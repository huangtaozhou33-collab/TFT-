# 统计数据自动更新

入口：开发者模式 → 统计自动更新。五类任务默认启用，每 24 小时检查一次；各自可配置 1～168 小时、暂停或立即采集一次。首次启用的下一次运行安排在 24 小时后，不在部署时隐式启动全目录爬取。修改周期从保存时间重新计算，运行中修改/暂停对下一轮生效。立即采集是一次性排队，不改变周期，也可在自动更新暂停时执行。

## 范围与路径

唯一任务注册表是 `server/statistics-schedule.mjs` 的 `STATISTICS_JOBS`，开发者页面直接读取该注册表，不接受用户提交任意 URL 或命令。

|任务|来源接口|本地查询路径|
|---|---|---|
|MetaTFT 阵容榜|`/tft-comps-api/comps_data`、`comps_stats`|`/api/comps/v2` → `loadMetaDataset(comps)`|
|MetaTFT 综合榜|`/tft-explorer-api/total`、`units_unique`、`items_unique`、`traits`|大数据 / Agent → `loadMetaDataset(overall)`|
|MetaTFT 全棋子出装|`/tft-explorer-api/unit_builds/{championId}`|大数据 / Agent → `loadMetaDataset(builds)`|
|MetaTFT 全装备持有者|`/tft-explorer-api/item_units_unique/{itemId}-1`|大数据 / Agent → `loadMetaDataset(holders)`|
|OP.GG 参考|`https://mcp-api.op.gg/mcp` 的 `tft_list_meta_decks`、`tft_get_champion_item_build`、`tft_list_champions_for_item`|`statistics_reference_snapshots`，独立留存参考，尚未添加双来源比较页面，不替代 MetaTFT|

MetaTFT 主机为 `https://api-hc.metatft.com`。每轮先核对来源赛季/补丁元数据；当前目录全棋子、全装备（含散件、神器、光明）分别遍历全部 12 种段位范围。保留普通排位、近 3 天及请求补丁；来源统计响应未明确给出补丁，继续保留 `sourcePatch:null`。OP.GG 不提供的段位、地区、窗口保持未知。不存在跨来源平均胜率、累加样本或静默降级。

资料库、英雄机制、黑话、视频知识与 Milvus 不属于这些任务，仍通过原来的赛季资料发布流程更新。复杂筛选不定时穷举，继续按需查询并使用现有 10 分钟条件快照。

## 持久化与运行

迁移 008 新增 `statistics_jobs`（周期/状态/进度）、`statistics_job_runs`（执行历史）、`statistics_reference_snapshots`（OP.GG 独立原响应）。MetaTFT 继续使用原有数据集和统计行表。保存周期采用 revision 冲突检查。配置来自 MySQL，容器重启不恢复成默认值。

应用进程每 15 秒检查到期任务，使用持有整个执行期间的 MySQL advisory lock 串行运行，跨进程不重复启动；任务报告持续写 MySQL。进程中断后，下次获得锁的工作进程将残留 running 标为 interrupted，补一次已到期任务，不回放停机期间的每一个周期。应用 / Docker / 电脑必须运行；这不是离线云定时服务。

MetaTFT 源请求至少相隔 500ms；403/429 立即停止当前批次，保留 Retry-After，未提供时至少冷却一小时。冷却由同一来源的所有任务共享，手动立即采集也受此约束；下一轮执行不早于冷却期限或配置周期。连续三次其他失败停止批次。OP.GG 至少相隔 750ms，失败停止批次，同样保留 Retry-After 并遵守原客户端超时。不会绕过访问限制。

已有同范围的 MetaTFT 快照优先直接读取，不因 6 小时过期而在页面请求中强制重抓。当前发布/补丁/段位/查询键必须匹配；旧快照过期时显示“数据较旧”。缺少本地范围仍沿用现有受限请求路径采集，并非全部改成异步排队 API。后台新结果校验、事务入库后可读；失败不删除上次结果。发布单位是单数据集，不是整批所有接口同时切换，不能声称跨接口拥有同一个来源更新时间。

内容比对排除本系统 fetch 时间，按来源响应数据的指纹比较；相同内容仅延长检查有效期并写任务记录，不新增一份统计快照，也不改写原采集时间。历史快照不在本次任务中清理。Redis 用不可变 snapshot ID + dimension 缓存行（默认 300 秒），失效/宕机回退 MySQL。统计与知识缓存同用现有连接和 TTL 配置，但使用独立 key 前缀。

前端每 5 分钟及切回窗口/切换页面时查询本地 `/api/statistics-version`，检测到变化后清除阵容与大数据内存缓存并重绘当前统计页，保留筛选状态；筛选器只提示重新查询，避免覆盖正在输入的条件。不会重新加载整个页面或清空聊天。此指纹只表示本地数据变动，不冒充来源批次版本。

## 恢复

部署前源码备份：`tmp/stats-schedule-before/`；原镜像 `tft-workbench:before-stats-schedule-20261011`。数据库逻辑备份 `mysql.sql` 为 715,669,433 字节，SHA256 `06097DCD441FA8627217DA81432B94563EC67AF01C1DBD82AB4217A2CBC9E5C0`。迁移仅新增表，无删除旧统计、知识发布或向量。尚未演练恢复；回退镜像前应先停止自动任务，新表可保留，不需要通过删表回退。
