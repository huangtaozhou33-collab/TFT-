import test from 'node:test';
import assert from 'node:assert/strict';
import {inferenceSettings} from '../server/env.mjs';
import {completionBody} from '../server/ai.mjs';
import {answerChat} from '../server/chat.mjs';
import {prepareQueryAgent,validateStatisticsQuery} from '../server/query-agent.mjs';
const settings=inferenceSettings(()=> '');
const catalog={champions:[{id:'low',name:'低费核心',cost:1},{id:'mid',name:'二费核心',cost:2},{id:'high',name:'高费核心',cost:5}],items:[],traits:[]};
const body={messages:[{role:'user',content:'低费赌狗推荐阵容'}],pageContext:{view:'comps',rank:'ALL',readonly:true}};
const stats=n=>({sampleSize:n,avgPlacement:4,top4Rate:.5,winRate:.1});
const decks={status:'live',data:[
 {id:'high',name:'高费带低费挂件',units:[{id:'high',isCore:true},{id:'low',isCore:false}],stats:stats(99999)},
 {id:'unknown',name:'未标核心',units:[{id:'low'}],stats:stats(88888)},
 {id:'one',name:'一费体系',units:[{id:'low',isCore:true}],stats:stats(3000)},
 {id:'two',name:'二费体系',units:[{id:'mid',isCore:true}],stats:stats(2000)}]};
test('thinking defaults, disabled request and invalid hyperparameters',()=>{
 assert.equal(settings.thinking,'enabled');assert.equal(settings.reasoningEffort,'high');
 const b=completionBody({model:'fake',inference:settings},[],[]);
 assert.deepEqual(b.thinking,{type:'enabled'});assert.equal(b.reasoning_effort,'high');assert.equal(b.max_tokens,8192);assert.equal(b.temperature,undefined);
 assert.equal(completionBody({model:'fake',inference:{...settings,thinking:'disabled'}},[]).reasoning_effort,undefined);
 for(const [k,v] of [['AI_THINKING','yes'],['AI_MAX_ROUNDS','1'],['AI_MAX_TOOL_CALLS','0'],['AI_MAX_TOKENS','NaN'],['AI_REASONING_EFFORT','extreme']])assert.throws(()=>inferenceSettings(key=>key===k?v:''));
});
test('cost filters use source core flags, not low-cost passengers; filter before limit and sort',async()=>{
 const a=await prepareQueryAgent({body,catalog,history:body.messages,draft:{version:0}}, {getMetaDecks:async()=>decks});
 assert.match(a.messages[1].content,/追核心单位三星/);
 assert.ok((await a.run('search_glossary',{query:'赌狗'})).entries.length);
 const r=await a.run('query_tft_stats',{view:'comps',coreCosts:[1,2],sort:'sampleSize',limit:1});
 assert.equal(r.selection.matchedRows,2);assert.equal(r.data[0].id,'one');assert.equal(r.data[0].units[0].cost,1);
 assert.equal((await a.run('query_tft_stats',{view:'comps',coreCosts:[2]})).data[0].id,'two');
 assert.equal((await a.run('query_tft_stats',{view:'comps',coreCosts:[3]})).status,'empty');
 for(const coreCosts of [[],[0],[1,1],['1'],[6]])assert.throws(()=>validateStatisticsQuery({view:'comps',coreCosts},catalog));
});
test('thinking survives more than four tool calls; aggregate usage without disclosing reasoning',async()=>{
 let calls=0;
 const result=await answerChat(body,{queryAgentEnabled:true,getCatalog:async()=>catalog,getMetaDecks:async()=>decks,inferenceSettings:settings,
  chatCompletion:async(messages,tools)=>{
   calls++;
   if(calls>1)assert.equal(messages.filter(m=>m.role==='assistant').at(-1).reasoning_content,`private-${calls-1}`);
   return {usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},message:{role:'assistant',reasoning_content:`private-${calls}`,
    ...(calls<=5?{tool_calls:[{id:String(calls),type:'function',function:{name:calls<5?'search_catalog':'query_tft_stats',arguments:JSON.stringify(calls<5?{query:'核心'}:{view:'comps',coreCosts:[1,2]})}}]}:{content:'数字由服务端输出'})}};
  }});
 assert.equal(result.execution.modelCalls,6);assert.equal(result.execution.toolCalls,5);assert.equal(result.execution.reasoningObserved,true);
 assert.equal(result.usage.total_tokens,180);assert.doesNotMatch(JSON.stringify(result),/private-/);assert.match(result.reply,/1\/2 费来源核心/);
});
test('configured tool budget prevents extra service reads',async()=>{
 let rounds=0,reads=0;
 const result=await answerChat(body,{queryAgentEnabled:true,getCatalog:async()=>catalog,getMetaDecks:async()=>{reads++;return decks;},inferenceSettings:{...settings,maxToolCalls:1},
 chatCompletion:async()=>({message:++rounds===1?{tool_calls:[1,2].map(i=>({id:String(i),type:'function',function:{name:'query_tft_stats',arguments:'{"view":"comps"}'}}))}:{content:'完成'}})});
 assert.equal(reads,1);assert.match(result.reply,/查询未完成/);
});
