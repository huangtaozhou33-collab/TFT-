# TFT V1 数据来源与核验

> 本文件是 V1 来源核验历史，后续数据库统计已切换 MetaTFT。当前入口、来源边界、段位与采集覆盖见 [V4 数据架构](DATABASE_ARCHITECTURE.md)，不要把下文旧采集状态当作当前状态。

核验日期：2026-10-08（Australia/Sydney）。仅用于本机个人研究，没有部署；OP.GG 统计通过公开 MCP，羁绊统计按用户授权单次读取 Tactics.tools 公开 HTML。

## 已完成的实际调用

官方入口是 [OP.GG MCP](https://github.com/opgginc/opgg-mcp/blob/main/README.md) 的 `https://mcp-api.op.gg/mcp`，采用 Streamable HTTP。客户端实现原生 Node Fetch、JSON-RPC、JSON/SSE 两种响应、会话头、初始化通知、分页工具发现，以及过期会话 HTTP 404 后重新初始化。实际协商协议版本为 `2025-06-18`，服务端为 `OP.GG MCP Server 1.0.0`，发现 29 个工具，其中 6 个 TFT 工具。

| 工具 | 实测输入 | 结果 | 关键边界 |
|---|---|---|---|
| `tft_list_meta_decks` | `{}` | 10 个阵容，全部匹配 `TFTSet18` | schema 不支持补丁、地区、段位、星级筛选 |
| `tft_list_item_combinations` | `lang: zh_CN` | 519 行；响应自带 `set:18, version:18.4` | 内含历史行；只接受当前标准模式交集与明确装备类别 |
| `tft_list_augments` | `lang: zh_CN` | 285 行 | 表格式 headers/rows；249 行映射当前标准模式，36 行排除 |
| `tft_get_champion_item_build` | `champion_id: DA_18_Ahri` | 451 个三件套记录 | 时间、补丁、段位、地区未提供；不能推出全队最优 |
| `tft_list_champions_for_item` | `item_id: DA_InfinityEdge` | 13 个持有者记录 | 只确认该装备本次结果，不代表所有装备覆盖 |
| `tft_get_play_style` | 未调用 | schema 已核验 | 必填 `region`、真实玩家 `puuid`；未提供玩家身份，因此未采集个人资料 |

阵容统计源时间 `metadata.gameStatDateTime = 2026-10-07T12:59:23.000Z`，响应总局数 `gameStatCounts = 551048`。具体阵容使用 `stat.deck` 而非 `stat.label`；例如首阵容分母是 `compsCount=7466`，总体分母 `totalCount=407722`。两种口径分别保留，不把总局数当作每个阵容的样本数。

阿狸出装样本数使用 `itemCount`，总体参考 `totalChampionCount`；无尽持有者样本数使用 `totalCount`。均不推导未返回的 pickRate，不将观察差异当因果收益。装备响应 `18.4` 只属于该响应，**没有借给阵容、出装或持有者统计充当补丁**。

后续版本知识库补录了茂凯 `DA_18_Maokai` 的 590 条出装记录，以及全部 21 件当前纹章的持有者统计，每件返回 10–39 行，所有行均映射当前目录。2026-10-07T14:36:18.914Z 发布的阶段快照含 10 个阵容、4/74 条英雄/形态出装、23/127 件非散件装备持有者、21/21 件纹章持有者，整体 `complete=false`。此数值是该次阶段发布的历史记录；当前完成度以 `/api/stats` 和当前版本 manifest 为准，不能将局部覆盖称为全量数据。

## 上次 DNS 问题的分层复测

| 检查 | 本次真实结果 | 判断 |
|---|---|---|
| 沙盒内 Node Fetch：OP.GG 与 CommunityDragon | 都为 `getaddrinfo ENOTFOUND`；系统 DNS 查询拒绝访问 | 执行环境联网限制，不能解释为源站 DNS 不存在 |
| 自动审核允许的只读联网；Node 默认地址排序 | 间歇 `UND_ERR_CONNECT_TIMEOUT` | 连接层，未取得 HTTP 响应 |
| Windows Curl 默认 TLS | `CRYPT_E_REVOCATION_OFFLINE` | 在线吊销服务不可用；与 MCP schema 无关 |
| Node `--dns-result-order=ipv4first` / 模块 `setDefaultResultOrder('ipv4first')` | GET 得到 HTTP 405；初始化和五业务工具成功 | GET 405 是该端点对无请求 GET 的 HTTP 状态，不是业务工具失败 |
| 重试初始化 | 首次仍有一次连接超时，随后成功 | 保留间歇路由风险，不能声称 IPv6 根因已被完整证明 |

采用 IPv4 优先后实际 MCP 请求成功，TLS 证书验证始终开启，没有 `NODE_TLS_REJECT_UNAUTHORIZED=0`、不安全证书跳过或 IP 硬编码。Windows Curl 的 best-effort 吊销检查只用于独立只读诊断，应用运行不依赖 Curl。失败由 `describeError` 分别标为 dns、tls、connection、http、mcp、schema、tool；原始服务端字段缺失不写成网络失败。

## 静态目录

按 [CommunityDragon 项目文档](https://www.communitydragon.org/docs) 从其公开 RAW 下载。`sync-data.mjs` 先读取发布版本目录，解析最大已发布版本，本次为 `16.20`，然后下载固定版本双语 JSON，不把 `latest` 的跨补丁变动悄悄合并。文件 SHA-256、字节数与 HTTP Last-Modified 保存在 `data/raw/cdragon-manifest.json`。

同一 assetVersion 的双语原包已在本机时，默认复用并保留原采集时间；`--force` 才重新下载，`--offline` 完全跳过联网。归一化仍按当前规则重建，因此修复规则可生成新的规则版本指纹，而不会声称静态原包被重新采集。

当前标准模式从 `setData` 选择 `mutator === TFTSet{number}` 的最高已发布赛季，本次为 `TFTSet18`。排除 PvE、PAIRS、TURBO、活动/教学 mutator。冠军进一步排除无羁绊实体与非 1–5 费的内部实体；74 条包括拉克丝的可区分形态，**不等于 74 个独立商店英雄**。

当前归一化目录：74 条英雄/形态、137 件装备（10 散件、39 常规可合成成装、88 特殊装备，其中 31 神器、21 纹章）、35 羁绊、249 条已交叉映射强化符文、55 条验证配方。所有配方组件必须能映射散件，两份来源组件有序一致才标记 `recipeVerified`。保留特殊装备类别与兼容字段；无法验证的配方不能冒充标准合成。

神器缺项原因是 `DA_Artifact_DeathsDefiance` 不在 CommunityDragon 的本次 item 导出和标准 set.items 中，但 OP.GG 的明确 Set18 装备响应包含该行，且原始字段 `org.isArtifact=true`、`org.isUnique=true`。本版仅对这种明确当前赛季、明确神器标记的 `DA_Artifact_` / `DA_Item_Artifact_` 实体补录，显示 `sourceOnly=true`、identity/description 来源 `opgg`；没有混入 9 条历史 `TFT17_` 神器或其他内部装备。

死亡之蔑的持有者统计有独立覆盖缺口。2026-10-07T14:43:31.930Z 再次真实初始化并发现工具后，`tft_list_champions_for_item.inputSchema.properties.item_id.enum` 含 142 个允许 ID，其中只有 30 个神器。静态原行的 `apiName/_key/org.ingameKey` 均为 `DA_Artifact_DeathsDefiance`，明确的 `org.key=OrnnItemDeathsDance` 也不在该 enum；没有找到被公开 schema 接受的同源别名。CommunityDragon 的英文同名旧实体 `TFT4_Item_OrnnDeathsDefiance` 也不在 enum，不能用历史 ID 替代当前实体。缓存记为 `not_supported`，没有绕过 schema 请求、冒用死亡之刃或生成假持有者数据。此证据仅说明**公开工具的允许 ID 列表没有暴露此装备**，不能推出 OP.GG 内部数据库从未有过该装备统计。

两种【窃贼手套】的 OP.GG 描述明确写 `Consumes 3 item slots`，因此 `slotCost=3`，其他装备默认 `slotCost=1`。当前规则版本为 `set18-assets16.20-recipes18.4-v4`，旧草案和规划必须失效。当前接受的 137 件装备，两个来源都没有提供非空 associatedTraits/incompatibleTraits 关系，不能假装已核验所有纹章兼容关系。常规成装标记 `allocationVerified=true`；散件和所有特殊装备标记 `false`。特殊库存保留在账本，不自动分配、不自动合成。用户输入的锁装视为其已有现状原样保留，本版不验证其兼容关系，也不宣称这些锁装已通过完整游戏规则校验。

21 件纹章已按当前中文名称严格相等连接：`item.name === trait.name + '纹章'`，保存 `traitId/traitName` 和 `traitMapping.method=exact_name`，并明确 `compatibilityVerified=false`。名称连接说明该纹章对应哪个羁绊，不能当作任意英雄可装备的规则证据。

源文件本身含旧赛季、内部和未完整导出数据。OP.GG 装备与强化表同样混有旧行；当前归一化采用标准模式 ID 交集，未知行保留 raw，不进入页面统计。`coverage.complete=false`。源版本和游戏补丁分开，`gamePatch=null`。

当前职责字段只有 2 条非空，当前英雄技能都至少有一个未导出动态变量。数值只按已提供变量替换，支持数值/星级数组、乘法与可解析变量哈希。未知公式显示 `〔数值未知〕` 并设置 `descriptionIncomplete`；不生成猜测数值。Riot 特殊标签和图标占位已清理，页面只渲染纯文本。部分装备源中文说明为空，保留 OP.GG 英文效果且标注 `descriptionLanguage=en_us`。五个典型图标已实际 HEAD 验证为 HTTP 200 `image/png`。

## 模块契约与复验

- `getCatalog()`：读取已验证本地 `data/catalog.json`，返回 context/champions/items/traits/augments/coverage/sources；按文件修改时间与大小重载，可在同步发布后更新当前进程目录。
- `getMetaDecks()`、`getChampionBuild(id)`、`getItemHolders(id)`：返回 `{status,data,evidence,reason}`，只读当前版本本地知识库、只映射当前目录。证据明示 `delivery=version_cache`、`cacheKey`、asset/rules/set、原始 `fetchedAt`、`sourceTime`、快照年龄、样本分母和未知筛选维度。保留 `status=live` 兼容页面，该字段表示记录有真实来源；采集方式由 delivery 说明。
- `fetchOPGGTool(name,args)`：名称为兼容既有 Agent 工具保留，实现也是五项 TFT 工具的纯本地缓存读取，**没有网络调用、24 小时 TTL、15 分钟 TTL 或缺项回源**。缺缓存返回 `status/code=not_cached` 与补录说明，源 schema 明确不支持的实体返回 `code=not_supported`。网页和 Agent 共享相同版本知识库。
- `getStatsOverview()`：只读本地知识库索引，返回实体名称、类别、是否收录、行数和覆盖度，不调用上游。OP.GG 提供阵容、英雄出装和装备持有者视角；独立 Tactics.tools 羁绊缓存有效时 `traitStats=true`。英雄总体胜率、强化符文统计和统一段位地区筛选均为 `false`。不能将三件套表现聚合或包装成英雄整体胜率，也不能将独立羁绊来源的 Diamond+ 口径借给 OP.GG。
- `getSourceStatus()`：静态 coverage、历史实测探针步骤与当前本地缓存覆盖，`opgg.delivery=version_cache`。历史探针业务调用全部成功才汇总 `live`，部分失败为 `degraded`，全部失败为 `unavailable`；玩家运营风格的 schema-only 状态不计入业务调用成功数。

## 每版本统计知识库

仅独立 `scripts/sync-stats.mjs` 访问官方 MCP。默认选择当前全部英雄/形态和全部非散件装备，纹章优先，串行调用并限速；HTTP 429、5xx 和可重试连接失败指数退避。采集前核验真实工具 schema，明确 enum 不支持的实体记录缺口，不能生成空的假统计充当成功。

cacheKey 由 game/set/mutator/assetVersion/rulesVersion/gamePatch 的稳定指纹构成，本次为 `tft-set18-assets16.20-5fedf1ff9cba`。它表示本机知识库的版本绑定，**不证明出装/持有者上游统计属于 assetVersion 所对应游戏补丁**；上游未提供补丁时仍为 unknown/null。当前 Set18 的英雄/装备 ID 映射在发布前逐行验证，未知行从展示排除并记录 rawRowCount/excludedRows。跨 set、asset 或 rules 的缓存不会被当前读取路径接纳。

记录保存在 `data/stats/<cacheKey>/snapshots/<captureId>/records/`；manifest 记录每查询的 SHA-256、源时间、行数、缺口与覆盖。全部暂存记录经磁盘完整性验证后才 atomic rename 发布版本 manifest；中断/失败保留最后可用 manifest。已采集但尚未整体发布的记录保存于同版本 `pending/`，`--complete` 可恢复，不更改已发布记录的原采集时间。版本进程锁防止同时同步同一版本。

同版本已有发布记录时，默认跳过。首次部分录入后须显式 `--complete` 补齐缺项；`--force` 明确重录选择的实体。覆盖同时显示 cached、attempted、unsupported、total；`complete=true` 仅表示全部所选基础实体已经完成采集尝试，源 schema 不支持仍单独显示，不表示具备未提供的统计维度。

## 独立羁绊统计版本包

实际读取 [Tactics.tools 公开羁绊页](https://tactics.tools/traits) 的普通 HTML，HTTP 200、170911 字节，采集时间 `2026-10-07T14:47:39.457Z`。页面标题明确 Set18 / Patch18.4，可见筛选为 Ranked / Diamond+；页面内 `__NEXT_DATA__.props.pageProps` 含 `aperture` 和完整 `statsData.traits`。读取公开页面已嵌入的数据，没有调用未公开 API，没有遍历各羁绊详情或批量抓取。

该来源 `statsData.lastUpdated=1791381395`，对应 `2026-10-07T13:56:35.000Z`；`totalEntries=14635`，页面显示约 14k comps analyzed。地区和精确统计开始/结束时间未提供，保持 null；页面选择补丁 18.4 是本记录自己的来源补丁，资产 16.20、OP.GG 未知统计补丁仍分别保留。14,635 属于独立来源样本，不能与 OP.GG 的总局数或某阵容分母相加、等同。

原始 `traits` 有 90 个 `traitId__N` 档位，其中 89 个通过当前 35 条目录 ID 与 `effects[N-1]` 精确连接。`tier=N` 是一基档位序号，`minUnits/level` 才是对应效果的激活人数；例如 `DA_Juggernaut18__1` 是 2 人主宰。公开页面当前可见的 50 个档位标签与上述阈值逐项匹配，没有冲突；其余只接受存在的同 ID、同效果档位，不按名称猜测。`DA_18_Eclipse__1` 不在当前标准目录，被明确排除。覆盖为 `cachedTraits=35,totalTraits=35,acceptedRows=89,sourceRows=90,excludedRows=1,complete=false`，不声称所有潜在档位必有样本。

**数值单位已与真实页面交叉验证**：主宰一档原值 `count=5837,place=4.41,top4=52.53,won=12.97`，公开 UI 同行显示 `4.41 / 52.5% / 13.0%`，hover 约 5.8k games。因此这份 HTML 内 place 已是均次，top4/won 已是百分数；归一化只将百分数除以 100，保留样本 `count`，绝不再用 place/count 或用百分数/count。解析器拒绝不在均次 1–8、百分数 0–100 范围的字段，避免将其他端点的 sum/count schema 混入。档位之间不是独立对照实验，不声称提高一个档位造成胜率增益。

`server/trait-data.mjs` 导出 `getTraitStats()`，GET `/api/stats/traits` 与 Agent 仅读取同一 `data/traits/<cacheKey>/` 本地包，`delivery=version_cache`；缺包、版本不匹配或 SHA-256 校验失败返回 `not_cached`，不回源。包以固定捕获文件与 atomic manifest 发布，保留原 sourceTime/fetchedAt；`scripts/sync-traits.mjs` 同版本默认跳过，`--force` 才重录。`--offline` 始终禁止联网：可复用已发布包，或显式 `--from-html` 加原始 `--fetched-at` 导入已保存页面；没有有效包/导入文件则失败且不发布。格式、赛季、筛选、样本或映射校验失败不覆盖已发布包。归一化小包与 manifest 可追踪，原始公开 HTML 在包的 `raw/` 中只保留本机。

对照核验了 [MetaTFT 羁绊页](https://www.metatft.com/traits)：浏览器实际显示 Patch18.4 / Ranked / Platinum+ / Last3Days、1,035,816 comps 与统计表，故不能说其没有数据。不过普通 HTML 仅有 SPA 壳，页面需要动态加载；本版选用已验证可单次公开 HTML 保存的 Tactics.tools，不混合两个来源口径。

复验命令（项目根目录，Node 24）：

```powershell
node scripts/probe-opgg.mjs --all
node scripts/sync-data.mjs
node scripts/sync-data.mjs --offline
node scripts/sync-stats.mjs --complete --champions=all --items=all
node scripts/sync-stats.mjs --force --champions=DA_18_Maokai --items=
node scripts/sync-traits.mjs
node scripts/sync-traits.mjs --force
node --test tests/data-cache.test.mjs
node --test tests/traits-data.test.mjs
```

原始公开回包保留在 `data/raw/`，包括 tools/list 与五个业务工具；OP.GG 统计 snapshot/pending 和羁绊 raw HTML 也为本机数据，不提交大体积原包。小体积 manifest 索引、静态目录和归一化羁绊包可追踪。版本缓存缺所依赖数据文件或哈希校验失败时明确未收录，不回源。独立同步只访问官方 MCP 与已核验公开羁绊 HTML，不使用第三方非官方 API 包装接口。

公开 MCP 的代码许可证与数据展示、缓存、再分发授权是不同范围；本版本只在用户电脑作个人研究，没有宣称获得公开商业发布授权。
