import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ROOT, readConfig } from './env.mjs';
import { aiStatus, checkAI } from './ai.mjs';
import { getCatalog, getMetaDecks, getSourceStatus, getChampionBuild, getItemHolders, getStatsOverview } from './data.mjs';
import { planEquipment, validatePlan, PlannerError } from './planner.mjs';
import { getTraitStats } from './trait-data.mjs';
import { getExplorerSnapshot } from './explorer-data.mjs';
import { getConditionalChampionBuild } from './conditional-builds.mjs';
import { getResearchResults } from './research.mjs';
import { handleDeveloperRequest } from './developer-api.mjs';
import { localRequest, publicPort } from './http-access.mjs';
import { patchNotes, startPatchMonitor } from './patch-notes.mjs';
import { startStatisticsScheduler } from './statistics-schedule.mjs';
import {CHAT_PROVIDERS,EMBEDDING_PROVIDERS,MODEL_OPTIONS,modelCapabilities} from './model-providers.mjs';
import {saveModelSelection} from './model-settings.mjs';
import {storageConfig} from './storage/config.mjs';

setDefaultResultOrder('ipv4first');
const publicDir = resolve(ROOT, 'public');
const port = Number(process.env.PORT) || readConfig().port;
const bindHost = process.env.HOST || '127.0.0.1';
const externalPort = publicPort(process.env.PUBLIC_PORT, port);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let activeChats = 0, checkingAI;
const headers = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store'
};
function send(res, status, data) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
const compress = promisify(gzip);
async function sendExplorer(req, res, data) {
  if (!/(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers['accept-encoding'] || '')) return send(res, 200, data);
  const contents = await compress(JSON.stringify(data));
  res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  res.end(contents);
}
async function bodyJSON(req) {
  const type = req.headers['content-type']?.split(';')[0];
  if (type !== 'application/json') throw Object.assign(new Error('请求必须使用 application/json'), { status: 415, code: 'INVALID_CONTENT_TYPE' });
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256000) throw Object.assign(new Error('请求体超过 256KB'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('请求体必须为有效 JSON 对象'), { status: 400, code: 'INVALID_JSON' }); }
}
export const server = http.createServer(async (req, res) => {
  try {
    if (!localRequest(req, { port, externalPort })) return send(res, 403, { code: 'ORIGIN_REJECTED', message: '仅允许本机访问' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/models'){
        const snapshot=()=>{const c=readConfig(),e=storageConfig().embedding;return {chat:{provider:c.provider,model:c.model,configured:Boolean(c.key),inference:c.inference},embedding:{provider:e.provider,model:e.model,dimensions:e.dimensions,configured:Boolean(e.key)},choices:{chat:CHAT_PROVIDERS,embedding:EMBEDDING_PROVIDERS},models:MODEL_OPTIONS,capabilities:Object.fromEntries(Object.entries(MODEL_OPTIONS).map(([p,models])=>[p,Object.fromEntries(models.map(m=>[m,modelCapabilities(p,m)]))]))};};
        if(req.method==='GET')return send(res,200,snapshot());
        if(req.method==='POST'){
          if(activeChats||checkingAI)return send(res,409,{code:'MODEL_BUSY',message:'请等待当前问答或连接测试结束再切换。'});
          const body=await bodyJSON(req);await saveModelSelection(body);
          return send(res,200,{...snapshot(),connectionTested:false,indexAction:body.target==='embedding'?'需按新模型配置核验或重建索引；不会自动调用付费Embedding。':null});
        }
        return send(res,405,{message:'Use GET or POST'});
      }
      if (url.pathname.startsWith('/api/developer/')) return await handleDeveloperRequest(req, res, url, { send, bodyJSON });
      if (req.method === 'GET') {
        if(url.pathname==='/api/statistics-version'){
          if(process.env.STORAGE_BACKEND!=='mysql')return send(res,200,{version:null});
          const {getPool,getActiveRelease}=await import('./storage/repository.mjs');
          const db=await getPool(),release=await getActiveRelease(db);
          const [[r]]=await db.execute('SELECT MAX(captured_at) latest FROM metatft_datasets WHERE release_id=?',[release?.id||'']);
          return send(res,200,{version:`${release?.id||''}:${release?.currentPatch||''}:${r.latest||0}`});
        }
        if(url.pathname==='/api/patch-notes'){if(process.env.STORAGE_BACKEND!=='mysql')return send(res,503,{message:'公告存储需要 MySQL 部署'});return send(res,200,await patchNotes());}
        if (url.pathname === '/api/health') return send(res, 200, { status: 'ok', version: '4.0.0', ai: aiStatus(), scope: '国际服 PC TFT · 单用户本机研究' });
        if (url.pathname === '/api/storage') {
          const { getStorageHealth } = await import('./storage/runtime.mjs');
          return send(res, 200, await getStorageHealth());
        }
        if (url.pathname === '/api/riot/status') {
          const { isDatabaseMode } = await import('./storage/runtime.mjs');
          if (!isDatabaseMode()) return send(res,200,{status:'not_configured',matches:{total:0,readyCurrent:0,quarantined:0,otherPatch:0},participantsCurrent:0});
          const { getRiotStatus } = await import('./riot/repository.mjs');
          return send(res, 200, await getRiotStatus());
        }
        if (url.pathname === '/api/comps' || url.pathname === '/api/comps/v2') {
          const { isDatabaseMode } = await import('./storage/runtime.mjs');
          if (url.pathname === '/api/comps' && isDatabaseMode()) return send(res,409,{code:'CLIENT_UPDATE_REQUIRED',message:'阵容首页已切换为 MetaTFT 体系统计，请刷新页面后查看。',endpoint:'/api/comps/v2'});
          const { getCompsOverview } = await import('./comps.mjs');
          return send(res, 200, await getCompsOverview({rank:url.searchParams.get('rank') ?? undefined}));
        }
        if (url.pathname === '/api/catalog') return send(res, 200, await getCatalog());
        if (url.pathname === '/api/glossary') {
          const { getPublishedGlossary } = await import('./knowledge/glossary.mjs');
          return send(res, 200, await getPublishedGlossary());
        }
        if (url.pathname === '/api/decks') return send(res, 200, await getMetaDecks({rank:url.searchParams.get('rank') ?? undefined}));
        if (url.pathname === '/api/stats') return send(res, 200, await getStatsOverview({rank:url.searchParams.get('rank') ?? undefined}));
        if (url.pathname === '/api/stats/traits') return send(res, 200, await getTraitStats({rank:url.searchParams.get('rank') ?? undefined}));
        if (url.pathname === '/api/explorer') return await sendExplorer(req, res, await getExplorerSnapshot(url.searchParams.get('tab') || 'units',{rank:url.searchParams.get('rank') ?? undefined}));
        if (url.pathname === '/api/mechanics') {
          const { getSeasonMechanic } = await import('./mechanics-data.mjs');
          return send(res, 200, await getSeasonMechanic());
        }
        if(url.pathname==='/api/library') {
          const {getLibrarySnapshot,getLibraryKnowledge}=await import('./library-data.mjs');
          if(url.searchParams.has('query')||url.searchParams.has('id')||url.searchParams.has('entityId'))return send(res,200,await getLibraryKnowledge({query:url.searchParams.get('query') || '',id:url.searchParams.get('id') || undefined,entityId:url.searchParams.get('entityId') || undefined}));
          return await sendExplorer(req,res,await getLibrarySnapshot());
        }
        if (url.pathname === '/api/sources') return send(res, 200, await getSourceStatus());
        const championBuild = url.pathname.match(/^\/api\/champions\/([^/]+)\/build$/);
        if (championBuild) return send(res, 200, await getChampionBuild(decodeURIComponent(championBuild[1]),{rank:url.searchParams.get('rank') ?? undefined}));
        const itemHolders = url.pathname.match(/^\/api\/items\/([^/]+)\/holders$/);
        if (itemHolders) return send(res, 200, await getItemHolders(decodeURIComponent(itemHolders[1]),{rank:url.searchParams.get('rank') ?? undefined}));
      }
      if (req.method === 'POST') {
        const body = await bodyJSON(req);
        if (url.pathname === '/api/knowledge/query') {
          if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 6000
            || body.entityId != null && (typeof body.entityId !== 'string' || !body.entityId.trim() || body.entityId.length > 256)
            || body.limit != null && (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 8)) {
            return send(res, 400, { code: 'INVALID_KNOWLEDGE_QUERY', message: '请提供非空知识问题（最多6000字）；limit须为1至8。' });
          }
          const { searchKnowledge } = await import('./knowledge/service.mjs');
          return send(res, 200, await searchKnowledge({ query: body.query.trim(), ...(body.entityId ? { entityId: body.entityId } : {}), ...(body.limit ? { limit: body.limit } : {}) }));
        }
        if (url.pathname === '/api/builds/query') return send(res, 200, await getConditionalChampionBuild(body));
        // An already-open v1 page assumes teammate.deckIds; never feed it the
        // incompatible same-participant statistics response after deployment.
        if (url.pathname === '/api/research/query') return send(res, 409, {
          code: 'CLIENT_UPDATE_REQUIRED',
          message: '筛选器已更新，请刷新页面后重试，当前筛选条件会保留。',
          endpoint: '/api/research/query/v2', schemaVersion: 2
        });
        // Already-open v2 pages retain their board/legacy semantics until reload.
        if (url.pathname === '/api/research/query/v2') return send(res, 200, await getResearchResults(body, { allowAggregate: false, allowMetaTft: false }));
        if (url.pathname === '/api/research/query/v3') return send(res, 200, { ...await getResearchResults(body), schemaVersion: 3 });
        if (url.pathname === '/api/team-code/decode') {
          const { decodeTeamCode } = await import('./team-code.mjs');
          return send(res, 200, await decodeTeamCode(body.code));
        }
        if (url.pathname === '/api/team-code/encode') {
          const { encodeTeamCode } = await import('./team-code.mjs');
          return send(res, 200, await encodeTeamCode(body.units));
        }
        if (url.pathname === '/api/plan') return send(res, 200, { plan: planEquipment(body.draft, await getCatalog()) });
        if (url.pathname === '/api/plan/validate') return send(res, 200, validatePlan(body.plan, body.draft, await getCatalog()));
        if (url.pathname === '/api/ai/test') {
          if (!checkingAI) checkingAI = checkAI().finally(() => { checkingAI = null; });
          const result = await checkingAI;
          return send(res, result.ready ? 200 : 503, result);
        }
        if (url.pathname === '/api/chat') {
          if (activeChats >= 2) return send(res, 429, { code: 'CHAT_BUSY', message: '已有两个问答请求正在进行，请稍后再试。' });
          activeChats++;
          try {
            const { answerChat } = await import('./chat.mjs');
            return send(res, 200, await answerChat(body));
          } finally { activeChats--; }
        }
      }
      return send(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: '不支持此方法' });
    const relative = decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const path = resolve(publicDir, '.' + relative);
    if (!path.startsWith(publicDir + sep)) return send(res, 404, { message: '文件不存在' });
    let contents;
    try { if (!(await stat(path)).isFile()) throw new Error(); contents = await readFile(path); } catch { return send(res, 404, { message: '文件不存在' }); }
    res.writeHead(200, { ...headers, 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    const status = error.status || (error instanceof PlannerError ? 400 : 500);
    send(res, status, { code: error.code || 'SERVER_ERROR', message: error.message || '服务请求失败', ...(typeof error.traceId === 'string' ? { traceId: error.traceId } : {}), ...(error.details ? { details: error.details } : {}) });
  }
});
server.requestTimeout = 240000;
server.headersTimeout = 10000;
server.listen(port, bindHost, () => { console.log(`TFT V4 本机服务: http://127.0.0.1:${externalPort}`); startStatisticsScheduler(); startPatchMonitor(); });
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `端口 ${port} 被占用，请修改 .env 中的 PORT` : '本机服务启动失败：' + err.message); process.exitCode = 1; });
