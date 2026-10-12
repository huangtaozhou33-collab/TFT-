const TABS = new Set(['units', 'equipment', 'items', 'traits', 'champions', 'decks', 'emblems']);
const TYPES = new Set(['champion', 'item', 'trait']);
const SORTS = new Set(['name', 'sampleSize', 'pickRate', 'avgPlacement', 'top4Rate', 'winRate']);

function conditions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 24).filter(condition => {
    if (!condition || !TYPES.has(condition.type) || typeof condition.id !== 'string' || !condition.id || condition.id.length > 180) return false;
    const key = `${condition.type}:${condition.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ type, id }) => ({ type, id }));
}

export function normalizeExplorerQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const sort = SORTS.has(input.sort) ? input.sort : 'avgPlacement';
  const minimum = Number(input.minSample);
  const cost = Number(input.cost);
  return {
    ...(input.mode === 'builds' ? { mode: 'builds' } : {}),
    tab: TABS.has(input.tab) ? input.tab : 'units',
    perspective: input.perspective === 'item' ? 'item' : 'champion',
    include: conditions(input.include), exclude: conditions(input.exclude),
    operator: input.operator === 'any' ? 'any' : 'all',
    search: typeof input.search === 'string' ? input.search.slice(0, 160) : '',
    minSample: Number.isFinite(minimum) && minimum >= 0 ? Math.min(100000000, Math.floor(minimum)) : 100,
    cost: Number.isInteger(cost) && cost >= 1 && cost <= 9 ? cost : '',
    sort, sortDirection: ['asc', 'desc'].includes(input.sortDirection) ? input.sortDirection : sort === 'name' || sort === 'avgPlacement' ? 'asc' : 'desc',
    horizontal: input.horizontal !== false, autocomplete: input.autocomplete !== false,
    page: Number.isInteger(Number(input.page)) && Number(input.page) > 0 ? Math.min(1000000, Number(input.page)) : 1
  };
}

function ids(value) { return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))] : []; }
export function getRowEntities(row) {
  if (!row || typeof row !== 'object') row = {};
  return {
    champion: ids([...ids(row.unitIds), row.championId]),
    item: ids([...ids(row.itemIds), row.itemId]),
    trait: ids([...ids(row.traitIds), row.traitId])
  };
}

function finite(value) {
  return value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim() || !Number.isFinite(Number(value)) ? null : Number(value);
}
function indexEntry(index, type, id) { return index?.[type]?.get?.(id) || index?.[type]?.[id]; }
function rowText(row, entities, index) {
  const names = Object.entries(entities).flatMap(([type, values]) => values.flatMap(id => {
    const entity = indexEntry(index, type, id); return entity ? [entity.name, ...(entity.aliases || [])] : [];
  }));
  return [row.name, row.championName, row.itemName, row.traitName, ...names].filter(value => typeof value === 'string').join(' ').toLowerCase();
}

export function filterExplorerRows(rows, input, index = {}) {
  const query = normalizeExplorerQuery(input);
  const search = query.search.trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const sample = finite(row?.stats?.sampleSize);
    if (!row || typeof row !== 'object') return false;
    if (query.minSample && (sample == null || sample < query.minSample)) return false;
    const entities = getRowEntities(row);
    const matches = condition => entities[condition.type].includes(condition.id);
    if (query.exclude.some(matches)) return false;
    if (query.include.length && !(query.operator === 'any' ? query.include.some(matches) : query.include.every(matches))) return false;
    if (query.cost && !entities.champion.some(id => Number(indexEntry(index, 'champion', id)?.cost) === query.cost)) return false;
    return !search || rowText(row, entities, index).includes(search);
  });
}

export function sortExplorerRows(rows, input) {
  const query = normalizeExplorerQuery(input);
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (query.sort === 'name') return direction * String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    const av = finite(a.stats?.[query.sort]); const bv = finite(b.stats?.[query.sort]);
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return direction * (av - bv);
  });
}

export function encodeExplorerQuery(query) { return JSON.stringify(normalizeExplorerQuery(query)); }
export function decodeExplorerQuery(value) {
  if (typeof value !== 'string' || value.length > 16000) return null;
  try { const input = JSON.parse(value); return input && typeof input === 'object' && !Array.isArray(input) ? normalizeExplorerQuery(input) : null; } catch { return null; }
}
