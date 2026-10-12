import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPackedSeed } from '../scripts/export-seed.mjs';
import { sha256 } from '../scripts/stats-cache.mjs';
import { planPatchAssignments, applyPatchAssignments, effectiveSnapshotPatch, snapshotPatchEvidence, validatePatchPolicy, sameJSONAfterNumericRoundTrip } from '../server/storage/patch-attribution.mjs';
import { snapshotAvailability } from '../server/storage/runtime.mjs';
import { hasObservedCompStatistics } from '../server/comps.mjs';

const bundle=await loadPackedSeed();
const policy=JSON.parse(await readFile(new URL('../data/patch-attributions/opgg-18.4.json',import.meta.url),'utf8'));
const release={id:bundle.id,season:bundle.season,currentPatch:bundle.sourcePatch};
const rows=bundle.snapshots.map(s=>({snapshot_key:s.key,source_patch:s.sourcePatch,evidence_kind:s.kind,content_hash:sha256(s.payload),payload:s.payload}));
const plans=planPatchAssignments(rows,release,policy);
const originalFingerprints=JSON.parse((await readFile(new URL('../docs/TERMINOLOGY_SOURCE_HASHES.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));

test('reviewed policy is rebound only after proving every original source snapshot is identical and glossary is the sole addition',()=>{
  assert.equal(policy.releaseId,bundle.id);
  assert.equal(policy.releaseBinding.method,'identical_source_snapshot_hashes');
  assert.equal(policy.releaseBinding.reviewedReleaseId,originalFingerprints.releaseId);
  assert.equal(policy.releaseBinding.targetReleaseId,bundle.id);
  assert.equal(policy.releaseBinding.reviewedSnapshotCount,209);
  assert.equal(originalFingerprints.snapshots.length,209);
  assert.equal(policy.releaseBinding.reviewedSnapshotsDigest,sha256([...originalFingerprints.snapshots].sort((a,b)=>a.snapshotKey.localeCompare(b.snapshotKey))));
  const current=new Map(rows.map(row=>[row.snapshot_key,{snapshotKey:row.snapshot_key,kind:row.evidence_kind,contentHash:row.content_hash,sourcePatch:row.source_patch}]));
  for(const original of originalFingerprints.snapshots)assert.deepEqual(current.get(original.snapshotKey),original,original.snapshotKey);
  const originalKeys=new Set(originalFingerprints.snapshots.map(row=>row.snapshotKey));
  assert.deepEqual([...current.keys()].filter(key=>!originalKeys.has(key)),['glossary']);
  assert.deepEqual(policy.releaseBinding.addedSnapshotKeys,['glossary']);
  assert.equal(policy.checkedAt,'2026-10-09T15:04:56.000Z','identity migration must not pretend a new upstream patch review');
});

test('reviewed capture-date attribution enables 201 actual source snapshots, excluding unsupported records and all knowledge',()=>{
  assert.equal(plans.length,201);
  assert.ok(plans.every(p=>p.assignedPatch==='18.4'&&p.attribution.sourcePatch===null));
  for(const plan of plans) {
    const original=rows.find(row=>row.snapshot_key===plan.key);
    assert.equal(original.source_patch,null);assert.equal(original.payload.evidence.sourcePatch,null);
    assert.equal(plan.attribution.fetchedAt,original.payload.evidence.fetchedAt);
    assert.equal(plan.contentHash,sha256(original.payload));
  }
});

test('a fresh installation can assign the explicit new seed without inheriting any old database records',async()=>{
  const inserts=[];let committed=false;
  const connection={
    beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{},
    query:async sql=>{assert.match(sql,/FROM runtime_state/);return [[{active_release:release.id,current_patch:release.currentPatch}]];},
    execute:async(sql,args)=>{
      if(sql.startsWith('SELECT snapshot_key'))return [rows];
      if(sql.startsWith('SELECT content_hash'))return [[]];
      if(sql.startsWith('INSERT INTO snapshot_patch_assignments')){inserts.push(args);return [{affectedRows:1}];}
      if(sql.startsWith('INSERT INTO change_log'))return [{affectedRows:1}];
      assert.fail(`Unexpected SQL: ${sql}`);
    }
  };
  const result=await applyPatchAssignments({getConnection:async()=>connection},release,policy,{apply:true});
  assert.equal(result.status,'assigned');assert.equal(result.changed,201);assert.equal(result.eligible,201);
  assert.equal(inserts.length,201);assert.ok(committed);
  assert.ok(inserts.every(([releaseId,,hash,patch,attribution])=>releaseId===bundle.id&&patch==='18.4'&&JSON.parse(attribution).contentHash===hash));
  assert.ok(inserts.every(([,key])=>rows.find(row=>row.snapshot_key===key).source_patch===null));
});
test('reimporting old data cannot relabel it by today, another release, or another season',()=>{
  assert.deepEqual(planPatchAssignments(rows,{...release,id:'a'.repeat(64)},policy),[]);
  assert.deepEqual(planPatchAssignments(rows,{...release,currentPatch:'18.5'},policy),[]);
  assert.deepEqual(planPatchAssignments(rows,{...release,season:19},policy),[]);
  assert.deepEqual(planPatchAssignments(rows,release,{...policy,captureStart:'2026-10-08T00:00:00Z'}),[]);
  const row=structuredClone(rows.find(r=>r.snapshot_key===plans[0].key));row.payload.evidence.fetchedAt='2026-10-09T00:00:00Z';
  assert.deepEqual(planPatchAssignments([row],release,policy),[],'Changing capture time without changing hash is rejected');
});
test('source declaration wins and stale or unbound assignments never grant current status',()=>{
  const p=plans[0],record={sourcePatch:null,assignedPatch:p.assignedPatch,contentHash:p.contentHash,patchAssignment:p.attribution,release};
  assert.equal(snapshotAvailability(record),'ready');assert.equal(effectiveSnapshotPatch(record),'18.4');
  assert.equal(snapshotAvailability({...record,sourcePatch:'18.3'}),'version_mismatch');
  assert.equal(snapshotAvailability({...record,release:{...release,currentPatch:'18.5'}}),'version_mismatch');
  assert.equal(snapshotAvailability({...record,contentHash:'b'.repeat(64)}),'version_unknown');
  assert.equal(snapshotAvailability({...record,patchAssignment:null}),'version_unknown');
  assert.equal(snapshotAvailability({...record,patchAssignment:{...p.attribution,method:'guessed'}}),'version_unknown');
  const evidence=snapshotPatchEvidence(record);
  assert.equal(evidence.sourcePatch,null);assert.equal(evidence.effectivePatch,'18.4');
  assert.equal(evidence.patchAssignment.contentHash,undefined);assert.ok(evidence.patchAssignment.evidenceUrls.length);
  assert.throws(()=>validatePatchPolicy({...policy,evidenceUrls:['http://example.com']}));
});
test('homepage accepts audited inferred comp statistics while keeping original numbers and unknown source patch',()=>{
  const p=plans.find(p=>rows.find(r=>r.snapshot_key===p.key).payload.evidence.tool==='tft_list_meta_decks');
  const source=rows.find(r=>r.snapshot_key===p.key).payload,deck=source.data.data[0];
  const evidence={...source.evidence,...snapshotPatchEvidence({sourcePatch:null,assignedPatch:p.assignedPatch,contentHash:p.contentHash,patchAssignment:p.attribution,release})};
  const data={stats:{...deck.stat.deck,sampleSize:deck.stat.deck.compsCount},evidence};
  assert.ok(hasObservedCompStatistics(data));assert.equal(evidence.sourcePatch,null);
  assert.ok(!hasObservedCompStatistics({...data,evidence:{...evidence,currentPatch:'18.5'}}));
  assert.ok(!hasObservedCompStatistics({...data,evidence:{...evidence,patchAssignment:null}}));
});

test('MySQL numeric roundtrip requires original verified content and cannot excuse meaningful tampering',()=>{
  const original=rows.find(row=>row.payload.evidence?.tool==='tft_list_meta_decks');
  const row=structuredClone(original);
  row.payload.data.data[1].stat.opScore=2.054083419584914;
  assert.deepEqual(planPatchAssignments([row],release,policy),[]);
  const refs=new Map([[original.snapshot_key,original.payload]]);
  const accepted=planPatchAssignments([row],release,policy,refs);
  assert.equal(accepted.length,1);assert.equal(accepted[0].attribution.validation,'seed_hash_and_mysql_numeric_roundtrip');
  row.payload.data.data[1].stat.opScore=2.06;
  assert.deepEqual(planPatchAssignments([row],release,policy,refs),[]);
  assert.equal(sameJSONAfterNumericRoundTrip({sample:100},{sample:101}),false);
  assert.equal(sameJSONAfterNumericRoundTrip({text:'18.3'},{text:'18.4'}),false);
  assert.equal(sameJSONAfterNumericRoundTrip({value:0},{value:Number.MIN_VALUE}),false);
  assert.equal(sameJSONAfterNumericRoundTrip([1],{0:1}),false);
});
