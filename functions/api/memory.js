/**
 * Parisse & Mori — Cloudflare Pages Memory Archive gateway
 * Route: POST /api/memory
 * Keep all secrets in Cloudflare Pages -> Settings -> Variables and Secrets.
 *
 * Required environment bindings (Production):
 *   MEMORY_API_SECRET       // same value as Apps Script's UPLOAD_SECRET
 *   MEMORY_APPS_SCRIPT_URL  // Apps Script web app /exec for Memory Archive
 *   WEDDING_API_SECRET      // already used by functions/api/rsvp.js
 *   WEDDING_APPS_SCRIPT_URL // already used by functions/api/rsvp.js
 *
 * This endpoint requires a valid personalized invitation link and consent.
 * Do not turn on the public upload UI until the backend is tested.
 */
const RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
};
const MIB = 1024 * 1024;
const FILE_LIMITS = {
  'image/jpeg': 5 * MIB,
  'image/png': 5 * MIB,
  'image/webp': 5 * MIB,
  'image/heic': 5 * MIB,
  'image/heif': 5 * MIB,
  'video/mp4': 8 * MIB,
  'video/quicktime': 8 * MIB,
  'video/webm': 8 * MIB,
  'audio/mp4': 5 * MIB,
  'audio/mpeg': 5 * MIB,
  'audio/webm': 5 * MIB,
  'audio/wav': 5 * MIB,
  'audio/ogg': 5 * MIB,
  'audio/x-m4a': 5 * MIB,
};
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: RESPONSE_HEADERS });
}
function trustedScriptUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
        !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || url.search || url.hash) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
async function postScript(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!res.ok) return null;
  try {
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
function base64FromBytes(bytes) {
  // Avoid exceeding the argument limit in String.fromCharCode(...largeArray).
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: 'Origin not allowed.' });
  }
  // This is only an initial filter. Origin alone is NOT an authorization mechanism.
  const rsvpUrl = trustedScriptUrl(env.WEDDING_APPS_SCRIPT_URL);
  const memoryUrl = trustedScriptUrl(env.MEMORY_APPS_SCRIPT_URL);
  if (!env.WEDDING_API_SECRET || !env.MEMORY_API_SECRET || !rsvpUrl || !memoryUrl) {
    return json(503, { ok: false, error: 'Memory uploads are not configured yet.' });
  }
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return json(415, { ok: false, error: 'Expected a form upload.' });
  }
  // Multipart overhead is small; avoid parsing unexpectedly large bodies.
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 9 * MIB) {
    return json(413, { ok: false, error: 'File exceeds the upload limit.' });
  }

  let fields;
  try {
    fields = await request.formData();
  } catch {
    return json(400, { ok: false, error: 'Could not read the upload.' });
  }
  const invite = fields.get('invitation');
  const guestName = fields.get('name');
  const consent = fields.get('consent');
  const file = fields.get('file');
  if (typeof invite !== 'string' || !/^[a-f\d]{32}$/i.test(invite)) {
    return json(403, { ok: false, error: 'Open your personal invitation link to share a memory.' });
  }
  if (typeof guestName !== 'string' || !guestName.trim() || guestName.length > 120) {
    return json(400, { ok: false, error: 'Please enter your name.' });
  }
  if (consent !== 'yes') {
    return json(400, { ok: false, error: 'Please confirm permission to share the memory.' });
  }
  if (!(file instanceof File)) {
    return json(400, { ok: false, error: 'Please choose a file.' });
  }
  const mimeType = (file.type || '').toLowerCase().split(';')[0].trim();
  const limit = FILE_LIMITS[mimeType];
  if (!limit) {
    return json(415, { ok: false, error: 'Unsupported file type.' });
  }
  if (!file.size || file.size > limit) {
    return json(413, { ok: false, error: `File too large. Limit: ${Math.round(limit / MIB)} MB.` });
  }

  try {
    // The same private RSVP Google Apps Script confirms the invitation exists.
    // We don't expose the RSVP secret or Google response to the guest.
    const invitation = await postScript(rsvpUrl, {
      auth: env.WEDDING_API_SECRET,
      action: 'lookup',
      invite,
    });
    if (!invitation || invitation.ok !== true || !Array.isArray(invitation.guests) ||
        invitation.guests.length === 0) {
      return json(403, { ok: false, error: 'This invitation could not be verified.' });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await postScript(memoryUrl, {
      secret: env.MEMORY_API_SECRET,
      guestName: guestName.trim(),
      fileName: String(file.name || 'memory').slice(0, 90),
      mimeType,
      base64: base64FromBytes(bytes),
    });
    if (!result || result.ok !== true) {
      return json(502, { ok: false, error: 'Could not save the file. Please try again.' });
    }
    return json(200, { ok: true, message: 'Memory saved successfully.' });
  } catch (error) {
    console.error('Memory upload gateway:', String(error?.name || 'error'));
    return json(502, { ok: false, error: 'Upload connection unavailable. Please try again.' });
  }
}

export function onRequestGet() {
  return json(405, { ok: false, error: 'POST required.' });
}
