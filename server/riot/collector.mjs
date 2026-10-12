export const COLLECTOR_JOB_KEY = 'riot:kr:collector:v1';
const fail = code => Object.assign(new Error(code), { code });
const parseJSON = value => typeof value === 'string' ? JSON.parse(value) : value;
const validId = id => typeof id === 'string' && /^KR_\d+$/.test(id);

export function createCollectorStore(db) {
  return {
    async load() {
      const [rows] = await db.execute('SELECT payload FROM riot_collection_jobs WHERE job_key=?', [COLLECTOR_JOB_KEY]);
      return rows[0] ? parseJSON(rows[0].payload) : null;
    },
    async save(state) {
      await db.execute('INSERT INTO riot_collection_jobs(job_key,payload) VALUES(?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)', [COLLECTOR_JOB_KEY, JSON.stringify(state)]);
    },
    async existing(ids) {
      if (!ids.length) return new Set();
      const [rows] = await db.execute(`SELECT match_id FROM riot_matches WHERE match_id IN (${ids.map(() => '?').join(',')})`, ids);
      return new Set(rows.map(row => row.match_id));
    }
  };
}

export function publicCollectorState(state) {
  return {
    pendingMatches: state?.pending?.length || 0, trackedSeeds: state?.seeds?.length || 0,
    lastStartedAt: state?.lastStartedAt || null, lastFinishedAt: state?.lastFinishedAt || null,
    lastStatus: state?.lastReport?.status || 'not_started', lastReport: state?.lastReport || null,
    discoveryComplete: Boolean(state?.cycle?.complete)
  };
}

// The caller owns the MySQL advisory lock for the entire run. Each page and each
// imported detail is checkpointed, so an interruption never advances past lost IDs.
export async function collectRiot({ client, store, importMatch, maxMatches = 25, seedCount = 3, maxListPages = 10,
  now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100) throw fail('RIOT_INVALID_MATCH_BUDGET');
  if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 10) throw fail('RIOT_INVALID_SEED_BUDGET');
  if (!Number.isInteger(maxListPages) || maxListPages < 1 || maxListPages > 20) throw fail('RIOT_INVALID_PAGE_BUDGET');
  const state = await store.load() || { version: 1, pending: [], seeds: [], cycle: null };
  if (state.version !== 1 || !Array.isArray(state.pending) || !Array.isArray(state.seeds)
    || state.pending.length > 2000 || state.pending.some(id => !validId(id))) throw fail('RIOT_COLLECTOR_STATE_INVALID');
  const report = { status: 'running', startedAt: new Date(now()).toISOString(), platform: 'kr', region: 'asia',
    requests: 0, discovered: 0, fetched: 0, imported: 0, reclassified: 0, duplicates: 0, conflicts: 0, skippedExisting: 0,
    maximumMatchDetails: maxMatches, queuePolicy: 'store_all_validate_ranked_for_statistics', seedPolicy: 'current_challenger_seeds_not_match_time_rank' };
  state.lastStartedAt = report.startedAt;
  await store.save(state);
  const get = async url => { report.requests++; return client.get(url); };
  async function drain() {
    while (state.pending.length && report.fetched < maxMatches) {
      const id = state.pending[0];
      if ((await store.existing([id])).has(id)) {
        report.skippedExisting++; state.pending.shift(); await store.save(state); continue;
      }
      const body = await get(`https://asia.api.riotgames.com/tft/match/v1/matches/${encodeURIComponent(id)}`);
      if (body?.metadata?.match_id !== id || !Array.isArray(body.info?.participants)) throw fail('RIOT_MATCH_SCHEMA_INVALID');
      report.fetched++;
      const result = await importMatch({ body, fetchedAt: new Date(now()).toISOString() });
      if (!['imported', 'reclassified', 'duplicate', 'conflict'].includes(result.status)) throw fail('RIOT_IMPORT_RESULT_INVALID');
      report[({ imported: 'imported', reclassified: 'reclassified', duplicate: 'duplicates', conflict: 'conflicts' })[result.status]]++;
      state.pending.shift();
      await store.save(state);
    }
  }
  try {
    await drain();
    if (report.fetched < maxMatches) {
      if (!state.cycle || state.cycle.complete) {
        const league = await get('https://kr.api.riotgames.com/tft/league/v1/challenger');
        if (league?.queue !== 'RANKED_TFT' || !Array.isArray(league.entries)) throw fail('RIOT_LEAGUE_SCHEMA_INVALID');
        const prior = new Map(state.seeds.map(seed => [seed.puuid, seed]));
        const entries = [...league.entries].filter(row => typeof row.puuid === 'string' && row.puuid)
          .sort((a, b) => Number(b.leaguePoints || 0) - Number(a.leaguePoints || 0));
        const players = [...new Map(entries.map(row => [row.puuid, row])).values()].slice(0, seedCount);
        if (!players.length) throw fail('RIOT_NO_SEED_PLAYERS');
        const endTime = Math.floor(now() / 1000);
        state.seeds = players.map(row => ({ puuid: row.puuid, start: 0, complete: false,
          fromTime: Math.max(0, (prior.get(row.puuid)?.lastCompleteTime || endTime - 48 * 3600) - 3600),
          lastCompleteTime: prior.get(row.puuid)?.lastCompleteTime || null }));
        state.cycle = { endTime, complete: false };
        await store.save(state);
      }
      let pages = 0;
      while (pages < maxListPages && report.fetched < maxMatches && state.pending.length < 1900) {
        const seed = state.seeds.find(row => !row.complete);
        if (!seed) { state.cycle.complete = true; await store.save(state); break; }
        const params = new URLSearchParams({ start: String(seed.start), count: '20', startTime: String(seed.fromTime), endTime: String(state.cycle.endTime) });
        const ids = await get(`https://asia.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(seed.puuid)}/ids?${params}`);
        if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => !validId(id))) throw fail('RIOT_MATCH_IDS_INVALID');
        pages++;
        const existing = await store.existing(ids);
        const pending = new Set(state.pending);
        for (const id of ids) {
          if (existing.has(id)) { report.skippedExisting++; continue; }
          if (!pending.has(id)) { state.pending.push(id); pending.add(id); report.discovered++; }
        }
        seed.start += ids.length;
        if (ids.length < 20) { seed.complete = true; seed.lastCompleteTime = state.cycle.endTime; }
        state.cycle.complete = state.seeds.every(row => row.complete);
        await store.save(state);
        await drain();
        if (state.cycle.complete) break;
      }
    }
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = { code: /^RIOT_[A-Z_]+$/.test(error.code || '') ? error.code : 'RIOT_COLLECTION_FAILED',
      httpStatus: Number.isInteger(error.status) ? error.status : null, retryAfterSeconds: error.retryAfter ?? null };
  }
  report.pendingMatches = state.pending.length;
  report.discoveryComplete = Boolean(state.cycle?.complete);
  report.finishedAt = new Date(now()).toISOString();
  state.lastFinishedAt = report.finishedAt;
  state.lastReport = report;
  await store.save(state);
  return report;
}
