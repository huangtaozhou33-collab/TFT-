import { createHash } from 'node:crypto';
import { getPool } from './storage/repository.mjs';
import { articleContent, officialImage } from './patch-content.mjs';
import {readFile} from 'node:fs/promises';
import {patchCards,simplifiedArticle} from './patch-cards.mjs';
import {currentPatchIndex,refreshPatchIndex} from './patch-entities.mjs';
const entityIndex=readFile(new URL('../data/patch-entities.json',import.meta.url),'utf8').then(JSON.parse).catch(()=>({entities:[]}));
export const PATCH_SOURCES = ['zh-tw','en-us'].map(locale=>({locale,url:`https://teamfighttactics.leagueoflegends.com/${locale}/news/game-updates/`,name:locale==='zh-tw'?'Riot 官方繁中':'Riot 官方英文'}));
const hash=s=>createHash('sha256').update(s).digest('hex');
const json=x=>typeof x==='string'?JSON.parse(x):x;
export function plainText(s='') {
 return String(s).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div|\/tr)\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c<=0x10ffff?String.fromCodePoint(c):'';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[k])).replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
}
export function pageData(html) {
 const raw=html.match(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
 const page=raw&&JSON.parse(raw)?.props?.pageProps?.page;
 if(!Array.isArray(page?.blades))throw new Error('官方页面结构变化，未覆盖已有公告');
 return page;
}
export function patchLinks(html,source) {
 const items=pageData(html).blades.flatMap(b=>b.items||[]);
 const links=items.filter(x=>/\/teamfight-tactics-patch-\d+-\d+(?:-notes(?:-\d{4})?)?\/?$/.test(x.action?.payload?.url||'')).map(x=>({url:new URL(x.action.payload.url,source.url).href,locale:source.locale}));
 if(!links.length)throw new Error('官方列表未识别到版本公告，未视为没有更新');
 return [...new Map(links.map(x=>[x.url,x])).values()].slice(0,3);
}
export function parseArticle(html,{url,locale},now=Date.now()) {
 const p=pageData(html),head=p.blades.find(b=>b.type==='articleMasthead');
 const rich=p.blades.filter(b=>b.type==='patchNotesRichText').map(b=>b.richText?.body||'').join('\n');
 const body=plainText(rich);
 const patch=head?.title?.match(/\b\d{1,2}\.\d{1,2}[a-z]?\b/i)?.[0];
 if(!patch||!body||body.length<100||!Number.isFinite(Date.parse(head.publishDate)))throw new Error('公告内容或日期校验失败，未覆盖已有公告');
 const article={url,locale,patch,title:head.title,publishedAt:head.publishDate,summary:plainText(head.description?.body),body,
  contentVersion:2,cover:officialImage(head.banner?.url,head.title),content:articleContent(rich)};
 const contentHash=hash(JSON.stringify(article));return {...article,contentHash,id:hash(url+contentHash),fetchedAt:now};
}
async function fetchOfficial(url) {
 const u=new URL(url);if(u.origin!=='https://teamfighttactics.leagueoflegends.com')throw new Error('非官方公告地址');
 let r;try{r=await fetch(u,{signal:AbortSignal.timeout(20000),redirect:'error'});}catch(error){
  const code=error.cause?.code||error.code||error.name;
  const reason=['EAI_AGAIN','ENOTFOUND'].includes(code)?'官方域名解析失败':/TIMEOUT|Timeout/i.test(code)?'官方来源连接超时':'官方来源暂时无法连接';
  throw new Error(`${reason}（${code}）；已保存内容仍可查看`);
 }
 if(!r.ok)throw new Error(`官方来源 HTTP ${r.status}`);
 const text=await r.text();if(text.length>6000000)throw new Error('公告响应超过大小限制');return text;
}
const defaults=()=>({enabled:true,intervalHours:24,nextCheckAt:Date.now(),lastCheckedAt:null,lastSuccessAt:null,status:'not_checked',message:'尚未检查官方公告'});
async function stateOf(db){await db.execute('INSERT IGNORE INTO patch_monitor(id,state) VALUES(?,?)',['riot',JSON.stringify(defaults())]);const [[r]]=await db.execute('SELECT state FROM patch_monitor WHERE id=?',['riot']);return json(r.state);}
export async function patchNotes(db) {
 db??=await getPool();const state=await stateOf(db);
 const [rows]=await db.query('SELECT payload FROM patch_articles ORDER BY fetched_at DESC');
 const latest=[...new Map(rows.map(r=>json(r.payload)).reverse().map(a=>[a.url,a])).values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||b.locale.localeCompare(a.locale));
 const index=process.env.STORAGE_BACKEND==='mysql'?await currentPatchIndex(db):await entityIndex;
 return {sources:PATCH_SOURCES,state,articles:latest.map(a=>({...a,cards:patchCards(a,index),simplified:a.locale==='zh-tw'?simplifiedArticle(a):null})),note:'公告与统计、资料库分开发布；官方繁中与英文可能不同步。每次复查列表最近三篇，检测同页热修订；不会据公告自动修改当前数据补丁。'};
}
export async function savePatchSchedule(body) {
 if(typeof body.enabled!=='boolean'||!Number.isInteger(body.intervalHours)||body.intervalHours<1||body.intervalHours>168)throw Object.assign(new Error('检查周期须为 1～168 小时整数'),{status:400});
 const db=await getPool(),c=await db.getConnection();try{const [[l]]=await c.query("SELECT GET_LOCK('tft_patch_check',0) acquired");if(l.acquired!==1)throw Object.assign(new Error('公告检查中，请稍后保存'),{status:409});const s=await stateOf(c);await c.execute('UPDATE patch_monitor SET state=? WHERE id=?',[JSON.stringify({...s,enabled:body.enabled,intervalHours:body.intervalHours,nextCheckAt:Date.now()+body.intervalHours*3600000}),'riot']);}finally{await c.query("SELECT RELEASE_LOCK('tft_patch_check')");c.release();}return patchNotes();
}
export async function checkPatchNotes({fetchPage=fetchOfficial,dueOnly=false,db}={}) {
 db??=await getPool();const c=await db.getConnection();
 try {
  const [[l]]=await c.query("SELECT GET_LOCK('tft_patch_check',0) acquired");if(l.acquired!==1)throw Object.assign(new Error('公告检查正在运行'),{status:409});
  const s=await stateOf(c),now=Date.now();if(dueOnly&&(!s.enabled||s.nextCheckAt>now))return;
  if(!dueOnly&&s.lastCheckedAt&&now-s.lastCheckedAt<10000)throw Object.assign(new Error('刚刚检查过，请稍后再试'),{status:429});
  let added=0,revised=0,checked=0;const errors=[];let entityIndexState=s.entityIndexState||null;
  if(process.env.STORAGE_BACKEND==='mysql')try{entityIndexState=await refreshPatchIndex(c);}catch(e){entityIndexState={status:'failed',message:e.message};errors.push('实体图标索引：'+e.message);}
  for(const source of PATCH_SOURCES){try{
   const links=patchLinks(await fetchPage(source.url),source);
   for(const link of links){const a=parseArticle(await fetchPage(link.url.endsWith('/')?link.url:link.url+'/'),link);
    const [[old]]=await c.execute('SELECT content_hash FROM patch_articles WHERE url=? ORDER BY fetched_at DESC LIMIT 1',[a.url]);checked++;
    if(old?.content_hash===a.contentHash)continue;
    await c.execute('INSERT INTO patch_articles(id,url,locale,patch,title,published_at,fetched_at,content_hash,payload) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE fetched_at=VALUES(fetched_at),payload=VALUES(payload)',[a.id,a.url,a.locale,a.patch,a.title,a.publishedAt,a.fetchedAt,a.contentHash,JSON.stringify(a)]);
    if(old)revised++;else added++;
   }
  }catch(e){errors.push(`${source.name}：${e.message}`);}}
  if(added+revised>0&&entityIndexState?.status==='cached')try{entityIndexState=await refreshPatchIndex(c,{force:true});}catch(e){entityIndexState={status:'failed',message:e.message};errors.push('实体图标索引：'+e.message);}
  const status=errors.length?(checked?'partial':'failed'):(added+revised?'updated':'unchanged');s.entityIndexState=entityIndexState;
  const message=errors.length?`检查未完整成功；新增 ${added} 篇、修订 ${revised} 篇，保留已保存公告。`:added+revised?`已更新：新增 ${added} 篇公告、${revised} 篇正文修订。`:'没有更新：已检查的官方公告与本地一致。';
  await c.execute('UPDATE patch_monitor SET state=? WHERE id=?',[JSON.stringify({...s,lastCheckedAt:now,lastSuccessAt:errors.length?s.lastSuccessAt:Date.now(),nextCheckAt:Date.now()+s.intervalHours*3600000,status,message,checked,added,revised,errors}),'riot']);
 }finally{await c.query("SELECT RELEASE_LOCK('tft_patch_check')").catch(()=>{});c.release();}
 return patchNotes(db);
}
export function startPatchMonitor(){if(process.env.STORAGE_BACKEND!=='mysql')return;const tick=()=>checkPatchNotes({dueOnly:true}).catch(e=>console.error('版本公告检查未完成',e.status||'storage'));setTimeout(tick,12000).unref();setInterval(tick,60000).unref();}
