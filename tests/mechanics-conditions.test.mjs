import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { inspectLittleBuddyHTML, parsePublishedCSV, normalizeMechanicOfferingConditions, publishOfferingConditionsSnapshot, readOfferingConditionsSnapshot, getMechanicOfferingConditions } from '../server/mechanics-conditions.mjs';
import { syncMechanicsConditions } from '../scripts/sync-mechanics-conditions.mjs';

const catalog = { context: { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', gamePatch: null, rulesVersion: 'offering-fixture-v1' },
  traits: [{ id: 'DA_Riftbeast18', name: '峡谷野怪' }], augments: [{ id: 'DA_SalvageBin', name: '装备回收箱' }], items: [] };
const englishTraits = [{ apiName: 'DA_Riftbeast18', name: 'Riftbeast' }];
const bands = ['Early', 'Early Mid', 'Mid', 'Mid Late', 'Late', 'Very Late'];
const bounds = [['2-1', '2-7'], ['3-1', '3-4'], ['3-5', '4-1'], ['4-2', '4-7'], ['5-1', '5-7'], ['6-1', '10-1']];
const columns = ['Name', 'mName', 'Cost', 'Standard', 'Doubles', 'Special Conditions', 'Re-offer Cooldown', ...bands, 'MutuallyExclusiveItem1', 'MutuallyExclusiveItem1Name'];
const sourceURL = 'https://docs.google.com/spreadsheets/d/e/2PACX-Fixture/pub?gid=0&single=true&output=csv';
function pageHTML({ patch = '18.4', brokenCooldown = false } = {}) {
  const widget = `var SHEET_CSV_URL = "${sourceURL}"; var COL_CONDITIONS = "Special Conditions"; ${bands.map((band, index) => `key: "${band}", label: "${bounds[index][0]} to ${bounds[index][1]}"`).join(';')} ${brokenCooldown ? '' : 'After this Wisp is offered, it cannot be seen again for this many Wisp shops.'}`;
  const encoded = JSON.stringify({ widget: [0, widget] }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<title>TFT Set 18</title><h1>TFT Wisp offer rules (${patch})</h1><astro-island props="${encoded}"></astro-island>`;
}
const riotHTML = '<title>TFT patch 18.4</title>2026-10-06T18:00:00.000Z we can only show you Wisps that you can afford under 10 gold Stage 4-1 to 5-7 first 2 seconds of Planning Phase below 20 HP';
const capture = { fetchedAt: '2026-10-07T16:25:45.277Z', pageFetchedAt: '2026-10-07T16:24:57.905Z', riotFetchedAt: '2026-10-07T16:24:59.218Z' };
function row(id, name, condition = '', override = {}) { return { Name: name, mName: id, Cost: '2', Standard: 'Yes', Doubles: 'Yes', 'Special Conditions': condition, 'Re-offer Cooldown': '5', 'Mid Late': 'Mid Late', Late: 'Late', ...override }; }
const rows = [
  row('DA_18_Supercritical', 'Supercritical', 'Requires: At least 2 champions anywhere in your army that can critically strike with abilities.'),
  row('DA_18_SupercriticalUpgrade', 'Supercritical', 'Requires: At least 2 champions anywhere in your army that can critically strike with abilities.'),
  row('DA_HeroOfProphecy18', 'Hero Of Prophecy', 'Requires: At least 35 gold; more than 50 player health remaining; level 10 or higher.', { Cost: '35', 'Re-offer Cooldown': '200', 'Mid Late': '', Late: '', 'Very Late': 'Very Late' }),
  row('DA_18_Drizzle', 'Drizzle', 'Requires: Less than 10 gold.', { Cost: '0' }),
  row('DA_18_Drizzle_Upgrade', 'Drizzle', 'Requires: Less than 10 gold.', { Cost: '0' }),
  row('DA_GoldenGoose18', 'Golden Goose', 'Requires: More than 20 player health remaining.'),
  row('DA_Salvager18', 'Salvager', '', { Cost: '0', MutuallyExclusiveItem1: 'DA_SalvageBin', MutuallyExclusiveItem1Name: 'Salvage Bin' }),
  row('DA_Scrappy18', 'Scrappy', 'Requires: At least 2 champions on your board with no items.'),
  row('DA_Scrappy18_Upgrade', 'Scrappy', 'Requires: At least 3 champions on your board with no items.'),
  row('DA_PhantomSplash18', 'Phantom Splash', 'Requires: At least 2 inactive traits (contributed but not active).'),
  row('DA_PhantomSplashUpgrade18', 'Phantom Splash', 'Requires: At least 4 inactive traits (contributed but not active).'),
  row('DA_RideTheWave18', 'Ride the Wave', 'Requires: Offered only in the first 20 seconds of the planning phase; at least 20 gold.'),
  row('DA_RideTheWaveUpgrade18', 'Ride the Wave', 'Requires: Offered only in the first 2 seconds of the planning phase; at least 20 gold.'),
  row('DA_HandOfBaron18', 'Hand Of Baron', 'Requires: Riftbeast active.', { Cost: '6' }),
  row('DA_SolarGift18', 'Solar Gift'),
  row('DA_RoomForAShroom', 'Room for a Shroom', 'Requires: Less than 10 gold.', { Cost: '0' }),
  row('DA_AbandonShip18', 'Abandon Ship', "Requires: No 3-star champion; a running subtotal of your army's unit sell values reaches between 15 and 24 gold; not on a win streak of 3 or more."),
  row('DA_BoosterShot18', 'Booster Shot', 'Requires: At least 2 1-star champions on your board, OR a 1-star 5-cost champion on your board holding 3 items.')
];
const entries = rows.filter(row => row.mName !== 'DA_RoomForAShroom').map(row => ({ id: row.mName, cost: 999, description: 'effect description', source: { descriptionSource: { name: 'CommunityDragon', sourcePatch: null } } })).concat({ id: 'DA_SolarGift18_Upgrade', cost: 999 });
const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csvFor = records => `${columns.map(quote).join(',')}\r\n${records.map(record => columns.map(column => quote(record[column])).join(',')).join('\r\n')}\r\n`;
const raw = { littleBuddyHTML: pageHTML(), csv: csvFor(rows), riotHTML };
const normalize = (changes = {}) => normalizeMechanicOfferingConditions({ catalog, entries, ...raw, ...capture, englishTraits, ...changes });
const item = (payload, id) => payload.entries.find(entry => entry.id === id).offeringConditions;
async function isolated(run) { const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-offering-test-'); const directory = await mkdtemp(prefix); try { await run(pathToFileURL(directory + sep)); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); } }

test('offer eligibility, current purchase cost and effect triggers remain separate', () => {
  const result = normalize(), supercritical = item(result, 'DA_18_Supercritical'), prophecy = item(result, 'DA_HeroOfProphecy18');
  assert.equal(supercritical.allOf.find(rule => rule.field === 'abilityCritChampionCount').value, 2); assert.equal(supercritical.allOf.find(rule => rule.field === 'abilityCritChampionCount').scope, 'army_any_location');
  assert.equal(supercritical.purchaseConditions.cost.value, 2); assert.notEqual(supercritical.purchaseConditions.cost.value, 999); assert.equal(supercritical.triggerConditions.status, 'not_extracted');
  assert.equal(prophecy.allOf.find(rule => rule.field === 'playerLevel').value, 10); assert.equal(prophecy.allOf.find(rule => rule.field === 'playerHealth').op, 'gt'); assert.equal(prophecy.cooldown.value, 200);
  assert.equal(prophecy.cooldown.unit, 'wisp_shops'); assert.equal(prophecy.cooldown.trigger, 'offered'); assert.equal(prophecy.cooldown.sharedAcrossVariants, null);
  assert.equal(supercritical.weight.value, null); assert.equal(supercritical.probability.value, null); assert.equal(supercritical.offerConditions.eligibilityGuaranteed, false); assert.equal(result.coverage.complete, false);
  assert.equal(result.source.sourcePatch, '18.4'); assert.equal(result.context.gamePatch, null); assert.equal(result.sources[1].sourceTime, '2026-10-06T18:00:00.000Z');
});

test('actual upgraded constraints do not inherit; missing variants remain unknown', () => {
  const result = normalize();
  for (const [base, upgraded, field, a, b] of [['DA_Scrappy18', 'DA_Scrappy18_Upgrade', 'championCount', 2, 3], ['DA_PhantomSplash18', 'DA_PhantomSplashUpgrade18', 'inactiveContributedTraitCount', 2, 4], ['DA_RideTheWave18', 'DA_RideTheWaveUpgrade18', 'planningElapsedSeconds', 20, 2]]) {
    assert.equal(item(result, base).allOf.find(rule => rule.field === field).value, a); assert.equal(item(result, upgraded).allOf.find(rule => rule.field === field).value, b);
  }
  assert.equal(item(result, 'DA_SolarGift18_Upgrade').status, 'not_documented'); assert.equal(item(result, 'DA_SolarGift18_Upgrade').purchaseConditions.cost, null);
  assert.equal(result.excludedSourceRows[0].id, 'DA_RoomForAShroom'); assert.equal(result.excludedSourceRows[0].membershipVerified, false);
  const baron = item(result, 'DA_HandOfBaron18'); assert.equal(baron.allOf.find(rule => rule.field === 'traitActive').trait.id, 'DA_Riftbeast18');
  assert.equal(item(result, 'DA_Salvager18').excludedBy[0].id, 'DA_SalvageBin'); assert.equal(item(result, 'DA_Salvager18').excludedBy[0].catalogMapped, true);
});

test('official stage override and HP20 conflict are preserved instead of inventing certainty', () => {
  const result = normalize(), drizzle = item(result, 'DA_18_Drizzle'), goose = item(result, 'DA_GoldenGoose18');
  assert.deepEqual(drizzle.roundWindow.map(window => [window.from, window.to]), [['4-1', '5-7']]); assert.equal(drizzle.sourceRoundWindow[0].from, '4-2'); assert.equal(drizzle.conflicts[0].type, 'official_patch_override');
  assert.equal(goose.status, 'partial'); assert.equal(goose.conflicts.find(conflict => conflict.type === 'boundary_conflict').unresolvedValue, 20); assert.ok(goose.unknownFields.includes('health20Eligibility'));
  const subtotal = item(result, 'DA_AbandonShip18').allOf.find(rule => rule.field === 'runningArmySellSubtotalHitsRange'); assert.deepEqual(subtotal.range, { min: 15, max: 24 }); assert.equal(subtotal.traversalOrder, null);
  assert.equal(item(result, 'DA_BoosterShot18').anyOf[0].alternatives.length, 2);
});

test('public widget and CSV validation reject wrong patch, changed semantics and corrupt rows', () => {
  assert.equal(inspectLittleBuddyHTML(pageHTML()).csvURL, sourceURL);
  assert.throws(() => inspectLittleBuddyHTML(pageHTML({ patch: '18.3' })), /set\/patch/);
  assert.throws(() => inspectLittleBuddyHTML(pageHTML({ brokenCooldown: true })), /cooldown units/);
  assert.throws(() => normalize({ riotHTML: '<title>TFT patch 18.3</title>' }), /Riot 18.4/);
  assert.throws(() => parsePublishedCSV(csvFor([rows[0], rows[0]])), /duplicate/);
  assert.throws(() => parsePublishedCSV(csvFor([{ ...rows[0], Cost: 'unknown' }])), /numeric Cost/);
  assert.throws(() => parsePublishedCSV('Name,mName\nX,"unfinished'), /Unterminated/);
  const multiline = { ...rows[0], Name: 'Quoted "name", example', 'Special Conditions': 'line one\nline two' }; assert.equal(parsePublishedCSV(csvFor([multiline]))[0]['Special Conditions'], 'line one\nline two');
  const emptyMode = normalize({ csv: csvFor(rows.map((row, index) => index === 0 ? { ...row, Doubles: '' } : row)) }); assert.equal(item(emptyMode, rows[0].mName).modes.doubles, null);
});

test('pure local reads isolate version/entity sets, reject tamper and never fetch', async () => isolated(async dir => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('No runtime fetch'); };
  try {
    assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).code, 'not_cached'); const payload = normalize(); await publishOfferingConditionsSnapshot(catalog, entries, payload, raw, dir);
    assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).status, 'cached');
    for (const context of [{ ...catalog.context, set: 19 }, { ...catalog.context, assetVersion: '16.21' }, { ...catalog.context, rulesVersion: 'fixture-v2' }]) assert.equal((await getMechanicOfferingConditions({ catalog: { ...catalog, context }, entries, dir })).code, 'not_cached');
    assert.equal((await getMechanicOfferingConditions({ catalog, entries: entries.slice(1), dir })).code, 'not_cached');
    const { manifest } = await readOfferingConditionsSnapshot(catalog, entries, dir), path = new URL(`conditions/${manifest.cacheKey}/${manifest.file}`, dir), changed = JSON.parse(await readFile(path, 'utf8')); changed.entries[0].offeringConditions.purchaseConditions.cost.value = 999; await writeFile(path, JSON.stringify(changed));
    assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).code, 'not_cached'); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('same-version/offline skip and failed refresh preserve the last valid package', async () => isolated(async dir => {
  let requests = 0; const blocked = async () => { requests++; throw new Error('Should not fetch'); }, dependencies = { catalog, entries, dir, englishTraits, fetchImpl: blocked };
  await assert.rejects(syncMechanicsConditions(['--offline'], dependencies), /no network request/); assert.equal(requests, 0); assert.equal(await readOfferingConditionsSnapshot(catalog, entries, dir), null);
  const payload = normalize(); await publishOfferingConditionsSnapshot(catalog, entries, payload, raw, dir);
  assert.equal((await syncMechanicsConditions([], dependencies)).source.fetchedAt, capture.fetchedAt); assert.equal((await syncMechanicsConditions(['--offline'], dependencies)).status, 'cached'); assert.equal(requests, 0);
  await assert.rejects(syncMechanicsConditions(['--force'], { ...dependencies, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => pageHTML({ patch: '18.3' }) }) }), /set\/patch/);
  assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).source.fetchedAt, capture.fetchedAt);
  await assert.rejects(publishOfferingConditionsSnapshot(catalog, entries, payload, { ...raw, csv: 'different' }, dir), /integrity/);
  const differentIDs = structuredClone(payload); differentIDs.entries[0].id = 'DA_Unmatched18'; await assert.rejects(publishOfferingConditionsSnapshot(catalog, entries, differentIDs, raw, dir), /integrity/);
  assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).status, 'cached');
}));

test('saved HTML and CSV publish offline retaining separate original source times', async () => isolated(async dir => {
  const primary = new URL('lbb.html', dir), data = new URL('lbb.csv', dir), official = new URL('riot.html', dir); await writeFile(primary, raw.littleBuddyHTML); await writeFile(data, raw.csv); await writeFile(official, riotHTML);
  let requests = 0; const result = await syncMechanicsConditions(['--offline', `--from-html=${fileURLToPath(primary)}`, `--csv=${fileURLToPath(data)}`, `--riot-html=${fileURLToPath(official)}`, `--fetched-at=${capture.fetchedAt}`, `--page-fetched-at=${capture.pageFetchedAt}`, `--riot-fetched-at=${capture.riotFetchedAt}`],
    { catalog, entries, dir, englishTraits, fetchImpl: async () => { requests++; throw new Error('Offline must not fetch'); } });
  assert.equal(result.source.fetchedAt, capture.fetchedAt); assert.equal(result.source.pageFetchedAt, capture.pageFetchedAt); assert.equal(result.sources[1].fetchedAt, capture.riotFetchedAt); assert.equal(requests, 0); assert.equal((await getMechanicOfferingConditions({ catalog, entries, dir })).status, 'cached');
}));
