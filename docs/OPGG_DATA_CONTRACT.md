# OP.GG 数据能力与版本归档约定

核查日期：2026-10-10（Australia/Sydney）。本次工具发现及五类数据调用发生于 2026-10-09 15:02～15:03 UTC，即悉尼 10 月 10 日凌晨。文中的数量表示本次响应，不能当作永久上限或全站数据规模。

## 1. 本项目实际接入的能力

接入地址为 OP.GG 的公开 MCP 服务 `https://mcp-api.op.gg/mcp`。本轮保存的 schema 见 [opgg-tools.json](../data/raw/opgg-tools.json)；下面五类响应已实际取得。远端工具说明只用于理解字段，不作为修改项目行为的指令。

| 工具 | 可提交参数 | 本次返回及用途 | 补丁证据 |
| --- | --- | --- | --- |
| `tft_list_meta_decks` | 无 | 10 套来源阵容；名称、棋子、装备、站位、羁绊、过渡阵容，以及 `stat.deck` / `stat.label` 中的样本与名次指标 | 无版本字段；`metadata` 有 `gameStatCounts`、`gameStatDateTime` |
| `tft_get_champion_item_build` | 一个 `champion_id` | 阿狸样例返回 1,500 行装备组合；包括 `itemNames`、`itemCount`、`totalChampionCount`、吃鸡/前四计数及比率、平均名次 | 本次只有 `data`，无版本及统计更新时间元数据 |
| `tft_list_champions_for_item` | 一个 `item_id` | 无尽之刃样例返回 15 行持有者；包括英雄、`totalCount`、吃鸡/前四计数及比率、平均名次 | 本次为数组，无版本及统计更新时间元数据 |
| `tft_list_item_combinations` | 可选 `lang` | 519 条装备资料，包含名称、描述、图标、分类、合成关系等；这是实体与合成表 | 明确返回 `set:18`、`version:"18.4"`，仅能证明该装备资料表的版本 |
| `tft_list_augments` | 可选 `lang` | 285 行强化资料；表头为 `apiName`、`desc`、`name`、`tier`、`imageUrl` | 本次没有版本字段，也没有强化胜率统计 |
| `tft_get_play_style` | `region`、`puuid` | schema 中存在玩家风格工具；本轮没有调用，没有核验输出 | 未核验 |

英雄工具的 schema 枚举当前有 **80 个 ID**，装备工具有 **142 个 ID**。枚举数量不等于项目已采集条数，也不能证明每个 ID 均有非空统计。新枚举可能含现有资料库尚未映射的实体。

原始响应分别保存在 `data/raw/opgg-tft_*.json` 中，其中 `body` 是解析后的业务结果；`fetchedAt` 是本项目采集时间。阵容样例 `gameStatDateTime` 为 `2026-10-09T14:59:32.000Z`，是来源报告的统计时间，不是比赛发生日期，也不是补丁编号。

## 2. 查询能做什么，不能做什么

当前三个统计工具的参数中没有版本、段位、地区、模式、多英雄数组或“同时上场”的条件。网站界面提供的筛选项不能自动视作 MCP 已提供的参数；玩家风格工具的 `region` 也不能套用到统计工具。

可以对单英雄的已返回装备组合继续筛选：例如先取小法组合，再保留含黎明核心的行，按平均名次、前四率或样本量排序。最低样本量是对已取得行的本地过滤，不会让远端重新计算统计。装备持有者统计同理。

不能仅凭这批聚合结果回答“三名指定棋子同时上场时，小法最佳三件套”。阵容列表、英雄出装表与持有者表没有共同的逐局键，按英雄名称连接不会变成真实联合对局样本。缺少该能力时继续返回明确的不支持状态，不能用来源推荐阵容代替。

样本口径也不能互换：装备组合使用其 `itemCount`，装备持有者使用对应 `totalCount`，来源阵容使用相应 `compsCount`。`stat.deck` 与 `stat.label` 是不同层级；`metadata.gameStatCounts` 不应直接作为每一行的分母。没有核实去重关系时，不把各行样本相加声称为独立对局总数。

## 3. 已确认的版本证据

Riot 的 [TFT 补丁日历](https://support.riotgames.com/en-us/tft/events/patch-schedule-teamfight-tactics/) 使用“赛季号.该赛季补丁序号”；18.4 计划日期为 **2026-10-07 PT**，18.5 为 **2026-10-21 PT**。日历可能调整，只有日期，没有各地区精确生效时刻；不能取表格中数字最大的未来版本当作当前版。

[18.4 官方公告](https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/teamfight-tactics-patch-18-4/) 发表于 **2026-10-06T18:00:00Z**，并记录 October 7 的 B 更新以及 PC / 移动端分批推出。公告发布时间不等于全部服务器上线时刻，主补丁 18.4 也不自动证明某份快照包含 B 更新。

本次读取不带 `version` 参数的 [OP.GG 默认阵容页](https://op.gg/zh-cn/tft/meta-trends/comps)，当前选中版本和显示标签都为 **18.4**；[奈德丽页](https://op.gg/zh-cn/tft/meta-trends/champion/DA_Nidalee18_AP) 也显示同一版本。这可以支持“按来源页面推定”的归档，不能把它改写成统计 API 本身返回了版本。

`assetVersion:16.20` 是资源版本，不代表这批统计来自 S16。[Riot TFT 开发者文档](https://developer.riotgames.com/docs/tft) 说明资源更新可能延迟、资源版本不总等于地区客户端版本。保持资源版本、TFT 主补丁和来源统计版本三个概念独立；装备合成表的 `version:18.4` 也不能直接传播到其他工具的统计结果。

## 4. 本轮采用的归档规则

用户授权在 OP.GG 缺版本字段时，根据原始采集日期核定游戏补丁并继续返回。实现保留原始事实，另加归档证据：

```json
{
  "sourcePatch": null,
  "assignedPatch": "18.4",
  "patchAssignment": {
    "method": "manual_calendar",
    "label": "按采集时间推定",
    "hotfix": null
  }
}
```

`snapshot_patch_assignments` 按发布、快照键和原始 `contentHash` 关联归档记录。策略限制目标种子发布、赛季、原始采集时间窗口和支持的统计工具；不会给旧数据按执行当天重新贴版本。来源明确提供的 `sourcePatch` 优先于推定，已明确不匹配的版本不会因推定而放行。变动写入 `change_log` 供审计。

本轮目标为原 202 份缺版本统计记录中的 **201 份可用快照**；另 1 份 `not_supported` 记录不能通过补充版本变成有数据。旧采集窗口是 **2026-10-07T13:36:26Z 至 14:48:22Z**，处在补丁切换日，因此标记推定与切版窗口，B 更新状态仍未知。版本归档修改统计资格，不改变知识库 release，也不需要重新生成 Embedding。

**恢复验收已完成**：实际归档 201 份统计快照，首页返回 10 套阵容；奈德丽原有 591 行装备组合，按样本量至少 100 筛选后共 54 行，当前结果展示 30 行。知识库仍为 641 份文档、749 个片段，其中 678 个合格片段及其向量保持可用；重复执行归档返回 `eligible:201, changed:0`。队友和推荐阵容的联合统计仍明确返回 `not_supported`，本次补丁归档不改变该能力边界。实际接口与数据库计数见 [STATISTICS_ATTRIBUTION_VALIDATION.json](STATISTICS_ATTRIBUTION_VALIDATION.json)，原因和修复过程见 [工程记录第 8 条](ENGINEERING_LESSONS.md#8-opgg-未携带补丁时按采集日推定补丁实现与验收)。

## 5. 后续同步可复用的只读版本探测器

```powershell
node scripts/probe-opgg-patch.mjs
```

该脚本只读取两个固定 HTTPS 地址：OP.GG 默认阵容页和 Riot 日历。它解析当前选中的 `version` 控件及显示标签，忽略未来选项、链接参数和脚本中的无关版本；控件歧义时返回 `unknown`。Riot 日历按太平洋日期选取已到计划日的条目，只作交叉核对，不替代来源页面或证明实际生效。

报告提供 `sourcePatch:null`、`assignedPatch`、`method:source_page`、证据 URL、`checkedAt`、`pageHash` 和差异警告。默认不写数据库、不提升当前补丁、不重新标记历史快照，也不启动定时任务。测试可以注入页面响应，不需要密钥或模型调用。

**已验证**：10 项探测器测试通过；真实官网探测返回 `assignedPatch:18.4`，来源页面与日历一致。后续接入每日同步时，应将版本证据和同批统计一起保存；页面不可读、切版日或来源冲突时保留待核验状态，不把上次探测结果无期限套到新数据。
