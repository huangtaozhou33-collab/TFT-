import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {CHAT_PROVIDERS,EMBEDDING_PROVIDERS,providerPreset,modelCapabilities} from './model-providers.mjs';
const file=new URL('../runtime/model-settings.json',import.meta.url);
export function modelSettings(){try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw new Error('Model settings could not be read.');}}
export function validateSelection(body){
 if(!body||!['chat','embedding'].includes(body.target))throw Object.assign(new Error('target must be chat or embedding'),{status:400});
 const presets=body.target==='chat'?CHAT_PROVIDERS:EMBEDDING_PROVIDERS;
 if(!Object.hasOwn(presets,body.provider)||body.provider==='compatible')throw Object.assign(new Error('Switching requires a named provider; custom endpoints use configuration files.'),{status:400});
 const preset=providerPreset(presets,body.provider),model=body.model||preset.model;
 if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))throw Object.assign(new Error('Invalid model ID'),{status:400});
 const value={provider:body.provider,model};
 if(body.target==='chat'&&body.inference){
  const caps=modelCapabilities(body.provider,model),i=body.inference;
  const bad=()=>{throw Object.assign(new Error('模型不支持该参数，或数值超出允许范围。'),{status:400});};
  if(Object.keys(i).some(k=>!['thinking','reasoningEffort','thinkingBudget','maxTokens','maxToolCalls','maxRounds'].includes(k)))bad();
  value.inference={};
  if(i.thinking!==undefined){if(!['enabled','disabled'].includes(i.thinking)||caps.thinking==='unsupported'||caps.thinking==='required'&&i.thinking!=='enabled')bad();value.inference.thinking=i.thinking;}
  if(i.reasoningEffort!==undefined){if(!caps.efforts.includes(i.reasoningEffort))bad();value.inference.reasoningEffort=i.reasoningEffort;}
  for(const [key,min,max] of [['maxTokens',1024,32768],['thinkingBudget',1024,32768],['maxToolCalls',1,32],['maxRounds',2,16]]){
   if(i[key]===undefined)continue;if(!Number.isInteger(i[key])||i[key]<min||i[key]>max||key==='thinkingBudget'&&!caps.budget)bad();value.inference[key]=i[key];
  }
  if(body.provider==='anthropic'&&caps.budget&&(i.thinkingBudget||4096)>=(i.maxTokens||8192))bad();
 }
 if(body.target==='embedding'){
  value.dimensions=body.dimensions??preset.dimensions;
  if(!Number.isInteger(value.dimensions)||value.dimensions<1||value.dimensions>32768)throw Object.assign(new Error('Invalid embedding dimensions'),{status:400});
 }
 return value;
}
let pending=Promise.resolve();
export function saveModelSelection(body){
 const value=validateSelection(body);
 const run=async()=>{const settings={...modelSettings(),[body.target]:value};await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});const temp=new URL(`../runtime/model-settings.${randomUUID()}.tmp`,import.meta.url);await writeFile(temp,JSON.stringify(settings),{mode:0o600});await rename(temp,file);return settings;};
 const result=pending.then(run);pending=result.catch(()=>{});return result;
}
