import { getOPGGChampionBuild as getChampionBuild } from './data.mjs';
import { selectConditionalBuilds } from '../public/build-query.js';
import { compareResearchRows, researchAggregatePlan } from '../public/research-query.js';

const unsupported = '出装组合查询针对同一棋子；多个队友或激活羁绊请切换“同局阵容（Riot）”。当前条件会保留。';
const compReason = 'OP.GG 三件套记录没有同局队友名单。查看同时上场的队友与阵容，请切换“同局阵容（Riot）”。';
function emptyColumn(label, status, reason, extra = {}) { return { rows: [], count: 0, label, status, reason, evidence: null, ...extra }; }

/** Generic adapter over the same published source rows as the big-data browser.
 * No item/champion names, fixed answers, new snapshots or marginal-stat joins.
 */
export async function getAggregateResearchResults(query, catalog, dependencies = {}) {
  const plan = researchAggregatePlan(query);
  const base = { schemaVersion: 2, query, source: 'opgg', querySemantics: 'same_champion_observed_build',
    jointMatchQueries: false, coverage: { jointMatchQueries: false, qualifiedBuilds: 0, matchedChampions: 0 },
    equipment: emptyColumn('满足条件的完整三件套', 'not_supported', unsupported, { kind: 'observed_builds' }),
    teammates: emptyColumn('棋子与对应三件套', 'not_supported', unsupported, { kind: 'build_carriers' }),
    comps: emptyColumn('同局阵容', 'not_supported', compReason),
    note: '每行指标属于所示棋子携带完整三件套的来源统计。棋子栏展示各棋子在当前排序下的首位组合；不合计样本，不作为英雄整体胜率。' };
  if (!plan) return { ...base, status: 'not_supported', reason: unsupported };
  const champions = plan.championId ? catalog.champions.filter(hero => hero.id === plan.championId) : catalog.champions;
  const read = dependencies.getChampionBuild || getChampionBuild;
  // All calls are to published local snapshots; no request can collect upstream data.
  // Let transport failures reject the request, rather than misreporting zero samples.
  const sources = await Promise.all(champions.map(async hero => ({ hero, source: await read(hero.id) })));
  const live = sources.filter(({ source }) => ['live', 'cached'].includes(source.status));
  const releases = new Set(live.map(({ source }) => source.evidence?.releaseId).filter(Boolean));
  const patches = new Set(live.map(({ source }) => source.evidence?.effectivePatch || source.evidence?.sourcePatch).filter(Boolean));
  if (releases.size > 1 || patches.size > 1) throw Object.assign(new Error('查询期间资料版本发生变化，请重试。'), { status: 503, code: 'RESEARCH_RELEASE_CHANGED' });
  const selected = live.map(({ hero, source }) => {
    const result = selectConditionalBuilds(source.data, { ...plan, championId: hero.id }, catalog);
    return { ...result, evidence: source.evidence, rows: result.data.map(row => ({ ...row, evidence: row.evidence || source.evidence,
      statisticScope: 'champion_occurrences_with_exact_three_item_build' })) };
  });
  const invalid = selected.find(result => result.status === 'invalid');
  if (invalid) return { ...base, status: 'invalid', reason: invalid.reason,
    equipment: { ...base.equipment, status: 'invalid', reason: invalid.reason },
    teammates: { ...base.teammates, status: 'invalid', reason: invalid.reason } };
  const rows = selected.flatMap(result => result.rows).sort((a, b) => compareResearchRows(a, b, query.sort) || a.id.localeCompare(b.id));
  const carriers = new Map();
  for (const row of rows) {
    const previous = carriers.get(row.championId);
    if (previous) previous.qualifyingBuildCount++;
    else carriers.set(row.championId, { ...row, qualifyingBuildCount: 1 });
  }
  const missing = sources.filter(({ source }) => !['live', 'cached'].includes(source.status));
  const beforeMinimum = selected.reduce((count, result) => count + result.selection.matchedRows, 0);
  const status = !live.length ? 'unavailable' : missing.length ? 'partial' : rows.length ? 'ok' : beforeMinimum ? 'insufficient_samples' : 'empty';
  const reason = !live.length ? '当前版本没有可用的 OP.GG 出装资料。'
    : !rows.length ? beforeMinimum ? '已收录对应组合，但没有达到当前最低样本数；可调整样本门槛。' : '当前已收录出装中没有满足全部条件的完整三件套。'
      : missing.length ? `当前有 ${missing.length} 名棋子的来源资料不可用，结果限于已收录资料。` : null;
  const evidence = rows[0]?.evidence || live[0]?.source.evidence || null;
  return { ...base, status, reason, evidence, delivery: evidence?.delivery || null,
    selection: { mode: 'observed_conditional_three_item_builds', metric: query.sort, minimumSampleSize: query.minSample,
      matchedRows: beforeMinimum, qualifiedRows: rows.length, samplesCombined: false },
    equipment: { ...base.equipment, status, reason, evidence, rows: rows.slice(0, 30), count: rows.length },
    teammates: { ...base.teammates, status, reason, evidence, rows: [...carriers.values()], count: carriers.size,
      label: '各棋子排序首位三件套 · 指标仅属于所示组合' },
    coverage: { jointMatchQueries: false, requestedChampions: champions.length, availableSnapshots: live.length,
      unavailableSnapshots: missing.length, matchedBuildsBeforeMinimum: beforeMinimum, qualifiedBuilds: rows.length, matchedChampions: carriers.size },
  };
}
