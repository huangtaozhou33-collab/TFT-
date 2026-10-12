import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { getCatalog } from '../server/data.mjs';
import { TRAITS_DIR, TRAITS_URL, normalizeTacticsHTML, readTraitSnapshot, publishTraitSnapshot } from '../server/trait-data.mjs';

export async function syncTraits(argv = process.argv.slice(2), { catalog, dir = TRAITS_DIR, fetchImpl = globalThis.fetch } = {}) {
  catalog ??= await getCatalog();
  const previous = await readTraitSnapshot(catalog, dir);
  if (previous && !argv.includes('--force')) { console.log(JSON.stringify({ status: 'skipped', cacheKey: previous.payload.cacheKey, reason: 'This version already has a valid published trait snapshot. Use --force to explicitly capture it again.', coverage: previous.payload.coverage })); return previous.payload; }
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const path = value('from-html'); let html, fetchedAt;
  if (path) { fetchedAt = value('fetched-at'); if (!fetchedAt) throw new Error('--from-html requires the original --fetched-at ISO time.'); html = await readFile(path, 'utf8'); }
  else {
    if (argv.includes('--offline')) throw new Error('Offline trait sync has no valid current snapshot. Provide --from-html and its original --fetched-at; no network request was made.');
    setDefaultResultOrder('ipv4first');
    const response = await fetchImpl(TRAITS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Public Tactics.tools trait HTML HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Public trait page did not return HTML.');
    html = await response.text(); fetchedAt = new Date().toISOString();
  }
  const payload = normalizeTacticsHTML(html, catalog, { fetchedAt });
  const manifest = await publishTraitSnapshot(catalog, payload, html, dir);
  console.log(JSON.stringify({ status: 'published', cacheKey: payload.cacheKey, sourcePatch: payload.evidence.sourcePatch, population: payload.evidence.population, fetchedAt, sourceTime: payload.evidence.sourceTime, coverage: payload.coverage, publishedAt: manifest.publishedAt }, null, 2));
  return payload;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncTraits().catch(error => { console.error(JSON.stringify({ status: 'failed_not_published', reason: error.message })); process.exitCode = 1; });
