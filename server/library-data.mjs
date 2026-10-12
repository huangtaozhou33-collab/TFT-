import { readFile } from 'node:fs/promises';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';
import { getCatalog } from './data.mjs';

export const LIBRARY_DIR = new URL('../data/library/', import.meta.url);
export const LIBRARY_CATEGORIES = [
  { id: 'system', name: '系统规则与概率', icon: '▦', description: '商店、卡池、奇遇、掉落与玩家伤害' },
  { id: 'augment', name: '海克斯奖励与交互', icon: '✧', description: '已并入对应海克斯详情' },
  { id: 'trait', name: '羁绊机制细则', icon: '⌘', description: '兑现奖励、特殊商店、献祭与形态' },
  { id: 'wisp', name: '法杖详细效果', icon: '❋', description: '属性、装备叠层与临时药水' },
  { id: 'reference', name: '实用速查', icon: '◷', description: '纹章、PvE、日程与通用参考' }
];
export function libraryEntityFingerprint(catalog) {
  return sha256(Object.fromEntries(['champions','items','traits','augments'].map(type=>[type,catalog[type].map(({id,name})=>({id,name})).sort((a,b)=>a.id.localeCompare(b.id))])));
}
export function parseReferenceCSV(text) {
  const rows = []; let row = [], value = '', quoted = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i=0;i<text.length;i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i+1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(value); value=''; }
    else if ((char === '\r' || char === '\n') && !quoted) { if (char==='\r' && text[i+1]==='\n') i++; row.push(value); if(row.some(Boolean)) rows.push(row); row=[]; value=''; }
    else value += char;
  }
  if (quoted) throw new Error('Unterminated reference CSV field.');
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers=rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length) throw new Error('Duplicate or missing reference CSV headers.');
  return rows.map(values=>{ if(values.length !== headers.length) throw new Error('Reference CSV row width mismatch.'); return Object.fromEntries(headers.map((header,i)=>[header,values[i]])); });
}
const recorded = date => typeof date==='string' && Number.isFinite(Date.parse(date));
const validHash = hash => /^[a-f0-9]{64}$/.test(hash ?? '');
export function validateLibrary(payload, catalog) {
  const errors=[];
  if(payload?.schemaVersion!==1 || payload.cacheKey!==cacheKeyFor(catalog) || stableJSON(payload.context)!==stableJSON(cacheContext(catalog)) || payload.entityFingerprint!==libraryEntityFingerprint(catalog)) errors.push('资料库版本或实体指纹不匹配');
  if(!Array.isArray(payload?.documents) || !payload.documents.length || !Array.isArray(payload?.augmentRules)) return {valid:false,errors:[...errors,'资料库结构不完整']};
  const ids=new Set();
  for(const doc of payload.documents) {
    if(!doc || !Array.isArray(doc.entities) || !Array.isArray(doc.aliases) || !doc.rules?.every(rule=>typeof rule==='string')) {errors.push('资料结构损坏');continue;}
    if(!/^[a-z0-9-]+$/.test(doc.id) || ids.has(doc.id)) errors.push(`资料身份无效：${doc.id}`); ids.add(doc.id);
    if(!LIBRARY_CATEGORIES.some(category=>category.id===doc.category) || doc.set!==catalog.context.set || !doc.title || !Array.isArray(doc.rules) || !Array.isArray(doc.tables)) errors.push(`资料字段无效：${doc.id}`);
    if(!doc.source?.url?.startsWith('https://www.littlebuddybot.com/') || !recorded(doc.source?.fetchedAt) || !validHash(doc.source?.sha256)) errors.push(`来源证据缺失：${doc.id}`);
    if(doc.retrievalEligible && (doc.sourcePatch!=='18.4' || doc.reviewStatus!=='reviewed' || doc.conflicts?.length)) errors.push(`未核验的条目不能用于当前数值问答：${doc.id}`);
    for(const ref of doc.entities ?? []) if(ref.type!=='wisps' && !catalog[ref.type]?.some(entity=>entity.id===ref.id)) errors.push(`实体未映射：${doc.id}/${ref.id}`);
    for(const asset of doc.source.assets ?? []) if(!asset.url?.startsWith('https://assets.zyrosite.com/') || !validHash(asset.sha256)) errors.push(`原图证据缺失：${doc.id}`);
    for(const t of doc.tables) {
      if(!Array.isArray(t.columns) || !t.columns.length || !Array.isArray(t.rows)) { errors.push(`表格结构无效：${doc.id}`); continue; }
      for(const row of t.rows) if(!Array.isArray(row.cells) || row.cells.length!==t.columns.length || row.cells.some(cell=>!['string','number'].includes(typeof cell)) || row.probability!=null && (!Number.isFinite(row.probability)||row.probability<0||row.probability>1)) errors.push(`表格单元格或概率无效：${doc.id}`);
      if(t.exhaustive) {
        const groups=Object.groupBy(t.rows.filter(row=>row.probability!=null),row=>row.condition || t.condition);
        for(const rows of Object.values(groups)) if(Math.abs(rows.reduce((sum,row)=>sum+row.probability,0)-1)>0.00001 && !doc.probabilitiesRounded) errors.push(`完整奖励分支概率和异常：${doc.id}`);
      }
    }
  }
  const ruleIds=new Set();
  for(const rule of payload.augmentRules) {
    if(ruleIds.has(rule.id) || !catalog.augments.some(entity=>entity.id===rule.id) || !Array.isArray(rule.stages) || rule.stages.some(stage=>![2,3,4].includes(stage)) || !Array.isArray(rule.conditionsZh) || !Array.isArray(rule.exclusions) || rule.sourcePatch!=='18.4') errors.push(`强化规则无效：${rule.id}`);
    ruleIds.add(rule.id);
  }
  for(const row of payload.catalogTranslations ?? []) if(!catalog.augments.some(entity=>entity.id===row.id)||typeof row.descriptionZh!=='string') errors.push('目录中文译文未映射');
  if(!validHash(payload.rulesSource?.sha256) || !recorded(payload.rulesSource?.fetchedAt)) errors.push('强化CSV来源缺失');
  return {valid:errors.length===0,errors};
}
export async function readLibrarySnapshot(catalog, dir=LIBRARY_DIR) {
  try {
    const base=new URL(`${cacheKeyFor(catalog)}/`,dir);
    const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
    if(manifest.schemaVersion!==1 || manifest.cacheKey!==cacheKeyFor(catalog) || stableJSON(manifest.context)!==stableJSON(cacheContext(catalog)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(manifest.releaseId ?? '') || manifest.file!==`${manifest.releaseId}.json` || !validHash(manifest.sha256) || !recorded(manifest.publishedAt)) return null;
    const text=await readFile(new URL(manifest.file,base),'utf8');
    if(sha256(text)!==manifest.sha256) return null;
    const payload=JSON.parse(text), validation=validateLibrary(payload,catalog);
    return validation.valid ? {payload,manifest,validation} : null;
  } catch { return null; }
}
export async function getLibrarySnapshot({catalog,dir=LIBRARY_DIR}={}) {
  const { readDatabaseSnapshot } = await import('./storage/runtime.mjs');
  const stored = await readDatabaseSnapshot('library');
  if (stored !== undefined) return stored;
  catalog ??= await getCatalog();
  const pack=await readLibrarySnapshot(catalog,dir);
  if(!pack) return {status:'not_cached',delivery:'version_cache',context:cacheContext(catalog),categories:LIBRARY_CATEGORIES,documents:[],augmentRules:[],reason:'当前版本中文机制资料尚未发布，或校验未通过。'};
  const {payload,manifest}=pack;
  return {...payload,status:'ready',delivery:'version_cache',releaseId:manifest.releaseId,publishedAt:manifest.publishedAt,categories:LIBRARY_CATEGORIES,
    coverage:{documents:payload.documents.length,tables:payload.documents.reduce((sum,doc)=>sum+doc.tables.length,0),rows:payload.documents.reduce((sum,doc)=>sum+doc.tables.reduce((n,t)=>n+t.rows.length,0),0),augmentRules:payload.augmentRules.length,totalAugments:catalog.augments.length,byCategory:Object.fromEntries(LIBRARY_CATEGORIES.map(category=>[category.id,payload.documents.filter(doc=>doc.category===category.id).length]))}};
}
const normalize = value=>String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
export function matchingLibraryDocuments(snapshot,{id,entityId,query=''}={}) {
  if(id) return snapshot.documents.filter(doc=>doc.id===id);
  if(entityId) return snapshot.documents.filter(doc=>doc.entities.some(ref=>ref.id===entityId));
  const text=normalize(query); if(!text) return [];
  const scored=snapshot.documents.map(doc=>({doc,score:Math.max(...[doc.title.split(' · ')[0],...doc.aliases].filter(Boolean).map(alias=>{const key=normalize(alias); return text.includes(key)?key.length:key.includes(text)&&text.length>=2?text.length:0;}),0)}));
  return scored.filter(row=>row.score>0).sort((a,b)=>b.score-a.score).map(row=>row.doc);
}
export async function getLibraryKnowledge({id,entityId,query='',catalog,dir=LIBRARY_DIR}={}) {
  query=typeof query==='string'?query.slice(0,6000):'';
  const snapshot=await getLibrarySnapshot({catalog,dir});
  const documents=matchingLibraryDocuments(snapshot,{id,entityId,query});
  const text=normalize(query),relatedIds=new Set(documents.flatMap(doc=>doc.entities.filter(ref=>ref.type==='augments').map(ref=>ref.id)));
  const rules=snapshot.augmentRules.filter(rule=>entityId?rule.id===entityId:relatedIds.has(rule.id) || Boolean(text&&((rule.name&&text.includes(normalize(rule.name))) || (rule.nameOriginal&&text.includes(normalize(rule.nameOriginal))))));
  const data=documents.slice(0,3).map(doc=>{
    if(!doc.retrievalEligible) return {id:doc.id,title:doc.title,source:doc.source,sourcePatch:doc.sourcePatch,reviewStatus:doc.reviewStatus,retrievalEligible:false,reason:doc.conflicts?.join('；') || `此资料的来源补丁未核验为当前${snapshot.retrievalPatch||'18.4'}，仅供前端参考。`};
    const n=doc.id==='trait-ladder' ? query.match(/(\d{1,2})\s*(?:个|种)?\s*(?:非独特)?羁绊/)?.[1] : null;
    return {...doc,tables:doc.tables.map(t=>({...t,rows:n?t.rows.filter(row=>row.cells[0]===`${n}种`):t.rows})),source:doc.source};
  });
  return {status:snapshot.status,context:snapshot.context,releaseId:snapshot.releaseId,data,augmentRules:rules.slice(0,4),rulesSource:snapshot.rulesSource,
    matchedDocuments:documents.length,truncated:documents.length>3||rules.length>4,note:'规则概率与奖励数量属于来源机制表；不等于胜率。被标为参考或存在冲突的资料不提供当前数值结论。'};
}
