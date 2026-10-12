export const CHAT_PROVIDERS={
 deepseek:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},
 qwen:{baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus'},
 openai:{baseUrl:'https://api.openai.com/v1',model:'gpt-4.1'},
 anthropic:{baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-4-6'},
 kimi:{baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k2.5'},
 compatible:{baseUrl:'',model:''}
};
export const MODEL_OPTIONS={deepseek:['deepseek-flash','deepseek-pro'],qwen:['qwen-plus','qwen3.8-max'],openai:['gpt-4.1','gpt-4.1-mini','gpt-5'],anthropic:['claude-sonnet-4-6','claude-opus-4-6','claude-sonnet-4-5'],kimi:['kimi-k2.5'],compatible:[]};
export function modelCapabilities(provider,model){
 const common={thinking:'unsupported',efforts:[],budget:false,maxTokens:{min:1024,max:32768}};
 if(provider==='deepseek'&&MODEL_OPTIONS.deepseek.includes(model))return {...common,thinking:'toggle',efforts:['low','high','max']};
 if(provider==='qwen'&&MODEL_OPTIONS.qwen.includes(model))return {...common,thinking:'toggle',budget:true};
 if(provider==='kimi'&&model==='kimi-k2.5')return {...common,thinking:'toggle'};
 if(provider==='openai'&&model==='gpt-5')return {...common,thinking:'required',efforts:['low','medium','high']};
 if(provider==='anthropic'&&/claude-(sonnet|opus)-4-6$/.test(model))return {...common,thinking:'toggle',efforts:['low','medium','high',...(model==='claude-opus-4-6'?['max']:[])]};
 if(provider==='anthropic'&&model==='claude-sonnet-4-5')return {...common,thinking:'toggle',budget:true};
 return common;
}
export const EMBEDDING_PROVIDERS={
 openai:{baseUrl:'https://api.openai.com/v1',model:'text-embedding-3-small',dimensions:1536},
 qwen:{baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'text-embedding-v4',dimensions:1024},
 compatible:{baseUrl:'',model:'',dimensions:0}
};
export function providerPreset(providers,name){
 if(!Object.hasOwn(providers,name))throw new Error(`Unsupported provider: ${name}`);
 return providers[name];
}
export function buildCompletion(config,messages,tools){
 const p=config.provider||'deepseek',caps=modelCapabilities(p,config.model),s={...config.inference};
 if(caps.thinking==='required')s.thinking='enabled';
 if(caps.efforts.length&&!caps.efforts.includes(s.reasoningEffort))s.reasoningEffort='high';
 if(p==='anthropic'){
  const body={model:config.model,max_tokens:s.maxTokens,stream:false,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n'),messages:[]};
  for(const m of messages){
   if(m.role==='system')continue;
   let role=m.role==='tool'?'user':m.role;
   let content=m.role==='tool'?[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]:m.anthropic_content||[
    ...(m.content?[{type:'text',text:m.content}]:[]),
    ...(m.tool_calls||[]).map(t=>({type:'tool_use',id:t.id,name:t.function.name,input:JSON.parse(t.function.arguments)}))];
   if(body.messages.at(-1)?.role===role)body.messages.at(-1).content.push(...content);
   else body.messages.push({role,content});
  }
  if(s.thinking==='enabled'){
   if(/claude-(sonnet|opus)-4-6$/.test(config.model)){body.thinking={type:'adaptive'};body.output_config={effort:s.reasoningEffort==='max'&&config.model!=='claude-opus-4-6'?'high':s.reasoningEffort};}
   else body.thinking={type:'enabled',budget_tokens:Math.min(s.thinkingBudget||4096,s.maxTokens-1)};
  }
  if(body.thinking?.budget_tokens<1024)throw new Error('Claude thinking requires AI_MAX_TOKENS greater than 1024.');
  if(tools?.length)body.tools=tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}));
  return body;
 }
 const body={model:config.model,messages:messages.map(({anthropic_content,...m})=>m),max_tokens:s.maxTokens,stream:false};
 if(p==='deepseek'){body.thinking={type:s.thinking};if(s.thinking==='enabled')body.reasoning_effort=s.reasoningEffort;}
 if(p==='qwen'){body.enable_thinking=s.thinking==='enabled';if(body.enable_thinking){body.thinking_budget=s.thinkingBudget||4096;body.stream=true;body.stream_options={include_usage:true};}}
 if(p==='kimi'&&/^kimi-k2\.5/.test(config.model))body.thinking={type:s.thinking};
 if(p==='openai'){
  body.max_completion_tokens=s.maxTokens;delete body.max_tokens;
  // Non-reasoning GPT models do not accept reasoning_effort.
  if(/^(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(config.model)&&s.thinking==='enabled')body.reasoning_effort=s.reasoningEffort==='max'?'high':s.reasoningEffort;
 }
 if(tools?.length)body.tools=tools;
 return body;
}
export function normalizeCompletion(result,provider){
 if(provider!=='anthropic')return result;
 const blocks=result.content||[];
 return {choices:[{finish_reason:result.stop_reason==='max_tokens'?'length':result.stop_reason,message:{role:'assistant',
  content:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),
  anthropic_content:blocks,
  tool_calls:blocks.filter(b=>b.type==='tool_use').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}}))}}],
  usage:result.usage?{prompt_tokens:result.usage.input_tokens,completion_tokens:result.usage.output_tokens,total_tokens:result.usage.input_tokens+result.usage.output_tokens}:null};
}
