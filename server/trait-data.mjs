import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';

export const TRAITS_DIR = new URL('../data/traits/', import.meta.url);
export const TRAITS_URL = 'https://tactics.tools/traits';
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }

export function normalizeTacticsHTML(html, catalog, { fetchedAt, url = TRAITS_URL } = {}) {
  if (url !== TRAITS_URL || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid public trait source URL or capture time.');
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
  const identity = title?.match(/TFT Traits Stats - Best Traits for Set (\d+) Patch (\d+\.\d+[a-z]?)/);
  if (!identity || Number(identity[1]) !== catalog.context.set) throw new Error('Public trait page set/patch identity does not match the current catalog.');
  const sourcePatch = identity[2];
  const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!embedded) throw new Error('Public HTML contains no __NEXT_DATA__; no undocumented API fallback is allowed.');
  const parsed = JSON.parse(embedded), page = parsed.props?.pageProps;
  if (parsed.page !== '/traits/[[...slug]]' || !page?.statsData?.traits || Array.isArray(page.statsData.traits)) throw new Error('Public trait page schema changed.');
  const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (page.aperture?.queue !== 1100 || page.aperture?.gameType !== 0 || page.aperture?.rankGroup !== 1 || !visibleText.includes(`Ranked Diamond+ ${sourcePatch}`)) throw new Error('Public page Ranked/Diamond+/patch filters could not be verified.');
  const raw = page.statsData;
  if (!Number.isSafeInteger(raw.totalEntries) || raw.totalEntries <= 0 || !Number.isSafeInteger(raw.lastUpdated) || raw.lastUpdated <= 0) throw new Error('Public trait sample/time metadata missing.');
  const sourceTime = new Date(raw.lastUpdated * 1000).toISOString();
  if (Date.parse(sourceTime) > Date.parse(fetchedAt) + 300_000) throw new Error('Source update time is later than the capture time.');
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog);
  const evidence = { source: 'Tactics.tools', url, endpoint: url, sourcePatch, gamePatch: sourcePatch, set: catalog.context.set,
    queue: 'Ranked', rank: 'Diamond+', population: { queue: 'Ranked', rank: 'Diamond+', region: null }, region: null,
    statisticalWindow: { selection: `page patch ${sourcePatch}`, from: null, to: null },
    fetchedAt, sourceTime, delivery: 'version_cache', cacheKey, assetVersion: context.assetVersion, rulesVersion: context.rulesVersion,
    sampleDenominator: 'source statsData.traits[key].count (trait-tier occurrences)', sourceTotalEntries: raw.totalEntries,
    sourceTotalEntriesMeaning: 'page statsData.totalEntries; separate source sample, not OP.GG game count',
    sourceHTMLSha256: sha256(html), aperture: page.aperture,
    mappingMethod: 'exact_trait_id_and_one_based_effect_index', rateUnit: 'fraction (source percentages divided by 100)',
    unsupportedDimensions: ['region', 'star', 'cross_source_population_comparison'],
    note: '按来源羁绊档位统计；不代表全队因果收益，不与 OP.GG 样本或段位口径合并。' };
  const traitMap = new Map(catalog.traits.map(trait => [trait.id, trait])); const data = [], excluded = [];
  for (const [key, row] of Object.entries(raw.traits)) {
    const match = /^(\w+)__(\d+)$/.exec(key); const trait = match ? traitMap.get(match[1]) : null;
    const tier = Number(match?.[2]), effect = trait?.effects?.[tier - 1];
    if (!trait || !effect || !Number.isSafeInteger(tier) || tier < 1 || !Number.isSafeInteger(effect.minUnits) || effect.minUnits < 1) { excluded.push({ sourceKey: key, reason: trait ? 'unmapped_effect_tier' : 'outside_current_catalog' }); continue; }
    if (!Number.isSafeInteger(row.count) || row.count < 0 || row.count > raw.totalEntries || !Number.isFinite(row.place) || row.place < 1 || row.place > 8 || !Number.isFinite(row.top4) || row.top4 < 0 || row.top4 > 100 || !Number.isFinite(row.won) || row.won < 0 || row.won > 100) throw new Error(`Invalid public trait statistics row: ${key}`);
    data.push({ id: key, traitId: trait.id, name: trait.name, icon: trait.icon, tier, level: effect.minUnits, minUnits: effect.minUnits, maxUnits: effect.maxUnits ?? null,
      stats: { avgPlacement: row.place, top4Rate: row.top4 / 100, winRate: row.won / 100, sampleSize: row.count },
      mapping: { method: evidence.mappingMethod, effectIndex: tier - 1, sourceOrdinal: tier, semantics: 'minUnits is the catalog activation threshold; tier is the source ordinal' } });
  }
  if (!data.length) throw new Error('No public trait rows map to the current catalog.');
  const cachedTraits = new Set(data.map(row => row.traitId)).size;
  const coverage = { sourceRows: Object.keys(raw.traits).length, acceptedRows: data.length, excludedRows: excluded.length, cachedTraits, totalTraits: catalog.traits.length,
    complete: cachedTraits === catalog.traits.length && !excluded.length, excluded,
    note: 'complete 表示来源行均可映射；cachedTraits/totalTraits 单独说明当前目录的羁绊覆盖，不声称全部潜在档位均有样本。' };
  return { schemaVersion: 1, status: 'live', delivery: 'version_cache', cacheKey, context, coverage, data, evidence, reason: null };
}

export async function readTraitSnapshot(catalog, dir = TRAITS_DIR) {
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog);
  const manifest = await optionalJSON(new URL(`${cacheKey}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== cacheKey || stableJSON(manifest.context) !== stableJSON(context) || !/^[a-f0-9-]{36}\.json$/.test(manifest.file)) return null;
  const payload = await optionalJSON(new URL(`${cacheKey}/${manifest.file}`, dir));
  if (!payload || payload.schemaVersion !== 1 || payload.cacheKey !== cacheKey || stableJSON(payload.context) !== stableJSON(context) || sha256(payload) !== manifest.sha256 || payload.evidence?.source !== 'Tactics.tools' || payload.evidence?.url !== TRAITS_URL || payload.evidence?.set !== catalog.context.set || !Array.isArray(payload.data)) return null;
  return { payload, manifest };
}

export async function publishTraitSnapshot(catalog, payload, html, dir = TRAITS_DIR) {
  const cacheKey = cacheKeyFor(catalog), context = cacheContext(catalog);
  if (payload.cacheKey !== cacheKey || stableJSON(payload.context) !== stableJSON(context) || payload.evidence.sourceHTMLSha256 !== sha256(html)) throw new Error('Trait snapshot source/context validation failed.');
  const versionDir = new URL(`${cacheKey}/`, dir); await mkdir(new URL('raw/', versionDir), { recursive: true });
  const captureId = randomUUID(), file = `${captureId}.json`, target = new URL(file, versionDir);
  await writeFile(target, JSON.stringify(payload, null, 2)); await writeFile(new URL(`raw/${captureId}.html`, versionDir), html);
  if (sha256(await optionalJSON(target)) !== sha256(payload)) throw new Error('Trait snapshot disk integrity validation failed.');
  const manifest = { schemaVersion: 1, cacheKey, context, file, sha256: sha256(payload), publishedAt: new Date().toISOString(), fetchedAt: payload.evidence.fetchedAt, sourceTime: payload.evidence.sourceTime, sourcePatch: payload.evidence.sourcePatch, coverage: payload.coverage };
  const next = new URL(`manifest.${captureId}.next.json`, versionDir); await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', versionDir));
  return manifest;
}

export async function getTraitStats({ catalog, rank, dir = TRAITS_DIR } = {}) {
  const { readDatabaseSnapshot, isDatabaseMode } = await import('./storage/runtime.mjs');
  if (isDatabaseMode()) return (await import('./metatft/datasets.mjs')).getMetaTraits(catalog || await (await import('./data.mjs')).getCatalog(),{rank});
  const stored = await readDatabaseSnapshot('traits', {statistics:true});
  if (stored !== undefined) return stored;
  // Lazy import avoids a data -> trait-data -> data initialization cycle.
  catalog ??= await (await import('./data.mjs')).getCatalog();
  const cached = await readTraitSnapshot(catalog, dir);
  if (cached) return cached.payload;
  const cacheKey = cacheKeyFor(catalog);
  return { status: 'not_cached', code: 'not_cached', delivery: 'version_cache', cacheKey, context: cacheContext(catalog),
    coverage: { sourceRows: 0, acceptedRows: 0, excludedRows: 0, cachedTraits: 0, totalTraits: catalog.traits.length, complete: false }, data: [],
    evidence: { source: 'Tactics.tools', url: TRAITS_URL, endpoint: TRAITS_URL, set: catalog.context.set, delivery: 'version_cache', cacheKey, sourcePatch: null, gamePatch: null, sourceTime: null, fetchedAt: null, population: null },
    reason: '当前版本本地知识库尚未收录羁绊统计，或缓存完整性校验未通过；网页与 Agent 不会自动联网。请运行独立 sync:traits 同步任务。' };
}
