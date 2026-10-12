const KEY='tft.atelier.language.v1';
let language='zh-CN';try{language=localStorage.getItem(KEY)==='en-US'?'en-US':'zh-CN';}catch{}
let dictionary={},matcher=null,cache=new Map(),sourceTranslations=new Map();
export const hasSourceTranslation=text=>sourceTranslations.has(String(text||'').replace(/\\n/g,'\n').replace(/\\r/g,'').trim());
export const getLanguage=()=>language;
export const englishText=text=>dictionary[text]||text;
export function translate(text){
 if(typeof text==='string'&&language==='zh-CN')return sourceTranslations.has(text.trim())?text.replace(text.trim(),()=>sourceTranslations.get(text.trim())):text;
 if(language!=='en-US'||typeof text!=='string'||!/[\u3400-\u9fff]/u.test(text))return text;
 if(cache.has(text))return cache.get(text);
 const trimmed=text.trim();let result=dictionary[trimmed];
 if(result)result=text.replace(trimmed,result);
 else {
  const detail=/^查看(.+)统计详情$/.exec(trimmed),comp=/^查看(.+)的队员、装备、站位与统计$/.exec(trimmed);
  if(detail)result=`View ${translate(detail[1])} statistics`;
  else if(comp)result=`View ${translate(comp[1])}: roster, items, positioning and statistics`;
  else result=matcher?text.replace(/(^|[ ·])([洛霞慎蔚易])(?= ·|$)/g,(_,prefix,name)=>prefix+(dictionary[name]||name)).replace(/第 (\d+) 列 · 第 (\d+) 排，空格/g,'Column $1 · Row $2, empty').replace(/第 (\d+) 排/g,'Row $1').replace(/棋盘 · (\d+) 人上场 \/ (\d+) 人记录/g,'Board · $1 placed / $2 recorded').replace(/已保存 (\d+) 份/g,'$1 saved').replace(matcher,key=>' '+dictionary[key]+' ').replace(/ +/g,' ').replace(/(\d+)\s*条/g,'$1 records').replace(/(\d+)\s*费/g,'$1 cost').replace(/(\d+)\s*页/g,'$1 pages').replace(/(\d+)\s*篇/g,'$1 articles').replace(/(\d+)\s*件/g,'$1 items').trim():text;
 }
 cache.set(text,result);return result;
}
export async function initLanguage(){
 try {const response=await fetch('/locales/item-descriptions.json');if(response.ok){const data=await response.json();sourceTranslations=new Map(data.entries.map(entry=>[entry.source.replace(/\\n/g,'\n').replace(/\\r/g,'').trim(),entry.zh]));}}catch{console.warn('Item translations could not be loaded; retaining original descriptions.');}
 try { const response=await fetch('/locales/en-US.json');if(response.ok){dictionary=await response.json();const terms=Object.keys(dictionary).filter(k=>k.length>1&&k.length<100).sort((a,b)=>b.length-a.length);matcher=new RegExp(terms.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gu');} } catch { console.warn('Interface translation could not be loaded; retaining source labels.'); }
 const original=new WeakMap(),attributes=new WeakMap();let observer;
 function visit(root){
  const nodes=[];if(root.nodeType===Node.TEXT_NODE)nodes.push(root);else{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(walker.nextNode())nodes.push(walker.currentNode);}
  for(const text of nodes){if(!text.parentElement||text.parentElement.closest('script,style,textarea,pre,code,[data-no-translate],.patch-rich-content,.chat-message.user,.markdown-content,.planner-note-editor'))continue;
   const previous=original.get(text);const source=previous&&text.data===previous.rendered?previous.source:text.data;const rendered=translate(source);original.set(text,{source,rendered});if(text.data!==rendered)text.data=rendered;
  }
  const elements=root.nodeType===1?[root,...root.querySelectorAll('[title],[placeholder],[aria-label]')]:[];
  for(const element of elements){if(element.closest('[data-no-translate]'))continue;let saved=attributes.get(element)||{};
   for(const attr of ['title','placeholder','aria-label']){const value=element.getAttribute(attr);if(!value)continue;const old=saved[attr];const source=old&&old.rendered===value?old.source:value;const rendered=translate(source);saved[attr]={source,rendered};if(value!==rendered)element.setAttribute(attr,rendered);}attributes.set(element,saved);
  }
 }
 function apply(){observer?.disconnect();document.documentElement.lang=language;document.title=language==='en-US'?'TFT Atelier V4 · TFT Research':'TFT Atelier V4 · 云顶资料库';visit(document.body);document.querySelectorAll('[data-language]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.language===language)));observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label']});}
 observer=new MutationObserver(records=>{observer.disconnect();for(const r of records){if(r.type==='childList'){for(const n of r.addedNodes)visit(n);}else visit(r.target);}observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label']});});
 document.querySelectorAll('[data-language]').forEach(b=>b.addEventListener('click',()=>{if(language===b.dataset.language)return;language=b.dataset.language;cache.clear();try{localStorage.setItem(KEY,language);}catch{}apply();window.dispatchEvent(new CustomEvent('languagechange',{detail:language}));}));
 apply();
}
