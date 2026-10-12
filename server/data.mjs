import { readFile, stat } from 'node:fs/promises';
import { cacheKeyFor, cacheContext, queryKey, readManifest, readRecord, TOOL_NAMES } from '../scripts/stats-cache.mjs';
import { getTraitStats } from './trait-data.mjs';
import { getExplorerOverallStats } from './explorer-overall.mjs';
import { readDatabaseSnapshot,readDatabaseStatsManifest,isDatabaseMode } from './storage/runtime.mjs';
import { getMetaCompDecks, getMetaDetail, getMetaOverview } from './metatft/datasets.mjs';

const dataDir = new URL('../data/', import.meta.url);
let catalogPromise, catalogFingerprint;
class SourceError extends Error { constructor(message, layer) { super(message); this.layer = layer; } }
async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJSON(path) { try { return await readJSON(path); } catch { return null; } }
export async function getCatalog() {
  const stored = await readDatabaseSnapshot('catalog');
  if (stored !== undefined) return stored;
  const path = new URL('catalog.json', dataDir);
  try {
    const details = await stat(path); const fingerprint = `${details.mtimeMs}:${details.size}`;
    if (!catalogPromise || catalogFingerprint !== fingerprint) {
      catalogFingerprint = fingerprint;
      catalogPromise = readJSON(path).catch(error => { catalogPromise = null; throw error; });
    }
    return await catalogPromise;
  } catch (error) { throw new SourceError(`Static catalog is unavailable. Run npm run sync:data. ${error.message}`, 'static'); }
}

function evidenceFor(record, extra = {}) {
  return { source: 'OP.GG MCP', endpoint: record.endpoint, tool: record.tool, fetchedAt: record.fetchedAt, sourceTime: record.body?.metadata?.gameStatDateTime ?? null, sourcePatch: record.body?.version ?? null, gamePatch: null,
    delivery: 'version_cache', cacheKey: record.cacheKey, assetVersion: record.boundContext?.assetVersion, rulesVersion: record.boundContext?.rulesVersion, set: record.boundContext?.set,
    snapshotAgeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(record.fetchedAt)) / 1000)),
    unsupportedDimensions: ['gamePatch', 'region', 'rank', 'star'], population: null, statisticalWindow: null, ...extra };
}

export async function fetchOPGGTool(name, args = {}) {
  const stored = await readDatabaseSnapshot(`opgg:${queryKey(name,args)}`, {statistics:['tft_list_meta_decks','tft_get_champion_item_build','tft_list_champions_for_item'].includes(name)});
  if (stored !== undefined) return stored;
  if (!TOOL_NAMES.has(name)) throw new SourceError(`Tool ${name} is outside the local knowledge-base whitelist.`, 'schema');
  const catalog = await getCatalog(); const manifest = await readManifest(catalog);
  const cached = manifest ? await readRecord(manifest, name, args) : null;
  const context = cacheContext(catalog); const evidence = { source: 'OP.GG MCP', tool: name, delivery: 'version_cache', cacheKey: cacheKeyFor(catalog), ...context, gamePatch: null };
  if (!cached) return { status: 'not_cached', code: 'not_cached', data: null, delivery: 'version_cache', evidence, reason: '当前版本本地知识库尚未收录此统计；网页和 Agent 不会自动访问上游。请通过独立版本同步任务补录。' };
  if (cached.record.status === 'not_supported') return { status: 'unavailable', code: 'not_supported', data: null, delivery: 'version_cache', evidence: evidenceFor(cached.record), reason: cached.record.reason || '当前上游工具 schema 不支持此实体；已记录缺口。' };
  return { status: 'live', data: cached.record.body, delivery: 'version_cache', evidence: evidenceFor(cached.record, { recordHash: cached.entry.sha256 }), reason: null };
}

function stats(row, sampleKey) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { avgPlacement: number(row.avgPlacement), top4Rate: number(row.top4Rate), winRate: number(row.winRate), pickRate: number(row.pickRate), sampleSize: number(row[sampleKey]) };
}

export async function getMetaDecks(options={}) {
  if (isDatabaseMode()) return getMetaCompDecks(await getCatalog(), options);
  return getOPGGDecks();
}
export async function getOPGGDecks() {
  const catalog = await getCatalog(); const source = await fetchOPGGTool('tft_list_meta_decks', {});
  if (source.status !== 'live') return { ...source, data: [] };
  if (!Array.isArray(source.data?.data)) return { status: 'unavailable', data: [], evidence: source.evidence, reason: 'OP.GG meta deck schema has no data array.' };
  const championMap = new Map(catalog.champions.map(champion => [champion.id, champion])); const itemMap = new Map(catalog.items.map(item => [item.id, item])); const traitMap = new Map(catalog.traits.map(trait => [trait.id, trait]));
  const accepted = source.data.data.filter(deck => String(deck.teamCode ?? '').endsWith(catalog.context.mutator) && Array.isArray(deck.units) && deck.units.every(unit => championMap.has(unit.key)));
  const data = accepted.map(deck => ({ id: deck.id, name: deck.name?.zh_CN || deck.name?.en_US || String(deck.name || deck.id),
    teamCode: typeof deck.teamCode === 'string' ? deck.teamCode : null,
    units: deck.units.map(unit => ({ id: unit.key, name: championMap.get(unit.key).name, cost: championMap.get(unit.key).cost, icon: championMap.get(unit.key).icon, items: (unit.items ?? []).filter(id => itemMap.has(id)), isCore: unit.isCore, priority: unit.priority, star: unit.tier, cell: unit.cell })),
    traits: (deck.traits ?? []).filter(trait => traitMap.has(trait.key)).map(trait => ({ id: trait.key, name: traitMap.get(trait.key).name, count: trait.numUnits, style: trait.style })), stats: stats(deck.stat?.deck ?? {}, 'compsCount'),
    evidence: { ...source.evidence, set: catalog.context.set, sampleDenominator: 'stat.deck.compsCount (matching comp games)', populationDenominator: deck.stat?.deck?.totalCount ?? null, sourceTotalGameCount: source.data.metadata?.gameStatCounts ?? null, fields: 'stat.deck', deckRating: deck.stat?.opTier ?? null, deckRatingMeaning: 'OP.GG deck rating; not a player rank' },
    // Stage lists are source examples, not a generated economy/levelling guide.
    stages: ['early', 'middle'].filter(stage => deck[stage]).map(stage => ({ stage, level: Number(deck[stage].level), units: deck[stage].units.filter(unit => championMap.has(unit.characterId)).map(unit => ({ id: unit.characterId, name: championMap.get(unit.characterId).name, items: (unit.items ?? []).filter(Boolean), cell: unit.cell })), evidenceKind: 'source_stage_example', play: deck[stage].play ?? null })) }));
  return { status: data.length ? 'live' : 'unavailable', data, evidence: { ...source.evidence, set: catalog.context.set, upstreamDecks: source.data.data.length, acceptedDecks: data.length, excludedDecks: source.data.data.length - data.length }, reason: data.length ? null : 'No source decks matched the current standard set.' };
}

export async function getChampionBuild(championId, options={}) {
  if (isDatabaseMode()) return getMetaDetail('builds',championId,await getCatalog(),options);
  return getOPGGChampionBuild(championId);
}
export async function getOPGGChampionBuild(championId) {
  const catalog = await getCatalog(); const champion = catalog.champions.find(champion => champion.id === championId);
  if (!champion) return { status: 'unavailable', data: [], evidence: null, reason: 'Champion is outside the current standard-set catalog.' };
  const source = await fetchOPGGTool('tft_get_champion_item_build', { champion_id: championId });
  if (source.status !== 'live') return { ...source, data: [] };
  const items = new Map(catalog.items.map(item => [item.id, item]));
  if (!Array.isArray(source.data?.data)) return { status: 'unavailable', data: [], evidence: source.evidence, reason: 'OP.GG item build schema has no data array.' };
  const rows = source.data.data.filter(row => row.characterId === championId && Array.isArray(row.itemNames) && row.itemNames.every(id => items.has(id)));
  const data = rows.map(row => ({ championId, championName: champion.name, itemIds: row.itemNames, items: row.itemNames.map(id => ({ id, name: items.get(id).name, icon: items.get(id).icon })), stats: stats(row, 'itemCount'), evidence: { ...source.evidence, sampleDenominator: 'itemCount (champion occurrences with this build)', populationDenominator: row.totalChampionCount ?? null, set: catalog.context.set } }));
  return { ...source, data, evidence: { ...source.evidence, set: catalog.context.set, upstreamRows: source.data.data.length, acceptedRows: rows.length, excludedRows: source.data.data.length - rows.length } };
}

export async function getItemHolders(itemId, options={}) {
  if (isDatabaseMode()) return getMetaDetail('holders',itemId,await getCatalog(),options);
  return getOPGGItemHolders(itemId);
}
export async function getOPGGItemHolders(itemId) {
  const catalog = await getCatalog(); const item = catalog.items.find(item => item.id === itemId);
  if (!item) return { status: 'unavailable', data: [], evidence: null, reason: 'Item is outside the current standard-set catalog.' };
  const source = await fetchOPGGTool('tft_list_champions_for_item', { item_id: itemId });
  if (source.status !== 'live') return { ...source, data: [] };
  if (!Array.isArray(source.data)) return { status: 'unavailable', data: [], evidence: source.evidence, reason: 'OP.GG holder response was not an array.' };
  const champions = new Map(catalog.champions.map(champion => [champion.id, champion])); const rows = source.data.filter(row => champions.has(row.characterId));
  return { ...source, data: rows.map(row => ({ championId: row.characterId, id: row.characterId, name: champions.get(row.characterId).name, cost: champions.get(row.characterId).cost, icon: champions.get(row.characterId).icon, itemId, stats: stats(row, 'totalCount'), evidence: { ...source.evidence, sampleDenominator: 'totalCount (champion occurrences holding this item)', set: catalog.context.set } })), evidence: { ...source.evidence, set: catalog.context.set, upstreamRows: source.data.length, acceptedRows: rows.length } };
}

export async function getSourceStatus() {
  if (isDatabaseMode()) {
    const catalog=await getCatalog(), stats=await getMetaOverview(catalog);
    return {context:catalog.context,communityDragon:{status:'ready',fetchedAt:catalog.context.fetchedAt,assetVersion:catalog.context.assetVersion,coverage:catalog.coverage},
      metatft:{name:'MetaTFT · 首页、大数据与筛选器',status:'ready',...stats.evidence,coverage:stats.coverage,note:stats.note},
      archives:{name:'旧统计归档',status:'archived',note:'OP.GG 与 Tactics.tools 历史快照保留用于追溯，当前数据库模式下的页面统计不再使用。'}};
  }
  const catalog = await getCatalog(); const opgg = await optionalJSON(new URL('opgg-status.json', dataDir)); const storedManifest=await readDatabaseStatsManifest();const manifest = storedManifest===undefined?await readManifest(catalog):storedManifest;
  const traits = await getTraitStats({ catalog });
  const overall = await getExplorerOverallStats({ catalog });
  return { context: catalog.context, communityDragon: { status: 'ready', fetchedAt: catalog.context.fetchedAt, assetVersion: catalog.context.assetVersion, coverage: catalog.coverage },
    tacticsTools: { status: traits.status === 'live' ? 'ready' : traits.status, ...traits.evidence, coverage: traits.coverage, note: traits.reason || '公开页面中的羁绊档位统计，独立保留来源补丁与 Ranked / Diamond+ 样本；网页只读本地版本缓存。' },
    tacticsOverall: { status: overall.status === 'live' ? 'ready' : overall.status, ...overall.evidence, coverage: overall.coverage, note: overall.reason || overall.evidence.note },
    opgg: { status: manifest ? 'ready' : 'not_cached', endpoint: manifest?.endpoint ?? 'https://mcp-api.op.gg/mcp', lastChecked: manifest?.publishedAt ?? null, fetchedAt: manifest?.publishedAt ?? null, stages: opgg?.stages ?? [], delivery: 'version_cache', cacheKey: cacheKeyFor(catalog), assetVersion: catalog.context.assetVersion, rulesVersion: catalog.context.rulesVersion, set: catalog.context.set, coverage: manifest?.coverage ?? null, gamePatch: null, supportedFilters: [], note: '网页与 Agent 仅读取同一版本本地知识库；不实时联网、不按时间过期刷新。新版本由独立同步任务更新一次，缺项明确保留。' } };
}

export async function getStatsOverview(options={}) {
  if (isDatabaseMode()) return getMetaOverview(await getCatalog(),options);
  const catalog = await getCatalog(); const storedManifest=await readDatabaseStatsManifest();const manifest = storedManifest===undefined?await readManifest(catalog):storedManifest;
  const traits = await getTraitStats({ catalog });
  const overall = await getExplorerOverallStats({ catalog });
  const entryFor = (tool, args) => manifest?.records?.[queryKey(tool, args)];
  const champions = catalog.champions.map(item => { const entry = entryFor('tft_get_champion_item_build', { champion_id: item.id }); return { id: item.id, name: item.name, cost: item.cost, cached: entry?.status === 'ok', rowCount: entry?.status === 'ok' ? entry.rowCount : 0, ...(entry?.status === 'not_supported' ? { status: 'not_supported' } : {}) }; });
  const items = catalog.items.filter(item => item.kind !== 'component').map(item => { const entry = entryFor('tft_list_champions_for_item', { item_id: item.id }); return { id: item.id, name: item.name, category: item.category, cached: entry?.status === 'ok', rowCount: entry?.status === 'ok' ? entry.rowCount : 0, ...(entry?.status === 'not_supported' ? { status: 'not_supported' } : {}) }; });
  return { status: manifest ? 'ready' : 'not_cached', cacheKey: cacheKeyFor(catalog), context: cacheContext(catalog), fetchedAt: manifest?.publishedAt ?? null, delivery: manifest?.delivery||'version_cache',
    coverage: { ...(manifest?.coverage ?? { decks: 0, championBuilds: { cached: 0, total: champions.length }, itemHolders: { cached: 0, total: items.length }, emblemHolders: { cached: 0, total: items.filter(item => item.category === 'emblem').length }, complete: false }),
      traitStats: { status: traits.status, cached: traits.coverage.cachedTraits, total: traits.coverage.totalTraits, rowCount: traits.data.length, sourcePatch: traits.evidence.sourcePatch, delivery: traits.delivery },
      overallStats: { status: overall.status, champions: overall.coverage.champions, items: overall.coverage.items, sourcePatch: overall.evidence.sourcePatch, delivery: overall.delivery } }, champions, items,
    capabilities: { deckStats: true, championBuildStats: true, itemHolderStats: true, championOverallStats: overall.status === 'live', itemOverallStats: overall.status === 'live', traitStats: traits.status === 'live', augmentStats: false, rankRegionFilters: false },
    ...(manifest ? {} : { reason: '当前版本统计知识库尚未同步；不会由网页或 Agent 自动请求上游。' }) };
}
