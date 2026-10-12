import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getCatalog } from '../server/data.mjs';
import { getActiveRelease, closeDatabase } from '../server/storage/repository.mjs';
import { loadMetaDataset } from '../server/metatft/datasets.mjs';
import { getMetaTftMetadata, readMetaTft } from '../server/metatft/client.mjs';
import { RANK_OPTIONS, rankScope } from '../public/stat-ranks.js';

export function collectionTasks(catalog, ranks=RANK_OPTIONS.map(([id])=>id)) {
  for(const rank of ranks)rankScope(rank);
  return ranks.flatMap(rank=>[
    ...['overall','comps'].map(kind=>({rank,kind,entityId:''})),
    ...catalog.champions.map(x=>({rank,kind:'builds',entityId:x.id})),
    ...catalog.items.map(x=>({rank,kind:'holders',entityId:x.id,category:x.category}))
  ]);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// All workers share spacing, including retries and multi-endpoint datasets.
export function pacedReader(read=readMetaTft, interval=250) {
  let next=0, cooldown=0;
  return async path=>{
    for(let attempt=0;;attempt++) {
      const at=Math.max(Date.now(),next,cooldown);next=at+interval;await sleep(Math.max(0,at-Date.now()));
      await sleep(Math.max(0,cooldown-Date.now()));
      try{return await read(path);}catch(error){
        if(attempt>=2 || error.code!=='METATFT_UNAVAILABLE')throw error;
        cooldown=Math.max(cooldown,Date.now()+(error.retryAfterMs || 2000*2**attempt));
      }
    }
  };
}
export async function collectCatalogue({catalog,release,metadata,ranks,load=loadMetaDataset,read=pacedReader(),checkpoint=async()=>{},concurrency=3}) {
  const tasks=collectionTasks(catalog,ranks), startedAt=new Date().toISOString();
  const report={schemaVersion:1,source:'MetaTFT',releaseId:release.id,requestedPatch:metadata.patch.patch+(metadata.patch.b_patch_version||''),sourcePatch:null,startedAt,
    ranks:[...new Set(tasks.map(t=>t.rank))],catalog:{champions:catalog.champions.length,items:catalog.items.length},target:tasks.length,
    modelCalled:false,results:[],complete:false,exhaustive:false,
    limitation:'按当前目录逐个采集整体、阵容体系、棋子出装与装备持有者（含散件）。保存完整来源响应；来源候选可能截断，无分页契约，不能声称收录全部可能组合或原始比赛。'};
  let cursor=0, saves=Promise.resolve();
  async function worker(){
    while(cursor<tasks.length){
      const task=tasks[cursor++];
      try {
        const result=await load(task.kind,task.entityId,catalog,{rank:task.rank,getActiveRelease:async()=>release,getMetaTftMetadata:async()=>metadata,readMetaTft:read});
        report.results.push({...task,status:result.rows.length?'ok':'empty',snapshotId:result.snapshot.id,cacheHit:result.cacheHit,rows:result.rows.length,sourceRows:result.snapshot.summary.sourceRows,excluded:result.snapshot.summary.skipped,
          sourceCandidateLimitUnverified:true,capturedAt:result.evidence.fetchedAt});
      }catch(error){report.results.push({...task,status:'error',code:error.code||'COLLECTION_ERROR',message:error.message});}
      if(report.results.length%20===0||cursor===tasks.length){
        const snapshot=structuredClone(report);saves=saves.then(()=>checkpoint(snapshot));await saves;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(3,Math.max(1,concurrency))},worker));await saves;
  report.finishedAt=new Date().toISOString();report.complete=report.results.length===tasks.length&&report.results.every(r=>r.status!=='error');
  report.summary={datasets:report.results.filter(r=>r.status!=='error').length,rows:report.results.reduce((n,r)=>n+(r.rows||0),0),empty:report.results.filter(r=>r.status==='empty').length,failed:report.results.filter(r=>r.status==='error').length};
  await checkpoint(report);return report;
}
async function main(){
  const {values}=parseArgs({options:{apply:{type:'boolean'},rank:{type:'string',multiple:true},out:{type:'string'}}});
  if(!values.apply)throw new Error('Use --apply to explicitly collect public MetaTFT statistics into MySQL. No models are called.');
  const file=resolve(values.out||'data/metatft/collection-latest.json');await mkdir(resolve(file,'..'),{recursive:true});
  try {
    const catalog=await getCatalog(),release=await getActiveRelease(),metadata=await getMetaTftMetadata();
    const report=await collectCatalogue({catalog,release,metadata,ranks:values.rank,checkpoint:async r=>{
      await writeFile(file+'.tmp',JSON.stringify(r,null,2));await rename(file+'.tmp',file);
      console.log(JSON.stringify({completed:r.results.length,target:r.target,errors:r.results.filter(x=>x.status==='error').length,...(r.summary?{summary:r.summary}:{} )}));
    }});
    if(!report.complete)process.exitCode=1;
  }finally{await closeDatabase();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
