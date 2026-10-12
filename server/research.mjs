import { getCatalog, getMetaDecks } from './data.mjs';
import { getConditionalChampionBuild } from './conditional-builds.mjs';
import { validateResearchQuery, matchesResearchDeck, compareResearchRows, researchBuildQuery, researchAggregatePlan } from '../public/research-query.js';
import { getAggregateResearchResults } from './research-aggregates.mjs';
import { isDatabaseMode } from './storage/runtime.mjs';
import { getRiotResearchResults } from './riot/query.mjs';
import { getMetaTftResearchResults } from './metatft/query.mjs';

export async function getResearchResults(input, dependencies = {}) {
  const catalog = await (dependencies.getCatalog || getCatalog)();
  const validation = validateResearchQuery(input, catalog);
  if (!validation.valid) throw Object.assign(new Error(validation.reason), { status: 400, code: 'INVALID_RESEARCH_QUERY' });
  const { query } = validation;
  const databaseMode=dependencies.databaseMode ?? isDatabaseMode();
  if (query.dataSource === 'metatft' || databaseMode && dependencies.allowMetaTft !== false && dependencies.allowAggregate !== false && (!query.dataSource || query.dataSource === 'auto')) {
    return (dependencies.getMetaTftResearchResults || getMetaTftResearchResults)(query, catalog, dependencies.metatft || {});
  }
  if(query.rank != null)throw Object.assign(new Error('段位筛选需要使用 MetaTFT，不能忽略段位条件。'),{status:400,code:'INVALID_STAT_RANK'});
  if (dependencies.allowAggregate !== false && query.dataSource !== 'riot'
    && (query.dataSource === 'opgg' || researchAggregatePlan(query))) {
    return (dependencies.getAggregateResearchResults || getAggregateResearchResults)(query, catalog, dependencies);
  }
  if (databaseMode) {
    const riot = await (dependencies.getRiotResearchResults || getRiotResearchResults)(query, catalog, dependencies.riot || {});
    // An empty Riot condition result must never be replaced by unrelated aggregate data.
    if (riot !== null) return riot;
  }
  const source = databaseMode
    ? {status:'not_supported',code:'joint_statistics_unavailable',data:[],evidence:null,reason:'当前来源没有逐局联合样本，暂不支持这些条件下的队友和阵容统计；不会用十套来源阵容代替对局样本。'}
    : await (dependencies.getMetaDecks || getMetaDecks)();
  const matched = (source.data || []).filter(deck => matchesResearchDeck(deck, query));
  const decks = matched.filter(deck => !query.minSample || Number.isFinite(deck.stats?.sampleSize) && deck.stats.sampleSize >= query.minSample).sort((a,b) => compareResearchRows(a,b,query.sort));
  const selected = new Set(query.conditions.filter(t => t.type === 'champion').map(t => t.id));
  const teammates = new Map(), equipment = new Map();
  for (const deck of decks) for (const unit of deck.units) {
    const id = unit.championId || unit.id;
    if (!selected.has(id)) {
      if (!teammates.has(id)) teammates.set(id, { championId: id, deckIds: [] });
      if (!teammates.get(id).deckIds.includes(deck.id)) teammates.get(id).deckIds.push(deck.id);
    }
    if (selected.size && !selected.has(id)) continue;
    const ids = (unit.items || []).map(v => typeof v === 'string' ? v : v?.id || v?.itemId).filter(Boolean);
    if (!ids.length) continue;
    const key = [id, ...ids.slice().sort()].join(':');
    if (!equipment.has(key)) equipment.set(key, { championId: id, itemIds: ids, deckIds: [] });
    if (!equipment.get(key).deckIds.includes(deck.id)) equipment.get(key).deckIds.push(deck.id);
  }
  const buildQuery = query.conditions.length ? researchBuildQuery(query) : null;
  const builds = buildQuery ? await (dependencies.getConditionalChampionBuild || getConditionalChampionBuild)(buildQuery) : null;
  const status=databaseMode&&builds?(builds.status==='ok'?'partial':builds.status):source.status||'ok';
  const reason=databaseMode&&builds?(builds.status==='ok'?'装备组合有可用统计；队友和阵容尚无联合样本。':builds.reason):source.reason;
  return { schemaVersion: 2, query, delivery: databaseMode?'mysql':'version_cache', status, reason,
    equipment: builds ? { kind: 'observed_builds', rows: builds.data.slice(0, 30), count: builds.data.length, evidence: builds.evidence,
      status: builds.status, reason: builds.reason, label: '满足条件的完整三件套' }
      : { kind: 'source_lineups', rows: [...equipment.values()].sort((a,b) => b.deckIds.length-a.deckIds.length).slice(0,30), count: equipment.size, label: '匹配阵容中的出装', evidence: source.evidence,status:source.status,reason:source.reason },
    teammates: { rows: [...teammates.values()].sort((a,b) => b.deckIds.length-a.deckIds.length), label: '匹配阵容中的队友', evidence: source.evidence, status:source.status,reason: source.reason },
    comps: { rows: decks, count: decks.length, matchedBeforeMinimum: matched.length, evidence: source.evidence, status:source.status,reason: source.reason },
    coverage: { sourceComps: source.data?.length || 0, jointMatchQueries: false },
    note: databaseMode?'单英雄装备组合按当前统计归档版本查询；推定版本会单独标注。任意多条件统计需要真实联合样本。':'队友与推荐阵容来自同时满足全部条件的已收录阵容；队友数量为阵容方案数，不是对局次数。没有匹配时不放宽条件。',
  };
}
