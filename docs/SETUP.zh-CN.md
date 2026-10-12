# 启动与维护

[English](SETUP.md) · [首页](../README.zh-CN.md)

## 推荐：Docker 完整启动

安装 Git、Node.js 22+（建议 24，用于初始化脚本）、Docker Engine/Desktop 和 Compose v2，并先启动 Docker。首次构建需要联网下载镜像和 npm 依赖；数据更新与模型调用也需要对应网络。可选 Milvus 会增加多个服务和内存需求，请按数据规模配置机器。

```sh
git clone https://github.com/huangtaozhou33-collab/TFT-.git tft-evidence-workbench
cd tft-evidence-workbench
node scripts/init-docker-env.mjs
docker compose --env-file .env.docker up --build -d --wait
```

打开 http://127.0.0.1:3001。初始化脚本生成随机基础设施密码并留空模型密钥，不覆盖已有 `.env.docker`。应用容器启动时执行 MySQL 迁移并导入种子数据。私有仓库需要你自己的 GitHub 访问权限，不要复制他人的密码或密钥文件。

Windows 也可以运行 `start-docker.cmd` 或 `./start-docker.ps1`。同一端口只运行一个部署；3001 被占用时修改 `.env.docker` 的 `TFT_PORT`，再重新创建应用容器。

## 配置聊天模型

在 `.env.docker` 填入所用提供商的密钥：`DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `KIMI_API_KEY`。通用配置仍兼容 `AI_API_KEY`。不要提交该文件。

```sh
docker compose --env-file .env.docker up -d app
```

打开 TFT 助手，点击齿轮选择提供商、模型以及该模型支持的思考和 token 参数。界面不能授予账号没有的模型权限，“配置有效”也不等于真实生成已通过测试。

如果只用环境变量配置，需要一起设置 `AI_PROVIDER`、`AI_MODEL`、`AI_BASE_URL`，或者清空通用模型/地址覆盖项；不能换了提供商却保留 DeepSeek 的地址和模型。已保存的界面设置可能覆盖启动默认值。详见[模型配置](MODEL_CONFIGURATION.md)。

不填模型密钥也能打开网页、查看已有数据；生成回答需要配置模型，可能产生费用。不要把本地开发者界面直接暴露到公网。

## 首次更新数据

种子包含参考资料和带来源的历史快照，不是作者完整的 MetaTFT 实时数据库。进入开发者模式，手动执行需要的统计更新任务，再查看任务状态、来源、补丁和样本范围。定时检查默认每天一次，可以在界面修改；上游没有变化时不应生成重复数据版本。

首次条件查询可能较慢，上游不可用时也可能失败。无样本可能是真实结果，不能暗中放宽段位或删除持有者条件。来源更新时间与本系统检查时间是两回事。详见[定时更新说明](STATISTICS_SCHEDULE.md)。

## 可选：启用向量检索

在 `.env.docker` 设置 `MILVUS_URL=http://milvus:19530`，再配置 Embedding 提供商、密钥、模型、地址和维度。聊天模型与 Embedding 模型分别配置。

```sh
docker compose --env-file .env.docker --profile rag up --build -d --wait
docker compose --env-file .env.docker exec app npm run check:storage
# 下方是明确的付费 Embedding 操作：
docker compose --env-file .env.docker exec app npm run rag:index
```

更换不兼容的模型或维度后必须建立匹配索引，不能继续使用旧向量。没有就绪向量索引时可以回退词法检索；Milvus 容器健康不等于资料已经完成向量化。

## 轻量本地开发

```sh
npm ci
npm start
```

打开 http://127.0.0.1:3000。默认 JSON 模式适合界面和资料开发，不能替代 MySQL 统计筛选器；完整功能请使用 Docker。`.env.example` 是配置说明，不包含可用的 API 密钥。

## 检查、停止和升级

```sh
npm test
npm run db:dry-run
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker stop
```

普通离线测试和种子校验不调用付费模型。`check:ai` 和 `rag:index` 属于明确的真实提供商操作。[发布验收记录](RELEASE_READINESS.md) 区分实际检查和未验证环境。

升级前备份 MySQL 和个人笔记，保留 Docker 数据卷与私人配置。不要把 `down -v` 当作重启，它会删除持久数据。模型偏好在 Docker 数据卷中，笔记在浏览器存储中；换端口会进入不同的浏览器存储范围。

| 现象 | 排查方向 |
|---|---|
| 镜像下载或构建失败 | Docker 网络、镜像仓库 DNS、代理、npm 网络 |
| 网页打开但统计为空 | MySQL 后端、首次同步结果、段位支持、真实样本门槛 |
| 聊天提示未配置 | 服务端对应提供商密钥；改环境后重新创建应用容器 |
| 提供商拒绝参数 | 账号和具体模型能力，不要随意填入不支持的参数 |
| 向量检索不可用 | Milvus 健康、Embedding 配置和维度、索引任务是否完成 |
| 部分图标缺失 | 资料库匹配和远程图片可用性，宁可占位也不配错图片 |

当前版本面向本地研究。公网服务、多用户、统一登录和生产监控仍需要额外建设。
