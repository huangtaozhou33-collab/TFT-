import { getPool } from '../storage/repository.mjs';
import { metaError } from './client.mjs';
import { cacheGet,cacheSet } from '../storage/runtime.mjs';
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

export async function findDataset(releaseId, key, db = null) {
  try {
    db ??= await getPool();
    const [rows] = await db.execute('SELECT id,release_id,query_scope,source_metadata,summary,content_hash,captured_at,expires_at FROM metatft_datasets WHERE release_id=? AND dataset_key=? ORDER BY captured_at DESC LIMIT 1', [releaseId, key]);
    if (!rows.length) return null;
    const r = rows[0];
    return { id:r.id, releaseId:r.release_id, scope:json(r.query_scope), metadata:json(r.source_metadata), summary:json(r.summary), contentHash:r.content_hash, capturedAt:Number(r.captured_at), expiresAt:Number(r.expires_at) };
  } catch { throw metaError('MySQL 统计快照暂不可用，请稍后重试。', 'DATABASE_UNAVAILABLE'); }
}
export async function saveDataset(s, db = null) {
  let connection;
  try {
    db ??= await getPool(); connection = await db.getConnection(); await connection.beginTransaction();
    const [[active]] = await connection.query('SELECT active_release,current_patch FROM runtime_state WHERE id=1 FOR SHARE');
    if (active?.active_release !== s.release.id || active.current_patch !== s.release.currentPatch) throw metaError('采集期间资料版本改变，请重试。', 'RESEARCH_RELEASE_CHANGED');
    await connection.execute('INSERT INTO metatft_datasets(id,release_id,dataset_key,kind,entity_id,query_scope,source_metadata,raw_response_text,content_hash,summary,captured_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [s.id,s.release.id,s.key,s.scope.kind,s.scope.entityId,JSON.stringify(s.scope),JSON.stringify(s.metadata),s.rawResponseText,s.contentHash,JSON.stringify(s.summary),s.capturedAt,s.expiresAt]);
    for (let offset=0; offset<s.rows.length; offset+=100) {
      const values=s.rows.slice(offset,offset+100).map(r=>[s.id,r.dimension,r.rowKey,r.entityId,r.stats.sampleSize,r.stats.avgPlacement,JSON.stringify(r.placementCount),JSON.stringify(r)]);
      await connection.query('INSERT INTO metatft_dataset_rows(dataset_id,dimension,row_key,entity_id,sample_size,avg_placement,placement_count,payload) VALUES ?', [values]);
    }
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback().catch(()=>{});
    if (error.code==='RESEARCH_RELEASE_CHANGED') throw error;
    throw metaError('MetaTFT 统计未能写入 MySQL，请重试；未展示未入库的结果。', 'DATABASE_UNAVAILABLE');
  } finally { connection?.release(); }
}
export async function readDatasetRows(id, dimension = null, db = null) {
  try {
    const cacheKey=`stats:dataset:v1:${id}:${dimension||'all'}`;
    const cached=await cacheGet(cacheKey);if(cached)return cached;
    db ??= await getPool();
    // Sorting wide JSON in MySQL can exceed sort_buffer_size. Sort small display arrays in JS.
    const [rows] = dimension ? await db.execute('SELECT payload FROM metatft_dataset_rows WHERE dataset_id=? AND dimension=?',[id,dimension])
      : await db.execute('SELECT payload FROM metatft_dataset_rows WHERE dataset_id=?',[id]);
    const result=rows.map(r=>json(r.payload));await cacheSet(cacheKey,result);return result;
  } catch { throw metaError('MySQL 统计记录暂不可用，请稍后重试。', 'DATABASE_UNAVAILABLE'); }
}
export async function datasetInventory(releaseId, scope, db = null) {
  try {
    db ??= await getPool();
    const [rows] = await db.execute(`SELECT kind,entity_id,summary,captured_at FROM metatft_datasets
      WHERE release_id=? AND expires_at>? AND JSON_UNQUOTE(JSON_EXTRACT(query_scope,'$.patch'))=?
        AND JSON_UNQUOTE(JSON_EXTRACT(query_scope,'$.bPatch'))=? AND JSON_EXTRACT(query_scope,'$.adapterVersion')=1 AND JSON_EXTRACT(query_scope,'$.ranks')=CAST(? AS JSON)`, [releaseId,Date.now(),scope.patch,scope.bPatch,JSON.stringify(scope.ranks)]);
    const latest=new Map();
    for(const r of rows.sort((a,b)=>Number(a.captured_at)-Number(b.captured_at))) latest.set(`${r.kind}:${r.entity_id}`,{...r,summary:json(r.summary)});
    return latest;
  } catch { throw metaError('MySQL 统计目录暂不可用。', 'DATABASE_UNAVAILABLE'); }
}
