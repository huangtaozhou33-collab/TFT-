import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {cleanText} from './catalog-normalize.mjs';
const read=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url),'utf8'));
const ui=await read('public/locales/ui-en.json'),zh=await read('data/raw/cdragon-zh_cn.json'),en=await read('data/raw/cdragon-en_us.json');
const catalog=await read('data/catalog.json');const setOf=r=>r.setData.find(s=>s.number===catalog.context.set&&s.mutator===catalog.context.mutator);
const cnSet=setOf(zh),enSet=setOf(en),eng=new Map([...en.items,...enSet.champions,...enSet.traits].map(e=>[e.apiName,e]));
const output={};
function traitDescription(e){let i=0;const raw=e.desc.replace(/<row>([\s\S]*?)<\/row>/g,(_,r)=>{const effect=e.effects[i++]||{};return cleanText(r,{...effect.variables,MinUnits:effect.minUnits}).text+'\n';});return cleanText(raw,e.effects[0]?.variables).text;}
for(const e of cnSet.traits){const other=eng.get(e.apiName);if(other?.desc)output[traitDescription(e)]=traitDescription(other).replaceAll('〔数值未知〕','[value unknown]').replaceAll('〔字段未知〕','[unknown field]');}
for(const e of [...zh.items,...cnSet.champions,...cnSet.traits]){
 const other=eng.get(e.apiName);if(!other)continue;
 if(e.name&&other.name&&e.name!==other.name&&!/[\u4e00-\u9fff]/.test(other.name))output[e.name]=other.name;
 if(e.desc&&other.desc){const a=cleanText(e.desc,e.effects||{}).text,b=cleanText(other.desc,other.effects||{}).text.replaceAll('〔数值未知〕','[value unknown]').replaceAll('〔字段未知〕','[unknown field]');if(a&&b)output[a]=b;}
 if(e.ability&&other.ability){output[e.ability.name]=other.ability.name;const variables=Object.fromEntries((e.ability.variables||[]).map(v=>[v.name,v.value]));output[cleanText(e.ability.desc,variables).text]=cleanText(other.ability.desc,variables).text.replaceAll('〔数值未知〕','[value unknown]');}
}
Object.assign(output,ui,await read('public/locales/pages-en.json'));await mkdir(new URL('../public/locales/',import.meta.url),{recursive:true});await writeFile(new URL('../public/locales/en-US.json',import.meta.url),JSON.stringify(output));console.log('Published locale entries:',Object.keys(output).length);
