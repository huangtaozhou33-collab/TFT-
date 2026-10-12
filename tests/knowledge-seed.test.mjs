import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedBundle, collectSeedBundle, seedSummary } from '../server/storage/seed.mjs';
import { bootstrapDatabase } from '../scripts/bootstrap-db.mjs';
import { fetchOPGGTool } from '../server/data.mjs';
import { sha256, queryKey } from '../scripts/stats-cache.mjs';
import { exportPackedSeed, loadPackedSeed } from '../scripts/export-seed.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const localOnly = callback => callback();
const bundle = await collectSeedBundle({ withLocalSnapshots: localOnly });
const stored = key => bundle.snapshots.find(row => row.key === key).payload;
const inputs = overrides => ({ catalog: stored('catalog'), library: stored('library'), mechanics: stored('mechanics'),
  overall: stored('overall'), traits: stored('traits'), ...overrides });

test('initial seed captures every validated source snapshot without inventing current-patch statistics', () => {
  assert.equal(bundle.season, 18); assert.equal(bundle.sourcePatch, '18.4');
  assert.equal(bundle.manifest.seedVersion, 'v1');
  assert.equal(bundle.manifest.chunkerVersion, 'conditional-groups-v1');
  assert.equal(bundle.snapshots.length, 210);
  assert.equal(bundle.snapshots.find(row => row.key === 'glossary').sourcePatch, null);
  assert.equal(bundle.snapshots.find(row => row.key === 'glossary').kind, 'editorial_knowledge');
  assert.equal(bundle.manifest.counts.opggSnapshots, 204);
  assert.equal(bundle.manifest.counts.statisticsSnapshots, 204);
  assert.equal(bundle.manifest.counts.patchVerifiedStatisticsSnapshots, 2);
  assert.equal(bundle.manifest.counts.quarantinedStatisticsSnapshots, 202);
  assert.equal(bundle.manifest.counts.tableRows, 846);
  assert.equal(bundle.manifest.jointMatchQueries, false);
  assert.equal(bundle.manifest.rawMatchObservations, 0);
  assert.equal(bundle.snapshots.find(row => row.key === 'catalog').sourcePatch, null);
  assert.equal(bundle.snapshots.find(row => row.key === 'mechanics').sourcePatch, null);
  const build = bundle.snapshots.find(row => row.key === `opgg:${queryKey('tft_get_champion_item_build', { champion_id: 'DA_18_Veigar' })}`);
  assert.ok(build.payload.data.data.length);
  assert.equal(build.kind, 'statistics'); assert.equal(build.sourcePatch, null);
  assert.equal(build.payload.evidence.sourcePatch, null);
  const recipes = bundle.snapshots.find(row => row.key === `opgg:${queryKey('tft_list_item_combinations', { lang: 'zh_CN' })}`);
  assert.equal(recipes.kind, 'entity_reference'); assert.equal(recipes.sourcePatch, '18.4');
  assert.equal(bundle.capabilities.find(row => row.id === 'opgg_mcp').statisticsPatchVerified, false);
  assert.ok(bundle.capabilities.filter(row => row.jointMatchQueries != null).every(row => row.jointMatchQueries === false));
});

test('seed IDs audit complete content and remain stable when only runtime ages change', async () => {
  const { id, ...content } = bundle;
  assert.equal(id, sha256(content));
  const again = await collectSeedBundle({ withLocalSnapshots: localOnly, fetchOPGGTool: async (...args) => {
    const result = await fetchOPGGTool(...args);
    return { ...result, evidence: { ...result.evidence, snapshotAgeSeconds: 99999999 } };
  } });
  assert.equal(again.id, bundle.id);
  assert.ok(again.snapshots.every(row => row.payload.evidence?.snapshotAgeSeconds === undefined));
  for (const fingerprint of bundle.manifest.fingerprints) assert.equal(fingerprint.contentHash, sha256(stored(fingerprint.key)));
  const library = structuredClone(stored('library'));
  library.documents.find(doc => doc.id === 'shop-odds').summary += ' 来源新增说明。';
  assert.notEqual(buildSeedBundle(inputs({ library })).id, buildSeedBundle(inputs()).id);
});

test('seed patch is derived from matching reviewed evidence, never from asset versions or capture dates', () => {
  const overall = structuredClone(stored('overall')); overall.evidence.sourcePatch = '18.5';
  assert.throws(() => buildSeedBundle(inputs({ overall })), /conflicting patches/);
  overall.evidence.sourcePatch = null;
  assert.throws(() => buildSeedBundle(inputs({ overall })), /patch-verified/);
  const library = structuredClone(stored('library')); library.documents.forEach(doc => { doc.retrievalEligible = false; });
  assert.throws(() => buildSeedBundle(inputs({ library })), /no reviewed/);
  const traits = structuredClone(stored('traits')); traits.context.set = 17;
  assert.throws(() => buildSeedBundle(inputs({ traits })), /another season/);
  assert.match(bundle.manifest.patchMeaning, /not a claim about the latest live game patch/);
});

test('collector enters local snapshot scope before any reader and fails closed on missing source records', async () => {
  let local = false, reads = 0;
  const readers = {
    withLocalSnapshots: async callback => { assert.equal(local, false); local = true; try { return await callback(); } finally { local = false; } },
    getCatalog: async () => { assert.ok(local); reads++; return stored('catalog'); },
    getLibrarySnapshot: async () => { assert.ok(local); reads++; return stored('library'); },
    getSeasonMechanic: async () => { assert.ok(local); reads++; return stored('mechanics'); },
    getExplorerOverallStats: async () => { assert.ok(local); reads++; return stored('overall'); },
    getTraitStats: async () => { assert.ok(local); reads++; return stored('traits'); },
    readManifest: async () => { assert.ok(local); reads++; return { records: { one: { tool: 'tft_list_meta_decks', args: {} } } }; },
    fetchOPGGTool: async () => { assert.ok(local); reads++; return { status: 'not_cached', evidence: { sourcePatch: null } }; }
  };
  await assert.rejects(collectSeedBundle(readers), /missing or failed validation/);
  assert.equal(local, false); assert.equal(reads, 7);
});

test('dry-run validates and summarizes without touching MySQL', async () => {
  const result = await bootstrapDatabase({ dryRun: true, dependencies: {
    collectSeedBundle: async () => bundle,
    migrate: () => assert.fail('dry-run must not migrate'), publishBundle: () => assert.fail('dry-run must not publish'), closeDatabase: () => assert.fail('dry-run must not connect')
  } });
  assert.deepEqual(result, { status: 'dry_run', ...seedSummary(bundle) });
  assert.equal(JSON.stringify(result).includes('payload'), false);
});

test('bootstrap migrates before publishing and closes connections after success or failure', async () => {
  const events = [];
  const dependencies = { collectSeedBundle: async () => { events.push('collect'); return bundle; },
    migrate: async () => { events.push('migrate'); },
    publishBundle: async actual => { assert.equal(actual.id, bundle.id); events.push('publish'); return { status: 'published', releaseId: actual.id }; },
    closeDatabase: async () => { events.push('close'); } };
  const result = await bootstrapDatabase({ dependencies });
  assert.equal(result.status, 'published'); assert.deepEqual(events, ['collect', 'migrate', 'publish', 'close']);
  events.length = 0;
  await assert.rejects(bootstrapDatabase({ dependencies: { ...dependencies, publishBundle: async () => { events.push('publish'); throw new Error('injected publication failure'); } } }), /injected publication failure/);
  assert.deepEqual(events, ['collect', 'migrate', 'publish', 'close']);
  events.length = 0;
  await assert.rejects(bootstrapDatabase({ dependencies: { ...dependencies, migrate: async () => { events.push('migrate'); throw new Error('injected migration failure'); } } }), /injected migration failure/);
  assert.deepEqual(events, ['collect', 'migrate', 'close']);
});

async function withSeedDirectory(callback) {
  const testRoot = fileURLToPath(new URL('../tmp/', import.meta.url));
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'tft-packed-seed-'));
  try { return await callback(directory); }
  finally { assert.ok(resolve(directory).startsWith(resolve(testRoot) + sep)); await rm(directory, { recursive: true, force: true }); }
}
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

test('exported seed is deterministic, independently checksummed and usable without local statistic snapshots', async () => {
  await withSeedDirectory(async directory => {
    assert.equal(await loadPackedSeed({ directory }), null);
    const first = await exportPackedSeed({ directory, bundle });
    assert.equal(first.status, 'exported');
    const compressed = await readFile(join(directory, 'current.json.gz'));
    assert.equal(bytesHash(compressed), first.manifest.sha256);
    const second = await exportPackedSeed({ directory, bundle });
    assert.equal(second.status, 'unchanged'); assert.deepEqual(second.manifest, first.manifest);
    const loaded = await loadPackedSeed({ directory });
    assert.deepEqual(loaded, bundle);
    const summary = await bootstrapDatabase({ dryRun: true, dependencies: {
      loadPackedSeed: () => loadPackedSeed({ directory }),
      collectSeedBundle: () => assert.fail('valid packaged seed must not read ignored local snapshots')
    } });
    assert.equal(summary.releaseId, bundle.id);
    assert.equal(summary.counts.quarantinedStatisticsSnapshots, 202);
  });
});

test('seed archive corruption, forged bundle IDs and mismatched manifest metadata fail closed', async () => {
  await withSeedDirectory(async directory => {
    const first = await exportPackedSeed({ directory, bundle });
    const path = join(directory, 'current.json.gz'), manifestPath = join(directory, 'manifest.json');
    const original = await readFile(path);
    const damaged = Buffer.from(original); damaged[damaged.length - 10] ^= 1;
    await writeFile(path, damaged);
    await assert.rejects(loadPackedSeed({ directory }), /compressed bytes failed checksum/);
    await assert.rejects(bootstrapDatabase({ dryRun: true, dependencies: { loadPackedSeed: () => loadPackedSeed({ directory }),
      collectSeedBundle: () => assert.fail('corrupt package must not fall back silently') } }), /checksum/);

    const forged = structuredClone(bundle); forged.documents[0].title += ' tampered';
    const json = Buffer.from(JSON.stringify(forged)), gz = gzipSync(json);
    await writeFile(path, gz);
    await writeFile(manifestPath, JSON.stringify({ ...first.manifest, sha256: bytesHash(gz), uncompressedSha256: bytesHash(json), compressedBytes: gz.length, uncompressedBytes: json.length }));
    await assert.rejects(loadPackedSeed({ directory }), /content hash differs from its ID/);

    await writeFile(path, original);
    await writeFile(manifestPath, JSON.stringify({ ...first.manifest, sourcePatch: '18.5' }));
    await assert.rejects(loadPackedSeed({ directory }), /metadata differs/);
    await writeFile(manifestPath, JSON.stringify({ ...first.manifest, counts: { ...first.manifest.counts, entities: 1 } }));
    await assert.rejects(loadPackedSeed({ directory }), /metadata differs/);
    await writeFile(manifestPath, JSON.stringify({ ...first.manifest, file: '../catalog.json' }));
    await assert.rejects(loadPackedSeed({ directory }), /Unsupported seed package metadata/);
  });
});

test('explicit from-local bypasses a package and incomplete packages never count as absent', async () => {
  const result = await bootstrapDatabase({ dryRun: true, fromLocal: true, dependencies: {
    collectSeedBundle: async () => bundle,
    loadPackedSeed: () => assert.fail('--from-local must not use package')
  } });
  assert.equal(result.releaseId, bundle.id);
  await withSeedDirectory(async directory => {
    await exportPackedSeed({ directory, bundle });
    await rm(join(directory, 'manifest.json'));
    await assert.rejects(loadPackedSeed({ directory }), /without its manifest/);
    await exportPackedSeed({ directory, bundle });
    await rm(join(directory, 'current.json.gz'));
    await assert.rejects(loadPackedSeed({ directory }), /archive is missing/);
  });
});
