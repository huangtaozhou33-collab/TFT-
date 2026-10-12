import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeMetaOverall, normalizeMetaComps, normalizeMetaDetail, loadMetaDataset } from '../server/metatft/datasets.mjs';
import { metaScope, metaParams, metaEvidence } from '../server/metatft/scope.mjs';
import { metaPlan, metaStats } from '../server/metatft/query.mjs';
import { hasObservedCompStatistics } from '../server/comps.mjs';
import { sha256 } from '../scripts/stats-cache.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../data/catalog.json',import.meta.url)));
const fixture=k=>JSON.parse(fs.readFileSync(new URL(`./fixtures/metatft-unified/${k}.json`,import.meta.url)));
const release={id:'a'.repeat(64),season:18,currentPatch:'18.4'};
const metadata={set:'TFTSet18',patch:{patch:'18.4',b_patch_version:'b'}};
const scope=metaScope(release,metadata);
const overall=()=>Object.fromEntries(['total','units','items','traits'].map(k=>[k,fixture(k)]));
const comps=()=>({definitions:fixture('compsData'),statistics:fixture('compsStats')});

test('overview, detail and explorer share exact queue/patch/b-patch/day/rank parameters',()=>{
  const plan=metaPlan({conditions:[{type:'champion',id:'DA_18_Ahri'}]},release,metadata);
  const p=new URL(plan.urls.total,'https://api-hc.metatft.com').searchParams;
  for(const [k,v] of metaParams(scope))assert.equal(p.get(k),v,k);
  assert.throws(()=>metaScope({...release,currentPatch:'18.5'},metadata),{code:'METATFT_VERSION_MISMATCH'});
});
test('overall histogram uses first occurrences; no overlapping second-copy counts or fabricated mappings',()=>{
  const raw=overall(),result=normalizeMetaOverall(raw,scope,catalog);
  assert.equal(result.rows.filter(r=>r.dimension==='units').length,65);
  assert.equal(result.rows.filter(r=>r.dimension==='items').length,136);
  assert.equal(result.summary.total,6995256);
  for(const row of result.rows){
    assert.deepEqual({...row.stats,pickRate:undefined},{...metaStats(row.placementCount),pickRate:undefined});
    if(row.dimension!=='traits')assert.match(row.sourceKey,/-1$/);
  }
  const dragon=result.rows.find(r=>r.id==='DA_18_ElderDragon');
  assert.deepEqual(dragon.placementCount,raw.units.data.data.find(r=>r.units_unique==='DA_18_ElderDragon-1').placement_count);
  assert.ok(result.summary.skipped.units.includes('TFT18_SprykinSummonMelee-1'));
  assert.equal(result.rows.filter(r=>r.kind==='component').length,10);
});
test('scope widening, malformed distributions and duplicate rows fail instead of producing empty data',()=>{
  const r=overall();r.units.data.filter_adjustment.override_applied=true;
  assert.throws(()=>normalizeMetaOverall(r,scope,catalog),{code:'METATFT_SCOPE_CHANGED'});
  const r2=overall();r2.items.data.data[1].placement_count[0]=-1;
  assert.throws(()=>normalizeMetaOverall(r2,scope,catalog),{code:'METATFT_RESPONSE_INVALID'});
  const r3=overall();r3.units.data.data.push(r3.units.data.data.find(r=>r.units_unique==='DA_18_Ahri-1'));
  assert.throws(()=>normalizeMetaOverall(r3,scope,catalog),{code:'METATFT_RESPONSE_INVALID'});
});
test('home cluster statistics retain their own histograms, independent template scope, no invented stars/positions/codes',()=>{
  const source=comps(),r=normalizeMetaComps(source,scope,catalog);
  assert.equal(r.rows.length,60);assert.equal(r.summary.total,6652259);
  const evidence=metaEvidence({scope,metadata,release,id:'b'.repeat(64),contentHash:'c'.repeat(64),capturedAt:1,expiresAt:600001},'MetaTFT Comps');
  for(const row of r.rows){
    const histogram=source.statistics.data.results.find(x=>x.cluster===row.sourceCluster).places.slice(0,8);
    assert.equal(row.stats.avgPlacement,metaStats(histogram).avgPlacement);
    assert.equal(row.statisticsKind,'comp_cluster');assert.equal(row.templateEvidence.scope,'source_default_template');
    assert.ok(row.units.every(u=>u.star===null&&u.cell===null));assert.equal(row.teamCode,null);
    assert.ok(hasObservedCompStatistics({...row,evidence:{...evidence,statisticsKind:'comp_cluster'}}));
  }
  source.definitions.data.cluster_id++;
  assert.throws(()=>normalizeMetaComps(source,scope,catalog),{code:'METATFT_CLUSTER_MISMATCH'});
});
test('cluster source count and ninth histogram total must match, no stats borrowed from template overall',()=>{
  const source=comps();source.statistics.data.results[1].places[8]++;
  assert.throws(()=>normalizeMetaComps(source,scope,catalog),{code:'METATFT_RESPONSE_INVALID'});
});
test('generic detail normalizers accept all observed three-item builds and holders, preserving repeat items',()=>{
  const builds=normalizeMetaDetail(fixture('builds'),{...scope,kind:'builds',entityId:'DA_18_ElderDragon'},catalog);
  assert.equal(builds.rows.length,471);assert.ok(builds.rows.every(r=>r.itemIds.length===3));
  assert.ok(builds.rows.some(r=>new Set(r.itemIds).size<3));
  const holders=normalizeMetaDetail(fixture('holders'),{...scope,kind:'holders',entityId:'DA_Artifact_SilvermereDawn'},catalog);
  assert.equal(holders.rows.length,65);assert.ok(holders.rows.some(r=>r.championId==='DA_18_Ahri'));
  assert.ok(holders.rows.every(r=>r.sourceKey.endsWith('-1&DA_Artifact_SilvermereDawn-1')));
});
test('valid empty response remains empty; rank override remains an error',()=>{
  const source=fixture('holders');source.data.data=[];
  assert.equal(normalizeMetaDetail(source,{...scope,kind:'holders',entityId:'DA_Artifact_SilvermereDawn'},catalog).rows.length,0);
  source.data.filter_adjustment.override_applied=true;
  assert.throws(()=>normalizeMetaDetail(source,{...scope,kind:'holders',entityId:'DA_Artifact_SilvermereDawn'},catalog),{code:'METATFT_SCOPE_CHANGED'});
});
test('first collection saves exact response text before returning SQL rows; cached and concurrent reads reuse it',async()=>{
  const events=[],raw=fixture('builds');let saved;
  const deps={getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,findDataset:async()=>saved||null,
    readMetaTft:async url=>{events.push('fetch');assert.match(url,/unit_unique=DA_18_ElderDragon-1/);return raw;},
    saveDataset:async value=>{events.push('save');saved=value;},readDatasetRows:async id=>{events.push('sql');assert.equal(id,saved.id);return saved.rows;}};
  const [a,b]=await Promise.all([loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps),loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps)]);
  assert.deepEqual(events,['fetch','save','sql','sql']);assert.equal(a.snapshot.id,b.snapshot.id);
  assert.equal(sha256(saved.rawResponseText),saved.contentHash);
  assert.equal(JSON.parse(saved.rawResponseText).rows.bodyText,raw.bodyText);
  assert.equal(a.evidence.sourcePatch,null);assert.equal(a.evidence.requestedPatch,'18.4b');
  const cached=await loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps);assert.equal(cached.cacheHit,true);assert.equal(events.filter(x=>x==='fetch').length,1);
});
test('failed persistence never returns upstream-only rows; unknown entities do not initiate collection',async()=>{
  const deps={getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,findDataset:async()=>null,
    readMetaTft:async()=>fixture('holders'),saveDataset:async()=>{throw new Error('write failed');},readDatasetRows:async()=>{throw new Error('must not run');}};
  await assert.rejects(loadMetaDataset('holders','DA_Artifact_SilvermereDawn',catalog,deps),/write failed/);
  await assert.rejects(loadMetaDataset('builds','out_of_set',catalog,deps),{code:'INVALID_STAT_ENTITY'});
});

test('unchanged content checks extend freshness without duplicating snapshot or replacing capture time',async()=>{
  let saved,saves=0,touched=0;
  const deps={force:true,ttlMs:86400000,getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,
    findDataset:async()=>saved,readMetaTft:async()=>fixture('builds'),
    saveDataset:async s=>{saved=s;saves++;},touchDataset:async(id,expiry)=>{assert.equal(id,saved.id);assert.ok(expiry>=saved.expiresAt);touched++;},readDatasetRows:async()=>saved.rows};
  const first=await loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps);
  const next=await loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps);
  assert.equal(first.snapshot.id,next.snapshot.id);assert.equal(next.unchanged,true);
  assert.equal(first.evidence.fetchedAt,next.evidence.fetchedAt);assert.equal(saves,1);assert.equal(touched,1);
});

test('local expired datasets remain readable after failed background refresh without repeating upstream work',async()=>{
  let reads=0,writes=0;
  const snapshot={id:'persisted',releaseId:release.id,scope:{...scope,kind:'builds'},metadata,summary:{metric:'observed_three_item_build'},capturedAt:1,expiresAt:2};
  const deps={getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,findDataset:async()=>snapshot,
    readMetaTft:async()=>{reads++;throw new Error('upstream failed');},saveDataset:async()=>{writes++;},readDatasetRows:async()=>[{id:'old',stats:{sampleSize:7}}]};
  await assert.rejects(loadMetaDataset('builds','DA_18_ElderDragon',catalog,{...deps,force:true}),/upstream failed/);
  const result=await loadMetaDataset('builds','DA_18_ElderDragon',catalog,deps);
  assert.equal(reads,1);assert.equal(writes,0);assert.equal(result.rows[0].stats.sampleSize,7);assert.equal(result.evidence.stale,true);assert.equal(result.cacheHit,true);
});
