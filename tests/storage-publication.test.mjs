import test from 'node:test';
import assert from 'node:assert/strict';
import { publishBundle } from '../server/storage/repository.mjs';
import { sha256 } from '../scripts/stats-cache.mjs';

function bundle(name,sourcePatch='18.4') {
  const data={season:18,sourcePatch,manifest:{name,counts:{}},snapshots:[],entities:[],documents:[],chunks:[],capabilities:[]};
  return {id:sha256(data),...data};
}
function publishedDatabase(bundles,active) {
  const releases=new Map(bundles.map(b=>[b.id,{state:'published',sourcePatch:b.sourcePatch}]));
  const state={currentPatch:active.sourcePatch,activeRelease:active.id};
  const changes=[];let committed=false;
  const connection={
    query:async sql=>{
      if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
      if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
      if(sql.includes('FROM runtime_state'))return [[{current_patch:state.currentPatch,active_release:state.activeRelease,active_patch:releases.get(state.activeRelease).sourcePatch}]];
      throw new Error(`Unexpected query: ${sql}`);
    },
    execute:async(sql,args)=>{
      if(sql.startsWith('SELECT state'))return [[releases.get(args[0])].filter(Boolean)];
      if(sql.startsWith('INSERT IGNORE INTO runtime_state'))return [{}];
      if(sql.startsWith('UPDATE runtime_state')){state.activeRelease=args[0];state.currentPatch=args[1];return [{}];}
      if(sql.startsWith('INSERT INTO change_log')){changes.push(args);return [{}];}
      throw new Error(`Unexpected mutation: ${sql}`);
    },
    beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{}
  };
  return {getConnection:async()=>connection,state,changes,get committed(){return committed;}};
}
test('startup seed A cannot roll back a newer same-patch publication B',async()=>{
  const a=bundle('initial'),b=bundle('updated'),db=publishedDatabase([a,b],b);
  const old=process.env.CURRENT_GAME_PATCH;delete process.env.CURRENT_GAME_PATCH;
  try {const result=await publishBundle(a,db);assert.equal(result.status,'unchanged');assert.equal(result.active,false);assert.equal(db.state.activeRelease,b.id);assert.equal(db.changes.length,0);assert.equal(db.committed,true);}
  finally{if(old===undefined)delete process.env.CURRENT_GAME_PATCH;else process.env.CURRENT_GAME_PATCH=old;}
});
test('an explicitly selected new patch can activate an already imported matching release',async()=>{
  const a=bundle('old'),b=bundle('new','18.5'),db=publishedDatabase([a,b],a);
  const old=process.env.CURRENT_GAME_PATCH;process.env.CURRENT_GAME_PATCH='18.5';
  try {const result=await publishBundle(b,db);assert.equal(result.active,true);assert.equal(db.state.activeRelease,b.id);assert.equal(db.state.currentPatch,'18.5');assert.equal(db.changes.length,1);}
  finally{if(old===undefined)delete process.env.CURRENT_GAME_PATCH;else process.env.CURRENT_GAME_PATCH=old;}
});
test('bundle hash tampering fails before connecting or publishing',async()=>{
  const a=bundle('initial');a.sourcePatch='18.5';
  await assert.rejects(publishBundle(a,{getConnection:async()=>{assert.fail('must validate before connecting');}}),/hash mismatch/);
});
