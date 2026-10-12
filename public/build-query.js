// The same selector runs in the browser and in Agent tools. A candidate is an
// observed complete three-item build, never a combination of marginal stats.
import { validRank } from './stat-ranks.js';
const METRICS = new Set(['avgPlacement', 'top4Rate', 'winRate', 'sampleSize']);
const strings = value => Array.isArray(value) ? value.filter(id => typeof id === 'string' && id && id.length <= 180) : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const counts = ids => ids.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());

export function normalizeBuildQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const sort = METRICS.has(input.sort) ? input.sort : 'avgPlacement';
  const minimum = Number(input.minSample ?? 100);
  return {
    championId: typeof input.championId === 'string' ? input.championId.slice(0, 180) : '',
    requiredItemIds: strings(input.requiredItemIds).slice(0, 24),
    excludedItemIds: [...new Set(strings(input.excludedItemIds))].slice(0, 24),
    minSample: Number.isFinite(minimum) && minimum >= 0 ? Math.min(100000000, Math.floor(minimum)) : 100,
    ...(input.rank != null ? {rank:input.rank}:{}), sort, sortDirection: ['asc', 'desc'].includes(input.sortDirection) ? input.sortDirection : sort === 'avgPlacement' ? 'asc' : 'desc',
  };
}

export function buildQueryFromExplorer(input = {}) {
  const included = Array.isArray(input.include) ? input.include : [];
  const excluded = Array.isArray(input.exclude) ? input.exclude : [];
  const champions = included.filter(term => term.type === 'champion');
  if (input.operator === 'any' || champions.length !== 1 || included.some(term => !['champion', 'item'].includes(term.type)) || excluded.some(term => term.type !== 'item')) return null;
  return normalizeBuildQuery({ championId: champions[0].id, requiredItemIds: included.filter(term => term.type === 'item').map(term => term.id),
    excludedItemIds: excluded.map(term => term.id), minSample: input.minSample, ...(input.rank != null ? {rank:input.rank}:{}), sort: input.sort, sortDirection: input.sortDirection });
}

export function validateBuildQuery(input, catalog) {
  const query = normalizeBuildQuery(input);
  const champion = catalog.champions.find(entity => entity.id === query.championId);
  const items = new Map(catalog.items.map(entity => [entity.id, entity]));
  let reason = '';
  if (input?.rank != null && !validRank(input.rank)) reason = '请选择有效段位。';
  else if (['requiredItemIds', 'excludedItemIds'].some(key => input?.[key] != null && (!Array.isArray(input[key]) || input[key].some(id => typeof id !== 'string' || !id || id.length > 180)))) reason = '装备条件格式无效，不能忽略固定或排除条件。';
  else if (!champion) reason = '请选择当前赛季的一名英雄。';
  else if (query.requiredItemIds.length > 3) reason = '最多固定三件装备，完整出装只有三个装备槽。';
  else if ([...query.requiredItemIds, ...query.excludedItemIds].some(id => !items.has(id) || items.get(id).kind === 'component')) reason = '条件装备必须是当前赛季的成装、神器、光明装备或纹章。';
  else if (query.requiredItemIds.some(id => query.excludedItemIds.includes(id))) reason = '同一件装备不能同时固定和排除。';
  else if (query.requiredItemIds.reduce((sum, id) => sum + (items.get(id).slotCost ?? 1), 0) > 3) reason = '固定装备占用超过三个装备槽。';
  else if ([...counts(query.requiredItemIds)].some(([id, count]) => count > 1 && items.get(id).unique)) reason = '这件装备不能重复携带。';
  return { query, valid: !reason, reason, champion, items };
}

export function selectConditionalBuilds(sourceRows, input, catalog) {
  const { query, valid, reason, champion, items } = validateBuildQuery(input, catalog);
  const empty = { query, data: [], best: null, selection: { mode: 'observed_conditional_three_item_builds', metric: query.sort,
    direction: query.sortDirection, minimumSampleSize: query.minSample, matchedRows: 0, qualifiedRows: 0,
    statisticScope: 'champion_occurrences_with_exact_three_item_build', samplesCombined: false } };
  if (!valid) return { ...empty, status: 'invalid', reason };
  const required = counts(query.requiredItemIds);
  const unique = new Map();
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    if (!row || row.championId !== champion.id || row.kind && row.kind !== 'champion_build' || !Array.isArray(row.itemIds) || row.itemIds.length !== 3) continue;
    const ids = row.itemIds;
    if (ids.some(id => !items.has(id) || items.get(id).kind === 'component') || ids.reduce((sum, id) => sum + (items.get(id).slotCost ?? 1), 0) > 3) continue;
    const available = counts(ids);
    if ([...available].some(([id, count]) => count > 1 && items.get(id).unique) || [...required].some(([id, count]) => (available.get(id) || 0) < count) || ids.some(id => query.excludedItemIds.includes(id))) continue;
    const stats = row.stats;
    if (!finite(stats?.avgPlacement) || stats.avgPlacement < 1 || stats.avgPlacement > 8 || !Number.isSafeInteger(stats.sampleSize) || stats.sampleSize < 1) continue;
    if (['top4Rate', 'winRate'].some(key => stats[key] != null && (!finite(stats[key]) || stats[key] < 0 || stats[key] > 1))) continue;
    const key = [champion.id, ...[...ids].sort()].join(':');
    const previous = unique.get(key);
    // Repeated source rows are not extra games. Keep one intact source row.
    if (previous && previous.stats.sampleSize >= stats.sampleSize) continue;
    const remaining = [...ids];
    const fixed = query.requiredItemIds.map(id => remaining.splice(remaining.indexOf(id), 1)[0]);
    const ordered = [...fixed, ...remaining];
    unique.set(key, { ...row, id: key, kind: 'champion_build', name: champion.name, championName: champion.name,
      itemIds: ordered, items: ordered.map(id => ({ id, name: items.get(id).name, icon: items.get(id).icon })),
      fixedItemCount: fixed.length, completionItemIds: remaining, stats: { ...stats } });
  }
  const matched = [...unique.values()];
  const data = matched.filter(row => row.stats.sampleSize >= query.minSample && finite(row.stats[query.sort]));
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  data.sort((a, b) => direction * (a.stats[query.sort] - b.stats[query.sort]) || b.stats.sampleSize - a.stats.sampleSize || a.id.localeCompare(b.id));
  const status = data.length ? 'ok' : matched.length ? 'insufficient_samples' : 'empty';
  return { query, status, data, best: data[0] || null,
    selection: { ...empty.selection, matchedRows: matched.length, qualifiedRows: data.length },
    reason: data.length ? null : matched.length ? '有对应三件套，但没有记录达到当前样本门槛并提供排序指标。请调整门槛；不会自动用小样本代替。' : '当前来源未收录满足这些条件的完整三件套。请调整条件；不会用普通出装补上固定装备。' };
}
