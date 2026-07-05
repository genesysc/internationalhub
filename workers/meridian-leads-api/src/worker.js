/**
 * Meridian — Webinar Registration API
 * Receives POSTs from webinar-register.html, writes to the
 * "meridian_leads" D1 database (table: registrations), then
 * forwards the same data to a Zapier webhook so a Zap can push
 * it into Brevo for the actual nurture-email sending.
 *
 * Deploy this as a Cloudflare Worker named e.g. "meridian-leads-api",
 * with a D1 binding: variable name "DB" -> database "meridian_leads".
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

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const firstname = (body.firstname || "").trim();
    const email = (body.email || "").trim().toLowerCase();
    const whatsapp = (body.whatsapp || "").trim();
    const event = (body.event || "spain-webinar-aug1").trim();
    const sourcePage = (body.sourcePage || "").trim();

    if (!firstname || !isValidEmail(email)) {
      return new Response(JSON.stringify({ error: "Missing or invalid name/email" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
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
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Database write failed", detail: String(err) }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
