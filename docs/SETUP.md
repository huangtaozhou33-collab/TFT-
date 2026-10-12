# Setup and operations

[简体中文](SETUP.zh-CN.md) · [Home](../README.md)

## Recommended: Docker

Install Git, Node.js 22+ (24 recommended for the helper scripts), and Docker Engine/Desktop with Compose v2. Start Docker first. Allow internet access for images, npm dependencies, source refreshes and configured model APIs. Milvus adds several services and needs more memory than the basic app; size your machine for your dataset.

```sh
git clone https://github.com/huangtaozhou33-collab/TFT-.git tft-evidence-workbench
cd tft-evidence-workbench
node scripts/init-docker-env.mjs
docker compose --env-file .env.docker up --build -d --wait
```

Open http://127.0.0.1:3001. Initialization creates random local service passwords and blank model keys, and never overwrites an existing `.env.docker`. Container startup migrates MySQL and imports the bundled seed. Do not copy someone else's database password or `.env` file. A private repository requires your own GitHub access.

Windows users can also run `start-docker.cmd` or `./start-docker.ps1`. Keep one deployment running on a given port. Set `TFT_PORT` in `.env.docker` if 3001 is occupied, then recreate the app.

## Configure chat

For a second isolated installation on the same host, add `COMPOSE_PROJECT_NAME=tft-second-copy` and set `TFT_PORT=3031` in its newly generated `.env.docker` before starting. A different directory by itself does not isolate the fixed Compose project name or volumes. Open port 3031 for that installation. Keep `.gitattributes`: it preserves LF bytes for integrity-checked reference snapshots on Windows.

Add your key to `.env.docker` for a supported provider: `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `KIMI_API_KEY`. Legacy `AI_API_KEY` supports the generic configuration. Do not commit this file.

```sh
docker compose --env-file .env.docker up -d app
```

Open the assistant and its gear button to choose the provider, model and supported thinking/token controls. The UI cannot grant access to models unavailable to your account. Configuration validation is not a successful live-generation test. If configuring entirely by environment, set `AI_PROVIDER`, `AI_MODEL` and `AI_BASE_URL` together (or clear generic model/base overrides); leaving a DeepSeek model/base while selecting another provider is incorrect. Persisted UI settings can override startup defaults. See [parameter reference](MODEL_CONFIGURATION.md).

No model key is needed to open the UI and browse available data. Generated answers need a configured provider and can incur costs. Never expose this local developer interface directly to the internet.

## First data refresh

The seed contains reference knowledge and attributed historical snapshots, not the author's full live MetaTFT database. Open developer mode and run the required statistics update tasks, then inspect status, source, patch and sample scope. The normal schedule defaults to daily checks; you can change intervals there. No changes upstream should not create a duplicate data version.

First queries may take longer or fail if upstream access is unavailable. An empty result can be real; it is not permission to broaden rank or remove holder conditions silently. Source update time and local check time are different. See [scheduling behavior](STATISTICS_SCHEDULE.md).

## Optional vector retrieval

Set `MILVUS_URL=http://milvus:19530` and your embedding provider, key, model, endpoint and dimensions in `.env.docker`. Chat and embedding models are separate selections.

```sh
docker compose --env-file .env.docker --profile rag up --build -d --wait
docker compose --env-file .env.docker exec app npm run check:storage
# Explicit paid embedding operation:
docker compose --env-file .env.docker exec app npm run rag:index
```

Changing embedding model or dimensions requires a matching new index; do not reuse incompatible vectors. Without a ready vector index the knowledge service can use lexical retrieval. A healthy Milvus container alone does not mean documents have been embedded.

## Lightweight local development

```sh
npm ci
npm start
```

Open http://127.0.0.1:3000. The default JSON-backed mode is useful for UI/reference development, but does not replace the MySQL-backed statistics explorer. For the complete app use Docker. `.env.example` documents local environment options; copying it does not supply API credentials.

## Checks and maintenance

```sh
npm test
npm run db:dry-run
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker stop
```

Offline tests and seed dry-run do not invoke paid models. `check:ai` and `rag:index` are explicit live-provider operations. The [release record](RELEASE_READINESS.md) separates executed checks from untested environments.

Back up MySQL and local notes before upgrades. Keep the Docker volumes and private configuration. Do not use `down -v` as a routine restart: it removes persistent data. Model preferences live in a Docker volume; notes live in browser storage and differ between ports/origins.

| Symptom | Check |
|---|---|
| Image pull/build fails | Docker network, registry DNS, proxy and npm connectivity; retry after fixing connectivity |
| UI opens but stats are empty | MySQL backend, first sync results, supported rank and genuine sample threshold |
| Chat says not configured | Provider-specific server key; recreate app after env changes |
| Provider rejects parameters | Exact account/model capability; choose supported controls rather than arbitrary values |
| Vector search unavailable | Milvus health, embedding profile/dimensions and completed index job |
| An icon is missing | Catalog match and remote asset availability; fallback is preferable to a wrong picture |

This release targets local research use. Public hosting, multiple users, SSO and production observability need additional engineering.
