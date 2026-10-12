import { AsyncLocalStorage } from 'node:async_hooks';
import { storageConfig } from './config.mjs';
import { getSnapshot, getActiveRelease, getPool } from './repository.mjs';
import { effectiveSnapshotPatch, snapshotPatchEvidence } from './patch-attribution.mjs';
import { GENERAL_DOCUMENT_SQL } from '../knowledge/scope.mjs';
import { getMetaStorageInventory } from './statistics-inventory.mjs';

const localScope = new AsyncLocalStorage();
export const withLocalSnapshots = task => localScope.run(true, task);
export const isDatabaseMode = () => !localScope.getStore() && storageConfig().backend === 'mysql';

export async function readDatabaseStatsManifest() {
  if(!isDatabaseMode())return undefined;
  try {
    const db=await getPool(),release=await getActiveRelease(db);if(!release)return null;
    const [rows]=await db.execute(`SELECT s.snapshot_key,s.source_patch,s.evidence_kind,s.content_hash,a.assigned_patch,a.attribution,
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.evidence.tool')) AS tool,
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) AS source_status,
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.code')) AS source_code,
      JSON_LENGTH(JSON_EXTRACT(payload,'$.data.data')) AS list_rows,
      JSON_LENGTH(JSON_EXTRACT(payload,'$.data')) AS top_rows
      FROM source_snapshots s LEFT JOIN snapshot_patch_assignments a ON a.release_id=s.release_id AND a.snapshot_key=s.snapshot_key AND a.content_hash=s.content_hash WHERE s.release_id=? AND s.snapshot_key LIKE 'opgg:%'`,[release.id]);
    const records=Object.fromEntries(rows.map(row=>{
      const assigned={sourcePatch:row.source_patch,assignedPatch:row.assigned_patch,contentHash:row.content_hash,patchAssignment:typeof row.attribution==='string'?JSON.parse(row.attribution):row.attribution,release};
      const scope=snapshotAvailability(assigned);
      const allowed=row.evidence_kind!=='statistics'||scope==='ready';
      const status=row.source_code==='not_supported'?'not_supported':allowed?(row.source_status==='live'?'ok':row.source_code||'unavailable'):scope;
      return [row.snapshot_key.slice(5),{tool:row.tool,status,sourcePatch:row.source_patch,assignedPatch:row.assigned_patch,effectivePatch:effectiveSnapshotPatch(assigned),rowCount:status==='ok'?Number(row.list_rows??row.top_rows??0):0}];
    }));
    const captured=release.manifest.statsCapture??{},count=tool=>Object.values(records).filter(r=>r.tool===tool&&r.status==='ok').length;
    return {...captured,records,delivery:'mysql',coverage:{...(captured.coverage??{}),complete:false,
      decks:Object.values(records).find(r=>r.tool==='tft_list_meta_decks')?.rowCount??0,
      championBuilds:{...captured.coverage?.championBuilds,cached:count('tft_get_champion_item_build')},
      itemHolders:{...captured.coverage?.itemHolders,cached:count('tft_list_champions_for_item')},
      emblemHolders:{...captured.coverage?.emblemHolders,cached:0},
      patchAssigned:Object.values(records).filter(r=>r.status==='ok'&&!r.sourcePatch&&r.assignedPatch).length,
      patchQuarantined:Object.values(records).filter(r=>['version_unknown','version_mismatch'].includes(r.status)).length}};
  }catch{throw Object.assign(new Error('MySQL 统计目录暂不可用。'),{status:503,code:'DATABASE_UNAVAILABLE'});}
}

export function snapshotAvailability(snapshot) {
  if (!snapshot) return 'not_collected';
  const effective = effectiveSnapshotPatch(snapshot);
  if (!effective) return 'version_unknown';
  return effective === snapshot.release.currentPatch ? 'ready' : 'version_mismatch';
}
export async function readDatabaseSnapshot(key, { statistics = false } = {}) {
  if (!isDatabaseMode()) return undefined;
  let record;
  try { record = await getSnapshot(key); }
  catch { throw Object.assign(new Error('MySQL 暂不可用；未回退旧版本本地缓存。'), {status:503,code:'DATABASE_UNAVAILABLE'}); }
  if (!record && key.startsWith('opgg:')) return {status:'not_cached',code:'not_collected',data:null,delivery:'mysql',reason:'数据库尚未采集此查询；不会自动改用其他英雄或装备。'};
  if (!record) throw Object.assign(new Error('当前数据库尚未导入所需资料。'), {status:503,code:'DATA_NOT_IMPORTED'});
  if (record.payload.code === 'not_supported') return {...record.payload,delivery:'mysql',data:[],evidence:{...record.payload.evidence,...snapshotPatchEvidence(record)}};
  if (statistics && snapshotAvailability(record) !== 'ready') {
    const code = snapshotAvailability(record);
    const reason = code === 'version_unknown'
      ? `统计数据已采集，但来源未提供可核验的补丁标记，暂不能用于当前 ${record.release.currentPatch} 版本查询。`
      : `${record.sourcePatch?'来源统计属于':'统计归档为'} ${effectiveSnapshotPatch(record)} 补丁，与当前 ${record.release.currentPatch} 不同，已排除这些数据。`;
    return {...record.payload,status:'unavailable',code,delivery:'mysql',data:[],champions:[],units:[],items:[],evidence:{...record.payload.evidence,...snapshotPatchEvidence(record)},reason};
  }
  if(key==='library') return {...record.payload,delivery:'mysql',retrievalPatch:record.release.currentPatch,documents:record.payload.documents.map(d=>({...d,retrievalEligible:d.retrievalEligible&&d.sourcePatch===record.release.currentPatch})),augmentRules:record.payload.augmentRules.filter(r=>r.sourcePatch===record.release.currentPatch)};
  if(key==='mechanics' && record.release.sourcePatch!==record.release.currentPatch) return {status:'unavailable',delivery:'mysql',context:record.payload.context,entries:[],mechanic:null,source:record.payload.source,reason:'当前补丁的赛季机制尚未核验。'};
  return {...record.payload, delivery:'mysql',...(record.payload.evidence?{evidence:{...record.payload.evidence,...snapshotPatchEvidence(record)}}:{})};
}
let redis, redisFailedUntil=0;
export async function getRedis() {
  if (!storageConfig().redisUrl || Date.now()<redisFailedUntil) return null;
  try {
    if (!redis) { const {createClient}=await import('redis'); redis=createClient({url:storageConfig().redisUrl,socket:{connectTimeout:1200,reconnectStrategy:false}}); redis.on('error',()=>{}); }
    if (!redis.isOpen) await redis.connect();
    return redis.isReady?redis:null;
  } catch { redisFailedUntil=Date.now()+30000; return null; }
}
export async function closeRedis() { if(redis){const old=redis;redis=null;if(old.isOpen)old.destroy();} }
export async function cacheGet(key) { try {const c=await getRedis();const v=c?await c.get(key):null;return v?JSON.parse(v):null;}catch{return null;} }
export async function cacheSet(key,value) {try {const c=await getRedis();if(c)await c.set(key,JSON.stringify(value),{EX:storageConfig().cacheSeconds});}catch{} }
export async function getStorageHealth() {
  const config=storageConfig(), result={backend:config.backend,mysql:{status:'not_configured'},redis:{status:'not_configured'},milvus:{status:'not_configured'},embedding:{status:config.embedding.key&&config.embedding.model&&config.embedding.baseUrl?'configured':'not_configured'},activeRelease:null};
  if(config.backend==='mysql') {
    try {
      const db=await getPool();await db.query('SELECT 1');const active=await getActiveRelease(db);
      result.mysql={status:active?'ready':'empty'};
      result.activeRelease=active?{id:active.id,season:active.season,currentPatch:active.currentPatch,seedPatch:active.sourcePatch,counts:active.manifest.counts}:null;
      if(active) {
        const [[counts]]=await db.execute(`SELECT
          (SELECT COUNT(*) FROM knowledge_documents WHERE release_id=?) AS documents,
          (SELECT COUNT(*) FROM knowledge_documents d WHERE d.release_id=? AND d.eligible=1 AND (d.source_patch=? OR ${GENERAL_DOCUMENT_SQL})) AS eligibleDocuments,
          (SELECT COUNT(*) FROM knowledge_chunks WHERE release_id=?) AS chunks,
          (SELECT COUNT(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.release_id=c.release_id AND d.document_id=c.document_id WHERE c.release_id=? AND c.eligible=1 AND d.eligible=1 AND ((c.source_patch=? AND d.source_patch=?) OR (c.source_patch IS NULL AND ${GENERAL_DOCUMENT_SQL}))) AS eligibleChunks`,
          [active.id,active.id,active.currentPatch,active.id,active.id,active.currentPatch,active.currentPatch]);
        result.knowledgeCounts=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]));
        const [rows]=await db.execute('SELECT s.source_patch,s.content_hash,a.assigned_patch,a.attribution FROM source_snapshots s LEFT JOIN snapshot_patch_assignments a ON a.release_id=s.release_id AND a.snapshot_key=s.snapshot_key AND a.content_hash=s.content_hash WHERE s.release_id=? AND s.evidence_kind=\'statistics\'',[active.id]);
        const qualified=rows.map(row=>({sourcePatch:row.source_patch,assignedPatch:row.assigned_patch,contentHash:row.content_hash,patchAssignment:typeof row.attribution==='string'?JSON.parse(row.attribution):row.attribution,release:active}));
        result.statistics={scope:'published_source_snapshots',includesMetaTft:false,total:qualified.length,sourceDeclared:qualified.filter(row=>row.sourcePatch===active.currentPatch).length,
          assignedCurrent:qualified.filter(row=>!row.sourcePatch&&effectiveSnapshotPatch(row)===active.currentPatch).length,
          unavailable:qualified.filter(row=>snapshotAvailability(row)!=='ready').length};
        result.metatft=await getMetaStorageInventory(db,active.id).catch(()=>({status:'unavailable',reason:'MetaTFT 入库计数暂不可读；未记为零。'}));
      }
    }catch{result.mysql={status:'unavailable'};}
  }
  if(config.redisUrl) {const c=await getRedis();try{result.redis={status:c&&await c.ping()==='PONG'?'ready':'unavailable'};}catch{result.redis={status:'unavailable'};} }
  if(config.milvusUrl) {
    try {const {MilvusClient,indexProfile}=await import('../knowledge/vector.mjs');await new MilvusClient(config).call('collections/list',{});result.milvus={status:'connected',indexed:false};if(result.activeRelease){const {getIndexJob}=await import('./repository.mjs');const job=await getIndexJob(result.activeRelease.id,indexProfile(config).hash);result.milvus.indexed=job?.state==='ready';result.milvus.indexedChunks=job?.indexed_chunks??0;}}catch{result.milvus={status:'unavailable',indexed:false};}
  }
  return result;
}
