const TYPES = new Set(['champion', 'item', 'trait']);
import { validRank } from './stat-ranks.js';
const METRICS = new Set(['avgPlacement', 'top4Rate', 'winRate', 'sampleSize']);
export function normalizeResearchQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const conditions = Array.isArray(input.conditions) ? input.conditions : [];
  const min = Number(input.minSample ?? 100);
  return { conditions: conditions.map(term => ({ type: term?.type, id: term?.id, ...(term?.type === 'item' ? { holderId: term.holderId || null } : {}) })),
    minSample: Number.isFinite(min) && min >= 0 ? Math.min(100000000, Math.floor(min)) : 100,
    sort: METRICS.has(input.sort) ? input.sort : 'avgPlacement',
    // Presentation preferences travel in the page URL, not in the source query.
    ...(input.buildDisplay && typeof input.buildDisplay === 'object' && !Array.isArray(input.buildDisplay)
      ? { buildDisplay: { artifacts: input.buildDisplay.artifacts !== false, radiant: input.buildDisplay.radiant !== false } } : {}),
    ...(input.rank != null ? {rank:input.rank}:{}),
    ...(input.dataSource != null ? { dataSource: input.dataSource } : {}),
    ...(input.carrierId != null && input.carrierId !== '' ? { carrierId: input.carrierId } : {}) };
}
export function validateResearchQuery(input, catalog) {
  const query = normalizeResearchQuery(input);
  let reason = '';
  const maps = { champion: new Map(catalog.champions.map(x => [x.id, x])), item: new Map(catalog.items.map(x => [x.id, x])), trait: new Map(catalog.traits.map(x => [x.id, x])) };
  if (input?.rank != null && !validRank(input.rank)) reason = '请选择有效段位。';
  else if (!Array.isArray(input?.conditions) || query.conditions.length > 24) reason = '请选择最多 24 个有效条件。';
  else if (query.conditions.some(t => !TYPES.has(t.type) || typeof t.id !== 'string' || !maps[t.type].has(t.id))) reason = '条件中有当前赛季未收录的英雄、装备或羁绊。';
  else if (query.conditions.some(t => t.type === 'item' && (maps.item.get(t.id).kind === 'component' && query.dataSource !== 'metatft' || t.holderId && !query.conditions.some(c => c.type === 'champion' && c.id === t.holderId)))) reason = '散件统计需使用 MetaTFT；佩戴者须为已选英雄或任意英雄。';
  else if (query.carrierId != null && (typeof query.carrierId !== 'string' || !query.conditions.some(t => t.type === 'champion' && t.id === query.carrierId))) reason = '查看出装的英雄必须包含在已选条件中。';
  else if (query.dataSource != null && !['auto', 'opgg', 'riot', 'metatft'].includes(query.dataSource)) reason = '请选择有效的数据查询范围。';
  return { query, valid: !reason, reason };
}
const itemId = item => typeof item === 'string' ? item : item?.id || item?.itemId;
const counts = ids => ids.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
/** Match a single source lineup in full. Never join separate marginal records. */
export function matchesResearchDeck(deck, query) {
  const units = deck.units || [], terms = query.conditions || [];
  if (!terms.filter(t => t.type === 'champion').every(t => units.some(u => (u.championId || u.id) === t.id))) return false;
  if (!terms.filter(t => t.type === 'trait').every(t => (deck.traits || []).some(v => v.id === t.id && v.style > 0))) return false;
  const required = terms.filter(t => t.type === 'item');
  const available = counts(units.flatMap(u => (u.items || []).map(itemId)));
  if ([...counts(required.map(t => t.id))].some(([id, n]) => (available.get(id) || 0) < n)) return false;
  for (const holderId of new Set(required.map(t => t.holderId).filter(Boolean))) {
    const needed = counts(required.filter(t => t.holderId === holderId).map(t => t.id));
    if (!units.some(u => (u.championId || u.id) === holderId && [...needed].every(([id, n]) => (counts((u.items || []).map(itemId)).get(id) || 0) >= n))) return false;
  }
  return true;
}
export function compareResearchRows(a, b, sort = 'avgPlacement') {
  const av = a.stats?.[sort], bv = b.stats?.[sort];
  if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0;
  if (!Number.isFinite(bv)) return -1;
  return (sort === 'avgPlacement' ? 1 : -1) * (av - bv) || (b.stats?.sampleSize || 0) - (a.stats?.sampleSize || 0);
}
export function researchBuildQuery(query) {
  const heroes = query.conditions.filter(t => t.type === 'champion');
  if (heroes.length !== 1 || query.conditions.some(t => t.type === 'trait' || t.type === 'item' && t.holderId !== heroes[0].id)) return null;
  return { championId: heroes[0].id, requiredItemIds: query.conditions.filter(t => t.type === 'item').map(t => t.id), minSample: query.minSample, sort: query.sort };
}
/** Explicit OP.GG mode means all equipment belongs to one champion's build.
 * Automatic routing only accepts predicates with the same meaning in both modes.
 */
export function researchAggregatePlan(query) {
  const heroes = [...new Set(query.conditions.filter(t => t.type === 'champion').map(t => t.id))];
  const items = query.conditions.filter(t => t.type === 'item');
  if (heroes.length > 1 || query.conditions.some(t => t.type === 'trait')) return null;
  if (query.dataSource !== 'opgg' && (heroes.length ? items.some(t => t.holderId !== heroes[0]) : items.length !== 1)) return null;
  return { championId: heroes[0] || null, requiredItemIds: items.map(t => t.id), minSample: query.minSample, sort: query.sort };
}
export function researchFromLegacy(query = {}) {
  const hero = (query.include || []).find(t => t.type === 'champion');
  return normalizeResearchQuery({ ...query, conditions: (query.include || []).map(t => ({ ...t, ...(t.type === 'item' ? { holderId: hero?.id || null } : {}) })) });
}
