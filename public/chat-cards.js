import { RANK_OPTIONS } from './stat-ranks.js';
// Entity images only come from the current catalogue, never generated Markdown URLs.
export function renderChatCards(table,{el,lookup,entityImage,openEntity}) {
  if(!table||!Array.isArray(table.rows)||!table.rows.length)return null;
  const chip=(type,ref,core=false)=>{
    const id=typeof ref==='string'?ref:ref?.id;
    const entity=lookup(type,id);
    const name=entity?.name||ref?.name||id||'未识别';
    const content=[entityImage(entity||{name}),el('span',{text:name}),core?el('small',{text:'核心'}):null];
    return entity?el('button',{type:'button',class:`chat-entity-chip ${type}${core?' is-core':''}`,title:name,'aria-label':`查看${name}`,onclick:()=>openEntity(type,id)},content)
      :el('span',{class:'chat-entity-chip unknown'},content);
  };
  const items=(refs,compact=false)=>el('div',{class:`chat-card-items${compact?' compact':''}`,'aria-label':'装备'},refs.map(ref=>chip('items',ref)));
  const number=(n,percent=false)=>Number.isFinite(n)?percent?`${(n*100).toFixed(1)}%`:n.toFixed(3):'—';
  const cards=table.rows.slice(0,10).map((r,index)=>{
    const card=el('section',{class:'chat-result-card'},el('div',{class:'chat-card-heading'},el('span',{class:'chat-card-order',text:index+1}),el('strong',{text:r.name||'查询结果'}),el('small',{text:r.citation||''})));
    if(r.units?.length){
      card.append(el('div',{class:'chat-card-team composition','aria-label':'阵容棋子'},r.units.map(u=>el('div',{class:'chat-card-unit'},chip('champions',u,u.isCore===true),u.items?.length?items(u.items,true):null))));
      card.append(el('p',{class:'chat-card-caption',text:'来源代表阵容与装备；统计涵盖体系的不同变体。'}));
    }else{
      if(r.championId)card.append(chip('champions',{id:r.championId,name:r.name}));
      if(r.champions?.length)card.append(el('div',{class:'chat-card-team','aria-label':'同场棋子'},r.champions.map(u=>chip('champions',u))));
      if(r.items?.length)card.append(items(r.items));
      else if(r.itemId)card.append(items([{id:r.itemId}]));
      if(r.traitId)card.append(chip('traits',{id:r.traitId,name:r.name}),el('small',{text:`${r.threshold}档`}));
    }
    card.append(el('dl',{class:'chat-card-metrics'},[
      ['均次',number(r.stats?.avgPlacement)],['前四率',number(r.stats?.top4Rate,true)],['登顶率',number(r.stats?.winRate,true)],['样本',Number.isFinite(r.stats?.sampleSize)?r.stats.sampleSize.toLocaleString('en-US'):'—']
    ].map(([label,value])=>el('div',{},el('dt',{text:label}),el('dd',{text:value})))));
    return card;
  });
  const root=el('div',{class:'chat-result-cards','aria-label':'图文查询结果'});
  if(table.query){const q=table.query,s=table.source||{};const conditions=el('section',{class:'chat-query-card','aria-label':'本次查询条件'},el('strong',{text:'检索条件'}),el('p',{text:`${RANK_OPTIONS.find(([id])=>id===q.rank)?.[1]||q.rank||'段位未提供'} · 最少 ${q.minSample??0} 样本 · ${({avgPlacement:'平均排名',top4Rate:'前四率',winRate:'登顶率',sampleSize:'样本量'})[q.sort]||q.sort||'来源排序'}`}),el('small',{text:`${s.source||'来源未提供'} · 来源补丁 ${s.sourcePatch||'未声明'}${s.fetchedAt?' · 同步 '+new Date(s.fetchedAt).toLocaleString('zh-CN'):''}`}));
    if(s.requestedPatch)conditions.append(el('p',{text:`查询范围：${s.requestedPatch}${s.statisticalWindow?.days?` · 近 ${s.statisticalWindow.days} 天`:''}`}));
    if(q.coreCosts?.length)conditions.append(el('p',{text:`核心费用：${q.coreCosts.join(' / ')} 费（来源核心候选）`}));
    if(q.search)conditions.append(el('p',{text:`关键词：${q.search}`}));
    if(q.championId)conditions.append(chip('champions',q.championId));if(q.itemId)conditions.append(chip('items',q.itemId));
    for(const c of q.conditions||[]){const row=el('div',{class:'chat-condition'},chip(c.type==='champion'?'champions':c.type==='trait'?'traits':'items',c.id));if(c.type==='item')row.append(el('span',{text:c.holderId?'持有者 →':'任意持有者'}));if(c.holderId)row.append(chip('champions',c.holderId));conditions.append(row);}
    for(const id of q.requiredItemIds||[])conditions.append(el('span',{text:'必带'}),chip('items',id));for(const id of q.excludedItemIds||[])conditions.append(el('span',{text:'排除'}),chip('items',id));root.append(conditions);
  }
  if(table.kind==='comps'&&cards.length>1){const picker=el('select',{'aria-label':'切换推荐阵容',class:'chat-comp-picker',onchange:event=>cards.forEach((c,i)=>{c.hidden=i!==Number(event.target.value);})},table.rows.slice(0,10).map((r,i)=>el('option',{value:String(i),text:`${i+1}. ${r.name}`})));root.append(el('label',{text:`推荐阵容 · 已展示 ${cards.length} 套`}),picker);cards.forEach((c,i)=>{c.hidden=i!==0;});}
  root.append(...cards);return root;
}

