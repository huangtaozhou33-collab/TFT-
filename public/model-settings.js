export async function openModelSettings({api,el,openModal,onSaved}){
 const data=await api('/api/models');
 const root=el('div',{class:'model-settings'}),status=el('p',{role:'status',class:'panel-footnote'});
 root.append(el('p',{text:'设置保存在当前服务，供后续问答使用。保存不会调用模型；连接测试可能产生费用。'}));
 const field=(label,input)=>el('label',{class:'model-setting-field'},el('span',{text:label}),input);
 const select=(label,values,value)=>el('select',{'aria-label':label},values.map(([id,name])=>el('option',{value:id,text:name,selected:id===value})));
 const names={deepseek:'DeepSeek',qwen:'千问 Qwen',openai:'GPT / OpenAI',anthropic:'Claude / Anthropic',kimi:'Kimi'};
 const provider=select('聊天提供商',[['','请选择提供商'],...Object.entries(names)],data.chat.provider),model=select('聊天模型',[],''),controls=el('div',{class:'model-setting-grid'});
 const inputs={};
 function render(){
  status.textContent='';controls.replaceChildren();for(const k of Object.keys(inputs))delete inputs[k];
  const c=data.capabilities[provider.value]?.[model.value],saved=data.chat.provider===provider.value&&data.chat.model===model.value?data.chat.inference:{};
  if(!c){controls.append(el('p',{text:'当前自定义模型尚未登记参数能力，请通过配置文件设置。'}));return;}
  if(c.thinking==='toggle'){inputs.thinking=select('思考模式',[['enabled','开启'],['disabled','关闭']],saved.thinking||'enabled');controls.append(field('思考模式',inputs.thinking));}
  if(c.thinking==='required')controls.append(el('p',{text:'此模型始终进行推理，通过推理强度调整。'}));
  if(c.thinking==='unsupported')controls.append(el('p',{text:'此模型不提供已适配的思考开关或深度参数。'}));
  if(c.efforts.length){inputs.reasoningEffort=select('推理强度',c.efforts.map(v=>[v,({low:'低',medium:'中',high:'高',max:'最高'})[v]]),c.efforts.includes(saved.reasoningEffort)?saved.reasoningEffort:'high');controls.append(field('推理强度',inputs.reasoningEffort));}
  for(const [key,label,min,max,fallback] of [...(c.budget?[['thinkingBudget','思考 Token 预算',1024,32768,4096]]:[]),['maxTokens','生成 Token 上限',1024,32768,8192],['maxToolCalls','最多工具调用次数',1,32,12],['maxRounds','最多查询轮数',2,16,8]]){
   const input=el('input',{type:'number','aria-label':label,min,max,value:saved[key]||fallback});inputs[key]=input;controls.append(field(label,input));
  }
  controls.append(el('p',{class:'panel-footnote',text:'Token 上限与推理参数的含义随模型不同；更高设置通常增加等待时间和费用。工具次数与查询轮数是本系统的规划限制。'}));
 }
 function models(){const options=[...(data.models[provider.value]||[])];if(data.chat.provider===provider.value&&!options.includes(data.chat.model))options.unshift(data.chat.model);model.replaceChildren(...options.map(id=>el('option',{value:id,text:id,selected:data.chat.provider===provider.value&&data.chat.model===id})));render();}
 provider.addEventListener('change',models);model.addEventListener('change',render);models();
 root.append(field('聊天提供商',provider),field('聊天模型',model),controls);
 const save=el('button',{class:'button primary',type:'button',text:'保存聊天设置',onclick:async()=>{
  save.disabled=true;
  try{const inference=Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.type==='number'?Number(input.value):input.value]));const result=await api('/api/models',{target:'chat',provider:provider.value,model:model.value,inference});data.chat=result.chat;status.textContent=result.chat.configured?'已保存，下次问答生效。尚未进行真实连接测试。':'已保存，但该提供商尚未配置 API Key，请在服务端配置后使用。';await onSaved?.();}catch(error){status.textContent=error.message;}finally{save.disabled=false;}
 }});root.append(save,status);
 const embedding=el('details',{},el('summary',{text:'Embedding 模型（知识检索）'}));
 const ep=select('Embedding 提供商',[['','请选择提供商'],['openai','OpenAI'],['qwen','千问 Qwen']],data.embedding.provider);
 const presets={openai:[['text-embedding-3-small',1536],['text-embedding-3-large',3072]],qwen:[['text-embedding-v4',1024],['text-embedding-v3',1024]]};
 const epreset=select('Embedding 模型预设',[],'' );
 const em=el('input',{'aria-label':'Embedding 模型',value:data.embedding.model}),dim=el('input',{type:'number','aria-label':'向量维度',min:1,max:32768,value:data.embedding.dimensions||1024});
 function embeddingOptions(){epreset.replaceChildren(el('option',{value:'',text:'自定义模型'}),...(presets[ep.value]||[]).map(([id])=>el('option',{value:id,text:id,selected:id===em.value})));}
 epreset.addEventListener('change',()=>{const preset=presets[ep.value]?.find(([id])=>id===epreset.value);if(preset){em.value=preset[0];dim.value=preset[1];}});
 ep.addEventListener('change',()=>{const preset=data.choices.embedding[ep.value];if(preset){em.value=preset.model;dim.value=preset.dimensions;}embeddingOptions();});embeddingOptions();
 embedding.append(el('p',{text:'与聊天模型独立。更改后需要匹配的新索引，不会自动付费重建。当前自定义配置保留，只有点击保存才切换。'}),field('Embedding 提供商',ep),field('Embedding 模型预设',epreset),field('Embedding 模型',em),field('向量维度',dim),el('button',{type:'button',class:'button secondary',text:'保存 Embedding 设置',onclick:async()=>{try{const r=await api('/api/models',{target:'embedding',provider:ep.value,model:em.value,dimensions:Number(dim.value)});status.textContent=r.indexAction+(r.embedding.configured?'':' 尚未配置该服务的 Embedding Key。');}catch(e){status.textContent=e.message;}}}));root.append(embedding);
 openModal('模型与思考设置',root);
}
