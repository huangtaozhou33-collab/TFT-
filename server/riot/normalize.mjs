import { sha256 } from '../../scripts/stats-cache.mjs';
import { inferMatchPatch } from './patch-policy.mjs';

const finite = Number.isFinite;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
export function normalizeRiotMatch(record, catalog, patchWindows = []) {
  const body = record?.body, info = body?.info, matchId = body?.metadata?.match_id;
  if (!/^KR_\d+$/.test(matchId || '') || !info || typeof info !== 'object') throw Object.assign(new Error('Invalid Riot match envelope'), {code:'RIOT_MATCH_SCHEMA_INVALID'});
  const fetchedAt = typeof record.fetchedAt === 'number' ? record.fetchedAt : Date.parse(record.fetchedAt);
  if (!finite(fetchedAt)) throw Object.assign(new Error('Invalid capture time'), {code:'RIOT_CAPTURE_TIME_INVALID'});
  const issues = [], unknownItems = new Map();
  const season = Number.isSafeInteger(info.tft_set_number) ? info.tft_set_number : null;
  const queue = Number.isSafeInteger(info.queue_id) ? info.queue_id : null;
  const end = finite(info.game_datetime) ? info.game_datetime : null;
  const duration = finite(info.game_length) && info.game_length > 0 && info.game_length < 14400 ? info.game_length * 1000 : null;
  const start = finite(info.gameCreation) ? info.gameCreation : end != null && duration ? Math.floor(end - duration) : null;
  if (!start || !end || !duration || start < Date.UTC(2019,0,1) || start >= end || end > fetchedAt
    || Math.abs((end - start) - duration) > 300000) issues.push('invalid_game_time');
  if (queue !== 1100) issues.push('unsupported_queue');
  if (season !== catalog.context.set) issues.push('different_season');
  const rawVersion = typeof info.game_version === 'string' ? info.game_version.slice(0,240) : null;
  const patch = inferMatchPatch({platform:'kr',season,start,end,rawVersion},patchWindows);
  if (!patch.patch) issues.push(patch.reason);
  const champions = new Set(catalog.champions.map(c => c.id)), items = new Map(catalog.items.map(i => [i.id,i]));
  const participants = [], rawParticipants = Array.isArray(info.participants) ? info.participants : [];
  if (rawParticipants.length !== 8 || rawParticipants.map(p => p?.placement).sort((a,b)=>a-b).join(',') !== '1,2,3,4,5,6,7,8') issues.push('incomplete_ranked_placements');
  for (const [index,p] of rawParticipants.entries()) {
    if (!p || !Number.isSafeInteger(p.placement) || p.placement < 1 || p.placement > 8) { issues.push('invalid_participant'); continue; }
    const units = [];
    if (!Array.isArray(p.units) || !p.units.length) issues.push('empty_final_board');
    for (const [unitIndex,u] of (Array.isArray(p.units) ? p.units : []).entries()) {
      if (!identifier(u?.character_id) || !Number.isSafeInteger(u.tier) || u.tier < 1 || u.tier > 4 || !Array.isArray(u.itemNames)
        || u.itemNames.some(id => !identifier(id))) { issues.push('invalid_unit'); continue; }
      if (!champions.has(u.character_id)) issues.push('unknown_champion');
      const ids = [...u.itemNames].sort();
      for (const id of ids) if (!items.has(id)) unknownItems.set(id,(unknownItems.get(id)||0)+1);
      const validBuild = ids.length === 3 && ids.every(id => items.has(id) && items.get(id).kind !== 'component')
        && ids.reduce((n,id) => n + (items.get(id)?.slotCost ?? 1), 0) <= 3
        && ids.every(id => !items.get(id)?.unique || ids.filter(other => other === id).length === 1);
      units.push({unitIndex,championId:u.character_id,id:u.character_id,starLevel:u.tier,items:ids,itemIds:ids,
        buildKey:sha256(ids),validBuild});
    }
    const traits = [];
    if (!Array.isArray(p.traits)) issues.push('missing_traits');
    for (const t of (Array.isArray(p.traits) ? p.traits : [])) {
      if (!identifier(t?.name) || !Number.isSafeInteger(t.style) || !Number.isSafeInteger(t.tier_current) || t.style < 0 || t.tier_current < 0) {issues.push('invalid_trait');continue;}
      if (traits.some(existing => existing.id === t.name)) {issues.push('duplicate_trait');continue;}
      traits.push({id:t.name,style:t.style,tierCurrent:t.tier_current});
    }
    participants.push({index,placement:p.placement,level:Number.isSafeInteger(p.level)?p.level:null,
      compositionKey:sha256(units.map(u=>u.championId).sort()),units,traits});
  }
  return { matchId, platform:'kr',region:'asia',season,queue,start,end,rawVersion,sourcePatch:null,
    assignedPatch:patch.patch,patchAttribution:patch.attribution || null,
    status:issues.length?'quarantined':'ready',contentHash:sha256(body),body,fetchedAt,participants,
    quality:{issues:[...new Set(issues)],derivedHash:sha256(participants),unknownItems:[...unknownItems].map(([id,count])=>({id,count})),
      timeBasis:finite(info.gameCreation)?'gameCreation_to_game_datetime':'end_minus_duration',
      unknownItemPolicy:'preserved_in_raw_and_item_rows_excluded_from_complete_builds',rankAtMatchTime:null} };
}
