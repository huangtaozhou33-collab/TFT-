import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../scripts/stats-cache.mjs';
import { normalizeExplorerHTML, getExplorerOverallStats, publishExplorerSnapshot, readExplorerSnapshot } from '../server/explorer-overall.mjs';
import { syncExplorer } from '../scripts/sync-explorer.mjs';

const catalog = { context: { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', rulesVersion: 'fixture-v1', gamePatch: null },
  champions: [{ id: 'DA_18_Maokai', name: '茂凯', cost: 5, traits: ['主宰'], icon: null }],
  items: [{ id: 'DA_WarmogsArmor', name: '狂徒铠甲', kind: 'completed', category: 'completed', icon: null },
    { id: 'DA_Artifact_DeathsDefiance', name: '死亡之蔑', kind: 'special', category: 'artifact', icon: null },
    { id: 'DA_Component_GiantsBelt', name: '巨人腰带', kind: 'component', category: 'component', icon: null }] };
const fetchedAt = '2026-10-07T19:44:17.585Z';
function publicHTML(kind, { set = 18, patch = '18.4', rankGroup = 1, lastUpdated = 1791395842, count = 250, place = 4.14, top4 = 55.74, won = 19.45, itemRows } = {}) {
  const label = kind === 'units' ? 'Units' : 'Items';
  const data = { page: `/${kind}/[[...slug]]`, props: { pageProps: {
    aperture: { patch: { _0: 16200 }, queue: 1100, gameType: 0, rankGroup },
    statsData: { totalEntries: 1000, lastUpdated,
      units: { DA_18_Maokai: { count, place, top4, won, topItems: ['DA_WarmogsArmor', 'DA_OutsideCurrent'] }, DA_Old_Set_Unit: { count: 4, place: 4, top4: 50, won: 0, topItems: [] } },
      items: itemRows ?? [{ itemId: 'DA_WarmogsArmor', count: 600, place: 4.3, top4: 53.5, won: 13.5 }, { itemId: 'DA_OutsideCurrent', count: 2, place: 4, top4: 50, won: 0 }] }
  } } };
  return `<title>TFT ${label} Stats - Best ${label} for Set ${set} Patch ${patch}</title><div>Ranked</div><div>Diamond+</div><div>${patch}</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}
function input(units = {}, items = {}) { return { unitsHTML: publicHTML('units', units), itemsHTML: publicHTML('items', items), unitsFetchedAt: fetchedAt, itemsFetchedAt: '2026-10-07T19:44:18.051Z' }; }
async function isolated(run) {
  const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-explorer-test-'), directory = await mkdtemp(prefix);
  try { await run(pathToFileURL(directory + sep)); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
}

test('public overall values retain averages, percentage rates and verified /8 play ratio without joining populations', () => {
  const result = normalizeExplorerHTML(input(), catalog), champion = result.champions[0];
  assert.deepEqual(champion.stats, { avgPlacement: 4.14, top4Rate: .5574, winRate: .1945, sampleSize: 250, pickRate: .25, playRatePer8: 2 });
  assert.equal(result.items[0].stats.top4Rate, .535); assert.equal(result.items[0].stats.sampleSize, 600); assert.equal(result.items[0].sourceId, 'items');
  assert.deepEqual(champion.topItems, ['DA_WarmogsArmor']); assert.equal(result.coverage.unknownTopItems.length, 1);
  assert.equal(result.evidence.sourcePatch, '18.4'); assert.equal(result.context.gamePatch, null); assert.equal(result.evidence.sourceTime, '2026-10-07T17:57:22.000Z');
  assert.equal(result.evidence.sources[0].fetchedAt, fetchedAt); assert.deepEqual(result.evidence.population, { queue: 'Ranked', rank: 'Diamond+', region: null });
  assert.equal(result.evidence.sourceTotalEntries, 1000); assert.match(result.evidence.sourceTotalEntriesMeaning, /not disjoint/);
  assert.equal(result.coverage.champions.cached, 1); assert.equal(result.coverage.champions.excluded.length, 1);
  assert.equal(result.coverage.items.cached, 1); assert.equal(result.coverage.items.total, 2); assert.equal(result.coverage.items.missing[0].id, 'DA_Artifact_DeathsDefiance');
  assert.deepEqual(result.coverage.items.componentsWithoutStatistics, ['DA_Component_GiantsBelt']); assert.equal(result.coverage.complete, false);
  assert.equal(result.capabilities.jointFilters, false); assert.equal(result.capabilities.conditionalDelta, false); assert.equal(result.capabilities.rankRegionFilters, false); assert.equal(result.capabilities.starFilters, false);
  assert.equal(champion.starStats, undefined); assert.equal(result.items[0].adjustedDelta, undefined);
});

test('wrong set/filter/schema, future source time, mixed patches, duplicate items and sum-format statistics are rejected', () => {
  assert.throws(() => normalizeExplorerHTML(input({ set: 17 }), catalog), /set\/patch/);
  assert.throws(() => normalizeExplorerHTML(input({ rankGroup: 0 }), catalog), /filters/);
  assert.throws(() => normalizeExplorerHTML({ ...input(), unitsHTML: publicHTML('units').replace('__NEXT_DATA__', 'missing') }, catalog), /no __NEXT_DATA__/);
  assert.throws(() => normalizeExplorerHTML(input({ lastUpdated: 1791495842 }), catalog), /later than its capture/);
  assert.throws(() => normalizeExplorerHTML(input({}, { patch: '18.3' }), catalog), /different patches/);
  assert.throws(() => normalizeExplorerHTML(input({ place: 1035, top4: 139, won: 49 }), catalog), /Invalid public overall/);
  const duplicate = { itemId: 'DA_WarmogsArmor', count: 10, place: 4.3, top4: 50, won: 10 };
  assert.throws(() => normalizeExplorerHTML(input({}, { itemRows: [duplicate, duplicate] }), catalog), /duplicate/);
});

test('source occurrence ratios above one are preserved as ratios, not clamped to a made-up probability', () => {
  const result = normalizeExplorerHTML(input({ count: 1200 }), catalog);
  assert.equal(result.champions[0].stats.pickRate, 1.2); assert.equal(result.champions[0].stats.playRatePer8, 9.6);
});

test('runtime reader performs zero network requests and isolates context plus exact entity membership', async () => isolated(async dir => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Runtime network forbidden'); };
  try {
    const missing = await getExplorerOverallStats({ catalog, dir }); assert.equal(missing.status, 'not_cached'); assert.equal(missing.capabilities.championOverallStats, false);
    const captured = input(), payload = normalizeExplorerHTML(captured, catalog); await publishExplorerSnapshot(catalog, payload, captured, dir);
    const result = await getExplorerOverallStats({ catalog, dir }); assert.equal(result.status, 'live'); assert.equal(result.evidence.sources[0].fetchedAt, fetchedAt);
    for (const context of [{ ...catalog.context, set: 19 }, { ...catalog.context, assetVersion: '16.21' }, { ...catalog.context, rulesVersion: 'fixture-v2' }]) assert.equal((await getExplorerOverallStats({ catalog: { ...catalog, context }, dir })).status, 'not_cached');
    assert.equal((await getExplorerOverallStats({ catalog: { ...catalog, champions: [{ ...catalog.champions[0], id: 'DA_18_Other' }] }, dir })).status, 'not_cached');
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('payload tampering and even rehashed out-of-catalog IDs fail closed', async () => isolated(async dir => {
  const captured = input(), payload = normalizeExplorerHTML(captured, catalog); await publishExplorerSnapshot(catalog, payload, captured, dir);
  const { manifest } = await readExplorerSnapshot(catalog, dir), file = new URL(`${manifest.cacheKey}/${manifest.file}`, dir);
  const changed = JSON.parse(await readFile(file, 'utf8')); changed.champions[0].stats.winRate = .99; await writeFile(file, JSON.stringify(changed));
  assert.equal((await getExplorerOverallStats({ catalog, dir })).status, 'not_cached');
  changed.champions[0].id = 'DA_17_NotCurrent'; await writeFile(file, JSON.stringify(changed)); manifest.sha256 = sha256(changed);
  await writeFile(new URL(`${manifest.cacheKey}/manifest.json`, dir), JSON.stringify(manifest));
  assert.equal((await getExplorerOverallStats({ catalog, dir })).status, 'not_cached');
}));

test('same-version sync skips and failed forced refresh never replaces the last good manifest', async () => isolated(async dir => {
  const captured = input(), payload = normalizeExplorerHTML(captured, catalog); await publishExplorerSnapshot(catalog, payload, captured, dir);
  let requests = 0; const blocked = async () => { requests++; throw new Error('Cached version must not fetch'); };
  assert.equal((await syncExplorer([], { catalog, dir, fetchImpl: blocked })).status, 'live'); assert.equal(requests, 0);
  const original = await readExplorerSnapshot(catalog, dir);
  await assert.rejects(syncExplorer(['--force'], { catalog, dir, fetchImpl: async url => {
    if (url.endsWith('/items')) throw new Error('Second public source unavailable');
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => publicHTML('units') };
  } }), /Second public source/);
  assert.equal((await readExplorerSnapshot(catalog, dir)).manifest.file, original.manifest.file);
  assert.equal((await getExplorerOverallStats({ catalog, dir })).evidence.sources[0].fetchedAt, fetchedAt);
}));

test('offline sync cannot fetch; complete local import retains the original capture times', async () => isolated(async dir => {
  let requests = 0; const blocked = async () => { requests++; throw new Error('Offline must not fetch'); };
  await assert.rejects(syncExplorer(['--offline'], { catalog, dir, fetchImpl: blocked }), /no network request/);
  assert.equal(await readExplorerSnapshot(catalog, dir), null);
  const unitsPath = new URL('units.html', dir), itemsPath = new URL('items.html', dir); await writeFile(unitsPath, publicHTML('units')); await writeFile(itemsPath, publicHTML('items'));
  await assert.rejects(syncExplorer(['--offline', `--units-html=${unitsPath.pathname}`], { catalog, dir, fetchImpl: blocked }), /requires both/);
  // fileURLToPath prevents Windows URL path syntax from reaching readFile.
  const { fileURLToPath } = await import('node:url');
  const argv = ['--offline', `--units-html=${fileURLToPath(unitsPath)}`, `--items-html=${fileURLToPath(itemsPath)}`, `--units-fetched-at=${fetchedAt}`, '--items-fetched-at=2026-10-07T19:44:18.051Z'];
  const result = await syncExplorer(argv, { catalog, dir, fetchImpl: blocked }); assert.equal(result.evidence.sources[0].fetchedAt, fetchedAt);
  assert.equal((await syncExplorer(['--offline'], { catalog, dir, fetchImpl: blocked })).status, 'live'); assert.equal(requests, 0);
}));
