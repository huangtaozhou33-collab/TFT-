import { sha256 } from '../../scripts/stats-cache.mjs';
import { storageConfig } from '../storage/config.mjs';

export function indexProfile(config=storageConfig()) {
  const profile={model:config.embedding.model,baseUrl:config.embedding.baseUrl,dimensions:config.embedding.dimensions,chunker:'conditional-groups-v1',scopeSchema:'patch-or-editorial-glossary-v1',metric:'COSINE'};
  return {...profile,hash:sha256(profile)};
}
const failure = (message, code) => Object.assign(new Error(message), { code });
export function embeddingEndpoint(config=storageConfig()) {
  const embedding = config?.embedding;
  if (!embedding || typeof embedding.key !== 'string' || !embedding.key.trim() || typeof embedding.model !== 'string' || !embedding.model.trim()
    || typeof embedding.baseUrl !== 'string' || !embedding.baseUrl.trim() || !Number.isSafeInteger(embedding.dimensions) || embedding.dimensions < 1 || embedding.dimensions > 32768) {
    throw failure('Embedding API 未配置：需要独立的地址、Key、模型和维度。', 'EMBEDDING_NOT_CONFIGURED');
  }
  let url;
  try { url = new URL(embedding.baseUrl); } catch { throw failure('Embedding API 地址无效。', 'EMBEDDING_URL_INVALID'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) {
    throw failure('Embedding API 需要无内嵌凭证的 HTTPS 地址；本机自托管允许 loopback HTTP。', 'EMBEDDING_URL_INVALID');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/embeddings`;
  return url.href;
}
export function embeddingReady(config=storageConfig()) { try { embeddingEndpoint(config); return true; } catch { return false; } }
export async function embedTexts(texts,{config=storageConfig(),fetchImpl=fetch}={}) {
  const endpoint = embeddingEndpoint(config);
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string' || !text.trim())) throw failure('Embedding 输入必须为非空文本数组。', 'EMBEDDING_INPUT_INVALID');
  let response;
  try {
    response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${config.embedding.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.embedding.model,input:texts,encoding_format:'float',...(['openai','qwen'].includes(config.embedding.provider)?{dimensions:config.embedding.dimensions}:{})}),signal:AbortSignal.timeout(30000),redirect:'error'});
  } catch { throw failure('Embedding API 请求失败。', 'EMBEDDING_API_FAILED'); }
  if(!response.ok)throw failure('Embedding API 请求失败。', 'EMBEDDING_API_FAILED');
  let body;
  try { body = await response.json(); } catch { throw failure('Embedding API 返回无效 JSON。', 'EMBEDDING_RESPONSE_INVALID'); }
  const rows=body?.data;
  if(!Array.isArray(rows)||rows.length!==texts.length || rows.some(row => !row || typeof row !== 'object'))throw failure('Embedding 返回数量或记录格式与输入不符。', 'EMBEDDING_RESPONSE_INVALID');
  const sorted=[...rows].sort((a,b)=>a.index-b.index);
  if(sorted.some((row,i)=>row.index!==i||!Array.isArray(row.embedding)||row.embedding.length!==config.embedding.dimensions||row.embedding.some(v=>!Number.isFinite(v))||row.embedding.every(v=>v===0)))throw failure('Embedding 返回的索引、维度或向量无效。', 'EMBEDDING_RESPONSE_INVALID');
  return sorted.map(r=>r.embedding);
}
export function releaseFilter(release) {
  if (typeof release?.id !== 'string' || !release.id || typeof release.currentPatch !== 'string' || !release.currentPatch) throw failure('Knowledge release scope is required.', 'INDEX_RELEASE_INVALID');
  return `release_id == ${JSON.stringify(release.id)} and ((scope == "patch" and source_patch == ${JSON.stringify(release.currentPatch)}) or (scope == "general" and source_patch == "")) and eligible == true`;
}
export class MilvusClient {
  constructor(config=storageConfig(),fetchImpl=fetch){this.config=config;this.fetch=fetchImpl;}
  async call(path,body) {
    if(!this.config.milvusUrl)throw new Error('Milvus is not configured');
    const headers={'Content-Type':'application/json'};if(this.config.milvusToken)headers.Authorization=`Bearer ${this.config.milvusToken}`;
    const response=await this.fetch(`${this.config.milvusUrl.replace(/\/+$/,'')}/v2/vectordb/${path}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Milvus HTTP request failed');const result=await response.json();if(result.code!==0)throw new Error('Milvus operation failed');return result.data;
  }
  async ensureCollection(collectionName,dim) {
    const exists=await this.call('collections/has',{collectionName});
    if(exists?.has)return;
    await this.call('collections/create',{collectionName,schema:{autoID:false,enableDynamicField:false,fields:[
      {fieldName:'id',dataType:'VarChar',isPrimary:true,elementTypeParams:{max_length:'80'}},
      {fieldName:'release_id',dataType:'VarChar',elementTypeParams:{max_length:'64'}},
      {fieldName:'source_patch',dataType:'VarChar',elementTypeParams:{max_length:'24'}},
      {fieldName:'scope',dataType:'VarChar',elementTypeParams:{max_length:'16'}},
      {fieldName:'eligible',dataType:'Bool'},
      {fieldName:'vector',dataType:'FloatVector',elementTypeParams:{dim:String(dim)}}
    ]},indexParams:[{fieldName:'vector',indexName:'vector_cosine',metricType:'COSINE',params:{index_type:'AUTOINDEX'}}],params:{consistencyLevel:'Strong'}});
  }
  async verifyEntities(collectionName, release, ids, expectedScopes = null) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw failure('Index verification requires unique chunk IDs.', 'INDEX_VERIFY_FAILED');
    const scope = releaseFilter(release);
    for (let offset = 0; offset < ids.length; offset += 128) {
      const expected = ids.slice(offset, offset + 128), allowed = new Set(expected);
      const rows = await this.call('entities/query', { collectionName,
        filter: `${scope} and id in ${JSON.stringify(expected)}`,
        outputFields: ['id', 'release_id', 'source_patch', 'scope', 'eligible'], limit: expected.length, consistencyLevel: 'Strong' });
      if (!Array.isArray(rows) || rows.length !== expected.length || new Set(rows.map(row => row?.id)).size !== expected.length
        || rows.some(row => !allowed.has(row?.id) || row.release_id !== release.id || row.eligible !== true ||
          (row.scope === 'general' ? row.source_patch !== '' : row.scope !== 'patch' || row.source_patch !== release.currentPatch) ||
          (expectedScopes && row.scope !== expectedScopes.get(row.id)))) {
        throw failure('Index verification did not find every eligible current-release chunk.', 'INDEX_VERIFY_FAILED');
      }
    }
    return { count: ids.length };
  }
  async search(collectionName,vector,release,limit=30) {
    // Values are encoded as Milvus string literals, never interpolated user expressions.
    const filter=releaseFilter(release);
    return await this.call('entities/search',{collectionName,data:[vector],annsField:'vector',filter,limit,outputFields:['id'],consistencyLevel:'Strong'});
  }
}
