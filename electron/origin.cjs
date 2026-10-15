// Which page origins may use HID. Kept separate from main.cjs so it can be
// unit-tested without Electron.

/**
 * Electron passes origins in different shapes (the permission check sends
 * "app://bundle/" with a trailing slash), so compare scheme + host.
 * URL.origin can't be used: it's "null" for custom schemes in Node.
 */
function normalizeOrigin(origin) {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== undefined && allowed.some((a) => normalizeOrigin(a) === normalized);
}

module.exports = {normalizeOrigin, isAllowedOrigin};
