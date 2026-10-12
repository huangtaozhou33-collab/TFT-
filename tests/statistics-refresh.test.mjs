import test from 'node:test';
import assert from 'node:assert/strict';
import {watchStatistics} from '../public/statistics-refresh.js';
test('local version polling refreshes only on change; hidden pages and failures retain current display',async()=>{
  const previous={document:globalThis.document,window:globalThis.window,setInterval:globalThis.setInterval};
  const events={};let tick,version='release:1',fail=false,calls=0,changes=0;
  globalThis.document={visibilityState:'visible',addEventListener:(name,f)=>events[name]=f};
  globalThis.window={addEventListener:(name,f)=>events[name]=f};
  globalThis.setInterval=(f,ms)=>{assert.equal(ms,300000);tick=f;return 1;};
  try{
    watchStatistics({api:async path=>{assert.equal(path,'/api/statistics-version');calls++;if(fail)throw new Error();return {version};},onChange:()=>changes++});
    await new Promise(r=>setImmediate(r));await tick();assert.equal(changes,0);
    version='release:2';await events.visibilitychange();assert.equal(changes,1);
    await events.hashchange();assert.equal(changes,1);
    fail=true;await tick();assert.equal(changes,1);
    const count=calls;globalThis.document.visibilityState='hidden';await tick();assert.equal(calls,count);
  }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
