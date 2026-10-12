import { createHash } from 'node:crypto';
import { getActiveRelease,eligibleChunks,getIndexJob } from '../storage/repository.mjs';
import { isDatabaseMode,withLocalSnapshots,cacheGet,cacheSet } from '../storage/runtime.mjs';
import { storageConfig } from '../storage/config.mjs';
import { indexProfile,embeddingReady,embedTexts,MilvusClient } from './vector.mjs';
import { buildKnowledgeBundle } from './bundle.mjs';
import { isGeneralGlossary, knowledgeInScope } from './scope.mjs';
import { matchGlossaryMentions } from '../../public/glossary-matching.js';

const norm=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const hasTerm=(text,term)=>/^\d+$/.test(term)?new RegExp(`(^|[^0-9])${term}([^0-9]|$)`,'u').test(text):text.includes(term);
const entityMatches=(chunk,entityId)=>!entityId||(chunk.entityIds??[]).some(id=>id===entityId||id.endsWith(`:${entityId}`));
function aliasesOf(chunk) {
  return [...new Set([...(chunk.aliases??[]),...(chunk.document?.aliases??[]),...(chunk.payload?.aliases??[]),...(chunk.source?.aliases??[]),chunk.document?.term,chunk.payload?.term,
    chunk.document?.nameOriginal,chunk.document?.nameEn].filter(value=>typeof value==='string').map(norm))].filter(value=>value.length>=2);
}
function aliasScore(alias,query) {
  if(alias===query)return 100;
  // English names require word boundaries; "Orb" must not match "Orbs" accidentally.
  const contained=/\p{Script=Han}/u.test(alias)?query.includes(alias):new RegExp(`(^|[^a-z0-9_])${escaped(alias)}([^a-z0-9_]|$)`,'u').test(query);
  return contained?60+Math.min(alias.length,20):0;
}
function strongLexicalMatch(chunk,query,entityId) {
  const clean=norm(query);
  return Boolean(entityId&&entityMatches(chunk,entityId))||aliasesOf(chunk).some(alias=>aliasScore(alias,clean)>0)||
    Boolean(clean.length>=2&&[chunk.title,chunk.document?.title].some(title=>norm(title)===clean));
}
export function queryTerms(query) {
  const terms=norm(query).match(/[a-z0-9_]+|[\p{Script=Han}]+/gu)??[];
  return [...new Set(terms.flatMap(t=>/\p{Script=Han}/u.test(t)&&t.length>2?[t,...Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2))]:[t]))].filter(t=>t.length>=2||/^\d+$/.test(t));
}
export function rankLexical(chunks,query,entityId=null) {
  const terms=queryTerms(query), clean=norm(query);
  return chunks.map(c=>{
    const entityMatch=entityId&&entityMatches(c,entityId);
    if(entityId&&!entityMatch)return {chunk:c,score:0};
    const title=norm(c.title),text=norm(c.text);
    const alias=Math.max(0,...aliasesOf(c).map(name=>aliasScore(name,clean)));
    const score=(entityMatch?20:0)+alias+terms.reduce((s,t)=>s+(hasTerm(title,t)?4:0)+(hasTerm(text,t)?1:0),0)+(clean&&hasTerm(title,clean)?12:0);
    return {chunk:c,score};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.chunk.id.localeCompare(b.chunk.id));
}
export function reciprocalRankFusion(rankings) {
  const scores=new Map();for(const list of rankings)[...new Set(list)].forEach((id,i)=>scores.set(id,(scores.get(id)??0)+1/(60+i+1)));
  return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([id])=>id);
}
const safeImage=value=>typeof value==='string'&&(/^(https:\/\/|\/assets\/)/.test(value));
function evidenceOf(c) {
  const card=c.document??c.payload;
  const images=[...(c.document?.images??[]),...(c.source?.assets??[]),...(c.document?.source?.assets??[]),c.document?.source?.asset?.url,c.document?.source?.imageUrl,c.document?.image,c.source?.asset?.url].flatMap(v=>typeof v==='string'?[v]:v?.url?[v.url]:[]).filter(safeImage);
  return {id:c.id,documentId:c.documentId,title:c.title,text:c.text,sourcePatch:c.sourcePatch,source:c.source,images:[...new Set(images)],entityIds:c.entityIds,kind:c.kind,
    ...(isGeneralGlossary(c)?{scope:'general',editorialRevision:card?.editorialRevision,
      applicability:card?.applicability,evidenceStatus:card?.evidenceStatus,verificationStatus:card?.verificationStatus,
      references:card?.references??[],referenceNote:card?.referenceNote}:{scope:'patch'})};
}
async function localCorpus() {
  return withLocalSnapshots(async()=>{
    const [{getCatalog},{getLibrarySnapshot},{getSeasonMechanic}]=await Promise.all([import('../data.mjs'),import('../library-data.mjs'),import('../mechanics-data.mjs')]);
    const catalog=await getCatalog();const [library,mechanics]=await Promise.all([getLibrarySnapshot({catalog}),getSeasonMechanic()]);
    const bundle=buildKnowledgeBundle({catalog,library,mechanics}),patches=[...new Set(bundle.documents.filter(d=>d.eligible).map(d=>d.sourcePatch).filter(Boolean))];
    const patch=storageConfig().currentPatch||(patches.length===1?patches[0]:null);
    const docs=new Map(bundle.documents.map(d=>[d.id,d]));
    return {release:{id:createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),season:catalog.context.set,currentPatch:patch},chunks:bundle.chunks.filter(c=>knowledgeInScope(c,patch)).map(c=>({...c,source:docs.get(c.documentId).source,document:docs.get(c.documentId).payload,kind:docs.get(c.documentId).kind}))};
  });
}
export async function searchKnowledge({query='',entityId=null,limit=6}={},dependencies={}) {
  if(typeof query!=='string'||query.length>6000||(!query.trim()&&!entityId))throw Object.assign(new Error('请输入有效的知识问题。'),{status:400,code:'INVALID_KNOWLEDGE_QUERY'});
  if(entityId!==null&&(typeof entityId!=='string'||!entityId.trim()||entityId.length>300))throw Object.assign(new Error('entityId 必须是有效的实体标识。'),{status:400,code:'INVALID_KNOWLEDGE_QUERY'});
  if(!Number.isInteger(limit)||limit<1||limit>8)throw Object.assign(new Error('limit 必须在1到8之间。'),{status:400});
  const config=dependencies.config??storageConfig(),databaseMode=dependencies.databaseMode??isDatabaseMode();let release,chunks;
  try {
    if(dependencies.corpus)({release,chunks}=typeof dependencies.corpus==='function'?await dependencies.corpus():dependencies.corpus);
    else if(databaseMode){release=await getActiveRelease();if(!release)throw new Error('No active release');chunks=await eligibleChunks(release);}
    else({release,chunks}=await localCorpus());
    if(!release?.id||!release.currentPatch||!Array.isArray(chunks))throw new Error('Knowledge release is incomplete');
  }catch{return {status:'unavailable',evidence:[],retrieval:{mode:'unavailable'},reason:'知识存储不可用或尚未导入；没有使用其他版本替代。'};}
  // Re-check scope even for injected/retrieved candidates; vector IDs never authorize a record.
  chunks=chunks.filter(c=>knowledgeInScope(c,release.currentPatch)&&entityMatches(c,entityId));
  const glossaryChunks=chunks.filter(isGeneralGlossary);
  const mentions=entityId?[]:matchGlossaryMentions(query,glossaryChunks.map(c=>c.document??c.payload));
  const matchedIds=[...new Set(mentions.flatMap(span=>span.candidates.map(entry=>entry.id)))];
  const glossaryIds=matchedIds.flatMap(id=>glossaryChunks.filter(c=>(c.document??c.payload)?.id===id).map(c=>c.id));
  const profile=indexProfile(config),minVectorScore=Number.isFinite(config.knowledgeMinVectorScore)?config.knowledgeMinVectorScore:0.5;
  let job=null;
  if(databaseMode&&config.milvusUrl&&embeddingReady(config))job=await (dependencies.getIndexJob??getIndexJob)(release.id,profile.hash).catch(()=>null);
  const key=`knowledge:v5:${release.id}:${release.currentPatch}:${profile.hash}:${job?.state??'lexical'}:${createHash('sha256').update(JSON.stringify({query,entityId,limit,minVectorScore})).digest('hex')}`;
  const readCache=dependencies.cacheGet??(dependencies.corpus?async()=>null:cacheGet);
  const writeCache=dependencies.cacheSet??(dependencies.corpus?async()=>{}:cacheSet);
  const byId=new Map(chunks.map(c=>[c.id,c]));
  let cached=null;try{cached=await readCache(key);}catch{/* Cache failure must not hide authoritative data. */}
  if(cached?.releaseId===release.id&&cached.context?.gamePatch===release.currentPatch&&cached.retrieval?.relevance?.minVectorScore===minVectorScore&&Array.isArray(cached.evidence)&&
    ['ready','not_found'].includes(cached.status)&&cached.evidence.length<=limit&&
    ((cached.status==='ready'&&cached.evidence.length>0)||(cached.status==='not_found'&&cached.evidence.length===0))&&
    cached.evidence.every(entry=>byId.has(entry.id))) {
    // Cached IDs only preserve ranking. Rehydrate facts, images and sources from the
    // current allowed corpus; cached text never authorizes a withdrawn record.
    return {...cached,evidence:cached.evidence.map(entry=>evidenceOf(byId.get(entry.id))),retrieval:{...cached.retrieval,cacheHit:true}};
  }
  const lexical=rankLexical(chunks,query,entityId).slice(0,40);let ranked=lexical.map(r=>r.chunk.id),mode='lexical',vectorStatus=embeddingReady(config)?'not_indexed':'not_configured';
  const relevance={metric:'COSINE',minVectorScore,maxVectorScore:null,acceptedVectorCandidates:0,strongLexicalCandidates:0,applied:false};
  if(job?.state==='ready') {
    try {const [vector]=await (dependencies.embedTexts??embedTexts)([query],{config});
      const dense=await (dependencies.searchVector??((...args)=>new MilvusClient(config).search(...args)))(job.collection_name,vector,release,40);
      const allowed=new Set(chunks.map(c=>c.id));
      const scopedDense=(Array.isArray(dense)?dense:[]).filter(row=>allowed.has(row?.id));
      // Milvus COSINE reports similarity in distance: higher is more relevant.
      // A nearest neighbour alone is not evidence that the question is answerable.
      const scoredDense=scopedDense.filter(row=>Number.isFinite(row.distance));
      const denseIds=[...new Set(scoredDense.filter(row=>row.distance>=minVectorScore).map(row=>row.id))];
      const accepted=new Set(denseIds),strong=lexical.filter(row=>strongLexicalMatch(row.chunk,query,entityId));
      const strongIds=new Set(strong.map(row=>row.chunk.id));
      const lexicalIds=ranked.filter(id=>accepted.has(id)||strongIds.has(id));
      ranked=reciprocalRankFusion([lexicalIds,denseIds]);mode='hybrid';vectorStatus='ready';
      Object.assign(relevance,{applied:true,maxVectorScore:scoredDense.length?Math.max(...scoredDense.map(row=>row.distance)):null,
        acceptedVectorCandidates:denseIds.length,strongLexicalCandidates:strongIds.size});
    }catch{vectorStatus='unavailable';}
  }
  // Exact terminology mentions come first, one atomic card per concept. Dense
  // similarity must not bury 慢D under an unrelated reward mentioning金币.
  // Longest spans keep 大天使 separate from 天使 and prevent an incidental
  // definition/reference URL from outranking an explicitly requested meaning.
  ranked = [...new Set([...glossaryIds, ...ranked.filter(id=>!isGeneralGlossary(byId.get(id)) || glossaryIds.includes(id))])];
  const selected=ranked.slice(0,limit).map(id=>byId.get(id)).filter(Boolean);
  const terminology={mentions:mentions.map(span=>({text:span.text,ambiguous:span.ambiguous,candidates:span.candidates.map(entry=>({id:entry.id,term:entry.term}))})),truncated:glossaryIds.length>limit};
  const result={status:selected.length?'ready':'not_found',releaseId:release.id,context:{set:release.season,gamePatch:release.currentPatch},retrieval:{mode,vectorStatus,cacheHit:false,candidates:ranked.length,relevance,scoreMeaning:'COSINE 相关度与检索排序，不代表事实置信度'},terminology,evidence:selected.map(evidenceOf),reason:selected.length?null:'当前发布的知识与术语资料中没有找到相关证据。'};
  if(vectorStatus!=='unavailable')try{await writeCache(key,result);}catch{/* Redis is disposable. */}
  return result;
}
