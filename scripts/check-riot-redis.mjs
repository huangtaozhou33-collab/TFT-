import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectRiotRedis, createRedisRiotLimiter, riotCredentialFingerprint, RESERVE_SCRIPT } from '../server/riot/rate-limit.mjs';

// Infrastructure-only smoke test: unique fake credential, no Riot HTTP calls.
const fakeKey = `infrastructure-test-${randomUUID()}`;
const prefix = `riot:budget:{${riotCredentialFingerprint(fakeKey)}}`;
const keys = [`${prefix}:requests`, `${prefix}:state`];
let redis;
try {
  redis = await connectRiotRedis(process.env.REDIS_URL);
  const first = createRedisRiotLimiter({ redis, key: fakeKey });
  const second = createRedisRiotLimiter({ redis, key: fakeKey });
  await Promise.all([first.acquire(), second.acquire()]);
  const reservations = await redis.zRangeWithScores(keys[0], 0, -1);
  assert.equal(reservations.length, 2);
  const spacingMs = reservations[1].score - reservations[0].score;
  assert.ok(spacingMs >= 1350);
  await first.cooldown(2);
  const blockedUntil = Number(await redis.hGet(keys[1], 'blocked'));
  const started = performance.now();
  await second.acquire();
  const cooldownWaitMs = Math.round(performance.now() - started);
  const afterCooldown = await redis.zRangeWithScores(keys[0], -1, -1);
  assert.ok(afterCooldown[0].score >= blockedUntil);

  // Exercise both Lua windows directly without waiting 120 seconds; only the
  // isolated test namespace is rewritten, never production limiter keys.
  async function windowDelay(count, ageMs) {
    await redis.del(keys);
    const [seconds, micros] = await redis.sendCommand(['TIME']);
    const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    await redis.zAdd(keys[0], Array.from({ length: count }, (_, i) => ({ score: now - ageMs, value: `fake-${i}` })));
    return Number(await redis.eval(RESERVE_SCRIPT, { keys, arguments: ['0', randomUUID()] }));
  }
  const oneSecondDelayMs = await windowDelay(20, 100);
  assert.ok(oneSecondDelayMs > 0 && oneSecondDelayMs <= 1001);
  const twoMinuteDelayMs = await windowDelay(100, 60000);
  assert.ok(twoMinuteDelayMs > 50000 && twoMinuteDelayMs <= 60001);
  console.log(JSON.stringify({ status: 'passed', checks: 4, spacingMs, cooldownWaitMs, oneSecondDelayMs, twoMinuteDelayMs, providerRequests: 0 }));
} catch {
  console.error(JSON.stringify({ status: 'failed', code: 'RIOT_REDIS_SMOKE_FAILED', providerRequests: 0 }));
  process.exitCode = 1;
} finally {
  if (redis?.isOpen) {
    await redis.del(keys).catch(() => {});
    await redis.quit().catch(() => redis.destroy());
  }
}
