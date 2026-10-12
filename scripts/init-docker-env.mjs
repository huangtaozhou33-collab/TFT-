// Cross-platform initialization; never reads or overwrites existing credentials.
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const password=()=>randomBytes(32).toString('hex');
const settings=`# Private local configuration. Do not commit this file.
TFT_PORT=3001
MYSQL_PASSWORD=${password()}
MYSQL_ROOT_PASSWORD=${password()}
REDIS_PASSWORD=${password()}
MINIO_ROOT_PASSWORD=${password()}
AI_API_KEY=
# Provider/model switching: docs/MODEL_CONFIGURATION.md
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=
QWEN_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
KIMI_API_KEY=
OPENAI_EMBEDDING_API_KEY=
QWEN_EMBEDDING_API_KEY=
EMBEDDING_PROVIDER=compatible
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-flash
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
EMBEDDING_DIMENSIONS=0
MILVUS_URL=
MILVUS_TOKEN=
CURRENT_GAME_PATCH=
`;
try {
 await writeFile(new URL('../.env.docker',import.meta.url),settings,{flag:'wx',mode:0o600});
 console.log('Created .env.docker with random local passwords and blank API keys.');
} catch(error) {
 if(error.code==='EEXIST')console.log('.env.docker already exists; left unchanged.');
 else {console.error('Could not create local Docker configuration.');process.exitCode=1;}
}
