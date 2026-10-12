import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRiotMatch } from '../server/riot/normalize.mjs';
import { inferMatchPatch,windowFromProbe } from '../server/riot/patch-policy.mjs';

const window={platform:'kr',season:18,patch:'18.4',from:'2026-10-08T12:00:00.000Z',to:'2026-10-09T16:00:00.000Z',checkedAt:'2026-10-09T16:00:00.000Z',
  method:'calendar_and_page_inference',evidenceUrls:['https://op.gg/zh-cn/tft/meta-trends/comps','https://support.riotgames.com/en-us/tft/events/patch-schedule-teamfight-tactics/']};
const catalog={context:{set:18},champions:[{id:'A'},{id:'B'}],items:[{id:'x',kind:'completed'},{id:'y',kind:'completed'},{id:'z',kind:'completed'}]};
function sample(){return {fetchedAt:'2026-10-09T15:00:00Z',body:{metadata:{match_id:'KR_999'},info:{
  queue_id:1100,tft_set_number:18,game_version:'TFT Unreal Version ?.?.?.?',gameCreation:Date.parse('2026-10-09T13:00:00Z'),
  game_datetime:Date.parse('2026-10-09T13:30:00Z'),game_length:1800,
  participants:Array.from({length:8},(_,i)=>({placement:i+1,level:8,units:[{character_id:'A',tier:2,itemNames:['x','y','z']},{character_id:'B',tier:1,itemNames:[]}],traits:[]}))}}};}

test('Riot game_datetime is the end; gameCreation is the start, preserving raw patch and inferred attribution',()=>{
  const m=normalizeRiotMatch(sample(),catalog,[window]);
  assert.equal(m.status,'ready');assert.equal(m.start,Date.parse('2026-10-09T13:00:00Z'));
  assert.equal(m.end,Date.parse('2026-10-09T13:30:00Z'));assert.equal(m.sourcePatch,null);
  assert.equal(m.assignedPatch,'18.4');assert.equal(m.patchAttribution.hotfix,null);assert.equal(m.participants.length,8);
});
test('capture date cannot relabel an older or boundary-crossing match',()=>{
  const s=sample();s.body.info.gameCreation=Date.parse(window.from)-1000;s.body.info.game_datetime=Date.parse(window.from)+1799000;
  const m=normalizeRiotMatch(s,catalog,[window]);assert.equal(m.status,'quarantined');assert.equal(m.assignedPatch,null);
  assert.ok(m.quality.issues.includes('outside_verified_time_window'));
});
test('unknown item IDs are retained and only affected complete builds are excluded',()=>{
  const s=sample();s.body.info.participants[0].units[0].itemNames[2]='potion';
  const m=normalizeRiotMatch(s,catalog,[window]);assert.equal(m.status,'ready');assert.equal(m.participants[0].units[0].validBuild,false);
  assert.equal(m.participants[1].units[0].validBuild,true);assert.deepEqual(m.quality.unknownItems,[{id:'potion',count:1}]);
});
test('malformed boards and mixed modes stay out of ranked queries',()=>{
  for(const mutate of [s=>s.body.info.queue_id=1090,s=>s.body.info.participants.pop(),s=>s.body.info.participants[0].placement=2,
    s=>s.body.info.participants[0].units[0].character_id='unknown',s=>s.body.info.game_datetime=Date.parse('2026-10-11T00:00:00Z')]){
    const s=sample();mutate(s);assert.equal(normalizeRiotMatch(s,catalog,[window]).status,'quarantined');
  }
});
test('composition and build keys are order independent but keep duplicate counts',()=>{
  const a=sample(),b=sample();b.body.info.participants[0].units.reverse();b.body.info.participants[0].units[1].itemNames.reverse();
  const x=normalizeRiotMatch(a,catalog,[window]).participants[0],y=normalizeRiotMatch(b,catalog,[window]).participants[0];
  assert.equal(x.compositionKey,y.compositionKey);assert.equal(x.units[0].buildKey,y.units[1].buildKey);
  b.body.info.participants[0].units.push({character_id:'B',tier:1,itemNames:[]});
  assert.notEqual(x.compositionKey,normalizeRiotMatch(b,catalog,[window]).participants[0].compositionKey);
});
test('catalog legality changes invalidate derived fingerprint even when raw match stays identical',()=>{
  const a=normalizeRiotMatch(sample(),catalog,[window]);
  const changed={...catalog,items:catalog.items.map(i=>i.id==='x'?{...i,slotCost:3}:i)};
  const b=normalizeRiotMatch(sample(),changed,[window]);
  assert.equal(a.contentHash,b.contentHash);assert.notEqual(a.quality.derivedHash,b.quality.derivedHash);
  assert.equal(a.participants[0].units[0].validBuild,true);assert.equal(b.participants[0].units[0].validBuild,false);
});
test('unmapped real version or conflicting time windows never gets silently guessed',()=>{
  const m={platform:'kr',season:18,start:Date.parse('2026-10-09T13:00:00Z'),end:Date.parse('2026-10-09T13:30:00Z'),rawVersion:'Version 16.20'};
  assert.equal(inferMatchPatch(m,[window]).patch,null);
  assert.equal(inferMatchPatch({...m,rawVersion:'?'},[window,{...window,patch:'18.5'}]).reason,'conflicting_patch_windows');
});
test('automatic windows require agreeing independent pages and exclude transition period/future',()=>{
  const report={status:'known',checkedAt:window.to,calendar:{status:'known',mainPatch:'18.4',scheduledDate:'2026-10-07'},sourcePage:{status:'known',patch:'18.4'},
    evidence:window.evidenceUrls.map(url=>({url,status:'ok'}))};
  assert.equal(windowFromProbe(report,18).from,window.from);
  assert.equal(windowFromProbe({...report,sourcePage:{status:'known',patch:'18.5'}},18),null);
  assert.equal(windowFromProbe({...report,checkedAt:'2026-10-07T15:00:00Z'},18),null);
});
