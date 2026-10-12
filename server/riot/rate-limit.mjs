import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-120000)
local last = tonumber(redis.call('HGET',KEYS[2],'last') or '0')
local blocked = tonumber(redis.call('HGET',KEYS[2],'blocked') or '0')
local next = math.max(now,last+tonumber(ARGV[1]),blocked)
for _,window in ipairs({{20,1000},{100,120000}}) do
  local recent = redis.call('ZRANGEBYSCORE',KEYS[1],now-window[2],'+inf','WITHSCORES')
  if #recent/2 >= window[1] then
    next = math.max(next,tonumber(recent[(#recent/2-window[1])*2+2])+window[2]+1)
  end
end
if next > now then return next-now end
redis.call('ZADD',KEYS[1],now,ARGV[2])
redis.call('HSET',KEYS[2],'last',now)
redis.call('PEXPIRE',KEYS[1],180000)
redis.call('PEXPIRE',KEYS[2],math.max(180000,blocked-now+180000))
return 0`;

export const COOLDOWN_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
local blocked = math.max(tonumber(redis.call('HGET',KEYS[1],'blocked') or '0'),now+tonumber(ARGV[1]))
redis.call('HSET',KEYS[1],'blocked',blocked)
redis.call('PEXPIRE',KEYS[1],math.max(180000,blocked-now+180000))
return blocked`;

export const riotCredentialFingerprint = key => createHash('sha256').update(key.trim()).digest('hex');
const unavailable = () => Object.assign(new Error('RIOT_LIMITER_UNAVAILABLE'), { code: 'RIOT_LIMITER_UNAVAILABLE' });

// One conservative application budget shared by all collectors and both routing hosts.
// Reservations happen before HTTP; failed requests consume a reservation as well.
export function createRedisRiotLimiter({ redis, key, wait = sleep, minSpacingMs = 1350 } = {}) {
  if (!key?.trim()) throw Object.assign(new Error('RIOT_KEY_MISSING'), { code: 'RIOT_KEY_MISSING' });
  if (!Number.isFinite(minSpacingMs) || minSpacingMs < 1350) throw new Error('RIOT_INVALID_SPACING');
  const prefix = `riot:budget:{${riotCredentialFingerprint(key)}}`;
  const keys = [`${prefix}:requests`, `${prefix}:state`];
  async function evaluate(script, scriptKeys, args) {
    if (!redis || redis.isReady === false) throw unavailable();
    try { return await redis.eval(script, { keys: scriptKeys, arguments: args.map(String) }); }
    catch { throw unavailable(); }
  }
  return {
    async acquire() {
      for (;;) {
        const delay = Number(await evaluate(RESERVE_SCRIPT, keys, [minSpacingMs, randomUUID()]));
        if (!Number.isFinite(delay) || delay < 0) throw unavailable();
        if (delay === 0) return;
        await wait(Math.min(delay, 60000));
      }
    },
    async cooldown(seconds) {
      const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120;
      await evaluate(COOLDOWN_SCRIPT, [keys[1]], [Math.ceil(duration * 1000)]);
    }
  };
}

export async function connectRiotRedis(url) {
  if (!url) throw unavailable();
  let client;
  try {
    const { createClient } = await import('redis');
    client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    return client;
  } catch { if (client?.isOpen) client.destroy(); throw unavailable(); }
}
