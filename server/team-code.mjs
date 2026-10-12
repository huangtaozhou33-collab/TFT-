import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getCatalog, fetchOPGGTool } from './data.mjs';
import { cacheContext, cacheKeyFor, sha256, stableJSON } from '../scripts/stats-cache.mjs';
import { decodePCCode, encodePCCode, TeamCodeError } from '../public/team-code.js';
export { TeamCodeError } from '../public/team-code.js';

export const TEAM_CODES_DIR = new URL('../data/team-codes/', import.meta.url);
export const mappingURL = catalog => `https://raw.communitydragon.org/${catalog.context.assetVersion}/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json`;
const championFingerprint = catalog => sha256(catalog.champions.map(champion => champion.id).sort());
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }

export function normalizeTeamPlannerMapping(raw, catalog, { fetchedAt, sourceTime = null, url = mappingURL(catalog) } = {}) {
  if (url !== mappingURL(catalog) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid pinned PC mapping source or original capture time.');
  const source = raw?.[catalog.context.mutator];
  if (!Array.isArray(source) || !source.length || source.length > 255) throw new Error('The current mutator has no supported public PC mapping.');
  const championMap = new Map(catalog.champions.map(champion => [champion.id, champion])), seenIds = new Set(), seenCodes = new Set();
  for (const row of source) {
    if (!/^[A-Za-z0-9_]+$/.test(row?.character_id ?? '') || seenIds.has(row.character_id) || !Number.isSafeInteger(row.team_planner_code) || row.team_planner_code < 1 || row.team_planner_code > 4095 || seenCodes.has(row.team_planner_code)) throw new Error('Invalid, missing or duplicate public PC champion mapping.');
    seenIds.add(row.character_id); seenCodes.add(row.team_planner_code);
  }
  // v1 indexes the complete source mutator pool, before joining our catalog.
  // Dropping an unsupported source row before sorting would shift every later ID.
  const sorted = [...source].sort((a, b) => a.character_id.localeCompare(b.character_id, 'en'));
  const entries = [], excluded = [], v1 = {}, v2 = {};
  sorted.forEach((row, index) => {
    const champion = championMap.get(row.character_id);
    if (!champion) { excluded.push({ sourceId: row.character_id, v1Index: index + 1, teamPlannerCode: row.team_planner_code, reason: 'outside_current_catalog' }); return; }
    const entry = { championId: champion.id, name: champion.name, cost: champion.cost, icon: champion.icon ?? null, v1: index + 1, v2: row.team_planner_code };
    entries.push(entry); v1[entry.v1] = entry.championId; v2[entry.v2] = entry.championId;
  });
  if (!entries.length) throw new Error('No exact PC mapping IDs match the current catalog.');
  const missing = catalog.champions.filter(champion => !seenIds.has(champion.id)).map(champion => ({ id: champion.id, name: champion.name, reason: 'not_in_current_pc_teamplanner_source' }));
  return { schemaVersion: 1, status: 'cached', delivery: 'version_cache', cacheKey: cacheKeyFor(catalog), context: cacheContext(catalog), championFingerprint: championFingerprint(catalog),
    entries, v1, v2, coverage: { sourceRows: source.length, mappedChampions: entries.length, catalogChampions: catalog.champions.length, excluded, unmappedCatalog: missing, complete: !excluded.length && !missing.length },
    evidence: { source: 'CommunityDragon · PC Team Planner', url, assetVersion: catalog.context.assetVersion, set: catalog.context.set, mutator: catalog.context.mutator,
      sourcePatch: null, gamePatch: null, fetchedAt, sourceTime: sourceTime ?? null, rawJSONSha256: sha256(raw),
      idJoin: 'exact_character_id_to_current_catalog', v1Mapping: 'full_source_character_id_sorted_en_alphabetical_one_based', v2Mapping: 'source_team_planner_code_integer',
      formatResearch: ['https://github.com/ttkienn/TFT-Team-Planner-Code/blob/main/TFT.js', 'https://gist.github.com/bangingheads/243e396f78be1a4d49dc0577abf57a0b'],
      officialSupport: 'https://teamfighttactics.leagueoflegends.com/en-sg/news/game-updates/teamfight-tactics-patch-13-7-notes-2025/',
      compatibility: 'source_format_and_mapping_verified; real_game_client_not_tested', populationCostAvailable: false,
      note: '两个格式的块宽为2或3个十六进制字符，不是2或3个字节。原生码不含装备、棋盘坐标或星级；资产版本不等于统计补丁。' } };
}

function validateMapping(payload, catalog) {
  if (!payload || payload.schemaVersion !== 1 || payload.cacheKey !== cacheKeyFor(catalog) || stableJSON(payload.context) !== stableJSON(cacheContext(catalog)) || payload.championFingerprint !== championFingerprint(catalog) ||
    payload.evidence?.url !== mappingURL(catalog) || payload.evidence?.set !== catalog.context.set || payload.evidence?.mutator !== catalog.context.mutator || !Number.isFinite(Date.parse(payload.evidence?.fetchedAt)) || !/^[a-f0-9]{64}$/.test(payload.evidence?.rawJSONSha256 ?? '') || !Array.isArray(payload.entries)) return false;
  const ids = new Set(catalog.champions.map(champion => champion.id)); if (payload.entries.some(row => !ids.has(row.championId))) return false;
  try { encodePCCode([], payload, cacheContext(catalog)); return true; } catch { return false; }
}

export async function readTeamCodeMapping(catalog, dir = TEAM_CODES_DIR) {
  const key = cacheKeyFor(catalog), manifest = await optionalJSON(new URL(`${key}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== key || stableJSON(manifest.context) !== stableJSON(cacheContext(catalog)) || !/^[a-f0-9-]{36}\.json$/.test(manifest.file)) return null;
  const payload = await optionalJSON(new URL(`${key}/${manifest.file}`, dir));
  return validateMapping(payload, catalog) && sha256(payload) === manifest.sha256 ? { payload, manifest } : null;
}

export async function publishTeamCodeMapping(catalog, payload, raw, dir = TEAM_CODES_DIR) {
  if (!validateMapping(payload, catalog) || payload.evidence.rawJSONSha256 !== sha256(raw)) throw new Error('PC mapping source/context integrity validation failed.');
  const key = cacheKeyFor(catalog), folder = new URL(`${key}/`, dir), rawFolder = new URL(`raw/${key}/`, dir); await mkdir(folder, { recursive: true }); await mkdir(rawFolder, { recursive: true });
  const capture = randomUUID(), file = `${capture}.json`, target = new URL(file, folder); await writeFile(target, JSON.stringify(payload, null, 2)); await writeFile(new URL(`${capture}.json`, rawFolder), JSON.stringify(raw));
  const disk = await optionalJSON(target); if (!validateMapping(disk, catalog) || sha256(disk) !== sha256(payload)) throw new Error('PC mapping disk integrity validation failed.');
  const manifest = { schemaVersion: 1, cacheKey: key, context: payload.context, file, sha256: sha256(payload), source: payload.evidence, coverage: payload.coverage, publishedAt: new Date().toISOString() };
  const next = new URL(`manifest.${capture}.next.json`, folder); await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', folder)); return manifest;
}

async function requireCachedMapping(catalog, dir) {
  const cached = await readTeamCodeMapping(catalog, dir);
  if (!cached) throw new TeamCodeError('mapping_not_cached', '当前版本PC阵容码映射未收录或校验失败；请先运行独立 sync:team-codes 任务。解码不会联网。', 503);
  return cached.payload;
}
function sameMultiset(first, second) { return first.length === second.length && [...first].sort().join('\n') === [...second].sort().join('\n'); }

export function matchSourceLayout(decoded, sourceResult, catalog) {
  if (sourceResult?.status !== 'live' || !Array.isArray(sourceResult.data?.data) || sourceResult.evidence?.cacheKey !== cacheKeyFor(catalog) || sourceResult.evidence?.set !== catalog.context.set ||
    sourceResult.evidence?.assetVersion !== catalog.context.assetVersion || sourceResult.evidence?.rulesVersion !== catalog.context.rulesVersion || !/^[a-f0-9]{64}$/.test(sourceResult.evidence?.recordHash ?? '')) return null;
  const matches = sourceResult.data.data.filter(deck => String(deck.teamCode ?? '').toLowerCase() === decoded.code.toLowerCase() && Array.isArray(deck.units) && sameMultiset(decoded.units.map(unit => unit.championId), deck.units.map(unit => unit.key)));
  if (matches.length !== 1) return null;
  const deck = matches[0], itemIDs = new Set(catalog.items.map(item => item.id));
  if (deck.units.some(unit => !Array.isArray(unit.items) || unit.items.some(id => !itemIDs.has(id)))) return null;
  const units = deck.units.map((unit, index) => ({ instanceId: `source-${deck.id}-${index + 1}`, championId: unit.key, items: [...unit.items],
    cell: Number.isSafeInteger(unit.cell?.x) && unit.cell.x >= 1 && unit.cell.x <= 7 && Number.isSafeInteger(unit.cell?.y) && unit.cell.y >= 1 && unit.cell.y <= 4 ? { x: unit.cell.x, y: unit.cell.y } : null,
    star: Number.isSafeInteger(unit.tier) && unit.tier >= 1 && unit.tier <= 3 ? unit.tier : null, starOrigin: 'source_layout', isCore: Boolean(unit.isCore) }));
  return { units, context: cacheContext(catalog), source: { id: deck.id, name: deck.name?.zh_CN || deck.name?.en_US || String(deck.id), evidence: sourceResult.evidence },
    includes: { champions: true, items: true, positions: units.some(unit => unit.cell), stars: units.some(unit => unit.star != null) },
    coordinateSystem: { kind: 'source_raw_xy', columns: 7, rows: 4, indexBase: 1, frontRowY: 4,
      verification: { source: 'OP.GG public team-builder', url: 'https://op.gg/tft/tools/team-builder',
        mappingUrl: 'https://c-tft-web.op.gg/_next/static/chunks/5923-875d594a93cc412d.js', formula: 'row=4-y,col=x-1' } }, notEncodedInCode: true,
    warning: '这些装备、站位和星级来自精确命中的OP.GG本地阵容快照，不是原生阵容码内的数据。' };
}

export async function decodeTeamCode(code, { catalog, dir = TEAM_CODES_DIR, statsReader = fetchOPGGTool } = {}) {
  catalog ??= await getCatalog(); const mapping = await requireCachedMapping(catalog, dir), decoded = decodePCCode(code, mapping, cacheContext(catalog));
  let sourceResult = null;
  try { sourceResult = await statsReader('tft_list_meta_decks', {}); } catch { /* A missing optional local layout never changes decoded native fields. */ }
  return { ...decoded, mappingEvidence: { ...mapping.evidence, recordHash: sha256(mapping), cacheKey: mapping.cacheKey, delivery: 'version_cache' }, mappingCoverage: mapping.coverage,
    sourceLayout: matchSourceLayout(decoded, sourceResult, catalog) };
}
export async function encodeTeamCode(units, { catalog, dir = TEAM_CODES_DIR, version = 2 } = {}) {
  catalog ??= await getCatalog(); const mapping = await requireCachedMapping(catalog, dir);
  return { ...encodePCCode(units, mapping, cacheContext(catalog), { version }), mappingEvidence: { ...mapping.evidence, recordHash: sha256(mapping), cacheKey: mapping.cacheKey, delivery: 'version_cache' } };
}
