/**
 * Parisse & Mori — Memory Archive gateway
 * POST /api/memory — invitation-validated upload, no secrets in HTML.
 *
 * Secrets (Cloudflare Production):
 *  WEDDING_API_SECRET, WEDDING_APPS_SCRIPT_URL (existing RSVP values)
 *  MEMORY_API_SECRET, MEMORY_APPS_SCRIPT_URL (private archive values)
 *
 * Browser uses base64 JSON so encoding happens on the device rather than
 * consuming Cloudflare's 128 MiB Worker heap/10 ms free-plan CPU budget.
 * The receiver in Code.gs MUST be updated to the same per-file size limits.
 */
const RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
};
const MiB = 1024 * 1024;
const FILE_LIMITS = {
  'image/jpeg': 15 * MiB,
  'image/png': 15 * MiB,
  'image/webp': 15 * MiB,
  'image/heic': 15 * MiB,
  'image/heif': 15 * MiB,
  'video/mp4': 18 * MiB,
  'video/quicktime': 18 * MiB,
  'video/webm': 18 * MiB,
  'audio/mp4': 12 * MiB,
  'audio/mpeg': 12 * MiB,
  'audio/webm': 12 * MiB,
  'audio/wav': 12 * MiB,
  'audio/ogg': 12 * MiB,
  'audio/x-m4a': 12 * MiB,
};
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: RESPONSE_HEADERS });
}
function trustedScriptUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
        !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
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
  } catch { return null; }
}
export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: 'Origin not allowed.' });
  }
  const rsvpUrl = trustedScriptUrl(env.WEDDING_APPS_SCRIPT_URL);
  const memoryUrl = trustedScriptUrl(env.MEMORY_APPS_SCRIPT_URL);
  if (!env.WEDDING_API_SECRET || !env.MEMORY_API_SECRET || !rsvpUrl || !memoryUrl) {
    return json(503, { ok: false, error: 'Memory uploads are not configured yet.' });
  }
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json(415, { ok: false, error: 'Unsupported upload format. Refresh the website and try again.' });
  }
  // The largest encoded file is 24 MiB; enforce a strict request ceiling.
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 26 * MiB) {
    return json(413, { ok: false, error: 'File exceeds the upload limit.' });
  }
  let input;
  try { input = await request.json(); }
  catch { return json(400, { ok: false, error: 'Could not read the upload.' }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json(400, { ok: false, error: 'Invalid request.' });
  }
  const invite = input.invitation;
  if (typeof invite !== 'string' || !/^[a-f0-9]{32}$/i.test(invite)) {
    return json(403, { ok: false, error: 'Open your personalized invitation link to share a memory.' });
  }
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.toLowerCase().trim() : '';
  const limit = FILE_LIMITS[mimeType];
  if (!limit) return json(415, { ok: false, error: 'Unsupported file type.' });
  const actualSize = Number(input.size);
  if (!Number.isSafeInteger(actualSize) || actualSize < 1 || actualSize > limit) {
    return json(413, { ok: false, error: `File too large. Limit: ${Math.round(limit / MiB)} MB.` });
  }
  const base64 = input.base64;
  if (typeof base64 !== 'string' || base64.length !== 4 * Math.ceil(actualSize / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return json(400, { ok: false, error: 'Invalid file data.' });
  }
  const filename = String(input.fileName || 'memory').slice(0, 90);
  try {
    // Validate invitation against the existing private RSVP database.
    const lookup = await postScript(rsvpUrl, {
      auth: env.WEDDING_API_SECRET, action: 'lookup', invite,
    });
    const invitation = lookup && lookup.invitation;
    if (!lookup || lookup.ok !== true || !invitation || !Array.isArray(invitation.guests) ||
        invitation.guests.length === 0) {
      return json(403, { ok: false, error: 'This invitation could not be verified.' });
    }
    const guestName = String(invitation.invitationName ||
      invitation.guests.map(g => g && g.guestName).filter(Boolean).join(' & ') ||
      'Invited guest').trim().slice(0, 120);
    const saved = await postScript(memoryUrl, {
      secret: env.MEMORY_API_SECRET,
      guestName,
      fileName: filename,
      mimeType,
      base64,
    });
    if (!saved || saved.ok !== true) {
      return json(502, { ok: false, error: 'Could not save the file. Please try again.' });
    }
    return json(200, { ok: true, message: 'Memory saved successfully.' });
  } catch (err) {
    console.error('Memory gateway:', String(err?.name || 'error'));
    return json(502, { ok: false, error: 'Upload connection unavailable. Please try again.' });
  }
}
export function onRequestGet() {
  return json(405, { ok: false, error: 'POST required.' });
}
