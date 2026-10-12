// Explicit, paid acceptance only. Never invoked by npm test or health checks.
import {writeFile,mkdir} from 'node:fs/promises';
if(!process.argv.includes('--paid-provider'))throw Error('真实模型验收需显式 --paid-provider，会产生模型调用费用。');
const base='http://127.0.0.1:3001';
const H='DA_18_ElderDragon',V='DA_18_Veigar',S='DA_Artifact_SilvermereDawn',I='DA_InfinityEdge',B='DA_SpearOfShojin';
const c=(q,type,id,holder)=>q?.conditions?.some(x=>x.type===type&&x.id===id&&(holder===undefined||x.holderId===holder));
const tests=[
 {group:'holders',question:'密银黎明给谁比较合适？看全部段位，至少100个样本，按均次给我前三个。',check:q=>q?.view==='holders'&&q.itemId===S&&q.rank==='ALL'&&q.minSample===100&&q.sort==='avgPlacement'&&q.limit===3},
 {group:'holders',question:'改成光明无尽，按前四率排，其他不变。',check:q=>q?.view==='holders'&&q.itemId==='DA_InfinityEdgeRadiant'&&q.rank==='ALL'&&q.minSample===100&&q.sort==='top4Rate'&&q.limit===3},
 {group:'joint',question:'全部段位，我阵容里要有大龙和小法，大龙带密银，小法带青龙刀。帮我查这个组合的完整出装，出装看大龙，至少100样本，按均次前三。',check:q=>q?.view==='filter'&&q.rank==='ALL'&&q.carrierId===H&&q.resultView==='equipment'&&q.minSample===100&&q.limit===3&&q.conditions.length===4&&c(q,'champion',H)&&c(q,'champion',V)&&c(q,'item',S,H)&&c(q,'item',B,V)},
 {group:'joint',question:'再给大龙加一个无尽，其他条件保持。',check:q=>q?.view==='filter'&&q.conditions.length===5&&c(q,'item',I,H)&&c(q,'item',S,H)&&c(q,'item',B,V)&&q.carrierId===H},
 {group:'joint',question:'去掉小法这个棋子条件，他的青龙刀保留，改成任意人拿。',check:q=>q?.view==='filter'&&!c(q,'champion',V)&&c(q,'item',B,null)&&c(q,'item',I,H)&&c(q,'item',S,H)&&q.conditions.length===4},
 {group:'joint',question:'去掉青龙刀，把密银也改成任意人持有，无尽还给大龙。改看黄金，门槛50，按前四率给两条。',check:q=>q?.view==='filter'&&!c(q,'item',B)&&c(q,'item',S,null)&&c(q,'item',I,H)&&q.rank==='GOLD'&&q.minSample===50&&q.sort==='top4Rate'&&q.limit===2&&q.conditions.length===3},
 {group:'joint',question:'现在换一个问题：全部段位小法的整体平均名次是多少？不限样本。',check:q=>q?.view==='champions'&&q.championId===V&&q.rank==='ALL'&&q.minSample===0&&!q.conditions},
 {group:'unbound',question:'全部段位查有大龙而且阵容里有密银的组合，不要求大龙携带，先看同场队友，至少100样本给三条。',check:q=>q?.view==='filter'&&c(q,'champion',H)&&c(q,'item',S,null)&&q.resultView==='teammates'},
 {group:'duplicate',question:'全部段位小法拿两把青龙刀时完整出装有哪些？至少100样本给前三套。',check:q=>q?.view==='filter'&&c(q,'champion',V)&&q.conditions.filter(x=>x.type==='item'&&x.id===B&&x.holderId===V).length===2&&q.carrierId===V&&q.resultView==='equipment'},
 {group:'duplicate',question:'拿掉其中一把青龙刀，再给他加无尽，按登顶率排序。',check:q=>q?.view==='filter'&&q.conditions.filter(x=>x.type==='item'&&x.id===B&&x.holderId===V).length===1&&c(q,'item',I,V)&&q.sort==='winRate'},
 {group:'builds',question:'黄金小法的三件套，必须有青龙刀但不要无尽，至少100样本，均次最低的两套。',check:q=>q?.view==='builds'&&q.championId===V&&q.rank==='GOLD'&&q.requiredItemIds?.includes(B)&&q.excludedItemIds?.includes(I)&&q.minSample===100&&q.limit===2},
 {group:'unsupported',question:'全部段位找有大龙但是不能有小法的阵容交集，还要任意人带密银，至少100样本。',clarify:true,check:(q,r,t)=>!q&&t.tools.some(x=>x.name==='clarify_query')&&r.reply.length>0}
];
const records=[],sessions=new Map();
await mkdir('docs/natural-language-acceptance',{recursive:true});
for(const spec of tests){
 const session=sessions.get(spec.group)||{history:[],queryState:null};
 const messages=[...session.history,{role:'user',content:spec.question}].slice(-16);
 const started=Date.now();
 let record;
 try{
  const res=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,pageContext:{view:'comps',rank:'PLATINUM_PLUS',readonly:true,...(session.queryState?{queryState:session.queryState}:{})}}),signal:AbortSignal.timeout(390000)});
  const result=await res.json();const trace=result.traceId?await(await fetch(base+'/api/developer/trace?id='+result.traceId)).json():{tools:[]};
  record={question:spec.question,group:spec.group,httpStatus:res.status,elapsedMs:Date.now()-started,semanticPass:res.ok&&Boolean(spec.check(result.queryState,result,trace)),result,tools:trace.tools?.map(t=>({name:t.name,args:t.args,status:t.status,result:t.result})),truncated:trace.storageTruncated};
  session.history=[...messages,{role:'assistant',content:result.reply||result.message||'查询失败'}];if(result.queryState)session.queryState=result.queryState;sessions.set(spec.group,session);
 }catch(error){record={question:spec.question,group:spec.group,semanticPass:false,error:error.message,elapsedMs:Date.now()-started};}
 records.push(record);await writeFile('docs/natural-language-acceptance/provider.json',JSON.stringify({paidProvider:true,createdAt:new Date().toISOString(),records},null,2));
 console.log(JSON.stringify({n:records.length,question:record.question,pass:record.semanticPass,ms:record.elapsedMs,query:record.result?.queryState,status:record.tools?.filter(t=>t.name==='query_tft_stats').map(t=>t.result.status),tools:record.tools?.map(t=>t.name),error:record.error||record.result?.message}));
}
console.log(JSON.stringify({total:records.length,passed:records.filter(r=>r.semanticPass).length}));
