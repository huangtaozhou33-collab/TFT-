const HOSTS = new Set(['kr.api.riotgames.com', 'asia.api.riotgames.com']);
const safeError = (code, status = null, retryAfter = null) => Object.assign(new Error(code), { code, status, retryAfter });

export function retryAfterSeconds(value, now = Date.now()) {
  if (/^\d+$/.test(value || '')) return Number(value);
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

export function createRiotClient({ key, limiter, fetchImpl = fetch } = {}) {
  if (!key?.trim()) throw safeError('RIOT_KEY_MISSING');
  if (!limiter?.acquire || !limiter?.cooldown) throw safeError('RIOT_LIMITER_UNAVAILABLE');
  return {
    async get(url) {
      let target;
      try { target = new URL(url); } catch { throw safeError('RIOT_URL_REJECTED'); }
      if (target.protocol !== 'https:' || !HOSTS.has(target.hostname) || target.port || target.username || target.password
        || target.hash || target.searchParams.has('api_key') || !target.pathname.startsWith('/tft/')) throw safeError('RIOT_URL_REJECTED');
      await limiter.acquire();
      let response;
      try {
        response = await fetchImpl(target.href, { headers: { 'X-Riot-Token': key.trim(), Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(20000) });
      } catch { throw safeError('RIOT_NETWORK_ERROR'); }
      if (!response.ok) {
        const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
        if (response.status === 429) await limiter.cooldown(retryAfter);
        throw safeError(response.status === 429 ? 'RIOT_RATE_LIMITED' : [401, 403].includes(response.status)
          ? 'RIOT_AUTHENTICATION_FAILED' : 'RIOT_HTTP_ERROR', response.status, retryAfter);
      }
      try { return await response.json(); } catch { throw safeError('RIOT_INVALID_JSON', response.status); }
    }
  };
}
