import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiotRateLimiter } from '../scripts/riot-rate-limiter.mjs';

function clock(options = {}) {
  let time = 0;
  const waits = [], starts = [];
  const limiter = createRiotRateLimiter({ ...options, now: () => time,
    wait: async ms => { waits.push(ms); time += ms; } });
  return { limiter, waits, starts, now: () => time,
    take: async () => { await limiter.acquire(); starts.push(time); } };
}

test('both rolling windows remain bounded even with a burst of concurrent reservations', async () => {
  const c = clock({ minSpacingMs: 0 });
  await Promise.all(Array.from({ length: 201 }, () => c.take()));
  assert.equal(c.starts.length, 201);
  for (const time of c.starts) {
    assert.ok(c.starts.filter(start => start <= time && time - start <= 1000).length <= 20);
    assert.ok(c.starts.filter(start => start <= time && time - start <= 120000).length <= 100);
  }
  assert.ok(c.starts[100] > 120000);
  assert.ok(c.starts[200] > 240000);
  assert.ok(c.waits.every(ms => ms <= 60000));
});

test('the default pace preserves 1350 ms spacing and leaves margin below 100 per two minutes', async () => {
  const c = clock();
  for (let index = 0; index < 101; index++) await c.take();
  for (let index = 1; index < c.starts.length; index++) assert.ok(c.starts[index] - c.starts[index - 1] >= 1350);
  assert.equal(c.starts.filter(start => start <= 120000).length, 89);
});

test('Retry-After cooldown applies to subsequent reservations without shortening an existing cooldown', async () => {
  const c = clock({ minSpacingMs: 0 });
  await c.take();
  c.limiter.cooldown(180);
  c.limiter.cooldown(1);
  await Promise.all([c.take(), c.take()]);
  assert.deepEqual(c.starts, [0, 180000, 180000]);
});

test('an absent Retry-After uses a conservative two-minute cooldown', async () => {
  const c = clock({ minSpacingMs: 0 });
  c.limiter.cooldown(null);
  await c.take();
  assert.equal(c.now(), 120000);
});

test('a failed wait does not poison the queue or consume a request slot', async () => {
  let time = 0, fail = true;
  const limiter = createRiotRateLimiter({ now: () => time, wait: async ms => {
    if (fail) { fail = false; throw new Error('interrupted wait'); }
    time += ms;
  } });
  await limiter.acquire();
  await assert.rejects(limiter.acquire(), /interrupted wait/);
  await limiter.acquire();
  assert.equal(time, 1350);
});
