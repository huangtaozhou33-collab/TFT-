import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCatalog, getMetaDecks, getChampionBuild, getItemHolders, getStatsOverview, getSourceStatus } from '../server/data.mjs';
import { cacheKeyFor, queryKey, readManifest, readRecord, publishRecords, savePendingRecord, readPendingRecords, acquireSyncLock } from '../scripts/stats-cache.mjs';

async function isolated(run) {
  const testRoot = resolve('tmp'); await mkdir(testRoot, { recursive: true });
  const prefix = join(testRoot, 'tft-version-cache-test-'); const directory = await mkdtemp(prefix); const dir = pathToFileURL(directory + sep);
  try { await run(dir); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
}
function fixture(catalog) {
  return { status: 'ok', tool: 'tft_list_meta_decks', args: {}, fetchedAt: '2026-10-07T12:00:00.000Z', endpoint: 'https://mcp-api.op.gg/mcp', body: { data: [{ id: 'fixture', teamCode: `example${catalog.context.mutator}`, units: [{ key: catalog.champions[0].id, items: [] }] }], metadata: { gameStatDateTime: '2026-10-07T11:00:00.000Z' } } };
}

test('runtime data readers never access the network, including missing entities', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Runtime networking is forbidden'); };
  try {
    const overview = await getStatsOverview(); assert.equal(overview.delivery, 'version_cache');
    assert.equal(overview.capabilities.championOverallStats, overview.coverage.overallStats.status === 'live'); assert.equal(overview.capabilities.augmentStats, false);
    const deck = await getMetaDecks(); assert.equal(deck.evidence.delivery, 'version_cache');
    const maokai = await getChampionBuild('DA_18_Maokai');
    assert.ok(['live', 'not_cached'].includes(maokai.status));
    if (maokai.status === 'live') { assert.ok(maokai.data.length > 0); assert.equal(maokai.evidence.sourcePatch, null); }
    else { assert.equal(maokai.code, 'not_cached'); assert.match(maokai.reason, /不会自动访问上游/); }
    const missing = overview.champions.find(item => !item.cached && item.status !== 'not_supported');
    if (missing) { const result = await getChampionBuild(missing.id); assert.equal(result.code, 'not_cached'); assert.match(result.reason, /不会自动访问上游/); }
    const uncachedItem = overview.items.find(item => !item.cached && item.status !== 'not_supported');
    if (uncachedItem) assert.equal((await getItemHolders(uncachedItem.id)).code, 'not_cached');
    assert.equal((await getSourceStatus()).opgg.delivery, 'version_cache'); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test('published caches isolate set, asset and rules versions; tampering is not served', async () => isolated(async dir => {
  const catalog = await getCatalog(); const raw = fixture(catalog); const records = new Map([[queryKey(raw.tool, raw.args), raw]]);
  const manifest = await publishRecords(catalog, records, { dir });
  assert.ok(await readManifest(catalog, dir)); assert.ok(await readRecord(manifest, raw.tool, raw.args, dir));
  for (const context of [{ ...catalog.context, set: catalog.context.set + 1 }, { ...catalog.context, assetVersion: '16.21' }, { ...catalog.context, rulesVersion: catalog.context.rulesVersion + '-changed' }]) {
    const changed = { ...catalog, context }; assert.notEqual(cacheKeyFor(changed), manifest.cacheKey); assert.equal(await readManifest(changed, dir), null);
  }
  const entry = manifest.records[queryKey(raw.tool, raw.args)]; const path = new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/records/${entry.file}`, dir);
  const changed = JSON.parse(await readFile(path, 'utf8')); changed.body.metadata.gameStatDateTime = 'invented'; await writeFile(path, JSON.stringify(changed));
  assert.equal(await readRecord(manifest, raw.tool, raw.args, dir), null);
}));

test('invalid/interrupted updates preserve last good manifest and original capture timestamps', async () => isolated(async dir => {
  const catalog = await getCatalog(), raw = fixture(catalog), records = new Map([[queryKey(raw.tool, raw.args), raw]]);
  const previous = await publishRecords(catalog, records, { dir });
  const bad = { ...raw, body: { data: [{ teamCode: 'exampleTFTSet1', units: [{ key: 'old-set-champion', items: [] }] }] } };
  await assert.rejects(publishRecords(catalog, new Map([[queryKey(bad.tool, bad.args), bad]]), { dir }), /outside the current set/);
  const retained = await readManifest(catalog, dir); assert.equal(retained.captureId, previous.captureId);
  assert.equal((await readRecord(retained, raw.tool, raw.args, dir)).record.fetchedAt, raw.fetchedAt);
  await savePendingRecord(catalog, raw, dir); const pending = await readPendingRecords(catalog, dir);
  assert.equal(pending.get(queryKey(raw.tool, raw.args)).fetchedAt, raw.fetchedAt);
  const release = await acquireSyncLock(catalog, dir); await assert.rejects(acquireSyncLock(catalog, dir), /already running/); await release();
}));

test('current artifacts include source-only Deaths Defiance without historical Ornn internals', async () => {
  const catalog = await getCatalog(); const artifacts = catalog.items.filter(item => item.category === 'artifact');
  assert.equal(artifacts.length, 31); assert.ok(artifacts.every(item => !item.id.startsWith('TFT17_')));
  const death = artifacts.find(item => item.id === 'DA_Artifact_DeathsDefiance'); assert.equal(death.sourceOnly, true); assert.equal(death.source.identity, 'opgg'); assert.equal(death.unique, true); assert.equal(death.allocationVerified, false);
  for (const emblem of catalog.items.filter(item => item.category === 'emblem')) {
    assert.equal(emblem.allocationVerified, false); assert.equal(emblem.traitMapping.method, 'exact_name');
    assert.equal(emblem.name, `${catalog.traits.find(trait => trait.id === emblem.traitId).name}纹章`); assert.equal(emblem.traitMapping.compatibilityVerified, false);
  }
});
