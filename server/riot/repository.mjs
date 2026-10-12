import { getPool, getActiveRelease } from '../storage/repository.mjs';
import { getCatalog } from '../data.mjs';
import { stableJSON,sha256 } from '../../scripts/stats-cache.mjs';
import { normalizeRiotMatch } from './normalize.mjs';
import { loadRiotPatchWindows } from './patch-policy.mjs';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
export async function importRiotMatch(record, { db = null, catalog = null, patchWindows = null } = {}) {
  db ??= await getPool(); catalog ??= await getCatalog(); patchWindows ??= await loadRiotPatchWindows(db);
  const m = normalizeRiotMatch(record,catalog,patchWindows), connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT content_hash,status,assigned_patch,quality,raw_json FROM riot_matches WHERE match_id=? FOR UPDATE',[m.matchId]);
    const old = existing[0];
    if (old && (old.content_hash !== m.contentHash || json(old.quality).issues?.includes('source_payload_conflict'))) {
      const quality = json(old.quality);
      quality.issues = [...new Set([...(quality.issues || []),'source_payload_conflict'])];
      await connection.execute("UPDATE riot_matches SET status='quarantined',quality=? WHERE match_id=?",[stableJSON(quality),m.matchId]);
      const release = await getActiveRelease(connection);
      if (release && old.content_hash !== m.contentHash) await connection.execute("INSERT INTO change_log(release_id,kind,detail) VALUES(?,'riot_payload_conflict',?)",[release.id,stableJSON({
        previousHash:old.content_hash,incomingHash:m.contentHash,status:'quarantined',rawPreserved:true})]);
      await connection.commit(); return {status:'conflict',readiness:'quarantined'};
    }
    if (old && old.status === m.status && old.assigned_patch === m.assignedPatch && stableJSON(json(old.quality)) === stableJSON(m.quality)) {
      if (!old.raw_json) await connection.execute('UPDATE riot_matches SET raw_json=? WHERE match_id=?',[stableJSON(m.body),m.matchId]);
      await connection.commit(); return {status:'duplicate',readiness:m.status};
    }
    const fields = [m.platform,m.region,m.queue,m.season,m.start,m.end,m.rawVersion,m.sourcePatch,m.assignedPatch,
      m.patchAttribution?stableJSON(m.patchAttribution):null,m.status,m.contentHash,stableJSON(m.quality),stableJSON(m.body),m.fetchedAt,stableJSON(m.body)];
    if (!old) await connection.execute(`INSERT INTO riot_matches(match_id,platform,region,queue_id,season,game_started_at,game_ended_at,
      raw_game_version,source_patch,assigned_patch,patch_attribution,status,content_hash,quality,raw_payload,fetched_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[m.matchId,...fields]);
    else {
      await connection.execute(`UPDATE riot_matches SET platform=?,region=?,queue_id=?,season=?,game_started_at=?,game_ended_at=?,
        raw_game_version=?,source_patch=?,assigned_patch=?,patch_attribution=?,status=?,content_hash=?,quality=?,raw_payload=?,fetched_at=?,raw_json=? WHERE match_id=?`,[...fields,m.matchId]);
      // Rebuild only this identical raw match's derived rows after a policy/catalog change.
      for (const table of ['riot_unit_items','riot_units','riot_traits','riot_participants']) await connection.execute(`DELETE FROM ${table} WHERE match_id=?`,[m.matchId]);
    }
    for (const p of m.participants) {
      await connection.execute('INSERT INTO riot_participants(match_id,participant_index,placement,level,composition_key,units_json,traits_json) VALUES(?,?,?,?,?,?,?)',
        [m.matchId,p.index,p.placement,p.level,p.compositionKey,stableJSON(p.units),stableJSON(p.traits)]);
      for (const u of p.units) {
        await connection.execute('INSERT INTO riot_units(match_id,participant_index,unit_index,champion_id,star_level,item_ids,build_key,valid_build) VALUES(?,?,?,?,?,?,?,?)',
          [m.matchId,p.index,u.unitIndex,u.championId,u.starLevel,stableJSON(u.itemIds),u.buildKey,u.validBuild]);
        for (const [i,id] of u.itemIds.entries()) await connection.execute('INSERT INTO riot_unit_items(match_id,participant_index,unit_index,item_index,item_id) VALUES(?,?,?,?,?)',[m.matchId,p.index,u.unitIndex,i,id]);
      }
      for (const t of p.traits) await connection.execute('INSERT INTO riot_traits(match_id,participant_index,trait_id,style,tier_current) VALUES(?,?,?,?,?)',[m.matchId,p.index,t.id,t.style,t.tierCurrent]);
    }
    const release = await getActiveRelease(connection);
    if (release) await connection.execute("INSERT INTO change_log(release_id,kind,detail) VALUES(?,'riot_match_imported',?)",[release.id,stableJSON({
      action:old?'reclassified':'imported',status:m.status,season:m.season,queue:m.queue,assignedPatch:m.assignedPatch,sourcePatch:null,
      participants:m.participants.length,issues:m.quality.issues,unknownItems:m.quality.unknownItems,contentHash:m.contentHash})]);
    await connection.commit();
    return {status:old?'reclassified':'imported',readiness:m.status,assignedPatch:m.assignedPatch,participants:m.participants.length,issues:m.quality.issues};
  } catch(error) {await connection.rollback();throw error;}
  finally {connection.release();}
}

export async function getRiotStatus(db = null) {
  db ??= await getPool(); const release = await getActiveRelease(db);
  if (!release) return {status:'not_initialized',matches:{total:0,readyCurrent:0,quarantined:0,otherPatch:0}};
  const [[counts]] = await db.execute(`SELECT COUNT(*) AS total,
    SUM(status='ready' AND season=? AND queue_id=1100 AND COALESCE(source_patch,assigned_patch)=?) AS readyCurrent,
    SUM(status='quarantined') AS quarantined,
    SUM(status='ready' AND COALESCE(source_patch,assigned_patch)<>?) AS otherPatch,MAX(fetched_at) AS latestFetchedAt FROM riot_matches`,
    [release.season,release.currentPatch,release.currentPatch]);
  const [[participants]] = await db.execute(`SELECT COUNT(*) AS n FROM riot_participants p JOIN riot_matches m ON m.match_id=p.match_id
    WHERE m.status='ready' AND m.season=? AND m.queue_id=1100 AND COALESCE(m.source_patch,m.assigned_patch)=?`,[release.season,release.currentPatch]);
  const [unknown] = await db.query(`SELECT u.id,SUM(u.n) AS count FROM riot_matches m JOIN JSON_TABLE(m.quality,'$.unknownItems[*]'
    COLUMNS(id VARCHAR(240) PATH '$.id',n INT PATH '$.count')) u GROUP BY u.id ORDER BY count DESC LIMIT 30`);
  const [jobs] = await db.execute('SELECT job_key,payload,updated_at FROM riot_collection_jobs WHERE job_key IN (?,?)', ['riot:kr:collector:v1','riot:kr:worker:v1']);
  const collector = jobs.find(j=>j.job_key==='riot:kr:collector:v1'), worker = jobs.find(j=>j.job_key==='riot:kr:worker:v1');
  const c = collector ? json(collector.payload) : null, w = worker ? json(worker.payload) : null;
  const [changes] = await db.query("SELECT id,kind,detail,created_at FROM change_log WHERE kind IN ('riot_match_imported','riot_payload_conflict') ORDER BY id DESC LIMIT 12");
  // Do not expose cursors, seed player IDs, credentials or their fingerprints.
  return {status:Number(counts.readyCurrent)>0?'ready':'collecting',currentPatch:release.currentPatch,season:release.season,
    matches:Object.fromEntries(['total','readyCurrent','quarantined','otherPatch'].map(k=>[k,Number(counts[k] || 0)])),
    participantsCurrent:Number(participants.n),latestFetchedAt:counts.latestFetchedAt?new Date(Number(counts.latestFetchedAt)).toISOString():null,
    unknownItems:unknown.map(r=>({id:r.id,count:Number(r.count)})),
    recentChanges:changes.map(row=>({id:row.id,kind:row.kind,createdAt:row.created_at,detail:json(row.detail)})),
    lastJob:c?{status:c.lastReport?.status ?? c.status ?? null,updatedAt:collector.updated_at,pendingCount:Array.isArray(c.pending)?c.pending.length:0}:null,
    worker:w?{status:w.lastReport?.status ?? w.status ?? null,lastAttemptAt:w.lastAttemptAt ?? null,nextRunAt:w.nextAttemptAt ?? null,errorCode:w.errorCode ?? null}:null,
    patchAttribution:'比赛时间推定主补丁；热修未知',population:'韩服王者种子玩家的近期排位对局；对手比赛时段位未知',
    sampleUnit:'同一玩家的终局阵容，不是逐回合棋盘',source:'Riot Games API',delivery:'mysql'};
}

// Re-evaluate saved raw matches after patch evidence recovers, without spending API quota.
export async function reclassifyStoredRiotMatches({db=null,catalog=null,limit=250}={}) {
  if (!Number.isSafeInteger(limit)||limit<1||limit>1000) throw Object.assign(new Error('Invalid reclassification budget'),{code:'RIOT_RECLASSIFY_LIMIT_INVALID'});
  db ??= await getPool(); catalog ??= await getCatalog();
  const patchWindows=await loadRiotPatchWindows(db);
  const [rows]=await db.execute(`SELECT raw_payload,raw_json,content_hash,fetched_at FROM riot_matches WHERE status='quarantined' AND queue_id=1100 AND season=?
    AND NOT JSON_CONTAINS(JSON_EXTRACT(quality,'$.issues'),'"source_payload_conflict"') ORDER BY game_ended_at DESC LIMIT ${limit}`,[catalog.context.set]);
  const report={checked:rows.length,reclassified:0,stillQuarantined:0,unverifiable:0};
  for(const row of rows){
    const body=json(row.raw_json || row.raw_payload);
    // Do not interpret a binary-JSON numeric round-trip as a new upstream response.
    if (sha256(body)!==row.content_hash) {report.unverifiable++;continue;}
    const result=await importRiotMatch({body,fetchedAt:Number(row.fetched_at)},{db,catalog,patchWindows});
    if(result.status==='reclassified')report.reclassified++;
    if(result.readiness==='quarantined')report.stillQuarantined++;
  }
  return report;
}
