import { pathToFileURL } from 'node:url';
import { getActiveRelease, eligibleChunks, getIndexJob, saveIndexJob, getPool, closeDatabase } from '../server/storage/repository.mjs';
import { storageConfig } from '../server/storage/config.mjs';
import { MilvusClient, indexProfile, embedTexts, embeddingEndpoint } from '../server/knowledge/vector.mjs';
import { isGeneralGlossary, knowledgeInScope } from '../server/knowledge/scope.mjs';

const failure = (message, code) => Object.assign(new Error(message), { code });
const LOCK_NAME = 'tft_knowledge_index_build';

// A dedicated MySQL connection owns both the advisory lock and all job writes.
// Importing this module never connects to a service or calls an embedding API.
export async function indexKnowledge({ config = storageConfig() } = {}, dependencies = {}) {
  embeddingEndpoint(config);
  if (!config.milvusUrl) throw failure('请先配置 MILVUS_URL。', 'MILVUS_NOT_CONFIGURED');
  if (config.backend !== 'mysql') throw failure('向量构建需要 MySQL 中的已发布知识。', 'INDEX_DATABASE_REQUIRED');
  const db = await (dependencies.getPool ?? getPool)();
  const connection = await db.getConnection();
  const readRelease = dependencies.getActiveRelease ?? getActiveRelease;
  const readChunks = dependencies.eligibleChunks ?? eligibleChunks;
  const readJob = dependencies.getIndexJob ?? getIndexJob;
  const writeJob = dependencies.saveIndexJob ?? saveIndexJob;
  const embed = dependencies.embedTexts ?? embedTexts;
  let locked = false, identity, started = false, indexedCount = 0;
  try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK_NAME]);
    if (lock.acquired !== 1) throw failure('已有知识向量构建任务正在运行。', 'INDEX_BUILD_BUSY');
    locked = true;
    const release = await readRelease(connection);
    if (!release?.id) throw failure('请先导入知识库。', 'INDEX_RELEASE_MISSING');
    if (!release.currentPatch || release.currentPatch !== release.sourcePatch) throw failure('当前查询补丁与发布资料补丁不同，不能构建旧版本向量。', 'INDEX_PATCH_MISMATCH');
    const chunks = await readChunks(release, connection);
    if (!Array.isArray(chunks) || !chunks.length) throw failure('当前补丁没有可索引的已核验知识。', 'INDEX_CHUNKS_EMPTY');
    if (new Set(chunks.map(chunk => chunk?.id)).size !== chunks.length || chunks.some(chunk => !chunk || typeof chunk.id !== 'string' || !chunk.id || chunk.id.length > 80
      || !knowledgeInScope(chunk, release.currentPatch) || typeof chunk.text !== 'string' || !chunk.text.trim())) {
      throw failure('知识片段身份、版本或核验状态无效。', 'INDEX_CHUNKS_INVALID');
    }
    const profile = indexProfile(config), collection = `tft_${profile.hash.slice(0, 16)}_${release.id.slice(0, 16)}`;
    identity = { releaseId: release.id, profileHash: profile.hash, collection, profile };
    const previous = await readJob(release.id, profile.hash, connection);
    const client = dependencies.client ?? new MilvusClient(config);
    started = true;
    await writeJob({ ...identity, state: 'running' }, connection);
    const reuse = previous?.state === 'ready' && Number(previous.indexed_chunks) === chunks.length && previous.collection_name === collection;
    if (!reuse) {
      await client.ensureCollection(collection, config.embedding.dimensions);
      for (let offset = 0; offset < chunks.length; offset += 16) {
        const batch = chunks.slice(offset, offset + 16);
        const vectors = await embed(batch.map(chunk => `${chunk.title}\n${isGeneralGlossary(chunk) ? '适用范围：通用玩家用语（本项目整理）' : `适用补丁：${chunk.sourcePatch}`}\n${chunk.text}`), { config });
        if (!Array.isArray(vectors) || vectors.length !== batch.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== config.embedding.dimensions || vector.some(value => !Number.isFinite(value)) || vector.every(value => value === 0))) {
          throw failure('Embedding 未返回完整合法向量。', 'EMBEDDING_RESPONSE_INVALID');
        }
        const receipt = await client.call('entities/upsert', { collectionName: collection, data: batch.map((chunk, i) => ({
          id: chunk.id, release_id: release.id, source_patch: isGeneralGlossary(chunk) ? '' : chunk.sourcePatch, scope: isGeneralGlossary(chunk) ? 'general' : 'patch', eligible: true, vector: vectors[i],
        })) });
        if (!Number.isSafeInteger(receipt?.upsertCount) || receipt.upsertCount !== batch.length) throw failure('Milvus 未确认整批向量写入。', 'INDEX_UPSERT_INCOMPLETE');
        indexedCount += batch.length;
        await writeJob({ ...identity, state: 'running', count: indexedCount }, connection);
      }
    }
    await client.call('collections/load', { collectionName: collection });
    const verification = await client.verifyEntities(collection, release, chunks.map(chunk => chunk.id), new Map(chunks.map(chunk => [chunk.id, isGeneralGlossary(chunk) ? 'general' : 'patch'])));
    if (verification?.count !== chunks.length) throw failure('向量索引尚未通过完整性校验。', 'INDEX_VERIFY_FAILED');
    const current = await readRelease(connection);
    if (current?.id !== release.id || current.currentPatch !== release.currentPatch || current.sourcePatch !== release.sourcePatch) throw failure('构建期间当前资料发布发生变化，请重新构建。', 'INDEX_RELEASE_CHANGED');
    await writeJob({ ...identity, state: 'ready', count: chunks.length }, connection);
    return { status: reuse ? 'unchanged' : 'ready', collection, chunks: chunks.length, model: profile.model, dimensions: profile.dimensions };
  } catch (error) {
    if (started && identity) await writeJob({ ...identity, state: 'failed', count: indexedCount,
      errorCode: typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INDEX_BUILD_FAILED' }, connection).catch(() => {});
    throw error;
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    connection.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await indexKnowledge(), null, 2)); }
  catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INDEX_BUILD_FAILED';
    console.error(JSON.stringify({ status: 'error', code, message: '知识向量构建未完成；请检查独立的 Embedding 配置、当前资料版本和数据库状态。' }));
    process.exitCode = 1;
  } finally { await closeDatabase().catch(() => {}); }
}
