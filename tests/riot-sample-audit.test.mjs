import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRiotMatches, hasUsableGameVersion, participantMatchesConditions } from '../scripts/riot-sample-audit.mjs';

const catalog = { context: { set: 18 }, champions: [{ id: 'DA_18_Veigar' }, { id: 'DA_18_Alune' }], items: [{ id: 'DA_Artifact_Dawncore' }] };
const unit = (id = 'DA_18_Veigar', itemNames = ['DA_Artifact_Dawncore']) => ({ character_id: id, itemNames, items: [9999] });
const record = (matchId = 'PRIVATE_MATCH', overrides = {}) => ({ fetchedAt: '2026-10-09T00:00:00Z', body: { metadata: { match_id: matchId, participants: ['PRIVATE_PUUID'] }, info: {
  queue_id: 1100, tft_set_number: 18, game_version: 'Version 16.20.1 (build 12345)',
  participants: Array.from({ length: 8 }, (_, index) => ({ puuid: 'PRIVATE_PUUID', riotIdGameName: 'PRIVATE_NAME', placement: index + 1, units: [unit()] })), ...overrides,
} } });

test('audits unique matches, participant boards and unit occurrences without exposing player or match identities', () => {
  const report = auditRiotMatches([record(), record(), record('PRIVATE_MATCH_2', { queue_id: 1130, tft_set_number: 17 })], catalog);
  assert.equal(report.input.duplicateMatchRecordsExcluded, 1);
  assert.deepEqual(report.counts, { matches: 2, participantFinalBoards: 16, unitOccurrences: 16, ranked1100Matches: 1, currentSetMatches: 1, ranked1100CurrentSetMatches: 1 });
  assert.equal(report.fieldQuality.matchesWithoutCompletePlacementSet, 0);
  assert.equal(report.entityMapping.champions.mappedOccurrences, 16);
  assert.equal(report.entityMapping.items.mappedOccurrences, 16);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|puuid|riotIdGameName|match_id/);
});

test('flags placeholder versions and preserves raw version distribution without assigning TFT patch', () => {
  for (const invalid of [null, undefined, '', '  ', 'Version ?', 'placeholder version', 'unknown', 'N/A']) assert.equal(hasUsableGameVersion(invalid), false);
  assert.equal(hasUsableGameVersion('Version 16.20.1 (build 12345)'), true);
  const report = auditRiotMatches([record('A', { game_version: 'Version ?' }), record('B', { game_version: null })], catalog);
  assert.equal(report.fieldQuality.matchesWithMissingOrPlaceholderGameVersion, 2);
  assert.deepEqual(report.distributions.rawGameVersions, [{ value: '(missing)', count: 1 }, { value: 'Version ?', count: 1 }]);
  assert.equal(report.assignedPatch, undefined);
});

test('exact entity IDs are required; numeric item IDs never substitute missing or unknown itemNames', () => {
  const report = auditRiotMatches([record('A', { participants: [{ placement: 1, units: [
    unit('DA_18_Veigar', ['DA_Artifact_Dawncore', 'Unknown_Item']),
    { character_id: 'da_18_veigar', items: [1, 2, 3] },
    unit('Unknown_Champion', []),
  ] }] })], catalog);
  assert.equal(report.entityMapping.champions.mappedOccurrences, 1);
  assert.deepEqual(report.entityMapping.champions.unknownIds, [{ value: 'da_18_veigar', count: 1 }, { value: 'Unknown_Champion', count: 1 }]);
  assert.equal(report.entityMapping.items.namedItemOccurrences, 2);
  assert.equal(report.entityMapping.items.mappedOccurrences, 1);
  assert.deepEqual(report.entityMapping.items.unknownIds, [{ value: 'Unknown_Item', count: 1 }]);
  assert.equal(report.entityMapping.items.numericIdsUsedForMapping, 0);
  assert.equal(report.fieldQuality.numericItemIdOccurrences, 5);
  assert.equal(report.fieldQuality.unitsWithMissingItemNames, 1);
  assert.equal(report.fieldQuality.unitsWithNumericAndNamedItemCountDifference, 2);
});

test('reports malformed records, missing boards and invalid placement separately', () => {
  const report = auditRiotMatches([{}, record('A', { participants: [{ placement: 0, units: [] }, { placement: '2' }, null, { placement: 3, units: [null, { itemNames: [null], character_id: '' }] }] }), { body: { info: {} } }], catalog);
  assert.equal(report.input.malformedRecords, 1);
  assert.equal(report.input.recordsWithoutMatchIdentity, 1);
  assert.equal(report.fieldQuality.matchesWithMissingParticipants, 1);
  assert.equal(report.fieldQuality.participantsWithInvalidPlacement, 2);
  assert.equal(report.fieldQuality.participantsWithEmptyUnits, 1);
  assert.equal(report.fieldQuality.participantsWithMissingUnits, 1);
  assert.equal(report.fieldQuality.malformedParticipants, 1);
  assert.equal(report.fieldQuality.malformedUnits, 1);
  assert.equal(report.fieldQuality.unitsWithMissingChampionId, 1);
  assert.equal(report.fieldQuality.malformedNamedItemEntries, 1);
});

test('joint conditions stay within one participant and equipment must be on the chosen carrier', () => {
  const first = { units: [unit('DA_18_Veigar')] };
  const second = { units: [unit('DA_18_Alune')] };
  const conditions = { championIds: ['DA_18_Veigar', 'DA_18_Alune'], carrierId: 'DA_18_Veigar', itemNames: ['DA_Artifact_Dawncore'] };
  assert.equal([first, second].some(player => participantMatchesConditions(player, conditions)), false);
  assert.equal(participantMatchesConditions({ units: [...first.units, ...second.units] }, conditions), true);
  assert.equal(participantMatchesConditions({ units: [unit('DA_18_Veigar', []), unit('DA_18_Alune')] }, conditions), false);
  assert.equal(participantMatchesConditions(first, { carrierId: 'DA_18_Veigar', itemNames: ['DA_Artifact_Dawncore', 'DA_Artifact_Dawncore'] }), false);
  assert.equal(participantMatchesConditions(first, { itemNames: ['DA_Artifact_Dawncore'] }), false);
});
