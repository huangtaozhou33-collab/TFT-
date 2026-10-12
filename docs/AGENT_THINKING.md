# 查询助手推理配置

环境变量在 `.env.example` 中有示例，Docker Compose 同名变量透传。Docker 修改变量后需重新创建 app 容器；本机直跑会逐请求读取 `.env`。不要将密钥写入此文档。

|变量|默认值|用途|
|---|---|---|
|AI_THINKING|enabled|enabled / disabled|
|AI_REASONING_EFFORT|high|low / high / max|
|AI_MAX_TOKENS|8192|单次模型生成预算，不是整段对话总预算|
|AI_MAX_TOOL_CALLS|12|每轮问答工具预算，包含预取|
|AI_MAX_ROUNDS|8|每轮问答最多模型请求次数，末次不再提供工具|
|AI_REQUEST_TIMEOUT_MS|120000|单次模型请求时限|
|AI_TURN_TIMEOUT_MS|240000|准备完成后整轮调度时限；工具执行仍受各自服务超时约束|

思考模式保留多轮工具调用的 `reasoning_content`，仅用于回传服务商，不写入回答、浏览器或开发追踪。响应的 `execution.reasoningObserved` 仅表示实际收到非空推理字段，不是推理质量评分。`usage` 汇总本轮全部模型调用。

参考 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)。思考模式下不添加不起作用的 temperature 等采样旋钮。兼容服务必须支持相应参数；失败会明确报错，不会偷偷关闭思考。`/api/ai/test` 仍是轻量连通性测试，不代表思考与工具组合验收。

统计路径加载已发布术语库，模型可检索术语、目录和统计服务。`comps.coreCosts` 筛选来源明确标记的核心及当前目录费用，在样本筛选、排序和截取之前执行，支持任意 1–5 费集合。低费核心只能用于找到追三星玩法的候选，不能替代来源未提供的策略/星级标签。

模型负责把自然语言转为受验证的查询参数，可以继续调用工具补足信息。统计数字仍由工具结果渲染；本次未改成自由生成策略讲解，也未引入多 Agent 或训练模型。
