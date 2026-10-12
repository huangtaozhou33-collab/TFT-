import { sha256 } from '../../scripts/stats-cache.mjs';

const ORIGIN = 'https://api-hc.metatft.com';
export const metaError = (message, code = 'METATFT_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status });
export async function readMetaTft(path, fetchImpl = fetch) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw metaError('统计请求地址无效。', 'INVALID_PROVIDER_URL', 400);
  let response, text;
  try {
    response = await fetchImpl(url.href, { signal: AbortSignal.timeout(18000), redirect: 'error', headers: { Accept: 'application/json' } });
    text = await response.text();
  } catch { throw metaError('MetaTFT 暂时无法连接，请稍后重试；当前条件已保留。'); }
  if (!response.ok) {
    const retry=response.headers?.get('retry-after'), seconds=Number(retry);
    const retryAfterMs=retry ? (Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(retry)-Date.now())) : 0;
    throw Object.assign(metaError(`MetaTFT 暂未完成查询（HTTP ${response.status}），请稍后重试。`),{httpStatus:response.status,retryAfterMs:Number.isFinite(retryAfterMs)?retryAfterMs:0});
  }
  if (Buffer.byteLength(text) > 12_000_000) throw metaError('MetaTFT 返回的数据超出预期范围。', 'METATFT_RESPONSE_INVALID');
  let data;
  try { data = JSON.parse(text); } catch { throw metaError('MetaTFT 返回格式发生变化，请稍后重试。', 'METATFT_RESPONSE_INVALID'); }
  return { url: url.href, fetchedAt: new Date().toISOString(), contentHash: sha256(text), bodyText: text, data };
}

let metadataPromise, metadataUntil = 0;
export async function getMetaTftMetadata({force=false}={}) {
  if(!force&&process.env.STORAGE_BACKEND==='mysql'){
    const {getPool,getActiveRelease}=await import('../storage/repository.mjs');
    const db=await getPool(),release=await getActiveRelease(db);
    if(release){
      const [rows]=await db.execute("SELECT source_metadata FROM metatft_datasets WHERE release_id=? AND JSON_UNQUOTE(JSON_EXTRACT(query_scope,'$.patch'))=? ORDER BY captured_at DESC LIMIT 1",[release.id,release.currentPatch]);
      if(rows.length)return typeof rows[0].source_metadata==='string'?JSON.parse(rows[0].source_metadata):rows[0].source_metadata;
    }
  }
  if(force){metadataPromise=null;metadataUntil=0;}
  if (!metadataPromise || Date.now() >= metadataUntil) {
    metadataUntil = Date.now() + 60000;
    metadataPromise = Promise.all([readMetaTft('/tft-stat-api/patch'), readMetaTft('/tft-comps-api/unit_items_processed')])
      .then(([patch, set]) => ({ patch: patch.data, set: set.data.tft_set, capturedAt: patch.fetchedAt,
        requests: [patch, { url: set.url, fetchedAt: set.fetchedAt, contentHash: set.contentHash, data: { tft_set: set.data.tft_set, updated: set.data.updated, queue_id: set.data.queue_id } }] }))
      .catch(error => { metadataPromise = null; throw error; });
  }
  return metadataPromise;
}
