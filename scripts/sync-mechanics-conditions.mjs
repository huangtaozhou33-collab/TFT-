import { readFile } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import { pathToFileURL } from 'node:url';
import { getCatalog } from '../server/data.mjs';
import { readMechanicsSnapshot } from '../server/mechanics-data.mjs';
import { sha256 } from './stats-cache.mjs';
import { CONDITIONS_DIR, LITTLE_BUDDY_URL, RIOT_CONDITIONS_URL, inspectLittleBuddyHTML, normalizeMechanicOfferingConditions, readOfferingConditionsSnapshot, publishOfferingConditionsSnapshot } from '../server/mechanics-conditions.mjs';

export async function syncMechanicsConditions(argv = process.argv.slice(2), { catalog, entries, dir = CONDITIONS_DIR, fetchImpl = globalThis.fetch, englishTraits, traitSource } = {}) {
  catalog ??= await getCatalog();
  if (!entries) { const pack = await readMechanicsSnapshot(catalog, dir); if (!pack) throw new Error('Current mechanic catalog must be synced before offering conditions.'); entries = pack.payload.entries; }
  const previous = await readOfferingConditionsSnapshot(catalog, entries, dir);
  if (previous && !argv.includes('--force')) { console.log(JSON.stringify({ status: 'skipped', cacheKey: previous.payload.cacheKey, sourcePatch: previous.payload.source.sourcePatch, coverage: previous.payload.coverage })); return previous.payload; }
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!englishTraits) {
    const rawDir = new URL('../data/raw/', import.meta.url), manifest = JSON.parse(await readFile(new URL('cdragon-manifest.json', rawDir), 'utf8'));
    const text = await readFile(new URL('cdragon-en_us.json', rawDir), 'utf8');
    if (manifest.assetVersion !== catalog.context.assetVersion || sha256(text) !== manifest.files?.en_us?.sha256) throw new Error('Trait ID mapping static source version/hash mismatch.');
    const current = JSON.parse(text).setData?.find(set => set.number === catalog.context.set && set.mutator === catalog.context.mutator); if (!current) throw new Error('Trait mapping current set missing.');
    englishTraits = current.traits; traitSource = { name: 'CommunityDragon', url: manifest.files.en_us.url, set: catalog.context.set, assetVersion: manifest.assetVersion, fetchedAt: manifest.fetchedAt, sha256: manifest.files.en_us.sha256, mappingMethod: 'current_static_trait_id_and_exact_english_name' };
  }
  let littleBuddyHTML, csv, riotHTML, fetchedAt, pageFetchedAt, riotFetchedAt;
  if (value('from-html')) {
    const required = ['csv', 'riot-html', 'fetched-at', 'page-fetched-at', 'riot-fetched-at']; if (required.some(name => !value(name))) throw new Error('Local offering import requires --csv, --riot-html and original --fetched-at, --page-fetched-at, --riot-fetched-at.');
    littleBuddyHTML = await readFile(value('from-html'), 'utf8'); csv = await readFile(value('csv'), 'utf8'); riotHTML = await readFile(value('riot-html'), 'utf8'); fetchedAt = value('fetched-at'); pageFetchedAt = value('page-fetched-at'); riotFetchedAt = value('riot-fetched-at');
  } else {
    if (argv.includes('--offline')) throw new Error('Offline offering sync has no valid cache or complete saved import; no network request was made.');
    setDefaultResultOrder('ipv4first');
    const fetchText = async (url, contentType) => { const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) }); if (!response.ok || !response.headers.get('content-type')?.includes(contentType)) throw new Error(`Public offering source unavailable (${response.status}).`); return { text: await response.text(), fetchedAt: new Date().toISOString() }; };
    const page = await fetchText(LITTLE_BUDDY_URL, 'text/html'); littleBuddyHTML = page.text; pageFetchedAt = page.fetchedAt;
    const link = inspectLittleBuddyHTML(littleBuddyHTML); const data = await fetchText(link.csvURL, 'text/csv'); csv = data.text; fetchedAt = data.fetchedAt;
    const official = await fetchText(RIOT_CONDITIONS_URL, 'text/html'); riotHTML = official.text; riotFetchedAt = official.fetchedAt;
  }
  const raw = { littleBuddyHTML, csv, riotHTML }, payload = normalizeMechanicOfferingConditions({ ...raw, catalog, entries, fetchedAt, pageFetchedAt, riotFetchedAt, englishTraits, traitSource });
  const manifest = await publishOfferingConditionsSnapshot(catalog, entries, payload, raw, dir);
  console.log(JSON.stringify({ status: 'published', cacheKey: payload.cacheKey, sourcePatch: payload.source.sourcePatch, fetchedAt, coverage: payload.coverage, publishedAt: manifest.publishedAt }, null, 2)); return payload;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncMechanicsConditions().catch(error => { console.error(JSON.stringify({ status: 'failed_not_published', reason: error.message })); process.exitCode = 1; });
