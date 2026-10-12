import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cacheContext, cacheKeyFor } from '../scripts/stats-cache.mjs';
import { decodePCCode, encodePCCode, TeamCodeError } from '../public/team-code.js';
import { normalizeTeamPlannerMapping, publishTeamCodeMapping, readTeamCodeMapping, decodeTeamCode, encodeTeamCode, matchSourceLayout } from '../server/team-code.mjs';
import { syncTeamCodes } from '../scripts/sync-team-codes.mjs';

const catalog = { context: { game: 'tft', set: 18, mutator: 'TFTSet18', assetVersion: '16.20', rulesVersion: 'fixture-v1', gamePatch: null },
  champions: [{ id: 'DA_18_Ivern', name: '艾翁', cost: 5, icon: null }, { id: 'DA_18_Maokai', name: '茂凯', cost: 5, icon: null }, { id: 'DA_18_Lux_Coven', name: '拉克丝(魔女)', cost: 5 }],
  items: [{ id: 'DA_WarmogsArmor', name: '狂徒铠甲' }] };
const raw = { TFTSet18: [{ character_id: 'DA_18_Maokai', team_planner_code: 1045, display_name: 'Maokai', tier: 5 }, { character_id: 'DA_0SourceOnly', team_planner_code: 990, display_name: 'Source only', tier: 1 }, { character_id: 'DA_18_Ivern', team_planner_code: 1028, display_name: 'Ivern', tier: 5 }] };
const capturedAt = '2026-10-08T06:45:28.855Z', mapping = normalizeTeamPlannerMapping(raw, catalog, { fetchedAt: capturedAt }), context = cacheContext(catalog);
const nativeCode = '02404415000000000000000000000000TFTSet18'; // Ivern, Maokai, 8 empty slots.
const hasCode = (code, fn) => error => error instanceof TeamCodeError && error.code === code && (!fn || fn(error));
async function isolated(run) {
  const root = resolve('tmp'); await mkdir(root, { recursive: true }); const prefix = join(root, 'tft-code-test-'), directory = await mkdtemp(prefix);
  try { await run(pathToFileURL(directory + sep)); } finally { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
}
function layoutSource(code = nativeCode) {
  return { status: 'live', evidence: { source: 'OP.GG MCP', cacheKey: cacheKeyFor(catalog), set: 18, assetVersion: '16.20', rulesVersion: 'fixture-v1', sourcePatch: null, recordHash: 'a'.repeat(64) }, data: { data: [{ id: 'fixture-deck', name: { zh_CN: '真实来源布局' }, teamCode: code,
    units: [{ key: 'DA_18_Ivern', items: [], tier: 2, cell: { x: 1, y: 1 } }, { key: 'DA_18_Maokai', items: ['DA_WarmogsArmor'], tier: 3, cell: { x: 6, y: 4 } }] }] } };
}

test('native v2 code resolves exact IDs and slot order without inventing equipment, positions, stars or population', () => {
  const result = decodePCCode(` \n${nativeCode.toUpperCase()}\n `, mapping, context);
  assert.equal(result.code, nativeCode); assert.equal(result.version, 2); assert.equal(result.mutator, 'TFTSet18');
  assert.deepEqual(result.units.map(unit => unit.championId), ['DA_18_Ivern', 'DA_18_Maokai']); assert.deepEqual(result.units.map(unit => unit.codeSlot), [1, 2]);
  assert.deepEqual(result.includes, { champions: true, items: false, positions: false, stars: false }); assert.equal(result.capacity, 10);
  for (const unit of result.units) { assert.deepEqual(unit.items, []); assert.equal(unit.cell, null); assert.equal(unit.star, 1); assert.equal(unit.starOrigin, 'editor_default_not_encoded'); }
  assert.ok(result.warnings.some(warning => warning.code === 'population_not_encoded')); assert.equal(result.populationCost, undefined);
});

test('v1 sorts the complete source pool before filtering and preserves blanks and duplicate instance identities', () => {
  assert.equal(mapping.v1[1], undefined); assert.equal(mapping.v1[2], 'DA_18_Ivern'); assert.equal(mapping.v1[3], 'DA_18_Maokai');
  const code = `0100020003000000000000TFTSet18`, decoded = decodePCCode(code, mapping, context);
  assert.deepEqual(decoded.units.map(unit => unit.codeSlot), [2, 4]); assert.deepEqual(decoded.units.map(unit => unit.championId), ['DA_18_Ivern', 'DA_18_Maokai']);
  const duplicate = decodePCCode(`02415415000000000000000000000000TFTSet18`, mapping, context); assert.equal(duplicate.units.length, 2); assert.notEqual(duplicate.units[0].instanceId, duplicate.units[1].instanceId);
  assert.equal(decodePCCode(`02${'000'.repeat(10)}TFTSet18`, mapping, context).empty, true);
});

test('PC encoder round-trips only champions and refuses unsupported Lux forms or unknown mappings', () => {
  const encoded = encodePCCode([{ championId: 'DA_18_Ivern', star: 3, items: ['DA_WarmogsArmor'], cell: { x: 2, y: 4 } }, { championId: 'DA_18_Maokai' }], mapping, context);
  assert.equal(encoded.code, nativeCode); assert.equal(encoded.includes.items, false); assert.equal(encoded.includes.positions, false); assert.equal(encoded.includes.stars, false);
  const v1 = encodePCCode(['DA_18_Ivern', 'DA_18_Maokai'], mapping, context, { version: 1 });
  assert.deepEqual(decodePCCode(v1.code, mapping, context).units.map(unit => unit.championId), ['DA_18_Ivern', 'DA_18_Maokai']);
  assert.throws(() => encodePCCode(['DA_18_Lux_Coven'], mapping, context), hasCode('unsupported_champion'));
  assert.throws(() => encodePCCode(Array(11).fill('DA_18_Ivern'), mapping, context), hasCode('invalid_slot_count'));
  assert.throws(() => encodePCCode([], mapping, context, { version: 3 }), hasCode('unsupported_format'));
});

test('malformed formats, future prefixes, wrong sets, incomplete slots and unknown IDs fail without silent loss', () => {
  for (const code of ['', 'foo', 'https://example.test/code', nativeCode.replace('404', 'G04'), nativeCode.replace('TFTSet18', 'TFTSet18/../')]) assert.throws(() => decodePCCode(code, mapping, context), hasCode('invalid_code'));
  assert.throws(() => decodePCCode(nativeCode.replace(/^02/, '03'), mapping, context), hasCode('unsupported_format'));
  assert.throws(() => decodePCCode(nativeCode.replace('TFTSet18', 'TFTSet17'), mapping, context), hasCode('set_mismatch'));
  assert.throws(() => decodePCCode('02404415TFTSet18', mapping, context), hasCode('invalid_slot_count'));
  assert.throws(() => decodePCCode(`02fff${'000'.repeat(9)}TFTSet18`, mapping, context), hasCode('unknown_champion_code'));
  assert.throws(() => decodePCCode(nativeCode, mapping, { ...context, rulesVersion: 'other' }), hasCode('set_mismatch'));
  const corrupt = structuredClone(mapping); corrupt.v2[1045] = 'DA_18_Ivern'; assert.throws(() => decodePCCode(nativeCode, corrupt, context), hasCode('mapping_invalid'));
  assert.throws(() => normalizeTeamPlannerMapping({ TFTSet18: [raw.TFTSet18[0], raw.TFTSet18[0]] }, catalog, { fetchedAt: capturedAt }), /duplicate/);
});

test('known real OP.GG v2 vector matches eight independent champion IDs', () => {
  const known = [['DA_Amumu18', 1005], ['DA_Sentinel18', 1064], ['DA_18_ElderDragon', 1020], ['DA_18_Ivern', 1028], ['DA_18_Kennen', 1035], ['DA_18_Maokai', 1045], ['DA_Draven18', 1019], ['DA_Taric18', 1072]];
  const fixture = { ...catalog, champions: known.map(([id]) => ({ id, name: id, cost: 5 })) }, source = { TFTSet18: known.map(([character_id, team_planner_code]) => ({ character_id, team_planner_code })) };
  const prepared = normalizeTeamPlannerMapping(source, fixture, { fetchedAt: capturedAt }), code = '023ed4283fc40440b4153fb430000000TFTSet18';
  assert.deepEqual(decodePCCode(code, prepared, cacheContext(fixture)).units.map(unit => unit.championId), known.map(([id]) => id));
  assert.equal(encodePCCode(known.map(([id]) => id), prepared, cacheContext(fixture)).code, code);
});

test('exact source code and matching multiset produce an independent layout; other/ambiguous/unverified sources do not', () => {
  const decoded = decodePCCode(nativeCode, mapping, context), source = layoutSource(), original = structuredClone(decoded), layout = matchSourceLayout(decoded, source, catalog);
  assert.equal(layout.notEncodedInCode, true); assert.deepEqual(layout.units[1].items, ['DA_WarmogsArmor']); assert.equal(layout.units[1].star, 3); assert.deepEqual(layout.units[1].cell, { x: 6, y: 4 });
  assert.equal(layout.source.id, 'fixture-deck'); assert.equal(layout.coordinateSystem.frontRowY, 4);
  assert.deepEqual(layout.coordinateSystem.verification, { source: 'OP.GG public team-builder', url: 'https://op.gg/tft/tools/team-builder', mappingUrl: 'https://c-tft-web.op.gg/_next/static/chunks/5923-875d594a93cc412d.js', formula: 'row=4-y,col=x-1' });
  assert.match(layout.warning, /不是原生阵容码内的数据/); assert.doesNotMatch(layout.warning, /须依据来源单独核验/); assert.deepEqual(decoded, original);
  const otherCode = layoutSource(encodePCCode(['DA_18_Maokai', 'DA_18_Ivern'], mapping, context).code); assert.equal(matchSourceLayout(decoded, otherCode, catalog), null);
  const duplicate = layoutSource(); duplicate.data.data.push(structuredClone(duplicate.data.data[0])); assert.equal(matchSourceLayout(decoded, duplicate, catalog), null);
  const wrongMembers = layoutSource(); wrongMembers.data.data[0].units[0].key = 'DA_18_Maokai'; assert.equal(matchSourceLayout(decoded, wrongMembers, catalog), null);
  const unsupportedItems = layoutSource(); unsupportedItems.data.data[0].units[1].items.push('UNKNOWN_ITEM'); assert.equal(matchSourceLayout(decoded, unsupportedItems, catalog), null);
  const wrongVersion = layoutSource(); wrongVersion.evidence.rulesVersion = 'other'; assert.equal(matchSourceLayout(decoded, wrongVersion, catalog), null);
  const noHash = layoutSource(); delete noHash.evidence.recordHash; assert.equal(matchSourceLayout(decoded, noHash, catalog), null);
  const unknownCoordinates = layoutSource(); unknownCoordinates.data.data[0].units[0].cell = { x: 9, y: 4 }; unknownCoordinates.data.data[0].units[0].tier = 7;
  const partial = matchSourceLayout(decoded, unknownCoordinates, catalog); assert.equal(partial.units[0].cell, null); assert.equal(partial.units[0].star, null);
});

test('server decoder/encoder use only current verified local mapping, never fetch, and fail closed after tampering', async () => isolated(async dir => {
  const original = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Runtime network forbidden'); };
  const statsReader = async () => layoutSource();
  try {
    await assert.rejects(decodeTeamCode(nativeCode, { catalog, dir, statsReader }), hasCode('mapping_not_cached', error => error.status === 503));
    await publishTeamCodeMapping(catalog, mapping, raw, dir);
    const decoded = await decodeTeamCode(nativeCode, { catalog, dir, statsReader }); assert.equal(decoded.sourceLayout.units[1].star, 3); assert.equal(decoded.units[1].star, 1);
    assert.equal((await encodeTeamCode(['DA_18_Ivern', 'DA_18_Maokai'], { catalog, dir })).code, nativeCode);
    const absentLayout = await decodeTeamCode(nativeCode, { catalog, dir, statsReader: async () => { throw new Error('Missing optional snapshot'); } }); assert.equal(absentLayout.sourceLayout, null);
    await assert.rejects(decodeTeamCode(nativeCode, { catalog: { ...catalog, context: { ...context, set: 19, mutator: 'TFTSet19' } }, dir, statsReader }), hasCode('mapping_not_cached'));
    const cached = await readTeamCodeMapping(catalog, dir), file = new URL(`${cached.payload.cacheKey}/${cached.manifest.file}`, dir), tampered = JSON.parse(await readFile(file, 'utf8')); tampered.v2[1045] = 'DA_18_Ivern'; await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(decodeTeamCode(nativeCode, { catalog, dir, statsReader }), hasCode('mapping_not_cached')); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
}));

test('version sync defaults to skip, offline requires original metadata, and failed force keeps last good manifest', async () => isolated(async dir => {
  let requests = 0; const blocked = async () => { requests++; throw new Error('Must not fetch'); };
  await assert.rejects(syncTeamCodes(['--offline'], { catalog, dir, fetchImpl: blocked }), /No network request/);
  const path = new URL('source.json', dir); await writeFile(path, JSON.stringify(raw));
  await assert.rejects(syncTeamCodes([`--from-json=${fileURLToPath(path)}`, '--offline'], { catalog, dir, fetchImpl: blocked }), /original/);
  const result = await syncTeamCodes(['--offline', `--from-json=${fileURLToPath(path)}`, `--fetched-at=${capturedAt}`], { catalog, dir, fetchImpl: blocked }); assert.equal(result.evidence.fetchedAt, capturedAt);
  const previous = await readTeamCodeMapping(catalog, dir); await syncTeamCodes(['--offline'], { catalog, dir, fetchImpl: blocked }); assert.equal(requests, 0);
  await assert.rejects(syncTeamCodes(['--force'], { catalog, dir, fetchImpl: async () => ({ ok: true, json: async () => ({ TFTSet17: [] }), headers: { get: () => null } }) }), /mutator/);
  assert.equal((await readTeamCodeMapping(catalog, dir)).manifest.file, previous.manifest.file);
}));
