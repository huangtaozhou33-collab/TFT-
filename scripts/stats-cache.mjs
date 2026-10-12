import { readFile, mkdir, writeFile, rename, readdir, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const STATS_DIR = new URL('../data/stats/', import.meta.url);
export const TOOL_NAMES = new Set(['tft_list_meta_decks', 'tft_get_champion_item_build', 'tft_list_champions_for_item', 'tft_list_item_combinations', 'tft_list_augments']);
export const stableJSON = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');
export function cacheContext(catalog) { const c = catalog.context; return { game: c.game, set: c.set, mutator: c.mutator, assetVersion: c.assetVersion, rulesVersion: c.rulesVersion, gamePatch: c.gamePatch ?? null }; }
export function cacheKeyFor(catalog) { const context = cacheContext(catalog); if (context.game !== 'tft' || !Number.isSafeInteger(context.set) || context.set < 1 || !/^\d+\.\d+$/.test(context.assetVersion)) throw new Error('Invalid cache game/set/asset context.'); return `tft-set${context.set}-assets${context.assetVersion}-${sha256(context).slice(0, 12)}`; }
export function queryKey(tool, args = {}) { return sha256({ tool, args }); }
export async function optionalJSON(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
export async function readManifest(catalog, dir = STATS_DIR) {
  const key = cacheKeyFor(catalog); const manifest = await optionalJSON(new URL(`${key}/manifest.json`, dir));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.cacheKey !== key || stableJSON(manifest.context) !== stableJSON(cacheContext(catalog)) || !/^[a-f0-9-]{36}$/.test(manifest.captureId)) return null;
  return manifest;
}
export async function readRecord(manifest, tool, args = {}, dir = STATS_DIR) {
  const entry = manifest?.records?.[queryKey(tool, args)];
  if (!entry || entry.tool !== tool || stableJSON(entry.args) !== stableJSON(args) || !/^[a-f0-9]{64}\.json$/.test(entry.file)) return null;
  const record = await optionalJSON(new URL(`${manifest.cacheKey}/snapshots/${manifest.captureId}/records/${entry.file}`, dir));
  if (!record || sha256(record) !== entry.sha256 || record.cacheKey !== manifest.cacheKey || stableJSON(record.boundContext) !== stableJSON(manifest.context) || record.tool !== tool || stableJSON(record.args) !== stableJSON(args)) return null;
  return { record, entry };
}
export async function acquireSyncLock(catalog, dir = STATS_DIR) {
  const versionDir = new URL(`${cacheKeyFor(catalog)}/`, dir); await mkdir(versionDir, { recursive: true }); const path = new URL('sync.lock.json', versionDir);
  const previous = await optionalJSON(path);
  if (previous?.pid) { let alive = true; try { process.kill(previous.pid, 0); } catch (error) { alive = error.code === 'EPERM'; } if (alive) throw new Error('A statistics sync for this version is already running.'); await unlink(path); }
  const handle = await open(path, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.close();
  return async () => { const own = await optionalJSON(path); if (own?.pid === process.pid) await unlink(path).catch(() => {}); };
}
export async function savePendingRecord(catalog, raw, dir = STATS_DIR) {
  validateSourceRecord(raw, catalog); const key = cacheKeyFor(catalog); const record = { ...raw, cacheKey: key, boundContext: cacheContext(catalog) }; const pendingDir = new URL(`${key}/pending/`, dir); await mkdir(pendingDir, { recursive: true });
  const filename = `${queryKey(raw.tool, raw.args)}.json`, next = new URL(`${filename}.${randomUUID()}.next`, pendingDir);
  await writeFile(next, JSON.stringify({ sha256: sha256(record), record }, null, 2)); await rename(next, new URL(filename, pendingDir));
}
export async function readPendingRecords(catalog, dir = STATS_DIR) {
  const key = cacheKeyFor(catalog), pendingDir = new URL(`${key}/pending/`, dir); const records = new Map(); let files = [];
  try { files = await readdir(pendingDir); } catch { return records; }
  for (const filename of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
    const envelope = await optionalJSON(new URL(filename, pendingDir)), record = envelope?.record;
    if (!record || record.cacheKey !== key || stableJSON(record.boundContext) !== stableJSON(cacheContext(catalog)) || envelope.sha256 !== sha256(record) || filename !== `${queryKey(record.tool, record.args)}.json`) continue;
    try { validateSourceRecord(record, catalog); records.set(queryKey(record.tool, record.args), record); } catch {}
  }
  return records;
}
export function validateSourceRecord(record, catalog) {
  if (!TOOL_NAMES.has(record.tool) || !record.args || !record.fetchedAt || !Number.isFinite(Date.parse(record.fetchedAt))) throw new Error('Invalid statistics record identity/time.');
  if (record.status === 'not_supported') return { rowCount: 0, rawRowCount: 0, excludedRows: 0 };
  const champions = new Set(catalog.champions.map(item => item.id)); const items = new Set(catalog.items.map(item => item.id));
  const body = record.body; let rows, accepted;
  if (record.tool === 'tft_list_meta_decks') {
    if (!Array.isArray(body?.data)) throw new Error('Meta-deck data array missing.');
    rows = body.data; accepted = rows.filter(deck => String(deck.teamCode ?? '').endsWith(catalog.context.mutator) && Array.isArray(deck.units) && deck.units.every(unit => champions.has(unit.key) && (unit.items ?? []).every(id => items.has(id))));
    if (rows.length && !accepted.length) throw new Error('All meta decks are outside the current set.');
  } else if (record.tool === 'tft_get_champion_item_build') {
    if (!champions.has(record.args.champion_id) || !Array.isArray(body?.data)) throw new Error('Invalid champion build entity/schema.');
    rows = body.data; accepted = rows.filter(row => row.characterId === record.args.champion_id && Array.isArray(row.itemNames) && row.itemNames.every(id => items.has(id)));
    if (rows.some(row => row.characterId !== record.args.champion_id)) throw new Error('Champion build response belongs to another entity/set.');
    if (rows.length && !accepted.length) throw new Error('No build items map to the current catalog.');
  } else if (record.tool === 'tft_list_champions_for_item') {
    if (!items.has(record.args.item_id) || !Array.isArray(body)) throw new Error('Invalid holder entity/schema.');
    rows = body; accepted = rows.filter(row => champions.has(row.characterId));
    if (rows.length && !accepted.length) throw new Error('All holder rows are outside the current set.');
  } else if (record.tool === 'tft_list_item_combinations') {
    if (body?.set !== catalog.context.set || !Array.isArray(body.data)) throw new Error('Recipe set/schema does not match catalog.');
    rows = body.data; accepted = rows.filter(row => items.has(row.apiName));
  } else {
    if (!Array.isArray(body?.headers) || !Array.isArray(body?.rows)) throw new Error('Augment table schema missing.');
    const index = body.headers.indexOf('apiName'); if (index < 0) throw new Error('Augment ID header missing.');
    const ids = new Set(catalog.augments.map(item => item.id)); rows = body.rows; accepted = rows.filter(row => ids.has(row[index]));
  }
  return { rowCount: accepted.length, rawRowCount: rows.length, excludedRows: rows.length - accepted.length };
}
export async function publishRecords(catalog, records, { dir = STATS_DIR, endpoint = 'https://mcp-api.op.gg/mcp', failures = [] } = {}) {
  const key = cacheKeyFor(catalog), captureId = randomUUID(); const context = cacheContext(catalog);
  const captureDir = new URL(`${key}/snapshots/${captureId}/`, dir); await mkdir(new URL('records/', captureDir), { recursive: true });
  const entries = {};
  for (const raw of records.values()) {
    const metrics = validateSourceRecord(raw, catalog);
    const record = { ...raw, status: raw.status ?? 'ok', cacheKey: key, boundContext: context };
    const query = queryKey(record.tool, record.args), file = `${query}.json`;
    await writeFile(new URL(`records/${file}`, captureDir), JSON.stringify(record, null, 2));
    entries[query] = { tool: record.tool, args: record.args, file, sha256: sha256(record), status: record.status, fetchedAt: record.fetchedAt, sourceTime: record.body?.metadata?.gameStatDateTime ?? null, sourcePatch: record.body?.version ?? null, ...metrics };
  }
  const indexEntries = Object.values(entries); const championTotal = catalog.champions.length; const itemTotal = catalog.items.filter(item => item.kind !== 'component').length;
  const count = (tool, status = 'ok') => indexEntries.filter(entry => entry.tool === tool && entry.status === status).length;
  const championAttempted = count('tft_get_champion_item_build') + count('tft_get_champion_item_build', 'not_supported');
  const itemAttempted = count('tft_list_champions_for_item') + count('tft_list_champions_for_item', 'not_supported');
  const manifest = { schemaVersion: 1, cacheKey: key, captureId, context, endpoint, publishedAt: new Date().toISOString(), records: entries, failures,
    coverage: { decks: indexEntries.find(entry => entry.tool === 'tft_list_meta_decks' && entry.status === 'ok')?.rowCount ?? 0,
      championBuilds: { cached: count('tft_get_champion_item_build'), attempted: championAttempted, unsupported: count('tft_get_champion_item_build', 'not_supported'), total: championTotal },
      itemHolders: { cached: count('tft_list_champions_for_item'), attempted: itemAttempted, unsupported: count('tft_list_champions_for_item', 'not_supported'), total: itemTotal },
      emblemHolders: { cached: catalog.items.filter(item => item.category === 'emblem' && entries[queryKey('tft_list_champions_for_item', { item_id: item.id })]?.status === 'ok').length, total: catalog.items.filter(item => item.category === 'emblem').length },
      complete: championAttempted === championTotal && itemAttempted === itemTotal && count('tft_list_meta_decks') === 1 } };
  await writeFile(new URL('manifest.json', captureDir), JSON.stringify(manifest, null, 2));
  // Verify disk files before publishing the single manifest pointer. A failed or
  // interrupted batch leaves the previous good manifest and records untouched.
  for (const entry of indexEntries) if (!await readRecord(manifest, entry.tool, entry.args, dir)) throw new Error(`Staged record failed integrity check: ${entry.tool}`);
  const versionDir = new URL(`${key}/`, dir); const next = new URL(`manifest.${captureId}.next.json`, versionDir);
  await writeFile(next, JSON.stringify(manifest, null, 2)); await rename(next, new URL('manifest.json', versionDir));
  const currentNext = new URL(`current.${captureId}.next.json`, dir);
  await writeFile(currentNext, JSON.stringify({ cacheKey: key, context, publishedAt: manifest.publishedAt }, null, 2)); await rename(currentNext, new URL('current.json', dir));
  return manifest;
}
