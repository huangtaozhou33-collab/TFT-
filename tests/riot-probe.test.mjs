import test from 'node:test';
import assert from 'node:assert/strict';
import { riotGet } from '../scripts/probe-riot.mjs';
import { createRiotRateLimiter } from '../scripts/riot-rate-limiter.mjs';

function virtualLimiter() {
  let time = 0;
  return createRiotRateLimiter({ now: () => time, wait: async ms => { time += ms; } });
}

test('Riot probe keeps credentials in a header on a fixed HTTPS origin and forbids redirects', async () => {
  const secret = 'test-credential';
  const result = await riotGet('https://kr.api.riotgames.com/tft/league/v1/challenger', secret, {
    limiter: virtualLimiter(),
    fetchImpl: async (url, options) => {
      assert.equal(url.includes(secret), false);
      assert.equal(options.headers['X-Riot-Token'], secret);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }
  });
  assert.deepEqual(result, { entries: [] });
});

test('missing credentials and untrusted targets never make an HTTP request', async () => {
  let calls = 0;
  const options = { limiter: { acquire() { throw new Error('invalid input must not reserve quota'); } },
    fetchImpl: async () => { calls++; throw new Error('should not fetch'); } };
  await assert.rejects(riotGet('https://kr.api.riotgames.com/tft/league/v1/challenger', '', options), { code: 'RIOT_KEY_MISSING' });
  for (const url of ['http://kr.api.riotgames.com/tft/x', 'https://evil.example/tft/x',
    'https://kr.api.riotgames.com.evil.example/tft/x', 'https://secret@kr.api.riotgames.com/tft/x',
    'https://kr.api.riotgames.com:9000/tft/x', 'https://kr.api.riotgames.com/tft/x?api_key=secret',
    'https://kr.api.riotgames.com/other']) {
    await assert.rejects(riotGet(url, 'secret', options), { code: 'RIOT_URL_REJECTED' });
  }
  assert.equal(calls, 0);
});

test('401, 403 and 429 stop after one attempt and omit sensitive upstream bodies', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const events = [];
    await assert.rejects(riotGet('https://asia.api.riotgames.com/tft/match/v1/matches/KR_1', 'secret', {
      limiter: { acquire: async () => { events.push('reserved'); }, cooldown: seconds => events.push(seconds) },
      fetchImpl: async () => { calls++; events.push('fetch'); return new Response('secret PUUID-private-name', { status, headers: { 'retry-after': '120' } }); }
    }), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, status === 429 ? 'RIOT_RATE_LIMITED' : 'RIOT_AUTHENTICATION_FAILED');
      assert.equal(error.retryAfter, 120);
      assert.equal(JSON.stringify(error).includes('secret'), false);
      assert.equal(error.message.includes('PUUID'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(events, status === 429 ? ['reserved', 'fetch', 120] : ['reserved', 'fetch']);
  }
});

test('network errors and invalid JSON have bounded diagnostics without echoing credentials', async () => {
  await assert.rejects(riotGet('https://kr.api.riotgames.com/tft/league/v1/challenger', 'secret', {
    limiter: virtualLimiter(),
    fetchImpl: async () => { throw new Error('secret'); }
  }), { message: 'RIOT_NETWORK_ERROR', code: 'RIOT_NETWORK_ERROR' });
  await assert.rejects(riotGet('https://kr.api.riotgames.com/tft/league/v1/challenger', 'secret', {
    limiter: virtualLimiter(),
    fetchImpl: async () => new Response('secret malformed body', { status: 200 })
  }), { message: 'RIOT_INVALID_JSON', code: 'RIOT_INVALID_JSON' });
});
