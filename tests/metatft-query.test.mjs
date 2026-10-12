import test from 'node:test';
import assert from 'node:assert/strict';
import { metaPlan, metaStats, normalizeMetaRows, getMetaTftResearchResults } from '../server/metatft/query.mjs';
import { readMetaTft } from '../server/metatft/client.mjs';
import { getResearchResults } from '../server/research.mjs';
import { patchContext } from '../public/patch-context.js';
import { sha256 } from '../scripts/stats-cache.mjs';

const release = { id: 'release', season: 18, currentPatch: '18.4' };
const metadata = { set: 'TFTSet18', patch: { patch: '18.4', b_patch_version: 'b' } };
const catalog = { champions: ['HeroA','HeroB','HeroC'].map(id => ({ id, name: id })), items: ['ItemA','ItemB','ItemC'].map(id => ({ id, name: id })), traits: [] };
const hero = id => ({ type: 'champion', id });
const item = (id, holderId = null) => ({ type: 'item', id, holderId });
const query = (conditions, extra = {}) => ({ conditions, minSample: 2, sort: 'avgPlacement', dataSource: 'metatft', ...extra });
const histogram = [3,2,1,1,1,0,0,0];
const adjustment = { override_applied: false, rank_filter: 'CHALLENGER,DIAMOND,EMERALD,GRANDMASTER,MASTER,PLATINUM', sample_size: 987654 };
const response = data => { const payload={ data, filter_adjustment: adjustment }, bodyText=JSON.stringify(payload); return { data:payload, bodyText, url:'https://api-hc.metatft.com/test', fetchedAt:'2026-10-11T00:00:00Z', contentHash:sha256(bodyText) }; };

test('generic conditions bind different holders and consume separate copies across the board', () => {
  const plan = metaPlan(query([hero('HeroB'), hero('HeroA'), item('ItemA','HeroA'), item('ItemA','HeroB'), item('ItemA'), item('ItemB','HeroA')]), release, metadata);
  const url = new URL(plan.urls.total, 'https://api-hc.metatft.com');
  assert.deepEqual(url.searchParams.getAll('unit_unique').sort(), ['HeroA-1','HeroB-1']);
  assert.ok(url.searchParams.getAll('item_unique').includes('ItemA-3'));
  assert.deepEqual(url.searchParams.getAll('unit_item_unique').sort(), ['HeroA-1&ItemA-1','HeroA-1&ItemB-1','HeroB-1&ItemA-1']);
  const repeated = metaPlan(query([hero('HeroA'),item('ItemB','HeroA'),item('ItemB','HeroA')]), release, metadata);
  assert.equal(new URL(repeated.urls.total,'https://api-hc.metatft.com').searchParams.get('unit_item_unique'),'HeroA-1&ItemB-2');
});

test('snapshot identity isolates release, patch, holder and carrier; sorting and threshold reuse observations', () => {
  const q = query([hero('HeroA'),hero('HeroB'),item('ItemA','HeroA')], { carrierId: 'HeroA' });
  const key = metaPlan(q,release,metadata).queryKey;
  assert.equal(metaPlan({...q,conditions:q.conditions.slice().reverse(),sort:'sampleSize',minSample:100},release,metadata).queryKey,key);
  assert.notEqual(metaPlan({...q,conditions:[hero('HeroA'),hero('HeroB'),item('ItemA','HeroB')]},release,metadata).queryKey,key);
  assert.notEqual(metaPlan({...q,carrierId:'HeroB'},release,metadata).queryKey,key);
  assert.notEqual(metaPlan(q,{...release,id:'new'},metadata).queryKey,key);
  assert.notEqual(metaPlan(q,release,{...metadata,patch:{...metadata.patch,b_patch_version:'c'}}).queryKey,key);
  assert.throws(()=>metaPlan(q,release,{...metadata,set:'TFTSet17'}),{code:'METATFT_VERSION_MISMATCH'});
  assert.throws(()=>metaPlan(q,release,{...metadata,patch:{patch:'18.5',b_patch_version:''}}),{code:'METATFT_VERSION_MISMATCH'});
});

test('single equipment queries use holders; champion queries use co-occurring units and a specific build target', () => {
  const a=metaPlan(query([item('ItemB')]),release,metadata);
  assert.equal(a.paths.teammates,'item_units_unique/ItemB-1');
  assert.equal(a.paths.equipment,'unit_builds/any_unit/ItemB');
  const b=metaPlan(query([hero('HeroA'),hero('HeroB'),item('ItemB')],{carrierId:'HeroB'}),release,metadata);
  assert.equal(b.paths.teammates,'units_unique');assert.equal(b.paths.equipment,'unit_builds/HeroB');
  assert.equal(new URL(b.urls.total,'https://api-hc.metatft.com').searchParams.has('unit_item_unique'),false);
});

test('placement histograms give metrics without calling the baseline count the matched sample', () => {
  assert.deepEqual(metaStats(histogram),{sampleSize:8,avgPlacement:2.375,top4Rate:.875,winRate:.375});
  assert.equal(metaStats([0,0,0,0,0,0,0,0]).avgPlacement,null);
  for(const bad of [[1],[-1,0,0,0,0,0,0,0],['1',0,0,0,0,0,0,0]])assert.throws(()=>metaStats(bad),{code:'METATFT_RESPONSE_INVALID'});
});

test('overlapping copy rows are not combined; complete builds preserve exact stats and holder requirements', () => {
  const holders=metaPlan(query([item('ItemA')]),release,metadata);
  const rows=normalizeMetaRows('teammates',[{unit_items_unique:'HeroA-1&ItemA-1',placement_count:histogram},{unit_items_unique:'HeroA-2&ItemA-1',placement_count:histogram}],holders,catalog);
  assert.equal(rows.length,1);assert.equal(rows[0].stats.sampleSize,8);assert.equal(rows[0].star,undefined);
  const p=metaPlan(query([hero('HeroA'),item('ItemA','HeroA')]),release,metadata);
  const builds=normalizeMetaRows('equipment',[{unit_builds:'HeroA&ItemA|ItemB|ItemC',placement_count:histogram},{unit_builds:'HeroA&ItemB|ItemB|ItemC',placement_count:histogram},{unit_builds:'HeroA&ItemA|ItemB',placement_count:histogram}],p,catalog);
  assert.equal(builds.length,1);assert.deepEqual(builds[0].itemIds,['ItemA','ItemB','ItemC']);
  assert.throws(()=>normalizeMetaRows('comps',[{units_traits:'HeroB|SomeTrait_1',placement_count:histogram}],p,catalog),{code:'METATFT_SCOPE_CHANGED'});
});

function harness({zero=false,override=false,writeFails=false}={}) {
  let snapshot=null,calls=0,saved=0,reads=0;
  const deps={databaseMode:true,getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,findMetaSnapshot:async()=>snapshot,
    readMetaTft:async path=>{calls++;const data=path.includes('/total?')?[{placement_count:zero?[0,0,0,0,0,0,0,0]:histogram}]
      :path.includes('/unit_builds/')?[{unit_builds:'HeroA&ItemA|ItemB|ItemC',placement_count:histogram}]
      :path.includes('/units_unique?')?[{units_unique:'HeroC-1',placement_count:histogram}]
      :[{units_traits:'HeroA&HeroB&HeroC|Trait_1',placement_count:histogram}];
      const r=response(data);if(override)r.data.filter_adjustment={...adjustment,override_applied:true};return r;},
    saveMetaSnapshot:async s=>{saved++;if(writeFails)throw Object.assign(new Error('database write failed'),{code:'DATABASE_UNAVAILABLE'});snapshot=s;},
    selectMetaRows:async(id,q)=>{reads++;assert.equal(id,snapshot.id);return Object.fromEntries(['equipment','teammates','comps'].map(d=>{const all=snapshot.rows.filter(r=>r.dimension===d),rows=all.filter(r=>r.stats.sampleSize>=q.minSample);return[d,{rows,count:rows.length,beforeMinimum:all.length}]}));}};
  return {deps,get state(){return{snapshot,calls,saved,reads}}};
}

test('first collection is persisted then selected; subsequent sorting reads the same MySQL snapshot',async()=>{
  const h=harness(),q=query([hero('HeroA'),hero('HeroB'),item('ItemA','HeroA')]);
  const result=await getMetaTftResearchResults(q,catalog,h.deps);
  assert.equal(result.source,'metatft');assert.equal(result.delivery,'mysql');assert.equal(result.coverage.matchedSamples,8);
  assert.equal(result.coverage.matchedMatches,null);assert.equal(result.coverage.cacheHit,false);
  assert.equal(h.state.calls,4);assert.equal(h.state.saved,1);assert.equal(h.state.reads,1);
  assert.equal(sha256(h.state.snapshot.rawResponseText),h.state.snapshot.contentHash);
  for (const raw of Object.values(JSON.parse(h.state.snapshot.rawResponseText))) assert.equal(sha256(raw.bodyText),raw.contentHash);
  assert.equal(result.equipment.rows[0].stats.sampleSize,8);assert.equal(result.evidence.sourcePatch,null);
  assert.equal(patchContext(result.evidence).label,'18.4b · 查询范围');
  const filtered=await getMetaTftResearchResults({...q,minSample:500,sort:'sampleSize'},catalog,h.deps);
  assert.equal(filtered.coverage.cacheHit,true);assert.equal(filtered.coverage.matchedSamples,8);
  assert.equal(filtered.equipment.status,'insufficient_samples');assert.equal(filtered.equipment.count,0);
  assert.equal(h.state.calls,4);assert.equal(h.state.reads,2);
});

test('real zero histograms persist an empty snapshot; no alternative source or column fetch is attempted',async()=>{
  const h=harness({zero:true});const result=await getMetaTftResearchResults(query([hero('HeroA')]),catalog,h.deps);
  assert.equal(result.status,'empty');assert.equal(result.coverage.matchedSamples,0);assert.equal(h.state.calls,1);
  assert.equal(h.state.saved,1);assert.equal(result.comps.rows.length,0);assert.match(result.comps.reason,/没有同时满足全部条件/);
});

test('scope expansion and database failure are failures, never published as empty or live rows',async()=>{
  const a=harness({override:true});await assert.rejects(getMetaTftResearchResults(query([hero('HeroA')]),catalog,a.deps),{code:'METATFT_SCOPE_CHANGED'});assert.equal(a.state.saved,0);
  const b=harness({writeFails:true});await assert.rejects(getMetaTftResearchResults(query([hero('HeroA')]),catalog,b.deps),{code:'DATABASE_UNAVAILABLE'});assert.equal(b.state.reads,0);
  await assert.rejects(readMetaTft('/tft-stat-api/patch',async()=>({ok:false,status:429,text:async()=>'rate limited'})),{code:'METATFT_UNAVAILABLE'});
});

test('explicit MetaTFT routing validates entities and never consults OP.GG or Riot on errors',async()=>{
  let calls=0;
  const deps={databaseMode:true,getCatalog:async()=>catalog,getMetaTftResearchResults:async q=>{calls++;return{source:'metatft',query:q}},getRiotResearchResults:async()=>assert.fail('Riot fallback'),getAggregateResearchResults:async()=>assert.fail('aggregate fallback')};
  const result=await getResearchResults(query([hero('HeroB'),item('ItemC','HeroB')]),deps);assert.equal(result.source,'metatft');
  for (const dataSource of [undefined,'auto']) assert.equal((await getResearchResults(query([hero('HeroB')],{dataSource}),deps)).source,'metatft');
  await assert.rejects(getResearchResults(query([hero('Unknown')]),deps),{code:'INVALID_RESEARCH_QUERY'});assert.equal(calls,3);
});
