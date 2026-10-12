import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRiot, publicCollectorState } from '../server/riot/collector.mjs';
import { parseCollectorArguments } from '../scripts/collect-riot.mjs';
import { workerConfig, workerIsDue, workerTick } from '../scripts/riot-worker.mjs';

const now = () => Date.parse('2026-10-10T00:00:00Z');
function fixture({ pages = [], seedCount = 1 } = {}) {
  let state = null, listIndex = 0;
  const existing = new Set(), calls = [], records = [];
  const store = { load: async () => structuredClone(state), save: async value => { state = structuredClone(value); },
    existing: async ids => new Set(ids.filter(id => existing.has(id))) };
  const client = { get: async url => {
    calls.push(url);
    if (url.endsWith('/challenger')) return { queue: 'RANKED_TFT', entries: Array.from({ length: seedCount }, (_, i) => ({ puuid: `private-player-${i}`, leaguePoints: 100 - i })) };
    if (url.includes('/ids?')) return pages[listIndex++] || [];
    const id = url.split('/').at(-1);
    return { metadata: { match_id: id }, info: { participants: [] } };
  } };
  const importMatch = async record => { existing.add(record.body.metadata.match_id); records.push(record); return { status: 'imported' }; };
  return { store, client, importMatch, existing, calls, records, state: () => state };
}

test('collector checkpoints unconsumed IDs and resumes without fetching stored details', async () => {
  const f = fixture({ pages: [['KR_1', 'KR_2', 'KR_3']] });
  const first = await collectRiot({ ...f, now, maxMatches: 1, seedCount: 1 });
  assert.equal(first.imported, 1);
  assert.deepEqual(f.state().pending, ['KR_2', 'KR_3']);
  f.existing.add('KR_2'); // Simulate import committed before a process lost its checkpoint.
  const second = await collectRiot({ ...f, now, maxMatches: 1, seedCount: 1 });
  assert.equal(second.imported, 1);
  assert.equal(second.skippedExisting, 1);
  assert.equal(f.calls.some(url => url.endsWith('/KR_2')), false);
  assert.deepEqual(f.records.map(row => row.body.metadata.match_id), ['KR_1', 'KR_3']);
  const safe = JSON.stringify(publicCollectorState(f.state()));
  assert.equal(safe.includes('private-player'), false);
  assert.equal(safe.includes('KR_'), false);
});

test('collector resumes pagination at the next page after its first pending page is drained', async () => {
  const f = fixture({ pages: [Array.from({ length: 20 }, (_, i) => `KR_${i + 1}`), ['KR_21']] });
  await collectRiot({ ...f, now, maxMatches: 1, seedCount: 1 });
  assert.equal(f.state().seeds[0].start, 20);
  assert.equal(f.state().pending.length, 19);
  const second = await collectRiot({ ...f, now, maxMatches: 25, seedCount: 1 });
  assert.equal(second.imported, 20);
  const pages = f.calls.filter(url => url.includes('/ids?'));
  assert.equal(pages.length, 2);
  assert.equal(new URL(pages[1]).searchParams.get('start'), '20');
  assert.equal(new URL(pages[1]).searchParams.get('endTime'), String(Math.floor(now() / 1000)));
  assert.equal(f.state().cycle.complete, true);
});

test('rate/auth failures stop the run with pending detail and cursor intact', async () => {
  for (const [code, status] of [['RIOT_AUTHENTICATION_FAILED', 401], ['RIOT_RATE_LIMITED', 429]]) {
    const f = fixture({ pages: [['KR_10', 'KR_11']] });
    const original = f.client.get;
    f.client.get = async url => {
      if (url.endsWith('/KR_10')) throw Object.assign(new Error('secret must not echo'), { code, status, retryAfter: 120 });
      return original(url);
    };
    const result = await collectRiot({ ...f, now });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, code);
    assert.deepEqual(f.state().pending, ['KR_10', 'KR_11']);
    assert.equal(f.records.length, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('collector rejects malformed budgets and never silently drops a full pending queue', async () => {
  const f = fixture();
  await assert.rejects(collectRiot({ ...f, maxMatches: 101 }), { code: 'RIOT_INVALID_MATCH_BUDGET' });
  assert.equal(f.calls.length, 0);
  await f.store.save({ version: 1, seeds: [], pending: Array.from({ length: 2001 }, (_, i) => `KR_${i}`) });
  await assert.rejects(collectRiot({ ...f }), { code: 'RIOT_COLLECTOR_STATE_INVALID' });
});

test('collector deduplicates IDs within a page and across seeds before fetching details', async () => {
  const f = fixture({ seedCount: 2, pages: [['KR_1', 'KR_1', 'KR_2'], ['KR_2', 'KR_3']] });
  const report = await collectRiot({ ...f, now, seedCount: 2 });
  assert.equal(report.imported, 3);
  assert.equal(report.discovered, 3);
  assert.equal(f.calls.filter(url => /\/KR_\d+$/.test(url)).length, 3);
});

test('collector CLI requires explicit provider permission and bounded budget', () => {
  assert.throws(() => parseCollectorArguments([]), { code: 'RIOT_INVALID_ARGUMENTS' });
  assert.throws(() => parseCollectorArguments(['--allow-provider', '--max-matches=101']), { code: 'RIOT_INVALID_ARGUMENTS' });
  assert.deepEqual(parseCollectorArguments(['--allow-provider', '--max-matches=50', '--seed-count=5']), { allowProvider: true, maxMatches: 50, seedCount: 5 });
});

test('worker default is daily and unchanged credentials do not create authentication retry loops', () => {
  const config = workerConfig({});
  assert.equal(config.intervalMs, 86400000);
  assert.equal(config.maxMatches, 25);
  const state = { errorCode: 'RIOT_AUTHENTICATION_FAILED', credentialFingerprint: 'old', nextAttemptAt: '2026-10-11T00:00:00Z' };
  assert.equal(workerIsDue(state, 'old', now()), false);
  assert.equal(workerIsDue(state, 'new', now()), true);
  assert.equal(workerIsDue(state, 'old', Date.parse(state.nextAttemptAt)), true);
  assert.equal(workerIsDue({ ...state, errorCode: 'RIOT_KEY_MISSING', credentialFingerprint: 'missing' }, 'new', now()), true);
});

test('worker persists its next attempt after failure and retains earlier success', async () => {
  let saved;
  const db = { execute: async (sql, args) => {
    if (sql.startsWith('SELECT')) return [[{ payload: { lastSuccessAt: '2026-10-08T00:00:00Z' } }]];
    saved = JSON.parse(args[1]); return [];
  } };
  const report = await workerTick({ db, key: 'test-key', config: workerConfig({}), now,
    run: async () => ({ status: 'failed', error: { code: 'RIOT_RATE_LIMITED', retryAfterSeconds: 120 } }) });
  assert.equal(report.nextAttemptAt, '2026-10-11T00:00:00.000Z');
  assert.equal(saved.lastSuccessAt, '2026-10-08T00:00:00Z');
  assert.equal(saved.errorCode, 'RIOT_RATE_LIMITED');
  assert.equal(JSON.stringify(saved).includes('test-key'), false);
});
