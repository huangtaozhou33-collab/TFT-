import { parseFragment } from 'parse5';

const tags=new Set(['p','h2','h3','h4','h5','h6','ul','ol','li','blockquote','strong','b','em','i','br','hr','a','table','thead','tbody','tr','th','td','figure','figcaption']);
const blocked=new Set(['script','style','iframe','svg','object','embed','form','template']);
export function officialImage(value,alt='Riot 官方公告配图') {
 try {const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='cmsassets.rgpub.io'||u.username||u.password)return null;
 return {type:'image',src:u.href,alt:String(alt||'Riot 官方公告配图').slice(0,300)};}catch{return null;}
}
export function articleContent(html) {
 let remaining=10000;
 function walk(n,depth=0){
  if(--remaining<0||depth>40)return [];
  if(n.nodeName==='#text')return n.value?[{type:'text',text:n.value}]:[];
  if(blocked.has(n.tagName))return [];
  const attrs=Object.fromEntries((n.attrs||[]).map(a=>[a.name,a.value]));
  // Author portraits are attribution decoration, not patch change illustrations.
  if((attrs.class||'').split(/\s+/).includes('context-designers'))return [];
  if(n.tagName==='img'){const image=officialImage(attrs.src,attrs.alt);return image?[image]:[];}
  const children=(n.childNodes||[]).flatMap(c=>walk(c,depth+1));
  if(!tags.has(n.tagName))return children;
  const item={type:'element',tag:n.tagName,children};
  if(n.tagName==='a'){
   try{const u=new URL(attrs.href);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return children;item.href=u.href;}catch{return children;}
  }
  return [item];
 }
 return walk(parseFragment(html));
}
