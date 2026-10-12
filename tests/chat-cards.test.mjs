import test from 'node:test';
import assert from 'node:assert/strict';
import {renderChatCards} from '../public/chat-cards.js';
import {queryVisualTables} from '../server/query-agent.mjs';
const el=(tag,attrs={},...children)=>({tag,attrs,children:children.flat(Infinity).filter(Boolean),append(...nodes){this.children.push(...nodes.flat(Infinity).filter(Boolean));}});
const all=n=>[n,...(n.children||[]).filter(x=>typeof x==='object').flatMap(all)];
const heroes={h:{id:'h',name:'棋子',icon:'/known.png'}};
const items={i:{id:'i',name:'装备',icon:'/item.png'}};
const calls=[];
const context={el,lookup:(type,id)=>(type==='champions'?heroes:items)[id],entityImage:e=>el('img',{src:e.icon}),openEntity:(...args)=>calls.push(args)};
const stats={sampleSize:1234,avgPlacement:3.14159,top4Rate:.625,winRate:0};
test('query cards retain holder scope and comp switching changes the visible result',()=>{
 const n=renderChatCards({kind:'comps',query:{rank:'ALL',minSample:100,sort:'avgPlacement',coreCosts:[1,2],conditions:[{type:'item',id:'i',holderId:'h'}]},source:{source:'MetaTFT',sourcePatch:null},rows:[{name:'A',stats},{name:'B',stats}]},context);
 const nodes=all(n),cards=nodes.filter(x=>x.attrs.class==='chat-result-card');
 assert.deepEqual(cards.map(c=>c.hidden),[false,true]);
 nodes.find(x=>x.tag==='select').attrs.onchange({target:{value:'1'}});
 assert.deepEqual(cards.map(c=>c.hidden),[true,false]);
 assert.ok(nodes.some(x=>x.attrs.text==='持有者 →'));
 assert.ok(nodes.some(x=>x.attrs.text==='核心费用：1 / 2 费（来源核心候选）'));
 assert.ok(nodes.some(x=>x.attrs.text?.includes('来源补丁 未声明')));
});
test('holder cards show both entities and exact metrics; clicks use verified IDs',()=>{
 const n=renderChatCards({rows:[{championId:'h',itemId:'i',name:'棋子',stats,citation:'[S1]'}]},context);
 const nodes=all(n);assert.deepEqual(nodes.filter(x=>x.tag==='img').map(x=>x.attrs.src),['/known.png','/item.png']);
 for(const value of ['3.142','62.5%','0.0%','1,234','[S1]'])assert.ok(nodes.some(x=>x.attrs.text===value));
 nodes.find(x=>x.attrs['aria-label']==='查看棋子').attrs.onclick();assert.deepEqual(calls.at(-1),['champions','h']);
});
test('duplicate gear stays duplicated; unverified image URLs are never loaded',()=>{
 const n=renderChatCards({rows:[{championId:'h',items:[{id:'i'},{id:'i'},{id:'unknown',name:'未知',icon:'https://untrusted.invalid/x'}],stats}]},context);
 assert.equal(all(n).filter(x=>x.attrs.src==='/item.png').length,2);
 assert.ok(!JSON.stringify(n).includes('untrusted.invalid'));assert.ok(all(n).some(x=>x.attrs.text==='未知'));
});
test('compositions render each unit with its own gear, never a flattened assignment',()=>{
 const n=renderChatCards({rows:[{name:'体系',units:[{id:'h',isCore:true,items:[{id:'i'}]},{id:'unseen',name:'新棋子',items:[]}],stats}]},context);
 const units=all(n).filter(x=>x.attrs.class==='chat-card-unit');assert.equal(units.length,2);
 assert.ok(all(units[0]).some(x=>x.attrs.src==='/item.png'));assert.ok(!all(units[1]).some(x=>x.attrs.src==='/item.png'));
 assert.ok(all(n).some(x=>x.attrs.text==='核心'));
});
test('visual table order follows text result columns; empty/error states never get cards',()=>{
 const r={status:'ok',query:{view:'filter',resultView:'all'},equipment:{rows:[{id:'gear'}]},teammates:{rows:[]},comps:{rows:[{id:'team'}]}};
 assert.deepEqual(queryVisualTables([r]).map(t=>t.rows[0].id),['gear','team']);
 assert.deepEqual(queryVisualTables([{...r,query:{view:'filter',resultView:'teammates'}}]),[]);
 assert.deepEqual(queryVisualTables([{...r,status:'error'}]),[]);
 assert.equal(renderChatCards({rows:[]},context),null);
});
