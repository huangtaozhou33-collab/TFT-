import test from 'node:test';
import assert from 'node:assert/strict';
import { RANK_OPTIONS, rankScope, rankLabel, scopeRank } from '../public/stat-ranks.js';
import { metaScope, metaParams, checkMetaScope, metaEvidence } from '../server/metatft/scope.mjs';
import { metaPlan } from '../server/metatft/query.mjs';
import { normalizeResearchQuery, validateResearchQuery } from '../public/research-query.js';
import { validateBuildQuery } from '../public/build-query.js';
import { validateStatisticsQuery, prepareQueryAgent } from '../server/query-agent.mjs';
import { collectionTasks, collectCatalogue, pacedReader } from '../scripts/collect-metatft.mjs';
import { datasetInventory } from '../server/metatft/dataset-repository.mjs';
import { selectMetaRows } from '../server/metatft/repository.mjs';
import { loadMetaDataset } from '../server/metatft/datasets.mjs';
const release={id:'a'.repeat(64),season:18,currentPatch:'18.4'},metadata={set:'TFTSet18',patch:{patch:'18.4',b_patch_version:'b'}};
const catalog={context:{set:18},champions:[{id:'Hero',name:'英雄',cost:1,traits:[]}],items:[{id:'Core',kind:'completed',category:'core'},{id:'Radiant',kind:'completed',category:'radiant'},{id:'Artifact',kind:'special',category:'artifact'},{id:'Emblem',kind:'special',category:'emblem'},{id:'Component',kind:'component',category:'component'}],traits:[]};

test('ten exact ranks, all ranks and platinum-plus have distinct canonical keys and truthful evidence',()=>{
  const keys=new Set();
  for(const [rank,label]of RANK_OPTIONS){
    const scope=metaScope(release,metadata,{rank}),plan=metaPlan({conditions:[{type:'champion',id:'Hero'}],rank},release,metadata);
    assert.equal(scopeRank(scope.ranks),rank);assert.equal(rankLabel(rank),label);keys.add(plan.queryKey);
    assert.equal(metaParams(scope).get('rank'),rankScope(rank).join(','));
    assert.doesNotThrow(()=>checkMetaScope({filter_adjustment:{override_applied:false,rank_filter:[...scope.ranks].reverse().join(',')}},scope));
    const e=metaEvidence({scope,metadata,release,id:'snapshot',capturedAt:1,expiresAt:2});
    assert.equal(e.rank,label);assert.equal(e.rankFilter,rank);assert.equal(e.population.rank,label);
  }
  assert.equal(keys.size,12);assert.deepEqual(rankScope('GOLD'),['GOLD']);assert.equal(rankScope('ALL').length,10);
  assert.throws(()=>metaScope(release,metadata,{rank:'diamond+'}),{code:'INVALID_STAT_RANK'});
  assert.throws(()=>checkMetaScope({filter_adjustment:{override_applied:false,rank_filter:'GOLD,SILVER'}},metaScope(release,metadata,{rank:'GOLD'})),{code:'METATFT_SCOPE_CHANGED'});
});
test('rank survives shared query contracts and unknown ranks fail rather than being ignored',()=>{
  const input={rank:'GOLD',conditions:[{type:'champion',id:'Hero'}]};
  assert.equal(normalizeResearchQuery(JSON.parse(JSON.stringify(input))).rank,'GOLD');
  assert.ok(validateResearchQuery(input,catalog).valid);
  assert.equal(validateBuildQuery({rank:'GOLD',championId:'Hero'},catalog).query.rank,'GOLD');
  for(const view of ['comps','champions','items','traits'])assert.equal(validateStatisticsQuery({view,rank:'IRON'},catalog).rank,'IRON');
  assert.ok(!validateResearchQuery({...input,rank:'SECRET'},catalog).valid);
  assert.ok(!validateBuildQuery({championId:'Hero',rank:'SECRET'},catalog).valid);
  assert.throws(()=>validateStatisticsQuery({view:'items',rank:'SECRET'},catalog));
});
test('coverage inventory uses exact ranks in SQL, preventing another tier from appearing collected',async()=>{
  let call;
  await datasetInventory(release.id,{patch:'18.4',bPatch:'b',ranks:['GOLD']},{execute:async(sql,args)=>{call={sql,args};return [[]];}});
  assert.match(call.sql,/query_scope,'\$\.ranks'/);assert.equal(call.args.at(-1),'["GOLD"]');
});
test('dataset cache keys are isolated by rank, even with the same entity and release',async()=>{
  const keys=[];
  for(const rank of ['IRON','GOLD'])await loadMetaDataset('builds','Hero',catalog,{rank,getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,
    findDataset:async(_,key)=>{keys.push(key);return{id:key,releaseId:release.id,scope:metaScope(release,metadata,{rank}),metadata,capturedAt:1,expiresAt:2,summary:{sourceRows:0}};},readDatasetRows:async()=>[]});
  assert.notEqual(keys[0],keys[1]);
});
test('catalog collection covers every champion and every item category including components at every rank',()=>{
  const tasks=collectionTasks(catalog);
  assert.equal(tasks.length,12*8);
  for(const [rank]of RANK_OPTIONS){const group=tasks.filter(t=>t.rank===rank);assert.equal(group.length,8);assert.deepEqual(group.filter(t=>t.kind==='holders').map(t=>t.category),['core','radiant','artifact','emblem','component']);}
  assert.ok(tasks.some(t=>t.entityId==='Component'));
});
test('batch retains successful zero data, errors and checkpoints; never reports a failed catalogue complete',async()=>{
  let active=0,max=0,checkpoints=[];
  const report=await collectCatalogue({catalog,release,metadata,ranks:['GOLD'],checkpoint:async r=>checkpoints.push(structuredClone(r)),load:async(kind,id,_,options)=>{
    active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;assert.equal(options.rank,'GOLD');
    if(id==='Artifact')throw Object.assign(new Error('source failure'),{code:'METATFT_UNAVAILABLE'});
    return{rows:id==='Radiant'?[]:[{}],snapshot:{id:'s-'+id,summary:{sourceRows:1,skipped:[]}},evidence:{fetchedAt:'time'}};
  }});
  assert.ok(max<=3);assert.equal(report.complete,false);assert.equal(report.summary.failed,1);assert.equal(report.summary.empty,1);assert.equal(report.summary.datasets,7);
  assert.equal(checkpoints.at(-1).summary.failed,1);assert.equal(report.modelCalled,false);
});
test('batch resumes through persisted dataset cache and successful empty entities count as collected',async()=>{
  const r=await collectCatalogue({catalog,release,metadata,ranks:['IRON'],load:async()=>({rows:[],cacheHit:true,snapshot:{id:'s',summary:{sourceRows:0}},evidence:{}})});
  assert.equal(r.complete,true);assert.equal(r.exhaustive,false);assert.equal(r.summary.empty,8);
});
test('retry policy retries transient source errors but not scope changes',async()=>{
  let calls=0;
  const read=pacedReader(async()=>{calls++;if(calls===1)throw Object.assign(new Error('rate limit'),{code:'METATFT_UNAVAILABLE',retryAfterMs:1});return 'ok';},0);
  assert.equal(await read('/public'),'ok');assert.equal(calls,2);
  const bad=pacedReader(async()=>{throw Object.assign(new Error('scope'),{code:'METATFT_SCOPE_CHANGED'});},0);
  await assert.rejects(()=>bad('/public'),{code:'METATFT_SCOPE_CHANGED'});
});

test('joint query returns every qualified persisted row, not an inaccessible first sixty',async()=>{
  const payloads=Array.from({length:90},(_,i)=>({rowKey:String(i),stats:{avgPlacement:5-i/100,sampleSize:100+i}}));
  const db={execute:async(sql,args)=>{
    assert.doesNotMatch(sql,/LIMIT 60/);
    if(sql.includes('GROUP BY'))return[[{dimension:'equipment',count:90,qualified:90}]];
    return[args[1]==='equipment'?payloads.map(payload=>({payload})):[]];
  }};
  const r=await selectMetaRows('snapshot',{minSample:100,sort:'avgPlacement'},db);
  assert.equal(r.equipment.rows.length,90);assert.equal(r.equipment.count,90);assert.equal(r.equipment.rows[0].rowKey,'89');
});
