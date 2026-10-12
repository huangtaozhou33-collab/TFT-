export const LIBRARY_ROUTES = {systems:'system','trait-rules':'trait','wisp-rules':'wisp',reference:'reference',glossary:'glossary'};
const norm=value=>String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
export function searchLibrary(doc,query) {
  const text=norm(query); if(!text) return true;
  return norm([doc.title,doc.summary,...doc.aliases,...doc.rules,...doc.tables.flatMap(table=>[table.title,...table.rows.flatMap(row=>row.cells)])].join(' ')).includes(text);
}
export const entityDocuments=(snapshot,id)=>snapshot?.documents?.filter(doc=>doc.entities.some(entity=>entity.id===id)) ?? [];
const statusText=doc=>doc.reviewStatus==='conflict'?'数值待核验':doc.retrievalEligible?`来源 ${doc.sourcePatch}`:doc.sourcePatch?`${doc.sourcePatch} · 参考资料`:'通用参考';

export function renderLibraryHub(container,{snapshot,mechanics,glossary,el,btn,onNavigate,onOpen,onMechanic,onGlossary}) {
  const ready=snapshot?.status==='ready';
  const hero=el('section',{class:'library-overview'},el('span',{class:'library-hero-symbol','aria-hidden':'true',text:'✦'}),el('div',{class:'library-overview-copy'},el('span',{class:'eyebrow',text:'规则 · 条件 · 奖励 / FIELD NOTES'}),el('h2',{},'看懂机制，',el('br'),el('span',{text:'再做选择。'})),el('p',{text:'从商店概率到魔女兑现，每一个选择都有据可查。海克斯奖励与出现条件，点开详情即可了解。'})),el('div',{class:'library-overview-numbers'},el('strong',{text:ready?snapshot.coverage.documents:'—'}),el('span',{text:'个机制专题'}),el('strong',{text:ready?snapshot.coverage.augmentRules:'—'}),el('span',{text:'个海克斯出现规则'})));
  const search=el('input',{type:'search',placeholder:'搜索法杖、奖励、术语或英文原名…','aria-label':'搜索资料库'});
  const results=el('div',{class:'library-hub-results'});
  function update(){const query=search.value.trim();results.replaceChildren(); if(!query)return; const matches=(snapshot?.documents ?? []).filter(doc=>searchLibrary(doc,query)).slice(0,8),wisps=(mechanics?.entries ?? []).filter(entry=>mechanicSearchText(entry).includes(norm(query))).slice(0,6),terms=filterGlossaryEntries(glossary?.entries,query).slice(0,6);
    results.append(...terms.map(entry=>el('button',{type:'button',class:'library-search-result',onclick:()=>onGlossary?.(entry)},el('strong',{text:entry.term}),el('span',{text:entry.definition}),el('small',{text:'通用术语 · 本项目整理'}))),...wisps.map(entry=>el('button',{type:'button',class:'library-search-result library-wisp-result',onclick:()=>onMechanic(entry)},entry.icon?.startsWith('https://')?el('img',{src:entry.icon,alt:'',loading:'lazy'}):null,el('strong',{text:entry.name}),el('span',{text:offeringPreview(entry).window}),el('small',{text:offeringPreview(entry).conditions.slice(0,2).join('；')}))),...matches.map(doc=>el('button',{type:'button',class:'library-search-result',onclick:()=>onOpen(doc)},el('strong',{text:doc.title}),el('span',{text:doc.summary}),el('small',{text:statusText(doc)}))));if(!matches.length&&!wisps.length&&!terms.length)results.append(el('p',{class:'muted-text',text:'暂未收录这一内容，试试名称、外号或英文原名。'}));}
  search.addEventListener('input',update);hero.append(el('div',{class:'library-hub-search'},search,results));container.append(hero);
  const categories=[...(snapshot?.categories ?? [
    {id:'system',name:'系统规则与概率',icon:'▦',description:'商店、卡池、经济、掉落与玩家伤害'},
    {id:'trait',name:'羁绊机制细则',icon:'⌘',description:'兑现奖励、特殊商店、献祭与形态'},
    {id:'wisp',name:'法杖详细效果',icon:'❋',description:'属性、装备叠层与临时药水'},
    {id:'reference',name:'实用速查',icon:'◷',description:'纹章、PvE、日程与通用参考'}]),{id:'glossary',name:'云顶术语',icon:'字',description:'慢D、锁血与打工，查含义、例句和常见误解'}];
  const cards=categories.filter(category=>category.id!=='augment').map(category=>el('button',{type:'button',class:'library-category-card',onclick:()=>onNavigate(category.id==='wisp'?'mechanics':Object.keys(LIBRARY_ROUTES).find(route=>LIBRARY_ROUTES[route]===category.id))},el('span',{class:'library-category-icon','aria-hidden':'true',text:category.icon}),el('div',{},el('h3',{text:category.id==='wisp'?'赛季特殊玩法':category.name}),el('p',{text:category.id==='wisp'?'法杖出现回合、金币条件、冷却、互斥与详细效果':category.description})),el('span',{class:'library-category-count',text:category.id==='glossary'?`${glossary?.entries?.length ?? '—'} 个术语 ↗`:category.id==='wisp'?`${mechanics?.offering?.coverage?.mapped ?? '—'} 条出现条件 ↗`:`${snapshot?.coverage?.byCategory?.[category.id] ?? '—'} 篇 ↗`})));
  container.append(el('div',{class:'library-category-grid'},cards));
  const orbDoc=snapshot?.documents?.find(doc=>doc.id==='loot-orb-contents');
  if(orbDoc)container.append(el('button',{type:'button',class:'library-orb-shortcut',onclick:()=>onOpen(orbDoc)},el('div',{class:'library-orb-preview'},LOOT_ORBS.map(orb=>gameIcon(orb,{el,size:38}))),el('div',{},el('strong',{text:'战利品法球'}),el('p',{text:'认图找奖励 · 按颜色和阶段查概率'})),el('span',{'aria-hidden':'true',text:'↗'})));
  if(ready)container.append(el('div',{class:'library-quick-links'},el('span',{text:'常用速查'}),['shop-odds','trait-ladder','golden-egg','coven'].map(id=>{const doc=snapshot.documents.find(doc=>doc.id===id);return doc?btn(doc.title.split(' · ')[0],()=>onOpen(doc),'ghost small'):null;})));
}

function sourceDetails(doc,{el,safeUrl}) {
  const source=doc.source;
  const links=[['查看原始页面',source.url],...(source.csv?[['查看来源表格',source.csv.url]]:[])];
  const time=source.fetchedAt?new Intl.DateTimeFormat('zh-CN',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(source.fetchedAt)): '未记录';
  return el('details',{class:'library-source'},el('summary',{text:'来源与版本'}),el('dl',{},[['资料来源','Little Buddy Bot · 中文整理'],['页面补丁',source.pagePatch ?? '未声明'],['图内更新日期',source.imageUpdatedAt ?? '无图片日期'],['采集时间',`${time}（悉尼）`],['图片文件名补丁提示',[...new Set(source.assets.map(asset=>asset.filePatchHint).filter(Boolean))].join(' / ') || '无']].map(([label,value])=>[el('dt',{text:label}),el('dd',{text:value})])),el('p',{text:'图片文件名、页面补丁与图内日期分别保留；文件名较旧不等同于当前内容失效。'}),el('div',{class:'actions'},links.map(([title,url])=>safeUrl(url)?el('a',{href:safeUrl(url),target:'_blank',rel:'noopener noreferrer',text:`${title} ↗`}):null)));
}
function sourceArtwork(doc,{el,safeUrl}) {
  const assets=(doc.source?.assets || []).filter(asset=>! /logo/i.test(asset.alt || '') && safeUrl(asset.url));
  if(!assets.length)return null;
  return el('details',{class:'library-source-artwork'},el('summary',{text:'图片对照 · 来源原图'}),el('p',{text:'上方为中文整理；展开原图可核对图标与奖励。'}),assets.map(asset=>el('figure',{},el('a',{href:safeUrl(asset.url),target:'_blank',rel:'noopener noreferrer'},el('img',{src:safeUrl(asset.url),alt:`${doc.title}的来源图表`,loading:'lazy',referrerpolicy:'no-referrer'})),el('figcaption',{text:`Little Buddy Bot · ${doc.title} · 图内更新 ${doc.source.imageUpdatedAt || '未声明'}`}))));
}

function richCell(value,{el,catalog,onEntity}) {
  const text=String(value),span=el('span',{class:'library-cell-text'});
  const candidates=['items','champions'].flatMap(type=>(catalog[type] ?? []).map(entity=>({type,entity}))).filter(({entity})=>entity.name?.length>1 && text.includes(entity.name)).sort((a,b)=>b.entity.name.length-a.entity.name.length);
  const chosen=[];
  for(const candidate of candidates)for(let start=text.indexOf(candidate.entity.name);start>=0;start=text.indexOf(candidate.entity.name,start+candidate.entity.name.length))if(!chosen.some(segment=>start<segment.end&&start+candidate.entity.name.length>segment.start))chosen.push({...candidate,start,end:start+candidate.entity.name.length});
  for(const visual of lootRewardTokens(text))if(!chosen.some(segment=>visual.start<segment.end&&visual.end>segment.start))chosen.push(visual);
  chosen.sort((a,b)=>a.start-b.start);let cursor=0;
  for(const segment of chosen){if(segment.start>cursor)span.append(text.slice(cursor,segment.start));if(segment.crop){span.append(el('span',{class:'library-reward-token'},gameIcon(segment,{el,size:25}),segment.name));}else{const icon=segment.entity.icon?.startsWith('https://')?el('img',{src:segment.entity.icon,alt:'',loading:'lazy',onerror:event=>event.currentTarget.remove()}):null;span.append(el('button',{type:'button',class:'library-entity-token',onclick:()=>onEntity(segment.type,segment.entity.id),title:`查看${segment.entity.name}`},icon,segment.entity.name));}cursor=segment.end;}
  if(cursor<text.length)span.append(text.slice(cursor));return span;
}

export function createLibraryDocument(doc,options) {
  const {el,btn,catalog,onEntity,onAsk}=options;
  const body=el('article',{class:'library-document','data-library-id':doc.id},el('div',{class:'library-document-title'},el('div',{},el('span',{class:'eyebrow',text:doc.category==='augment'?'奖励与特殊交互':'机制细则'}),el('h2',{text:doc.title})),el('span',{class:`tag ${doc.retrievalEligible?'':'gold'}`,text:statusText(doc)})),el('p',{class:'library-summary',text:doc.summary}));
  if(doc.conflicts?.length)body.append(el('div',{class:'library-conflict',role:'note'},el('strong',{text:'来源数值存在冲突'}),doc.conflicts.map(text=>el('p',{text})),el('p',{text:'下表保留来源原值；助手不会将这些数值作为当前补丁的确定结论。'})));
  else if(!doc.retrievalEligible)body.append(el('p',{class:'library-reference-note',text:doc.sourcePatch?`来源标记 ${doc.sourcePatch}，当前适用性待核验。`:'此资料未声明当前补丁，按参考资料展示。'}));
  if(doc.id!=='loot-orb-contents')body.append(el('ul',{class:'library-rule-list'},doc.rules.map(rule=>el('li',{text:rule}))));
  const visibleRefs=doc.entities.filter(ref=>ref.type==='wisps'?ref.name:catalog[ref.type]?.some(entity=>entity.id===ref.id));
  if(visibleRefs.length)body.append(el('div',{class:'library-related'},el('span',{text:'关联图鉴'}),visibleRefs.map(ref=>{const entity=ref.type==='wisps'?options.mechanics?.entries?.find(entry=>entry.id===ref.id):catalog[ref.type]?.find(entity=>entity.id===ref.id),name=ref.name || entity?.name,variant=({base:'基础',upgraded:'升级',prismatic:'棱彩'})[ref.variant];return el('button',{type:'button',class:'button ghost small library-related-entity',onclick:()=>onEntity(ref.type,ref.id)},entity?.icon?.startsWith('https://')?el('img',{src:entity.icon,alt:'',loading:'lazy'}):null,variant?`${name} · ${variant}`:name);}))); 
  let selected=0;
  let selectedOrb=LOOT_ORBS[0].id,orbButtons=[];
  if(doc.id==='loot-orb-contents') {
    const picker=el('section',{class:'library-orb-picker','aria-label':'按图片选择法球'},el('h3',{text:'先认法球，再查奖励'}),el('p',{text:'点击法球图片，然后选择阶段。蓝色战利品球与基础装备球分开查询。'}));
    orbButtons=LOOT_ORBS.map(orb=>el('button',{type:'button','aria-label':orb.name,class:`library-orb-choice${orb.id===selectedOrb?' active':''}`,'aria-pressed':String(orb.id===selectedOrb),onclick:()=>{
      selectedOrb=orb.id;selected=doc.tables.findIndex(table=>table.title.startsWith(orb.prefix));
      for(let index=0;index<orbButtons.length;index++){const active=LOOT_ORBS[index].id===selectedOrb;orbButtons[index].classList.toggle('active',active);orbButtons[index].setAttribute('aria-pressed',String(active));}
      updateSwitcher();renderTable();
    }},gameIcon(orb,{el,size:58}),el('strong',{text:orb.name}),el('small',{text:orb.hint})));
    picker.append(el('div',{class:'library-orb-grid'},orbButtons));body.append(picker,el('details',{class:'library-orb-rules'},el('summary',{text:'法球价值与奖励概率说明'}),el('ul',{class:'library-rule-list'},doc.rules.map(rule=>el('li',{text:rule})))));
  }
  const tableHost=el('section',{class:'library-table-section'});
  const select=el('select',{'aria-label':'选择规则表',onchange:event=>{selected=Number(event.target.value);renderTable();}});
  function updateSwitcher(){select.replaceChildren(...doc.tables.flatMap((table,index)=>doc.id==='loot-orb-contents'&&!table.title.startsWith(LOOT_ORBS.find(orb=>orb.id===selectedOrb).prefix)?[]:[el('option',{value:index,text:table.title})]));select.value=String(selected);}
  updateSwitcher();
  const switcher=doc.tables.length>1?el('label',{class:'library-table-switch'},el('span',{text:doc.id==='loot-orb-contents'?'选择出现阶段':'选择奖励档位 / 表格'}),select):null;
  if(switcher)body.append(switcher);
  function renderTable(){const table=doc.tables[selected];tableHost.replaceChildren();if(!table)return;
    const count=el('span',{class:'library-row-count'}),search=el('input',{type:'search',placeholder:'在表内查找…','aria-label':'搜索表格内容'});
    const header=el('div',{class:'library-table-heading'},el('h3',{text:table.title}),count);
    const tbody=el('tbody'),nativeTable=el('table',{class:'library-native-table'},el('caption',{class:'sr-only',text:table.title}),el('thead',{},el('tr',{},table.columns.map(column=>el('th',{scope:'col',text:column})))),tbody);
    const scroll=el('div',{class:'library-table-scroll',tabindex:'0','aria-label':`${table.title}，可横向滚动`},nativeTable);
    const filters=el('div',{class:'library-table-filters'});const groups=[...new Set(table.rows.map(row=>String(row.cells[0])))];
    const condition=doc.id==='trait-ladder'?el('select',{'aria-label':'选择羁绊数量'},el('option',{value:'',text:'全部羁绊数量'}),groups.map(group=>el('option',{value:group,text:group}))):null;
    const update=()=>{const rows=table.rows.filter(row=>(!condition?.value||String(row.cells[0])===condition.value)&&norm(row.cells.join(' ')).includes(norm(search.value)));count.textContent=`${rows.length} 条`;tbody.replaceChildren(...rows.map(row=>el('tr',{},row.cells.map((cell,index)=>el(index===0?'th':'td',index===0?{scope:'row'}:{},index===0&&row.entity?btn(String(cell),()=>onEntity(row.entity.type,row.entity.id),'ghost small'):table.columns[index].includes('概率')?el('span',{class:'library-probability',text:cell}):richCell(cell,options))))));if(!rows.length)tbody.append(el('tr',{},el('td',{colspan:table.columns.length,class:'library-no-result',text:'没有匹配结果。'})));};
    search.addEventListener('input',update);condition?.addEventListener('change',update);if(condition)filters.append(condition);if(table.rows.length>10)filters.append(search);
    tableHost.append(header,filters,scroll);if(table.probabilityBasis)tableHost.append(el('p',{class:'library-table-note',text:`概率口径：${table.probabilityBasis}`}));if(table.condition)tableHost.append(el('p',{class:'library-table-note',text:`触发条件：${table.condition}`}));if(table.note)tableHost.append(el('p',{class:'library-table-note',text:table.note}));update();
  }renderTable();body.append(tableHost);
  if(doc.coverage)body.append(el('p',{class:'library-table-note',text:`来源 ${doc.coverage.sourceRows} 条，已匹配中文目录 ${doc.coverage.matchedRows} 条。${doc.coverage.note ?? ''}`}));
  body.append(el('div',{class:'library-document-actions'},btn('✧ 询问这个机制',()=>onAsk(doc),'secondary small')),sourceArtwork(doc,options),sourceDetails(doc,options));return body;
}

export function createAugmentOffering(rule,source,{el,btn,onEntity,safeUrl}) {
  const body=el('section',{class:'library-offering'},el('div',{class:'library-offering-heading'},el('h3',{text:'出现条件'}),el('span',{class:'tag neutral',text:`来源 ${rule.sourcePatch}`})),el('div',{class:'library-offering-grid'},el('div',{},el('small',{text:'强化阶段'}),el('strong',{text:rule.stages.length?rule.stages.map(stage=>`第${stage}阶段`).join(' / '):'来源未列可提供阶段'})),el('div',{},el('small',{text:'游戏模式'}),el('strong',{text:rule.modes.join(' / ') || '来源未列适用模式'}))),el('ul',{},rule.conditionsZh.map(condition=>el('li',{text:condition}))));
  if(rule.onePlayerNote)body.append(el('p',{class:'library-one-player',text:rule.onePlayerNote}));
  const mapped=rule.exclusions.filter(entity=>entity.catalogMapped),unknown=rule.exclusions.length-mapped.length;
  if(mapped.length)body.append(el('details',{class:'library-exclusions'},el('summary',{text:`互斥强化 · ${mapped.length}项`}),el('div',{class:'actions'},mapped.map(entity=>btn(entity.name,()=>onEntity('augments',entity.id),'ghost small')))));
  else body.append(el('p',{class:'library-table-note',text:'来源未列已匹配目录的互斥强化。'}));
  if(unknown)body.append(el('p',{class:'library-table-note',text:`另有${unknown}个互斥条目尚未匹配当前中文目录，未借用相似名称。`}));
  if(safeUrl(source?.pageUrl))body.append(el('a',{class:'library-offering-source',href:safeUrl(source.pageUrl),target:'_blank',rel:'noopener noreferrer',text:'强化条件来源 ↗'}));return body;
}

export function renderLibraryBrowser(main,{snapshot,category,selectedId,onSelect,onNavigate,...options}) {
  if(category==='glossary')return renderGlossaryBrowser(main,{...options,selectedId,onSelect});
  const {el}=options;
  if(snapshot?.status!=='ready')return main.append(el('p',{class:'library-reference-note',text:snapshot?.reason || '正在载入中文机制资料…'}));
  const documents=snapshot.documents.filter(doc=>doc.category===category),meta=snapshot.categories.find(meta=>meta.id===category);
  const search=el('input',{type:'search',placeholder:'搜索中文名称、英文别名或规则内容','aria-label':'筛选机制专题'}),list=el('div',{class:'library-topic-list'}),detail=el('div',{class:'library-reader'});
  let active=documents.find(doc=>doc.id===selectedId) ?? documents[0];
  const select=doc=>{active=doc;onSelect(doc);detail.replaceChildren(createLibraryDocument(doc,options));for(const button of list.querySelectorAll('button')){const selected=button.dataset.topic===doc.id;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}};
  function update(){const found=documents.filter(doc=>searchLibrary(doc,search.value));list.replaceChildren(...found.map(doc=>{const ref=doc.entities[0],entity=ref?.type==='wisps'?options.mechanics?.entries?.find(entry=>entry.id===ref.id):options.catalog[ref?.type]?.find(entity=>entity.id===ref.id);
    const thumbnail=doc.id==='loot-orb-contents'||doc.id==='loot-distribution-system'?gameIcon(LOOT_ORBS[doc.id==='loot-orb-contents'?2:1],{el,size:32}):entity?.icon?.startsWith('https://')?el('img',{class:'library-topic-icon',src:entity.icon,alt:'',loading:'lazy'}):null;
    return el('button',{type:'button',class:`library-topic${active?.id===doc.id?' active':''}${thumbnail?' library-topic-visual':''}`,'data-topic':doc.id,'aria-pressed':String(active?.id===doc.id),onclick:()=>select(doc)},thumbnail,el('strong',{text:doc.title}),el('small',{text:`${doc.tables.reduce((sum,table)=>sum+table.rows.length,0)}条规则 · ${statusText(doc)}`}));}));if(!found.length)list.append(el('p',{class:'muted-text',text:'未找到匹配专题。'}));}
  search.addEventListener('input',update);
  main.append(el('div',{class:'library-layout'},el('aside',{class:'library-topics','aria-label':meta?.name},el('div',{class:'library-topics-head'},el('h2',{text:meta?.name}),el('span',{text:`${documents.length}篇`})),search,list),detail));update();if(active)select(active);
}

/** Prefer a matching name or alias over incidental mentions in examples. */
export function filterGlossaryEntries(entries=[],query='') {
  const needle=norm(query),tokens=String(query).normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if(!Array.isArray(entries))return [];
  const score=entry=>{
    const names=[entry.term,...(entry.aliases ?? [])].map(norm);
    if(names.includes(needle))return 0;
    if(names.some(name=>name.includes(needle)))return 1;
    const body=norm([entry.term,...(entry.aliases ?? []),entry.category,entry.definition,entry.applicability,...(entry.examples ?? []),...(entry.misconceptions ?? []),...(entry.relatedTerms ?? [])].join(' '));
    return tokens.every(token=>body.includes(norm(token)))?2:Infinity;
  };
  return needle?entries.map((entry,index)=>({entry,index,score:score(entry)})).filter(row=>Number.isFinite(row.score)).sort((a,b)=>a.score-b.score || a.index-b.index).map(row=>row.entry):entries.slice();
}

function glossaryCategory(entry) {
  return ({economy:'经济',rolling:'搜牌',tempo:'节奏',composition:'阵容',combat:'对战',positioning:'站位',equipment:'装备',statistics:'统计',general:'通用'})[entry.category] || (/[^\x00-\x7F]/.test(entry.category || '')?entry.category:'通用');
}

export function createGlossaryEntry(entry,{glossary,el,btn,onRelated,onAskGlossary}) {
  const body=el('article',{class:'library-document glossary-document','data-glossary-id':entry.id},
    el('div',{class:'library-document-title'},el('div',{},el('span',{class:'eyebrow',text:`云顶术语 / ${glossaryCategory(entry)}`}),el('h2',{text:entry.term})),el('span',{class:'tag neutral',text:entry.applicability?.includes('历史/赛季相关')?'历史 / 赛季相关':'通用术语'})),
    entry.aliases?.length?el('p',{class:'glossary-aliases',text:`也叫：${entry.aliases.join('、')}`}):null,
    el('p',{class:'glossary-definition',text:entry.definition}));
  for(const [label,values,cls] of [['对局中的说法',entry.examples,'glossary-examples'],['容易误解的地方',entry.misconceptions,'glossary-misconceptions']]) {
    if(values?.length)body.append(el('section',{class:`glossary-section ${cls}`},el('h3',{text:label}),el('ul',{},values.map(text=>el('li',{text})))));
  }
  const related=(entry.relatedTerms ?? []).map(term=>(glossary?.entries ?? []).find(candidate=>candidate.id===term || candidate.term===term || candidate.aliases?.includes(term))).filter(Boolean);
  if(related.length)body.append(el('div',{class:'library-related'},el('span',{text:'相关术语'}),related.map(term=>btn(term.term,()=>onRelated(term),'ghost small'))));
  if(onAskGlossary)body.append(el('div',{class:'library-document-actions'},btn('询问这个术语',()=>onAskGlossary(entry),'secondary small')));
  if(entry.applicability)body.append(el('p',{class:'library-reference-note',text:`适用范围：${entry.applicability}`}));
  const references=(entry.references ?? []).filter(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}});
  if(entry.evidenceStatus)body.append(el('details',{class:'library-source'},el('summary',{text:'证据标记与参考来源'}),
    el('p',{text:entry.evidenceStatus==='source_supported'?'source_supported · 有用法或对应概念参考，不等于官方定义。':'editorial_common_usage · 编者常见用法整理，不等于官方定义。'}),
    el('p',{text:entry.referenceNote || '未逐条独立复核。'}),
    references.length?el('ul',{},references.map((url,index)=>el('li',{},el('a',{href:url,target:'_blank',rel:'noopener noreferrer',text:`参考 ${index+1} · ${new URL(url).hostname}`})))):null));
  body.append(el('p',{class:'glossary-source',text:`${glossary?.source?.name || '本项目术语整理'} · 基础概念与常用说法。具体数值、装备效果和运营选择以对应赛季及对局条件为准。`}));
  return body;
}

export function renderGlossaryBrowser(main,{glossary,selectedId,onSelect=()=>{},...options}) {
  const {el,btn}=options;
  if(!glossary)return main.append(el('p',{class:'library-inline-error',role:'status',text:'正在载入云顶术语…'}));
  if(glossary.reason)return main.append(el('p',{class:'library-reference-note',role:'status',text:`术语暂时无法读取：${glossary.reason}`}));
  const entries=Array.isArray(glossary.entries)?glossary.entries:[];
  const search=el('input',{type:'search',placeholder:'搜索术语或别名，如慢D、锁血…','aria-label':'搜索云顶术语'}),list=el('div',{class:'library-topic-list'}),detail=el('div',{class:'library-reader',role:'region','aria-label':'术语详情'}),count=el('span',{text:`${entries.length}个`});
  let active=entries.find(entry=>entry.id===selectedId) ?? entries[0];
  const select=entry=>{
    active=entry;onSelect(entry);
    detail.replaceChildren(createGlossaryEntry(entry,{...options,glossary,onRelated:related=>{search.value='';active=related;update();select(related);}}));
    for(const button of list.querySelectorAll('button')){const selected=button.dataset.term===entry.id;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}
  };
  function update(){
    const found=filterGlossaryEntries(entries,search.value);count.textContent=`${found.length}个`;
    list.replaceChildren(...found.map(entry=>el('button',{type:'button',class:`library-topic${active?.id===entry.id?' active':''}`,'data-term':entry.id,'aria-pressed':String(active?.id===entry.id),onclick:()=>select(entry)},el('strong',{text:entry.term}),el('small',{text:entry.aliases?.slice(0,3).join(' / ') || glossaryCategory(entry)}))));
    if(!found.length){list.append(el('p',{class:'muted-text',role:'status',text:'没有找到这个术语。'}));detail.replaceChildren(el('p',{class:'library-summary',text:'试试常用名称、别名或定义里的关键词。'}),btn('清空搜索',()=>{search.value='';update();search.focus();},'ghost small'));return;}
    if(!found.some(entry=>entry.id===active?.id))select(found[0]);
    else if(!detail.querySelector('article'))select(active);
  }
  search.addEventListener('input',update);
  main.append(el('div',{class:'library-layout glossary-layout'},el('aside',{class:'library-topics','aria-label':'云顶术语列表'},el('div',{class:'library-topics-head'},el('h2',{text:'云顶术语'}),count),search,list),detail));
  update();if(active&&detail.querySelector('article')===null)select(active);
}
import { LOOT_ORBS, gameIcon, lootRewardTokens } from './library-visuals.js';
import { mechanicSearchText, offeringPreview } from './mechanic-browser.js';
