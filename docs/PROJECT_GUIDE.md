# 项目目录与发布入口

## 阅读顺序

1. [中文首页](../README.zh-CN.md) / [English README](../README.md)：功能与截图概览。
   [当前启动指南](SETUP.zh-CN.md) / [English setup](SETUP.md)；[当前架构](ARCHITECTURE.zh-CN.md) / [English architecture](ARCHITECTURE.md)。
2. [发布就绪检查](RELEASE_READINESS.md)：哪些已验证，哪些仍不能承诺。
3. [数据库架构](DATABASE_ARCHITECTURE.md)：MySQL、Redis、Milvus 与统计来源分工。
4. [RAG 配置](RAG_SETUP.md) / [Agent 思考与工具](AGENT_THINKING.md)。
5. [统计更新](STATISTICS_SCHEDULE.md) / [公告与聊天卡片](PATCH_NOTES_AND_CHAT.md)。
6. [工程学习记录](ENGINEERING_LESSONS.md)：问题、根因、验证和限制。

## 文件分工

| 路径 | 用途 | GitHub处理 |
|---|---|---|
| public/ | 浏览器界面、语言包、图表和卡片 | 源码 |
| server/ | HTTP、Agent工具、查询、存储和调度 | 源码 |
| scripts/ | 启动、导入、采集、索引和诊断 | 源码；真实提供商脚本单独执行 |
| tests/ | 离线回归测试 | 纳入CI |
| data/catalog.json、data/seed/ | 静态目录与首启种子 | 第三方数据；公开分发许可须单独确认 |
| data/其他目录 | 已整理的来源资料、清单和采集记录 | 不等于本机MySQL全部内容 |
| docs/*.md | 设计、操作、历史验收说明 | 文档；历史数量以记录日期为准 |
| docs/*browser/、screenshots/、verification/ | 截图、测试轨迹及历史证据 | 保留用于复盘，不参与启动 |
| .env、.env.docker | 本机密钥与配置 | 已忽略，禁止上传 |
| tmp/、node_modules/、*.log | 临时实验、依赖与日志 | 已忽略 |
| Docker命名卷 | 数据库、向量和缓存 | 不在Git仓库内 |

本次采用索引整理，不批量挪动带相对路径的代码、数据或旧证据；避免破坏引用。没有删除本地试验资料。

## 跨平台 Docker 启动

Windows 优先用 `start-docker.cmd -Rag` 或 PowerShell 启动脚本。
macOS/Linux 或偏好统一命令的用户，安装 Node.js 22+ 和 Docker Compose V2 后在仓库根目录执行：

```sh
node scripts/init-docker-env.mjs
docker compose --env-file .env.docker up --build -d --wait
```

访问 http://127.0.0.1:3001 。初始化只在文件不存在时生成随机密码，重复执行不会覆盖配置。
需要向量检索时，在自己的 `.env.docker` 配置 `MILVUS_URL=http://milvus:19530` 及 Embedding 提供商，再执行：

```sh
docker compose --env-file .env.docker --profile rag up --build -d --wait
```

启动Milvus不等于已有向量；按照RAG文档显式建索引。该步骤可能调用付费Embedding。
停止用 `docker compose --env-file .env.docker --profile rag stop`；保留命名卷。不要为了重启执行 `down -v`。
