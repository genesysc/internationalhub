/**
 * Meridian — Leads API
 * Receives POSTs from webinar-register.html (webinar registrations,
 * table: registrations) and affiliate.html (affiliate applications),
 * routed by the request body's "formType" field. Affiliate
 * applications are further split by "applicantType" into two
 * separate tables — affiliate_applications_individual and
 * affiliate_applications_business — since business applications
 * carry a required company name that individual ones don't.
 * Webinar registrations also forward to a Zapier webhook so a Zap
 * can push them into Brevo for nurture emails, and trigger a Brevo
 * transactional email notifying the team of the new signup.
 *
 * Deploy this as a Cloudflare Worker named e.g. "meridian-leads-api",
 * with a D1 binding: variable name "DB" -> database "meridian_leads",
 * and a KV binding: variable name "RATE_LIMIT_KV" -> namespace
 * "meridian-leads-api-ratelimit" (used for per-IP rate limiting).
 * Also requires a "BREVO_API_KEY" secret (wrangler secret put
 * BREVO_API_KEY) for the registration notification email, and the
 * NOTIFICATION_FROM_EMAIL below must be a sender verified in Brevo.
 * See DEPLOY_INSTRUCTIONS.md for exact click-by-click steps.
 */

// ============================================================
// IMPORTANT — before launch:
// Replace with your real production domain(s). Leaving a wide-open
// entry here means any website could submit to your database.
// ============================================================
const ALLOWED_ORIGINS = [
  "https://meridian.genesysconsultancy.co.uk",
  "http://localhost:8080" // convenient for local testing, remove before launch
];

// ============================================================
// IMPORTANT — before launch:
// Replace with the real "Catch Hook" URL from your Zapier Zap
// (Trigger step -> Webhooks by Zapier -> Catch Hook). See
// DEPLOY_INSTRUCTIONS.md for how to set this up in Zapier and
// wire the second step to Brevo.
// ============================================================
const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/YOUR_ZAP_ID/YOUR_HOOK_ID/";

// ============================================================
// IMPORTANT — before launch:
// Where new webinar registration alerts get sent, and who they're
// sent from. The "from" address must be a verified sender in your
// Brevo account (Settings -> Senders & IP) or the send will fail.
// ============================================================
const NOTIFICATION_TO_EMAIL = "info@genesysconsultancy.co.uk";
const NOTIFICATION_FROM_EMAIL = "noreply@meridian.genesysconsultancy.co.uk";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Simple per-IP rate limit: CORS only stops browsers from reading the
// response, it never stops a request from reaching this endpoint at all
// (curl/scripts ignore it entirely), so this is the actual abuse guard.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes

async function isRateLimited(env, ip) {
  const key = `ratelimit:${ip}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT_MAX) return true;

  // Re-puts the full TTL on every request within the window (a sliding
  // window) — an active abuser stays blocked as long as they keep trying,
  // rather than getting a fresh allowance right at a fixed window boundary.
  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return false;
}

async function forwardToZapier(payload) {
  // Fire-and-forget: if Zapier is briefly down or misconfigured, that
  // should never block or fail someone's registration — the D1 write
  // already succeeded and is the source of truth either way.
  try {
    await fetch(ZAPIER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Zapier forward failed (non-fatal):", err);
  }
}

async function sendRegistrationNotification(env, { firstname, email, whatsapp, event, sourcePage }) {
  // Same fire-and-forget reasoning as forwardToZapier: a notification
  // failure should never affect the registrant's experience or the
  // D1 write, which already succeeded by the time this runs.
  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: NOTIFICATION_FROM_EMAIL },
        to: [{ email: NOTIFICATION_TO_EMAIL }],
        subject: `New webinar registration: ${firstname} (${event})`,
        htmlContent: `
          <p>New registration for <strong>${event}</strong>:</p>
          <ul>
            <li>Name: ${firstname}</li>
            <li>Email: ${email}</li>
            <li>WhatsApp: ${whatsapp || "—"}</li>
            <li>Source page: ${sourcePage || "—"}</li>
          </ul>
        `,
      }),
    });
  } catch (err) {
    console.error("Registration notification email failed (non-fatal):", err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimited(env, ip)) {
      return new Response(JSON.stringify({ error: "Too many requests, please try again later" }), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const jsonHeaders = { ...headers, "Content-Type": "application/json" };

    if (body.formType === "affiliate") {
      return handleAffiliateApplication(body, env, jsonHeaders);
    }
    return handleWebinarRegistration(body, env, ctx, jsonHeaders);
  },
};

async function handleWebinarRegistration(body, env, ctx, jsonHeaders) {
  const firstname = (body.firstname || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const whatsapp = (body.whatsapp || "").trim();
  const event = (body.event || "spain-webinar-aug1").trim();
  const sourcePage = (body.sourcePage || "").trim();

  if (!firstname || !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "Missing or invalid name/email" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  try {
    // Upsert: if the email already exists, update their details rather
    // than erroring or creating a duplicate row (someone re-registering
    // shouldn't break, and shouldn't fragment your list either).
    await env.DB.prepare(
      `INSERT INTO registrations (firstname, email, whatsapp, source_page, event)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         firstname = excluded.firstname,
         whatsapp = excluded.whatsapp,
         source_page = excluded.source_page,
         event = excluded.event`
    ).bind(firstname, email, whatsapp || null, sourcePage || null, event).run();

    // Forward to Zapier -> Brevo, and send a team notification email,
    // in the background, after the D1 write succeeds. ctx.waitUntil
    // keeps these running even after we've already returned the
    // response below, so registration feels instant to the person
    // filling in the form.
    const registration = { firstname, email, whatsapp, event, sourcePage };
    ctx.waitUntil(forwardToZapier(registration));
    ctx.waitUntil(sendRegistrationNotification(env, registration));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error("Database write failed:", err);
    return new Response(JSON.stringify({ error: "Database write failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

async function handleAffiliateApplication(body, env, jsonHeaders) {
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const applicantType = (body.applicantType || "").trim();
  const companyName = (body.companyName || "").trim();
  const website = (body.website || "").trim();
  const audienceNotes = (body.audienceNotes || "").trim();

  if (!name || !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "Missing or invalid name or email" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  // Individual and business applicants live in separate tables (different
  // shape — business rows require a company name), routed by applicantType.
  if (applicantType === "business") {
    if (!companyName) {
      return new Response(JSON.stringify({ error: "Company name is required for business applicants" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    return insertAffiliateRow(env, jsonHeaders, {
      table: "affiliate_applications_business",
      columns: "contact_name, email, company_name, website, audience_notes",
      values: [name, email, companyName, website || null, audienceNotes || null],
    });
  }

  if (applicantType === "individual") {
    return insertAffiliateRow(env, jsonHeaders, {
      table: "affiliate_applications_individual",
      columns: "name, email, website, audience_notes",
      values: [name, email, website || null, audienceNotes || null],
    });
  }

  return new Response(JSON.stringify({ error: "applicantType must be \"individual\" or \"business\"" }), {
    status: 400,
    headers: jsonHeaders,
  });
}

async function insertAffiliateRow(env, jsonHeaders, { table, columns, values }) {
  const placeholders = values.map(() => "?").join(", ");
  const updateClause = columns
    .split(", ")
    .filter((c) => c !== "email")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  try {
    // Upsert on email, same reasoning as webinar registrations: someone
    // re-applying (or fixing a typo) updates their existing row instead
    // of erroring or creating a duplicate.
    await env.DB.prepare(
      `INSERT INTO ${table} (${columns})
       VALUES (${placeholders})
       ON CONFLICT(email) DO UPDATE SET ${updateClause}`
    ).bind(...values).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error("Database write failed:", err);
    return new Response(JSON.stringify({ error: "Database write failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
