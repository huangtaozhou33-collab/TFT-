import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisRiotLimiter, RESERVE_SCRIPT, COOLDOWN_SCRIPT } from '../server/riot/rate-limit.mjs';
import { createRiotClient, retryAfterSeconds } from '../server/riot/client.mjs';

test('independent limiter instances share atomic Redis keys and wait for reservations', async () => {
  const calls = [], waits = [], responses = [0, 1350, 0];
  const redis = { eval: async (script, options) => { calls.push({ script, ...options }); return responses.shift(); } };
  const first = createRedisRiotLimiter({ redis, key: 'private-test-key', wait: async ms => waits.push(ms) });
  const second = createRedisRiotLimiter({ redis, key: 'private-test-key', wait: async ms => waits.push(ms) });
  await first.acquire(); await second.acquire();
  assert.deepEqual(calls[0].keys, calls[1].keys);
  assert.equal(calls[0].script, RESERVE_SCRIPT);
  assert.deepEqual(waits, [1350]);
  assert.equal(JSON.stringify(calls).includes('private-test-key'), false);
  assert.notEqual(calls[0].arguments[1], calls[1].arguments[1]);
});

test('Redis failure prevents provider fetch, without local fail-open fallback', async () => {
  let fetched = 0;
  const redis = { eval: async () => { throw new Error('redis://secret'); } };
  const client = createRiotClient({ key: 'test', limiter: createRedisRiotLimiter({ key: 'test', redis }), fetchImpl: async () => { fetched++; } });
  await assert.rejects(client.get('https://kr.api.riotgames.com/tft/league/v1/challenger'), { code: 'RIOT_LIMITER_UNAVAILABLE' });
  assert.equal(fetched, 0);
});

test('429 persists shared cooldown and returns once without retry or response-body exposure', async () => {
  const calls = [];
  const redis = { eval: async (script, options) => { calls.push({ script, ...options }); return 0; } };
  let fetched = 0;
  const client = createRiotClient({ key: 'test', limiter: createRedisRiotLimiter({ key: 'test', redis }), fetchImpl: async () => {
    fetched++; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '240' }), json: () => { throw new Error('must not read error body'); } };
  } });
  await assert.rejects(client.get('https://asia.api.riotgames.com/tft/match/v1/matches/KR_1'), { code: 'RIOT_RATE_LIMITED', retryAfter: 240 });
  assert.equal(fetched, 1);
  assert.equal(calls[1].script, COOLDOWN_SCRIPT);
  assert.deepEqual(calls[1].arguments, ['240000']);
});

test('client accepts only fixed official HTTPS targets, uses a header key, and refuses redirects', async () => {
  let reservations = 0, request;
  const client = createRiotClient({ key: ' test ', limiter: { acquire: async () => reservations++, cooldown: async () => {} },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ done: true }) }; } });
  for (const url of ['https://evil.test/tft/', 'http://kr.api.riotgames.com/tft/', 'https://kr.api.riotgames.com/tft/?api_key=x', 'https://kr.api.riotgames.com/tft/#x', 'https://kr.api.riotgames.com/lol/']) {
    await assert.rejects(client.get(url), { code: 'RIOT_URL_REJECTED' });
  }
  assert.equal(reservations, 0);
  assert.deepEqual(await client.get('https://kr.api.riotgames.com/tft/league/v1/challenger'), { done: true });
  assert.equal(request.options.headers['X-Riot-Token'], 'test');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.url.includes('test'), false);
});

test('Retry-After HTTP dates are interpreted and malformed delays use conservative fallback', async () => {
  assert.equal(retryAfterSeconds('Sat, 10 Oct 2026 00:02:00 GMT', Date.parse('2026-10-10T00:00:00Z')), 120);
  assert.equal(retryAfterSeconds('unavailable'), null);
  let args;
  const limiter = createRedisRiotLimiter({ key: 'test', redis: { eval: async (_script, options) => { args = options.arguments; return 0; } } });
  await limiter.cooldown(null);
  assert.deepEqual(args, ['120000']);
});
