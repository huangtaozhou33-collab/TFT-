# TFT 统计数据源选型

核查日期：2026-10-10（Australia/Sydney）。保留 OP.GG 已有榜单，Riot 官方比赛数据现已接入严格条件筛选器与 Agent 共用查询。当前已入库 87 场，其中 36 场满足模式、结构及推定主补丁窗口，可查询 288 份玩家终局；每日限量采集已启动。下文小批实测属于最初的来源验证，最新实现、命令和边界见 [Riot 采集与查询](RIOT_PIPELINE.md)。MetaTFT 和 Tactics.tools 仍适合争取授权接入。

## 数据能力比较

| 来源 | 能提供什么 | 对本项目的意义 |
| --- | --- | --- |
| OP.GG MCP | 现成阵容、单英雄出装、装备携带者等聚合结果 | 接入成本低，继续提供已有功能；已核接口没有任意多英雄同场统计，见 [已有实测](OPGG_DATA_CONTRACT.md) |
| Riot 官方 API | 比赛、玩家结果、最终棋子及其装备等原始记录 | 可自行构建同一玩家阵容的联合统计，但要持续采样、去重和聚合 |
| MetaTFT | 网站提供英雄完整出装、装备携带者和自定义条件 Explorer | 功能贴近目标；本次未找到面向第三方的官方 API 文档、Key 申请或开放数据许可 |
| Tactics.tools | 网站提供版本、段位和多条件 Explorer；高级筛选属于赞助权益 | 可对照产品行为；本次未找到可直接接入的公开 API 契约，赞助权限也不能视作 API 授权 |

来源：[OP.GG 官方 MCP](https://github.com/opgginc/opgg-mcp)、[Riot Match API](https://developer.riotgames.com/apis#tft-match-v1/GET_getMatch)、[MetaTFT 功能说明](https://www.metatft.com/)、[Tactics.tools Explorer](https://tactics.tools/explorer)、[高级筛选说明](https://tactics.tools/patreon)。MetaTFT 本轮直接网页提取只得到 SPA 壳，功能说明来自官方域名的搜索索引正文；不据此判断即时补丁或实时样本量。

## Riot 可以怎样补上严格筛选器

官方 Match DTO 定义包含 `game_version`、`game_datetime`、`queue_id`、`tft_set_number`；每个 participant 有 `puuid`、`placement`、`traits`、`units`；每个 unit 有 `character_id`、`items`、`itemNames`、`tier` 等字段。[接口参考](https://developer.riotgames.com/apis#tft-match-v1/GET_getMatch)

据此可设计查询：先找同一玩家最终阵容包含指定三名棋子的记录，再从该玩家阵容中找小法，筛选携带黎明核心的装备组合，按完整组合计算样本量、平均名次、前四率和登顶率。关联键必须包含比赛与玩家，不能把同局八个人的棋子混在一起。

这是终局阵容的统计方案，不能凭这些字段重建第 4-2 回合的棋盘、装备合成时机或运营过程。样本量取实际匹配的玩家对局记录；采集到的总比赛数、玩家记录数和最后匹配数分别展示。稀有条件可能仍缺足够样本。

采集起点可用 [League API](https://developer.riotgames.com/apis#tft-league-v1/GET_getChallengerLeague) 获取玩家，其当前响应定义直接提供 PUUID，再读取比赛 ID 列表和比赛详情。段位需另存观测时间；比赛 DTO 没有每位玩家当局开打时段位，不能用今天段位替代历史段位，也不能把同局全部对手都归为种子玩家的段位。

## 版本与数据质量

`game_version` 是客户端版本字符串，仍需核验到产品展示补丁的映射；资源版本与游戏补丁分开。官方概览说明资源更新可能延迟。[TFT 文档](https://developer.riotgames.com/docs/tft)

官方仓库的 [问题 1185](https://github.com/RiotGames/developer-relations/issues/1185) 在本次查看时仍开放：报告者在 2026-09-02 的 EUW 双人作战 S18 样本中遇到占位 `game_version` 和缺失搭档字段。这是特定样本的报告，未在本项目复现，不能推断所有普通排位均有故障；也不能承诺换成官方 API 就绝无缺字段。

建议先验收一小批普通排位，检查版本、棋子与装备映射、重复记录、段位时点和联合条件命中量，再决定是否切换主查询来源。缺失字段继续保留原值及核验状态。

同日实测已完成：12 场 S18 比赛中 7 场为普通排位，56 条玩家终局、455 个棋子记录全部精确映射；660 次装备记录中 2 个药水 ID 未收录。**包括 7 场普通排位在内的全部 12 场，`game_version` 均为占位字符串**。这是本项目本次韩服小样本的直接观察，不推广为全部服务器故障，也不自动推定为 18.4。原始数据仅留本机，未写入业务统计库。脱敏结果见 [Riot 实际验收](RIOT_API_VALIDATION.json)，排查过程见 [工程记录](ENGINEERING_LESSONS.md)。

重复小批探测需要显式允许外部请求：`node --env-file=.env.docker scripts/probe-riot.mjs --allow-provider`。离线质量核验使用 `node scripts/riot-sample-audit.mjs data/raw/riot-probes/<本次目录>/matches`；后者不调用 API。开发 Key 到期后需本机更新，不能将 Key 写进命令参数或提交文件。

## Key 与部署选择

开发 Key 每 24 小时失效，适合原型验证；个人 Key 适合私人项目，官方文档列出 20 次/秒及 100 次/2 分钟限额。公开产品需要申请生产 Key，实际采集还要遵守接口限流及 `Retry-After`。[官方 Key 说明](https://developer.riotgames.com/docs/portal#api-keys)

开源代码和 Docker 镜像不能包含维护者密钥。提供预先采集的合格初始包与提供持续在线数据服务是两个部署选择，后者需要明确运营主体及接入许可。官方将不涉及具体玩家的聚合统计列为可申请的生产用途；实时根据当前对局状态指挥玩家的用途另有限制。[TFT 用途政策](https://developer.riotgames.com/docs/tft#game-policy)

## 建议的项目分工

Riot 原始比赛进入 MySQL，统计服务执行条件查询，Redis 缓存结果，前端和 Agent 共用接口。Milvus 继续负责机制与规则文本。保留 OP.GG 作为已有聚合数据来源，明确来源和样本口径；不要将两个来源的指标直接混算。

MetaTFT 如能提供正式授权的聚合或条件查询接口，可能显著减少自采成本；在取得接口契约、额度与缓存展示范围前，不应视作已可替换。搜索中出现的第三方“MetaTFT API”包装服务也不等于 MetaTFT 官方开放 API。
