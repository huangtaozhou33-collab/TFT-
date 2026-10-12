// Read-only deployed database audit. Does not contact a model or statistics provider.
import assert from 'node:assert/strict';
import { getPool, getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { metaPlan, metaStats } from '../server/metatft/query.mjs';
import { sha256, stableJSON } from './stats-cache.mjs';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const sameStats = (actual, expected) => {
  assert.equal(actual.sampleSize, expected.sampleSize);
  for (const key of ['avgPlacement','top4Rate','winRate']) {
    if (expected[key] === null) assert.equal(actual[key], null);
    else assert.ok(Math.abs(actual[key] - expected[key]) < 1e-12);
  }
};
let phase = 'connection';
try {
  const db = await getPool(), release = await getActiveRelease();
  assert.ok(release);
  const [migrations] = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.ok(migrations.some(row => row.version === 6));
  phase = 'read snapshots';
  // Avoid filesorting wide raw JSON rows in MySQL's bounded sort buffer.
  const [snapshots] = await db.execute('SELECT * FROM metatft_query_snapshots WHERE release_id=?', [release.id]);
  snapshots.sort((a,b) => Number(a.captured_at) - Number(b.captured_at));
  assert.ok(snapshots.length, 'Run real queries before this audit');
  const [rows] = await db.execute('SELECT r.* FROM metatft_query_rows r JOIN metatft_query_snapshots s ON s.id=r.snapshot_id WHERE s.release_id=?', [release.id]);
  let byteVerifiedSnapshots = 0, legacyJsonOnlySnapshots = 0, legacyJsonHashMismatches = 0;
  const sourceHistograms = new Map();
  phase = 'verify snapshot evidence';
  for (const snapshot of snapshots) {
    const scope = json(snapshot.query_scope), metadata = json(snapshot.source_metadata), responses = json(snapshot.raw_responses), summary = json(snapshot.summary);
    const plan = metaPlan({ conditions: scope.conditions, carrierId: scope.carrierId }, release, metadata);
    assert.equal(sha256(stableJSON({releaseId:release.id,...scope})), snapshot.query_key, `Query key mismatch: ${snapshot.id}`);
    if (snapshot.raw_response_text !== null) {
      assert.equal(plan.queryKey, snapshot.query_key);
      assert.equal(sha256(snapshot.raw_response_text), snapshot.content_hash, `Raw response hash mismatch: ${snapshot.id}`);
      for (const [dimension, raw] of Object.entries(JSON.parse(snapshot.raw_response_text))) {
        assert.equal(sha256(raw.bodyText),raw.contentHash);
        assert.equal(raw.contentHash,responses[dimension].contentHash);
        responses[dimension].data = JSON.parse(raw.bodyText);
      }
      byteVerifiedSnapshots++;
    } else {
      assert.equal(scope.adapterVersion,1,'Current snapshots must preserve source bytes');
      legacyJsonOnlySnapshots++;
      if (sha256(stableJSON(responses)) !== snapshot.content_hash) legacyJsonHashMismatches++;
    }
    assert.equal(summary.responsePatch, null);
    assert.equal(snapshot.requested_patch, scope.patch);
    assert.equal(snapshot.requested_b_patch, scope.bPatch);
    assert.equal(metadata.set, `TFTSet${release.season}`);
    for (const [dimension, response] of Object.entries(responses)) {
      assert.equal(new URL(response.url).pathname + new URL(response.url).search, plan.urls[dimension]);
      assert.equal(response.data.filter_adjustment.override_applied, false);
      if (dimension !== 'total') for (const source of response.data.data) {
        const key = source.unit_builds ?? source.units_unique ?? source.unit_items_unique ?? source.units_traits;
        sourceHistograms.set(`${snapshot.id}:${dimension}:${sha256(key)}`, source.placement_count);
      }
    }
    const total = responses.total.data.data[0]?.placement_count || [0,0,0,0,0,0,0,0];
    sameStats(summary.stats, metaStats(total));
    if (!summary.stats.sampleSize) assert.equal(rows.filter(row => row.snapshot_id === snapshot.id).length, 0);
  }
  phase = 'verify row metrics';
  for (const row of rows) {
    const payload = json(row.payload), stats = metaStats(json(row.placement_count));
    assert.deepEqual(json(row.placement_count),sourceHistograms.get(`${row.snapshot_id}:${row.dimension}:${row.row_key}`));
    assert.equal(Number(row.sample_size), stats.sampleSize);
    for (const [column, property] of [['avg_placement','avgPlacement'],['top4_rate','top4Rate'],['win_rate','winRate']]) assert.ok(Math.abs(Number(row[column]) - stats[property]) < 1e-12);
    sameStats(payload.stats, stats);
    assert.equal(sha256(payload.sourceKey), row.row_key);
  }
  phase = 'read knowledge counts';
  const [[knowledge]] = await db.execute('SELECT (SELECT COUNT(*) FROM knowledge_documents WHERE release_id=?) AS documents,(SELECT COUNT(*) FROM knowledge_chunks WHERE release_id=?) AS chunks,(SELECT COUNT(*) FROM source_snapshots WHERE release_id=?) AS sourceSnapshots', [release.id, release.id, release.id]);
  const verifiedIds = new Set(snapshots.filter(row => row.raw_response_text !== null).map(row => row.id));
  console.log(JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), releaseId: release.id, schemaVersions: migrations.map(row => row.version),
    snapshots: snapshots.length, byteVerifiedSnapshots, legacyJsonOnlySnapshots, legacyJsonHashMismatches, rows: rows.length, byteVerifiedRows: rows.filter(row => verifiedIds.has(row.snapshot_id)).length, dimensions: Object.fromEntries(['equipment','teammates','comps'].map(d => [d, rows.filter(row => row.dimension === d).length])),
    knowledge, checks: ['canonical_query_keys','original_response_hashes','exact_upstream_conditions','no_scope_expansion','source_and_request_patch_separation','rows_equal_source_histograms','stored_histogram_metrics','persisted_real_zero'],
    queries: snapshots.map(row => ({ snapshotId: row.id, queryKey: row.query_key, adapterVersion: json(row.query_scope).adapterVersion, conditions: json(row.query_scope).conditions, carrierId: json(row.query_scope).carrierId, capturedAt: new Date(Number(row.captured_at)).toISOString(), stats: json(row.summary).stats })),
    modelCalled: false, databaseMutations: false }, null, 2));
} catch (error) {
  // Omit raw driver errors: these can contain deployment details.
  console.error(JSON.stringify({ status: 'failed', phase, errorType: error.name, code: error.code, check: error.name === 'AssertionError' ? error.message : 'Database audit could not complete' }));
  process.exitCode = 1;
} finally { await closeDatabase(); }
