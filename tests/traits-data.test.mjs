import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeTacticsHTML, publishTraitSnapshot, getTraitStats, readTraitSnapshot } from '../server/trait-data.mjs';
import { syncTraits } from '../scripts/sync-traits.mjs';

const catalog = { context: { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', rulesVersion: 'fixture-v1', gamePatch: null },
  traits: [{ id: 'DA_Juggernaut18', name: '主宰', icon: null, effects: [{ minUnits: 2, maxUnits: 3 }, { minUnits: 4, maxUnits: 5 }] }] };
const fetchedAt = '2026-10-07T14:47:39.457Z';
function publicHTML({ set = 18, patch = '18.4', traits, rankGroup = 1 } = {}) {
  const data = { page: '/traits/[[...slug]]', props: { pageProps: { aperture: { patch: { _0: 16200 }, rankGroup, gameType: 0, queue: 1100 },
    statsData: { totalEntries: 14635, lastUpdated: 1791381395, traits: traits ?? { DA_Juggernaut18__1: { count: 5837, place: 4.41, top4: 52.53, won: 12.97 }, DA_Juggernaut18__2: { count: 900, place: 4.02, top4: 60, won: 17 }, DA_Unknown__1: { count: 8, place: 4, top4: 50, won: 0 } } } } } };
  return `<title>TFT Traits Stats - Best Traits for Set ${set} Patch ${patch}</title><div>Ranked</div><div>Diamond+</div><div>${patch}</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}
async function isolated(run) {
  const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-traits-test-'); const directory = await mkdtemp(prefix);
  try { await run(pathToFileURL(directory + sep)); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
}

test('public page averages and percent rates match displayed units, and tiers join exact effects', () => {
  const result = normalizeTacticsHTML(publicHTML(), catalog, { fetchedAt });
  assert.equal(result.data[0].stats.avgPlacement, 4.41); assert.equal(result.data[0].stats.top4Rate, 0.5253); assert.equal(result.data[0].stats.winRate, 0.1297); assert.equal(result.data[0].stats.sampleSize, 5837);
  assert.equal(result.data[0].tier, 1); assert.equal(result.data[0].minUnits, 2); assert.equal(result.data[1].tier, 2); assert.equal(result.data[1].minUnits, 4);
  assert.equal(result.evidence.sourcePatch, '18.4'); assert.equal(result.context.gamePatch, null); assert.equal(result.evidence.sourceTime, '2026-10-07T13:56:35.000Z');
  assert.deepEqual(result.evidence.population, { queue: 'Ranked', rank: 'Diamond+', region: null });
  assert.equal(result.coverage.sourceRows, 3); assert.equal(result.coverage.acceptedRows, 2); assert.equal(result.coverage.excludedRows, 1); assert.equal(result.coverage.complete, false);
});

test('unverified source set, filters, HTML schema and sum-format fields are rejected', () => {
  assert.throws(() => normalizeTacticsHTML(publicHTML({ set: 17 }), catalog, { fetchedAt }), /set\/patch/);
  assert.throws(() => normalizeTacticsHTML(publicHTML({ rankGroup: 0 }), catalog, { fetchedAt }), /filters/);
  assert.throws(() => normalizeTacticsHTML(publicHTML().replace('<div>18.4</div>', '<div>18.3</div>'), catalog, { fetchedAt }), /filters/);
  assert.throws(() => normalizeTacticsHTML(publicHTML().replace('__NEXT_DATA__', 'missing'), catalog, { fetchedAt }), /no __NEXT_DATA__/);
  assert.throws(() => normalizeTacticsHTML(publicHTML({ traits: { DA_Juggernaut18__1: { count: 5837, place: 25741, top4: 3066, won: 757 } } }), catalog, { fetchedAt }), /Invalid public trait statistics/);
  const unmapped = normalizeTacticsHTML(publicHTML({ traits: { DA_Juggernaut18__1: { count: 5, place: 4, top4: 40, won: 20 }, DA_Juggernaut18__9: { count: 5, place: 4, top4: 40, won: 20 } } }), catalog, { fetchedAt });
  assert.equal(unmapped.coverage.excluded[0].reason, 'unmapped_effect_tier');
});

test('trait reads never network, isolate versions, and reject missing or tampered payloads', async () => isolated(async dir => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('No runtime network'); };
  try {
    const missing = await getTraitStats({ catalog, dir }); assert.equal(missing.code, 'not_cached'); assert.match(missing.reason, /不会自动联网/);
    const html = publicHTML(), payload = normalizeTacticsHTML(html, catalog, { fetchedAt }); await publishTraitSnapshot(catalog, payload, html, dir);
    const live = await getTraitStats({ catalog, dir }); assert.equal(live.status, 'live'); assert.equal(live.evidence.fetchedAt, fetchedAt); assert.equal(live.delivery, 'version_cache');
    for (const context of [{ ...catalog.context, set: 19 }, { ...catalog.context, assetVersion: '16.21' }, { ...catalog.context, rulesVersion: 'fixture-v2' }]) assert.equal((await getTraitStats({ catalog: { ...catalog, context }, dir })).code, 'not_cached');
    const { manifest } = await readTraitSnapshot(catalog, dir), path = new URL(`${manifest.cacheKey}/${manifest.file}`, dir);
    const changed = JSON.parse(await readFile(path, 'utf8')); changed.data[0].stats.winRate = 1; await writeFile(path, JSON.stringify(changed));
    assert.equal((await getTraitStats({ catalog, dir })).code, 'not_cached'); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('same-version sync skips, and invalid force refresh keeps the previous capture', async () => isolated(async dir => {
  const html = publicHTML(), payload = normalizeTacticsHTML(html, catalog, { fetchedAt }); await publishTraitSnapshot(catalog, payload, html, dir);
  let requests = 0; const blocked = async () => { requests++; throw new Error('Should not fetch cached version'); };
  assert.equal((await syncTraits([], { catalog, dir, fetchImpl: blocked })).evidence.fetchedAt, fetchedAt); assert.equal(requests, 0);
  await assert.rejects(syncTraits(['--force'], { catalog, dir, fetchImpl: async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => publicHTML({ set: 17 }) }) }), /set\/patch/);
  const retained = await getTraitStats({ catalog, dir }); assert.equal(retained.status, 'live'); assert.equal(retained.evidence.fetchedAt, fetchedAt);
}));

test('offline sync never fetches and leaves missing versions unpublished', async () => isolated(async dir => {
  let requests = 0; const blocked = async () => { requests++; throw new Error('Offline must not fetch'); };
  await assert.rejects(syncTraits(['--offline'], { catalog, dir, fetchImpl: blocked }), /no network request/);
  assert.equal(await readTraitSnapshot(catalog, dir), null); assert.equal(requests, 0);
  const html = publicHTML(), payload = normalizeTacticsHTML(html, catalog, { fetchedAt }); await publishTraitSnapshot(catalog, payload, html, dir);
  assert.equal((await syncTraits(['--offline'], { catalog, dir, fetchImpl: blocked })).status, 'live'); assert.equal(requests, 0);
}));
