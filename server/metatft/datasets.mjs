import { rankScope, DEFAULT_RANK } from '../../public/stat-ranks.js';
import { sha256, stableJSON, cacheContext } from '../../scripts/stats-cache.mjs';
import { getActiveRelease } from '../storage/repository.mjs';
import { getMetaTftMetadata, readMetaTft, metaError } from './client.mjs';
import { metaScope, metaParams, checkMetaScope, metaEvidence } from './scope.mjs';
import { metaStats, normalizeMetaRows } from './query.mjs';
import { findDataset, saveDataset, readDatasetRows, datasetInventory } from './dataset-repository.mjs';

const inFlight = new Map();
const invalid = () => metaError('MetaTFT 统计格式发生变化，未将异常数据当成零样本。', 'METATFT_RESPONSE_INVALID');
function checked(response, scope) {
  checkMetaScope(response.data, scope);
  if (!Array.isArray(response.data.data) || response.data.data.length > 20000) throw invalid();
  for (const row of response.data.data) metaStats(row.placement_count);
  return response.data.data;
}
function wrap(row, dimension, entityId, sourceKey, placementCount) {
  return { ...row, dimension, entityId, rowKey:sha256(`${dimension}:${sourceKey}`), sourceKey, placementCount };
}
function traitTier(key, catalog) {
  const match = key?.match(/^(.+)_(\d+)$/);
  if (!match) return null;
  const trait=catalog.traits.find(t=>t.id===match[1]), tier=Number(match[2]), effect=trait?.effects?.[tier-1];
  if (!trait || !effect || !Number.isSafeInteger(effect.minUnits) || effect.minUnits<1) return null;
  return { id:key, traitId:trait.id, name:trait.name, icon:trait.icon, tier, minUnits:effect.minUnits, style:effect.style };
}
export function normalizeMetaOverall(responses, scope, catalog) {
  const totals=checked(responses.total,scope);
  if (totals.length!==1) throw invalid();
  const total=metaStats(totals[0].placement_count).sampleSize;
  const rows=[], skipped={}, sourceRows={};
  for(const [dimension,key,entities] of [['units','units_unique',catalog.champions],['items','items_unique',catalog.items],['traits','traits',catalog.traits]]) {
    const raw=checked(responses[dimension],scope); sourceRows[dimension]=raw.length; skipped[dimension]=[];
    const seen=new Set();
    for(const source of raw) {
      const sourceKey=source[key];
      if (sourceKey===null) continue; // explicit source bucket for absent entities
      if (typeof sourceKey!=='string') throw invalid();
      const stats=metaStats(source.placement_count);
      if(!stats.sampleSize) continue;
      let row, entityId;
      if(dimension==='traits') {
        row=traitTier(sourceKey,catalog); entityId=row?.traitId;
        if(!row){skipped[dimension].push(sourceKey);continue;}
      } else {
        const match=sourceKey.match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/);
        if(!match) throw invalid();
        if(match[2]!=='1') continue; // 2nd/3rd occurrences overlap, and are not star levels
        entityId=match[1]; const entity=entities.find(e=>e.id===entityId);
        if(!entity){skipped[dimension].push(sourceKey);continue;}
        row={id:entityId,name:entity.name,icon:entity.icon,...(dimension==='units'?{cost:entity.cost,traits:entity.traits,topItems:[]}:{kind:entity.kind,category:entity.category})};
      }
      if(seen.has(sourceKey)) throw invalid(); seen.add(sourceKey);
      // Total is fetched independently; do not invent a pick rate if snapshots advanced.
      const pickRate=total>=stats.sampleSize && total>0 ? stats.sampleSize/total : null;
      rows.push(wrap({...row,stats:{...stats,pickRate}},dimension,entityId,sourceKey,source.placement_count));
    }
  }
  return { rows, summary:{total,sourceRows,skipped,exhaustive:false,metric:'first_occurrence_per_board'} };
}

export function normalizeMetaComps(responses, scope, catalog) {
  const definitions=responses.definitions.data, statistics=responses.statistics.data;
  checkMetaScope(statistics,scope);
  if (definitions.tft_set!==`TFTSet${scope.season}` || statistics.tft_set!==definitions.tft_set || definitions.queue_id!==scope.queue || statistics.queue_id!==scope.queue || definitions.cluster_id!==statistics.cluster_id || definitions.results?.data?.cluster_id!==definitions.cluster_id) throw metaError('MetaTFT 阵容目录与统计批次不一致，请重试。','METATFT_CLUSTER_MISMATCH');
  const clusters=definitions.results?.data?.cluster_details;
  if(!clusters || typeof clusters!=='object' || Array.isArray(clusters) || !Array.isArray(statistics.results)) throw invalid();
  const total=statistics.results.find(r=>r.cluster==='')?.places?.[0];
  if(!Number.isSafeInteger(total)||total<1) throw invalid();
  const heroes=new Map(catalog.champions.map(h=>[h.id,h])), items=new Map(catalog.items.map(i=>[i.id,i])), traits=new Map(catalog.traits.map(t=>[t.id,t]));
  const rows=[], skipped=[], seen=new Set();
  for(const source of statistics.results) {
    if(source.cluster==='' || source.cluster==='-1')continue;
    const key=String(source.cluster), template=clusters[key];
    if(seen.has(key))throw invalid();seen.add(key);
    if(!Array.isArray(source.places)||source.places.length!==9)throw invalid();
    const histogram=source.places.slice(0,8), stats=metaStats(histogram);
    if(stats.sampleSize!==source.places[8] || stats.sampleSize!==source.count || stats.sampleSize>total)throw invalid();
    if(!stats.sampleSize)continue;
    if(!template || typeof template.units_string!=='string'){skipped.push(key);continue;}
    const ids=template.units_string.split(/,\s*/);
    if(!ids.length || ids.some(id=>!heroes.has(id))){skipped.push(key);continue;}
    const buildMap=new Map();
    for(const b of template.builds||[]) if(ids.includes(b.unit)&&Array.isArray(b.buildName)&&b.buildName.length<=3&&b.buildName.every(id=>items.has(id))&&!buildMap.has(b.unit))buildMap.set(b.unit,b.buildName);
    const cores=new Set((template.name||[]).filter(part=>part.type==='unit').map(part=>part.name));
    const units=ids.map(id=>{const h=heroes.get(id);return {id,name:h.name,cost:h.cost,icon:h.icon,items:buildMap.get(id)||[],isCore:cores.has(id),star:null,cell:null};});
    const name=(template.name||[]).map(part=>part.type==='unit'?heroes.get(part.name)?.name:traits.get(part.name)?.name).filter(Boolean).join(' · ')||units.map(u=>u.name).slice(0,2).join(' · ');
    const sourceTraits=String(template.traits_string||'').split(/,\s*/).map(key=>traitTier(key,catalog)).filter(Boolean).map(t=>({id:t.traitId,name:t.name,count:t.minUnits,tier:t.tier,style:t.style,countMeaning:'source_trait_tier_threshold'}));
    rows.push(wrap({id:`metatft:cluster:${key}`,name,teamCode:null,units,traits:sourceTraits,stages:[],stats:{...stats,pickRate:stats.sampleSize/total},
      statisticsKind:'comp_cluster',clusterId:definitions.cluster_id,sourceCluster:key,
      templateEvidence:{endpoint:responses.definitions.url,fetchedAt:responses.definitions.fetchedAt,sourceTime:new Date(definitions.updated).toISOString(),sourcePatch:null,scope:'source_default_template',equipment:'independent_source_build_examples',positioning:'not_provided'},
      note:'指标统计该阵容体系的不同变体；棋子与装备来自来源代表配置，未统计整套固定装备或站位的联合胜率。代表配置的采样范围由来源决定，不能当作当前筛选结果。'},'comps',key,key,histogram));
  }
  rows.sort((a,b)=>b.stats.sampleSize-a.stats.sampleSize);
  return { rows, summary:{total,sourceRows:statistics.results.length-1,skipped,clusterId:definitions.cluster_id,sourceTime:new Date(statistics.updated).toISOString(),exhaustive:false,metric:'comp_cluster'} };
}

export function normalizeMetaDetail(response, scope, catalog) {
  const raw=checked(response,scope), build=scope.kind==='builds';
  const plan={scope:{...scope,conditions:[],carrierId:build?scope.entityId:null,focusItemId:build?null:scope.entityId},holders:!build};
  const normalized=normalizeMetaRows(build?'equipment':'teammates',raw,plan,catalog);
  const rows=[],skipped=[];
  for(const row of normalized) {
    const hero=catalog.champions.find(h=>h.id===row.championId);
    if(!hero || (row.itemIds||[]).some(id=>!catalog.items.some(item=>item.id===id))){skipped.push(row.sourceKey);continue;}
    const payload=build?{championId:hero.id,championName:hero.name,itemIds:row.itemIds,items:row.itemIds.map(id=>{const item=catalog.items.find(i=>i.id===id);return {id,name:item.name,icon:item.icon};})}
      :{championId:hero.id,id:hero.id,name:hero.name,cost:hero.cost,icon:hero.icon,itemId:scope.entityId};
    rows.push(wrap({...payload,stats:{...row.stats,pickRate:null}},scope.kind,hero.id,row.sourceKey,row.placementCount));
  }
  return {rows,summary:{sourceRows:raw.length,skipped,exhaustive:false,metric:build?'observed_three_item_build':'item_holder_first_occurrence'}};
}

async function collect(scope, key, release, metadata, catalog, deps) {
  const read=deps.readMetaTft||readMetaTft, responses={}, params=metaParams(scope);
  let normalized;
  if(scope.kind==='overall') {
    await Promise.all([['total','total'],['units','units_unique'],['items','items_unique'],['traits','traits']].map(async([k,path])=>{responses[k]=await read(`/tft-explorer-api/${path}?${params}`);}));
    normalized=normalizeMetaOverall(responses,scope,catalog);
  } else if(scope.kind==='comps') {
    responses.definitions=await read(`/tft-comps-api/comps_data?queue=${scope.queue}`);
    const cluster=responses.definitions.data.cluster_id;
    if(!Number.isSafeInteger(cluster))throw invalid();
    params.set('cluster_id',String(cluster));
    responses.statistics=await read(`/tft-comps-api/comps_stats?${params}`);
    normalized=normalizeMetaComps(responses,scope,catalog);
  } else {
    const build=scope.kind==='builds';
    params.append(build?'unit_unique':'item_unique',`${scope.entityId}-1`);
    responses.rows=await read(`/tft-explorer-api/${build?'unit_builds/'+scope.entityId:'item_units_unique/'+scope.entityId+'-1'}?${params}`);
    normalized=normalizeMetaDetail(responses.rows,scope,catalog);
  }
  const rawResponseText=stableJSON(Object.fromEntries(Object.entries(responses).map(([k,{data,...r}])=>[k,r]))), contentHash=sha256(rawResponseText), capturedAt=Date.now();
  normalized.summary.semanticHash=sha256(stableJSON(Object.fromEntries(Object.entries(responses).map(([k,r])=>[k,r.data]))));
  const previous=deps.force?await(deps.findDataset||findDataset)(release.id,key):null;
  if(previous?.summary.semanticHash===normalized.summary.semanticHash){
    const expiresAt=capturedAt+(deps.ttlMs||24*60*60*1000);
    if(deps.touchDataset)await deps.touchDataset(previous.id,expiresAt);
    else {const {getPool}=await import('../storage/repository.mjs');await(await getPool()).execute('UPDATE metatft_datasets SET expires_at=? WHERE id=?',[expiresAt,previous.id]);}
    return {...previous,expiresAt,unchanged:true};
  }
  const snapshot={id:sha256(`${key}:${contentHash}:${capturedAt}`),key,release,scope,metadata,rawResponseText,contentHash,capturedAt,expiresAt:capturedAt+(deps.ttlMs||24*60*60*1000),...normalized};
  snapshot.summary.rowCount=snapshot.rows.length;
  await (deps.saveDataset||saveDataset)(snapshot);
  return snapshot;
}
export async function loadMetaDataset(kind, entityId, catalog, deps={}) {
  if(!['overall','comps','builds','holders'].includes(kind))throw invalid();
  if(kind==='builds'&&!catalog.champions.some(h=>h.id===entityId)||kind==='holders'&&!catalog.items.some(i=>i.id===entityId)) throw metaError('所选实体不在当前赛季资料中。','INVALID_STAT_ENTITY',400);
  const release=await (deps.getActiveRelease||getActiveRelease)();
  if(!release)throw metaError('数据库尚未发布当前资料。','DATA_NOT_IMPORTED');
  if(catalog.context.set!==release.season)throw metaError('资料目录与当前发布赛季不同，请重试。','METATFT_VERSION_MISMATCH');
  const metadata=await (deps.getMetaTftMetadata||getMetaTftMetadata)(), scope={adapterVersion:kind==='overall'?2:1,kind,entityId:entityId||'',...metaScope(release,metadata,deps)};
  const key=sha256(stableJSON({releaseId:release.id,...scope}));
  let snapshot=deps.force ? null : await (deps.findDataset||findDataset)(release.id,key), cacheHit=Boolean(snapshot);
  if(!snapshot){
    if(!inFlight.has(key))inFlight.set(key,collect(scope,key,release,metadata,catalog,deps).finally(()=>inFlight.delete(key)));
    snapshot=await inFlight.get(key);
  }
  const rows=await (deps.readDatasetRows||readDatasetRows)(snapshot.id);
  const evidence={...metaEvidence(snapshot,kind==='comps'?'MetaTFT Comps':'MetaTFT Explorer'),...(snapshot.summary.sourceTime?{sourceTime:snapshot.summary.sourceTime}:{}),
    statisticsKind:snapshot.summary.metric,sourceReturnedRows:snapshot.summary.sourceRows,exhaustive:false};
  evidence.stale=Date.now()>snapshot.expiresAt;
  evidence.freshness=evidence.stale?'旧快照：后台检查尚未成功更新，保留上次数据。':'当前本地快照';
  return {snapshot,cacheHit,unchanged:Boolean(snapshot.unchanged),evidence,rows:rows.map(row=>({...row,evidence:{...evidence,...(row.note?{note:row.note}:{})}}))};
}

export async function getMetaOverall(catalog, options={}) {
  const {snapshot,evidence,rows}=await loadMetaDataset('overall','',catalog,options);
  const champions=rows.filter(r=>r.dimension==='units'),items=rows.filter(r=>r.dimension==='items'),traits=rows.filter(r=>r.dimension==='traits');
  return {status:'live',delivery:'mysql',context:cacheContext(catalog),cacheKey:snapshot.id,champions,items,traits,
    evidence:{...evidence,sources:[{id:'units',...evidence},{id:'items',...evidence}],sourceTotalEntries:snapshot.summary.total},
    coverage:{champions:champions.length,items:items.length,traits:traits.length,totalChampions:catalog.champions.length,totalItems:catalog.items.length,excluded:snapshot.summary.skipped},
    capabilities:{championOverallStats:true,itemOverallStats:true,traitStats:true,rankFilters:true,rankRegionFilters:false}};
}
export async function getMetaTraits(catalog, options={}) {
  const overall=await getMetaOverall(catalog, options);
  return {...overall,data:overall.traits,coverage:{cachedTraits:new Set(overall.traits.map(t=>t.traitId)).size,totalTraits:catalog.traits.length},note:'来源羁绊档位统计，样本不与棋子或装备记录相加。'};
}
export async function getMetaCompDecks(catalog, options={}) {
  const {snapshot,evidence,rows}=await loadMetaDataset('comps','',catalog,options);
  return {status:rows.length?'live':'unavailable',delivery:'mysql',data:rows.sort((a,b)=>b.stats.sampleSize-a.stats.sampleSize),evidence:{...evidence,populationDenominator:snapshot.summary.total},reason:rows.length?null:'MetaTFT 当前范围没有可展示的阵容体系。'};
}
export async function getMetaDetail(kind, entityId, catalog, options={}) {
  const {snapshot,evidence,rows}=await loadMetaDataset(kind,entityId,catalog,options);
  return {status:rows.length?'live':'empty',delivery:'mysql',data:rows.sort((a,b)=>a.stats.avgPlacement-b.stats.avgPlacement||b.stats.sampleSize-a.stats.sampleSize),evidence,
    coverage:{sourceReturnedRows:snapshot.summary.sourceRows,acceptedRows:rows.length,excluded:snapshot.summary.skipped,exhaustive:false},
    reason:rows.length?null:'MetaTFT 当前补丁和样本范围内没有对应记录；未改用其他来源。'};
}
export async function getMetaOverview(catalog, options={}) {
  const [overall,comps]=await Promise.all([getMetaOverall(catalog, options),getMetaCompDecks(catalog, options)]);
  const inventory=await datasetInventory(overall.evidence.releaseId,{patch:overall.evidence.requestedPatch.replace(/[a-z]+$/,''),bPatch:overall.evidence.requestedPatch.match(/[a-z]+$/)?.[0]||'',ranks:rankScope(options.rank ?? DEFAULT_RANK)});
  const entries=(entities,kind)=>entities.map(e=>{const record=inventory.get(`${kind}:${e.id}`);return {id:e.id,name:e.name,cost:e.cost,category:e.category,available:true,cached:Boolean(record),rowCount:record?.summary.rowCount||0};});
  const champions=entries(catalog.champions,'builds'),items=entries(catalog.items,'holders');
  return {status:'ready',source:'metatft',delivery:'mysql',cacheKey:overall.cacheKey,context:cacheContext(catalog),fetchedAt:overall.evidence.fetchedAt,evidence:overall.evidence,champions,items,
    coverage:{decks:comps.data.length,championBuilds:{cached:champions.filter(x=>x.cached).length,total:champions.length},itemHolders:{cached:items.filter(x=>x.cached).length,total:items.length},
      itemCategories:Object.fromEntries(['core','radiant','artifact','emblem','component'].map(category=>[category,{cached:items.filter(x=>x.cached&&x.category===category).length,total:items.filter(x=>x.category===category).length}])),emblemHolders:{cached:items.filter(x=>x.cached&&x.category==='emblem').length,total:items.filter(x=>x.category==='emblem').length},traitStats:{status:'live',cached:new Set(overall.traits.map(t=>t.traitId)).size,total:catalog.traits.length,rowCount:overall.traits.length,delivery:'mysql'},overallStats:{status:'live',champions:overall.champions.length,items:overall.items.length,delivery:'mysql'},catalogueComplete:champions.every(x=>x.cached)&&items.every(x=>x.cached),complete:false},
    capabilities:{deckStats:true,championBuildStats:true,itemHolderStats:true,championOverallStats:true,itemOverallStats:true,traitStats:true,augmentStats:false,rankFilters:true,rankRegionFilters:false},
    note:'统计统一使用 MetaTFT。全目录出装与携带者按段位分别采集入库；未返回的实体和组合保持缺项。近 3 天普通排位，各接口更新时间可能不同；目录采集完成不代表全部可能出装组合均有来源记录。'};
}
