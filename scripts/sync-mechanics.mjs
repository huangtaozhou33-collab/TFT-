import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';
import { getCatalog } from '../server/data.mjs';
import { sha256 } from './stats-cache.mjs';
import { MECHANICS_DIR, MECHANICS_URL, MECHANICS_TC_URL, RULES_URL, normalizeMechanics, readMechanicsSnapshot, publishMechanicsSnapshot } from '../server/mechanics-data.mjs';

export async function syncMechanics(argv = process.argv.slice(2), { catalog, dir = MECHANICS_DIR, fetchImpl = globalThis.fetch, staticSources } = {}) {
  catalog ??= await getCatalog(); const previous = await readMechanicsSnapshot(catalog, dir);
  if (previous && !argv.includes('--force')) { console.log(JSON.stringify({ status: 'skipped', cacheKey: previous.payload.cacheKey, coverage: previous.payload.coverage })); return previous.payload; }
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!staticSources) {
    const rawDir = new URL('../data/raw/', import.meta.url), staticManifest = JSON.parse(await readFile(new URL('cdragon-manifest.json', rawDir), 'utf8'));
    const locale = async name => { const text = await readFile(new URL(`cdragon-${name}.json`, rawDir), 'utf8'); if (sha256(text) !== staticManifest.files?.[name]?.sha256) throw new Error('Static mechanic locale integrity failed.'); return JSON.parse(text); };
    staticSources = { zh: await locale('zh_cn'), en: await locale('en_us'), staticManifest };
  }
  let html, tcHTML, riotHTML, fetchedAt, tcFetchedAt, rulesFetchedAt;
  if (value('from-html')) {
    if (!value('fetched-at') || !value('rules-html') || !value('rules-fetched-at')) throw new Error('Saved mechanic HTML import requires original --fetched-at, --rules-html and --rules-fetched-at.');
    html = await readFile(value('from-html'), 'utf8'); fetchedAt = value('fetched-at'); riotHTML = await readFile(value('rules-html'), 'utf8'); rulesFetchedAt = value('rules-fetched-at');
    if (value('tc-html')) { tcHTML = await readFile(value('tc-html'), 'utf8'); tcFetchedAt = value('tc-fetched-at') ?? fetchedAt; }
  } else {
    if (argv.includes('--offline')) throw new Error('Offline mechanic sync has no valid cache or saved HTML import; no network request was made.');
    setDefaultResultOrder('ipv4first');
    const page = async url => { const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) }); if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error(`Public mechanic HTML unavailable (${response.status}).`); return { html: await response.text(), fetchedAt: new Date().toISOString() }; };
    const primary = await page(MECHANICS_URL); html = primary.html; fetchedAt = primary.fetchedAt;
    const localized = await page(MECHANICS_TC_URL); tcHTML = localized.html; tcFetchedAt = localized.fetchedAt;
    const official = await page(RULES_URL); riotHTML = official.html; rulesFetchedAt = official.fetchedAt;
  }
  const raw = { html, tcHTML, riotHTML }, payload = normalizeMechanics({ ...raw, ...staticSources, catalog, fetchedAt, tcFetchedAt, rulesFetchedAt });
  const manifest = await publishMechanicsSnapshot(catalog, payload, raw, dir);
  console.log(JSON.stringify({ status: 'published', cacheKey: payload.cacheKey, sourcePatch: payload.source.sourcePatch, fetchedAt, coverage: payload.coverage, publishedAt: manifest.publishedAt }, null, 2)); return payload;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncMechanics().catch(error => { console.error(JSON.stringify({ status: 'failed_not_published', reason: error.message })); process.exitCode = 1; });
