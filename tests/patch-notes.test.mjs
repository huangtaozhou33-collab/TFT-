import test from 'node:test';
import assert from 'node:assert/strict';
import {plainText,pageData,patchLinks,parseArticle,PATCH_SOURCES,checkPatchNotes} from '../server/patch-notes.mjs';
const html=blades=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{page:{blades}}}})}</script>`;
const article=body=>html([{type:'articleMasthead',title:'TFT 18.4 版本更新',publishDate:'2026-10-06T18:00:00Z',description:{body:'官方简介'}},{type:'patchNotesRichText',richText:{body}}]);
test('list excludes videos and links only latest patch articles',()=>{
 const x=html([{items:[{action:{payload:{url:'/zh-tw/news/game-updates/teamfight-tactics-patch-18-4'}}},{action:{payload:{url:'/zh-tw/news/game-updates/patch-rundown'}}}]}]);
 assert.equal(patchLinks(x,PATCH_SOURCES[0]).length,1);
 assert.throws(()=>patchLinks(html([]),PATCH_SOURCES[0]));assert.throws(()=>pageData('<html>blocked</html>'));
});
test('content hash detects hotfix within same patch; fetch time and site shell do not change hash',()=>{
 const ref={url:PATCH_SOURCES[0].url+'teamfight-tactics-patch-18-4',locale:'zh-tw'},body='<h2>英雄</h2><p>'+('调整说明。'.repeat(50))+'</p>';
 const a=parseArticle(article(body),ref,1),b=parseArticle(article(body),ref,2),c=parseArticle(article(body+'<p>B补丁修正</p>'),ref,3);
 assert.equal(a.contentHash,b.contentHash);assert.notEqual(a.contentHash,c.contentHash);assert.equal(c.patch,'18.4');
 assert.throws(()=>parseArticle(article('空'),ref));
});
test('announcement text is plain text, never executable markup',()=>{
 assert.equal(plainText('<script>bad()</script><p>攻速 &amp; 法力</p><img src=x onerror=bad()>'),'攻速 & 法力');
});
test('new announcement ingestion generates cards; changed content revises; unchanged is idempotent',async()=>{
 const db=memoryDb();let damage=10;
 const fetchPage=async url=>url.endsWith('/game-updates/')?html([{items:[{action:{payload:{url:url+'teamfight-tactics-patch-18-4'}}}]}]):article('<h2>大型改動</h2><h4>單位</h4><ul><li>測試英雄<ul><li>傷害：'+damage+' ⇒ 12</li></ul></li></ul><p>'+('完整公告内容。'.repeat(30))+'</p>');
 let r=await checkPatchNotes({db,fetchPage});assert.equal(r.state.added,2);assert.equal(r.articles[0].cards.champions.length,1);
 await db.execute('UPDATE patch_monitor SET state=?',[JSON.stringify({...r.state,lastCheckedAt:0})]);
 r=await checkPatchNotes({db,fetchPage});assert.equal(r.state.status,'unchanged');assert.equal(r.state.revised,0);
 damage=9;await db.execute('UPDATE patch_monitor SET state=?',[JSON.stringify({...r.state,lastCheckedAt:0})]);
 r=await checkPatchNotes({db,fetchPage});assert.equal(r.state.revised,2);assert.match(r.articles[0].cards.champions[0].body,/9 ⇒ 12/);
});

function memoryDb(saved=[]){
 let state={enabled:true,intervalHours:24,nextCheckAt:0,lastCheckedAt:null,lastSuccessAt:123},rows=[...saved];
 return {async getConnection(){return this;},release(){},async query(sql){
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.includes('RELEASE_LOCK'))return [[{}]];
  if(sql.includes('SELECT payload'))return [rows.slice().sort((a,b)=>b.fetchedAt-a.fetchedAt).map(payload=>({payload}))];
  throw new Error(sql);
 },async execute(sql,args){
  if(sql.startsWith('INSERT IGNORE INTO patch_monitor'))return [[]];
  if(sql.startsWith('SELECT state'))return [[{state}]];
  if(sql.startsWith('UPDATE patch_monitor')){state=JSON.parse(args[0]);return [[]];}
  if(sql.startsWith('SELECT content_hash'))return [rows.filter(r=>r.url===args[0]).sort((a,b)=>b.fetchedAt-a.fetchedAt).slice(0,1).map(r=>({content_hash:r.contentHash}))];
  if(sql.startsWith('INSERT INTO patch_articles')){const a=JSON.parse(args[8]);rows=rows.filter(r=>r.id!==a.id);rows.push(a);return [[]];}
  throw new Error(sql);
 }};
}
test('upstream failure retains saved articles and never reports unchanged',async()=>{
 const saved={id:'saved',url:'official',publishedAt:'2026-10-06',locale:'zh-tw',body:'已有正文',fetchedAt:1};
 const result=await checkPatchNotes({db:memoryDb([saved]),fetchPage:async()=>{throw new Error('HTTP 503');}});
 assert.equal(result.state.status,'failed');assert.equal(result.state.errors.length,2);assert.equal(result.state.lastSuccessAt,123);
 assert.equal(result.articles.length,1);for(const [key,value] of Object.entries(saved))assert.deepEqual(result.articles[0][key],value);assert.ok(!result.state.message.includes('没有更新'));
});
test('unchanged content and disabled scheduling do not publish new revisions',async()=>{
 const content=article('<p>'+('完整说明。'.repeat(40))+'</p>');
 const refs=PATCH_SOURCES.map(s=>({url:s.url+'teamfight-tactics-patch-18-4',locale:s.locale}));
 const saved=refs.map(r=>parseArticle(content,r,1));const db=memoryDb(saved);
 const result=await checkPatchNotes({db,fetchPage:async url=>url.endsWith('/game-updates/')?html([{items:[{action:{payload:{url:url+'teamfight-tactics-patch-18-4'}}}]}]):content});
 assert.equal(result.state.status,'unchanged');assert.equal(result.state.added,0);assert.equal(result.state.revised,0);assert.equal(result.articles.length,2);
 assert.ok(result.articles.every(a=>a.fetchedAt===1));
 await db.execute('UPDATE patch_monitor SET state=?',[JSON.stringify({...result.state,enabled:false,nextCheckAt:0})]);
 let requests=0;await checkPatchNotes({db,dueOnly:true,fetchPage:async()=>{requests++;}});assert.equal(requests,0);
});
