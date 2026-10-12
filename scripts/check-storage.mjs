// Explicit integration check; synthetic vectors live in a temporary collection,
// never in the knowledge index. No model provider is contacted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool,getActiveRelease,closeDatabase } from '../server/storage/repository.mjs';
import { getStorageHealth,readDatabaseSnapshot,closeRedis,snapshotAvailability } from '../server/storage/runtime.mjs';
import { storageConfig } from '../server/storage/config.mjs';
import { searchKnowledge } from '../server/knowledge/service.mjs';
import { MilvusClient } from '../server/knowledge/vector.mjs';
import { queryKey } from './stats-cache.mjs';

const oldPatch=process.env.CURRENT_GAME_PATCH;
const collection=`tft_smoke_${randomUUID().replaceAll('-','')}`;
// Keep this infrastructure check provider-free even when the app has a ready
// production embedding index. Read fresh configuration for the patch override.
const searchStoredKnowledge=query=>searchKnowledge(query,{config:{...storageConfig(),
  embedding:{baseUrl:'',key:'',model:'',dimensions:0}}});
let milvus,created=false;
try {
  assert.equal(storageConfig().backend,'mysql','Run this check inside the app container');
  const db=await getPool(),release=await getActiveRelease();assert.ok(release);
  const [counts]=await db.execute('SELECT (SELECT COUNT(*) FROM entities WHERE release_id=?) AS entities,(SELECT COUNT(*) FROM knowledge_documents WHERE release_id=?) AS documents,(SELECT COUNT(*) FROM knowledge_chunks WHERE release_id=?) AS chunks',[release.id,release.id,release.id]);
  assert.equal(Number(counts[0].chunks),release.manifest.counts.chunks);
  assert.equal(Number(counts[0].entities),release.manifest.counts.entities);
  const health=await getStorageHealth();assert.equal(health.mysql.status,'ready');assert.equal(health.redis.status,'ready');
  const question={query:'战利品法球能开出什么',limit:3};
  const first=await searchStoredKnowledge(question),second=await searchStoredKnowledge(question);
  assert.equal(first.status,'ready');assert.ok(first.evidence.every(e=>e.sourcePatch===release.currentPatch));assert.ok(first.evidence.some(e=>e.images.length));assert.equal(second.retrieval.cacheHit,true);
  for(const result of [first,second]){assert.equal(result.retrieval.mode,'lexical');assert.equal(result.retrieval.vectorStatus,'not_configured');}
  const buildKey=`opgg:${queryKey('tft_get_champion_item_build',{champion_id:'DA_18_Veigar'})}`;
  const assigned=await readDatabaseSnapshot(buildKey,{statistics:true});
  assert.equal(assigned.delivery,'mysql');assert.equal(assigned.evidence.currentPatch,release.currentPatch);
  assert.equal(assigned.evidence.sourcePatch,null,'Inferred attribution never rewrites original source patch');
  if(assigned.evidence.assignedPatch){assert.equal(assigned.status,'live');assert.equal(assigned.evidence.effectivePatch,release.currentPatch);assert.ok(assigned.data.data.length);}
  else{assert.equal(assigned.code,'version_unknown');assert.deepEqual(assigned.data,[]);}
  assert.equal(snapshotAvailability({sourcePatch:null,release}),'version_unknown','Unattributed unknown data stays unknown');
  const currentStats=await readDatabaseSnapshot('overall',{statistics:true});
  assert.equal(currentStats.evidence.sourcePatch,release.currentPatch);
  assert.equal(currentStats.evidence.currentPatch,release.currentPatch);
  assert.equal(currentStats.evidence.delivery,'mysql');
  // Process-local override tests isolation without changing the persistent active release.
  process.env.CURRENT_GAME_PATCH='999.999';
  assert.equal((await searchStoredKnowledge(question)).status,'not_found');
  assert.ok((await readDatabaseSnapshot('library')).documents.every(d=>!d.retrievalEligible));
  assert.deepEqual((await readDatabaseSnapshot('mechanics')).entries,[]);
  const mismatched=await readDatabaseSnapshot('overall',{statistics:true});
  assert.equal(mismatched.code,'version_mismatch');assert.deepEqual(mismatched.data,[]);
  assert.equal(mismatched.delivery,'mysql');assert.match(mismatched.reason,/来源统计属于 .*999\.999.*已排除/);
  const oldAssigned=await readDatabaseSnapshot(buildKey,{statistics:true});
  assert.deepEqual(oldAssigned.data,[]);
  assert.equal(oldAssigned.code,assigned.evidence.assignedPatch?'version_mismatch':'version_unknown');
  if(oldPatch===undefined)delete process.env.CURRENT_GAME_PATCH;else process.env.CURRENT_GAME_PATCH=oldPatch;
  if(storageConfig().milvusUrl) {
    milvus=new MilvusClient();await milvus.ensureCollection(collection,2);created=true;
    const receipt=await milvus.call('entities/upsert',{collectionName:collection,data:[
      {id:'test_current',release_id:release.id,source_patch:release.currentPatch,scope:'patch',eligible:true,vector:[1,0]},
      {id:'test_general',release_id:release.id,source_patch:'',scope:'general',eligible:true,vector:[1,0]},
      {id:'test_old',release_id:release.id,source_patch:'999.999',scope:'patch',eligible:true,vector:[1,0]},
      {id:'test_unreviewed',release_id:release.id,source_patch:release.currentPatch,scope:'patch',eligible:false,vector:[1,0]}
    ]});
    assert.equal(receipt.upsertCount,4);
    assert.equal((await milvus.verifyEntities(collection,release,['test_current','test_general'])).count,2);
    const results=await milvus.search(collection,[1,0],release,10);
    assert.deepEqual(new Set(results.map(r=>r.id)),new Set(['test_current','test_general']));
  }
  console.log(JSON.stringify({status:'passed',checks:['mysql_seed_counts','redis_cache','knowledge_sources_and_images','stats_patch_attribution_and_isolation','patch_isolation_all_paths',...(created?['milvus_real_create_upsert_filtered_search']:[])],counts:counts[0],embeddingProviderCalled:false},null,2));
}catch(error){console.error(JSON.stringify({status:'failed',message:error.message}));process.exitCode=1;}
finally {
  if(oldPatch===undefined)delete process.env.CURRENT_GAME_PATCH;else process.env.CURRENT_GAME_PATCH=oldPatch;
  if(created)await milvus.call('collections/drop',{collectionName:collection}).catch(()=>{process.exitCode=1;});
  await closeRedis();await closeDatabase();
}
