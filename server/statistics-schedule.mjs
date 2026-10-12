import { randomUUID } from 'node:crypto';
import { getPool, getActiveRelease } from './storage/repository.mjs';
import { getCatalog } from './data.mjs';
import { RANK_OPTIONS } from '../public/stat-ranks.js';

export const STATISTICS_JOBS = [
  {id:'meta-comps',name:'MetaTFT 阵容榜',kind:'comps',paths:['https://api-hc.metatft.com/tft-comps-api/comps_data','https://api-hc.metatft.com/tft-comps-api/comps_stats']},
  {id:'meta-overall',name:'MetaTFT 棋子 / 装备 / 羁绊榜',kind:'overall',paths:['https://api-hc.metatft.com/tft-explorer-api/{total,units_unique,items_unique,traits}']},
  {id:'meta-builds',name:'MetaTFT 全棋子出装',kind:'builds',paths:['https://api-hc.metatft.com/tft-explorer-api/unit_builds/{championId}']},
  {id:'meta-holders',name:'MetaTFT 全装备持有者',kind:'holders',paths:['https://api-hc.metatft.com/tft-explorer-api/item_units_unique/{itemId}-1']},
  {id:'opgg-reference',name:'OP.GG 独立参考数据',kind:'reference',paths:['https://mcp-api.op.gg/mcp → tft_list_meta_decks','tft_get_champion_item_build(champion_id)','tft_list_champions_for_item(item_id)']},
];
const HOUR=3600000;
const json=v=>typeof v==='string'?JSON.parse(v):v;
export function validateSchedule(body) {
  if(!STATISTICS_JOBS.some(j=>j.id===body.id)||typeof body.enabled!=='boolean'||!Number.isInteger(body.intervalHours)||body.intervalHours<1||body.intervalHours>168||!Number.isInteger(body.revision)||body.revision<1)
    throw Object.assign(new Error('请选择有效任务，周期为 1～168 小时整数。'),{status:400,code:'INVALID_SCHEDULE'});
  return body;
}
export async function ensureStatisticsJobs(db=null) {
  db??=await getPool();
  for(const j of STATISTICS_JOBS)await db.execute('INSERT IGNORE INTO statistics_jobs(id,next_run_at) VALUES(?,?)',[j.id,Date.now()+24*HOUR]);
}
export async function statisticsSchedule() {
  const db=await getPool();await ensureStatisticsJobs(db);
  const [rows]=await db.query('SELECT * FROM statistics_jobs');
  const [runs]=await db.query('SELECT * FROM statistics_job_runs ORDER BY started_at DESC LIMIT 20');
  return {jobs:STATISTICS_JOBS.map(j=>{const r=rows.find(r=>r.id===j.id);return {...j,enabled:Boolean(r.enabled),intervalHours:r.interval_hours,revision:r.revision,status:r.status,nextRunAt:Number(r.next_run_at),lastStartedAt:r.last_started_at==null?null:Number(r.last_started_at),lastFinishedAt:r.last_finished_at==null?null:Number(r.last_finished_at),lastSuccessAt:r.last_success_at==null?null:Number(r.last_success_at),progress:json(r.progress)};}),runs:runs.map(r=>({...r,report:json(r.report)})),
    note:'周期从保存或上次完成时起计算。服务停止时不采集，恢复后补一次到期任务，不补跑每个漏掉的周期。MetaTFT 覆盖全部 12 种段位范围；OP.GG 只作独立参考，不替代页面统计。资料库不参与定时同步；复杂筛选按需缓存 10 分钟。'};
}
export async function saveStatisticsSchedule(body) {
  validateSchedule(body);const db=await getPool();await ensureStatisticsJobs(db);
  const [r]=await db.execute('UPDATE statistics_jobs SET enabled=?,interval_hours=?,next_run_at=?,revision=revision+1 WHERE id=? AND revision=?',[body.enabled,body.intervalHours,Date.now()+body.intervalHours*HOUR,body.id,body.revision]);
  if(!r.affectedRows)throw Object.assign(new Error('配置已被更新，请刷新后重试。'),{status:409,code:'SCHEDULE_CONFLICT'});
  return statisticsSchedule();
}
export async function queueStatisticsJob(id) {
  if(!STATISTICS_JOBS.some(j=>j.id===id))throw Object.assign(new Error('未知统计任务。'),{status:400});
  const db=await getPool();await ensureStatisticsJobs(db);
  const cooldown=await statisticsSourceCooldown(db,id);
  if(cooldown>Date.now())throw Object.assign(new Error('来源要求等待，当前限流冷却尚未结束。'),{status:429,code:'SOURCE_COOLDOWN'});
  const [r]=await db.execute("UPDATE statistics_jobs SET status='queued',next_run_at=?,revision=revision+1 WHERE id=? AND status NOT IN ('running','queued')",[Date.now(),id]);
  if(!r.affectedRows)throw Object.assign(new Error('任务已经排队或正在运行。'),{status:409,code:'JOB_BUSY'});
  return statisticsSchedule();
}
export async function statisticsSourceCooldown(db,id){
  const [rows]=await db.execute('SELECT last_finished_at,progress FROM statistics_jobs WHERE id LIKE ?',[id.startsWith('meta-')?'meta-%':'opgg-reference']);
  return Math.max(0,...rows.map(r=>Number(r.last_finished_at||0)+Number(json(r.progress)?.retryAfterMs||0)));
}
const retryDelay=e=>e.retryAfterMs||([403,429].includes(e.httpStatus)?HOUR:0);
export function statisticsTasks(kind,catalog) {
  const ids=kind==='builds'?catalog.champions.map(x=>x.id):kind==='holders'?catalog.items.map(x=>x.id):[''];
  return RANK_OPTIONS.flatMap(([rank])=>ids.map(entityId=>({kind,rank,entityId})));
}
export async function collectStatisticsJob(job,{progress=async()=>{},guard=async()=>{},catalog,release,metadata,load,read}={}) {
  catalog??=await getCatalog();release??=await getActiveRelease();
  if(job.kind==='reference')return collectReference(catalog,release,progress,guard);
  const {loadMetaDataset}=await import('./metatft/datasets.mjs');
  const {getMetaTftMetadata,readMetaTft}=await import('./metatft/client.mjs');
  metadata??=await getMetaTftMetadata({force:true});load??=loadMetaDataset;read??=readMetaTft;
  const tasks=statisticsTasks(job.kind,catalog),report={target:tasks.length,completed:0,changed:0,unchanged:0,failed:0,empty:0,errors:[],requestedPatch:metadata.patch.patch+(metadata.patch.b_patch_version||''),sourcePatch:null};
  let next=0,consecutive=0;
  const paced=async path=>{await new Promise(r=>setTimeout(r,Math.max(0,next-Date.now())));next=Date.now()+500;return read(path);};
  for(const task of tasks){
    await guard();
    try{
      const r=await load(task.kind,task.entityId,catalog,{rank:task.rank,force:true,ttlMs:job.intervalHours*HOUR,getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,readMetaTft:paced});
      report[r.unchanged?'unchanged':'changed']++;if(!r.rows.length)report.empty++;consecutive=0;
    }catch(e){report.failed++;consecutive++;if(report.errors.length<20)report.errors.push({...task,code:e.code||'SYNC_FAILED',httpStatus:e.httpStatus||null});
      // Stop this batch on access restriction/rate limit; never evade or hammer it.
      if([403,429].includes(e.httpStatus)||consecutive>=3){report.stopped=true;report.httpStatus=e.httpStatus||null;report.retryAfterMs=retryDelay(e);report.completed++;break;}
    }
    report.completed++;if(report.completed%20===0)await progress(report);
  }
  await progress(report);return report;
}
export function referenceScope(body,{tool,args,release}) {
  return {tool,args,season:release.season,requestedPatch:release.currentPatch,
    sourcePatch:typeof body?.version==='string'&&/^\d+\.\d+[a-z]*$/.test(body.version)?body.version:null,
    sourceTime:body?.metadata?.gameStatDateTime??null,rank:null,region:null,window:null};
}
async function collectReference(catalog,release,progress,guard) {
  const {OPGGClient,unwrapTool}=await import('../scripts/opgg-client.mjs');
  const {validateSourceRecord,sha256,stableJSON}=await import('../scripts/stats-cache.mjs');
  const db=await getPool(),client=new OPGGClient('https://mcp-api.op.gg/mcp');
  const tasks=[['tft_list_meta_decks',{}],...catalog.champions.map(x=>['tft_get_champion_item_build',{champion_id:x.id}]),...catalog.items.filter(x=>x.kind!=='component').map(x=>['tft_list_champions_for_item',{item_id:x.id}])];
  const report={target:tasks.length,completed:0,changed:0,unchanged:0,unsupported:0,failed:0,scope:'source_defined',sourcePatch:null};
  try{await progress(report);await client.initialize();for(const [tool,args] of tasks){
    await guard();
    const def=client.tools.find(t=>t.name===tool),key=Object.keys(args)[0],allowed=def?.inputSchema?.properties?.[key]?.enum;
    if(!def||(allowed&&!allowed.includes(args[key]))){report.unsupported++;report.completed++;continue;}
    const result=await client.call(tool,args),body=unwrapTool(result),raw={status:'ok',fetchedAt:new Date().toISOString(),endpoint:client.endpoint,tool,args,result,body};
    validateSourceRecord(raw,catalog);
    const queryKey=sha256(stableJSON({tool,args})),hash=sha256(stableJSON(body)),id=sha256(`${release.id}:${queryKey}:${hash}`),now=Date.now();
    const [existing]=await db.execute('SELECT id FROM statistics_reference_snapshots WHERE id=?',[id]);
    await db.execute('INSERT INTO statistics_reference_snapshots(id,release_id,source,query_key,query_scope,raw_response,content_hash,captured_at,checked_at) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE checked_at=VALUES(checked_at),query_scope=VALUES(query_scope)',[id,release.id,'opgg',queryKey,JSON.stringify(referenceScope(body,{tool,args,release})),JSON.stringify(raw),hash,now,now]);
    report[existing.length?'unchanged':'changed']++;report.completed++;if(report.completed%5===0)await progress(report);
    await new Promise(r=>setTimeout(r,750));
  }}catch(e){e.syncReport={...report,failed:1,code:e.code||'SYNC_FAILED',layer:e.layer||null,httpStatus:e.httpStatus||null,retryAfterMs:retryDelay(e)};throw e;}
  finally{await client.close().catch(()=>{});}return report;
}
let timer,busy=false;
export async function tickStatisticsScheduler() {
  if(busy)return;busy=true;let connection;
  try{
    const db=await getPool();await ensureStatisticsJobs(db);connection=await db.getConnection();
    const [[lock]]=await connection.query("SELECT GET_LOCK('tft_statistics_scheduler',0) acquired");if(lock.acquired!==1)return;
    // Owning the advisory lock proves the prior worker is gone; retain its partial progress.
    await db.execute("UPDATE statistics_job_runs SET status='interrupted',finished_at=? WHERE status='running'",[Date.now()]);
    await db.query("UPDATE statistics_jobs SET status='interrupted' WHERE status='running'");
    const [jobs]=await db.execute("SELECT * FROM statistics_jobs WHERE (enabled=1 OR status='queued') AND next_run_at<=? ORDER BY next_run_at,id LIMIT 1",[Date.now()]);
    if(!jobs.length)return;
    const row=jobs[0],definition=STATISTICS_JOBS.find(x=>x.id===row.id);if(!definition)return;
    const cooldown=await statisticsSourceCooldown(db,row.id);
    if(cooldown>Date.now()){await db.execute('UPDATE statistics_jobs SET next_run_at=? WHERE id=?',[cooldown,row.id]);return;}
    const id=randomUUID(),started=Date.now();
    await db.execute("INSERT INTO statistics_job_runs(id,job_id,started_at,status) VALUES(?,?,?,'running')",[id,row.id,started]);
    await db.execute("UPDATE statistics_jobs SET status='running',last_started_at=?,progress=NULL WHERE id=?",[started,row.id]);
    let report,status;
    try{report=await collectStatisticsJob({...definition,intervalHours:row.interval_hours},{guard:async()=>{
      const [[owner]]=await connection.query("SELECT IS_USED_LOCK('tft_statistics_scheduler')=CONNECTION_ID() owned");
      if(owner.owned!==1)throw Object.assign(new Error('Scheduler lock lost'),{code:'SCHEDULER_LOCK_LOST'});
    },progress:async report=>{await db.execute('UPDATE statistics_jobs SET progress=? WHERE id=?',[JSON.stringify(report),row.id]);await db.execute('UPDATE statistics_job_runs SET report=? WHERE id=?',[JSON.stringify(report),id]);}});status=report.failed||report.stopped?'partial':'success';}
    catch(e){report=e.syncReport||{failed:1,code:e.code||'SYNC_FAILED',httpStatus:e.httpStatus||null,retryAfterMs:retryDelay(e)};status='failed';}
    const now=Date.now();
    await db.execute('UPDATE statistics_job_runs SET status=?,finished_at=?,report=? WHERE id=?',[status,now,JSON.stringify(report),id]);
    await db.execute('UPDATE statistics_jobs SET status=?,last_finished_at=?,last_success_at=IF(?=\'success\',?,last_success_at),progress=?,next_run_at=?+GREATEST(interval_hours*3600000,?),revision=revision+1 WHERE id=?',[status,now,status,now,JSON.stringify(report),now,report.retryAfterMs||0,row.id]);
  }finally{if(connection){await connection.query("SELECT RELEASE_LOCK('tft_statistics_scheduler')").catch(()=>{});connection.release();}busy=false;}
}
export function startStatisticsScheduler(){
  if(timer||process.env.STORAGE_BACKEND!=='mysql')return;
  const tick=()=>tickStatisticsScheduler().catch(()=>console.error('Statistics scheduler unavailable; saved schedules and previous snapshots are retained.'));
  timer=setInterval(tick,15000);timer.unref();tick();
}
