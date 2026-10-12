import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { getPool, migrate, closeDatabase } from '../server/storage/repository.mjs';
import { storageConfig } from '../server/storage/config.mjs';
import { createRiotClient } from '../server/riot/client.mjs';
import { connectRiotRedis, createRedisRiotLimiter } from '../server/riot/rate-limit.mjs';
import { createCollectorStore, collectRiot } from '../server/riot/collector.mjs';

export async function runRiotCollection({ allowProvider = false, maxMatches = 25, seedCount = 3, env = process.env } = {}) {
  if (!allowProvider) throw Object.assign(new Error('RIOT_PROVIDER_NOT_AUTHORIZED'), { code: 'RIOT_PROVIDER_NOT_AUTHORIZED' });
  if (!env.RIOT_API_KEY?.trim()) throw Object.assign(new Error('RIOT_KEY_MISSING'), { code: 'RIOT_KEY_MISSING' });
  if (env.RIOT_REGION && env.RIOT_REGION !== 'asia') throw Object.assign(new Error('RIOT_REGION_UNSUPPORTED'), { code: 'RIOT_REGION_UNSUPPORTED' });
  const db = await getPool();
  await migrate(db);
  const lock = await db.getConnection();
  let acquired = false, redis;
  try {
    const [[row]] = await lock.query("SELECT GET_LOCK('tft_riot_collector_kr',0) AS acquired");
    acquired = row.acquired === 1;
    if (!acquired) return { status: 'already_running', requests: 0 };
    redis = await connectRiotRedis(storageConfig(env).redisUrl);
    const limiter = createRedisRiotLimiter({ redis, key: env.RIOT_API_KEY });
    const client = createRiotClient({ key: env.RIOT_API_KEY, limiter });
    const [{ getCatalog }, { importRiotMatch, reclassifyStoredRiotMatches }, { refreshRiotPatchWindows }] = await Promise.all([
      import('../server/data.mjs'), import('../server/riot/repository.mjs'), import('../server/riot/patch-policy.mjs')
    ]);
    let patchPolicy;
    try { patchPolicy = await refreshRiotPatchWindows({ db }); }
    catch { patchPolicy = { status: 'unavailable', code: 'RIOT_PATCH_POLICY_REFRESH_FAILED' }; }
    const catalog = await getCatalog();
    // Revisit stored quarantined matches from their original payload after the
    // audited time window grows; no extra Riot request is needed for this step.
    let reclassification = { status: 'not_run', reclassified: 0 };
    if (patchPolicy?.status === 'updated') {
      try { reclassification = await reclassifyStoredRiotMatches({ db, catalog, limit: 250 }); }
      catch { reclassification = { status: 'failed', code: 'RIOT_RECLASSIFICATION_FAILED', reclassified: 0 }; }
    }
    const report = await collectRiot({ client, store: createCollectorStore(db), maxMatches, seedCount,
      importMatch: record => importRiotMatch(record, { db, catalog }) });
    // Do not echo upstream responses or policy internals in collection logs.
    return { ...report, patchPolicyStatus: patchPolicy?.status || 'checked', reclassification };
  } finally {
    if (redis?.isOpen) await redis.quit().catch(() => redis.destroy());
    if (acquired) await lock.query("SELECT RELEASE_LOCK('tft_riot_collector_kr')").catch(() => {});
    lock.release();
  }
}

export function parseCollectorArguments(args) {
  if (!args.includes('--allow-provider') || args.some(arg => !/^--(?:allow-provider|max-matches=\d+|seed-count=\d+)$/.test(arg))) {
    throw Object.assign(new Error('RIOT_INVALID_ARGUMENTS'), { code: 'RIOT_INVALID_ARGUMENTS' });
  }
  const maxMatches = Number(args.find(arg => arg.startsWith('--max-matches='))?.split('=')[1] || 25);
  const seedCount = Number(args.find(arg => arg.startsWith('--seed-count='))?.split('=')[1] || 3);
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100 || !Number.isInteger(seedCount) || seedCount < 1 || seedCount > 10) {
    throw Object.assign(new Error('RIOT_INVALID_ARGUMENTS'), { code: 'RIOT_INVALID_ARGUMENTS' });
  }
  return { allowProvider: true, maxMatches, seedCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setDefaultResultOrder('ipv4first');
  try {
    const report = await runRiotCollection(parseCollectorArguments(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^RIOT_[A-Z_]+$/.test(error.code || '') ? error.code : 'RIOT_COLLECTION_FAILED' }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
