import test from 'node:test';
import assert from 'node:assert/strict';
import { getResearchResults } from '../server/research.mjs';
import { normalizeResearchQuery, validateResearchQuery } from '../public/research-query.js';

const catalog = { champions: ['alpha','beta','gamma'].map(id=>({id,name:id})),
  items: [{id:'x',kind:'artifact'},{id:'y',kind:'completed'},{id:'z',kind:'completed'},{id:'unique',kind:'completed',unique:true},{id:'part',kind:'component'}], traits:[{id:'trait'}] };
const row=(championId,itemIds,sampleSize,avgPlacement)=>({championId,itemIds,stats:{sampleSize,avgPlacement,top4Rate:.7,winRate:.2}});
const sourceRows={alpha:[row('alpha',['x','y','z'],200,3),row('alpha',['z','x','y'],200,3),row('alpha',['y','y','z'],110,3.7)],
  beta:[row('beta',['x','y','z'],160,2.8),row('beta',['x','x','y'],20,2.1)], gamma:[row('gamma',['y','z','z'],300,4)]};
const deps={databaseMode:true,getCatalog:async()=>catalog,getChampionBuild:async id=>({status:'live',data:sourceRows[id],evidence:{source:'OP.GG MCP',releaseId:'release-a',effectivePatch:'18.4',recordHash:id}}),
  getRiotResearchResults:async()=>{throw Error('Do not replace source-record queries with Riot');}};
const item=id=>({type:'item',id,holderId:null});
const champion=id=>({type:'champion',id});
const query=(conditions,extra={})=>({conditions,minSample:100,sort:'avgPlacement',dataSource:'opgg',...extra});

test('any catalog item searches every published champion, deduplicates tuples, and retains per-row statistics',async()=>{
  const result=await getResearchResults(query([item('x')]),deps);
  assert.equal(result.source,'opgg'); assert.equal(result.coverage.jointMatchQueries,false);
  assert.deepEqual(result.equipment.rows.map(row=>row.championId),['beta','alpha']);
  assert.deepEqual(result.teammates.rows.map(row=>row.championId),['beta','alpha']);
  assert.equal(result.teammates.rows[0].stats.sampleSize,160);
  assert.equal(result.teammates.rows[0].evidence.recordHash,'beta');
  assert.deepEqual(result.teammates.rows[0].itemIds,['x','y','z']);
  assert.equal(result.coverage.matchedBuildsBeforeMinimum,3); assert.equal(result.coverage.qualifiedBuilds,2);
  assert.equal(result.selection.samplesCombined,false); assert.equal(result.comps.status,'not_supported');
  const another=await getResearchResults(query([item('z')]),deps);
  assert.deepEqual(new Set(another.teammates.rows.map(row=>row.championId)),new Set(['alpha','beta','gamma']));
});

test('one, two and three fixed items are matched on the same source row with their multiplicity',async()=>{
  for(const items of [['x'],['x','y'],['x','y','z']]) {
    const r=await getResearchResults(query(items.map(item)),deps);
    assert.equal(r.equipment.count,2);
    assert.ok(r.equipment.rows.every(row=>items.every(id=>row.itemIds.includes(id))));
  }
  const repeat=await getResearchResults(query([item('x'),item('x')],{minSample:0}),deps);
  assert.equal(repeat.equipment.count,1);assert.equal(repeat.equipment.rows[0].championId,'beta');assert.equal(repeat.equipment.rows[0].stats.sampleSize,20);
  for(const items of [['unique','unique'],['x','y','z','z']])assert.equal((await getResearchResults(query(items.map(item)),deps)).status,'invalid');
});

test('champion restriction, sorting, threshold and empty results are general predicates, without weaker fallbacks',async()=>{
  const r=await getResearchResults(query([champion('alpha'),item('y')],{sort:'sampleSize'}),deps);
  assert.equal(r.equipment.count,2);assert.equal(r.teammates.count,1);assert.equal(r.teammates.rows[0].qualifyingBuildCount,2);
  assert.equal(r.teammates.rows[0].stats.sampleSize,200); // not 200+110, and duplicates add nothing
  assert.equal((await getResearchResults(query([item('x')],{minSample:1000}),deps)).status,'insufficient_samples');
  const empty=await getResearchResults(query([champion('gamma'),item('x')]),deps);
  assert.equal(empty.status,'empty');assert.equal(empty.equipment.count,0);assert.equal(empty.teammates.count,0);
});

test('OP.GG refuses unsupported predicates; legacy auto and explicit Riot preserve full board queries including empty results',async()=>{
  for(const conditions of [[champion('alpha'),champion('beta')],[item('x'),{type:'trait',id:'trait'}]]){
    const r=await getResearchResults(query(conditions),{...deps,getChampionBuild:async()=>{throw Error('Unsupported predicates must not be ignored');}});
    assert.equal(r.status,'not_supported');assert.deepEqual(r.equipment.rows,[]);
  }
  const riot={source:'riot',status:'empty',coverage:{jointMatchQueries:true}};
  for(const q of [query([item('x')],{dataSource:'riot'}),query([champion('alpha'),champion('beta')],{dataSource:'auto'}),query([item('x'),item('y')],{dataSource:'auto'})]){
    const r=await getResearchResults(q,{...deps,allowMetaTft:false,getChampionBuild:async()=>{throw Error('No weaker fallback');},getRiotResearchResults:async received=>{assert.deepEqual(received.conditions,q.conditions);return riot;}});
    assert.equal(r,riot);
  }
  assert.equal((await getResearchResults(query([item('x')],{dataSource:'auto'}),{...deps,allowMetaTft:false})).source,'opgg');
  assert.equal((await getResearchResults(query([item('x')]),{...deps,allowAggregate:false,getRiotResearchResults:async()=>riot})),riot);
});

test('missing snapshots, transport failures and mixed releases are not empty matches or silent cross-release combinations',async()=>{
  const partial=await getResearchResults(query([item('x')]),{...deps,getChampionBuild:async id=>id==='alpha'?{status:'not_cached',data:[]}:deps.getChampionBuild(id)});
  assert.equal(partial.status,'partial');assert.equal(partial.coverage.unavailableSnapshots,1);assert.equal(partial.equipment.count,1);
  const unavailable=await getResearchResults(query([item('x')]),{...deps,getChampionBuild:async()=>({status:'not_cached',data:[]})});
  assert.equal(unavailable.status,'unavailable');
  await assert.rejects(()=>getResearchResults(query([item('x')]),{...deps,getChampionBuild:async()=>{throw Error('database unavailable');}}),/database unavailable/);
  await assert.rejects(()=>getResearchResults(query([item('x')]),{...deps,getChampionBuild:async id=>{const s=await deps.getChampionBuild(id);s.evidence.releaseId=id;return s;}}),{code:'RESEARCH_RELEASE_CHANGED'});
});

test('query scope round-trips without hiding unknown scopes or invalid entities',()=>{
  const original=query([item('x')]);assert.deepEqual(normalizeResearchQuery(JSON.parse(JSON.stringify(original))),original);
  for(const q of [query([item('missing')]),query([item('part')]),query([item('x')],{dataSource:'invented'})])assert.equal(validateResearchQuery(q,catalog).valid,false);
});
