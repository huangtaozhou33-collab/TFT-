import { getCatalog, getStatsOverview, getMetaDecks, getChampionBuild, getItemHolders } from './data.mjs';
import { getTraitStats } from './trait-data.mjs';
import { getExplorerOverallStats } from './explorer-overall.mjs';
import { isDatabaseMode } from './storage/runtime.mjs';
import { cacheContext } from '../scripts/stats-cache.mjs';

export const EXPLORER_TABS = new Set(['units', 'equipment', 'decks', 'champions', 'items', 'emblems', 'traits']);

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function rowStats(stats = {}) {
  return {
    sampleSize: finite(stats.sampleSize), avgPlacement: finite(stats.avgPlacement),
    top4Rate: finite(stats.top4Rate), winRate: finite(stats.winRate),
    // The sources have different denominators. A build's pickRate is not the
    // probability of seeing its champion in a match or this query population.
    pickRate: null, avgLevel: null,
  };
}

/** Preserve source rows; never reconstruct a joint match population from marginals. */
export function normalizeExplorerRows(tab, result, catalog, entityId = null) {
  if (!EXPLORER_TABS.has(tab)) throw new Error('Unknown explorer tab');
  const champions = new Map(catalog.champions.map(entity => [entity.id, entity]));
  const items = new Map(catalog.items.map(entity => [entity.id, entity]));
  const traits = new Map(catalog.traits.map(entity => [entity.id, entity]));
  const traitByName = new Map(catalog.traits.map(entity => [entity.name, entity.id]));
  const nativeTraits = champion => (champion.traits || []).map(name => traitByName.get(name)).filter(Boolean);
  const evidence = (row, membership) => ({ ...(row.evidence || result.evidence || {}),
    sourcePickRate: finite(row.stats?.pickRate), traitMembership: membership,
    querySemantics: 'cached_aggregate_row_membership', jointPopulationAvailable: false });
  return (result.data || []).flatMap((row, index) => {
    if (tab === 'units') {
      const champion = champions.get(row.id);
      if (!champion) return [];
      return [{ id: `unit:${champion.id}`, kind: 'champion_overall', name: champion.name, championId: champion.id, cost: champion.cost, icon: champion.icon,
        unitIds: [champion.id], itemIds: [], traitIds: nativeTraits(champion), topItemIds: (row.topItems || []).filter(id => items.has(id)),
        stats: { ...rowStats(row.stats), pickRate: finite(row.stats?.pickRate) },
        evidence: evidence(row, 'catalog_native_champion') }];
    }
    if (tab === 'equipment') {
      const item = items.get(row.id);
      if (!item) return [];
      return [{ id: `equipment:${item.id}`, kind: 'item_overall', name: item.name, itemId: item.id, itemCategory: item.category, icon: item.icon,
        unitIds: [], itemIds: [item.id], traitIds: [],
        stats: { ...rowStats(row.stats), pickRate: finite(row.stats?.pickRate) },
        evidence: evidence(row, 'not_applicable') }];
    }
    if (tab === 'decks') {
      const units = (row.units || []).filter(unit => champions.has(unit.id));
      if (!units.length) return [];
      const itemIds = [...new Set(units.flatMap(unit => unit.items || []).filter(id => items.has(id)))];
      return [{ id: `deck:${row.id}`, kind: 'deck', name: row.name, icon: units.find(unit => unit.isCore)?.icon || units[0].icon,
        unitIds: [...new Set(units.map(unit => unit.id))], itemIds, traitIds: [...new Set((row.traits || []).map(trait => trait.id).filter(id => traits.has(id)))],
        units, traits: row.traits || [], stats: rowStats(row.stats), evidence: evidence(row, 'observed_source_deck') }];
    }
    if (tab === 'traits') {
      const trait = traits.get(row.traitId);
      if (!trait || !Number.isInteger(row.minUnits) || row.minUnits < 1) return [];
      return [{ id: `trait:${row.id}`, kind: 'trait_tier', name: trait.name, icon: trait.icon, traitId: trait.id,
        threshold: row.minUnits, tier: row.tier, unitIds: [], itemIds: [], traitIds: [trait.id],
        stats: rowStats(row.stats), evidence: evidence(row, 'observed_source_trait_tier') }];
    }
    const champion = champions.get(row.championId || row.id);
    if (!champion) return [];
    if (tab === 'champions') {
      if (entityId && champion.id !== entityId || !Array.isArray(row.itemIds) || !row.itemIds.length || row.itemIds.some(id => !items.has(id))) return [];
      return [{ id: `build:${champion.id}:${[...row.itemIds].sort().join('+')}:${index}`, kind: 'champion_build', name: champion.name, icon: champion.icon,
        championId: champion.id, cost: champion.cost, unitIds: [champion.id], itemIds: [...row.itemIds], traitIds: nativeTraits(champion),
        stats: rowStats(row.stats), evidence: evidence(row, 'catalog_native_champion') }];
    }
    const item = items.get(row.itemId || entityId);
    if (!item || tab === 'emblems' && item.category !== 'emblem') return [];
    // A native trait cannot be gained a second time by wearing its emblem.
    if (tab === 'emblems' && (!item.traitId || !traits.has(item.traitId) || nativeTraits(champion).includes(item.traitId))) return [];
    return [{ id: `holder:${item.id}:${champion.id}:${index}`, kind: tab === 'emblems' ? 'emblem_holder' : 'item_holder', name: champion.name, icon: champion.icon,
      championId: champion.id, itemId: item.id, itemName: item.name, itemIcon: item.icon, itemCategory: item.category, cost: champion.cost,
      unitIds: [champion.id], itemIds: [item.id], traitIds: nativeTraits(champion),
      ...(item.category === 'emblem' ? { emblemTraitId: item.traitId || null } : {}),
      stats: rowStats(row.stats), evidence: evidence(row, 'catalog_native_champion') }];
  });
}

export async function getExplorerSnapshot(tab = 'units', options={}) {
  if (!EXPLORER_TABS.has(tab)) throw Object.assign(new Error('不支持的检索维度'), { status: 400, code: 'INVALID_EXPLORER_TAB' });
  const catalog = await getCatalog();
  const overview = isDatabaseMode() && ['units','equipment','decks','traits'].includes(tab)
    ? {delivery:'mysql',context:cacheContext(catalog)} : await getStatsOverview(options);
  let results;
  if (tab === 'units' || tab === 'equipment') {
    const overall = await getExplorerOverallStats({ catalog, ...options });
    const sourceId = tab === 'units' ? 'units' : 'items';
    const source = overall.evidence.sources.find(source => source.id === sourceId) || {};
    const { sources: declaredSources, ...summaryEvidence } = overall.evidence;
    const { id: declaredSourceId, ...pageEvidence } = source;
    const evidence = { ...summaryEvidence, ...pageEvidence, sourceId, rank: overall.evidence.population?.rank ?? null, queue: overall.evidence.population?.queue ?? null };
    results = [{ result: { ...overall, data: (tab === 'units' ? overall.champions : overall.items).map(row => ({ ...row, evidence })), evidence } }];
  }
  else if (tab === 'decks') results = [{ result: await getMetaDecks(options) }];
  else if (tab === 'traits') results = [{ result: await getTraitStats({ catalog, ...options }) }];
  else {
    const entries = tab === 'champions' ? overview.champions : overview.items.filter(item => tab !== 'emblems' || item.category === 'emblem');
    results = await Promise.all(entries.filter(entry => entry.cached).map(async entry => ({ entityId: entry.id,
      result: tab === 'champions' ? await getChampionBuild(entry.id, options) : await getItemHolders(entry.id, options) })));
  }
  const rows = results.flatMap(({ result, entityId }) => normalizeExplorerRows(tab, result, catalog, entityId));
  const sources = [...new Map(results.filter(({ result }) => result.evidence).map(({ result }) => {
    const e = result.evidence;
    return [JSON.stringify([e.source, e.sourcePatch, e.sourceTime, e.fetchedAt, e.sampleDenominator]), e];
  })).values()];
  const allMissing = !results.length || results.every(({ result }) => result.status === 'not_cached');
  return {
    schemaVersion: 1, status: rows.length ? 'cached' : allMissing ? 'not_cached' : 'unavailable', tab,
    delivery: overview.delivery||'version_cache', cacheKey: overview.cacheKey, context: overview.context, rows,
    evidence: sources[0] || null, sources, coverage: ['units', 'equipment'].includes(tab) ? results[0].result.coverage : overview.coverage || results[0]?.result.coverage,
    querySemantics: 'cached_aggregate_row_membership',
    summary: { rowCount: rows.length, sampleSize: null, avgPlacement: null, top4Rate: null, winRate: null, pickRate: null, avgLevel: null },
    capabilities: { rowMembershipFilters: true, includeExclude: true, andOr: true, jointMatchQueries: false,
      overallChampionStats: tab === 'units' && rows.length > 0, overallItemStats: tab === 'equipment' && rows.length > 0, totalQueryPopulation: false, patchSelection: false,
      rankFilters: isDatabaseMode(), rankRegionFilters: false, matchHistory: false, starFilters: false, twoItemStats: false, counters: false },
    note: '条件用于匹配本地已收录的聚合记录。英雄出装与装备携带记录中的羁绊来自英雄原生资料；不代表对局中的激活档位。不同记录可能重叠，样本不相加，不生成多条件联查胜率。',
    ...(rows.length ? {} : { reason: allMissing ? '当前版本没有此维度的本地缓存；不会自动访问外部 API。' : '当前版本没有可展示的有效来源行。' }),
  };
}
