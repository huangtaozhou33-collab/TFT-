import {Converter} from 'opencc-js';
const simplified=Converter({from:'tw',to:'cn'});
export const textOf=n=>n.type==='text'?n.text:(n.children||[]).map(c=>(['ul','ol'].includes(c.tag)?'\n':'')+textOf(c)).join(n.tag==='ul'||n.tag==='ol'?'\n':'');
const norm=s=>s.toLowerCase().replace(/[’‘]/g,"'").replace(/'s\b/g,'').replace(/[「」“”]/g,'').replace(/\s+/g,' ').trim();
function categoryFor(s){
 if(/單位|单位|英雄|units|champions/i.test(s))return 'champions';
 if(/增幅|強化|强化|augments/i.test(s))return 'augments';
 if(/特性|羈絆|羁绊|traits/i.test(s))return 'traits';
 if(/道具|裝備|装备|徽章|items|emblems|artifacts|radiant/i.test(s))return 'items';
 if(/神火|法杖|wisps|charms/i.test(s))return 'wisps';
 return null;
}
export function patchCards(article,index){
 const groups=Object.fromEntries(['champions','items','traits','augments','wisps'].map(k=>[k,[]]));
 let category=null,section='',batch='';
 const candidates=index.entities.flatMap(e=>[...Object.values(e.names),...(e.aliases||[])].filter(Boolean).map(name=>({e,name,key:norm(name)}))).sort((a,b)=>b.key.length-a.key.length);
 function match(text,cat){
  const s=norm(text),matches=candidates.filter(x=>x.e.category===cat&&(s===x.key||s.startsWith(x.key)&&(!/[a-z]/i.test(s[x.key.length]||'')||/^(cost|hp|ad|ap|mana|damage|attack)/.test(s.slice(x.key.length)))));
  if(!matches.length)return null;
  const longest=matches.filter(x=>x.key.length===matches[0].key.length);
  if(new Set(longest.map(x=>x.e.id)).size===1)return longest[0];
  if(cat==='wisps'&&longest.every(x=>x.e.familyId)&&new Set(longest.map(x=>x.e.familyId)).size===1)return longest.find(x=>x.e.variant==='base')||null;
  return null;
 }
 function emit(li,parent=''){
    const text=textOf(li).trim();if(!text)return;
    const heading=(li.children||[]).filter(c=>!['ul','ol'].includes(c.tag)).map(textOf).join('').trim();
    const found=match(heading,category)||parent.split(' · ').reverse().map(label=>match(label,category)).find(Boolean),entity=found?.e;
    const nested=(li.children||[]).filter(c=>['ul','ol'].includes(c.tag));
    if(!entity&&nested.length&&!/[：:]|⇒/.test(heading)){
     const childItems=nested.flatMap(n=>n.children||[]).filter(c=>c.tag==='li');
     if(childItems.length){for(const child of childItems)emit(child,[parent,heading].filter(Boolean).join(' · '));return;}
    }
    let body=entity&&nested.length?nested.map(textOf).join('\n').trim():text;
    if(parent)body=parent+'\n'+body;
    if(entity&&article.locale!=='en-us'&&found.name)body=body.replace(found.name,entity.names.zh_cn);
    groups[category].push({entityId:entity?.id||null,icon:entity?.icon||null,matchStatus:entity?'matched':'unresolved',name:entity?(article.locale==='en-us'?entity.names.en_us:entity.names.zh_cn):simplified(heading||text),originalName:heading,body:article.locale==='en-us'?body:simplified(body),section:article.locale==='en-us'?section:simplified(section),batch:article.locale==='en-us'?batch:simplified(batch)});
 }
 function walk(n){
  if(/^h[2-6]$/.test(n.tag)){
   const t=textOf(n).trim();if(n.tag==='h2'){batch=t;category=null;}
   section=t;category=categoryFor(t);return;
  }
  if((n.tag==='ul'||n.tag==='ol')&&category){
   for(const li of n.children||[])if(li.tag==='li')emit(li);return;
  }
  for(const c of n.children||[])walk(c);
 }
 for(const n of article.content||[])walk(n);
 return groups;
}
export function simplifiedArticle(article){
 return {title:simplified(article.title||''),summary:simplified(article.summary||''),body:simplified(article.body||'')};
}
