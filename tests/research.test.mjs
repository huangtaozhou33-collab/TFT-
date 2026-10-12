import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResearchQuery, validateResearchQuery, matchesResearchDeck, researchBuildQuery } from '../public/research-query.js';
import { getResearchResults } from '../server/research.mjs';

const catalog = { champions: [{id:'a'}, {id:'b'}, {id:'c'}], items: [{id:'x'}, {id:'y'}, {id:'z'}, {id:'part',kind:'component'}], traits: [{id:'t'}, {id:'inactive'}] };
const champion = id => ({type:'champion',id});
const item = (id,holderId=null) => ({type:'item',id,holderId});
const query = (conditions,minSample=100) => normalizeResearchQuery({conditions,minSample});
const lineup = { id:'first', name:'A B', units:[{id:'a',items:['x','y','z']},{id:'b',items:['x']},{id:'c',items:[]}], traits:[{id:'t',style:2},{id:'inactive',style:0}], stats:{sampleSize:300,avgPlacement:4.1} };
const second = { id:'second', name:'A C', units:[{id:'a',items:['y']},{id:'c',items:['x']}], traits:[], stats:{sampleSize:1000,avgPlacement:3.7} };
const evidence={source:'test',sourcePatch:null,rank:null};
// Compatibility coverage for the retained v2 endpoint; v3 aggregate routing has its own suite.
const dependencies={allowAggregate:false,getCatalog:async()=>catalog,getMetaDecks:async()=>({status:'ok',data:[lineup,second],evidence}),getRiotResearchResults:async()=>null};

test('research validation rejects unknown entities, components, detached holders and malformed requests',()=>{
  for(const input of [null,[],{}, {conditions:[{type:'bad',id:'a'}]}, {conditions:[champion('unknown')]}, {conditions:[item('part')]}, {conditions:[item('x','a')]}, {conditions:Array(25).fill(champion('a'))}]) assert.equal(validateResearchQuery(input,catalog).valid,false);
  assert.equal(validateResearchQuery(query([champion('a'),item('x','a')]),catalog).valid,true);
});
test('research carrier is optional, preserved through serialization, and must be a selected champion',()=>{
  const conditions=[champion('a'),champion('b')];
  assert.equal(Object.hasOwn(normalizeResearchQuery({conditions}),'carrierId'),false);
  const selected=normalizeResearchQuery({conditions,carrierId:'b'});
  assert.equal(normalizeResearchQuery(JSON.parse(JSON.stringify(selected))).carrierId,'b');
  assert.equal(validateResearchQuery(selected,catalog).valid,true);
  for(const carrierId of ['c','missing',42,{id:'a'}])assert.equal(validateResearchQuery({conditions,carrierId},catalog).valid,false);
});
test('AND conditions match one complete lineup, including active traits and equipment ownership',()=>{
  assert.equal(matchesResearchDeck(lineup,query([champion('a'),champion('b'),item('x','a'),{type:'trait',id:'t'}])),true);
  assert.equal(matchesResearchDeck(second,query([champion('a'),champion('b')])),false);
  assert.equal(matchesResearchDeck(second,query([champion('a'),item('x','a')])),false);
  assert.equal(matchesResearchDeck(second,query([champion('a'),item('x')])),true);
  assert.equal(matchesResearchDeck(lineup,query([{type:'trait',id:'inactive'}])),false);
});
test('repeated items require enough copies globally and on the specified champion instance',()=>{
  assert.equal(matchesResearchDeck(lineup,query([item('x'),item('x')])),true);
  assert.equal(matchesResearchDeck(lineup,query([champion('a'),item('x','a'),item('x','a')])),false);
  assert.equal(matchesResearchDeck(second,query([item('x'),item('x')])),false);
  const split={...lineup,units:[{id:'a',items:['x']},{id:'a',items:['y']}]};
  assert.equal(matchesResearchDeck(split,query([champion('a'),item('x','a'),item('y','a')])),false);
});
test('complete-build endpoint is used only for one champion and their own items',()=>{
  const valid=query([champion('a'),item('x','a')],500);
  assert.deepEqual(researchBuildQuery(valid),{championId:'a',requiredItemIds:['x'],minSample:500,sort:'avgPlacement'});
  for(const conditions of [[item('x')],[champion('a'),champion('b')],[champion('a'),item('x')],[champion('a'),{type:'trait',id:'t'}]]) assert.equal(researchBuildQuery(query(conditions)),null);
});
test('research preserves observed three-item statistics while counting teammate lineups without inventing stats',async()=>{
  let received;
  const rows=[{championId:'a',itemIds:['x','y','z'],stats:{avgPlacement:3.8,sampleSize:500}}];
  const result=await getResearchResults(query([champion('a'),item('x','a')]),{...dependencies,getConditionalChampionBuild:async input=>{received=input;return{status:'ok',data:rows,evidence};}});
  assert.deepEqual(received.requiredItemIds,['x']);
  assert.deepEqual(result.equipment.rows,rows);
  assert.equal(result.equipment.kind,'observed_builds');
  assert.deepEqual(result.comps.rows.map(x=>x.id),['first']);
  assert.deepEqual(result.teammates.rows.map(x=>x.championId),['b','c']);
  assert.equal(result.teammates.rows[0].stats,undefined);
  assert.deepEqual(result.teammates.rows[0].deckIds,['first']);
  assert.equal(result.coverage.jointMatchQueries,false);
});
test('multi-champion research does not silently use single-champion builds or loosen conditions',async()=>{
  const deps={...dependencies,getConditionalChampionBuild:async()=>{throw new Error('cannot use single-champion marginal');}};
  const found=await getResearchResults(query([champion('a'),champion('b'),item('x','a')]),deps);
  assert.equal(found.equipment.kind,'source_lineups');
  assert.equal(found.comps.count,1);
  assert.deepEqual(found.teammates.rows.map(x=>x.championId),['c']);
  assert.ok(found.equipment.rows.every(x=>!Object.hasOwn(x,'stats')));
  const empty=await getResearchResults(query([champion('a'),champion('b'),item('z','b')]),deps);
  assert.equal(empty.comps.count,0);assert.equal(empty.equipment.rows.length,0);assert.equal(empty.teammates.rows.length,0);
});
test('sample threshold keeps all three lineup-derived columns in sync, and 0 allows unknown samples',async()=>{
  const high=await getResearchResults(query([champion('a'),champion('b')],500),dependencies);
  assert.equal(high.comps.matchedBeforeMinimum,1);assert.equal(high.comps.count,0);assert.equal(high.teammates.rows.length,0);assert.equal(high.equipment.rows.length,0);
  const unknown={...dependencies,getMetaDecks:async()=>({data:[{...lineup,stats:{avgPlacement:4}}],evidence})};
  assert.equal((await getResearchResults(query([champion('a'),champion('b')],0),unknown)).comps.count,1);
  assert.equal((await getResearchResults(query([champion('a'),champion('b')],100),unknown)).comps.count,0);
});

test('MySQL mode never promotes saved source lineups into strict joint match statistics',async()=>{
  const result=await getResearchResults(query([champion('a'),champion('b')],0),{...dependencies,databaseMode:true,
    getMetaDecks:async()=>{throw new Error('Aggregate lineups are not match observations');},
    getConditionalChampionBuild:async()=>{throw new Error('Cannot relax to a single champion');}});
  assert.equal(result.status,'not_supported');assert.equal(result.delivery,'mysql');
  assert.equal(result.equipment.status,'not_supported');assert.match(result.equipment.reason,/联合样本/);
  assert.deepEqual(result.equipment.rows,[]);assert.deepEqual(result.teammates.rows,[]);assert.deepEqual(result.comps.rows,[]);
  assert.equal(result.coverage.jointMatchQueries,false);
});

test('MySQL mode can return supported single-holder builds while joint teammate columns remain unavailable',async()=>{
  const rows=[{championId:'a',itemIds:['x','y','z'],stats:{avgPlacement:4.1,sampleSize:17}}];
  const result=await getResearchResults(query([champion('a'),item('x','a')],0),{...dependencies,databaseMode:true,
    getConditionalChampionBuild:async input=>{assert.equal(input.minSample,0);return{status:'ok',data:rows,evidence:{sourcePatch:'18.4'}};}});
  assert.deepEqual(result.equipment.rows,rows);assert.deepEqual(result.teammates.rows,[]);assert.deepEqual(result.comps.rows,[]);
  assert.equal(result.status,'partial');assert.equal(result.equipment.status,'ok');assert.equal(result.teammates.status,'not_supported');
});

test('published Riot empty results never fall back to aggregate OP.GG builds or lineups',async()=>{
  const riot={status:'empty',source:'riot',equipment:{rows:[]},teammates:{rows:[]},comps:{rows:[]},coverage:{jointMatchQueries:true}};
  const result=await getResearchResults(query([champion('a'),champion('b')]),{...dependencies,databaseMode:true,
    getRiotResearchResults:async()=>riot,getMetaDecks:async()=>{throw Error('No weaker fallback');},getConditionalChampionBuild:async()=>{throw Error('No weaker fallback');}});
  assert.equal(result,riot);
});
