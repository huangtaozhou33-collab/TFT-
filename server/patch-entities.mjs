import {readFile} from 'node:fs/promises';
import {assetURL} from '../scripts/catalog-normalize.mjs';
import {getCatalog} from './data.mjs';
import {getSeasonMechanic} from './mechanics-data.mjs';
const fallback=()=>readFile(new URL('../data/patch-entities.json',import.meta.url),'utf8').then(JSON.parse);
const json=x=>typeof x==='string'?JSON.parse(x):x;
export function buildPatchIndex(catalog,raw){
 const sets=Object.fromEntries(Object.entries(raw).map(([locale,r])=>[locale,r.setData.find(s=>s.number===catalog.context.set&&s.mutator===catalog.context.mutator)]));
 if(Object.values(sets).some(s=>!s))throw Error('Patch entity locale set mismatch');
 const maps=Object.fromEntries(Object.entries(raw).map(([locale,r])=>[locale,new Map([...r.items,...sets[locale].champions,...sets[locale].traits].map(e=>[e.apiName,e]))]));
 const entities=new Map();
 function add(e,category){const id=e.id||e.apiName,cn=maps.zh_cn.get(id);if(!cn)return;const names=Object.fromEntries(Object.entries(maps).map(([locale,m])=>[locale,m.get(id)?.name]).filter(([,n])=>n));entities.set(id,{id,category,icon:e.id?e.icon:assetURL(e.icon,catalog.context.assetVersion),names,aliases:e.aliases||[],...(category==='wisps'?{familyId:id.replace(/_Prismatic$/,'').replace(/_?Upgrade(?=18$|$)/,''),variant:/_Prismatic$/.test(id)?'prismatic':/Upgrade/.test(id)?'upgraded':'base'}:{}),mappingSource:'exact_apiName'});}
 for(const key of ['champions','items','traits','augments'])for(const e of catalog[key]||[])add(e,key);
 // Catalog display filters can omit valid set traits and re-enabled augments.
 for(const e of sets.zh_cn.traits)if(!entities.has(e.apiName))add(e,'traits');
 const setIDs=new Set(sets.zh_cn.items);
 for(const e of raw.zh_cn.items){if(entities.has(e.apiName))continue;
  if(/\/wands\/set\d+_mechanicicon\.(tex|dds)$/i.test(e.icon||'')&&setIDs.has(e.apiName))add(e,'wisps');
  else if(e.isAugment&&(setIDs.has(e.apiName)||e.apiName.startsWith('DA_')))add(e,'augments');
 }
 for(const locale of Object.keys(raw))for(const e of raw[locale].items){
  if(!/(?:徽章|纹章| Emblem)$/.test(e.name||''))continue;
  for(const id of e.associatedTraits||[]){const trait=entities.get(id);if(trait?.category==='traits')trait.aliases.push(e.name.replace(/(?:徽章|纹章| Emblem)$/,'').trim());}
 }
 return {schemaVersion:2,set:catalog.context.set,assetVersion:catalog.context.assetVersion,checkedAt:Date.now(),entities:[...entities.values()]};
}
export async function currentPatchIndex(db){
 let index=await fallback();
 if(process.env.STORAGE_BACKEND==='mysql'){
  const [rows]=await db.execute('SELECT state FROM patch_monitor WHERE id=?',['entity-index']);if(rows[0])index=json(rows[0].state);
  const catalog=await getCatalog();if(index.set!==catalog.context.set||index.assetVersion!==catalog.context.assetVersion)return {entities:[],reason:'entity_index_version_mismatch'};
  const current=new Map(index.entities.map(e=>[e.id,{...e,names:{...e.names},aliases:[...(e.aliases||[])]}]));
  for(const category of ['champions','items','traits','augments'])for(const e of catalog[category]||[]){const old=current.get(e.id);if(old)current.set(e.id,{...old,icon:e.icon||old.icon,names:{...old.names,zh_cn:e.name},aliases:[...old.aliases,...(e.aliases||[])]});}
  const mechanics=await getSeasonMechanic({catalog});for(const e of mechanics.entries||[]){const old=current.get(e.id);current.set(e.id,{...old,id:e.id,category:'wisps',icon:e.icon||old?.icon,names:{...old?.names,...Object.fromEntries(Object.entries({zh_cn:e.name,en_us:e.nameEn,zh_tw:e.nameTraditional}).filter(([,v])=>v))},familyId:e.upgrade?.baseId||old?.familyId||e.id,variant:e.upgrade?.variant||old?.variant,aliases:[...(old?.aliases||[]),...Object.values(old?.names||{})].filter(Boolean)});}
  index={...index,entities:[...current.values()]};
 }
 return index;
}
export async function refreshPatchIndex(db,{force=false,fetcher=fetch}={}){
 const catalog=await getCatalog(),[rows]=await db.execute('SELECT state FROM patch_monitor WHERE id=?',['entity-index']);const old=rows[0]&&json(rows[0].state);
 if(!force&&old?.schemaVersion===2&&old?.set===catalog.context.set&&old?.assetVersion===catalog.context.assetVersion&&Date.now()-old.checkedAt<86400000)return {status:'cached',count:old.entities.length,checkedAt:old.checkedAt};
 const locales=['zh_cn','en_us','zh_tw'];const results=await Promise.all(locales.map(async locale=>{
  const url=`https://raw.communitydragon.org/${catalog.context.assetVersion}/cdragon/tft/${locale}.json`;const r=await fetcher(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error(`Asset locale ${locale}: HTTP ${r.status}`);return [locale,await r.json()];
 }));
 const index=buildPatchIndex(catalog,Object.fromEntries(results));if(index.entities.length<40)throw Error('Patch index coverage validation failed');
 await db.execute('INSERT INTO patch_monitor(id,state) VALUES(?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)',['entity-index',JSON.stringify(index)]);
 return {status:'updated',count:index.entities.length,checkedAt:index.checkedAt};
}
