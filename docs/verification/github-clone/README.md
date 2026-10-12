# GitHub clone acceptance — 2026-10-12

## Isolation and method / 隔离方式

Both installations were cloned over HTTPS from `https://github.com/huangtaozhou33-collab/TFT-.git`, not copied from the developer workspace. They used newly generated `.env.docker` files with blank API keys and newly created Compose volumes. No existing MySQL/Milvus database or personal model configuration was reused.

两轮均从 GitHub HTTPS 克隆，未复制开发目录。首次验证提交 `2b49860`，修复后重新克隆提交 `be685ef`。唯一必要环境差异是同机隔离：3031/3032 端口、独立 Compose 项目名；轻量服务使用 3033。未读取原密钥文件，未调用付费聊天或 Embedding。

## Defect reproduced and fixed / 发现与修复

Windows Git `core.autocrlf=true` changed reviewed library JSON from LF to CRLF. Its byte hash no longer matched the manifest. First run: 456 executed tests, 451 passed, 5 failed (some test files failed during initialization). Normalizing only CRLF back to LF reproduced the original expected hash. Docker's compressed MySQL seed was unaffected, which had hidden the JSON-mode failure.

新增 `.gitattributes` 固定文本 LF，二进制文件不转换；未关闭或放宽完整性校验。加入 Windows/Linux CI。中英文 README 补充第二份部署必须隔离项目名和端口，不能仅换目录。

## Final executed checks / 实际验收

| Check | Result |
|---|---|
| Fresh GitHub clone `be685ef`, npm ci, npm test | 476 passed, 0 failed/skipped |
| Release file/link check and seed dry-run | Passed |
| README standard Docker build and empty-volume startup | app/MySQL/Redis healthy |
| Database schema | 9 migrations, 27 tables |
| Reference seed | 844 entities, 832 documents, 940 chunks; not vector or match counts |
| Optional RAG profile, fresh Milvus/etcd/MinIO volumes | Healthy; synthetic vector create/upsert/scoped search passed and temporary collection removed |
| Lightweight Windows `npm start` | Library API ready; UI shop probability table renders |
| Developer UI manual MetaTFT composition sync | Completed successfully; other large jobs not exhaustively rerun |
| Browser filter on first isolated clone | Added Ahri, then Jeweled Gauntlet held by Ahri; result rendered, refresh restored both conditions, removed item |
| Real low-sample state | Ahri with Silvermere Dawn: 17 source aggregate samples; threshold 1000 correctly returned no qualifying rows |
| Missing model key | Chat returned server configuration guidance; no paid provider request |
| Final clone homepage | Search Elder Dragon reduced 60 source comps to 4 |
| Already-open page across RAG app recreation | Developer sync and homepage remained usable |
| Original deployment at 3001 | Left running; existing browser continued to browse library |
| GitHub CI | [Windows and Ubuntu both passed](https://github.com/huangtaozhou33-collab/TFT-/actions/runs/38220304837) |

## Evidence / 证据

- [Final Docker homepage](final-docker.png)
- [Windows JSON library](windows-library.png)
- [Filter excerpt](filter.txt)
- [Real sample-threshold empty state](no-samples.png), [text](no-samples.txt)
- [Missing-key state](missing-key.png), [text](missing-key.txt)

## Limits / 限制

The host was Windows with Docker Desktop running Linux containers. Linux CI is not a Linux-host Docker deployment test; macOS and ARM were not tested. Public image/package caches were allowed, but no preexisting application data was reused. Live model generation and actual embedding of the knowledge corpus were intentionally not run. Upstream access succeeded in this run and is not a permanent availability guarantee. Test services are stopped after verification; their isolated volumes are retained for diagnosis, and the original deployment is untouched.
