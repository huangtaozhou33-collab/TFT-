import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { normalizeMechanics, publishMechanicsSnapshot, readMechanicsSnapshot, getSeasonMechanic } from '../server/mechanics-data.mjs';
import { syncMechanics } from '../scripts/sync-mechanics.mjs';

const catalog = { context: { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', rulesVersion: 'mechanics-fixture-v1', gamePatch: null },
  traits: [{ id: 'DA_18_Blossom', name: '灵魂莲华', description: '(3) 升级法杖\n(5) 每个商店出现法杖', effects: [{ minUnits: 3 }, { minUnits: 5 }] }] };
const fetchedAt = '2026-10-07T15:55:37.469Z', rulesFetchedAt = '2026-10-07T15:57:58.668Z';
const riotHTML = 'one Wisp per round every other shop After stage 5 during planning phase';
const ids = ['DA_ForestTwins18', 'DA_ForestTwinsUpgrade18', 'DA_ForestTwins18_Prismatic', 'DA_18_Drizzle', 'DA_18_Drizzle_Upgrade'];
const item = (apiName, name, override = {}) => ({ apiName, name, desc: '本回合获得 @Mana@ 法力。', effects: { Mana: 10 }, icon: 'assets/ux/tft/hud/zaps/wands/set18_mechanicicon.tex', isAugment: false, composition: [], ...override });
const staticSources = {
  zh: { setData: [{ number: 18, mutator: 'TFTSet18', items: ids }], items: [...ids.map(id => item(id, /Drizzle/.test(id) ? '细雨' : '森林双子')), item('DA_History17', '历史'), item('DA_Ordinary18', '普通装备', { icon: 'assets/other.tex' })] },
  en: { setData: [{ number: 18, mutator: 'TFTSet18', items: ids }], items: ids.map(id => item(id, /Drizzle/.test(id) ? 'Drizzle' : 'Forest’s Twins')) },
  staticManifest: { assetVersion: '16.20', fetchedAt: '2026-10-07T13:39:00.000Z', files: { zh_cn: { url: 'https://raw.communitydragon.org/16.20/cdragon/tft/zh_cn.json', sha256: 'fixture-hash' } } }
};
const publicGroup = [
  { id: ids[0], name: 'Forest’s Twins', typ: 'base', category: 'Champion', tier: 1, rounds: ['Early', 'Mid'], cost: 2, desc: 'old public description' },
  { id: ids[1], name: 'Forest’s Twins', typ: 'upgraded', category: 'Champion', tier: 2, rounds: [], cost: 2, desc: 'public upgraded description' },
  { id: ids[2], name: 'Forest’s Twins', typ: 'prismatic', category: null, tier: 3, rounds: [], cost: 2, desc: 'public prismatic description' }
];
function publicHTML({ set = 18, groups = [publicGroup, [{ ...publicGroup[0], id: 'DA_History17', name: 'Historical' }]] } = {}) {
  return `<title>Set ${set} Enchanted Wilds Information</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page: '/info/set-update', props: { pageProps: { anomalies: groups } } })}</script>`;
}
const normalize = (html = publicHTML(), extra = {}) => normalizeMechanics({ html, riotHTML, ...staticSources, catalog, fetchedAt, rulesFetchedAt, ...extra });
async function isolated(run) {
  const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-mechanics-test-'); const directory = await mkdtemp(prefix);
  try { await run(pathToFileURL(directory + sep)); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
}
const raw = html => ({ html, tcHTML: null, riotHTML });

test('current IDs and source variant groups are exact; unmapped availability stays unknown', () => {
  const result = normalize(), base = result.entries.find(entry => entry.id === ids[0]), upgraded = result.entries.find(entry => entry.id === ids[1]), unknown = result.entries.find(entry => entry.id === ids[3]);
  assert.equal(result.entries.length, 5); assert.equal(result.coverage.metadataMapped, 3); assert.equal(result.coverage.availabilityUnverified, 2); assert.deepEqual(result.coverage.excludedPublicRows, ['DA_History17']);
  assert.equal(base.description, '本回合获得 10 法力。'); assert.equal(base.descriptionIncomplete, false); assert.equal(base.cost, 2); assert.deepEqual(base.stages, ['Early', 'Mid']);
  assert.equal(base.upgrade.upgradedId, ids[1]); assert.equal(base.upgrade.prismaticId, ids[2]); assert.equal(upgraded.stages, null);
  assert.equal(unknown.active, null); assert.equal(unknown.cost, null); assert.equal(unknown.category, null); assert.equal(unknown.stages, null); assert.equal(unknown.availability.status, 'unverified');
  assert.equal(unknown.upgrade.upgradedId, ids[4]); assert.equal(base.availability.purchaseConditionsVerified, false); assert.equal(result.coverage.complete, false);
  assert.equal(base.source.descriptionSource.fetchedAt, staticSources.staticManifest.fetchedAt); assert.equal(base.source.metadataSource.fetchedAt, fetchedAt); assert.equal(result.source.sourcePatch, null);
  assert.equal(result.mechanic.upgradeRules[0].minUnits, 3); assert.match(result.mechanic.rules[0], /商店/); assert.match(result.mechanic.rules[5], /每隔一枚/);
  assert.equal(base.stats, undefined); assert.equal(result.rating.status, 'unrated');
});

test('changed public schema, wrong set, duplicate IDs and unverified rules are rejected', () => {
  assert.throws(() => normalize(publicHTML({ set: 17 })), /set identity/);
  assert.throws(() => normalize(publicHTML().replace('__NEXT_DATA__', 'missing')), /no __NEXT_DATA__/);
  assert.throws(() => normalize(publicHTML({ groups: [publicGroup, publicGroup] })), /duplicate/);
  assert.throws(() => normalize(publicHTML({ groups: [[{ ...publicGroup[0], rounds: ['2-1'] }]] })), /stage label/);
  assert.throws(() => normalize(publicHTML({ groups: [[{ ...publicGroup[0], tier: 9 }]] })), /tier/);
  assert.throws(() => normalize(publicHTML(), { riotHTML: 'one Wisp per round' }), /rules could not/);
});

test('runtime reads never network, reject other versions and tampered files', async () => isolated(async dir => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('No runtime network'); };
  try {
    assert.equal((await getSeasonMechanic({ catalog, dir })).code, 'not_cached');
    const html = publicHTML(), payload = normalize(html); await publishMechanicsSnapshot(catalog, payload, raw(html), dir);
    const cached = await getSeasonMechanic({ catalog, dir }); assert.equal(cached.status, 'cached'); assert.equal(cached.delivery, 'version_cache'); assert.equal(cached.source.fetchedAt, fetchedAt);
    for (const context of [{ ...catalog.context, set: 19 }, { ...catalog.context, assetVersion: '16.21' }, { ...catalog.context, rulesVersion: 'fixture-v2' }]) assert.equal((await getSeasonMechanic({ catalog: { ...catalog, context }, dir })).code, 'not_cached');
    const { manifest } = await readMechanicsSnapshot(catalog, dir), path = new URL(`${manifest.cacheKey}/${manifest.file}`, dir);
    const changed = JSON.parse(await readFile(path, 'utf8')); changed.entries[0].cost = 999; await writeFile(path, JSON.stringify(changed));
    assert.equal((await getSeasonMechanic({ catalog, dir })).code, 'not_cached'); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('expert ratings match exact normalized names only on base variants and remain independent', async () => isolated(async dir => {
  const html = publicHTML(), payload = normalize(html); await publishMechanicsSnapshot(catalog, payload, raw(html), dir);
  await mkdir(new URL('ratings/', dir));
  const ratings = { schemaVersion: 1, set: 18, contextKey: payload.cacheKey, cacheKey: payload.cacheKey,
    source: { type: 'expert', name: 'MetaTFT · Spencer', author: 'Spencer', url: 'https://www.metatft.com/wisp-tiers', set: 18, sourcePatch: null, fetchedAt, sourceTime: null },
    tiers: { S: ["FOREST'S TWINS"], A: [], B: [], C: [], D: ['Source Only'] } };
  const ratingPath = new URL('ratings/set18-spencer.json', dir); await writeFile(ratingPath, JSON.stringify(ratings));
  const expert = await getSeasonMechanic({ catalog, dir }); assert.equal(expert.rating.status, 'expert'); assert.equal(expert.rating.coverage.matchedBaseEntries, 1);
  assert.equal(expert.entries.find(entry => entry.id === ids[0]).rating.tier, 'S'); assert.equal(expert.entries.find(entry => entry.id === ids[1]).rating.status, 'unrated'); assert.equal(expert.entries.find(entry => entry.id === ids[2]).rating.status, 'unrated');
  assert.equal(expert.rating.source.sourcePatch, null); assert.equal(expert.rating.source.sourceTime, null); assert.equal(expert.rating.coverage.upgradedOrPrismaticInherited, 0);
  for (const invalid of [{ ...ratings, contextKey: 'other-version' }, { ...ratings, cacheKey: 'other-version' }, { ...ratings, set: 17 }, { ...ratings, tiers: { ...ratings.tiers, A: ["Forest's Twins"] } }]) {
    await writeFile(ratingPath, JSON.stringify(invalid)); assert.equal((await getSeasonMechanic({ catalog, dir })).rating.status, 'unrated');
  }
}));

test('cached sync skips, offline never fetches, failed forced refresh preserves previous package', async () => isolated(async dir => {
  let requests = 0; const blocked = async () => { requests++; throw new Error('Offline must not fetch'); };
  await assert.rejects(syncMechanics(['--offline'], { catalog, dir, staticSources, fetchImpl: blocked }), /no network request/);
  assert.equal(await readMechanicsSnapshot(catalog, dir), null); assert.equal(requests, 0);
  const html = publicHTML(), payload = normalize(html); await publishMechanicsSnapshot(catalog, payload, raw(html), dir);
  assert.equal((await syncMechanics([], { catalog, dir, staticSources, fetchImpl: blocked })).source.fetchedAt, fetchedAt); assert.equal(requests, 0);
  assert.equal((await syncMechanics(['--offline'], { catalog, dir, staticSources, fetchImpl: blocked })).status, 'cached'); assert.equal(requests, 0);
  const fetchInvalid = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => publicHTML({ set: 17 }) });
  await assert.rejects(syncMechanics(['--force'], { catalog, dir, staticSources, fetchImpl: fetchInvalid }), /set identity/);
  assert.equal((await getSeasonMechanic({ catalog, dir })).source.fetchedAt, fetchedAt);
  await assert.rejects(publishMechanicsSnapshot(catalog, payload, { ...raw(html), html: 'changed' }, dir), /source validation/);
  assert.equal((await getSeasonMechanic({ catalog, dir })).source.fetchedAt, fetchedAt);
}));

test('saved HTML imports publish offline with original per-source capture times', async () => isolated(async dir => {
  const primary = new URL('primary.html', dir), traditional = new URL('traditional.html', dir), official = new URL('official.html', dir);
  await writeFile(primary, publicHTML()); await writeFile(traditional, publicHTML()); await writeFile(official, riotHTML);
  const tcFetchedAt = '2026-10-07T15:55:38.776Z'; let requests = 0;
  const result = await syncMechanics(['--offline', `--from-html=${fileURLToPath(primary)}`, `--fetched-at=${fetchedAt}`, `--tc-html=${fileURLToPath(traditional)}`, `--tc-fetched-at=${tcFetchedAt}`, `--rules-html=${fileURLToPath(official)}`, `--rules-fetched-at=${rulesFetchedAt}`],
    { catalog, dir, staticSources, fetchImpl: async () => { requests++; throw new Error('Offline must not fetch'); } });
  assert.equal(result.source.fetchedAt, fetchedAt); assert.equal(result.source.tcFetchedAt, tcFetchedAt); assert.equal(result.rulesSource.fetchedAt, rulesFetchedAt); assert.equal(requests, 0);
  const cached = await getSeasonMechanic({ catalog, dir }); assert.equal(cached.status, 'cached'); assert.equal(cached.entries.find(entry => entry.id === ids[0]).source.descriptionSource.fetchedAt, staticSources.staticManifest.fetchedAt);
  assert.equal(cached.entries.find(entry => entry.id === ids[0]).source.metadataSource.fetchedAt, fetchedAt);
}));
