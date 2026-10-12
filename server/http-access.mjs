export function publicPort(value, fallback) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PUBLIC_PORT must be an integer from 1 to 65535.');
  }
  return Number(value);
}

// Container port forwarding changes the browser Host header, not its authority.
// Allow only explicitly configured loopback authorities; never trust forwarded headers.
export function localRequest(req, { port, externalPort = port }) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`,
    `127.0.0.1:${externalPort}`, `localhost:${externalPort}`]);
  const host = req.headers.host || '';
  if (!allowed.has(host)) return false;
  if (!req.headers.origin) return true;
  try { const url = new URL(req.headers.origin); return url.protocol === 'http:' && url.host === host && !url.username && !url.password; }
  catch { return false; }
}
