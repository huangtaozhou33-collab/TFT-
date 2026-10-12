// Read-only replay of the website statistics services. No model calls.
import {readFile,writeFile} from 'node:fs/promises';
import {compareResearchRows} from '../public/research-query.js';
const base='http://127.0.0.1:3001',checks=[];
const batch=JSON.parse(await readFile('docs/natural-language-acceptance/provider.json','utf8'));
for(const [index,r] of batch.records.entries()){
 const t=r.tools?.filter(t=>t.name==='query_tft_stats').at(-1);if(!t)continue;
 const q=r.result.queryState;let path,body;
 if(q.view==='holders')path=`/api/items/${q.itemId}/holders?rank=${q.rank}`;
 else if(q.view==='filter'){path='/api/research/query/v3';body={...q,dataSource:'metatft'};}
 else if(q.view==='builds'){path='/api/builds/query';body={...q,minSample:0};}
 else if(q.view==='champions')path=`/api/explorer?tab=units&rank=${q.rank}`;
 else continue;
 const res=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await res.json();
 let checked=0;const failures=[];
 const compare=(expected,actual,label)=>{
  if(expected.length!==actual.length)failures.push(label+':row_count');
  actual.forEach((a,i)=>{const b=expected[i];if(!b){failures.push(label+':missing');return;}
   if(a.id!==b.id)failures.push(label+':id');
   for(const key of ['sampleSize','avgPlacement','top4Rate','winRate'])if(a.stats?.[key]!==b.stats?.[key])failures.push(label+':'+key);
   checked++;
  });
 };
 if(q.view==='filter'){
  if((data.summary?.stats||data.stats)?.sampleSize!==t.result.stats?.sampleSize)failures.push('joint_population');
  for(const key of ['equipment','teammates','comps'])compare((data[key]?.rows||[]).slice(0,q.limit),t.result[key]?.rows||[],key);
 }else{
  let rows=data.rows||data.data||[];
  if(q.championId)rows=rows.filter(x=>(x.championId||x.id)===q.championId);
  compare(rows.filter(x=>x.stats?.sampleSize>=q.minSample).sort((a,b)=>compareResearchRows(a,b,q.sort)).slice(0,q.limit),t.result.data||[],q.view);
 }
 checks.push({question:index+1,view:q.view,httpStatus:res.status,rowsChecked:checked,pass:res.ok&&!failures.length,failures});
 console.log(JSON.stringify(checks.at(-1)));
}
await writeFile('docs/natural-language-acceptance/data-checks.json',JSON.stringify({modelCalls:0,checks},null,2));
if(checks.some(x=>!x.pass))process.exitCode=1;
