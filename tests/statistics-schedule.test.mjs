import test from 'node:test';
import assert from 'node:assert/strict';
import {STATISTICS_JOBS,validateSchedule,statisticsTasks,collectStatisticsJob,referenceScope,statisticsSourceCooldown} from '../server/statistics-schedule.mjs';

test('only registered statistics jobs are editable; frequency is bounded and optimistic revision required',()=>{
  for(const j of STATISTICS_JOBS)assert.equal(validateSchedule({id:j.id,enabled:true,intervalHours:24,revision:1}).intervalHours,24);
  for(const value of [0,-1,0.5,169,'24',NaN])assert.throws(()=>validateSchedule({id:'meta-comps',enabled:true,intervalHours:value,revision:1}),{code:'INVALID_SCHEDULE'});
  assert.throws(()=>validateSchedule({id:'library',enabled:true,intervalHours:24,revision:1}));
  assert.throws(()=>validateSchedule({id:'meta-comps',enabled:'true',intervalHours:24,revision:1}));
});
test('catalogue jobs cover every entity and 12 independent rank scopes, including radiant and artifacts',()=>{
  const catalog={champions:[{id:'one'},{id:'two'}],items:[{id:'a',category:'artifact'},{id:'r',category:'radiant'},{id:'c',kind:'component'}]};
  assert.equal(statisticsTasks('builds',catalog).length,24);
  assert.equal(statisticsTasks('holders',catalog).length,36);
  assert.equal(statisticsTasks('comps',catalog).length,12);
});
const catalog={champions:[],items:[]},release={id:'test'},metadata={patch:{patch:'18.4',b_patch_version:'b'}};
test('scheduled jobs force checks using selected TTL and distinguish changed, unchanged and actual empty',async()=>{
  const args=[];
  const report=await collectStatisticsJob({kind:'comps',intervalHours:24},{catalog,release,metadata,load:async(...a)=>{args.push(a);return {unchanged:args.length>1,rows:[]};}});
  assert.equal(args.length,12);assert.equal(args[0][3].force,true);assert.equal(args[0][3].ttlMs,86400000);
  assert.equal(report.changed,1);assert.equal(report.unchanged,11);assert.equal(report.empty,12);assert.equal(report.failed,0);
});
test('403 and 429 stop the whole batch, retain retry-after, and never attempt another rank',async()=>{
  for(const httpStatus of [403,429]){
    let calls=0;const report=await collectStatisticsJob({kind:'comps',intervalHours:24},{catalog,release,metadata,load:async()=>{calls++;throw Object.assign(new Error('blocked'),{httpStatus,retryAfterMs:900000});}});
    assert.equal(calls,1);assert.equal(report.stopped,true);assert.equal(report.failed,1);assert.equal(report.retryAfterMs,900000);
  }
});
test('three consecutive failures terminate batch; failed reads are not counted as zero-sample snapshots',async()=>{
  const report=await collectStatisticsJob({kind:'comps',intervalHours:24},{catalog,release,metadata,load:async()=>{throw Object.assign(new Error('upstream'),{code:'METATFT_UNAVAILABLE'});}});
  assert.equal(report.completed,3);assert.equal(report.failed,3);assert.equal(report.empty,0);assert.equal(report.changed,0);
});
test('lost scheduler lock stops before issuing more requests',async()=>{
  let calls=0;
  await assert.rejects(collectStatisticsJob({kind:'comps',intervalHours:24},{catalog,release,metadata,guard:async()=>{throw new Error('lost lock');},load:async()=>{calls++;}}),/lost lock/);
  assert.equal(calls,0);
});
test('reference provenance preserves source patch separately from requested patch; unknown fields stay null',()=>{
  const context={tool:'test',args:{},release:{season:18,currentPatch:'18.4'}};
  const explicit=referenceScope({version:'18.3b',metadata:{gameStatDateTime:'source-time'}},context);
  assert.equal(explicit.sourcePatch,'18.3b');assert.equal(explicit.requestedPatch,'18.4');assert.equal(explicit.sourceTime,'source-time');
  assert.equal(referenceScope({},context).sourcePatch,null);assert.equal(explicit.rank,null);
});
test('source cooldown is shared across MetaTFT jobs while OP.GG remains independent',async()=>{
  const db={execute:async(sql,params)=>{assert.match(sql,/last_finished_at/);return [params[0]==='meta-%'?[{last_finished_at:1000,progress:{retryAfterMs:900000}},{last_finished_at:2000,progress:null}]:[]];}};
  assert.equal(await statisticsSourceCooldown(db,'meta-builds'),901000);
  assert.equal(await statisticsSourceCooldown(db,'meta-comps'),901000);
  assert.equal(await statisticsSourceCooldown(db,'opgg-reference'),0);
});
