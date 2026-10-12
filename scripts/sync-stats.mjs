import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getCatalog } from '../server/data.mjs';
import { OPGGClient, describeError, unwrapTool } from './opgg-client.mjs';
import { cacheKeyFor, queryKey, readManifest, readRecord, publishRecords, validateSourceRecord, optionalJSON, acquireSyncLock, savePendingRecord, readPendingRecords } from './stats-cache.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function options(argv) {
  const value = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return { force: argv.includes('--force'), complete: argv.includes('--complete'), offline: argv.includes('--offline'), migrate: !argv.includes('--no-migrate'), champions: value('champions', 'all'), items: value('items', 'all'), delayMs: Math.max(500, Number(value('delay-ms', '750')) || 750) };
}
function selected(value, all) {
  if (value === 'all') return all.map(item => item.id);
  const ids = value.split(',').map(id => id.trim()).filter(Boolean); const allowed = new Set(all.map(item => item.id));
  if (ids.some(id => !allowed.has(id))) throw new Error('Requested statistics entity is outside the current catalog.');
  return [...new Set(ids)];
}

export async function syncStats(argv = process.argv.slice(2)) {
  const opts = options(argv); const catalog = await getCatalog(); const existing = await readManifest(catalog); const key = cacheKeyFor(catalog);
  if (existing && !opts.force && !opts.complete) { console.log(JSON.stringify({ status: 'skipped', cacheKey: key, reason: 'This version already has a published cache. Use --complete to fill missing entities, or --force to explicitly capture selected records again.', coverage: existing.coverage })); return existing; }
  const records = new Map();
  if (existing) for (const entry of Object.values(existing.records)) {
    const cached = await readRecord(existing, entry.tool, entry.args); if (!cached) throw new Error('Previous published cache failed integrity validation; it was not overwritten.');
    records.set(queryKey(entry.tool, entry.args), cached.record);
  }
  for (const [query, pending] of await readPendingRecords(catalog)) if (!records.has(query)) records.set(query, pending);
  if (opts.migrate) {
    const rawDir = new URL('../data/raw/', import.meta.url); const rawManifest = await optionalJSON(new URL('cdragon-manifest.json', rawDir));
    // Legacy files have no asset binding. Migrate only alongside their matching
    // static download manifest, then validate every primary entity and set.
    if (rawManifest?.assetVersion === catalog.context.assetVersion) {
      for (const file of await readdir(rawDir)) {
        if (!/^opgg-tft_.*\.json$/.test(file)) continue;
        const raw = await optionalJSON(new URL(file, rawDir)); if (!raw?.tool || !raw.body || !raw.args) continue;
        const query = queryKey(raw.tool, raw.args); if (records.has(query)) continue;
        try { validateSourceRecord(raw, catalog); records.set(query, { ...raw, status: 'ok', migration: 'validated_matching_asset_legacy_snapshot' }); }
        catch (error) { console.log(JSON.stringify({ status: 'migration_excluded', file, reason: error.message })); }
      }
    }
  }
  const champions = selected(opts.champions, catalog.champions);
  const eligibleItems = catalog.items.filter(item => item.kind !== 'component'); const items = selected(opts.items, eligibleItems).sort((a, b) => Number(eligibleItems.find(item => item.id === b).category === 'emblem') - Number(eligibleItems.find(item => item.id === a).category === 'emblem'));
  const requests = [ ['tft_list_meta_decks', {}], ['tft_list_item_combinations', { lang: 'zh_CN' }], ['tft_list_augments', { lang: 'zh_CN' }],
    ...items.map(id => ['tft_list_champions_for_item', { item_id: id }]), ...champions.map(id => ['tft_get_champion_item_build', { champion_id: id }]) ];
  const client = new OPGGClient(process.env.OPGG_MCP_URL || 'https://mcp-api.op.gg/mcp');
  let newCount = 0, unsupportedCount = 0; let initialized = false;
  const releaseLock = await acquireSyncLock(catalog);
  try {
    for (const [tool, args] of requests) {
      const query = queryKey(tool, args); if (records.has(query) && !opts.force) continue;
      if (opts.offline) continue;
      if (!initialized) { await client.initialize(); initialized = true; }
      const definition = client.tools.find(item => item.name === tool);
      const argKey = args.champion_id ? 'champion_id' : args.item_id ? 'item_id' : null;
      if (argKey && definition?.inputSchema?.properties?.[argKey]?.enum && !definition.inputSchema.properties[argKey].enum.includes(args[argKey])) {
        const record = { status: 'not_supported', fetchedAt: new Date().toISOString(), endpoint: client.endpoint, tool, args, body: null, reason: '当前官方工具实际 schema 的实体 enum 不包含此 ID；未请求、不伪造统计。' };
        await savePendingRecord(catalog, record); records.set(query, record);
        unsupportedCount++; console.log(JSON.stringify({ tool, entity: args[argKey], status: 'not_supported' })); continue;
      }
      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { result = await client.call(tool, args); break; }
        catch (error) {
          const diagnostic = describeError(error);
          const retryable = diagnostic.httpStatus === 429 || diagnostic.httpStatus >= 500 || ['connection', 'dns'].includes(diagnostic.layer);
          if (!retryable || attempt === 4) throw error;
          const delay = Math.min(30_000, 1500 * 2 ** attempt);
          console.log(JSON.stringify({ tool, entity: args[argKey] ?? null, status: 'retry', attempt: attempt + 1, delayMs: delay, failure: diagnostic })); await pause(delay);
        }
      }
      const raw = { status: 'ok', fetchedAt: new Date().toISOString(), endpoint: client.endpoint, tool, args, result, body: unwrapTool(result) };
      const metrics = validateSourceRecord(raw, catalog); await savePendingRecord(catalog, raw); records.set(query, raw); newCount++;
      console.log(JSON.stringify({ tool, entity: argKey ? args[argKey] : null, status: 'captured', ...metrics, capturedThisRun: newCount }));
      await pause(opts.delayMs);
    }
    const manifest = await publishRecords(catalog, records, { endpoint: client.endpoint });
    console.log(JSON.stringify({ status: 'published', cacheKey: key, newCount, unsupportedCount, coverage: manifest.coverage, publishedAt: manifest.publishedAt }, null, 2));
    return manifest;
  } catch (error) { console.error(JSON.stringify({ status: 'failed_not_published', cacheKey: key, failure: describeError(error), reason: 'Previous published version cache remains intact. Retry --complete; this interrupted batch did not replace its manifest.' })); throw error; }
  finally { await client.close().catch(() => {}); await releaseLock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncStats().catch(() => { process.exitCode = 1; });
