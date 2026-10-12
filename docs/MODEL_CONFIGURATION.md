# 模型切换与思考设置

入口：打开 TFT 助手 → 右上角 ⚙「模型与思考设置」。选择提供商、模型和该型号支持的参数，保存后供后续问答使用。设置属于当前服务，所有使用此服务的页面共享；不是单会话设置。

## 已适配能力

| 提供商 / 型号 | 页面中的推理设置 |
| --- | --- |
| DeepSeek flash / pro | 开关；低、高、最高 |
| Qwen plus / 3.8-max | 开关；思考 Token 预算；开启时使用流式协议接收工具调用 |
| GPT-4.1 / mini | 无思考开关；可设置生成上限 |
| GPT-5 | 低、中、高；此型号不提供关闭推理选项 |
| Claude Sonnet / Opus 4.6 | 自适应思考开关与强度；最高仅 Opus |
| Claude Sonnet 4.5 | 开关与思考预算，预算必须小于生成上限 |
| Kimi K2.5 | 思考开关，不伪造深度档位 |

这是项目已登记的型号与参数，不是提供商的完整型号清单，也不保证账户具有访问权限。别名和能力会变化，应定期核对官方文档。温度等参数没有无差别开放，避免与推理型号的固定值限制冲突。工具调用次数（1–32）和查询轮数（2–16）是本项目控制项，并非供应商 API 参数。生成上限为本项目保守范围 1024–32768；不等于各型号最大上下文。

## 服务端凭证

在本机 `.env` 或 Docker 的 `.env.docker` 配置相应凭证；不要提交到 GitHub，也不要写在聊天内容中。

聊天凭证名称：`DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`KIMI_API_KEY`。
对应端点可用同前缀 `*_BASE_URL` 覆盖（例如 QWEN_BASE_URL）；千问不同地区/工作空间须使用账户对应端点。

默认提供商由 `AI_PROVIDER` 指定；保留旧的 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`。旧 key 只用于配置中指定的同一家提供商，不会在切换厂家时传给另一家。
Embedding 单独使用 `EMBEDDING_PROVIDER`、`EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`，或 `OPENAI_EMBEDDING_API_KEY` / `QWEN_EMBEDDING_API_KEY` 与相应 `*_EMBEDDING_BASE_URL`。

修改 Docker 环境凭证后需重新创建 app 容器；页面切换本身无需重启。命名提供商在页面保存后采用其默认端点或专属 BASE_URL，而不是旧 AI_BASE_URL。自定义兼容服务通过配置文件设置，页面不会猜测它支持哪些高级参数。

## 接口与持久化

- `GET /api/models`：读取当前聊天、Embedding 配置，以及可选型号/能力；不返回密钥。
- `POST /api/models`：本地同源请求；模型请求进行中返回 409；无效参数返回 400。

聊天示例请求体：
```json
{"target":"chat","provider":"openai","model":"gpt-5","inference":{"reasoningEffort":"medium","maxTokens":8192,"maxToolCalls":12,"maxRounds":8}}
```
Embedding 示例：
```json
{"target":"embedding","provider":"qwen","model":"text-embedding-v4","dimensions":1024}
```

选择保存在 `runtime/model-settings.json`（忽略提交），Docker 使用 model-settings 持久卷。文件只含选择参数，不含密钥。其优先级高于环境变量；如需回到环境默认，在停服后备份该文件并将其内容设为 `{}`，再启动。不要删除数据库卷。

保存不调用模型、不自动测试连接、不自动重建向量索引。切换 Embedding 后，已有索引会按模型、端点与维度的 profile 区分；需要核验/重建匹配索引后才恢复该模型的向量检索。维度最终仍由提供商响应校验，任意整数不保证厂家支持。

## 适配依据

- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [千问深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking/)
- [OpenAI Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Kimi thinking models](https://platform.kimi.com/docs/guide/use-thinking-models)
- [OpenAI Embeddings](https://developers.openai.com/api/docs/guides/embeddings)
- [千问 text-embedding-v4](https://help.aliyun.com/zh/model-studio/text-embedding-v4)

协议映射与界面已做离线测试；没有使用真实凭证进行跨提供商付费生成验收。提高推理设置不保证答案质量，需要继续以自然语言查询评测衡量。
