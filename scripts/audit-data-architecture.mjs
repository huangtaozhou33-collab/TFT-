import { readFile, writeFile } from 'node:fs/promises';
import { getPool, getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { sha256 } from './stats-cache.mjs';
import { getMetaStorageInventory } from '../server/storage/statistics-inventory.mjs';

// No upstream requests, embedding calls, schema changes, or data deletion.
const output = process.argv[2] || 'docs/DATABASE_ARCHITECTURE_AUDIT.json';
const id = value => { if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected schema identifier'); return '`' + value + '`'; };
let connection;
try {
  const db = await getPool(); connection = await db.getConnection();
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const active = await getActiveRelease(connection);
  if (!active) throw new Error('No active release');
  const report = { auditedAt: new Date().toISOString(), readOnly: true, consistentSnapshot: true, modelCalled: false,
    active: { releaseId: active.id, season: active.season, currentPatch: active.currentPatch, rulesSourcePatch: active.sourcePatch },
    tables: [], foreignKeys: [], migrations: [], failures: [], notes: [
      'Table row counts use COUNT(*); allocated bytes are MySQL information_schema estimates, not exact payload bytes.',
      'Statistics records, source responses, matches, participants, documents, chunks and vector job counts are distinct units.',
      'Retained MetaTFT snapshots include expired data and different ranks/adapters; this is not current query coverage.',
      'This audit verifies SQL relationships and migration checksums; MetaTFT body hashes and metrics are audited separately.' ] };
  const [tables] = await connection.query(`SELECT table_name AS name,engine,
    data_length AS dataBytes,index_length AS indexBytes FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name`);
  const [columns] = await connection.query(`SELECT table_name AS tableName,column_name AS name,column_type AS type,
    is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position`);
  const [indexes] = await connection.query(`SELECT table_name AS tableName,index_name AS name,non_unique AS nonUnique,
    GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnsList FROM information_schema.statistics
    WHERE table_schema=DATABASE() GROUP BY table_name,index_name,non_unique ORDER BY table_name,index_name`);
  for (const table of tables) {
    const [[count]] = await connection.query(`SELECT COUNT(*) AS n FROM ${id(table.name)}`);
    const tableColumns = columns.filter(c => c.tableName === table.name);
    let activeReleaseRows = null;
    if (tableColumns.some(c => c.name === 'release_id')) {
      const [[scoped]] = await connection.execute(`SELECT COUNT(*) AS n FROM ${id(table.name)} WHERE release_id=?`, [active.id]);
      activeReleaseRows = Number(scoped.n);
    }
    report.tables.push({ ...table, rows: Number(count.n), activeReleaseRows,
      columns: tableColumns.map(({ tableName, ...c }) => c), indexes: indexes.filter(i => i.tableName === table.name).map(({ tableName, ...i }) => i) });
  }
  const [foreignKeys] = await connection.query(`SELECT table_name AS child,constraint_name AS name,
    column_name AS childColumn,referenced_table_name AS parent,referenced_column_name AS parentColumn
    FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL
    ORDER BY table_name,constraint_name,ordinal_position`);
  const groups = Map.groupBy(foreignKeys, row => row.child + ':' + row.name);
  for (const group of groups.values()) {
    const first = group[0], predicate = group.map(r => `p.${id(r.parentColumn)}=c.${id(r.childColumn)}`).join(' AND ');
    const present = group.map(r => `c.${id(r.childColumn)} IS NOT NULL`).join(' AND ');
    const [[orphans]] = await connection.query(`SELECT COUNT(*) AS n FROM ${id(first.child)} c
      WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${id(first.parent)} p WHERE ${predicate})`);
    report.foreignKeys.push({ child: first.child, parent: first.parent, columns: group.map(r => r.childColumn), orphans: Number(orphans.n) });
    if (Number(orphans.n)) report.failures.push({ code: 'ORPHAN_ROWS', table: first.child, count: Number(orphans.n) });
  }
  const [migrations] = await connection.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version');
  for (const row of migrations) {
    const file = row.version === 1 ? 'schema.sql' : `schema-${String(row.version).padStart(3, '0')}.sql`;
    const checksum = sha256(await readFile(new URL('../server/storage/' + file, import.meta.url), 'utf8'));
    report.migrations.push({ version: row.version, file, checksumMatches: checksum === row.checksum, appliedAt: row.applied_at });
    if (checksum !== row.checksum) report.failures.push({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: row.version });
  }
  report.metatft = await getMetaStorageInventory(connection, active.id);
  const [scopes] = await connection.execute(`SELECT kind,
    JSON_UNQUOTE(JSON_EXTRACT(query_scope,'$.patch')) AS patch,
    JSON_UNQUOTE(JSON_EXTRACT(query_scope,'$.bPatch')) AS bPatch,
    JSON_EXTRACT(query_scope,'$.adapterVersion') AS adapterVersion,
    JSON_EXTRACT(query_scope,'$.ranks') AS ranks, COUNT(*) AS snapshots,COUNT(DISTINCT dataset_key) AS distinctKeys,
    SUM(expires_at>?) AS unexpiredSnapshots FROM metatft_datasets WHERE release_id=?
    GROUP BY kind,patch,bPatch,adapterVersion,ranks ORDER BY kind,patch,bPatch,adapterVersion,ranks`, [Date.now(), active.id]);
  report.metaDatasetScopes = scopes;
  const [[invalidScope]] = await connection.execute(`SELECT COUNT(*) AS n FROM metatft_datasets s JOIN data_releases r ON r.id=s.release_id
    WHERE s.kind<>JSON_UNQUOTE(JSON_EXTRACT(s.query_scope,'$.kind'))
    OR s.entity_id<>JSON_UNQUOTE(JSON_EXTRACT(s.query_scope,'$.entityId'))
    OR r.season<>JSON_EXTRACT(s.query_scope,'$.season')`);
  if (Number(invalidScope.n)) report.failures.push({ code: 'DATASET_SCOPE_COLUMNS_MISMATCH', count: Number(invalidScope.n) });
  const [releases] = await connection.query('SELECT id,season,source_patch,state,created_at,published_at FROM data_releases ORDER BY created_at');
  report.releases = releases;
  const [jobs] = await connection.execute('SELECT release_id,collection_name,state,indexed_chunks,updated_at FROM index_jobs ORDER BY updated_at');
  report.vectorIndexJobs = jobs; // Job accounting, not a new vector-content verification.
  await connection.commit();
  report.tableCount = report.tables.length;
  report.passed = !report.failures.length;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, tables: report.tableCount, migrations: report.migrations.length,
    foreignKeys: report.foreignKeys.length, orphanRows: report.foreignKeys.reduce((n, f) => n + f.orphans, 0), failures: report.failures }));
  if (!report.passed) process.exitCode = 1;
} finally { if (connection) { await connection.rollback().catch(() => {}); connection.release(); } await closeDatabase(); }
