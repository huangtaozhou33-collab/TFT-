import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiotParticipantFilter, getRiotResearchResults } from '../server/riot/query.mjs';
import { resolveResearchIntent } from '../server/research-intent.mjs';
import { answerChat } from '../server/chat.mjs';
import { readFile } from 'node:fs/promises';

const catalog = { champions: [{id:'a',name:'维迦'}, {id:'b',name:'阿狸'}, {id:'c',name:'璐璐'}], items: [{id:'x',name:'黎明核心'}, {id:'y',name:'法杖'}, {id:'z',name:'护盾'}], traits: [{id:'t',name:'法师'}] };
const release = { season: 18, currentPatch: '18.4' };
const query = { conditions: [{type:'champion',id:'a'}, {type:'champion',id:'b'}, {type:'item',id:'x',holderId:'a'}, {type:'item',id:'x'}], carrierId:'a', minSample:100, sort:'avgPlacement' };

test('participant SQL binds current release and all predicates to one participant and one holder instance', () => {
  const filter = buildRiotParticipantFilter({...query, conditions:[...query.conditions,{type:'trait',id:'t'},{type:'item',id:'y',holderId:'a'}]}, release);
  assert.deepEqual(filter.params, [18,'18.4','a','b','t','x',2,'y',1,'a','x',1,'y',1]);
  assert.match(filter.sql, /m.queue_id=1100/);
  assert.match(filter.sql, /m.status='ready'/);
  assert.match(filter.sql, /COALESCE\(m.source_patch,m.assigned_patch\)=\?/);
  assert.match(filter.sql, /cu.participant_index=p.participant_index/);
  assert.match(filter.sql, /ct.style>0 AND ct.tier_current>0/);
  assert.equal((filter.sql.match(/hi.unit_index=hu.unit_index/g) || []).length, 2);
  assert.equal(filter.sql.includes('18.4'),false);
});

test('no eligible currentpatch Riot match returns null before any aggregate lookup', async () => {
  let calls=0;
  const result=await getRiotResearchResults(query,catalog,{release,db:{execute:async(sql,params)=>{
    calls++;assert.match(sql,/m.queue_id=1100/);assert.deepEqual(params,[18,'18.4']);return [[{matches:0}]];
  }}});
  assert.equal(result,null);assert.equal(calls,1);
});

test('production pool queries use one read-only repeatable-read snapshot and always release it', async () => {
  const events=[];
  const connection={query:async sql=>{events.push(sql);},execute:async()=>[[{matches:0}]],commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),release:()=>events.push('release')};
  const db={getConnection:async()=>connection};
  const getActiveRelease=async active=>{assert.equal(active,connection);events.push('release lookup');return release;};
  assert.equal(await getRiotResearchResults(query,catalog,{db,getActiveRelease}),null);
  assert.deepEqual(events,['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY','release lookup','commit','release']);
  events.length=0;
  connection.execute=async()=>{throw Error('query failed');};
  await assert.rejects(getRiotResearchResults(query,catalog,{db,getActiveRelease}),/query failed/);
  assert.deepEqual(events.slice(-2),['rollback','release']);
});

test('Riot groups keep small samples, full provenance, correct carrier and deduplication SQL', async () => {
  const seen=[];
  const responses=[
    [{matches:8}],
    [{participants:2,matches:2,source_declared:0,assigned:2,platforms:'kr',first_game:1791518400000,last_game:1791522000000,fetched_at:1791530000000}],
    [{champion_id:'a',build_key:'build',item_ids:'["x","y","z"]',sample_size:2,avg_placement:'3',top4_rate:0.5,win_rate:0.5,total_rows:1}],
    [{champion_id:'c',sample_size:1,avg_placement:'1',top4_rate:1,win_rate:1,total_rows:1}],
    [{composition_key:'board',units_json:'[{"championId":"a","items":["x"]},{"championId":"b"},{"championId":"c"}]',sample_size:1,avg_placement:1,top4_rate:1,win_rate:1,total_rows:1}],
  ];
  const result=await getRiotResearchResults(query,catalog,{release,db:{execute:async(sql,params)=>{seen.push({sql,params});return [responses.shift()];}}});
  assert.equal(result.source,'riot');assert.equal(result.coverage.matchedParticipants,2);assert.equal(result.coverage.matchedMatches,2);
  assert.equal(result.equipment.rows[0].lowSample,true);assert.equal(result.equipment.rows[0].stats.sampleSize,2);
  assert.equal(result.selection.minimumSampleSize,0);assert.equal(result.selection.lowSampleWarningThreshold,100);
  assert.deepEqual(result.equipment.rows[0].itemIds,['x','y','z']);assert.equal(result.teammates.rows[0].stats.avgPlacement,1);
  assert.equal(result.evidence.sourcePatch,null);assert.equal(result.evidence.assignedPatch,'18.4');assert.equal(result.evidence.rank,null);
  assert.match(result.evidence.patchAssignment.note,/比赛发生时间/);
  assert.ok(result.comps.rows[0].units.every(unit=>unit.items.length===0));
  assert.match(seen[2].sql,/GROUP BY p.match_id,p.participant_index,p.placement,u.champion_id,u.build_key/);
  assert.match(seen[2].sql,/bi.unit_index=u.unit_index/);
  assert.deepEqual(seen[2].params.slice(-4),['a','a','x',1]);
  assert.match(seen[3].sql,/SELECT DISTINCT p.match_id,p.participant_index,p.placement,u.champion_id/);
  assert.ok(seen.slice(1).every(({sql})=>!sql.includes('sample_size>=')));
});

test('active Riot source returns explicit empty result without fabricated patch claims', async () => {
  const responses=[[{matches:7}],[{participants:0,matches:0,source_declared:null,assigned:null}],[],[],[]];
  const result=await getRiotResearchResults(query,catalog,{release,db:{execute:async()=>[responses.shift()]}});
  assert.equal(result.status,'empty');assert.equal(result.coverage.jointMatchQueries,true);
  assert.equal(result.evidence.sourcePatch,null);assert.equal(result.evidence.assignedPatch,null);
  assert.deepEqual(result.equipment.rows,[]);assert.match(result.reason,/没有同时满足全部条件/);
});

test('multi-champion questions resolve all heroes and a clearly named carrier, not just first hero', () => {
  const resolved=resolveResearchIntent('阿狸、璐璐、小法同时上场，小法带黎明核心的最佳三件套是什么？',catalog);
  assert.deepEqual(resolved.conditions.filter(term=>term.type==='champion').map(term=>term.id),['b','c','a']);
  assert.equal(resolved.carrierId,'a');assert.deepEqual(resolved.conditions.at(-1),{type:'item',id:'x',holderId:'a'});
  assert.equal(resolveResearchIntent('小法的最佳出装',catalog),null);
  assert.equal(resolveResearchIntent('小法和阿狸哪个出装好，比较一下',catalog),null);
});

test('Agent calls the same research service with all conditions and exposes actual joint evidence', async () => {
  const fullCatalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
  const heroes=fullCatalog.champions.slice(0,3);
  const conditions=heroes.map(hero=>({type:'champion',id:hero.id}));
  const result={status:'empty',query:{conditions},equipment:{rows:[],evidence:{source:'Riot Games Match API',sourcePatch:null,assignedPatch:'18.4'}},teammates:{rows:[]},comps:{rows:[],evidence:{source:'Riot Games Match API'}},coverage:{jointMatchQueries:true,matchedParticipants:0}};
  let calls=0;
  const answer=await answerChat({messages:[{role:'user',content:'当前筛选条件的装备和队友结果？'}],pageContext:{view:'explorer',readonly:true,research:{conditions,carrierId:heroes[2].id,minSample:100,sort:'avgPlacement'}}},{
    getCatalog:async()=>fullCatalog,getLibrarySnapshot:async()=>({documents:[],augmentRules:[]}),getSeasonMechanic:async()=>({entries:[]}),
    getMetaDecks:async()=>{throw Error('Do not relax to meta decks');},getChampionBuild:async()=>{throw Error('Do not relax to one champion');},
    getResearchResults:async input=>{calls++;assert.equal(input.carrierId,heroes[2].id);assert.deepEqual(input.conditions,conditions);return result;},
    chatCompletion:async(messages,tools)=>{
      const data=messages.filter(message=>message.role==='system').map(message=>message.content).find(content=>content.includes('"jointMatchQueries":true'));
      assert.ok(data);assert.ok(tools.some(tool=>tool.function.name==='get_research_stats'));
      return {message:{role:'assistant',content:'当前条件尚无样本。'},usage:null};
    },
  });
  assert.equal(calls,1);assert.equal(answer.reply,'当前条件尚无样本。');
});

test('an empty explorer page does not erase multiple heroes explicitly named in chat', async () => {
  const fullCatalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
  let received;
  await answerChat({messages:[{role:'user',content:'小法、阿狸、卡尔玛同时上场，小法的最佳装备是什么？'}],pageContext:{view:'explorer',research:{conditions:[],minSample:100}}},{
    getCatalog:async()=>fullCatalog,getLibrarySnapshot:async()=>({documents:[],augmentRules:[]}),getSeasonMechanic:async()=>({entries:[]}),
    getResearchResults:async query=>{received=query;return {query,status:'empty',equipment:{rows:[]},teammates:{rows:[]},comps:{rows:[]},coverage:{jointMatchQueries:true}};},
    chatCompletion:async()=>({message:{role:'assistant',content:'当前条件没有样本。'},usage:null}),
  });
  assert.equal(received.conditions.filter(term=>term.type==='champion').length,3);
  assert.match(received.carrierId,/Veigar$/);
});
