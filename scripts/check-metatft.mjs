// Explicit live acceptance of the deployed endpoint. Calls public statistics, never models.
// Test fixtures are not used by the production adapter or preloaded into its query cache.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] || 'http://127.0.0.1:3001';
const out = process.argv[3] || 'tmp/metatft-deployment';
await mkdir(out, { recursive: true });
const hero = id => ({ type: 'champion', id }), item = (id, holderId = null) => ({ type: 'item', id, holderId });
const elder = 'DA_18_ElderDragon', ivern = 'DA_18_Ivern', nidalee = 'DA_Nidalee18_AP', amumu = 'DA_Amumu18';
const silver = 'DA_Artifact_SilvermereDawn', edge = 'DA_InfinityEdge', flail = 'DA_StrikersFlail', shojin = 'DA_SpearOfShojin', warmog = 'DA_WarmogsArmor';
const records = [], report = { startedAt: new Date().toISOString(), base, modelCalled: false, records };
async function run(name, conditions, extra = {}) {
  const query = { conditions, carrierId: conditions.find(term => term.type === 'champion')?.id, minSample: 100, sort: 'avgPlacement', dataSource: 'metatft', ...extra };
  const response = await fetch(`${base}/api/research/query/v3`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(55000) });
  const result = await response.json();
  await writeFile(`${out}/${name}.json`, JSON.stringify({ query, http: response.status, result }, null, 2));
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.source, 'metatft'); assert.equal(result.delivery, 'mysql'); assert.equal(result.schemaVersion, 3);
  assert.equal(result.evidence.sourcePatch, null); assert.equal(result.coverage.matchedMatches, null);
  assert.deepEqual(result.query.conditions, conditions);
  for (const dimension of ['equipment','teammates','comps']) for (const row of result[dimension].rows) {
    assert.equal(row.evidence.snapshotId, result.coverage.snapshotId);
    assert.ok(row.stats.sampleSize >= query.minSample);
    assert.equal(row.stats.sampleSize, row.placementCount.reduce((a,b) => a+b, 0));
  }
  for (const comp of result.comps.rows) for (const term of conditions.filter(term => term.type === 'champion')) assert.ok(comp.units.some(unit => unit.championId === term.id));
  for (const row of result.equipment.rows) for (const term of conditions.filter(term => term.type === 'item' && term.holderId === result.coverage.scope.carrierId)) assert.ok(row.itemIds.includes(term.id));
  const record = { name, query, http: response.status, status: result.status, snapshotId: result.coverage.snapshotId, cacheHit: result.coverage.cacheHit, matchedSamples: result.coverage.matchedSamples, columns: Object.fromEntries(['equipment','teammates','comps'].map(d => [d, { count: result[d].count, shown: result[d].rows.length, beforeMinimum: result[d].beforeMinimum, status: result[d].status }])) };
  records.push(record); console.log(JSON.stringify({ name, status: record.status, samples: record.matchedSamples, cacheHit: record.cacheHit }));
  return result;
}
try {
  const itemOnly = await run('item-only', [item(silver)]);
  assert.ok(itemOnly.teammates.rows.some(row => row.championId === elder && row.heldItemId === silver));
  const triple = [hero(elder), item(silver,elder), item(edge,elder), item(flail,elder)];
  const full = await run('elder-triple', triple);
  assert.ok(full.coverage.matchedSamples > 0); assert.equal(full.equipment.rows.length, 1);
  const reordered = await run('reordered', [...triple].reverse(), { carrierId: elder, sort: 'sampleSize' });
  assert.equal(reordered.coverage.snapshotId, full.coverage.snapshotId); assert.equal(reordered.coverage.cacheHit, true);
  const threshold = await run('threshold', triple, { minSample: 100000000 });
  assert.equal(threshold.coverage.snapshotId, full.coverage.snapshotId); assert.equal(threshold.equipment.status, 'insufficient_samples'); assert.ok(threshold.coverage.matchedSamples > 0);
  const joint = await run('two-champions', [...triple, hero(ivern)]);
  const swapped = await run('holder-changed', [hero(elder),hero(ivern),item(silver,ivern),item(edge,elder),item(flail,elder)], { minSample: 0 });
  assert.notEqual(swapped.coverage.snapshotId, joint.coverage.snapshotId);
  const other = await run('nidalee-shojin', [hero(nidalee),item(shojin,nidalee)]);
  assert.ok(other.coverage.matchedSamples > 0);
  const otherJoint = await run('nidalee-amumu', [hero(nidalee),hero(amumu),item(shojin,nidalee)]);
  assert.ok(otherJoint.coverage.matchedSamples > 0);
  const carriers = [hero(nidalee),hero(amumu),item(shojin,nidalee),item(warmog,amumu)];
  const different = await run('two-holders', carriers);
  const amumuBuild = await run('change-build-target', carriers, { carrierId: amumu });
  assert.ok(different.coverage.matchedSamples > 0); assert.ok(amumuBuild.equipment.rows.every(row => row.championId === amumu));
  const copies = await run('two-copies', [hero(nidalee),item(shojin,nidalee),item(shojin,nidalee)], { minSample: 0 });
  assert.ok(copies.coverage.matchedSamples > 0); assert.ok(copies.equipment.rows.every(row => row.itemIds.filter(id => id === shojin).length >= 2));
  const boundUnbound = await run('bound-plus-unbound', [hero(nidalee),item(shojin,nidalee),item(shojin)], { minSample: 0 });
  assert.ok(boundUnbound.coverage.matchedSamples > 0);
  const zero = await run('real-zero', [hero(nidalee),item(shojin,nidalee),item(shojin,nidalee),item(shojin,nidalee),item(shojin,nidalee)], { minSample: 0 });
  assert.equal(zero.status, 'empty'); assert.equal(zero.coverage.matchedSamples, 0);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
await writeFile(`${out}/api-validation.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, completed: records.length, failure: report.failure }));
