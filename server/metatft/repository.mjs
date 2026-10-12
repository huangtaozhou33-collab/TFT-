import { getPool } from '../storage/repository.mjs';
import { metaError } from './client.mjs';
import { compareResearchRows } from '../../public/research-query.js';
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

export async function findMetaSnapshot(releaseId, queryKey, db = null) {
  try {
    db ??= await getPool();
    const [rows] = await db.execute('SELECT id,query_scope,source_metadata,summary,captured_at,expires_at FROM metatft_query_snapshots WHERE release_id=? AND query_key=? AND expires_at>? ORDER BY captured_at DESC LIMIT 1', [releaseId, queryKey, Date.now()]);
    if (!rows.length) return null;
    const row = rows[0];
    return { id: row.id, scope: json(row.query_scope), metadata: json(row.source_metadata), summary: json(row.summary), capturedAt: Number(row.captured_at), expiresAt: Number(row.expires_at) };
  } catch { throw metaError('MySQL 查询快照暂不可用，请稍后重试。', 'DATABASE_UNAVAILABLE'); }
}

export async function saveMetaSnapshot(snapshot, db = null) {
  let connection;
  try {
    db ??= await getPool(); connection = await db.getConnection(); await connection.beginTransaction();
    // A query collected against an old catalog must never be published as the new release.
    const [[active]] = await connection.query('SELECT active_release,current_patch FROM runtime_state WHERE id=1 FOR SHARE');
    if (active?.active_release !== snapshot.release.id || active.current_patch !== snapshot.release.currentPatch) throw metaError('查询期间资料版本改变，请重试。', 'RESEARCH_RELEASE_CHANGED');
    await connection.execute('INSERT INTO metatft_query_snapshots(id,release_id,query_key,season,requested_patch,requested_b_patch,query_scope,source_metadata,raw_responses,raw_response_text,content_hash,summary,captured_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [snapshot.id, snapshot.release.id, snapshot.queryKey, snapshot.release.season, snapshot.scope.patch, snapshot.scope.bPatch, JSON.stringify(snapshot.scope), JSON.stringify(snapshot.metadata), JSON.stringify(snapshot.responses), snapshot.rawResponseText, snapshot.contentHash, JSON.stringify(snapshot.summary), snapshot.capturedAt, snapshot.expiresAt]);
    for (let offset = 0; offset < snapshot.rows.length; offset += 100) {
      const batch = snapshot.rows.slice(offset, offset + 100);
      const values = batch.map(row => [snapshot.id, row.dimension, row.rowKey, row.championId || null, JSON.stringify(row.itemIds || []), JSON.stringify(row.units?.map(unit => unit.championId) || []), JSON.stringify(row.placementCount), row.stats.sampleSize, row.stats.avgPlacement, row.stats.top4Rate, row.stats.winRate, JSON.stringify(row)]);
      await connection.query('INSERT INTO metatft_query_rows(snapshot_id,dimension,row_key,champion_id,item_ids,unit_ids,placement_count,sample_size,avg_placement,top4_rate,win_rate,payload) VALUES ?', [values]);
    }
    await connection.commit();
    return snapshot;
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === 'RESEARCH_RELEASE_CHANGED') throw error;
    throw metaError('MetaTFT 数据未能保存到 MySQL，请重试；未展示未入库的结果。', 'DATABASE_UNAVAILABLE');
  } finally { connection?.release(); }
}

export async function selectMetaRows(snapshotId, query, db = null) {
  try {
    db ??= await getPool();
    const [counts] = await db.execute('SELECT dimension,COUNT(*) AS count,SUM(sample_size>=?) AS qualified FROM metatft_query_rows WHERE snapshot_id=? GROUP BY dimension', [query.minSample, snapshotId]);
    const result = {};
    for (const dimension of ['equipment', 'teammates', 'comps']) {
      const [rows] = await db.execute('SELECT payload FROM metatft_query_rows WHERE snapshot_id=? AND dimension=? AND sample_size>=?', [snapshotId, dimension, query.minSample]);
      const count = counts.find(row => row.dimension === dimension);
      result[dimension] = { rows: rows.map(row => json(row.payload)).sort((a,b)=>compareResearchRows(a,b,query.sort)||a.rowKey.localeCompare(b.rowKey)), count: Number(count?.qualified || 0), beforeMinimum: Number(count?.count || 0) };
    }
    return result;
  } catch { throw metaError('MySQL 统计查询暂不可用，请稍后重试。', 'DATABASE_UNAVAILABLE'); }
}
