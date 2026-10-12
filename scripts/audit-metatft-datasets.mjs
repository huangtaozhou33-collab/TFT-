// Read-only MySQL/original-response audit. No upstream or model requests.
import assert from 'node:assert/strict';
import { getPool, getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { getCatalog } from '../server/data.mjs';
import { normalizeMetaOverall, normalizeMetaComps, normalizeMetaDetail } from '../server/metatft/datasets.mjs';
import { metaParams } from '../server/metatft/scope.mjs';
import { sha256, stableJSON } from './stats-cache.mjs';
const json=v=>typeof v==='string'?JSON.parse(v):v;
let phase='connect';
try {
  const db=await getPool(),release=await getActiveRelease(),catalog=await getCatalog();
  const [migrations]=await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.ok(migrations.some(m=>m.version===7));
  const [datasets]=await db.execute('SELECT * FROM metatft_datasets WHERE release_id=?',[release.id]);
  const [stored]=await db.execute('SELECT r.* FROM metatft_dataset_rows r JOIN metatft_datasets d ON d.id=r.dataset_id WHERE d.release_id=?',[release.id]);
  assert.ok(datasets.length>0);
  const counts={},samples=[];
  for(const d of datasets) {
    phase=`verify ${d.kind}:${d.entity_id}`;
    const scope=json(d.query_scope),responses=JSON.parse(d.raw_response_text);
    assert.equal(sha256(d.raw_response_text),d.content_hash);
    assert.equal(sha256(stableJSON({releaseId:release.id,...scope})),d.dataset_key);
    for(const [key,r] of Object.entries(responses)) {
      assert.equal(sha256(r.bodyText),r.contentHash);r.data=JSON.parse(r.bodyText);
      const url=new URL(r.url);assert.equal(url.origin,'https://api-hc.metatft.com');
      if(key!=='definitions')for(const [name,value] of metaParams(scope))assert.equal(url.searchParams.get(name),value);
      if(scope.kind==='builds')assert.equal(url.searchParams.get('unit_unique'),`${scope.entityId}-1`);
      if(scope.kind==='holders')assert.equal(url.searchParams.get('item_unique'),`${scope.entityId}-1`);
    }
    const normalized=d.kind==='overall'?normalizeMetaOverall(responses,scope,catalog):d.kind==='comps'?normalizeMetaComps(responses,scope,catalog):normalizeMetaDetail(responses.rows,scope,catalog);
    const rows=stored.filter(r=>r.dataset_id===d.id),expected=new Map(normalized.rows.map(r=>[r.rowKey,r]));
    assert.equal(rows.length,expected.size);assert.equal(json(d.summary).rowCount,rows.length);
    for(const r of rows) {
      const e=expected.get(r.row_key),payload=json(r.payload);assert.ok(e);assert.equal(r.entity_id,e.entityId);
      assert.deepEqual(json(r.placement_count),e.placementCount);assert.deepEqual(payload.placementCount,e.placementCount);
      assert.equal(Number(r.sample_size),e.stats.sampleSize);
      assert.ok(Math.abs(r.avg_placement-e.stats.avgPlacement)<1e-12);
      for(const key of ['avgPlacement','top4Rate','winRate'])assert.ok(Math.abs(payload.stats[key]-e.stats[key])<1e-12);
      if(d.kind==='comps'){assert.deepEqual(payload.units,e.units);assert.equal(payload.statisticsKind,'comp_cluster');}
      if(d.kind==='builds')assert.deepEqual(payload.itemIds,e.itemIds);
    }
    counts[d.kind]??={snapshots:0,rows:0};counts[d.kind].snapshots++;counts[d.kind].rows+=rows.length;
    samples.push({kind:d.kind,entityId:d.entity_id,snapshotId:d.id,rows:rows.length,capturedAt:new Date(Number(d.captured_at)).toISOString()});
  }
  const [[archives]]=await db.execute('SELECT COUNT(*) AS snapshots FROM source_snapshots WHERE release_id=?',[release.id]);
  console.log(JSON.stringify({status:'passed',releaseId:release.id,migrations:migrations.map(m=>m.version),datasets:datasets.length,rows:stored.length,byteVerifiedDatasets:datasets.length,counts,archivedSourceSnapshots:archives.snapshots,knowledgeCounts:release.manifest.counts,snapshots:samples},null,2));
} catch(error){console.error(JSON.stringify({status:'failed',phase,message:error.message}));process.exitCode=1;}
finally{await closeDatabase();}
