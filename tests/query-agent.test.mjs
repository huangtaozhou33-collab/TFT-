import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareQueryAgent,validateStatisticsQuery,isStatisticsRequest} from '../server/query-agent.mjs';
import {answerChat} from '../server/chat.mjs';
const catalog=JSON.parse(await readFile(new URL('../data/catalog.json',import.meta.url),'utf8'));
const dragon=catalog.champions.find(c=>c.name==='远古巨龙'),ahri=catalog.champions.find(c=>c.name==='阿狸');
const silver=catalog.items.find(i=>i.name==='密银黎明'),ie=catalog.items.find(i=>i.name==='无尽之刃');
const source={source:'MetaTFT Explorer',url:'https://www.metatft.com/explorer',delivery:'mysql',snapshotId:'1'.repeat(64),recordHash:'2'.repeat(64),requestedPatch:'18.4b',sourcePatch:null};
const stats=(n,avg)=>({sampleSize:n,avgPlacement:avg,top4Rate:.6,winRate:.1});
const unit=(c,n,avg)=>({id:`unit:${c.id}`,championId:c.id,name:c.name,stats:stats(n,avg),evidence:source});
const body={messages:[{role:'user',content:'查询大龙整体均次'}],pageContext:{view:'comps',readonly:true}};
const make=(deps={},overrides={})=>prepareQueryAgent({catalog,body:{...body,...overrides},history:overrides.messages||body.messages,draft:{version:0},traceId:null},deps);

test('natural-language query tools carry page or explicit rank to every statistics service',async()=>{
  const calls=[];
  const empty=()=>({status:'empty',data:[],rows:[],evidence:{...source,rank:'黄金'}});
  const agent=await make({
    getMetaDecks:async options=>{calls.push(['comps',options.rank]);return empty();},
    getExplorerSnapshot:async(tab,options)=>{calls.push([tab,options.rank]);return empty();},
    getConditionalChampionBuild:async query=>{calls.push(['builds',query.rank]);return empty();},
    getItemHolders:async(id,options)=>{calls.push(['holders',options.rank]);return empty();},
    getResearchResults:async query=>{calls.push(['filter',query.rank]);return empty();}
  },{pageContext:{view:'stats',rank:'GOLD'}});
  for(const query of [{view:'comps'},{view:'champions'},{view:'items'},{view:'traits'},
    {view:'builds',championId:dragon.id},{view:'holders',itemId:silver.id},{view:'filter',conditions:[{type:'champion',id:dragon.id}]}])await agent.run('query_tft_stats',query);
  assert.equal(calls.length,7);assert.ok(calls.every(([,rank])=>rank==='GOLD'));
  await agent.run('query_tft_stats',{view:'champions',rank:'CHALLENGER'});
  assert.deepEqual(calls.at(-1),['units','CHALLENGER']);assert.equal(agent.result.queryState.rank,'CHALLENGER');
});
test('statistics route covers plain language and continuations but leaves definitions and mechanics separate',()=>{
  for(const q of ['查一下大龙整体均次','密银给谁','热门阵容有哪些','阿狸出装','按前四率排','大树最佳阵容和三件装备是什么？','按当前条件最佳三件套是什么？','查一下羁绊统计'])assert.equal(isStatisticsRequest(q,{view:'comps'}),true);
  for(const q of ['什么是吃分','羊刀怎么合成','法杖出现条件','连败奖励有多少'])assert.equal(isStatisticsRequest(q,{view:'explorer'}),false);
  assert.equal(isStatisticsRequest('再加一个无尽',{queryState:{view:'filter'}}),true);
});
test('validation never silently drops unsupported predicates, bad IDs, duplicate quantities or invalid limits',()=>{
  for(const query of [{view:'champions',conditions:[]},{view:'comps',itemId:silver.id},{view:'builds',championId:dragon.id,requiredItemIds:[ie.id,ie.id]},
    {view:'holders',itemId:'invented'},{view:'filter',conditions:[{type:'champion',id:dragon.id,exclude:true}]},
    {view:'filter',conditions:[{type:'item',id:silver.id,holderId:dragon.id}]},{view:'items',minSample:-1},{view:'comps',limit:11},
    {view:'filter',conditions:[{type:'trait',id:catalog.traits[0].id}]}
  ])assert.throws(()=>validateStatisticsQuery(query,catalog));
  const q=validateStatisticsQuery({view:'filter',conditions:[{type:'champion',id:dragon.id},{type:'item',id:ie.id,holderId:dragon.id},{type:'item',id:ie.id,holderId:dragon.id}]},catalog);
  assert.equal(q.conditions.length,3);
});
test('overall champion question uses overall rows, not strongest build, even while unrelated filter is open',async()=>{
  let overallCalls=0;
  const agent=await make({getExplorerSnapshot:async tab=>{overallCalls++;assert.equal(tab,'units');return {status:'cached',rows:[unit(dragon,7000,4.4)],evidence:source};},getChampionBuild:()=>assert.fail('must not read builds')},
    {pageContext:{view:'explorer',research:{conditions:[{type:'champion',id:ahri.id}]}}});
  const result=await agent.run('query_tft_stats',{view:'champions',championId:dragon.id,minSample:0});
  assert.equal(overallCalls,1);assert.equal(result.data[0].stats.avgPlacement,4.4);assert.equal(result.data[0].stats.sampleSize,7000);
  assert.match(agent.result.evidence[0].title,/MetaTFT.*棋子整体/);assert.equal(agent.result.evidence[0].sourcePatch,null);
});
test('comps honors specified sample threshold, sort and limit, preserves cluster scope and template names',async()=>{
  const data=[{id:'small',name:'small',units:[],stats:stats(99,1)},...Array.from({length:5},(_,i)=>({id:String(i),name:`体系${i}`,units:[{id:dragon.id,items:[silver.id]}],stats:stats(1000+i,5-i),evidence:{...source,source:'MetaTFT Comps',statisticsKind:'comp_cluster'}}))];
  const agent=await make({getMetaDecks:async()=>({status:'live',data,evidence:{...source,source:'MetaTFT Comps'}})});
  const result=await agent.run('query_tft_stats',{view:'comps',minSample:1000,sort:'avgPlacement',limit:2});
  assert.deepEqual(result.data.map(r=>r.id),['4','3']);assert.equal(result.data[0].units[0].items[0].name,'密银黎明');assert.match(result.note,/体系/);
});
test('items and holders use distinct services and sort before slicing',async()=>{
  let seen=[];const agent=await make({getExplorerSnapshot:async tab=>{seen.push(tab);return {status:'cached',rows:[{id:silver.id,itemId:silver.id,name:silver.name,itemCategory:'artifact',stats:stats(5000,4.2)}],evidence:source};},
    getItemHolders:async id=>{seen.push(id);return {status:'live',data:[unit(ahri,2000,4.3),unit(dragon,6000,3.4)],evidence:source};}});
  const item=await agent.run('query_tft_stats',{view:'items',itemId:silver.id,minSample:0});assert.equal(item.data[0].stats.sampleSize,5000);
  const holders=await agent.run('query_tft_stats',{view:'holders',itemId:silver.id,limit:1});assert.equal(holders.data[0].championId,dragon.id);
  assert.deepEqual(seen,['equipment',silver.id]);
});
test('trait statistics preserve activation tiers and never aggregate separate tiers into one population',async()=>{
  const trait=catalog.traits[0];
  const rows=[{id:'a',traitId:trait.id,name:trait.name,threshold:2,tier:1,stats:stats(12000,4.5)},{id:'b',traitId:trait.id,name:trait.name,threshold:4,tier:2,stats:stats(2000,3.8)}];
  const agent=await make({getExplorerSnapshot:async tab=>{assert.equal(tab,'traits');return {status:'cached',rows,evidence:source};}});
  const result=await agent.run('query_tft_stats',{view:'traits',traitId:trait.id,threshold:4,minSample:1000});
  assert.equal(result.data.length,1);assert.equal(result.data[0].threshold,4);assert.equal(result.data[0].stats.sampleSize,2000);assert.match(agent.result.evidence[0].title,/羁绊档位/);
  assert.equal((await agent.run('query_tft_stats',{view:'traits',search:trait.name,minSample:0})).data.length,2);
  for(const query of [{view:'traits',threshold:0},{view:'traits',traitId:'unknown'},{view:'traits',championId:dragon.id}])assert.throws(()=>validateStatisticsQuery(query,catalog));
});
test('followup search names and current page selections supply catalog IDs without trusting arbitrary IDs',async()=>{
  const agent=await make({}, {pageContext:{view:'stats',entityId:silver.id,queryState:{view:'items',search:silver.name},explorer:{selectedRow:{championId:dragon.id,itemId:'invented'}}}});
  const context=JSON.parse(agent.messages[1].content.split('：').slice(1).join('：'));
  assert.equal(context.previousEntities[0].id,silver.id);assert.equal(context.previousEntities[0].type,'item');
  assert.equal(context.pageEntity.type,'item');assert.deepEqual(context.pageSelection,[{type:'champion',id:dragon.id,name:dragon.name}]);
});
test('builds preserves fixed/excluded equipment without fabricating results',async()=>{
  const agent=await make({getConditionalChampionBuild:async query=>{assert.equal(query.championId,ahri.id);assert.deepEqual(query.requiredItemIds,[silver.id]);assert.deepEqual(query.excludedItemIds,[ie.id]);return {status:'empty',data:[],evidence:source};}});
  const result=await agent.run('query_tft_stats',{view:'builds',championId:ahri.id,requiredItemIds:[silver.id],excludedItemIds:[ie.id]});assert.equal(result.status,'empty');assert.deepEqual(result.data,[]);
});
test('filter forwards exact full conditions and carrier to common service, preserves zero and holder semantics',async()=>{
  const conditions=[{type:'champion',id:dragon.id},{type:'champion',id:ahri.id},{type:'item',id:silver.id,holderId:dragon.id},{type:'item',id:ie.id,holderId:null}];
  const agent=await make({getResearchResults:async q=>{assert.deepEqual(q.conditions,conditions);assert.equal(q.dataSource,'metatft');assert.equal(q.minSample,700);return {status:'empty',stats:stats(0,null),evidence:source,coverage:{matchedSamples:0},equipment:{status:'empty',rows:[]},teammates:{status:'empty',kind:'joint_teammates',rows:[]},comps:{status:'empty',rows:[]}};}});
  const result=await agent.run('query_tft_stats',{view:'filter',conditions,carrierId:dragon.id,minSample:700});
  assert.equal(result.status,'empty');assert.equal(result.stats.sampleSize,0);assert.equal(result.teammates.kind,'joint_teammates');
  assert.deepEqual(agent.result.queryState.conditions,conditions);assert.equal(agent.result.suggestedActions[0].type,'open_query');
});
test('a unique equipment holder determines the default build target regardless of condition order, with explicit overrides preserved',()=>{
  const conditions=[{type:'champion',id:ahri.id},{type:'champion',id:dragon.id},{type:'item',id:ie.id,holderId:dragon.id}];
  for(const input of [conditions,[...conditions].reverse()])assert.equal(validateStatisticsQuery({view:'filter',conditions:input,resultView:'equipment'},catalog).carrierId,dragon.id);
  assert.equal(validateStatisticsQuery({view:'filter',conditions,resultView:'equipment',carrierId:ahri.id},catalog).carrierId,ahri.id);
  assert.throws(()=>validateStatisticsQuery({view:'filter',conditions:conditions.slice(0,2),resultView:'equipment'},catalog),/查看谁/);
});
test('low sample and actual absence are different; service failure does not query a fallback source',async()=>{
  let reads=0;const agent=await make({getExplorerSnapshot:async()=>({status:'cached',rows:[unit(dragon,10,2)],evidence:source}),getChampionBuild:()=>assert.fail('fallback')});
  assert.equal((await agent.run('query_tft_stats',{view:'champions',championId:dragon.id,minSample:100})).status,'insufficient_samples');
  assert.equal((await agent.run('query_tft_stats',{view:'champions',championId:ahri.id})).status,'empty');
  const broken=await make({getExplorerSnapshot:async()=>{reads++;throw Error('来源不可用');}});
  await assert.rejects(broken.run('query_tft_stats',{view:'items'}),/来源不可用/);assert.equal(reads,1);
});
test('previous query is validated as context, never overrides the model full query; old pages without state still work',async()=>{
  const previous={view:'filter',conditions:[{type:'champion',id:ahri.id}],sort:'sampleSize',minSample:500,limit:2};
  const agent=await make({}, {pageContext:{queryState:previous}});const context=agent.messages[1].content;assert.ok(context.includes('"previousQuery":{"view":"filter"'));
  const invalidPrevious=await make({}, {pageContext:{queryState:{view:'filter',conditions:[{type:'champion',id:'fake'}]}}});assert.match(invalidPrevious.messages[1].content,/"previousQuery":null/);
});
test('real chat orchestration gives model the query tools and returns server-verified query state, without provider or embedding calls',async()=>{
  let calls=0;
  const result=await answerChat(body,{queryAgentEnabled:true,getCatalog:async()=>catalog,getExplorerSnapshot:async()=>({status:'cached',rows:[unit(dragon,9999,4.45)],evidence:source}),
    chatCompletion:async(messages,tools)=>{
      calls++;if(calls===1){assert.deepEqual(tools.map(t=>t.function.name),['search_glossary','search_catalog','clarify_query','query_tft_stats']);return {message:{role:'assistant',tool_calls:[{id:'query',type:'function',function:{name:'query_tft_stats',arguments:JSON.stringify({view:'champions',championId:dragon.id,minSample:0})}}]}};}
      const output=JSON.parse(messages.at(-1).content);assert.equal(output.data[0].stats.sampleSize,9999);assert.equal(output.data[0].citation,'[S1]');return {message:{role:'assistant',content:'大龙整体均次4.45，样本9999。[S1]'}};
    }});
  assert.equal(calls,2);assert.equal(result.answerMode,'natural_language_statistics');assert.equal(result.queryState.view,'champions');assert.equal(result.evidence[0].source,'MetaTFT Explorer');
});
test('a skipped query is retried and displayed sample decisions come from current tool data, not generated prose',async()=>{
  let calls=0,reads=0;
  const result=await answerChat({...body,messages:[{role:'user',content:'门槛改为1000'}]}, {queryAgentEnabled:true,getCatalog:async()=>catalog,
    getExplorerSnapshot:async()=>{reads++;return {status:'cached',rows:[unit(dragon,470,2.95)],evidence:source};},
    chatCompletion:async()=>{
      calls++;if(calls===2)return {message:{role:'assistant',tool_calls:[{id:'query',type:'function',function:{name:'query_tft_stats',arguments:JSON.stringify({view:'champions',championId:dragon.id,minSample:1000})}}]}};
      return {message:{role:'assistant',content:'470份样本符合1000门槛，均次2.951。'}};
    }});
  assert.equal(calls,3);assert.equal(reads,1);assert.match(result.reply,/没有达到指定样本门槛/);assert.doesNotMatch(result.reply,/470|2\.951/);
});
test('statistics requests cannot return unqueried historical numbers even when the model repeatedly ignores tools',async()=>{
  let calls=0;
  await assert.rejects(answerChat(body,{queryAgentEnabled:true,getCatalog:async()=>catalog,chatCompletion:async()=>{calls++;return {message:{role:'assistant',content:'历史样本12345均次1.2'}};}}),{code:'AI_TOOL_BUDGET'});
  assert.equal(calls,8);
});
test('ambiguous queries use an explicit clarification decision without inventing a query or a statistic',async()=>{
  let calls=0;
  const result=await answerChat(body,{queryAgentEnabled:true,getCatalog:async()=>catalog,chatCompletion:async()=>{
    calls++;return calls===1?{message:{role:'assistant',tool_calls:[{id:'clarify',type:'function',function:{name:'clarify_query',arguments:JSON.stringify({question:'你指的是哪一件装备？'})}}]}}:{message:{role:'assistant',content:'捏造的装备均次1.2'}};
  }});
  assert.equal(result.reply,'你指的是哪一件装备？');assert.equal(result.queryState,null);assert.deepEqual(result.evidence,[]);
});
