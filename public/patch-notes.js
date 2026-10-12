import {getLanguage} from './i18n.js';
const node=(tag,text,attrs={})=>{const e=document.createElement(tag);if(text)e.textContent=text;for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;};
const time=x=>x?new Date(x).toLocaleString('zh-CN'):'尚无记录';
function picture(image,label){
 const wrap=node('span',null,{class:'patch-figure'}),button=node('button',null,{type:'button','aria-label':label,class:'patch-image-button'});
 const img=node('img',null,{src:image.src,alt:image.alt,loading:'lazy',decoding:'async',referrerpolicy:'no-referrer'});
 const caption=node('small','Riot 官方配图 · 点击放大');
 img.onerror=()=>{img.hidden=true;caption.textContent='图片暂时无法加载，可打开官方原文查看。';button.disabled=true;};
 button.append(img);button.onclick=event=>{
  event.preventDefault();event.stopPropagation();
  const modal=node('dialog',null,{class:'patch-lightbox','aria-label':'公告图片预览'}),close=node('button','关闭图片',{type:'button'});
  close.onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());
  modal.append(close,node('img',null,{src:image.src,alt:image.alt,referrerpolicy:'no-referrer'}),node('a','打开官方原图 ↗',{href:image.src,target:'_blank',rel:'noopener noreferrer'}));
  document.body.append(modal);modal.showModal();
 };
 wrap.append(button,caption);return wrap;
}
function richArticle(article,current){
 const content=node('div',null,{class:'patch-rich-content'}),toc=node('details',null,{class:'patch-toc'}),links=node('div');
 toc.append(node('summary','章节导航'),links);let imageIndex=0,sectionIndex=0;
 const walk=n=>{
  if(n.type==='text')return document.createTextNode(n.text);
  if(n.type==='image')return picture(n,`放大公告图片 ${++imageIndex}`);
  const imageLink=n.tag==='a'&&(n.children||[]).some(c=>c.type==='image');
  const e=node(imageLink?'span':n.tag);
  if(n.tag==='a'&&!imageLink){e.href=n.href;e.target='_blank';e.rel='noopener noreferrer';}
  for(const child of n.children||[])e.append(walk(child));
  if(/^h[2-4]$/.test(n.tag)){
   e.id=`patch-section-${++sectionIndex}`;
   const jump=node('button',e.textContent,{type:'button'});jump.onclick=()=>{e.scrollIntoView({block:'start'});};links.append(jump);
  }
  return e;
 };
 if(current.cover)article.append(picture(current.cover,'放大公告封面'));
 for(const block of current.content)content.append(walk(block));
 if(sectionIndex)article.append(toc);article.append(content);
}
export function renderPatchNotes(root,{api,developer=false}) {
 const page=node('section',null,{class:'patch-page'});root.append(page);
 let data,query='',selected=null,busy=false,locale=getLanguage(),font=localStorage.getItem('patch-font')||'system';
 const en=()=>locale==='en-US',t=(zh,english)=>en()?english:zh;
 const status=node('p',t('正在读取公告…','Loading patch notes…'),{role:'status'});page.append(status);
 async function run(path,body){if(busy)return;busy=true;status.textContent=t('正在检查官方来源，请稍候…','Checking official sources…');try{data=await api(path,body,180000);paint();}catch(e){status.textContent=t(`未完成：${e.message}。已有公告保留。`,`Check failed: ${e.message}. Saved notes remain available.`);}finally{busy=false;}}
 function paint(){
  if(!page.isConnected)return;page.replaceChildren();page.dataset.font=font;page.lang=locale;
  page.append(node('p','OFFICIAL PATCH NOTES',{class:'eyebrow'}),node('h1',t(developer?'版本公告监测':'版本更新',developer?'Patch monitor':'Patch notes')));
  status.textContent=en()?({unchanged:'No updates: saved notes match the official sources.',updated:'Official notes updated.',failed:'Source check failed. Saved notes retained.',partial:'Some sources could not be checked.',not_checked:'Not checked yet.'}[data.state.status]||''):data.state.message;page.append(status);
  const date=x=>x?new Date(x).toLocaleString(locale):t('尚无记录','Not yet');
  page.append(node('p',t(`上次检查 ${date(data.state.lastCheckedAt)} · 自动检查 ${data.state.enabled?data.state.intervalHours+' 小时':'已关闭'}`,`Last checked ${date(data.state.lastCheckedAt)} · Scheduled checks ${data.state.enabled?'every '+data.state.intervalHours+' hours':'disabled'}`)));
  if(data.state.errors?.length)page.append(node('p',data.state.errors.join('；'),{class:'patch-error'}));
  if(data.state.entityIndexState)page.append(node('p',t(`图标索引：${data.state.entityIndexState.status} · ${data.state.entityIndexState.count??'—'} 个实体；自动按当前资料库重新关联。`,`Icon index: ${data.state.entityIndexState.status} · ${data.state.entityIndexState.count??'—'} entities; linked to the current library automatically.`)));
  page.append(node('p',t('卡片来自 Riot 官方公告；简中为官方繁中转简体，实体名称对齐本项目资料库，并非国服公告。官方中英文更新可能不同步。','Cards use Riot’s official English notes. Chinese and English publications may differ.')));
  const actions=node('div',null,{class:'patch-controls'}),check=node('button',t('检查最新公告','Check for updates'),{type:'button'});check.onclick=()=>run('/api/developer/patch-check',{});actions.append(check);
  const fonts=node('select',null,{'aria-label':t('公告字体','Patch font')});[['system',t('系统字体','System')],['sans',t('黑体 / 无衬线','Sans serif')],['serif',t('宋体 / 衬线','Serif')]].forEach(([value,label])=>fonts.append(node('option',label,{value})));fonts.value=font;fonts.onchange=()=>{font=fonts.value;localStorage.setItem('patch-font',font);paint();};actions.append(fonts);page.append(actions);
  if(developer){const enabled=node('input',null,{type:'checkbox','aria-label':t('自动检查版本公告','Enable scheduled checks')});enabled.checked=data.state.enabled;const hours=node('input',null,{type:'number',min:'1',max:'168','aria-label':t('公告检查间隔小时','Check interval hours')});hours.value=data.state.intervalHours;const save=node('button',t('保存公告周期','Save schedule'));save.onclick=()=>run('/api/developer/patch-schedule',{enabled:enabled.checked,intervalHours:Number(hours.value)});actions.append(enabled,hours,save);
   const sources=node('details');sources.append(node('summary',t('已保存的采集路径','Saved source URLs')));data.sources.forEach(s=>sources.append(node('a',s.url,{href:s.url,target:'_blank',rel:'noopener noreferrer'})));page.append(sources);
  }
  const form=node('form',null,{class:'patch-controls'}),input=node('input',null,{type:'search',placeholder:t('搜索版本或改动','Search patch or change'),'aria-label':t('搜索版本公告','Search patch notes')});input.value=query;form.onsubmit=e=>{e.preventDefault();query=input.value.trim();selected=null;paint();};const reset=node('button',t('重置','Reset'),{type:'button'});reset.onclick=()=>{query='';selected=null;paint();};form.append(input,node('button',t('搜索公告','Search'),{type:'submit'}),reset);page.append(form);
  const matches=data.articles.filter(a=>a.locale===(en()?'en-us':'zh-tw')&&`${a.title} ${a.body} ${a.simplified?.body||''} ${Object.values(a.cards||{}).flat().map(c=>c.name).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  if(!matches.length){page.append(node('p',t('没有匹配公告，请调整搜索条件或检查更新。','No matching notes. Change the search or check for updates.')));return;}
  const current=matches.find(a=>a.id===selected)||matches[0],display=en()?current:(current.simplified||current);
  const layout=node('div',null,{class:'patch-layout'}),list=node('nav',null,{'aria-label':t('公告列表','Patch list')}),article=node('article',null,{class:'patch-article'});
  matches.forEach(a=>{const b=node('button',`${a.patch}\n${en()?a.title:(a.simplified?.title||a.title)}`,{type:'button','aria-pressed':String(a.id===current.id)});b.onclick=()=>{selected=a.id;paint();};list.append(b);});
  article.append(node('h2',display.title),node('p',t(`来源发布 ${date(current.publishedAt)} · 本系统收录 ${date(current.fetchedAt)}`,`Published ${date(current.publishedAt)} · Synced ${date(current.fetchedAt)}`)),node('a',t('打开 Riot 官方原文 ↗','Read Riot’s original notes ↗'),{href:current.url,target:'_blank',rel:'noopener noreferrer'}),node('p',display.summary,{class:'patch-summary'}));
  const categories=[['champions','棋子变动','Champions'],['items','装备变动','Items'],['traits','羁绊变动','Traits'],['augments','海克斯变动','Augments'],['wisps','法杖变动','Wisps / Charms']];
  const jumps=node('div',null,{class:'patch-controls'});
  for(const [key,zh,english]of categories){const rows=current.cards?.[key]||[],section=node('section',null,{class:'patch-category',id:`patch-category-${key}`}),jump=node('button',`${t(zh,english)} (${rows.length})`,{type:'button'});jump.onclick=()=>section.scrollIntoView({block:'start'});jumps.append(jump);section.append(node('h3',t(zh,english)));
   if(!rows.length)section.append(node('p',t('此公告未识别到该分类条目，请以完整原文为准。','No entries identified in this category. Refer to the full original.')));
   const grid=node('div',null,{class:'patch-card-grid'});
   for(const row of rows){const card=node('div',null,{class:'patch-change-card'}),header=node('div',null,{class:'patch-card-heading'});
    if(row.icon){const img=node('img',null,{src:row.icon,alt:row.name,loading:'lazy',width:'48',height:'48'});img.onerror=()=>{img.replaceWith(node('span','◇',{class:'patch-icon-missing'}));};header.append(img);}else header.append(node('span','◇',{class:'patch-icon-missing',title:t('未匹配资料库图标','No verified catalog icon')}));
    header.append(node('h4',row.entityId?row.name:(row.name?.split(/[：:]/)[0]||t('其他改动','Other change'))));card.append(header,node('small',`${row.batch} · ${row.section}`));if(!row.icon)card.append(node('small',t('未找到唯一对应的资料库图片；保留原文，不猜配图。','No unique catalog image match; original text retained.')));card.append(node('p',row.body));grid.append(card);
   }section.append(grid);article.append(section);
  }
  article.insertBefore(jumps,article.querySelector('.patch-category'));
  const full=node('details',null,{class:'patch-full-original'});full.append(node('summary',t('完整官方原文（繁中，含系统改动与错误修复）','Full official article (including systems and bug fixes)')));let loaded=false;full.ontoggle=()=>{if(full.open&&!loaded){loaded=true;if(current.contentVersion===2)richArticle(full,current);else full.append(node('p',current.body));}};article.append(full);
  layout.append(list,article);page.append(layout);
 }
 window.addEventListener('languagechange',()=>{if(!page.isConnected)return;locale=getLanguage();selected=null;if(data)paint();});
 run('/api/patch-notes').then(()=>{if(page.isConnected&&data&&Date.now()-(data.state.lastCheckedAt||0)>300000)run('/api/developer/patch-check',{});});
}
