// Diagnostic only: read-only MySQL transaction + local read/query HTTP endpoints.
// No migrations, collection, LLM, embedding, or upstream OP.GG requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getPool, getActiveRelease, getSnapshot, closeDatabase } from '../server/storage/repository.mjs';
import { queryKey } from './stats-cache.mjs';
import { selectConditionalBuilds } from '../public/build-query.js';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const itemId = 'DA_Artifact_SilvermereDawn';
const championId = 'DA_Nidalee18_AP';
const minSample = 100;
const base = process.argv.find(value => value.startsWith('--base-url='))?.slice(11) || 'http://127.0.0.1:3000';
const url = new URL(base);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only local application endpoints are allowed');
assert(!url.username && !url.password, 'Credentials must not be included');
const sqlText = await readFile(new URL('./sql/opgg-filter-candidates.sql', import.meta.url), 'utf8');
const sql = Object.fromEntries(sqlText.split('-- query: ').slice(1).map(block => {
  const end = block.indexOf('\n'); return [block.slice(0, end).trim(), block.slice(end + 1).trim()];
}));
const stats = row => ({ sampleSize: Number(row.sample_size), avgPlacement: row.avg_placement, top4Rate: row.top4_rate, winRate: row.win_rate, pickRate: null });
const evidence = value => value ? Object.fromEntries(['source', 'delivery', 'sourcePatch', 'assignedPatch', 'effectivePatch', 'fetchedAt', 'sampleDenominator'].map(key => [key, value[key] ?? null])) : null;
const compact = row => ({ championId: row.championId, itemIds: row.itemIds, itemNames: row.items?.map(item => item.name), name: row.name, stats: row.stats });
async function api(path, body) {
  const response = await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) } : {});
  assert.equal(response.status, 200, `HTTP ${path}`);
  return response.json();
}

let connection, stage = 'connect';
try {
  connection = await (await getPool()).getConnection();
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const release = await getActiveRelease(connection);
  assert(release, 'Published release required');
  const catalog = (await getSnapshot('catalog', connection)).payload;
  const holderKey = `opgg:${queryKey('tft_list_champions_for_item', { item_id: itemId })}`;
  const buildKey = `opgg:${queryKey('tft_get_champion_item_build', { champion_id: championId })}`;
  const [snapshots] = await connection.execute("SELECT evidence_kind,payload FROM source_snapshots WHERE release_id=? AND snapshot_key LIKE 'opgg:%'", [release.id]);
  const groups = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.evidence_kind !== 'statistics') continue;
    const payload = parse(snapshot.payload), tool = payload.evidence?.tool;
    const group = groups.get(tool) || { tool, snapshots: 0, liveSnapshots: 0, rawRows: 0, rowFields: new Set(), snapshotsWithDeclaredPatch: 0 };
    group.snapshots++;
    if (payload.status === 'live') group.liveSnapshots++;
    const rows = Array.isArray(payload.data) ? payload.data : payload.data?.data || [];
    group.rawRows += rows.length;
    for (const row of rows) if (row && typeof row === 'object') for (const key of Object.keys(row)) group.rowFields.add(key);
    if (payload.evidence?.sourcePatch) group.snapshotsWithDeclaredPatch++;
    groups.set(tool, group);
  }
  const holderParams = [holderKey, release.currentPatch, minSample];
  const buildParams = [buildKey, release.currentPatch, championId, itemId, minSample];
  stage = 'sql:item-holders';
  const [holderRows] = await connection.execute(sql['item-holders'], holderParams);
  stage = 'sql:champion-build-candidates';
  const [buildRows] = await connection.execute(sql['champion-build-candidates'], buildParams);
  const heroes = new Map(catalog.champions.map(hero => [hero.id, hero]));
  const holders = holderRows.filter(row => heroes.has(row.champion_id)).map(row => ({ championId: row.champion_id, name: heroes.get(row.champion_id).name, stats: stats(row) }));
  const buildQuery = { championId, requiredItemIds: [itemId], minSample, sort: 'avgPlacement' };
  const selected = selectConditionalBuilds(buildRows.map(row => ({ championId: row.champion_id, itemIds: parse(row.item_ids), stats: stats(row) })), buildQuery, catalog);
  // Known empty scope checks: no inference is allowed to revive another patch/key.
  stage = 'sql:empty-scope-checks';
  const [wrongPatch] = await connection.execute(sql['item-holders'], [holderKey, '0.0', minSample]);
  const [missingSnapshot] = await connection.execute(sql['item-holders'], ['opgg:missing', release.currentPatch, minSample]);
  assert.equal(wrongPatch.length, 0); assert.equal(missingSnapshot.length, 0);
  await connection.commit();
  connection.release(); connection = null;

  stage = 'local-api-comparison';
  const [holderApi, buildApi, research, riot, comps, explorerUnits, explorerEquipment, explorerHolders] = await Promise.all([
    api(`/api/items/${itemId}/holders`), api('/api/builds/query', buildQuery),
    api('/api/research/query/v2', { conditions: [{ type: 'item', id: itemId, holderId: null }], minSample, sort: 'avgPlacement' }),
    api('/api/riot/status'), api('/api/comps'), api('/api/explorer?tab=units'), api('/api/explorer?tab=equipment'), api('/api/explorer?tab=items'),
  ]);
  assert.equal(holderApi.evidence.releaseId, release.id, 'Active release changed during audit');
  const byHero = rows => [...rows].sort((a, b) => a.championId.localeCompare(b.championId));
  assert.deepEqual(byHero(holders).map(row => [row.championId, row.stats]), byHero(holderApi.data.filter(row => row.stats.sampleSize >= minSample)).map(row => [row.championId, row.stats]));
  const buildSignature = rows => rows.map(row => [row.championId, [...row.itemIds].sort(), row.stats]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(buildSignature(selected.data), buildSignature(buildApi.data));
  const columns = Object.fromEntries(['equipment', 'teammates', 'comps'].map(key => {
    const value = research[key]; return [key, value ? { status: value.status, rows: value.rows?.length ?? value.data?.length ?? null, reason: value.reason ?? null, evidence: evidence(value.evidence) } : null];
  }));
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), releaseId: release.id, currentPatch: release.currentPatch,
    item: { id: itemId, name: catalog.items.find(item => item.id === itemId)?.name },
    execution: { mysqlTransaction: 'READ ONLY, REPEATABLE READ', sqlMutationStatements: false, providerCalls: false, productionRoutingChanged: false, browserAcceptancePerformed: false },
    snapshots: { totalOpgg: snapshots.length, statistics: snapshots.filter(row => row.evidence_kind === 'statistics').length, groups: [...groups.values()].map(group => ({ ...group, rowFields: [...group.rowFields].sort() })) },
    sql: { file: 'scripts/sql/opgg-filter-candidates.sql', holderParams, buildParams, holderCandidateRows: holderRows.length, buildCandidateRows: buildRows.length,
      holderRows: holders, completeBuilds: selected.data.map(compact), buildSelectionAfterSqlMinimum: selected.selection,
      checks: { holderSqlMatchesPublishedApi: true, selectedBuildSqlMatchesPublishedApi: true, wrongPatchEmpty: true, missingSnapshotEmpty: true } },
    api: { holders: { allRows: holderApi.data.length, qualifiedRows: holders.length, evidence: evidence(holderApi.evidence) },
      builds: { status: buildApi.status, selection: buildApi.selection, evidence: evidence(buildApi.evidence) },
      research: { schemaVersion: research.schemaVersion, status: research.status, summary: research.summary, coverage: research.coverage, columns },
      riot: { matches: riot.matches, participantsCurrent: riot.participantsCurrent, latestFetchedAt: riot.latestFetchedAt, worker: riot.worker, lastJob: riot.lastJob, patchAttribution: riot.patchAttribution },
      comps: { status: comps.status, rows: comps.data.length, evidence: evidence(comps.evidence) },
      explorerUnits: { status: explorerUnits.status, rows: explorerUnits.rows.length, evidence: evidence(explorerUnits.evidence) },
      explorerEquipment: { status: explorerEquipment.status, rows: explorerEquipment.rows.length, evidence: evidence(explorerEquipment.evidence) },
      explorerHolders: { status: explorerHolders.status, rows: explorerHolders.rows.length, evidence: evidence(explorerHolders.evidence) } },
    limitations: ['OP.GG sample counts are source aggregate occurrences, not matches stored in this database.', 'Build and holder rows do not identify matches, participants, or teammates.', 'SQL examples do not implement arbitrary joint conditions or the frontend.', 'Inferred patches remain inferred; source rank, region, and sampling window are unknown.'],
  }, null, 2));
} catch (error) {
  if (connection) await connection.rollback();
  // Do not print connection configuration, SQL server details, or secrets.
  console.error(JSON.stringify({ status: 'failed', stage, name: error.name, code: error.code ?? null, message: error instanceof assert.AssertionError ? error.message : stage.startsWith('sql:') ? error.sqlMessage : 'Audit failed; inspect the named query or endpoint without logging credentials.' }));
  process.exitCode = 1;
} finally {
  if (connection) connection.release();
  await closeDatabase();
}
