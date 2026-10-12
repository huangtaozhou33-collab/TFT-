import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import { createHash } from 'node:crypto';
import { normalizeCatalog } from './catalog-normalize.mjs';
setDefaultResultOrder('ipv4first');
const dataDir = new URL('../data/', import.meta.url); const rawDir = new URL('raw/', dataDir);
await mkdir(rawDir, { recursive: true });
async function readOptional(name) { try { return JSON.parse(await readFile(new URL(name, rawDir), 'utf8')); } catch { return null; } }
async function readLocale(language, sourceManifest) {
  const text = await readFile(new URL(`cdragon-${language}.json`, rawDir), 'utf8');
  const expected = sourceManifest.files?.[language];
  if (!expected?.sha256 || createHash('sha256').update(text).digest('hex') !== expected.sha256 || Buffer.byteLength(text) !== expected.bytes) throw new Error(`${language} static source failed manifest integrity validation.`);
  return JSON.parse(text);
}
const offline = process.argv.includes('--offline');
const force = process.argv.includes('--force');
let manifest = await readOptional('cdragon-manifest.json');
if (!offline) {
  const response = await fetch('https://raw.communitydragon.org/', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CommunityDragon version index HTTP ${response.status}`);
  const index = await response.text();
  const versions = [...index.matchAll(/href="(\d+\.\d+)\/"/g)].map(match => match[1]).sort((a, b) => { const aa = a.split('.').map(Number), bb = b.split('.').map(Number); return bb[0] - aa[0] || bb[1] - aa[1]; });
  if (!versions.length) throw new Error('No published asset version in CommunityDragon index.');
  const assetVersion = versions[0];
  let sameVersionValid = false;
  if (manifest?.assetVersion === assetVersion) { try { await Promise.all(['en_us', 'zh_cn'].map(language => readLocale(language, manifest))); sameVersionValid = true; } catch {} }
  if (!force && sameVersionValid) {
    console.log(JSON.stringify({ source: 'communitydragon', status: 'reused_version_cache', assetVersion, fetchedAt: manifest.fetchedAt }));
  } else {
    manifest = { assetVersion, fetchedAt: new Date().toISOString(), files: {} };
    // Download a pinned version so locales cannot silently straddle a patch rollover.
    for (const language of ['en_us', 'zh_cn']) {
    const url = `https://raw.communitydragon.org/${assetVersion}/cdragon/tft/${language}.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${language} static source HTTP ${response.status}`);
    const text = await response.text(); JSON.parse(text);
    await writeFile(new URL(`cdragon-${language}.next.json`, rawDir), text);
    manifest.files[language] = { url, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), lastModified: response.headers.get('last-modified') };
    console.log(JSON.stringify({ source: 'communitydragon', language, assetVersion, bytes: manifest.files[language].bytes }));
    }
    for (const language of ['en_us', 'zh_cn']) await rename(new URL(`cdragon-${language}.next.json`, rawDir), new URL(`cdragon-${language}.json`, rawDir));
    await writeFile(new URL('cdragon-manifest.next.json', rawDir), JSON.stringify(manifest, null, 2));
    await rename(new URL('cdragon-manifest.next.json', rawDir), new URL('cdragon-manifest.json', rawDir));
  }
}
if (!manifest) throw new Error('No manifest available; run without --offline once.');
const [zh, en, recipes, augments] = await Promise.all([readLocale('zh_cn', manifest), readLocale('en_us', manifest), readOptional('opgg-tft_list_item_combinations.json'), readOptional('opgg-tft_list_augments.json')]);
if (!zh || !en) throw new Error('Missing locale source files.');
const catalog = normalizeCatalog(zh, en, manifest, recipes, augments);
if (catalog.champions.length < 40 || catalog.items.filter(item => item.kind === 'component').length < 8 || catalog.traits.length < 10) throw new Error('Catalog validation failed: entity coverage unexpectedly low.');
const unresolvedRecipes = catalog.items.filter(item => item.components.some(id => !catalog.items.some(candidate => candidate.id === id)));
if (unresolvedRecipes.length) throw new Error(`Unmapped recipe component IDs: ${unresolvedRecipes.map(item => item.id).join(', ')}`);
const target = new URL('catalog.json', dataDir), staging = new URL('catalog.next.json', dataDir);
await writeFile(staging, JSON.stringify(catalog, null, 2)); await rename(staging, target);
console.log(JSON.stringify({ status: 'ok', context: catalog.context, coverage: catalog.coverage }, null, 2));
