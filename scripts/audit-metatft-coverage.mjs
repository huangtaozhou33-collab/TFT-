import { readFile, writeFile } from 'node:fs/promises';
import { getPool, closeDatabase } from '../server/storage/repository.mjs';
import { sha256 } from './stats-cache.mjs';
import { metaStats } from '../server/metatft/query.mjs';
import { rankScope } from '../public/stat-ranks.js';

const parse=v=>typeof v==='string'?JSON.parse(v):v;
const input=process.argv[2]||'data/metatft/collection-latest.json',output=process.argv[3]||'docs/METATFT_COVERAGE_AUDIT.json';
try {
  const report=JSON.parse(await readFile(input,'utf8')),db=await getPool(),tasks=report.results.filter(r=>r.status!=='error');
  const audit={auditedAt:new Date().toISOString(),reportComplete:report.complete,releaseId:report.releaseId,requestedPatch:report.requestedPatch,sourcePatch:null,
    target:report.target,datasets:0,statisticRows:0,rawResponseBodies:0,rawBytes:0,modelCalled:false,failures:[],ranks:{},emptyEntities:[],sourceUnmapped:{},exhaustive:false};
  for(const r of report.results.filter(r=>r.status==='error'))audit.failures.push({rank:r.rank,kind:r.kind,id:r.entityId,code:r.code});
  for(let offset=0;offset<tasks.length;offset+=12){
    const batch=tasks.slice(offset,offset+12),ids=batch.map(x=>x.snapshotId),marks=ids.map(()=>'?').join(',');
    const [snapshots]=await db.execute(`SELECT id,release_id,query_scope,summary,raw_response_text,content_hash FROM metatft_datasets WHERE id IN (${marks})`,ids);
    const [rows]=await db.execute(`SELECT dataset_id,placement_count,sample_size,avg_placement,payload FROM metatft_dataset_rows WHERE dataset_id IN (${marks})`,ids);
    for(const task of batch){
      const s=snapshots.find(s=>s.id===task.snapshotId),list=rows.filter(r=>r.dataset_id===task.snapshotId);
      if(!s){audit.failures.push({snapshotId:task.snapshotId,code:'MISSING_SNAPSHOT'});continue;}
      const scope=parse(s.query_scope),summary=parse(s.summary);
      if(s.release_id!==report.releaseId||scope.kind!==task.kind||scope.entityId!==task.entityId||scope.ranks.join(',')!==rankScope(task.rank).join(',')||scope.patch+scope.bPatch!==report.requestedPatch) audit.failures.push({snapshotId:s.id,code:'SCOPE_MISMATCH'});
      if(sha256(s.raw_response_text)!==s.content_hash)audit.failures.push({snapshotId:s.id,code:'RAW_HASH_MISMATCH'});
      if(list.length!==task.rows||list.length!==summary.rowCount)audit.failures.push({snapshotId:s.id,code:'ROW_COUNT_MISMATCH'});
      for(const body of Object.values(JSON.parse(s.raw_response_text))){
        audit.rawResponseBodies++;audit.rawBytes+=Buffer.byteLength(body.bodyText);
        if(sha256(body.bodyText)!==body.contentHash)audit.failures.push({snapshotId:s.id,code:'BODY_HASH_MISMATCH'});
        const url=new URL(body.url);if(url.searchParams.has('rank')&&url.searchParams.get('rank')!==rankScope(task.rank).join(','))audit.failures.push({snapshotId:s.id,code:'REQUEST_RANK_MISMATCH'});
      }
      for(const r of list){
        const metrics=metaStats(parse(r.placement_count)),payload=parse(r.payload);
        if(metrics.sampleSize!==r.sample_size||metrics.sampleSize!==payload.stats.sampleSize||Math.abs(metrics.avgPlacement-Number(r.avg_placement))>1e-8||['avgPlacement','winRate','top4Rate'].some(k=>Math.abs(metrics[k]-payload.stats[k])>1e-10))audit.failures.push({snapshotId:s.id,code:'METRIC_MISMATCH'});
      }
      const rank=audit.ranks[task.rank]??={datasets:0,rows:0,builds:0,holders:0,empty:0,categories:{}};
      rank.datasets++;rank.rows+=list.length;if(task.kind==='builds')rank.builds++;if(task.kind==='holders'){rank.holders++;rank.categories[task.category]=(rank.categories[task.category]||0)+1;}
      if(!list.length){rank.empty++;audit.emptyEntities.push({rank:task.rank,kind:task.kind,id:task.entityId,sourceRows:task.sourceRows,reason:'no_accepted_rows_in_source_response'});}
      if(task.kind==='overall')audit.sourceUnmapped[task.rank]=summary.skipped;
      audit.datasets++;audit.statisticRows+=list.length;
    }
    if((offset+12)%240===0)console.log(JSON.stringify({verified:audit.datasets,rows:audit.statisticRows,errors:audit.failures.length}));
  }
  audit.passed=report.complete&&audit.datasets===report.target&&!audit.failures.length;
  await writeFile(output,JSON.stringify(audit,null,2));
  console.log(JSON.stringify({passed:audit.passed,datasets:audit.datasets,rows:audit.statisticRows,bodies:audit.rawResponseBodies,errors:audit.failures.length}));
  if(!audit.passed)process.exitCode=1;
}finally{await closeDatabase();}
