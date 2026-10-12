import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { createRiotRateLimiter } from './riot-rate-limiter.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOSTS = new Set(['kr.api.riotgames.com', 'asia.api.riotgames.com']);
const defaultLimiter = createRiotRateLimiter();
const safeError = (code, status = null, retryAfter = null) => Object.assign(new Error(code), { code, status, retryAfter });

// This small probe has a fixed request budget; it is not a production collector.
export async function riotGet(url, key, { fetchImpl = fetch, limiter = defaultLimiter } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !HOSTS.has(target.hostname) || target.port || target.username || target.password
    || target.hash || target.searchParams.has('api_key') || !target.pathname.startsWith('/tft/')) throw safeError('RIOT_URL_REJECTED');
  if (!key?.trim()) throw safeError('RIOT_KEY_MISSING');
  await limiter.acquire();
  let response;
  try {
    response = await fetchImpl(target.href, { headers: { 'X-Riot-Token': key.trim(), Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch { throw safeError('RIOT_NETWORK_ERROR'); }
  if (!response.ok) {
    const delay = response.headers.get('retry-after');
    const retryAfter = /^\d+$/.test(delay || '') && Number.isFinite(Number(delay)) ? Number(delay) : null;
    if (response.status === 429) limiter.cooldown(retryAfter);
    throw safeError(response.status === 429 ? 'RIOT_RATE_LIMITED' : response.status === 401 || response.status === 403
      ? 'RIOT_AUTHENTICATION_FAILED' : 'RIOT_HTTP_ERROR', response.status, retryAfter);
  }
  try { return await response.json(); } catch { throw safeError('RIOT_INVALID_JSON', response.status); }
}

export async function probeRiot({ key, previousLeagueFile = null } = {}) {
  const startedAt = new Date().toISOString();
  const directory = join(ROOT, 'data/raw/riot-probes', startedAt.replace(/[:.]/g, '-'));
  await mkdir(join(directory, 'matches'), { recursive: true });
  const report = { checkedAt: startedAt, status: 'running', platform: 'kr', region: 'asia',
    requestedQueue: 1100, scope: 'top_three_challenger_seed_players_recent_48h',
    maximumMatchDetails: 12, requests: [], matchesFetched: 0, databaseModified: false,
    rateLimit: { scope: 'single_process_shared_hosts', requestsPerSecond: 20, requestsPer120Seconds: 100, minimumSpacingMs: 1350 } };
  const get = async (url, kind) => {
    try { const body = await riotGet(url, key); report.requests.push({ kind, httpStatus: 200 }); return body; }
    catch (error) { report.requests.push({ kind, httpStatus: error.status ?? null, error: error.code }); throw error; }
  };
  try {
    let league;
    if (previousLeagueFile) {
      const allowed = resolve(ROOT, 'data/raw/riot-probes');
      const candidate = resolve(ROOT, previousLeagueFile);
      if (!candidate.startsWith(allowed + '/') && !candidate.startsWith(allowed + '\\')) throw safeError('RIOT_SEED_PATH_REJECTED');
      league = JSON.parse(await readFile(candidate, 'utf8'));
      const age = Date.now() - Date.parse(league.fetchedAt);
      if (league.platform !== 'kr' || !Number.isFinite(age) || age < 0 || age > 3600000) throw safeError('RIOT_SEED_EXPIRED');
      report.leagueReused = true;
    } else {
      league = { platform: 'kr', fetchedAt: new Date().toISOString(), body: await get('https://kr.api.riotgames.com/tft/league/v1/challenger', 'challenger_league') };
    }
    await writeFile(join(directory, 'league.json'), JSON.stringify(league));
    if (league.body?.queue !== 'RANKED_TFT' || !Array.isArray(league.body.entries)) throw safeError('RIOT_LEAGUE_SCHEMA_INVALID');
    report.leagueEntries = league.body.entries.length;
    const players = [...new Map(league.body.entries.filter(row => typeof row.puuid === 'string' && row.puuid)
      .sort((a, b) => Number(b.leaguePoints || 0) - Number(a.leaguePoints || 0)).map(row => [row.puuid, row])).values()].slice(0, 3);
    if (!players.length) throw safeError('RIOT_NO_SEED_PLAYERS');
    report.seedPlayers = players.length;
    const ids = new Set(), since = Math.floor(Date.now() / 1000) - 48 * 3600;
    for (let index = 0; index < players.length; index++) {
      const list = await get(`https://asia.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(players[index].puuid)}/ids?start=0&count=5&startTime=${since}`, 'match_ids');
      if (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !/^KR_\d+$/.test(id))) throw safeError('RIOT_MATCH_IDS_INVALID');
      await writeFile(join(directory, `match-list-${index + 1}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), body: list }));
      list.forEach(id => ids.add(id));
    }
    report.uniqueMatchIds = ids.size;
    let index = 0;
    for (const id of [...ids].slice(0, report.maximumMatchDetails)) {
      const body = await get(`https://asia.api.riotgames.com/tft/match/v1/matches/${encodeURIComponent(id)}`, 'match_detail');
      if (body?.metadata?.match_id !== id || !body.info || !Array.isArray(body.info.participants)) throw safeError('RIOT_MATCH_SCHEMA_INVALID');
      await writeFile(join(directory, 'matches', `${String(++index).padStart(2, '0')}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), body }));
      report.matchesFetched++;
    }
    report.status = report.matchesFetched ? 'captured' : 'no_recent_matches';
  } catch (error) {
    report.status = 'failed';
    report.error = { code: error.code?.startsWith('RIOT_') ? error.code : 'RIOT_PROBE_FAILED', httpStatus: error.status ?? null, retryAfterSeconds: error.retryAfter ?? null };
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2));
  return { ...report, captureDirectory: directory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--allow-provider') || args.some(arg => arg !== '--allow-provider' && !arg.startsWith('--league-file='))) {
    console.error('Use node --env-file=.env.docker scripts/probe-riot.mjs --allow-provider [--league-file=data/raw/riot-probes/.../league.json]');
    process.exitCode = 2;
  } else {
    setDefaultResultOrder('ipv4first');
    try {
      const report = await probeRiot({ key: process.env.RIOT_API_KEY,
        previousLeagueFile: args.find(arg => arg.startsWith('--league-file='))?.slice('--league-file='.length) });
      console.log(JSON.stringify(report, null, 2));
      if (report.status === 'failed') process.exitCode = 1;
    } catch { console.error(JSON.stringify({ status: 'failed', code: 'RIOT_PROBE_FAILED' })); process.exitCode = 1; }
  }
}
