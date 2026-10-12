// Local-only diagnostics. The enclosing HTTP server enforces Host and Origin.
// Publishing, rollback execution, and index rebuilding have no HTTP authority.
export async function handleDeveloperRequest(req, res, url, { send, bodyJSON }) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '开发者模式只支持只读查询。' });
  }
  const path = url.pathname.slice('/api/developer/'.length);
  if(['patch-notes','patch-check','patch-schedule'].includes(path)){
    if(process.env.STORAGE_BACKEND!=='mysql')return send(res,503,{message:'公告存储需要 MySQL 部署'});
    const service=await import('./patch-notes.mjs');
    if(req.method==='GET')return send(res,200,await service.patchNotes());
    const body=await bodyJSON(req);
    if(path==='patch-check')return send(res,200,await service.checkPatchNotes());
    if(path==='patch-schedule')return send(res,200,await service.savePatchSchedule(body));
    return send(res,405,{message:'此接口只读'});
  }
  if (path === 'statistics-schedule' || path === 'statistics-run') {
    if(process.env.STORAGE_BACKEND!=='mysql')return send(res,503,{code:'DATABASE_REQUIRED',message:'统计调度需要 MySQL 部署。'});
    const scheduler=await import('./statistics-schedule.mjs');
    if(req.method==='GET')return send(res,200,await scheduler.statisticsSchedule());
    const body=await bodyJSON(req);
    return send(res,200,path==='statistics-run'?await scheduler.queueStatisticsJob(body.id):await scheduler.saveStatisticsSchedule(body));
  }
  if (req.method === 'POST' && !['retrieval', 'diff'].includes(path)) {
    return send(res, 403, { code: 'DEVELOPER_READONLY', message: '当前开发者模式为只读；发布、回滚执行和重建索引的操作权限尚未配置。' });
  }
  if (req.method === 'GET') {
    if (path === 'storage') {
      const { getStorageHealth } = await import('./storage/runtime.mjs');
      return send(res, 200, await getStorageHealth());
    }
    if (['overview', 'documents', 'document', 'releases'].includes(path)) {
      const data = await import('./developer-data.mjs');
      const filters = Object.fromEntries(url.searchParams);
      if (path === 'overview') {
        const { getStorageHealth } = await import('./storage/runtime.mjs');
        const [overview, storageRuntime] = await Promise.all([data.getDeveloperOverview(filters), getStorageHealth()]);
        return send(res, 200, { ...overview, storageRuntime });
      }
      if (path === 'documents') return send(res, 200, await data.getDeveloperDocuments(filters));
      if (path === 'releases') return send(res, 200, await data.getDeveloperReleases());
      if (path === 'document') {
        const document = await data.getDeveloperDocument(url.searchParams.get('id'));
        return document ? send(res, 200, document) : send(res, 404, { code: 'DOCUMENT_NOT_FOUND', message: '文档不在允许查看的知识包中。' });
      }
    }
    if (path === 'traces' || path === 'trace') {
      const traces = await import('./developer-traces.mjs');
      if (path === 'traces') return send(res, 200, await traces.listDeveloperTraces(Object.fromEntries(url.searchParams)));
      const trace = await traces.getDeveloperTrace(url.searchParams.get('id'));
      return trace ? send(res, 200, trace) : send(res, 404, { code: 'TRACE_NOT_FOUND', message: '调用记录不存在或已超过保留范围；服务重启会清空内存记录。' });
    }
    return send(res, 404, { code: 'NOT_FOUND', message: '开发者查询不存在。' });
  }
  const body = await bodyJSON(req);
  if (path === 'diff') {
    const { previewDeveloperDiff } = await import('./developer-data.mjs');
    return send(res, 200, await previewDeveloperDiff(body));
  }
  const { debugChatRetrieval } = await import('./chat.mjs');
  return send(res, 200, await debugChatRetrieval(body));
}
