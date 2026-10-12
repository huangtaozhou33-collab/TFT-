import { readFile } from 'node:fs/promises';
import { sha256, stableJSON } from '../../scripts/stats-cache.mjs';
import { storageConfig } from './config.mjs';
import { effectiveSnapshotPatch } from './patch-attribution.mjs';
import { GENERAL_DOCUMENT_SQL } from '../knowledge/scope.mjs';

let pool;
export async function getPool() {
  if (!pool) { const mysql = await import('mysql2/promise'); pool = mysql.createPool(storageConfig().mysql); }
  return pool;
}
export async function closeDatabase() { if (pool) { const old = pool; pool = null; await old.end(); } }
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
export async function migrate(db = null) {
  db ??= await getPool();
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  const connection = await db.getConnection();
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('tft_schema_migration',30) AS acquired");
    if (lock.acquired !== 1) throw new Error('Schema migration lock unavailable');
    await connection.query(statements[0]);
    const [rows] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=1');
    if (rows.length && rows[0].checksum !== sha256(sql)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!rows.length) {
      for (const statement of statements.slice(1)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(1,?)', [sha256(sql)]);
    }
    const attributionSQL = await readFile(new URL('./schema-002.sql', import.meta.url), 'utf8');
    const [attributionMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=2');
    if (attributionMigration.length && attributionMigration[0].checksum !== sha256(attributionSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!attributionMigration.length) {
      for (const statement of attributionSQL.split(';').map(value=>value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(2,?)',[sha256(attributionSQL)]);
    }
    const riotSQL = await readFile(new URL('./schema-003.sql', import.meta.url), 'utf8');
    const [riotMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=3');
    if (riotMigration.length && riotMigration[0].checksum !== sha256(riotSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!riotMigration.length) {
      for (const statement of riotSQL.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(3,?)', [sha256(riotSQL)]);
    }
    const rawSQL = await readFile(new URL('./schema-004.sql', import.meta.url), 'utf8');
    const [rawMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=4');
    if (rawMigration.length && rawMigration[0].checksum !== sha256(rawSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!rawMigration.length) {
      const [columns] = await connection.query("SHOW COLUMNS FROM riot_matches LIKE 'raw_json'");
      if (!columns.length) await connection.query(rawSQL.trim().replace(/;$/, ''));
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(4,?)', [sha256(rawSQL)]);
    }
    const metaSQL = await readFile(new URL('./schema-005.sql', import.meta.url), 'utf8');
    const [metaMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=5');
    if (metaMigration.length && metaMigration[0].checksum !== sha256(metaSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!metaMigration.length) {
      for (const statement of metaSQL.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(5,?)', [sha256(metaSQL)]);
    }
    const metaTextSQL = await readFile(new URL('./schema-006.sql', import.meta.url), 'utf8');
    const [metaTextMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=6');
    if (metaTextMigration.length && metaTextMigration[0].checksum !== sha256(metaTextSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!metaTextMigration.length) {
      const [columns] = await connection.query("SHOW COLUMNS FROM metatft_query_snapshots LIKE 'raw_response_text'");
      if (!columns.length) await connection.query(metaTextSQL.trim().replace(/;$/, ''));
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(6,?)', [sha256(metaTextSQL)]);
    }
    const datasetsSQL = await readFile(new URL('./schema-007.sql', import.meta.url), 'utf8');
    const [datasetsMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=7');
    if (datasetsMigration.length && datasetsMigration[0].checksum !== sha256(datasetsSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!datasetsMigration.length) {
      for (const statement of datasetsSQL.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(7,?)', [sha256(datasetsSQL)]);
    }
    const scheduleSQL = await readFile(new URL('./schema-008.sql', import.meta.url), 'utf8');
    const [scheduleMigration] = await connection.execute('SELECT checksum FROM schema_migrations WHERE version=8');
    if (scheduleMigration.length && scheduleMigration[0].checksum !== sha256(scheduleSQL)) throw new Error('Migration checksum changed; create a new migration instead');
    if (!scheduleMigration.length) {
      for (const statement of scheduleSQL.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(8,?)', [sha256(scheduleSQL)]);
    }
    const patchSQL=await readFile(new URL('./schema-009.sql',import.meta.url),'utf8');
    const [patchMigration]=await connection.execute('SELECT checksum FROM schema_migrations WHERE version=9');
    if(patchMigration.length&&patchMigration[0].checksum!==sha256(patchSQL))throw new Error('Migration checksum changed');
    if(!patchMigration.length){for(const statement of patchSQL.split(';').map(x=>x.trim()).filter(Boolean))await connection.query(statement);await connection.execute('INSERT INTO schema_migrations(version,checksum) VALUES(9,?)',[sha256(patchSQL)]);}
  } finally { await connection.query("SELECT RELEASE_LOCK('tft_schema_migration')").catch(()=>{}); connection.release(); }
}
export async function getActiveRelease(db = null) {
  db ??= await getPool();
  const [rows] = await db.query('SELECT r.*,s.current_patch FROM runtime_state s JOIN data_releases r ON r.id=s.active_release WHERE s.id=1 AND r.state=\'published\'');
  if (!rows.length) return null;
  const row = rows[0];
  return { id: row.id, season: row.season, sourcePatch: row.source_patch, currentPatch: storageConfig().currentPatch || row.current_patch, manifest: json(row.manifest), publishedAt: row.published_at };
}
export async function getSnapshot(key, db = null) {
  db ??= await getPool(); const release = await getActiveRelease(db);
  if (!release) return null;
  const [rows] = await db.execute('SELECT s.payload,s.source_patch,s.evidence_kind,s.content_hash,a.assigned_patch,a.attribution FROM source_snapshots s LEFT JOIN snapshot_patch_assignments a ON a.release_id=s.release_id AND a.snapshot_key=s.snapshot_key AND a.content_hash=s.content_hash WHERE s.release_id=? AND s.snapshot_key=?',[release.id,key]);
  if (!rows.length) return null;
  const record = { release, sourcePatch: rows[0].source_patch, evidenceKind: rows[0].evidence_kind, payload: json(rows[0].payload),
    contentHash: rows[0].content_hash, assignedPatch: rows[0].assigned_patch ?? null, patchAssignment: rows[0].attribution ? json(rows[0].attribution) : null };
  return {...record,effectivePatch:effectiveSnapshotPatch(record)};
}
/** A knowledge-only publication must retain attribution for byte-identical stats.
 * This runs inside the publication transaction, never rewrites source patches,
 * and refuses changed payloads, other seasons/patches and malformed attribution.
 */
export async function inheritSnapshotPatchAssignments(connection, { fromRelease, toRelease, patch }) {
  if (!fromRelease || fromRelease === toRelease) return 0;
  const [result] = await connection.execute(`INSERT IGNORE INTO snapshot_patch_assignments(release_id,snapshot_key,content_hash,assigned_patch,attribution)
    SELECT target.release_id,target.snapshot_key,target.content_hash,a.assigned_patch,
      JSON_SET(a.attribution,'$.inheritedFromRelease',a.release_id,'$.inheritedToRelease',target.release_id)
    FROM snapshot_patch_assignments a
    JOIN source_snapshots original ON original.release_id=a.release_id AND original.snapshot_key=a.snapshot_key AND original.content_hash=a.content_hash
    JOIN source_snapshots target ON target.snapshot_key=original.snapshot_key AND target.content_hash=original.content_hash
    JOIN data_releases old_release ON old_release.id=original.release_id
    JOIN data_releases new_release ON new_release.id=target.release_id AND new_release.season=old_release.season AND new_release.source_patch=old_release.source_patch
    WHERE a.release_id=? AND target.release_id=? AND a.assigned_patch=? AND new_release.source_patch=a.assigned_patch
      AND original.source_patch IS NULL AND target.source_patch IS NULL AND original.evidence_kind='statistics' AND target.evidence_kind='statistics'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.attribution,'$.assignedPatch'))=a.assigned_patch
      AND JSON_UNQUOTE(JSON_EXTRACT(a.attribution,'$.contentHash'))=a.content_hash
      AND JSON_UNQUOTE(JSON_EXTRACT(a.attribution,'$.method')) IN ('manual_calendar','source_page')`, [fromRelease, toRelease, patch]);
  return Number(result.affectedRows ?? 0);
}
export async function publishBundle(bundle, db = null) {
  const {id,...contents}=bundle;
  if(id!==sha256(contents))throw new Error('Seed bundle content hash mismatch');
  db ??= await getPool(); const connection = await db.getConnection();
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('tft_seed_publish',30) AS acquired");
    if (lock.acquired !== 1) throw new Error('Publish lock unavailable');
    const [existing] = await connection.execute('SELECT state FROM data_releases WHERE id=?',[bundle.id]);
    await connection.beginTransaction();
    async function activate() {
      const desired=storageConfig().currentPatch;
      await connection.execute('INSERT IGNORE INTO runtime_state VALUES(1,?,?)',[desired||bundle.sourcePatch,bundle.id]);
      const [rows]=await connection.query('SELECT s.current_patch,s.active_release,r.source_patch AS active_patch FROM runtime_state s JOIN data_releases r ON r.id=s.active_release WHERE s.id=1 FOR UPDATE');
      const current=desired||rows[0].current_patch;
      // A bundled seed already imported on first boot must not take back the
      // pointer from a newer publication of the same patch after a restart.
      const active=current===bundle.sourcePatch&&(!existing.length||rows[0].active_release===bundle.id||rows[0].active_patch!==current);
      if (active && !existing.length && rows[0].active_release !== bundle.id) {
        const inherited = await inheritSnapshotPatchAssignments(connection, { fromRelease: rows[0].active_release, toRelease: bundle.id, patch: current });
        if (inherited) await connection.execute("INSERT INTO change_log(release_id,kind,detail) VALUES(?,'statistics_attribution_inherited',?)", [bundle.id, stableJSON({ fromRelease: rows[0].active_release, count: inherited, sameContentOnly: true, sourcePatchPreserved: true })]);
      }
      if(active)await connection.execute('UPDATE runtime_state SET active_release=?,current_patch=? WHERE id=1',[bundle.id,current]);
      if(active&&rows[0].active_release!==bundle.id)await connection.execute('INSERT INTO change_log(release_id,kind,detail) VALUES(?,\'release_activated\',?)',[bundle.id,stableJSON({from:rows[0].active_release,currentPatch:current})]);
      return active;
    }
    if (existing[0]?.state === 'published') { const active=await activate();await connection.commit();return {status:'unchanged',releaseId:bundle.id,active}; }
    await connection.execute('INSERT INTO data_releases(id,season,source_patch,manifest) VALUES(?,?,?,?)',[bundle.id,bundle.season,bundle.sourcePatch,stableJSON(bundle.manifest)]);
    for (const s of bundle.snapshots) await connection.execute('INSERT INTO source_snapshots VALUES(?,?,?,?,?,?)',[bundle.id,s.key,s.sourcePatch ?? null,s.kind,sha256(s.payload),stableJSON(s.payload)]);
    for (const e of bundle.entities) await connection.execute('INSERT INTO entities VALUES(?,?,?,?,?,?)',[bundle.id,e.id,e.kind,e.name,stableJSON(e.aliases ?? []),stableJSON(e.payload)]);
    for (const d of bundle.documents) {
      await connection.execute('INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?,?,?,?)',[bundle.id,d.id,d.kind,d.title,d.sourcePatch ?? null,!!d.eligible,d.reviewStatus || 'unverified',stableJSON(d.entityIds),stableJSON(d.source ?? {}),stableJSON(d.payload)]);
      for (const [i,t] of (d.payload.tables ?? []).entries()) for (const [j,r] of (t.rows ?? []).entries()) await connection.execute('INSERT INTO reward_branches VALUES(?,?,?,?,?,?,?)',[bundle.id,d.id,i,j,r.condition || t.condition || '',r.probability ?? null,stableJSON({tableTitle:t.title,columns:t.columns,note:t.note,probabilityBasis:t.probabilityBasis,exhaustive:t.exhaustive,row:r})]);
    }
    for (const c of bundle.chunks) await connection.execute('INSERT INTO knowledge_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)',[bundle.id,c.id,c.documentId,c.ordinal,c.title,c.text,c.sourcePatch ?? null,!!c.eligible,stableJSON(c.entityIds),c.contentHash,stableJSON(c.payload ?? {})]);
    for (const s of bundle.capabilities) await connection.execute('INSERT INTO source_capabilities VALUES(?,?,?)',[bundle.id,s.id,stableJSON(s)]);
    await connection.execute("UPDATE data_releases SET state='published',published_at=CURRENT_TIMESTAMP(3) WHERE id=?",[bundle.id]);
    // First install initializes patch. Later imports require the explicit active patch.
    const active=await activate();
    await connection.execute('INSERT INTO change_log(release_id,kind,detail) VALUES(?,\'seed_published\',?)',[bundle.id,stableJSON(bundle.manifest)]);
    await connection.commit();
    return { status:'published',releaseId:bundle.id,active,...bundle.manifest.counts };
  } catch(error) { await connection.rollback(); throw error; }
  finally { await connection.query("SELECT RELEASE_LOCK('tft_seed_publish')").catch(()=>{}); connection.release(); }
}
export async function eligibleChunks(release, db = null) {
  db ??= await getPool();
  const [rows] = await db.execute(`SELECT c.*,d.source,d.payload AS document_payload,d.kind FROM knowledge_chunks c JOIN knowledge_documents d ON d.release_id=c.release_id AND d.document_id=c.document_id WHERE c.release_id=? AND c.eligible=1 AND d.eligible=1 AND ((c.source_patch=? AND d.source_patch=?) OR (c.source_patch IS NULL AND ${GENERAL_DOCUMENT_SQL})) ORDER BY c.document_id,c.ordinal`,[release.id,release.currentPatch,release.currentPatch]);
  return rows.map(r=>({id:r.chunk_id,documentId:r.document_id,title:r.title,text:r.text,kind:r.kind,sourcePatch:r.source_patch,entityIds:json(r.entity_ids),contentHash:r.content_hash,payload:json(r.payload),source:json(r.source),document:json(r.document_payload)}));
}
export async function getIndexJob(releaseId, profileHash, db = null) {
  db ??=await getPool(); const [rows]=await db.execute('SELECT * FROM index_jobs WHERE release_id=? AND profile_hash=?',[releaseId,profileHash]); return rows[0] ?? null;
}
export async function saveIndexJob({releaseId,profileHash,collection,state,profile,count=0,errorCode=null},db=null) {
  db ??=await getPool();
  await db.execute('INSERT INTO index_jobs(release_id,profile_hash,collection_name,state,indexed_chunks,profile,error_code) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state),indexed_chunks=VALUES(indexed_chunks),error_code=VALUES(error_code)',[releaseId,profileHash,collection,state,count,stableJSON(profile),errorCode]);
}
