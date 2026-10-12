import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCompletion,normalizeCompletion} from '../server/model-providers.mjs';
import {validateSelection} from '../server/model-settings.mjs';
import {inferenceSettings} from '../server/env.mjs';
import {providerRequest} from '../server/ai.mjs';
const inference=inferenceSettings(()=>''),message=[{role:'user',content:'查询装备'}];
test('provider-specific thinking fields do not leak into other protocols',()=>{
 const build=provider=>buildCompletion({provider,model:'gpt-4.1',inference},message,[]);
 assert.equal(build('deepseek').thinking.type,'enabled');
 assert.equal(build('qwen').enable_thinking,true);
 assert.equal(build('qwen').thinking,undefined);
 assert.equal(build('openai').max_completion_tokens,8192);
 assert.equal(build('openai').reasoning_effort,undefined);
 assert.equal(build('compatible').thinking,undefined);
 assert.equal(buildCompletion({provider:'kimi',model:'kimi-k2.5',inference},message).thinking.type,'enabled');
});
test('Claude tool use round trip retains signed thinking and groups results',()=>{
 const blocks=[{type:'thinking',thinking:'test',signature:'signed-test'},{type:'tool_use',id:'tool_1',name:'query',input:{id:'abc'}}];
 const result=normalizeCompletion({content:blocks,stop_reason:'tool_use',usage:{input_tokens:5,output_tokens:3}},'anthropic');
 const body=buildCompletion({provider:'anthropic',model:'test',inference},[
 {role:'system',content:'rules'},...message,result.choices[0].message,{role:'tool',tool_call_id:'tool_1',content:'result'}
 ],[{type:'function',function:{name:'query',description:'query',parameters:{type:'object'}}}]);
 assert.equal(body.system,'rules');assert.deepEqual(body.messages[1].content,blocks);
 assert.equal(body.messages[2].content[0].tool_use_id,'tool_1');assert.equal(body.tools[0].input_schema.type,'object');
 assert.equal(result.usage.total_tokens,8);
});
test('switch validates provider and dimensions and does not store keys or endpoints',()=>{
 assert.throws(()=>validateSelection({target:'embedding',provider:'openai',dimensions:0}));
 assert.throws(()=>validateSelection({target:'chat',provider:'constructor'}));
 assert.throws(()=>validateSelection({target:'chat',provider:'compatible'}));
 assert.deepEqual(validateSelection({target:'chat',provider:'qwen',apiKey:'not-stored',baseUrl:'https://untrusted.test'}),{provider:'qwen',model:'qwen-plus'});
});
test('Claude authentication and messages endpoint use native headers',async()=>{
 const original=globalThis.fetch;let observed;
 globalThis.fetch=async(url,options)=>{observed={url,options};return new Response('{}');};
 try{await providerRequest('/messages',{}, {config:{provider:'anthropic',baseUrl:'https://api.anthropic.com/v1',key:'fake-key'}});
 assert.equal(observed.options.headers['x-api-key'],'fake-key');assert.equal(observed.options.headers.Authorization,undefined);
 assert.equal(observed.url.pathname,'/v1/messages');assert.equal(observed.options.redirect,'error');
 }finally{globalThis.fetch=original;}
});
