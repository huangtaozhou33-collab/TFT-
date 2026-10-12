# Docker、数据库与 RAG 配置

本项目目前有两种入口：`start.cmd` / `npm start` 默认运行原本地 JSON 开发版，地址为 `http://127.0.0.1:3000`；`start-docker.ps1` 运行 MySQL 数据库版，默认地址为 `http://127.0.0.1:3001`。两者保留同一套界面，但数据后端与统计资格检查不同。

架构见 [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)，问答范围与验收场景见 [RAG_QUESTION_MATRIX.md](RAG_QUESTION_MATRIX.md)。

## 1. 一键启动与首次导入

Windows 安装并启动 Docker Desktop，选择 Linux / WSL2 引擎。在项目目录执行：

```powershell
.\start-docker.ps1
```

此命令启动应用、MySQL 和 Redis 三个服务。要同时启动向量数据库及其依赖：

```powershell
.\start-docker.ps1 -Rag
```

`-Rag` 共启动六个服务：应用、MySQL、Redis、Milvus、etcd、MinIO。启动脚本构建镜像、等待健康检查，并由应用入口执行数据库迁移、首次导入及已核对的统计补丁归档策略。当前有 12 张 MySQL 表，归档记录独立保存在 `snapshot_patch_assignments`。同一资料包重复启动是幂等的，不会重复增加知识行；归档不会改写原始来源版本。

首次执行会生成 `.env.docker`，其中数据库密码为独立随机值，聊天 API Key 和 embedding 配置留空。脚本不读取开发用 `.env`，不会把已有聊天密钥自动拷入容器，也不会覆盖已有 `.env.docker`。后续修改配置后，重新运行原来的启动命令：使用 Milvus 的实例继续带 `-Rag`。

脚本成功后打开 [数据库版界面](http://127.0.0.1:3001)。端口可通过 `.env.docker` 的 `TFT_PORT` 调整。服务默认只绑定本机回环地址；公开托管和多用户部署不属于本轮交付。

当前开发机已实际启动六个服务并达到健康状态。2026-10-10 已完成真实 embedding 调用及 678 个合格片段的向量构建；具体检索验收见 [RAG_VALIDATION.md](RAG_VALIDATION.md)。新安装仍需自行填写模型配置并建立索引。

## 2. 无模型时可以做什么

没有 API Key 时，可以浏览资料库、查看可用的当前补丁统计、使用阵容规划器，以及使用知识检索 API 的词法路径。需要大模型组织和解释的 AI 问答，必须配置聊天模型。检索模式为 `lexical` 时，只表示未使用向量，不表示资料没有导入。

初始包 `data/seed/current.json.gz` 约 1.24 MB，清单位于同目录的 `manifest.json`。包中包含：

| 内容 | 数量 |
| --- | ---: |
| 实体 | 844 |
| 文档 | 641 |
| 片段 | 749 |
| 符合种子来源补丁检索资格的片段 | 678 |
| 来源快照 | 209 |
| 统计快照 | 204 |
| 来源明确标注补丁的统计快照 | 2 |
| 原始来源补丁未知的统计快照 | 202 |

初始资料来自赛季 18，已核验资料的来源补丁为 18.4。这是数据包的适用标记，不是一次自动检测线上最新版本的结果。初始导入会保留真实采集时间、来源和审核状态。

以上是原始种子包口径。用户已授权缺少版本字段的 OP.GG 统计按原始采集日期推定补丁；当前启动流程会应用本轮已核对的 18.4 归档策略。204 份统计中，2 份保留来源明确版本，201 份获推定归属，另 1 份 `not_supported` 仍不可用。原有 202 份的 `sourcePatch` 仍为 null，另记录 `assignedPatch`、`effectivePatch` 和 `patchAssignment`；界面显示“18.4 · 推定”。

此策略只针对已核对的发布、工具及采集时间范围，不给历史数据按今天日期重新贴标。切版日精确生效时刻和统计窗口未知，不能保证全部样本只含 18.4，也未确认 B 更新。现有聚合包仍不支持任意多英雄共存的真实联合统计。范围及依据见 [OPGG_DATA_CONTRACT.md](OPGG_DATA_CONTRACT.md)。

## 3. 配置聊天模型

在本机编辑 `.env.docker` 的以下字段，不要把自己的 Key 写到代码或提交到 GitHub：

```dotenv
AI_API_KEY=你的聊天API密钥
AI_BASE_URL=你的兼容API基础地址
AI_MODEL=你的聊天模型名称
```

服务地址和模型名按你实际使用的提供商填写。保存后重新执行：

```powershell
.\start-docker.ps1 -Rag
```

只运行基础三个服务的实例使用不带 `-Rag` 的命令。Docker 环境配置在重建容器时生效，浏览器刷新和单纯容器进程重启不会读取新的 `.env.docker` 文件内容。

## 4. 配置 embedding 与建立索引

聊天模型和 embedding 模型分开配置。聊天 API 可用并不代表该提供商或该模型支持向量化。需要具备兼容 `/embeddings` 接口的服务，并填写：

```dotenv
EMBEDDING_BASE_URL=https://你的服务地址/v1
EMBEDDING_API_KEY=你的embedding密钥
EMBEDDING_MODEL=你的embedding模型名称
EMBEDDING_DIMENSIONS=该模型实际输出维度
```

`EMBEDDING_BASE_URL` 应包含提供商要求的 API 前缀，例如 `/v1`；程序会在后面追加 `/embeddings`。不要填写成完整的 `/embeddings` 地址。维度必须与该接口实际返回值一致；程序会检查数量、索引、维度和数值，不会生成占位向量。

重新创建带 Milvus 的应用容器，再显式建立索引：

```powershell
.\start-docker.ps1 -Rag
docker compose --env-file .env.docker exec app npm run rag:index
```

启动脚本通过容器配置连接内部 Milvus；不用把 Milvus 端口暴露给宿主机。索引命令读取当前发布中合格的片段，调用所配置的 embedding API，写入对应 Milvus 集合，并记录任务状态。未填写独立 embedding 配置时命令会明确失败，词法知识检索继续可用。

索引失败后可以重新运行同一命令。模型或维度改变会形成新的索引配置，不能混用原向量。`rag:index` 成功及知识查询返回 `hybrid` 才表示对应路径可用；仅看到 Milvus 容器健康或服务显示 `connected` 不够。

本机已验证阿里云百炼 `qwen3.7-text-embedding`，默认输出 1024 维，678 个合格片段全部写入并回查通过。密钥仅保存在用户的本机配置，不包含在镜像或种子包中。其他使用者仍需填写自己的 API 配置。

可选配置 `KNOWLEDGE_MIN_VECTOR_SCORE=0.5` 控制混合检索的 COSINE 相关度下限。这个起始值基于本机上述模型的小规模正例与无关问题实测，不是事实置信度或所有模型通用的合格线。低分向量不能与微弱关键词重叠合并成有效证据；明确实体与已知别名匹配仍保留。更换模型或增加语料后，应重新评测该值。修改下限只需重新创建应用容器，不需要重新向量化；查询缓存会按下限隔离。

索引就绪后可显式运行真实检索冒烟测试（会对未缓存的问题调用已配置的 Embedding API）：

```powershell
node scripts/check-rag-live.mjs --allow-provider
```

测试使用 `tests/fixtures/rag-live-cases.json`，结果保存在 `docs/RAG_LIVE_VALIDATION.json`，覆盖知识关键事实、图片引用、当前补丁、无关问题及缓存。默认访问本机 3001；自定义端口可设置 `RAG_CHECK_URL`。它与不调用模型的 `check:storage` 分开，不代表完整的检索质量基准。

## 5. 状态、检索与检查

在浏览器打开 [存储状态](http://127.0.0.1:3001/api/storage)，可以查看后端类型、MySQL／Redis 连通性、Milvus 连接、embedding 配置和索引状态。

也可以直接查询知识：

```powershell
$knowledgeQuery = @{ query = '战利品法球能开出什么'; limit = 3 } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/knowledge/query' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($knowledgeQuery))
```

返回包括 `status`、当前发布和版本、`retrieval.mode`、`vectorStatus`、是否命中缓存以及证据。证据包含原来源与图片引用。`not_found` 表示本次检索未找到可用证据；`unavailable` 表示存储不可用或尚未准备好，两者不同。

常用检查命令：

```powershell
docker compose --env-file .env.docker --profile rag ps
docker compose --env-file .env.docker logs --tail 100 app
docker compose --env-file .env.docker exec app npm run db:dry-run
docker compose --env-file .env.docker exec app npm run check:storage
```

`db:dry-run` 验证种子包并输出原始包统计，不修改数据库，也不包含独立归档后的统计资格。`check:storage` 在实际服务上检查 MySQL 行数、Redis 命中、知识来源与图片、统计补丁归档和跨补丁隔离；若连接 Milvus，还会在临时集合测试真实写入与过滤，结束后清理该集合。它不调用模型提供商，也不替代真实 embedding 质量评测。检查是否通过以本次命令结果为准。

2026-10-10 本机执行的 `check:storage` 已通过上述全部实际服务检查，包括 `stats_patch_attribution_and_isolation` 和 Milvus 临时集合检查，报告 `embeddingProviderCalled: false`。同期项目回归 285/285 通过、无跳过。检查显式禁用自身的 Embedding 调用，不影响应用的真实混合检索配置。

只验证 Compose 配置、暂不启动容器时：

```powershell
.\start-docker.ps1 -Rag -ValidateOnly
```

## 6. 更新与当前补丁

`CURRENT_GAME_PATCH` 留空时使用数据库中记录的当前补丁；首次导入的初始值来自种子包。填写该配置可以显式限定服务使用的补丁，但不能因此改变旧记录的真实来源版本。

维护者已核实新游戏补丁时，可通过配置或已有 `db:set-patch` 命令更新运行补丁。新补丁知识／统计未准备好时，旧数据会被隔离，页面可能显示暂缺。当前流程没有自动核实新赛季、自动改写资料或者自动生成当前统计的能力。

只读版本探测已提供：

```powershell
npm run probe:patch
```

它读取 OP.GG 默认阵容页的当前选中版本，并与 Riot 日历交叉核对，输出版本、核对时间、依据和差异警告。它不写数据库、不切换运行补丁、不修改历史快照，也不安排每日执行；页面歧义或不可读时保持未知。

本轮原始包的人工核定策略位于 `data/patch-attributions/opgg-18.4.json`，应用容器启动时会幂等执行。需要单独复核或应用时：

```powershell
docker compose --env-file .env.docker exec app node scripts/assign-statistics-patch.mjs
docker compose --env-file .env.docker exec app npm run db:assign-patch
```

第一条只检查归档候选，第二条才写入独立归档表和变更记录。重复应用已验证返回 `eligible:201, changed:0`。归档与知识发布分开，不需要重新生成现有 678 条知识向量。该固定策略不是未来补丁的自动审批；后续同步需将同批采集与版本证据一起核对保存。

同步命令负责采集本地来源包；`seed:export` 负责生成有校验清单的初始包；`db:bootstrap` 负责导入。已有公开来源的字段、映射和版本冲突仍需维护者核验，不能只执行这些命令就视为完成内容审核。完整自动调度、更新 Agent、审核管理界面和远程更新包分发仍待后续交付。

## 7. 保存、停机与迁移

MySQL、Redis、Milvus、etcd 与 MinIO 使用各自的 Docker 命名卷。普通重建应用容器不会删除这些数据。暂停整套服务可以使用：

```powershell
docker compose --env-file .env.docker --profile rag stop
```

不要用 `docker compose down -v` 作为普通更新或重启方式，该选项会删除持久卷。

数据库迁移建议使用 MySQL 的逻辑导出（如 `mysqldump`），同时保存对应 `.env.docker` 和种子清单；向量索引可以由 MySQL 中的正文和切片重建。项目尚未提供一键备份／恢复脚本，不应把复制初始种子包当作整个实例的备份。密钥文件单独妥善保存，不随公共资料包分发。

个人阵容笔记目前在浏览器 localStorage，数据库备份不会包含它们。3000 和 3001 端口属于不同浏览器来源；要从原本地版迁移笔记，在规划器导出完整 JSON，再在数据库版导入。

## 8. 本轮能力边界

已经有数据库导入、结构化切片、词法／向量混合检索、缓存、678 个真实 Embedding 知识向量、统计补丁归档和只读版本探测。以下仍未实现：每日更新调度、补丁更新 Agent、问答时联网补查、任意条件联合统计、完整多轮条件状态、个人笔记 RAG 和运营案例检索。模型接入与当前小规模验收不等于完整检索质量评测已经完成。

前端仍可使用来源图片和原生中文规则表；这不代表支持自动识别用户对局截图。统计缺失时 Agent 不能根据知识向量或选手复盘生成一份伪胜率。
