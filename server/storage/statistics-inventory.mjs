// Read-only accounting. Counts are stored records, never sums of overlapping samples.
export async function getMetaStorageInventory(db, releaseId, now = Date.now()) {
  const [[datasets]] = await db.execute(`SELECT COUNT(*) AS snapshots,
    COALESCE(SUM(expires_at>?),0) AS unexpiredSnapshots,
    COUNT(DISTINCT dataset_key) AS distinctKeys
    FROM metatft_datasets WHERE release_id=?`, [now, releaseId]);
  const [[datasetRows]] = await db.execute(`SELECT COUNT(*) AS records FROM metatft_dataset_rows r
    JOIN metatft_datasets s ON s.id=r.dataset_id WHERE s.release_id=?`, [releaseId]);
  const [[queries]] = await db.execute(`SELECT COUNT(*) AS snapshots,
    COALESCE(SUM(expires_at>?),0) AS unexpiredSnapshots,
    COUNT(DISTINCT query_key) AS distinctKeys
    FROM metatft_query_snapshots WHERE release_id=?`, [now, releaseId]);
  const [[queryRows]] = await db.execute(`SELECT COUNT(*) AS records FROM metatft_query_rows r
    JOIN metatft_query_snapshots s ON s.id=r.snapshot_id WHERE s.release_id=?`, [releaseId]);
  const numbers = value => Object.fromEntries(Object.entries(value).map(([key, n]) => [key, Number(n)]));
  return { status: 'ready', releaseId, scope: 'active_release_all_retained_snapshots', countedAt: new Date(now).toISOString(),
    datasets: { ...numbers(datasets), rows: Number(datasetRows.records) },
    queries: { ...numbers(queries), rows: Number(queryRows.records) },
    sourcePatch: null, snapshotPolicy: { datasetsTtlHours: 6, queriesTtlMinutes: 10, automaticDeletion: false },
    note: '快照数包含当前发布保留的历史采集；未过期不等于当前补丁或完整覆盖。记录数不是比赛数或样本数，目录覆盖须另按补丁、段位与适配器版本核验。' };
}
