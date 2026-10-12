import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { getCatalog } from '../server/data.mjs';
import { EXPLORER_DIR, EXPLORER_URLS, normalizeExplorerHTML, publishExplorerSnapshot, readExplorerSnapshot } from '../server/explorer-overall.mjs';

export async function syncExplorer(argv = process.argv.slice(2), { catalog, dir = EXPLORER_DIR, fetchImpl = globalThis.fetch } = {}) {
  catalog ??= await getCatalog();
  const previous = await readExplorerSnapshot(catalog, dir);
  if (previous && !argv.includes('--force')) {
    console.log(JSON.stringify({ status: 'skipped', cacheKey: previous.payload.cacheKey, reason: 'This version already has a valid overall snapshot. Use --force to explicitly capture it again.', coverage: previous.payload.coverage }));
    return previous.payload;
  }
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const unitsPath = value('units-html'), itemsPath = value('items-html'); let input;
  if (unitsPath || itemsPath) {
    const unitsFetchedAt = value('units-fetched-at'), itemsFetchedAt = value('items-fetched-at');
    if (!unitsPath || !itemsPath || !unitsFetchedAt || !itemsFetchedAt) throw new Error('Local overall import requires both --units-html/--items-html and their original --units-fetched-at/--items-fetched-at ISO capture times.');
    const [unitsHTML, itemsHTML] = await Promise.all([readFile(unitsPath, 'utf8'), readFile(itemsPath, 'utf8')]);
    input = { unitsHTML, itemsHTML, unitsFetchedAt, itemsFetchedAt };
  } else {
    if (argv.includes('--offline')) throw new Error('Offline overall sync has no valid current snapshot. Provide both original public HTML files and capture times; no network request was made.');
    setDefaultResultOrder('ipv4first'); input = {};
    for (const [kind, url] of Object.entries(EXPLORER_URLS)) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Public Tactics.tools ${kind} HTML HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error(`Public ${kind} page did not return HTML.`);
      input[`${kind}HTML`] = await response.text(); input[`${kind}FetchedAt`] = new Date().toISOString();
    }
  }
  const payload = normalizeExplorerHTML(input, catalog), manifest = await publishExplorerSnapshot(catalog, payload, input, dir);
  console.log(JSON.stringify({ status: 'published', cacheKey: payload.cacheKey, sourcePatch: payload.evidence.sourcePatch, population: payload.evidence.population,
    sources: payload.evidence.sources.map(({ id, url, fetchedAt, sourceTime, sourceTotalEntries }) => ({ id, url, fetchedAt, sourceTime, sourceTotalEntries })), coverage: payload.coverage, publishedAt: manifest.publishedAt }, null, 2));
  return payload;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncExplorer().catch(error => { console.error(JSON.stringify({ status: 'failed_not_published', reason: error.message })); process.exitCode = 1; });
