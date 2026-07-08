/**
 * Meridian — Leads API
 * Receives POSTs from webinar-register.html (webinar registrations,
 * table: registrations) and affiliate.html (affiliate applications,
 * table: affiliate_applications), routed by the request body's
 * "formType" field. Webinar registrations also forward to a Zapier
 * webhook so a Zap can push them into Brevo for nurture emails.
 *
 * Deploy this as a Cloudflare Worker named e.g. "meridian-leads-api",
 * with a D1 binding: variable name "DB" -> database "meridian_leads",
 * and a KV binding: variable name "RATE_LIMIT_KV" -> namespace
 * "meridian-leads-api-ratelimit" (used for per-IP rate limiting).
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

    // Forward to Zapier -> Brevo in the background, after the D1 write
    // succeeds. ctx.waitUntil keeps this running even after we've
    // already returned the response below, so registration feels
    // instant to the person filling in the form.
    ctx.waitUntil(forwardToZapier({ firstname, email, whatsapp, event, sourcePage }));

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

  const validTypes = ["individual", "business"];
  if (!name || !isValidEmail(email) || !validTypes.includes(applicantType)) {
    return new Response(JSON.stringify({ error: "Missing or invalid name, email, or applicant type" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  try {
    // Upsert on email, same reasoning as webinar registrations: someone
    // re-applying (or fixing a typo) updates their existing row instead
    // of erroring or creating a duplicate.
    await env.DB.prepare(
      `INSERT INTO affiliate_applications (name, email, applicant_type, company_name, website, audience_notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         applicant_type = excluded.applicant_type,
         company_name = excluded.company_name,
         website = excluded.website,
         audience_notes = excluded.audience_notes`
    ).bind(name, email, applicantType, companyName || null, website || null, audienceNotes || null).run();

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
