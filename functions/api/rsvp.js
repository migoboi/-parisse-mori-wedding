/**
 * Parisse & Mori — Cloudflare Pages RSVP gateway
 * URL: POST /api/rsvp
 * Keep WEDDING_API_SECRET and WEDDING_APPS_SCRIPT_URL in Cloudflare
 * Production Variables and Secrets, never in this file.
 */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
};

function send(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
  // Called by the wedding website via same-origin fetch('/api/rsvp').
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return send(403, { ok: false, error: "Origin not allowed." });
  }

  if (!env.WEDDING_API_SECRET || !env.WEDDING_APPS_SCRIPT_URL) {
    return send(503, { ok: false, error: "RSVP service is not configured." });
  }

  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (declaredSize > 10000) {
    return send(413, { ok: false, error: "Request too large." });
  }

  let input;
  try {
    const raw = await request.text();
    if (raw.length > 10000) return send(413, { ok: false, error: "Request too large." });
    input = JSON.parse(raw);
  } catch {
    return send(400, { ok: false, error: "Invalid request body." });
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return send(400, { ok: false, error: "Invalid request." });
  }
  const invite = input.invite;
  if (typeof invite !== "string" || !/^[a-f0-9]{32}$/i.test(invite)) {
    return send(400, { ok: false, error: "Invalid invitation link." });
  }
  if (input.action !== "lookup" && input.action !== "rsvp") {
    return send(400, { ok: false, error: "Unknown action." });
  }

  const payload = { auth: env.WEDDING_API_SECRET, action: input.action, invite };
  if (input.action === "rsvp") {
    if (!Array.isArray(input.responses) || input.responses.length < 1 || input.responses.length > 20) {
      return send(400, { ok: false, error: "Invalid RSVP responses." });
    }
    for (const response of input.responses) {
      if (!response || typeof response.guestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,32}$/.test(response.guestId) ||
          !["Attending", "Declined"].includes(response.status)) {
        return send(400, { ok: false, error: "Invalid RSVP response." });
      }
    }
    payload.responses = input.responses;
  }

  // The Google Apps Script ContentService redirects JSON responses to
  // script.googleusercontent.com; `redirect: "follow"` is required.
  try {
    const url = new URL(env.WEDDING_APPS_SCRIPT_URL);
    if (url.protocol !== "https:" || url.hostname !== "script.google.com" ||
        !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
      return send(503, { ok: false, error: "RSVP service URL is invalid." });
    }

    const upstream = await fetch(url.href, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      cache: "no-store",
    });

    if (!upstream.ok) {
      return send(502, { ok: false, error: "RSVP service is unavailable." });
    }

    const body = await upstream.json();
    if (!body || typeof body !== "object" || typeof body.ok !== "boolean") {
      return send(502, { ok: false, error: "Unexpected RSVP service response." });
    }
    if (!body.ok) {
      return send(400, { ok: false, error: body.error || "Request was not accepted." });
    }

    return send(200, body);
  } catch (err) {
    // Never leak the backend URL, credentials or raw upstream error to a guest.
    console.error("Wedding RSVP gateway failure:", String(err?.name || "error"));
    return send(502, { ok: false, error: "Could not connect to RSVP service. Please try again." });
  }
}

export function onRequestGet() {
  return send(405, { ok: false, error: "POST required." });
}
