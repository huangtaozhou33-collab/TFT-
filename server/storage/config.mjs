// Infrastructure configuration is independent of the chat API key.
import {localEnvironment} from '../env.mjs';
import {modelSettings} from '../model-settings.mjs';
import {EMBEDDING_PROVIDERS,providerPreset} from '../model-providers.mjs';
export function storageConfig(env = {...process.env,...Object.fromEntries(Object.entries(localEnvironment()).filter(([,v])=>v))}) {
  const integer = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const knowledgeMinVectorScore = Number(env.KNOWLEDGE_MIN_VECTOR_SCORE || 0.5);
  if (!Number.isFinite(knowledgeMinVectorScore) || knowledgeMinVectorScore < 0 || knowledgeMinVectorScore > 1) throw new Error('KNOWLEDGE_MIN_VECTOR_SCORE must be between 0 and 1.');
  const selected=modelSettings().embedding,provider=selected?.provider||env.EMBEDDING_PROVIDER||'compatible',preset=providerPreset(EMBEDDING_PROVIDERS,provider);
  const embedding={provider,baseUrl:env[`${provider.toUpperCase()}_EMBEDDING_BASE_URL`]||(!selected?env.EMBEDDING_BASE_URL:'')||preset.baseUrl,
   key:env[`${provider.toUpperCase()}_EMBEDDING_API_KEY`]||(provider===(env.EMBEDDING_PROVIDER||'compatible')?env.EMBEDDING_API_KEY:'')||'',
   model:selected?.model||env.EMBEDDING_MODEL||preset.model,dimensions:selected?.dimensions||integer(env.EMBEDDING_DIMENSIONS,preset.dimensions)};
  return {
    backend: env.STORAGE_BACKEND || 'local_json',
    mysql: { host: env.MYSQL_HOST || '127.0.0.1', port: integer(env.MYSQL_PORT, 3306), user: env.MYSQL_USER || 'tft', password: env.MYSQL_PASSWORD || '', database: env.MYSQL_DATABASE || 'tft', charset: 'utf8mb4', timezone: 'Z', connectionLimit: 5, connectTimeout: 5000, enableKeepAlive: true },
    redisUrl: env.REDIS_URL || '',
    milvusUrl: env.MILVUS_URL || '', milvusToken: env.MILVUS_TOKEN || '',
    embedding,
    currentPatch: env.CURRENT_GAME_PATCH || '',
    knowledgeMinVectorScore,
    cacheSeconds: integer(env.KNOWLEDGE_CACHE_SECONDS, 300)
  };
}
