import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompletionStream} from '../server/completion-stream.mjs';
import {validateSelection} from '../server/model-settings.mjs';
test('SSE joins fragmented UTF-8 and tool arguments with usage',async()=>{
 const events=[{choices:[{delta:{reasoning_content:'查询',tool_calls:[{index:0,id:'c1',function:{name:'query',arguments:'{"id":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"装备"}'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{total_tokens:42}}];
 const bytes=new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n');
 const response=new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}));
 const result=await readCompletionStream(response);assert.equal(result.choices[0].message.reasoning_content,'查询');assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{id:'装备'});assert.equal(result.usage.total_tokens,42);
});
test('incomplete SSE cannot masquerade as successful response',async()=>{await assert.rejects(readCompletionStream(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n')),/Incomplete/);});
test('capabilities enforce GPT and Claude thinking constraints',()=>{
 assert.throws(()=>validateSelection({target:'chat',provider:'openai',model:'gpt-4.1',inference:{reasoningEffort:'high'}}));
 assert.throws(()=>validateSelection({target:'chat',provider:'openai',model:'gpt-5',inference:{thinking:'disabled'}}));
 assert.throws(()=>validateSelection({target:'chat',provider:'anthropic',model:'claude-sonnet-4-5',inference:{thinkingBudget:8192,maxTokens:4096}}));
});
