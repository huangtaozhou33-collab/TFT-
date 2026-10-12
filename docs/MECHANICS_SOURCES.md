# Set 18 法杖 / 自然仙灵版本知识库

本机网页与 Agent 调用 `getSeasonMechanic()`，只读已经发布且通过校验的当前版本包，不实时访问数据网站。当前包绑定 `tft-set18-assets16.20-5fedf1ff9cba`；赛季、资产版本或规则版本变化会产生独立键。未收录、跨版本或完整性校验失败时返回 `status: not_cached` 和空条目，明确说明需要独立同步。

## 来源与时间

| 字段 | 来源 | 原采集时间 UTC | 具体补丁 |
| --- | --- | --- | --- |
| 当前赛季成员、实际 ID、简体名称、效果数值 | [CommunityDragon 16.20 zh_cn](https://raw.communitydragon.org/16.20/cdragon/tft/zh_cn.json)；英文名称使用同版本 en_us | 2026-10-07 13:39:03.456 | 未声明游戏补丁，资产版本为 16.20 |
| 费用、阶段标签、分类、1–3级字段、公开变体分组 | [Tactics.tools Set 18 信息](https://tactics.tools/info/set-update) 公开 HTML 的 `__NEXT_DATA__.props.pageProps.anomalies` | 2026-10-07 15:55:37.469 | `sourcePatch: null` |
| 繁体名称 | [Tactics.tools 繁体 Set 18 信息](https://tactics.tools/tc/info/set-update) | 2026-10-07 15:55:38.776 | `sourcePatch: null` |
| 机制基本规则 | [Riot Games 赛季前瞻](https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/enchanted-wilds-overview/) | 2026-10-07 15:57:58.668 | 2026-07-27 发布的赛季前瞻，未当作当前补丁数值依据 |
| S/A/B/C/D 专家评价 | [MetaTFT · Spencer 法杖榜](https://www.metatft.com/wisp-tiers)，公开页面可见分组 | 2026-10-07 15:57:42.000 | `sourcePatch: null` |

Tactics 的赛季介绍没有为条目声明具体补丁，不能从其他统计页或导航借用 18.4。效果使用当前绑定的静态资产说明，费用等元数据使用公开页面并保留各自采集时间；它们不代表已经证明两来源属于同一游戏补丁。`entry.source.descriptionSource`、`metadataSource`、`conditionsSource` 独立保留来源、时间和哈希；规则与专家评价也独立记录。

专家榜页面显示相对标签 `20 hours ago`，未提供经核验绝对更新时间，故 `sourceTime: null`；采集时间不是作者更新时间。这是职业选手攻略评价，不是对局胜率、样本量或机器推算排名。

## 覆盖范围与可获得性

当前静态赛季目录中有 **349 个来源实体**：165 基础、165 升级、19 棱彩变体。按当前 Set 18 `set.items` 成员、实际机制图标路径、非强化符文及空合成配方过滤；不使用历史赛季全部全局装备列表。当前 349 条效果中的静态占位数值均已解析。

公开页面有 367 个条目，实际 ID 与当前赛季目录交集是 **338 个**；29 个不在当前目录的页面条目排除并记录实际 ID。349 并非 349 个已证实可以购买的法杖，也不代表已完整覆盖所有合法局面。

以下 **11 条**只有静态来源存在，尚不能判断其当前可获得性或是否为测试、弃用条目。它们保留供查询效果，但 `active: null`、`availability.status: unverified`，费用、出现阶段、分类等未知字段不编造：

| 来源基础 ID | 相关实际变体 |
| --- | --- |
| `DA_18_Drizzle` | `DA_18_Drizzle_Upgrade` |
| `DA_CloneCompanion18` | `DA_CloneCompanionUpgrade18`、`DA_CloneCompanion18_Prismatic` |
| `DA_FoundBigFriend18` | `DA_FoundBigFriend18_Upgrade` |
| `DA_18_GroveArmor` | `DA_18_GroveArmor_Upgrade` |
| `DA_TrueFriendship18` | `DA_TrueFriendship18_Upgrade` |

对其余 338 条，`active: true` 仅表示当前赛季目录与公开图鉴均列出实际 ID；`availability.purchaseConditionsVerified: false` 明确表示没有验证任意阶段、羁绊和局面下的全部购买条件。来源只明确说明男爵之手需要激活峡谷野怪羁绊，该条已单独记录；不能把这一条已知条件当作所有出现规则均已查明。覆盖 `complete: false`。

## 字段语义与规则

- `stages` 是来源字符串数组：`Early`、`EarlyMid`、`Mid`、`MidLate`、`Late`、`VeryLate`。只显示来源阶段标签，不擅自映射为 2-1、3-1 等数字回合；来源空列表归一为 `null`，含义是阶段未知。
- `category` 是来源七类代码，`categoryName` 是中文显示名：英雄、战斗、金币/经验、装备、杂项、风险交易、商店。来源没有分类则为 `null`。
- `tier` 是公开数据库的 1–3 级字段；`upgrade.variant` 为实际 `base/upgraded/prismatic` 变体。它们均不是 S–D 专家评价。
- `cost` 是公开条目的费用；`conditions` 是已明确说明的必要条件数组，未知时为 `null`。
- `upgrade` 关联仅使用公开实际分组与当前实际 ID，或静态 ID 明确变体标记加相同英文名。不编造缺失变体，不把 `UnitTier` 或星级占位变量当作法杖等级。

Riot 前瞻核验的机制原则：通常每回合可购买一枚；商店最右格每隔一个商店出现法杖；只能在准备阶段购买；多数效果持续一回合；第 5 阶段之后每隔一枚保证为战斗类别。不能将“每隔一个商店”写成“每隔一个回合”，也不能将后期规则写成所有法杖都是战斗类。

灵魂莲华的 3/5/7/9/11 档相关效果直接读取当前 catalog 的羁绊说明，不借前瞻旧数值。临时转职或临时属性效果按条目的时效展示，不视为永久纹章、库存装备或永久羁绊。

## 专家榜匹配

本机保存的 Spencer 公开奖级共 174 个不同英文名称：S 43、A 40、B 75、C 11、D 5。仅在当前**基础变体**中按英文名精确匹配，统一大小写、Unicode 弯引号与空白，不做近似匹配。当前 165 个基础实体匹配 **161 个**，13 个榜单名字未映射到当前基础目录；差异保留在 `rating.coverage.unmatchedSourceNames`。

升级和棱彩变体均不继承基础评价，未匹配条目保持 `unrated`，不填造 S–D。专家数据单独绑定赛季和版本键，拒绝错赛季、错上下文、重复名字或无效格式；输出 `recordSha256` 是当前本地评价文件的内容指纹，不是作者真实性签名。条目不包含伪造 `stats`。

## 同步、发布与验证

```powershell
npm run sync:mechanics
npm run sync:mechanics -- --offline
npm run sync:mechanics -- --force
```

同版本已有有效包时默认跳过，不改原采集时间。`--force` 显式重录；`--offline` 禁止网络，没有已有包或完整本地 HTML 导入时失败并保留原包。公开 HTML 无法解析、赛季不符、实际 ID 重复或未知阶段标签时失败，不使用未公开接口回退。

已有公开 HTML 可以离线导入并保留原采集时间：

```powershell
node scripts/sync-mechanics.mjs --force --offline --from-html=PATH_EN_HTML --fetched-at=ORIGINAL_UTC --rules-html=PATH_RIOT_HTML --rules-fetched-at=ORIGINAL_RULES_UTC --tc-html=PATH_TC_HTML --tc-fetched-at=ORIGINAL_TC_UTC
```

原始 HTML 保存在 `data/mechanics/raw/<cacheKey>/`，用于本机核查并忽略入 Git。归一包存为 `data/mechanics/<cacheKey>/<UUID>.json`，写盘后校验哈希并原子发布 manifest；无效刷新不覆盖旧 manifest。运行时不依赖 raw、网络或网站 API。专家榜在独立 `ratings/set18-spencer.json` 读取，网页和 Agent 共享相同匹配结果。

`tests/mechanics-data.test.mjs` 全部使用隔离 fixture，不依赖本机原始下载或真实快照；验证实际 ID/变体与未知可获得性、来源数值和独立时间、错误来源拒绝、缺包/跨版本/哈希损坏、零运行时网络、基础限定专家匹配、同版本跳过、离线禁网和失败刷新保留原包。
