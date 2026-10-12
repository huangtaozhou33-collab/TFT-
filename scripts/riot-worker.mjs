import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { setDefaultResultOrder } from 'node:dns';
import { getPool, migrate, closeDatabase } from '../server/storage/repository.mjs';
import { riotCredentialFingerprint } from '../server/riot/rate-limit.mjs';
import { runRiotCollection } from './collect-riot.mjs';

export const WORKER_JOB_KEY = 'riot:kr:worker:v1';
const parseJSON = value => typeof value === 'string' ? JSON.parse(value) : value;
const integer = (value, fallback, min, max) => {
  const number = Number(value || fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw Object.assign(new Error('RIOT_WORKER_CONFIG_INVALID'), { code: 'RIOT_WORKER_CONFIG_INVALID' });
  return number;
};
export function workerConfig(env = process.env) {
  return { intervalMs: integer(env.RIOT_COLLECTION_INTERVAL_HOURS, 24, 1, 168) * 3600000,
    maxMatches: integer(env.RIOT_COLLECTION_MAX_MATCHES, 25, 1, 100), seedCount: integer(env.RIOT_COLLECTION_SEEDS, 3, 1, 10) };
}

export function workerIsDue(state, fingerprint, now = Date.now()) {
  if (!state) return true;
  if (['RIOT_AUTHENTICATION_FAILED', 'RIOT_KEY_MISSING'].includes(state.errorCode) && state.credentialFingerprint !== fingerprint) return true;
  return !Number.isFinite(Date.parse(state.nextAttemptAt)) || now >= Date.parse(state.nextAttemptAt);
}

export async function workerTick({ db, key, config, run = runRiotCollection, now = () => Date.now() }) {
  const [rows] = await db.execute('SELECT payload FROM riot_collection_jobs WHERE job_key=?', [WORKER_JOB_KEY]);
  const state = rows[0] ? parseJSON(rows[0].payload) : null;
  const fingerprint = key?.trim() ? riotCredentialFingerprint(key) : 'missing';
  if (!workerIsDue(state, fingerprint, now())) return { status: 'waiting', nextAttemptAt: state.nextAttemptAt };
  let report;
  try { report = await run({ allowProvider: true, maxMatches: config.maxMatches, seedCount: config.seedCount }); }
  catch (error) { report = { status: 'failed', requests: 0, error: { code: /^RIOT_[A-Z_]+$/.test(error.code || '') ? error.code : 'RIOT_COLLECTION_FAILED' } }; }
  if (report.status === 'already_running') return report;
  const errorCode = report.error?.code || null;
  const finishedAt = new Date(now()).toISOString();
  const nextAttemptAt = new Date(now() + Math.max(config.intervalMs, (report.error?.retryAfterSeconds || 0) * 1000)).toISOString();
  const updated = { version: 1, lastAttemptAt: finishedAt, lastSuccessAt: report.status === 'completed' ? finishedAt : state?.lastSuccessAt || null,
    nextAttemptAt, errorCode, credentialFingerprint: fingerprint, intervalHours: config.intervalMs / 3600000, maximumMatchDetails: config.maxMatches,
    lastReport: report };
  await db.execute('INSERT INTO riot_collection_jobs(job_key,payload) VALUES(?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)', [WORKER_JOB_KEY, JSON.stringify(updated)]);
  return { ...report, nextAttemptAt };
}

export async function startRiotWorker() {
  if (!process.argv.includes('--allow-provider')) throw Object.assign(new Error('RIOT_PROVIDER_NOT_AUTHORIZED'), { code: 'RIOT_PROVIDER_NOT_AUTHORIZED' });
  const config = workerConfig();
  const db = await getPool();
  await migrate(db);
  let stopping = false;
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; controller.abort(); });
  while (!stopping) {
    try {
      const report = await workerTick({ db, key: process.env.RIOT_API_KEY, config });
      if (report.status !== 'waiting') console.log(JSON.stringify({ kind: 'riot_collection', ...report }));
    } catch { console.error(JSON.stringify({ kind: 'riot_collection', status: 'failed', code: 'RIOT_WORKER_STATE_UNAVAILABLE' })); }
    if (!stopping) await sleep(60000, undefined, { signal: controller.signal }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setDefaultResultOrder('ipv4first');
  try { await startRiotWorker(); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: /^RIOT_[A-Z_]+$/.test(error.code || '') ? error.code : 'RIOT_WORKER_FAILED' })); process.exitCode = 1; }
  finally { await closeDatabase(); }
}
