import { pageRank, rankPicker, rankLabel } from './stat-ranks.js';
import { node as n, action, icon, metrics, empty } from './data-ui.js';
import { patchContext, sourceLine } from './patch-context.js';
import { buildExplorerIndex, searchExplorerEntities } from './explorer-search.js';
import { normalizeResearchQuery } from './research-query.js';
import { roster } from './comps.js';

export function renderResearchExplorer(main, { catalog, api, query, onChange, onSelect, onComp } = {}) {
  query=normalizeResearchQuery(query);
  const initialSource=query.dataSource;
  query.dataSource='metatft';
  const maps={champion:new Map(catalog.champions.map(x=>[x.id,x])),item:new Map(catalog.items.map(x=>[x.id,x])),trait:new Map(catalog.traits.map(x=>[x.id,x]))};
  const index=buildExplorerIndex(catalog), root=n('section',{class:'data-page research-page','aria-label':'多条件筛选器'});main.append(root);
  let request=0,redrawEquipment=null;
  root.append(n('header',{class:'data-heading'},n('div',{},n('span',{class:'data-eyebrow',text:'TFT / EXPLORER'}),n('h1',{text:'筛选器'})),n('span',{class:'data-heading-note',text:'添加条件，查看同一组条件下的搭配'})));
  const chipBox=n('div',{class:'research-chips'}),suggestions=n('div',{class:'research-suggestions',id:'research-options',role:'listbox',hidden:true,'aria-label':'匹配的棋子与装备'});
  const input=n('input',{type:'text',role:'combobox','aria-label':'添加筛选条件','aria-autocomplete':'list','aria-expanded':'false','aria-controls':'research-options',placeholder:'搜索棋子、装备或转职，继续添加条件…',autocomplete:'off',oninput:()=>suggest(),onkeydown:event=>{
    if(event.key==='ArrowDown'){event.preventDefault();suggestions.querySelector('button')?.focus();}
    if(event.key==='Escape')closeSuggestions();
    if(event.key==='Enter'&&!suggestions.hidden&&suggestions.querySelector('button')){event.preventDefault();suggestions.querySelector('button').click();}
  }});
  const clear=action('清空',()=>{query.conditions=[];changed();},{class:'data-button quiet'});
  const search=n('div',{class:'research-search'},n('span',{'aria-hidden':'true',text:'⌕'}),input,clear);
  root.append(n('div',{class:'research-query-panel'},chipBox,search,suggestions));
  const status=n('span',{class:'research-status',role:'status'});
  const scopeNote=n('p',{class:'research-column-label'});
  root.append(scopeNote);
  const retry=action('重试查询',()=>load(),{class:'data-button',hidden:true});
  root.append(retry);
  const carrierSelect=n('select',{'aria-label':'查看谁的出装',onchange:event=>{query.carrierId=event.target.value;changed();}});
  const carrierPicker=n('label',{},'查看出装 ',carrierSelect),sampleLabel=n('span',{text:'最低样本 '});
  query.rank=query.rank || pageRank();
  root.append(n('div',{class:'research-toolbar'},rankPicker(query.rank,value=>{query.rank=value;changed();},'筛选器统计段位'),status,carrierPicker,n('label',{},sampleLabel,n('select',{'aria-label':'检索样本门槛',onchange:event=>{query.minSample=Number(event.target.value);changed();}},[...new Set([0,50,100,500,1000,query.minSample])].sort((a,b)=>a-b).map(value=>n('option',{value,selected:query.minSample===value,text:value||'不限'})))),n('label',{},'排序 ',n('select',{'aria-label':'检索结果排序',onchange:event=>{query.sort=event.target.value;changed();}},[['avgPlacement','平均名次'],['top4Rate','前四率'],['winRate','登顶率'],['sampleSize','样本数']].map(([value,text])=>n('option',{value,selected:query.sort===value,text}))))));
  const columns=n('div',{class:'research-columns'}), panels={};
  for(const [id,title]of [['equipment','装备'],['teammates','队友'],['comps','推荐阵容']]){
    const count=n('span',{}),body=n('div',{class:'research-column-body'}),label=n('p',{class:'research-column-label'});
    const heading=n('h2',{text:title}),section=n('section',{class:'research-column','aria-label':`${title}结果`},n('header',{},heading,count),label);
    if(id==='equipment'){
      const options=n('div',{class:'data-detail-options research-build-options',role:'group','aria-label':'出装包含的装备类别'},n('span',{text:'出装包含'}),
        [['artifacts','奥恩神器'],['radiant','光明装备']].map(([key,text])=>n('label',{},n('input',{type:'checkbox',checked:query.buildDisplay?.[key]!==false,'aria-label':text,onchange:event=>{
          query.buildDisplay={artifacts:true,radiant:true,...query.buildDisplay,[key]:event.target.checked};
          onChange?.(normalizeResearchQuery(query));
          redrawEquipment?.();
        }}),` ${text}`)));
      section.append(options);
    }
    section.append(body);
    panels[id]={count,body,label,heading,section};columns.append(section);
  }
  root.append(columns);
  const details=n('details',{class:'data-evidence'},n('summary',{text:'数据范围'}),n('p',{text:'完整三件套使用该英雄的出装样本；队友与推荐阵容从已收录阵容中匹配全部条件。不会把不同来源的统计拼成联合胜率。'}));root.append(details);
  function closeSuggestions(){suggestions.hidden=true;input.setAttribute('aria-expanded','false');}
  function suggest(){
    const text=input.value.trim();
    if(!text){closeSuggestions();return;}
    const matches=searchExplorerEntities(index,text).filter(({type,entity})=>type==='champion'||type==='item').slice(0,10);
    suggestions.replaceChildren(...matches.map(({type,entity})=>action([icon(entity),n('strong',{text:entity.name}),n('small',{text:type==='champion'?`${entity.cost} 费棋子`:type==='trait'?'羁绊':entity.category==='emblem'?'转职':'装备'})],()=>add(type,entity.id),{role:'option','aria-label':`添加${entity.name}`,onkeydown:event=>{
      const entries=[...suggestions.querySelectorAll('button')],i=entries.indexOf(event.currentTarget);
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();entries[(i+(event.key==='ArrowDown'?1:-1)+entries.length)%entries.length]?.focus();}
      if(event.key==='Escape'){closeSuggestions();input.focus();}
    }})));
    if(!matches.length)suggestions.append(empty('没有匹配项'));
    suggestions.hidden=false;input.setAttribute('aria-expanded','true');
  }
  function add(type,id,holderId){
    const hero=query.conditions.find(t=>t.type==='champion'&&t.id===query.carrierId)||query.conditions.find(t=>t.type==='champion');
    const term={type,id,...(type==='item'?{holderId:holderId===undefined?hero?.id||null:holderId}:{})};
    if(type==='item'||!query.conditions.some(t=>t.type===type&&t.id===id)){
      if(query.conditions.length>=24){status.textContent='最多添加 24 个条件';return;}
      query.conditions.push(term);
    }
    input.value='';closeSuggestions();changed();input.focus();
  }
  function chips(){
    const heroes=query.conditions.filter(t=>t.type==='champion');clear.hidden=!query.conditions.length;
    scopeNote.textContent=`MetaTFT · 普通排位 · 近 3 天 · ${rankLabel(query.rank)}。全部条件须在同一阵容中成立；可为每件装备分别指定佩戴者，重复添加表示需要多件。`;
    if(heroes.length&&!heroes.some(hero=>hero.id===query.carrierId))query.carrierId=heroes[0].id;
    if(!heroes.length)delete query.carrierId;
    carrierPicker.hidden=heroes.length<2;
    carrierSelect.replaceChildren(...heroes.map(hero=>n('option',{value:hero.id,selected:query.carrierId===hero.id,text:maps.champion.get(hero.id)?.name||hero.id})));
    chipBox.replaceChildren(...query.conditions.map((term,index)=>{
      const entity=maps[term.type]?.get(term.id),item=term.type==='item';
      const chip=n('div',{class:`research-chip ${term.type}`},icon(entity),n('strong',{text:entity?.name||term.id}));
      if(item)chip.append(n('select',{'aria-label':`${entity?.name}佩戴者`,onchange:event=>{term.holderId=event.target.value||null;changed();}},n('option',{value:'',selected:!term.holderId,text:'任意英雄携带'}),heroes.map(hero=>n('option',{value:hero.id,selected:term.holderId===hero.id,text:`${maps.champion.get(hero.id)?.name}携带`}))));
      chip.append(action('×',()=>{
        query.conditions.splice(index,1);
        if(term.type==='champion')query.conditions=query.conditions.map(t=>t.holderId===term.id?{...t,holderId:null}:t);
        changed();
      },{'aria-label':`移除${entity?.name||'此'}条件`,class:'research-chip-remove'}));return chip;
    }));
  }
  function changed(){chips();onChange?.(normalizeResearchQuery(query));load();}
  function choose(type,id,holderId){add(type,id,holderId);onSelect?.({type,id});}
  function resetPanel(panel,message){panel.count.textContent='';panel.label.textContent='';panel.body.replaceChildren(empty(message));}
  const renderFailure='结果已返回，但这一栏暂时无法显示。请刷新页面后重试；当前筛选条件会保留。';
  function show(result){
    if(result?.schemaVersion!==3)throw new Error('Unsupported research response');
    details.hidden=false;
    const joint=result.coverage?.jointMatchQueries===true;
    const meta=result.source==='metatft',aggregate=result.source==='opgg',carrierTitle=aggregate||result.teammates?.kind==='item_holders'?'棋子':'队友';
    panels.teammates.heading.textContent=carrierTitle;panels.teammates.section.setAttribute('aria-label',`${carrierTitle}结果`);
    status.textContent=meta?`${query.conditions.length} 个条件 · MetaTFT · ${result.coverage.matchedSamples??0} 份统计样本 · MySQL${result.coverage.cacheHit?' 已存快照':' 新采集快照'}`:joint?`${query.conditions.length} 个条件 · Riot · ${result.coverage.matchedParticipants??0} 份玩家终局 · ${result.coverage.matchedMatches??0} 场比赛`:aggregate?`${query.conditions.length} 个条件 · OP.GG · ${result.coverage.qualifiedBuilds??0} 组出装 · ${result.coverage.matchedChampions??0} 个棋子`:`${query.conditions.length} 个条件 · ${result.comps?.count??'未知'} 套匹配阵容`;
    sampleLabel.textContent=joint?'小样本提示线 ':'最低样本 ';
    const equipment=result.equipment;
    const withPatch=(label,evidence)=>{const patch=patchContext(evidence);return patch.patch?`${label} · ${patch.label}`:label;};
    const sampleWarning=row=>row.lowSample?n('small',{class:'research-low-sample',text:typeof row.warning==='string'?row.warning:`样本较少（${row.stats?.sampleSize??0}），结果可能波动。`}):null;
    const renderers={equipment:row=>{
      if(!row||typeof row.championId!=='string'||!Array.isArray(row.itemIds))throw new Error('Invalid equipment row');
      const hero=maps.champion.get(row.championId);
      const itemButtons=n('div',{class:'data-item-icons'},row.itemIds.map(id=>maps.item.has(id)?action(icon(maps.item.get(id)),()=>choose('item',id,query.conditions.some(t=>t.type==='champion'&&t.id===row.championId)?row.championId:null),{class:'data-icon-button','aria-label':`筛选${maps.item.get(id)?.name}`}):icon({name:`待核对装备 · ${id}`})));
      if(equipment.kind==='observed_builds'?!row.stats:!Array.isArray(row.deckIds))throw new Error('Missing equipment statistics');
      return n('article',{class:'research-build'},n('div',{class:'research-row-heading'},icon(hero),n('strong',{text:hero?.name||row.championId})),itemButtons,equipment.kind==='observed_builds'?metrics(row.stats,true):n('small',{text:`出现于 ${row.deckIds.length} 套匹配阵容`}),sampleWarning(row));
    },teammates:row=>{
      if(!row||typeof row.championId!=='string'||(!row.stats&&!Array.isArray(row.deckIds)))throw new Error('Invalid teammate row');
      const hero=maps.champion.get(row.championId),heading=action([icon(hero),n('span',{},n('strong',{text:hero?.name||row.championId}),!row.stats?n('small',{text:`${row.deckIds.length} 套匹配阵容中出现`}):null),n('span',{class:'research-add',text:'＋'})],()=>choose('champion',row.championId),{class:'research-teammate','aria-label':`添加${carrierTitle}${hero?.name||row.championId}`,disabled:!hero});
      const buildItems=aggregate&&Array.isArray(row.itemIds)?n('div',{class:'data-item-icons'},row.itemIds.map(id=>icon(maps.item.get(id)))):null;
      return row.stats?n('article',{class:'research-teammate-card'},heading,buildItems,metrics(row.stats,true),aggregate?n('small',{text:`${row.qualifyingBuildCount} 组匹配出装 · 此处展示排序首位组合`}):sampleWarning(row)):heading;
    },comps:deck=>{
      if(!deck||!Array.isArray(deck.units))throw new Error('Invalid composition row');
      const units=deck.units.map(unit=>({...unit,star:unit.star??unit.starLevel}));
      return n('article',{class:'research-comp'},n('h3',{text:deck.name}),roster(units,catalog,true),metrics(deck.stats,true),sampleWarning(deck),!joint&&!meta?action('查看阵容 ↗',()=>onComp?.(deck)):null);
    }};
    function drawColumn(id,panel){
      try{
        const column=result[id];
        if(!column||!Array.isArray(column.rows))throw new Error('Invalid result column');
        // Build detached nodes first: a malformed record cannot leave a half-rendered column.
        const rows=id==='equipment'?column.rows.filter(row=>!Array.isArray(row?.itemIds)||row.itemIds.every(itemId=>{
          const category=maps.item.get(itemId)?.category;
          return !(category==='artifact'&&query.buildDisplay?.artifacts===false||category==='radiant'&&query.buildDisplay?.radiant===false);
        })):column.rows;
        const nodes=rows.map(renderers[id]),total=column.count??column.rows.length,filtered=rows.length<column.rows.length;
        const reason=filtered?'当前装备类别选择下没有可展示的出装，可重新勾选奥恩神器或光明装备。':column.reason||'当前条件没有这类已收录记录。';
        panel.body.replaceChildren(...(nodes.length?nodes:[empty(reason)]));
        panel.count.textContent=filtered?`显示 ${nodes.length} / ${column.rows.length}`:total>nodes.length?`前 ${nodes.length} / ${total}`:String(total);
        panel.label.textContent=withPatch(meta?column.label:id==='comps'&&!aggregate?(joint?'同时满足全部条件的终局阵容':'同时满足全部条件'):column.label,column.evidence);
        return true;
      }catch{resetPanel(panel,renderFailure);return false;}
    }
    redrawEquipment=()=>drawColumn('equipment',panels.equipment);
    const failed=Object.entries(panels).filter(([id,panel])=>!drawColumn(id,panel)).length;
    if(failed)status.textContent+=` · ${failed} 栏显示异常，请刷新重试`;
    details.replaceChildren(...[n('summary',{text:meta?`数据范围 · MetaTFT / MySQL · ${result.coverage.matchedSamples??0} 份统计样本`:joint?`数据范围 · 命中 ${result.coverage.matchedParticipants??0} 份玩家终局`:aggregate?`数据范围 · OP.GG ${result.coverage.availableSnapshots??0} 份英雄出装资料`:`数据范围 · 已收录 ${result.coverage?.sourceComps??'未知'} 套来源阵容`}),n('p',{text:result.note}),result.reason?n('p',{text:result.reason}):null,meta?n('p',{text:`采集时间 ${result.evidence?.fetchedAt || '未知'}。来源候选可能截断；最低样本与排序在当前快照内计算。`}):null,joint?n('p',{text:'所有条件匹配同一玩家的终局阵容。样本低于提示线仍展示；同场玩家记录并非相互独立，采集范围也不代表全部段位。'}):null,sourceLine(equipment?.evidence),sourceLine(result.comps?.evidence)].filter(Boolean));
  }
  async function load(){
    const ticket=++request;
    redrawEquipment=null;
    retry.hidden=true;
    if(!query.conditions.length){status.textContent='从一个英雄或一件装备开始';for(const p of Object.values(panels)){p.body.replaceChildren(empty('添加条件后显示'));p.count.textContent='';p.label.textContent='';}details.hidden=true;return;}
    details.hidden=true;status.textContent='正在筛选…';
    for(const p of Object.values(panels))resetPanel(p,'正在筛选…');
    let result;
    // Category switches only hide displayed builds. Keep cohort/cache semantics intact.
    const {buildDisplay,...sourceQuery}=normalizeResearchQuery(query);
    try {result=await api('/api/research/query/v3',sourceQuery);}
    catch(error){if(root.isConnected&&ticket===request){status.textContent='查询未完成';details.hidden=true;retry.hidden=false;const message=/failed to fetch|networkerror|load failed/i.test(error.message||'')?'暂时无法连接服务。请稍后点击“重试查询”，当前条件已保留。':error.message||'查询暂时失败，请重试。';for(const p of Object.values(panels))resetPanel(p,message);}return;}
    if(!root.isConnected||ticket!==request)return;
    try{show(result);}
    catch{status.textContent='结果暂时无法显示，请刷新重试';details.hidden=true;for(const p of Object.values(panels))resetPanel(p,renderFailure);}
  }
  root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget))closeSuggestions();});
  const initialCarrier=query.carrierId;chips();
  if(query.carrierId!==initialCarrier||query.dataSource!==initialSource)onChange?.(normalizeResearchQuery(query));
  load();
}
