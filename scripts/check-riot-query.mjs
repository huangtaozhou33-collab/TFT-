import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getPool, getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { getRiotResearchResults } from '../server/riot/query.mjs';

// Infrastructure acceptance only. All synthetic rows live inside one transaction
// and are rolled back. No API/model calls and no production data modifications.
const fixtureIds = Array.from({length:8},(_,index)=>`KR_99990000000001${String(index).padStart(2,'0')}`);
const hero = name => `TEST_RIOT_${name}`;
const item = name => `TEST_RIOT_ITEM_${name}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const itemNames = ['x','y','z','p','q','r'].map(item);
const heroNames = ['crossA','crossB','splitA','splitB','holderA','holderB','holderC','copyA','copyB','copiesA','copiesB'];
const catalog = {champions:heroNames.map(name=>({id:hero(name),name})),items:itemNames.map(id=>({id,name:id,kind:'completed'})),traits:[]};
const unit = (name, names=[]) => ({id:hero(name),championId:hero(name),items:names.map(item).sort()});
const checks = [];
let db, connection, rollbackVerified = false;

async function insertMatch(index, release, participants, patch=release.currentPatch) {
  const id=fixtureIds[index], now=Date.now();
  await connection.execute(`INSERT INTO riot_matches(match_id,platform,region,queue_id,season,game_started_at,game_ended_at,
    raw_game_version,source_patch,assigned_patch,patch_attribution,status,content_hash,quality,raw_payload,fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,'kr','asia',1100,release.season,now-7200000,now-3600000,'TFT Unreal Version ?.?.?.?',null,patch,
    JSON.stringify({method:'isolated_transaction_fixture'}),'ready',digest({id,participants}),JSON.stringify({fixture:true}),JSON.stringify({fixture:true}),now]);
  for (const [participantIndex,p] of participants.entries()) {
    await connection.execute('INSERT INTO riot_participants(match_id,participant_index,placement,level,composition_key,units_json,traits_json) VALUES(?,?,?,?,?,?,?)',
      [id,participantIndex,p.placement,8,digest(p.units.map(u=>u.id).sort()),JSON.stringify(p.units),'[]']);
    for (const [unitIndex,u] of p.units.entries()) {
      await connection.execute('INSERT INTO riot_units(match_id,participant_index,unit_index,champion_id,star_level,item_ids,build_key,valid_build) VALUES(?,?,?,?,?,?,?,?)',
        [id,participantIndex,unitIndex,u.id,2,JSON.stringify(u.items),digest(u.items),u.items.length===3]);
      for (const [itemIndex,itemId] of u.items.entries()) await connection.execute('INSERT INTO riot_unit_items(match_id,participant_index,unit_index,item_index,item_id) VALUES(?,?,?,?,?)',
        [id,participantIndex,unitIndex,itemIndex,itemId]);
    }
  }
}

try {
  db=await getPool(); connection=await db.getConnection();
  await connection.beginTransaction();
  const [[collision]]=await connection.execute(`SELECT COUNT(*) AS n FROM riot_matches WHERE match_id IN (${fixtureIds.map(()=>'?').join(',')})`,fixtureIds);
  assert.equal(Number(collision.n),0,'fixture IDs must be unused');
  const release=await getActiveRelease(connection);
  assert.ok(release?.currentPatch,'published release required');
  const query=async(names,{holder,required=[],carrier=names[0],minSample=100}={})=>getRiotResearchResults({
    conditions:[...names.map(name=>({type:'champion',id:hero(name)})),...required.map(name=>({type:'item',id:item(name),holderId:holder?hero(holder):null}))],
    carrierId:hero(carrier),minSample,sort:'avgPlacement',
  },catalog,{db:connection,release});

  await insertMatch(0,release,[{placement:1,units:[unit('crossA',['x','y','z'])]},{placement:2,units:[unit('crossB')]}]);
  await insertMatch(1,release,[{placement:3,units:[unit('crossB')]}]);
  const cross=await query(['crossA','crossB']);
  assert.equal(cross.coverage.matchedParticipants,0);assert.equal(cross.equipment.rows.length,0);
  checks.push('different_players_and_matches_cannot_join');

  await insertMatch(2,release,[{placement:2,units:[unit('splitA',['x','p','q']),unit('splitA',['y','p','q']),unit('splitB')]}]);
  const split=await query(['splitA','splitB'],{holder:'splitA',required:['x','y']});
  assert.equal(split.coverage.matchedParticipants,0);
  checks.push('bound_items_cannot_be_split_across_hero_copies');

  await insertMatch(3,release,[{placement:4,units:[unit('holderA',['x','y','z']),unit('holderA',['p','q','r']),unit('holderB'),unit('holderC'),unit('holderC')]}]);
  const holder=await query(['holderA','holderB'],{holder:'holderA',required:['x','y']});
  assert.equal(holder.coverage.matchedParticipants,1);assert.equal(holder.equipment.rows.length,1);
  assert.deepEqual(holder.equipment.rows[0].itemIds,['x','y','z'].map(item).sort());
  checks.push('only_qualifying_carrier_instance_build_is_returned');
  assert.equal(holder.teammates.rows.find(row=>row.championId===hero('holderC')).stats.sampleSize,1);
  checks.push('copied_teammate_counts_one_participant');

  const copyUnits=[unit('copyA',['x','y','z']),unit('copyA',['x','y','z']),unit('copyB')];
  await insertMatch(4,release,[{placement:3,units:copyUnits}]);
  await insertMatch(5,release,[{placement:1,units:copyUnits}],`${release.season}.0`);
  const copy=await query(['copyA','copyB'],{minSample:1000});
  assert.equal(copy.coverage.matchedMatches,1);assert.equal(copy.coverage.matchedParticipants,1);
  assert.equal(copy.equipment.rows[0].stats.sampleSize,1);assert.equal(copy.equipment.rows[0].stats.avgPlacement,3);
  assert.equal(copy.equipment.rows[0].stats.top4Rate,1);assert.equal(copy.equipment.rows[0].stats.winRate,0);
  checks.push('identical_copied_build_counts_one_participant');
  assert.equal(copy.comps.rows[0].stats.sampleSize,1);assert.equal(copy.comps.rows[0].stats.avgPlacement,3);
  checks.push('previous_patch_excluded_from_all_statistics');
  assert.equal(copy.equipment.rows[0].lowSample,true);assert.equal(copy.comps.rows[0].lowSample,true);
  checks.push('small_samples_remain_visible_with_warning');

  await insertMatch(6,release,[{placement:1,units:[unit('copiesA',['x','x','z']),unit('copiesB')]}]);
  await insertMatch(7,release,[{placement:8,units:[unit('copiesA',['x','y','z']),unit('copiesB',['x'])]}]);
  const bound=await query(['copiesA','copiesB'],{holder:'copiesA',required:['x','x']});
  assert.equal(bound.coverage.matchedParticipants,1);assert.equal(bound.equipment.rows[0].stats.avgPlacement,1);
  const unbound=await query(['copiesA','copiesB'],{required:['x','x']});
  assert.equal(unbound.coverage.matchedParticipants,2);
  checks.push('repeated_items_preserve_multiset_and_holder_scope');

  // Exercise the production pool's read-only repeatable-read transaction too:
  // another connection must never see these uncommitted synthetic boards.
  const isolated=await getRiotResearchResults({conditions:[{type:'champion',id:hero('copyA')}],carrierId:hero('copyA'),minSample:100,sort:'avgPlacement'},catalog,{db,release});
  assert.ok(isolated===null || isolated.coverage.matchedParticipants===0);
  checks.push('production_read_only_snapshot_cannot_see_uncommitted_fixtures');

  await connection.rollback();
  const [[remaining]]=await connection.execute(`SELECT COUNT(*) AS n FROM riot_matches WHERE match_id IN (${fixtureIds.map(()=>'?').join(',')})`,fixtureIds);
  assert.equal(Number(remaining.n),0);rollbackVerified=true;
  console.log(JSON.stringify({status:'passed',checks:checks.length,assertions:checks,syntheticRowsCommitted:0,rollbackVerified,providerRequests:0}));
} catch (error) {
  console.error(JSON.stringify({status:'failed',checksPassed:checks.length,code:error.code || 'RIOT_QUERY_ACCEPTANCE_FAILED',assertion:error.code==='ERR_ASSERTION'?error.message:null,providerRequests:0}));
  process.exitCode=1;
} finally {
  if (connection) {await connection.rollback().catch(()=>{});connection.release();}
  await closeDatabase();
}
