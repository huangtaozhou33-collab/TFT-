import { getPool, getActiveRelease } from '../storage/repository.mjs';
import { validateResearchQuery } from '../../public/research-query.js';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const counts = values => values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
const ordering = { avgPlacement: 'avg_placement ASC', top4Rate: 'top4_rate DESC', winRate: 'win_rate DESC', sampleSize: 'sample_size DESC' };
const joinParticipant = (left, right) => `${left}.match_id=${right}.match_id AND ${left}.participant_index=${right}.participant_index`;

/** All predicates are correlated to one player's terminal board, never to the lobby. */
export function buildRiotParticipantFilter(query, release) {
  const clauses = ["m.status='ready'", 'm.queue_id=1100', 'm.season=?', 'COALESCE(m.source_patch,m.assigned_patch)=?'];
  const params = [release.season, release.currentPatch];
  for (const id of new Set(query.conditions.filter(term => term.type === 'champion').map(term => term.id))) {
    clauses.push(`EXISTS (SELECT 1 FROM riot_units cu WHERE ${joinParticipant('cu', 'p')} AND cu.champion_id=?)`);
    params.push(id);
  }
  for (const id of new Set(query.conditions.filter(term => term.type === 'trait').map(term => term.id))) {
    clauses.push(`EXISTS (SELECT 1 FROM riot_traits ct WHERE ${joinParticipant('ct', 'p')} AND ct.trait_id=? AND ct.style>0 AND ct.tier_current>0)`);
    params.push(id);
  }
  const items = query.conditions.filter(term => term.type === 'item');
  // Bound and unbound occurrences both consume copies in the complete board.
  for (const [id, needed] of counts(items.map(term => term.id))) {
    clauses.push(`(SELECT COUNT(*) FROM riot_unit_items ci WHERE ${joinParticipant('ci', 'p')} AND ci.item_id=?)>=?`);
    params.push(id, needed);
  }
  for (const holder of new Set(items.map(term => term.holderId).filter(Boolean))) {
    const required = [];
    const holderParams = [holder];
    for (const [id, needed] of counts(items.filter(term => term.holderId === holder).map(term => term.id))) {
      required.push(`(SELECT COUNT(*) FROM riot_unit_items hi WHERE ${joinParticipant('hi', 'hu')} AND hi.unit_index=hu.unit_index AND hi.item_id=?)>=?`);
      holderParams.push(id, needed);
    }
    clauses.push(`EXISTS (SELECT 1 FROM riot_units hu WHERE ${joinParticipant('hu', 'p')} AND hu.champion_id=? AND ${required.join(' AND ')})`);
    params.push(...holderParams);
  }
  return { sql: clauses.join(' AND '), params };
}

const aggregate = 'COUNT(*) AS sample_size,AVG(placement) AS avg_placement,AVG(placement<=4) AS top4_rate,AVG(placement=1) AS win_rate';
function stats(row) {
  return { sampleSize: Number(row.sample_size), avgPlacement: Number(row.avg_placement), top4Rate: Number(row.top4_rate), winRate: Number(row.win_rate) };
}
function sampled(row, query) {
  const value = stats(row), lowSample = value.sampleSize < query.minSample;
  return { stats: value, lowSample, ...(lowSample ? { warning: `样本仅 ${value.sampleSize} 份玩家终局，少于提示阈值 ${query.minSample}，结果可能不稳定。` } : {}) };
}

/** Null means no published current-patch Riot observations; an empty result is authoritative. */
export async function getRiotResearchResults(input, catalog, dependencies = {}) {
  const validation = validateResearchQuery(input, catalog);
  if (!validation.valid) throw Object.assign(new Error(validation.reason), { status: 400, code: 'INVALID_RESEARCH_QUERY' });
  const { query } = validation;
  const db = dependencies.db || await (dependencies.getPool || getPool)();
  if (typeof db.getConnection !== 'function') return readRiotResearchResults(query, catalog, db, dependencies);
  const connection = await db.getConnection();
  try {
    // A collector may commit between columns; the whole response must see one publication snapshot.
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const result = await readRiotResearchResults(query, catalog, connection, dependencies);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}

async function readRiotResearchResults(query, catalog, db, dependencies) {
  const release = dependencies.release || await (dependencies.getActiveRelease || getActiveRelease)(db);
  if (!release) return null;
  const scopeParams = [release.season, release.currentPatch];
  const [[available]] = await db.execute(`SELECT COUNT(*) AS matches FROM riot_matches m WHERE m.status='ready' AND m.queue_id=1100 AND m.season=? AND COALESCE(m.source_patch,m.assigned_patch)=?`, scopeParams);
  if (!Number(available.matches)) return null;
  const filter = buildRiotParticipantFilter(query, release);
  const cte = `WITH matched AS (SELECT p.*,m.source_patch,m.assigned_patch,m.platform,m.fetched_at,m.game_started_at
    FROM riot_participants p JOIN riot_matches m ON m.match_id=p.match_id WHERE ${filter.sql})`;
  const [[summary]] = await db.execute(`${cte} SELECT COUNT(*) AS participants,COUNT(DISTINCT match_id) AS matches,
    SUM(source_patch IS NOT NULL) AS source_declared,SUM(source_patch IS NULL AND assigned_patch IS NOT NULL) AS assigned,
    GROUP_CONCAT(DISTINCT platform ORDER BY platform) AS platforms,MIN(game_started_at) AS first_game,MAX(game_started_at) AS last_game,MAX(fetched_at) AS fetched_at FROM matched`, filter.params);
  const evidence = {
    source: 'Riot Games Match API', url: 'https://developer.riotgames.com/apis#tft-match-v1/GET_getMatch', delivery: 'mysql',
    sourcePatch: Number(summary.participants) && !Number(summary.assigned) ? release.currentPatch : null,
    assignedPatch: Number(summary.assigned) ? release.currentPatch : null, effectivePatch: release.currentPatch,
    patchAttribution: { sourceDeclaredParticipants: Number(summary.source_declared || 0), assignedParticipants: Number(summary.assigned || 0), method: Number(summary.assigned) ? 'calendar_and_page_inference' : Number(summary.participants) ? 'source_declared' : null, hotfix: null },
    patchAssignment: Number(summary.assigned) ? { method: 'calendar_and_page_inference', label: '按比赛时间推定主补丁', hotfix: null, note: '部分或全部比赛的来源版本字段没有可用补丁；根据比赛发生时间、官方计划日期与来源页面构成的保守比赛时间窗口推定主补丁。地区精确换版时间与热修未知，不是按采集日期补填。' } : null,
    set: release.season, queue: 'RANKED_TFT', queueId: 1100, platforms: summary.platforms?.split(',') || [], rank: null,
    population: '本项目通过种子玩家采集的排位比赛；不是随机总体样本，不代表对局时段位。',
    sampleDenominator: '每个组合内去重的玩家终局记录；不同组合可能重叠。',
    statisticalWindow: { from: summary.first_game ? new Date(Number(summary.first_game)).toISOString() : null, to: summary.last_game ? new Date(Number(summary.last_game)).toISOString() : null },
    fetchedAt: summary.fetched_at ? new Date(Number(summary.fetched_at)).toISOString() : null,
  };
  const selected = [...new Set(query.conditions.filter(term => term.type === 'champion').map(term => term.id))];
  const targetIds = query.carrierId ? [query.carrierId] : selected;
  const targetClause = targetIds.length ? ` AND u.champion_id IN (${targetIds.map(() => '?').join(',')})` : '';
  // If a selected holder has two copies, only the actual copy satisfying its bound items can be a build candidate.
  const buildClauses = [], buildParams = [];
  for (const holder of new Set(query.conditions.filter(term => term.type === 'item').map(term => term.holderId).filter(Boolean))) {
    const requirements = [];
    buildParams.push(holder);
    for (const [id, needed] of counts(query.conditions.filter(term => term.type === 'item' && term.holderId === holder).map(term => term.id))) {
      requirements.push(`(SELECT COUNT(*) FROM riot_unit_items bi WHERE ${joinParticipant('bi', 'u')} AND bi.unit_index=u.unit_index AND bi.item_id=?)>=?`);
      buildParams.push(id, needed);
    }
    buildClauses.push(`(u.champion_id<>? OR (${requirements.join(' AND ')}))`);
  }
  const order = ordering[query.sort] || ordering.avgPlacement;
  const [buildRows] = await db.execute(`${cte}, observations AS (
    SELECT p.match_id,p.participant_index,p.placement,u.champion_id,u.build_key,MIN(CAST(u.item_ids AS CHAR)) AS item_ids
    FROM matched p JOIN riot_units u ON ${joinParticipant('u', 'p')}
    WHERE u.valid_build=1${targetClause}${buildClauses.length ? ` AND ${buildClauses.join(' AND ')}` : ''}
    GROUP BY p.match_id,p.participant_index,p.placement,u.champion_id,u.build_key)
    SELECT champion_id,build_key,MIN(item_ids) AS item_ids,${aggregate},COUNT(*) OVER() AS total_rows
    FROM observations GROUP BY champion_id,build_key ORDER BY ${order},sample_size DESC,champion_id,build_key LIMIT 100`, [...filter.params, ...targetIds, ...buildParams]);
  const [teammateRows] = await db.execute(`${cte}, observations AS (
    SELECT DISTINCT p.match_id,p.participant_index,p.placement,u.champion_id FROM matched p JOIN riot_units u ON ${joinParticipant('u', 'p')}
    ${selected.length ? `WHERE u.champion_id NOT IN (${selected.map(() => '?').join(',')})` : ''})
    SELECT champion_id,${aggregate},COUNT(*) OVER() AS total_rows FROM observations GROUP BY champion_id
    ORDER BY ${order},sample_size DESC,champion_id LIMIT 100`, [...filter.params, ...selected]);
  const [compRows] = await db.execute(`${cte} SELECT composition_key,MIN(CAST(units_json AS CHAR)) AS units_json,
    ${aggregate},COUNT(*) OVER() AS total_rows FROM matched GROUP BY composition_key ORDER BY ${order},sample_size DESC,composition_key LIMIT 100`, filter.params);
  const status = Number(summary.participants) ? 'ok' : 'empty';
  const reason = status === 'empty' ? '当前补丁已采集的 Riot 排位比赛中，没有同时满足全部条件的玩家终局；未放宽条件或切换来源。' : null;
  const column = (rows, raw) => ({ rows, count: Number(raw[0]?.total_rows || 0), evidence, status: rows.length ? 'ok' : 'empty', reason: rows.length ? null : reason || '匹配玩家终局中没有这类可用记录。' });
  return {
    schemaVersion: 2, query, delivery: 'mysql', source: 'riot', status, reason, evidence,
    querySemantics: 'same_participant_terminal_board', jointMatchQueries: true,
    selection: { mode: 'same_participant_joint_matches', metric: query.sort, direction: query.sort === 'avgPlacement' ? 'asc' : 'desc',
      minimumSampleSize: 0, lowSampleWarningThreshold: query.minSample, matchedRows: Number(summary.participants),
      basis: '先按完整条件筛选同一玩家终局，再对每个组合的去重样本排序；样本阈值仅提示，不删除小样本。' },
    equipment: { ...column(buildRows.map(row => ({ id: `riot:${row.champion_id}:${row.build_key}`, championId: row.champion_id, itemIds: parse(row.item_ids), ...sampled(row, query) })), buildRows), kind: 'observed_builds', label: '满足全部条件的实际三件套' },
    teammates: { ...column(teammateRows.map(row => ({ championId: row.champion_id, ...sampled(row, query) })), teammateRows), label: '同一玩家终局中的队友' },
    comps: { ...column(compRows.map(row => {
      const units = (parse(row.units_json) || []).map(unit => {
        const id = unit.championId || unit.character_id || unit.id;
        return { id, championId: id, name: catalog.champions.find(champion => champion.id === id)?.name || id, items: [] };
      });
      return { id: `riot:${row.composition_key}`, name: units.map(unit => unit.name).join(' · '), units, traits: [], evidence, ...sampled(row, query) };
    }), compRows), matchedBeforeMinimum: Number(summary.participants), label: '实际终局阵容（棋子组合）' },
    coverage: { jointMatchQueries: true, sourceMatches: Number(available.matches), matchedMatches: Number(summary.matches), matchedParticipants: Number(summary.participants), currentPatch: release.currentPatch },
    note: '仅统计当前归档补丁、同一玩家终局同时满足全部条件的普通排位记录；样本不足仍展示并提示。装备按英雄与三件套去重，阵容按终局棋子组合统计；不是运营过程或因果结论。',
  };
}
