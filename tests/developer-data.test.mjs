import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheKeyFor, cacheContext, publishRecords, queryKey, sha256 } from '../scripts/stats-cache.mjs';
import { createDeveloperData } from '../server/developer-data.mjs';
import { normalizeTeamPlannerMapping, publishTeamCodeMapping } from '../server/team-code.mjs';

const context = { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', gamePatch: null, rulesVersion: 'developer-fixture-v1', language: 'zh_cn', fetchedAt: '2026-10-07T13:39:03.456Z' };
const catalog = { context, champions: [{ id: 'DA_18_Maokai', name: '茂凯', cost: 5, traits: ['主宰'], ability: { name: '技能', description: '真实归一化技能说明' } }],
  items: [{ id: 'DA_WarmogsArmor', name: '狂徒铠甲', description: '增加生命值。', kind: 'completed', category: 'core', components: [] }],
  traits: [{ id: 'DA_Juggernaut18', name: '主宰', description: '减少受到的伤害。', effects: [{ minUnits: 2, maxUnits: 3 }] }], augments: [{ id: 'DA_Augment', name: '强化', description: '强化说明' }],
  sources: [{ id: 'communitydragon', url: 'https://raw.communitydragon.org/16.20/cdragon/tft/zh_cn.json', fetchedAt: context.fetchedAt, set: 18, assetVersion: '16.20', sha256: 'a'.repeat(64) }] };
const secret = 'DEVELOPER_FIXTURE_PRIVATE_SENTINEL';
async function isolated(run) {
  const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-developer-test-'), dir = await mkdtemp(prefix);
  try { await writeFile(join(dir, 'catalog.json'), JSON.stringify(catalog)); await run({ dir, url: pathToFileURL(dir + sep), api: createDeveloperData({ dataDir: dir }) }); }
  finally { assert.ok(resolve(dir).startsWith(resolve(prefix))); await rm(dir, { recursive: true, force: true }); }
}
async function seedStats(url, { catalogValue = catalog, placement = 4.14, itemId = 'DA_WarmogsArmor', championId = 'DA_18_Maokai', unsupported = false } = {}) {
  const raw = { tool: 'tft_get_champion_item_build', args: { champion_id: championId }, status: 'ok', endpoint: 'https://mcp-api.op.gg/mcp', fetchedAt: '2026-10-07T14:19:05.347Z',
    body: { data: [{ characterId: championId, itemNames: [itemId, itemId, itemId], avgPlacement: placement, top4Rate: .5574, winRate: .1945, itemCount: 100, totalChampionCount: 500, secret, apiKey: secret }], apiKey: secret } };
  const records = new Map([[queryKey(raw.tool, raw.args), raw]]);
  if (unsupported) { const missing = { tool: 'tft_list_champions_for_item', args: { item_id: itemId }, status: 'not_supported', endpoint: raw.endpoint, fetchedAt: raw.fetchedAt, reason: '公开工具不支持' }; records.set(queryKey(missing.tool, missing.args), missing); }
  return publishRecords(catalogValue, records, { dir: new URL('stats/', url) });
}
async function seedTeamCodes(url, { catalogValue = catalog, plannerCode = 1045 } = {}) {
  const raw = { [catalogValue.context.mutator]: [{ character_id: 'DA_18_Maokai', team_planner_code: plannerCode }], credentials: secret };
  const payload = normalizeTeamPlannerMapping(raw, catalogValue, { fetchedAt: '2026-10-08T06:45:28.855Z', sourceTime: '2026-09-12T00:36:20Z' });
  return publishTeamCodeMapping(catalogValue, payload, raw, new URL('team-codes/', url));
}

test('overview reflects actual local JSON storage and current whitelist counts, without a vector/database claim', async () => isolated(async ({ api }) => {
  const result = await api.getDeveloperOverview();
  assert.equal(result.status, 'ready'); assert.deepEqual(result.counts.entities, { champions: 1, items: 1, traits: 1, augments: 1, mechanics: 0 });
  assert.equal(result.counts.documents, 4); assert.equal(result.counts.retrievalEligibleDocuments, 4); assert.equal(result.storage.engine, 'local_json');
  assert.equal(result.sourceAccounting.unit, 'source_field_projection');
  assert.deepEqual(result.sourceAccounting.groups.map(({ id, count }) => ({ id, count })), [{ id: 'tool_mapped', count: 4 }]);
  for (const service of ['mysql', 'milvus', 'redis']) assert.equal(result.storage[service].status, 'not_connected');
  assert.equal(result.storage.embedding.status, 'not_configured'); assert.equal(result.storage.embedding.vectorIndexed, false);
  assert.equal(result.assets[0].validation.checksumVerified, false); assert.equal(result.assets[0].validation.status, 'schema_valid_checksum_not_recorded');
  for (const operation of ['publish', 'rollback', 'rebuild']) { assert.equal(result.operations[operation].enabled, false); assert.equal(result.operations[operation].permission, 'external_not_configured'); }
}));

test('document IDs never become paths; raw files, credentials and engineering docs are outside the whitelist', async () => isolated(async ({ dir, api, url }) => {
  await mkdir(join(dir, 'raw'), { recursive: true }); await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, '.env'), `API_KEY=${secret}`); await writeFile(join(dir, 'raw', 'private.json'), JSON.stringify({ id: 'Secret', secret }));
  await writeFile(join(dir, 'docs', 'engineering.md'), secret); await seedStats(url);
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('No developer runtime network'); };
  try {
    const overview = await api.getDeveloperOverview({ dir: 'C:/', path: '../../.env' }), listing = await api.getDeveloperDocuments({ pageSize: 100, dataDir: '..' }), releases = await api.getDeveloperReleases();
    const doc = await api.getDeveloperDocument(listing.documents.find(row => row.kind === 'champion_builds').id);
    assert.ok(doc.id.startsWith('doc_')); assert.match(doc.fingerprint, /^[a-f0-9]{64}$/); assert.ok(doc.chunks.length); assert.equal(doc.contentOrigin, 'normalized_entity');
    assert.equal(doc.content.rows[0].stats.avgPlacement, 4.14); assert.equal(doc.content.rows[0].apiKey, undefined); assert.equal(doc.content.rows[0].secret, undefined);
    assert.equal(doc.chunking.vectorIndexed, false); assert.equal(await api.getDeveloperDocument('../../.env'), null); assert.equal(await api.getDeveloperDocument('C:/Users/example/.env'), null);
    assert.equal(await api.getDeveloperDocument(`doc_${'0'.repeat(32)}`), null);
    const output = JSON.stringify({ overview, listing, releases, doc }); assert.ok(!output.includes(secret)); assert.ok(!output.includes('engineering.md')); assert.ok(!output.includes('private.json'));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('source/status/version filters operate on the full document index before bounded pagination', async () => isolated(async ({ api, url }) => {
  await seedStats(url);
  const page = await api.getDeveloperDocuments({ source: 'OP.GG MCP', pageSize: 1, page: 99 });
  assert.equal(page.pagination.total, 1); assert.equal(page.documents.length, 1); assert.equal(page.pagination.page, 1);
  assert.equal(page.documents[0].kind, 'champion_builds'); assert.ok(page.documents[0].retrievalEligibility.eligible);
  const fingerprint = page.documents[0].fingerprint;
  assert.equal((await api.getDeveloperDocuments({ q: fingerprint })).pagination.total, 1);
  assert.equal((await api.getDeveloperDocuments({ q: page.documents[0].contentFingerprint })).documents[0].id, page.documents[0].id);
  const expectedKey = cacheKeyFor(catalog); assert.ok(page.filterOptions.cacheKey.includes(expectedKey)); assert.ok(page.filterOptions.versions.includes(expectedKey));
  assert.equal((await api.getDeveloperDocuments({ cacheKey: 'unknown-version' })).pagination.total, 0);
  assert.equal((await api.getDeveloperDocuments({ set: 17 })).pagination.total, 0);
  assert.equal((await api.getDeveloperDocuments({ patch: '18.4' })).pagination.total, 0); // OP.GG build patch remains unknown.
  assert.equal((await api.getDeveloperDocuments({ patch: 'unknown', status: 'ready', q: '茂凯', pageSize: 999 })).pagination.pageSize, 100);
}));

test('verified retained manifests stay view-only; cross-set same-family differences use real records without activating them', async () => isolated(async ({ api, url }) => {
  await seedStats(url, { placement: 4.4 }); await seedStats(url, { placement: 4.14 });
  const oldCatalog = { ...catalog, context: { ...context, set: 17, mutator: 'TFTSet17', assetVersion: '16.19', rulesVersion: 'developer-fixture-old' } };
  await seedStats(url, { catalogValue: oldCatalog, placement: 4.7 });
  const releases = await api.getDeveloperReleases(), stats = releases.releases.filter(row => row.family === 'stats');
  assert.equal(stats.length, 3); assert.equal(releases.baseline.available, true); assert.deepEqual(releases.baseline.comparableFamilies, ['stats']);
  const active = stats.find(row => row.current && row.active), historical = stats.find(row => row.set === 17), retained = stats.find(row => row.current && !row.active);
  assert.equal(historical.status, 'version_mismatch'); assert.equal(historical.validation.checksumVerified, true); assert.equal(retained.publicationState, 'retained_manifest');
  const oldDocs = await api.getDeveloperDocuments({ cacheKey: historical.cacheKey }); assert.equal(oldDocs.documents[0].retrievalEligibility.mode, 'view_only'); assert.equal(oldDocs.documents[0].retrievalEligibility.eligible, false);
  const diff = await api.previewDeveloperDiff({ from: historical.id, to: active.id });
  assert.equal(diff.status, 'ready'); assert.equal(diff.contextChanged, true); assert.equal(diff.changes.changed, 1); assert.equal(diff.previewOnly, true); assert.equal(diff.rollback.executable, false);
  assert.equal((await api.previewDeveloperDiff({ from: retained.id, to: active.id })).changes.changed, 1);
  const overview = await api.getDeveloperOverview();
  assert.deepEqual(Object.fromEntries(overview.sourceAccounting.groups.map(group => [group.id, group.count])), { tool_mapped: 5, retained_revision: 1, other_version: 1 });
  assert.equal(overview.sourceAccounting.groups.reduce((total, group) => total + group.count, 0), overview.counts.documents);
}));

test('an omitted local snapshot is distinguished from hash corruption and never treated as a database failure', async () => isolated(async ({ api, url }) => {
  const manifest = await seedStats(url), entry = Object.values(manifest.records)[0];
  await unlink(new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/records/${entry.file}`, new URL('stats/', url)));
  const overview = await api.getDeveloperOverview(), asset = overview.assets.find(row => row.family === 'stats');
  assert.equal(asset.status, 'local_files_unavailable'); assert.equal(asset.validation.valid, false);
  assert.equal(asset.validation.status, 'local_files_unavailable'); assert.equal(asset.validation.reason, 'local_snapshot_files_unavailable');
  assert.equal(asset.retrievalEligibility.eligible, false); assert.match(asset.retrievalEligibility.reason, /不是数据库损坏/);
  assert.equal(overview.counts.validationFailures, 0); assert.equal(overview.counts.localFilesUnavailablePackages, 1);
  assert.equal((await api.getDeveloperDocuments({ source: 'OP.GG MCP' })).pagination.total, 0);
  const releases = await api.getDeveloperReleases();
  assert.ok(releases.events.some(event => event.type === 'local_asset_availability' && event.status === 'unavailable'));
  assert.ok(!releases.events.some(event => event.type === 'current_validation' && event.packageId === asset.id));
}));

test('a record hash failure is visible on assets/releases and completely blocks its tool-document projection', async () => isolated(async ({ api, url }) => {
  const manifest = await seedStats(url), entry = Object.values(manifest.records)[0], path = new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/records/${entry.file}`, new URL('stats/', url));
  const record = JSON.parse(await readFile(path, 'utf8')); record.body.data[0].avgPlacement = 1; await writeFile(path, JSON.stringify(record));
  const overview = await api.getDeveloperOverview(), asset = overview.assets.find(row => row.family === 'stats');
  assert.equal(asset.status, 'invalid'); assert.equal(asset.validation.valid, false); assert.equal(asset.retrievalEligibility.mode, 'blocked'); assert.equal(overview.counts.validationFailures, 1);
  assert.equal((await api.getDeveloperDocuments({ source: 'OP.GG MCP' })).pagination.total, 0);
  const release = await api.getDeveloperReleases(); assert.ok(release.events.some(event => event.type === 'current_validation' && event.status === 'failed' && event.occurredAt === null));
  assert.equal(release.baseline.available, false);
}));

test('unsafe manifest pointers never open arbitrary files and are recorded as invalid packages', async () => isolated(async ({ dir, api }) => {
  const key = cacheKeyFor(catalog), versionDir = join(dir, 'traits', key); await mkdir(versionDir, { recursive: true });
  await writeFile(join(dir, '.env'), `PRIVATE=${secret}`); await writeFile(join(versionDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, cacheKey: key, context: cacheContext(catalog), file: '../../../.env', sha256: 'f'.repeat(64) }));
  const overview = await api.getDeveloperOverview(); assert.equal(overview.assets.find(row => row.family === 'traits').status, 'invalid');
  assert.ok(!JSON.stringify(overview).includes(secret)); assert.ok(!JSON.stringify(overview).includes('../../../.env'));
  assert.equal((await api.getDeveloperDocuments()).pagination.total, 4);
}));

test('diff rejects paths, unknown IDs, different families and missing verified baseline; unsupported statistics stay view-only', async () => isolated(async ({ api, url }) => {
  await seedStats(url, { unsupported: true }); const releases = await api.getDeveloperReleases(), stats = releases.releases.find(row => row.family === 'stats'), staticRelease = releases.releases.find(row => row.family === 'catalog');
  assert.equal(releases.baseline.available, false); assert.equal((await api.previewDeveloperDiff({ from: stats.id, to: stats.id })).status, 'missing_baseline');
  assert.equal((await api.previewDeveloperDiff({ from: '../../.env', to: stats.id })).status, 'invalid_selection');
  assert.equal((await api.previewDeveloperDiff({ from: `rel_${'0'.repeat(32)}`, to: stats.id })).status, 'invalid_selection');
  assert.equal((await api.previewDeveloperDiff({ from: staticRelease.id, to: stats.id })).status, 'incompatible');
  const docs = await api.getDeveloperDocuments({ source: 'OP.GG MCP' }), unsupported = docs.documents.find(doc => doc.kind === 'item_holders');
  assert.equal(unsupported.retrievalEligibility.eligible, false); assert.equal((await api.getDeveloperDocument(unsupported.id)).content.rows.length, 0);
}));

test('junction/symlink directories cannot redirect the package whitelist to other directories', async t => isolated(async ({ dir, api }) => {
  const outside = join(dir, 'not-a-knowledge-family'), target = join(outside, cacheKeyFor(catalog)), alias = join(dir, 'traits');
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'manifest.json'), JSON.stringify({ malicious: secret }));
  try { await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not allow fixture symlinks'); return; } throw error; }
  try { const overview = await api.getDeveloperOverview(); assert.equal(overview.assets.length, 1); assert.ok(!JSON.stringify(overview).includes(secret)); }
  finally { await unlink(alias); }
}));

test('quoted JSON, spaced Basic authorization and URL credentials are redacted in descriptions, original text and recorded failures', async () => isolated(async ({ dir, url, api }) => {
  const examples = ['JSON_API_EXAMPLE_ONLY', 'BASIC_EXAMPLE_ONLY', 'URL_USER_EXAMPLE_ONLY', 'URL_PASSWORD_EXAMPLE_ONLY', 'QUERY_EXAMPLE_ONLY', 'FRAGMENT_EXAMPLE_ONLY'];
  const text = `普通说明 {"apiKey" : "${examples[0]}"} { "authorization" : "Basic ${examples[1]} with spaces" } https://${examples[2]}:${examples[3]}@example.test/read?api_key=${examples[4]}&view=public#access_token=${examples[5]}`;
  const seeded = structuredClone(catalog); seeded.items[0].description = text; await writeFile(join(dir, 'catalog.json'), JSON.stringify(seeded));
  const manifest = await seedStats(url); manifest.failures = [{ tool: 'tft_list_champions_for_item', stage: 'HTTP', reason: text }];
  await writeFile(new URL(`${manifest.cacheKey}/manifest.json`, new URL('stats/', url)), JSON.stringify(manifest));
  await writeFile(join(dir, 'opgg-status.json'), JSON.stringify({ fetchedAt: '2026-10-07T14:00:00Z', stages: [{ name: '公开探针', status: 'failed', reason: text }] }));
  const documents = await api.getDeveloperDocuments({ q: '狂徒铠甲' }), id = documents.documents.find(row => row.kind === 'catalog_items').id;
  const detail = await api.getDeveloperDocument(id), releases = await api.getDeveloperReleases();
  for (const result of [detail.content.description, detail.originalText, ...detail.chunks.map(chunk => JSON.stringify(chunk.content)), JSON.stringify(releases.events)]) {
    for (const example of examples) assert.ok(!result.includes(example), `Text credentials escaped redaction: ${example}`);
  }
  assert.match(detail.content.description, /普通说明/); assert.match(detail.originalText, /redacted/);
  assert.ok(releases.events.some(event => event.type === 'recorded_sync_failure')); assert.ok(releases.events.some(event => event.type === 'recorded_probe'));
}));

test('PC team-code assets expose exact mapped and unmapped counts and local slices while remaining outside AI retrieval', async () => isolated(async ({ dir, url, api }) => {
  const mappingCatalog = structuredClone(catalog); mappingCatalog.champions.push({ id: 'DA_18_Lux_Coven', name: '拉克丝 (魔女)', cost: 4, traits: [] });
  await writeFile(join(dir, 'catalog.json'), JSON.stringify(mappingCatalog)); await seedTeamCodes(url, { catalogValue: mappingCatalog });
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Developer mapping must remain local'); };
  try {
    const overview = await api.getDeveloperOverview({ source: 'CommunityDragon · PC Team Planner' }), asset = overview.assets[0];
    assert.equal(overview.pagination.total, 1); assert.equal(asset.family, 'teamcodes'); assert.equal(asset.status, 'ready'); assert.equal(asset.validation.checksumVerified, true);
    assert.deepEqual(asset.counts, { entries: 1, sourceRows: 1, mappedChampions: 1, catalogChampions: 2, unmappedChampions: 1, excluded: 0, complete: false });
    assert.equal(asset.fetchedAt, '2026-10-08T06:45:28.855Z'); assert.equal(asset.sourcePatch, null); assert.equal(asset.sources[0].sourceTime, '2026-09-12T00:36:20Z');
    assert.equal(asset.sources[0].url, 'https://raw.communitydragon.org/16.20/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json');
    assert.equal(asset.retrievalEligibility.eligible, false); assert.equal(asset.retrievalEligibility.mode, 'view_only'); assert.deepEqual(asset.retrievalEligibility.tools, []);
    assert.equal(overview.counts.retrievalEligibleDocuments, 5); // Only the five catalog entities; mappings are not AI documents.
    const listing = await api.getDeveloperDocuments({ source: asset.source, cacheKey: asset.cacheKey }); assert.equal(listing.pagination.total, 3);
    const mapped = await api.getDeveloperDocument(listing.documents.find(row => row.kind === 'team_code_mapping').id);
    const unmapped = await api.getDeveloperDocument(listing.documents.find(row => row.kind === 'team_code_unmapped').id);
    const rules = await api.getDeveloperDocument(listing.documents.find(row => row.kind === 'team_code_rules').id);
    assert.equal(mapped.content.championId, 'DA_18_Maokai'); assert.equal(mapped.content.v2, 1045); assert.equal(mapped.chunking.vectorIndexed, false); assert.match(mapped.contentNote, /不是统计结果/);
    assert.equal(unmapped.content.id, 'DA_18_Lux_Coven'); assert.equal(unmapped.content.encodingSupported, false); assert.equal(unmapped.content.v2, null);
    assert.deepEqual(rules.content.includes, { champions: true, items: false, positions: false, stars: false }); assert.equal(rules.content.coverage.unmappedCatalog.length, 1);
    assert.ok(!JSON.stringify({ overview, mapped, unmapped, rules }).includes(secret)); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('PC mapping tampering or a forged coverage fingerprint stays visible as invalid and cannot become a document projection', async () => isolated(async ({ api, url }) => {
  const manifest = await seedTeamCodes(url), base = new URL(`${manifest.cacheKey}/`, new URL('team-codes/', url)), path = new URL(manifest.file, base);
  const payload = JSON.parse(await readFile(path, 'utf8')); payload.entries[0].v2 = 1046; payload.v2 = { 1046: 'DA_18_Maokai' }; await writeFile(path, JSON.stringify(payload));
  let overview = await api.getDeveloperOverview(), asset = overview.assets.find(row => row.family === 'teamcodes');
  assert.equal(asset.status, 'invalid'); assert.equal(asset.validation.reason, 'manifest_payload_hash_or_context_mismatch'); assert.equal(asset.retrievalEligibility.mode, 'blocked');
  assert.equal((await api.getDeveloperDocuments({ source: asset.source })).pagination.total, 0);
  payload.championFingerprint = 'e'.repeat(64); manifest.sha256 = sha256(payload); await writeFile(path, JSON.stringify(payload)); await writeFile(new URL('manifest.json', base), JSON.stringify(manifest));
  overview = await api.getDeveloperOverview(); asset = overview.assets.find(row => row.family === 'teamcodes');
  assert.equal(asset.validation.valid, false); assert.equal(asset.validation.reason, 'invalid_package_context_or_schema'); assert.equal((await api.getDeveloperDocuments({ source: asset.source })).pagination.total, 0);
  assert.ok((await api.getDeveloperReleases()).events.some(event => event.type === 'current_validation' && event.packageId === asset.id));
}));

test('PC mapping manifests in historical version directories can preview field differences without activating them', async () => isolated(async ({ api, url }) => {
  const oldCatalog = { ...catalog, context: { ...context, rulesVersion: 'developer-teamcode-old' } };
  await seedTeamCodes(url, { catalogValue: oldCatalog, plannerCode: 1044 }); await seedTeamCodes(url);
  const releases = await api.getDeveloperReleases(), rows = releases.releases.filter(row => row.family === 'teamcodes');
  assert.equal(rows.length, 2); assert.ok(releases.baseline.comparableFamilies.includes('teamcodes'));
  const old = rows.find(row => !row.current), current = rows.find(row => row.current); assert.equal(old.status, 'version_mismatch'); assert.equal(old.validation.checksumVerified, true);
  const historical = await api.getDeveloperDocuments({ source: old.source, cacheKey: old.cacheKey });
  assert.equal(historical.pagination.total, 2); assert.ok(historical.documents.every(row => row.retrievalEligibility.mode === 'view_only' && !row.retrievalEligibility.eligible));
  const diff = await api.previewDeveloperDiff({ from: old.id, to: current.id }); assert.equal(diff.status, 'ready'); assert.equal(diff.contextChanged, true); assert.equal(diff.changes.changed, 1);
  assert.equal(diff.rollback.executable, false); assert.equal(diff.operations.publish.enabled, false); assert.equal((await api.previewDeveloperDiff({ from: '../../team-codes/raw/private.json', to: current.id })).status, 'invalid_selection');
}));

test('a retained PC payload without its own manifest cannot become a verified rollback baseline', async () => isolated(async ({ api, url }) => {
  await seedTeamCodes(url, { plannerCode: 1044 }); await seedTeamCodes(url);
  const releases = await api.getDeveloperReleases(), rows = releases.releases.filter(row => row.family === 'teamcodes'); assert.equal(rows.length, 2);
  const retained = rows.find(row => !row.active), active = rows.find(row => row.active);
  assert.equal(retained.publicationState, 'payload_only'); assert.equal(retained.validation.checksumVerified, false); assert.equal(retained.retrievalEligibility.mode, 'view_only');
  assert.equal(releases.baseline.available, false); assert.equal((await api.previewDeveloperDiff({ from: retained.id, to: active.id })).status, 'incompatible');
}));
