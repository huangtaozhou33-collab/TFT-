import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && value.trim().length > 0;
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const distribution = map => [...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([value, count]) => ({ value, count }));
const fieldValue = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '(missing)';

export function hasUsableGameVersion(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/\?|placeholder|unknown|undefined|^null$|^n\/?a$/i.test(value.trim());
}

// Conditions are evaluated against one participant's final board. An item
// condition must belong to the carrier unit, not another player or teammate.
export function participantMatchesConditions(participant, { championIds = [], carrierId = null, itemNames = [] } = {}) {
  if (!Array.isArray(participant?.units)) return false;
  const units = participant.units.filter(isObject);
  const present = new Set(units.map(unit => unit.character_id));
  if (!championIds.every(id => isId(id) && present.has(id))) return false;
  if (itemNames.length && !isId(carrierId)) return false;
  if (!carrierId) return true;
  return units.some(unit => {
    if (unit.character_id !== carrierId) return false;
    const remaining = Array.isArray(unit.itemNames) ? [...unit.itemNames] : [];
    return itemNames.every(id => {
      const index = remaining.indexOf(id);
      if (!isId(id) || index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  });
}

export function auditRiotMatches(records, catalog) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const currentSet = Number.isInteger(catalog?.context?.set) ? catalog.context.set : null;
  const champions = new Set((catalog?.champions ?? []).map(entry => entry?.id).filter(isId));
  const items = new Set((catalog?.items ?? []).map(entry => entry?.id).filter(isId));
  const seen = new Set();
  const queues = new Map(); const sets = new Map(); const versions = new Map();
  const unknownChampions = new Map(); const unknownItems = new Map();
  const counts = { matches: 0, participantFinalBoards: 0, unitOccurrences: 0, ranked1100Matches: 0, currentSetMatches: 0, ranked1100CurrentSetMatches: 0 };
  const input = { records: records.length, malformedRecords: 0, duplicateMatchRecordsExcluded: 0, recordsWithoutMatchIdentity: 0 };
  const quality = {
    matchesWithMissingOrPlaceholderGameVersion: 0, matchesWithMissingParticipants: 0,
    matchesWithoutExactlyEightParticipants: 0, matchesWithoutCompletePlacementSet: 0,
    malformedParticipants: 0, participantsWithInvalidPlacement: 0, participantsWithMissingUnits: 0,
    participantsWithEmptyUnits: 0, malformedUnits: 0, unitsWithMissingChampionId: 0,
    unitsWithMissingItemNames: 0, unitsWithMalformedItemNames: 0, malformedNamedItemEntries: 0,
    unitsWithNumericItemIds: 0, numericItemIdOccurrences: 0, unitsWithNumericAndNamedItemCountDifference: 0,
  };
  let mappedChampions = 0; let namedItemOccurrences = 0; let mappedItems = 0;
  for (const record of records) {
    const body = record?.body;
    if (!isObject(body?.info)) { input.malformedRecords++; continue; }
    const matchId = body.metadata?.match_id;
    if (isId(matchId)) {
      if (seen.has(matchId)) { input.duplicateMatchRecordsExcluded++; continue; }
      seen.add(matchId);
    } else input.recordsWithoutMatchIdentity++;
    const info = body.info;
    counts.matches++;
    increment(queues, fieldValue(info.queue_id));
    increment(sets, fieldValue(info.tft_set_number));
    increment(versions, fieldValue(info.game_version));
    if (info.queue_id === 1100) counts.ranked1100Matches++;
    if (currentSet !== null && info.tft_set_number === currentSet) counts.currentSetMatches++;
    if (info.queue_id === 1100 && currentSet !== null && info.tft_set_number === currentSet) counts.ranked1100CurrentSetMatches++;
    if (!hasUsableGameVersion(info.game_version)) quality.matchesWithMissingOrPlaceholderGameVersion++;
    if (!Array.isArray(info.participants)) { quality.matchesWithMissingParticipants++; continue; }
    if (info.participants.length !== 8) quality.matchesWithoutExactlyEightParticipants++;
    const placements = info.participants.map(participant => participant?.placement);
    if (placements.length !== 8 || new Set(placements).size !== 8 || !placements.every(value => Number.isInteger(value) && value >= 1 && value <= 8)) quality.matchesWithoutCompletePlacementSet++;
    for (const participant of info.participants) {
      if (!isObject(participant)) { quality.malformedParticipants++; continue; }
      counts.participantFinalBoards++;
      if (!Number.isInteger(participant.placement) || participant.placement < 1 || participant.placement > 8) quality.participantsWithInvalidPlacement++;
      if (!Array.isArray(participant.units)) { quality.participantsWithMissingUnits++; continue; }
      if (participant.units.length === 0) quality.participantsWithEmptyUnits++;
      for (const unit of participant.units) {
        if (!isObject(unit)) { quality.malformedUnits++; continue; }
        counts.unitOccurrences++;
        if (!isId(unit.character_id)) quality.unitsWithMissingChampionId++;
        else if (champions.has(unit.character_id)) mappedChampions++;
        else increment(unknownChampions, unit.character_id);
        if (unit.itemNames === undefined || unit.itemNames === null) quality.unitsWithMissingItemNames++;
        else if (!Array.isArray(unit.itemNames)) quality.unitsWithMalformedItemNames++;
        const names = Array.isArray(unit.itemNames) ? unit.itemNames : [];
        for (const itemName of names) {
          if (!isId(itemName)) { quality.malformedNamedItemEntries++; continue; }
          namedItemOccurrences++;
          if (items.has(itemName)) mappedItems++;
          else increment(unknownItems, itemName);
        }
        const numericIds = Array.isArray(unit.items) ? unit.items.filter(Number.isFinite) : [];
        if (numericIds.length) {
          quality.unitsWithNumericItemIds++;
          quality.numericItemIdOccurrences += numericIds.length;
          if (Array.isArray(unit.itemNames) && numericIds.length !== unit.itemNames.length) quality.unitsWithNumericAndNamedItemCountDifference++;
        }
      }
    }
  }
  return {
    status: 'sample_audited', scope: 'captured_final_boards_only', currentCatalogSet: currentSet,
    input, counts, distributions: { queueIds: distribution(queues), setNumbers: distribution(sets), rawGameVersions: distribution(versions) },
    fieldQuality: quality,
    entityMapping: {
      method: 'exact_game_id_only',
      champions: { unitOccurrences: counts.unitOccurrences, mappedOccurrences: mappedChampions, unknownIds: distribution(unknownChampions), missingIdOccurrences: quality.unitsWithMissingChampionId },
      items: { namedItemOccurrences, mappedOccurrences: mappedItems, unknownIds: distribution(unknownItems), numericIdsUsedForMapping: 0 },
    },
    countDefinitions: {
      matches: 'Unique match IDs among valid info objects; records lacking an ID are counted individually and flagged.',
      participantFinalBoards: 'One final board per valid participant object per match; not unique players.',
      unitOccurrences: 'One valid unit object on a participant final board; repeated champions are separate occurrences.',
      namedItemOccurrences: 'One nonempty itemNames string on one unit; duplicate equipment counts separately.',
      ranked1100CurrentSetMatches: 'Matches whose explicit queue_id is 1100 and explicit tft_set_number equals the catalog set; not a patch-validity assertion.',
      distributions: 'Match counts, preserving raw non-sensitive version strings without mapping to a TFT patch.',
    },
    limitations: [
      'Authentication success does not establish statistical usability or representative sample coverage.',
      'Only final participant boards are audited; round-by-round boards and contemporaneous rank are not inferred.',
      'game_version is not automatically mapped to TFT patch 18.4 or any other display patch.',
      'Numeric items IDs are counted but never matched by array position or substituted for itemNames.',
      'Joint champion and carrier-equipment conditions must match within one participant final board.',
    ],
  };
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage');
  const files = (await readdir(resolve(directory), { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  const records = await Promise.all(files.map(name => readFile(join(resolve(directory), name), 'utf8').then(JSON.parse)));
  const catalog = JSON.parse(await readFile(resolve(process.argv[3] ?? 'data/catalog.json'), 'utf8'));
  console.log(JSON.stringify(auditRiotMatches(records, catalog), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Riot sample audit failed: supply a readable matches directory and catalog JSON. No API request was made.'); process.exitCode = 1; });
}
