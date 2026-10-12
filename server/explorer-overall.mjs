import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';

export const EXPLORER_DIR = new URL('../data/explorer/', import.meta.url);
export const EXPLORER_URLS = Object.freeze({ units: 'https://tactics.tools/units', items: 'https://tactics.tools/items' });
const POPULATION = Object.freeze({ queue: 'Ranked', rank: 'Diamond+', region: null });
const capabilities = available => ({ championOverallStats: available, itemOverallStats: available, jointFilters: false,
  conditionalCooccurrence: false, conditionalDelta: false, rankRegionFilters: false, starFilters: false, boardPositionStats: false, recentMatches: false });
const entityFingerprint = catalog => sha256({ champions: catalog.champions.map(x => x.id).sort(), items: catalog.items.map(x => x.id).sort() });
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }

function parsePublicPage(html, catalog, kind, fetchedAt) {
  if (!['units', 'items'].includes(kind) || typeof html !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid overall public source or original capture time.');
  const label = kind === 'units' ? 'Units' : 'Items';
  const identity = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.match(new RegExp(`TFT ${label} Stats - Best ${label} for Set (\\d+) Patch (\\d+\\.\\d+[a-z]?)`));
  if (!identity || Number(identity[1]) !== catalog.context.set) throw new Error(`Public ${kind} page set/patch identity does not match the catalog.`);
  const sourcePatch = identity[2];
  const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!embedded) throw new Error(`Public ${kind} HTML contains no __NEXT_DATA__; no undocumented API fallback is allowed.`);
  const parsed = JSON.parse(embedded), page = parsed.props?.pageProps;
  if (parsed.page !== `/${kind}/[[...slug]]` || !page?.statsData || typeof page.statsData.units !== 'object' || Array.isArray(page.statsData.units) || !Array.isArray(page.statsData.items)) throw new Error(`Public ${kind} page schema changed.`);
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (page.aperture?.queue !== 1100 || page.aperture?.gameType !== 0 || page.aperture?.rankGroup !== 1 || !visible.includes(`Ranked Diamond+ ${sourcePatch}`)) throw new Error(`Public ${kind} Ranked/Diamond+/patch filters could not be verified.`);
  const raw = page.statsData;
  if (!Number.isSafeInteger(raw.totalEntries) || raw.totalEntries <= 0 || !Number.isSafeInteger(raw.lastUpdated) || raw.lastUpdated <= 0) throw new Error(`Public ${kind} sample/time metadata missing.`);
  const sourceTime = new Date(raw.lastUpdated * 1000).toISOString();
  if (Date.parse(sourceTime) > Date.parse(fetchedAt) + 300_000) throw new Error(`Public ${kind} source time is later than its capture time.`);
  const evidence = { id: kind, source: 'Tactics.tools', url: EXPLORER_URLS[kind], endpoint: EXPLORER_URLS[kind], set: catalog.context.set,
    sourcePatch, gamePatch: sourcePatch, population: { ...POPULATION }, fetchedAt, sourceTime, sourceTotalEntries: raw.totalEntries,
    sourceTotalEntriesMeaning: 'source statsData.totalEntries; rows overlap and are not disjoint unique games',
    sampleDenominator: `source statsData.${kind === 'units' ? 'units[unitId]' : 'items[rowIndex]'}.count (${kind === 'units' ? 'unit' : 'item'} occurrences)`,
    sourceHTMLSha256: sha256(html), aperture: page.aperture, delivery: 'version_cache',
    rateUnit: 'fraction (source percentages divided by 100)', pickRateDefinition: 'source count / source totalEntries',
    playRateDisplay: 'public page displays count / totalEntries * 8, with the /8 unit; it is not a conditional probability' };
  return { raw, evidence };
}

function normalizedStats(row, sourceTotalEntries, id) {
  if (!Number.isSafeInteger(row.count) || row.count <= 0 || !Number.isFinite(row.place) || row.place < 1 || row.place > 8 ||
    !Number.isFinite(row.top4) || row.top4 < 0 || row.top4 > 100 || !Number.isFinite(row.won) || row.won < 0 || row.won > 100) throw new Error(`Invalid public overall statistics row: ${id}`);
  // count can exceed the entry denominator if a source counts repeated occurrences;
  // the displayed play-rate ratio is retained without inventing a probability.
  const pickRate = row.count / sourceTotalEntries;
  return { avgPlacement: row.place, top4Rate: row.top4 / 100, winRate: row.won / 100, sampleSize: row.count, pickRate, playRatePer8: pickRate * 8 };
}

export function normalizeExplorerHTML({ unitsHTML, itemsHTML, unitsFetchedAt, itemsFetchedAt }, catalog) {
  const units = parsePublicPage(unitsHTML, catalog, 'units', unitsFetchedAt), items = parsePublicPage(itemsHTML, catalog, 'items', itemsFetchedAt);
  if (units.evidence.sourcePatch !== items.evidence.sourcePatch || stableJSON(units.evidence.population) !== stableJSON(items.evidence.population)) throw new Error('Public overall pages have different patches or population filters; no combined snapshot was published.');
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog), championMap = new Map(catalog.champions.map(x => [x.id, x])), itemMap = new Map(catalog.items.map(x => [x.id, x]));
  const champions = [], normalizedItems = [], excludedChampions = [], excludedItems = [], unknownTopItems = [], seenItemIds = new Set();
  for (const [id, row] of Object.entries(units.raw.units)) {
    const champion = championMap.get(id);
    if (!champion) { excludedChampions.push({ id, reason: 'outside_current_catalog' }); continue; }
    if (!Array.isArray(row.topItems) || row.topItems.some(value => typeof value !== 'string')) throw new Error(`Invalid public overall topItems: ${id}`);
    const topItems = row.topItems.filter(itemId => itemMap.has(itemId));
    for (const itemId of row.topItems.filter(itemId => !itemMap.has(itemId))) unknownTopItems.push({ championId: id, itemId });
    champions.push({ id, name: champion.name, cost: champion.cost, traits: champion.traits, icon: champion.icon, stats: normalizedStats(row, units.raw.totalEntries, id), topItems, sourceId: 'units' });
  }
  for (const row of items.raw.items) {
    if (typeof row.itemId !== 'string' || seenItemIds.has(row.itemId)) throw new Error('Missing or duplicate public overall item ID.');
    seenItemIds.add(row.itemId); const item = itemMap.get(row.itemId);
    if (!item) { excludedItems.push({ id: row.itemId, reason: 'outside_current_catalog' }); continue; }
    normalizedItems.push({ id: item.id, name: item.name, kind: item.kind, category: item.category ?? item.kind, icon: item.icon, stats: normalizedStats(row, items.raw.totalEntries, item.id), sourceId: 'items' });
  }
  if (!champions.length || !normalizedItems.length) throw new Error('No public overall rows map to the current catalog.');
  const missingChampions = catalog.champions.filter(x => !champions.some(row => row.id === x.id)).map(x => ({ id: x.id, name: x.name, reason: 'not_in_public_source_snapshot' }));
  const missingItems = catalog.items.filter(x => x.kind !== 'component' && !normalizedItems.some(row => row.id === x.id)).map(x => ({ id: x.id, name: x.name, category: x.category ?? x.kind, reason: 'not_in_public_source_snapshot' }));
  const coverage = {
    champions: { sourceRows: Object.keys(units.raw.units).length, cached: champions.length, total: catalog.champions.length, excluded: excludedChampions, missing: missingChampions },
    items: { sourceRows: items.raw.items.length, cached: normalizedItems.length, total: catalog.items.filter(x => x.kind !== 'component').length, excluded: excludedItems, missing: missingItems, componentsWithoutStatistics: catalog.items.filter(x => x.kind === 'component').map(x => x.id) },
    unknownTopItems, complete: !missingChampions.length && !missingItems.length && !excludedChampions.length && !excludedItems.length,
    note: '整体行的样本相互重叠，不能相加推导对局总数；未录入项无统计值，不使用三件套或持有者行代替。' };
  const sources = [units.evidence, items.evidence];
  const evidence = { source: 'Tactics.tools', sourcePatch: units.evidence.sourcePatch, gamePatch: units.evidence.sourcePatch, set: context.set,
    population: { ...POPULATION }, queue: POPULATION.queue, rank: POPULATION.rank, region: null, delivery: 'version_cache', cacheKey,
    assetVersion: context.assetVersion, rulesVersion: context.rulesVersion, fetchedAt: sources.map(x => x.fetchedAt).sort().at(-1),
    sourceTime: units.evidence.sourceTime === items.evidence.sourceTime ? units.evidence.sourceTime : null,
    sourceTotalEntries: units.raw.totalEntries === items.raw.totalEntries ? units.raw.totalEntries : null,
    sourceTotalEntriesMeaning: units.evidence.sourceTotalEntriesMeaning, sources,
    sampleDenominator: 'each row is the source unit/item occurrence count; see its sourceId for the exact public page denominator',
    statisticalWindow: { selection: `page patch ${units.evidence.sourcePatch}`, from: null, to: null },
    unsupportedDimensions: ['conditional_AND_OR_unit_trait_item_filters', 'conditional_cooccurrence', 'conditional_delta', 'rank_selection', 'region_selection', 'star_selection', 'board_position_outcomes', 'recent_match_details'],
    note: '整体出现记录统计，可按本地实体属性和指标筛选；不构造条件对局样本、组合收益或跨来源排名。topItems仅保留来源列出的装备ID，不代表该搭配的胜率。' };
  return { schemaVersion: 1, status: 'live', delivery: 'version_cache', cacheKey, context, entityFingerprint: entityFingerprint(catalog),
    champions, items: normalizedItems, coverage, capabilities: capabilities(true), evidence, reason: null };
}

function validatePayload(payload, catalog) {
  const key = cacheKeyFor(catalog), context = cacheContext(catalog);
  if (!payload || payload.schemaVersion !== 1 || payload.status !== 'live' || payload.delivery !== 'version_cache' || payload.cacheKey !== key ||
    stableJSON(payload.context) !== stableJSON(context) || payload.entityFingerprint !== entityFingerprint(catalog) ||
    payload.evidence?.source !== 'Tactics.tools' || payload.evidence?.set !== context.set || !/^\d+\.\d+[a-z]?$/.test(payload.evidence?.sourcePatch ?? '') ||
    stableJSON(payload.evidence?.population) !== stableJSON(POPULATION) || !Array.isArray(payload.champions) || !payload.champions.length || !Array.isArray(payload.items) || !payload.items.length) return false;
  const sources = payload.evidence.sources;
  if (!Array.isArray(sources) || sources.length !== 2 || sources.some((source, i) => source.id !== ['units', 'items'][i] || source.source !== 'Tactics.tools' || source.url !== EXPLORER_URLS[source.id] || source.set !== context.set || source.sourcePatch !== payload.evidence.sourcePatch ||
    stableJSON(source.population) !== stableJSON(POPULATION) || !Number.isSafeInteger(source.sourceTotalEntries) || source.sourceTotalEntries <= 0 || !Number.isFinite(Date.parse(source.fetchedAt)) || !Number.isFinite(Date.parse(source.sourceTime)) || Date.parse(source.sourceTime) > Date.parse(source.fetchedAt) + 300_000 || !/^[a-f0-9]{64}$/.test(source.sourceHTMLSha256 ?? ''))) return false;
  for (const [kind, rows, entities, source] of [['units', payload.champions, catalog.champions, sources[0]], ['items', payload.items, catalog.items, sources[1]]]) {
    const ids = new Set(entities.map(x => x.id)), seen = new Set();
    for (const row of rows) {
      if (!ids.has(row.id) || seen.has(row.id) || row.sourceId !== kind) return false;
      seen.add(row.id); const s = row.stats;
      if (!s || !Number.isSafeInteger(s.sampleSize) || s.sampleSize <= 0 || !Number.isFinite(s.avgPlacement) || s.avgPlacement < 1 || s.avgPlacement > 8 || !Number.isFinite(s.top4Rate) || s.top4Rate < 0 || s.top4Rate > 1 || !Number.isFinite(s.winRate) || s.winRate < 0 || s.winRate > 1 || s.pickRate !== s.sampleSize / source.sourceTotalEntries || s.playRatePer8 !== s.pickRate * 8) return false;
      if (kind === 'units' && (!Array.isArray(row.topItems) || row.topItems.some(id => !catalog.items.some(x => x.id === id)))) return false;
    }
  }
  return true;
}

export async function readExplorerSnapshot(catalog, dir = EXPLORER_DIR) {
  const key = cacheKeyFor(catalog), manifest = await optionalJSON(new URL(`${key}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== key || stableJSON(manifest.context) !== stableJSON(cacheContext(catalog)) || manifest.entityFingerprint !== entityFingerprint(catalog) || !/^[a-f0-9-]{36}\.json$/.test(manifest.file)) return null;
  const payload = await optionalJSON(new URL(`${key}/${manifest.file}`, dir));
  if (!validatePayload(payload, catalog) || sha256(payload) !== manifest.sha256) return null;
  return { manifest, payload };
}

export async function publishExplorerSnapshot(catalog, payload, { unitsHTML, itemsHTML }, dir = EXPLORER_DIR) {
  if (!validatePayload(payload, catalog) || payload.evidence.sources[0].sourceHTMLSha256 !== sha256(unitsHTML) || payload.evidence.sources[1].sourceHTMLSha256 !== sha256(itemsHTML)) throw new Error('Overall snapshot source/context validation failed.');
  const cacheKey = cacheKeyFor(catalog), versionDir = new URL(`${cacheKey}/`, dir), rawDir = new URL(`raw/${cacheKey}/`, dir);
  await mkdir(versionDir, { recursive: true }); await mkdir(rawDir, { recursive: true });
  const captureId = randomUUID(), file = `${captureId}.json`, path = new URL(file, versionDir);
  await writeFile(path, JSON.stringify(payload, null, 2));
  for (const [kind, html] of [['units', unitsHTML], ['items', itemsHTML]]) {
    await writeFile(new URL(`${captureId}-${kind}.html`, rawDir), html);
    await writeFile(new URL(`${captureId}-${kind}.capture.json`, rawDir), JSON.stringify(payload.evidence.sources.find(x => x.id === kind), null, 2));
  }
  const disk = await optionalJSON(path);
  if (!validatePayload(disk, catalog) || sha256(disk) !== sha256(payload)) throw new Error('Overall snapshot disk integrity validation failed.');
  const manifest = { schemaVersion: 1, cacheKey, context: payload.context, entityFingerprint: payload.entityFingerprint, file, sha256: sha256(payload),
    publishedAt: new Date().toISOString(), fetchedAt: payload.evidence.fetchedAt, sourceTime: payload.evidence.sourceTime, sourcePatch: payload.evidence.sourcePatch, sources: payload.evidence.sources, coverage: payload.coverage };
  const next = new URL(`manifest.${captureId}.next.json`, versionDir); await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', versionDir));
  return manifest;
}

export async function getExplorerOverallStats({ catalog, rank, dir = EXPLORER_DIR } = {}) {
  const { readDatabaseSnapshot, isDatabaseMode } = await import('./storage/runtime.mjs');
  if (isDatabaseMode()) return (await import('./metatft/datasets.mjs')).getMetaOverall(catalog || await (await import('./data.mjs')).getCatalog(),{rank});
  const stored = await readDatabaseSnapshot('overall', {statistics:true});
  if (stored !== undefined) return stored;
  catalog ??= await (await import('./data.mjs')).getCatalog();
  const cached = await readExplorerSnapshot(catalog, dir); if (cached) return cached.payload;
  const cacheKey = cacheKeyFor(catalog);
  return { status: 'not_cached', code: 'not_cached', delivery: 'version_cache', cacheKey, context: cacheContext(catalog), champions: [], items: [],
    coverage: { champions: { cached: 0, total: catalog.champions.length }, items: { cached: 0, total: catalog.items.filter(x => x.kind !== 'component').length }, complete: false }, capabilities: capabilities(false),
    evidence: { source: 'Tactics.tools', sourcePatch: null, gamePatch: null, set: catalog.context.set, delivery: 'version_cache', cacheKey, population: null, fetchedAt: null, sourceTime: null, sourceTotalEntries: null,
      sources: Object.entries(EXPLORER_URLS).map(([id, url]) => ({ id, source: 'Tactics.tools', url, sourcePatch: null, fetchedAt: null, sourceTime: null })) },
    reason: '当前版本本地知识库未收录整体弈子/装备统计，或完整性校验未通过；网页与 Agent 不会自动联网。请运行 sync:explorer 同步任务。' };
}
