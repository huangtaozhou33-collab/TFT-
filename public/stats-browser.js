import { pageRank, rankPicker, rankLabel } from './stat-ranks.js';
import { node as n, action, icon, numeric, percent, metrics, empty, itemIcons, CATEGORIES } from './data-ui.js';
import { patchContext, patchDetails, sourceLine } from './patch-context.js';
import { compareResearchRows } from './research-query.js';
import { buildExplorerIndex, searchExplorerEntities } from './explorer-search.js';

const session = { kind:'equipment', category:'core', search:'', cost:'', sort:'avgPlacement', direction:1, page:1, detail:null, snapshots:{}, minimum:100, artifacts:true, radiant:true };
export function invalidateStats(){session.snapshots={};}
let savedContext='';
export function renderStatsBrowser(main, { catalog, api, onQuery, onSelect } = {}) {
  const heroes=new Map(catalog.champions.map(x=>[x.id,x])), items=new Map(catalog.items.map(x=>[x.id,x]));
  const storageKey=`tft:stats-view:v1:${catalog.context?.set}:${catalog.context?.rulesVersion}`;
  if(savedContext!==storageKey){
    savedContext=storageKey;session.snapshots={};
    try{
      const saved=JSON.parse(window.sessionStorage.getItem(storageKey)||'null');
      if(saved){
        for(const [key,values] of Object.entries({kind:['equipment','units'],category:['',...CATEGORIES.map(([id])=>id)],cost:['',1,2,3,4,5],sort:['name','sampleSize','avgPlacement','top4Rate','winRate'],direction:[1,-1],minimum:[0,100,500,1000],artifacts:[true,false],radiant:[true,false]})) if(values.includes(saved[key]))session[key]=saved[key];
        if(typeof saved.search==='string')session.search=saved.search.slice(0,160);
        if(Number.isSafeInteger(saved.page)&&saved.page>0)session.page=saved.page;
        if(saved.detail && (saved.detail.type==='champion'?heroes:saved.detail.type==='item'?items:new Map()).has(saved.detail.id))session.detail={type:saved.detail.type,id:saved.detail.id};
      }
    }catch{}
  }
  const saveView=()=>{try{const {snapshots,...view}=session;window.sessionStorage.setItem(storageKey,JSON.stringify(view));}catch{}};
  const searchIndex=buildExplorerIndex(catalog);
  const root=n('section',{class:'data-page','aria-label':'装备与棋子大数据'}); main.append(root);
  let detailRequest=0, rank=pageRank();
  function changeRank(value){rank=value;session.snapshots={};if(session.detail)detail(session.detail.type,session.detail.id);else list();}
  const cached = async kind => {
    const requestRank=rank, key=requestRank+':'+kind;
    if (session.snapshots[key]) {
      const previous=await session.snapshots[key];
      if (previous.evidence?.expiresAt && Date.parse(previous.evidence.expiresAt)<=Date.now()) delete session.snapshots[key];
    }
    if (!session.snapshots[key]) session.snapshots[key]=api(`/api/explorer?tab=${kind}&rank=${requestRank}`).catch(error=>{delete session.snapshots[key];throw error;});
    return session.snapshots[key];
  };
  function scopeControls(evidence) {
    const patch=patchContext(evidence), rank=evidence?.rank || evidence?.population?.rank || '未提供';
    const select = (label,value) => n('label',{class:'data-scope-select'},n('span',{text:label}),n('select',{'aria-label':`统计${label}`,title:label==='版本'&&patch.inferred?'按采集时间推定的统计补丁':'仅列出当前数据源实际提供的范围'},n('option',{value,text:value})));
    return n('div',{class:'data-scopes'},select('版本',patch.label),rankPicker(pageRank(),changeRank),n('span',{class:'data-scope-source',text:`${evidence?.stale?'数据较旧 · ':''}${evidence?.source || '来源'} · 采集 ${evidence?.fetchedAt ? new Date(evidence.fetchedAt).toLocaleString('zh-CN') : '未知'} · 来源更新 ${evidence?.sourceTime?new Date(evidence.sourceTime).toLocaleString('zh-CN'):'未知'}`}),patchDetails(evidence));
  }
  function categoryButtons(selected,onChange) {
    return n('div',{class:'data-categories',role:'group','aria-label':'装备类型'},[['','全部'],...CATEGORIES].map(([id,label])=>action(id?[n('img',{src:`/assets/categories/${id}.svg`,alt:'','aria-hidden':'true'}),label]:label,()=>onChange(id),{class:`data-category${selected===id?' active':''}`,'aria-pressed':String(selected===id)})));
  }
  async function list() {
    const ticket=++detailRequest; session.detail=null; onSelect?.(null); root.replaceChildren();
    saveView();
    window.scrollTo(0,0);
    const heading=n('header',{class:'data-heading'},n('div',{},n('span',{class:'data-eyebrow',text:'TFT / STATISTICS'}),n('h1',{text:'大数据'})),n('div',{},action('刷新数据',()=>{session.snapshots={};list();}),action('条件筛选 ↗',()=>onQuery([]))));
    const tabs=n('div',{class:'data-tabs',role:'tablist','aria-label':'大数据分类'},[['equipment','装备'],['units','棋子']].map(([id,label])=>action(label,()=>{session.kind=id;session.search='';session.page=1;list();},{role:'tab','aria-selected':String(session.kind===id),class:session.kind===id?'active':''})));
    const top=n('div',{class:'data-list-top'},tabs), body=n('div',{class:'data-panel'});
    root.append(heading,top,body); body.append(empty('正在载入统计…'));
    try {
      const kind=session.kind, data=await cached(kind); if(!root.isConnected||ticket!==detailRequest||session.detail||session.kind!==kind)return;
      top.append(scopeControls(data.evidence)); body.replaceChildren();
      const search=n('input',{type:'search',class:'data-search',value:session.search,placeholder:kind==='units'?'搜索棋子或外号':'搜索装备名称','aria-label':kind==='units'?'搜索棋子':'搜索装备',oninput:event=>{session.search=event.target.value;session.page=1;draw();}});
      const toolbar=n('div',{class:'data-toolbar'},kind==='equipment'?categoryButtons(session.category,value=>{session.category=value;session.page=1;list();}):n('div',{class:'data-costs',role:'group','aria-label':'棋子费用'},['',1,2,3,4,5].map(cost=>action(cost?`${cost} 费`:'全部费用',()=>{session.cost=cost;session.page=1;list();},{class:session.cost===cost?'active':''}))),search);
      const tableWrap=n('div',{class:'data-table-wrap'}), footer=n('div',{class:'data-table-footer'});
      body.append(toolbar,tableWrap,footer);
      function draw() {
        saveView();
        const query=session.search.trim().toLocaleLowerCase();
        const matches=new Set(searchExplorerEntities(searchIndex,query,kind==='equipment'?'item':'champion').map(({entity})=>entity.id));
        const observed=new Set((data.rows||[]).map(row=>row.championId||row.itemId));
        const absent=(kind==='units'?catalog.champions:catalog.items).filter(x=>!observed.has(x.id)).map(x=>({name:x.name,championId:kind==='units'?x.id:undefined,itemId:kind==='equipment'?x.id:undefined,itemCategory:x.category,sourceStatus:'not_returned',stats:{}}));
        const rows=[...(data.rows||[]),...absent].filter(row=>kind==='equipment'?(!session.category||row.itemCategory===session.category)&&(!query||matches.has(row.itemId)):(!session.cost||heroes.get(row.championId)?.cost===session.cost)&&(!query||matches.has(row.championId)));
        rows.sort((a,b)=>session.direction*(session.sort==='name'?a.name.localeCompare(b.name,'zh-CN'):compareResearchRows(a,b,session.sort)));
        const pages=Math.max(1,Math.ceil(rows.length/25));session.page=Math.min(session.page,pages);
        const table=n('table',{class:'data-table'});
        const columns=[[kind==='units'?'棋子':'装备','name'],['平均名次','avgPlacement'],['前四率','top4Rate'],['登顶率','winRate'],['样本数','sampleSize']];
        table.append(n('thead',{},n('tr',{},columns.map(([label,key])=>{const ascending=(key==='avgPlacement'||key==='name')?session.direction===1:session.direction===-1;return n('th',{scope:'col','aria-sort':session.sort===key?(ascending?'ascending':'descending'):'none'},action(`${label}${session.sort===key?(ascending?' ↑':' ↓'):''}`,()=>{session.direction=session.sort===key?-session.direction:1;session.sort=key;draw();}));}),kind==='units'?n('th',{scope:'col',text:'出装统计'}):n('th',{scope:'col',text:'出场率'}))));
        table.append(n('tbody',{},rows.slice((session.page-1)*25,session.page*25).map(row=>{
          const entity=kind==='units'?heroes.get(row.championId):items.get(row.itemId);
          return n('tr',{},n('td',{},action([icon(entity),n('span',{},n('strong',{text:entity?.name}),row.sourceStatus==='not_returned'?n('small',{text:'来源整体统计未返回'}):null,kind==='units'?n('small',{text:`${entity.cost} 费 · ${entity.traits.join(' / ')}`}):null)],()=>detail(kind==='units'?'champion':'item',entity.id,row),{class:'data-entity-link','aria-label':`查看${entity?.name}统计详情`})),
            n('td',{class:'data-place',text:numeric(row.stats?.avgPlacement)}),n('td',{text:percent(row.stats?.top4Rate)}),n('td',{text:percent(row.stats?.winRate)}),n('td',{text:numeric(row.stats?.sampleSize)}),n('td',{},kind==='units'?action('查看出装 →',()=>detail('champion',entity.id,row)):percent(row.stats?.pickRate)));
        })));
        tableWrap.replaceChildren(rows.length?table:empty('没有匹配的统计记录。'));
        footer.replaceChildren(n('span',{text:`${rows.length} 条 · ${session.page} / ${pages} 页`}),n('div',{},action('上一页',()=>{session.page--;draw();},{disabled:session.page===1}),action('下一页',()=>{session.page++;draw();},{disabled:session.page===pages})));
      }
      draw(); root.append(n('p',{class:'data-footnote',text:data.evidence?.source?.startsWith('MetaTFT')?`MetaTFT · 普通排位 · ${rankLabel(rank)} · 近 3 天。样本为玩家名次观测数；未返回整体统计的目录条目显示 —，可点击查看明细。各接口更新时间可能不同。`:'版本与段位仅显示当前已收录范围；详情中的搭配统计单独标注来源。'}));
    }catch(error){if(root.isConnected&&ticket===detailRequest)body.replaceChildren(empty(error.message),action('重试',list));}
  }
  async function detail(type,id,overall=null) {
    const ticket=++detailRequest; session.detail={type,id}; onSelect?.({type,id});
    saveView();
    window.scrollTo(0,0);
    const entity=(type==='champion'?heroes:items).get(id); if(!entity)return list();
    root.replaceChildren(n('div',{class:'data-detail-nav'},action('← 返回大数据',list),action('加入条件筛选 ↗',()=>onQuery([{type,id}]))),
      n('header',{class:'data-detail-heading'},icon(entity,'large'),n('div',{},n('span',{class:'data-eyebrow',text:type==='champion'?`${entity.cost} 费 / 棋子`:(CATEGORIES.find(x=>x[0]===entity.category)?.[1]||'装备')}),n('h1',{text:entity.name}),n('p',{text:type==='champion'?entity.traits.join(' · '):''}))),
      ...(overall?[metrics(overall.stats),sourceLine(overall.evidence)]:[]));
    root.append(rankPicker(rank,changeRank));
    const content=n('div',{}); root.append(content);content.append(empty('正在载入搭配…'));
    try {
      if(type==='champion') {
        const result=await api('/api/builds/query',{championId:id,minSample:session.minimum,sort:'avgPlacement',rank});
        if(!root.isConnected||ticket!==detailRequest)return;
        const drawBuilds=()=>{
          saveView();
          const rows=result.data.filter(row=>session.artifacts||!row.itemIds.some(item=>items.get(item)?.category==='artifact')).filter(row=>session.radiant||!row.itemIds.some(item=>items.get(item)?.category==='radiant'));
          const featured=n('div',{class:'data-build-featured'},rows.slice(0,3).map(row=>n('article',{class:'data-build-card'},itemIcons(row.itemIds,items,item=>detail('item',item)),metrics(row.stats,true))));
          content.replaceChildren(n('div',{class:'data-section-heading'},n('h2',{text:'完整出装'}),n('div',{class:'data-detail-options'},n('label',{},n('input',{type:'checkbox',checked:session.artifacts,onchange:event=>{session.artifacts=event.target.checked;drawBuilds();}}),' 奥恩神器'),n('label',{},n('input',{type:'checkbox',checked:session.radiant,onchange:event=>{session.radiant=event.target.checked;drawBuilds();}}),' 光明装备'),n('label',{},'最低样本 ',n('select',{'aria-label':'出装最低样本',onchange:event=>{session.minimum=Number(event.target.value);detail(type,id,overall);}},[0,100,500,1000].map(value=>n('option',{value,selected:session.minimum===value,text:value||'不限'})))))),rows.length?featured:empty(result.reason||'没有满足条件的出装。'),sourceLine(result.evidence));
          const table=n('table',{class:'data-table'},n('thead',{},n('tr',{},['装备组合','均次','前四率','登顶率','样本'].map(text=>n('th',{text})))),n('tbody',{},rows.map(row=>n('tr',{},n('td',{},itemIcons(row.itemIds,items,item=>detail('item',item))),n('td',{class:'data-place',text:numeric(row.stats.avgPlacement)}),n('td',{text:percent(row.stats.top4Rate)}),n('td',{text:percent(row.stats.winRate)}),n('td',{text:numeric(row.stats.sampleSize)})))));
          content.append(n('p',{class:'data-footnote',text:`共 ${rows.length} 条符合当前条件的来源出装，全部列出。来源可能限制候选数量，未返回的组合不能据此认定零样本。`}));
          if(rows.length) content.append(n('div',{class:'data-panel data-table-wrap'},table));
        }; drawBuilds();
      } else {
        const result=await api(`/api/items/${encodeURIComponent(id)}/holders?rank=${rank}`);
        if(!root.isConnected||ticket!==detailRequest)return;
        const rows=(result.data||[]).filter(row=>row.stats?.sampleSize>=session.minimum).sort((a,b)=>compareResearchRows(a,b));
        content.replaceChildren(n('div',{class:'data-section-heading'},n('h2',{text:'装备携带者'}),n('label',{},'最低样本 ',n('select',{'aria-label':'携带者最低样本',onchange:event=>{session.minimum=Number(event.target.value);detail(type,id,overall);}},[0,100,500,1000].map(value=>n('option',{value,selected:session.minimum===value,text:value||'不限'}))))),sourceLine(result.evidence));
        content.append(rows.length?n('div',{class:'data-holder-grid'},rows.map(row=>n('article',{class:'data-holder-card'},action([icon(heroes.get(row.championId)),n('strong',{text:heroes.get(row.championId)?.name})],()=>detail('champion',row.championId),{class:'data-entity-link'}),metrics(row.stats,true),action('查看搭配 →',()=>onQuery([{type:'champion',id:row.championId},{type:'item',id,holderId:row.championId}]))))):empty(result.reason||'当前样本门槛下没有携带者数据。'));
      }
    }catch(error){if(root.isConnected&&ticket===detailRequest)content.replaceChildren(empty(error.message),action('重试',()=>detail(type,id,overall)));}
  }
  if(session.detail)detail(session.detail.type,session.detail.id);else list();
}
