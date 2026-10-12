# 法杖出现条件：Set 18 / 来源补丁 18.4

此知识包用于查询商店何时可能提供某个法杖。它不计算“必出”或实际概率，不将英雄商店等级概率套给法杖。运行时只读取本地当前版本包，网页和 Agent 不访问上游。

## 实际来源

| 来源 | 提供的资料 | 原采集时间 UTC |
| --- | --- | --- |
| [Little Buddy Bot 原始法杖页](https://www.littlebuddybot.com/tft-wisps) | 标题明确 `TFT Wisp offer rules (18.4)`；实际 ID、费用、六档精确回合窗口、模式、特殊门槛、强化排除及再次提供冷却 | 页面 2026-10-07 16:24:57.905；公开 CSV 16:25:45.277 |
| [Riot Games 18.4 补丁公告](https://teamfighttactics.leagueoflegends.com/en-gb/news/game-updates/teamfight-tactics-patch-18-4/) | 买得起才提供、新增低金币法杖窗口、变形术最初2秒、低生命值排除 | 2026-10-07 16:24:59.218；文章发布 2026-10-06 18:00 |
| 本机同版本 CommunityDragon `en_us` | 用当前赛季实际羁绊 ID 与准确英文名称，将条件中的英文羁绊对应到当前中文目录；不用于替代18.4费用 | 2026-10-07 13:39:03.456 |

Little Buddy 页面的公开 HTML 内嵌组件声明了一个公开发布的 Google Sheet CSV 地址。同步脚本解析这个页面声明后读取 CSV，没有猜测私有接口、执行网站脚本或安装网站依赖。完整 CSV 为 **372 行 / 140 列**，保存在本机 raw 快照中；作者绝对更新时间未提供，`sourceTime: null`。

出现条件的 `sourcePatch: 18.4` 来自上述页面自身；效果图鉴的 Tactics/CD 具体游戏补丁依旧未知。当前购买费用仅使用18.4条件表的数字 `Cost`，不借用补丁未知的旧 Tactics 费用。各字段保留来源与时间。

## 已录入范围

当前机械图鉴有349个来源实体，按实际 `mName` 一一精确匹配 **343 个**。其中159条有特殊出现门槛；343条均有冷却及回合窗口；24条有强化排除项。基本版、升级版和棱彩版各读自己的实际行，不进行名称模糊匹配或变体继承。所有已提供的特殊条件文字均已归一化，但这不证明已经核验所有隐藏条件。

当前6个实际 ID 未见于18.4条件表，返回 `not_documented`，费用/窗口/冷却保留未知：

- `DA_CloneCompanion18`
- `DA_CloneCompanionUpgrade18`
- `DA_CloneCompanion18_Prismatic`
- `DA_TrueFriendship18`
- `DA_TrueFriendship18_Upgrade`
- `DA_SolarGift18_Upgrade`

372条来源记录中另外29条不在当前349目录，未擅自扩展主目录。完整原表保留，归一包 `excludedSourceRows` 也保存这些实际 ID、条件、费用、窗口、冷却等，并明确 `membershipVerified: false`。其中 Riot18.4明确新增的 `DA_RoomForAShroom` / `DA_RoomForAShroomUpgrade` 有 Little Buddy 行，但与当前绑定静态目录存在覆盖差异；不能称343匹配已经代表全部当前可购买法杖。

此前只见于静态来源的法力细雨、树丛铠甲、回归的好友各基础/升级共6条，现在有独立18.4来源条件。原图鉴中其他字段的来源标识仍保留，不能把新来源补丁追溯给旧效果数据。

## 字段与条件类型

`getMechanicOfferingConditions({catalog, entries, dir})` 返回 `{status, delivery, cacheKey, context, source, sources, rules, entries, coverage}`。`dir` 是机制根目录，默认 `data/mechanics/`，不是 `conditions/` 子目录；隔离测试可以传任意独立根目录。

每条 `entries` 是 `{id, offeringConditions}`，内容如下：

| 字段 | 语义 |
| --- | --- |
| `conditionsText` / `sourceText` | 中文说明数组与原始门槛文字，便于核查 |
| `offerConditions`、`allOf` / `anyOf` | 所有必要条件及可选分支；有 `field/op/value/scope` 和来源引用，但 `complete:false`、`eligibilityGuaranteed:false` |
| `purchaseConditions.cost` | 18.4实际行的费用 `{value,unit:'gold'}`；支付能力也会限制出现 |
| `triggerConditions` | 效果触发沿用 `entry.description`，未把“战斗8秒后触发”等混进商店出现限制 |
| `roundWindow` | 可出现回合数组 `{from,to,inclusive,sourceRefs}` |
| `sourceRoundWindow` | 原始 Little Buddy 阶段分组对应窗口，官方覆盖时仍保留 |
| `excludedBy` | 持有这些强化时不能提供；保留实际来源 ID，`catalogMapped` 明确是否对应当前强化目录 |
| `cooldown` | 被提供后再次提供的间隔，单位 `wisp_shops`，`trigger:'offered'`；各变体是否共享冷却为 `sharedAcrossVariants:null` |
| `weight` / `probability` | 未给权重、完整候选池及概率分母，`value:null`，不视为均匀抽取 |
| `modes` | 明确 Yes/No 才映射 true/false；空值为 null |
| `conflicts` / `unknownFields` | 源边界差异和未核验维度，不以“符合部分条件”保证能出现 |

在本数据内，`army_any_location` 保留来源“army任意位置”的口径；正文显示“队伍中（位置不限）”。不把它缩成“只看棋盘”，也不因为某个核心英雄满足效果触发就认为满足出现数量门槛。角色、伤害类别、叠层装备等分类按原条件记录；当前英雄分类未知时，不能自动推断资格。

Little Buddy 明确的六档窗口为：2-1至2-7、3-1至3-4、3-5至4-1、4-2至4-7、5-1至5-7、6-1至10-1。窗口只说明可能出现的时段，不是出现频率。

## 边界与例子

| 条目 | 核验条件示例 |
| --- | --- |
| 超级暴击 | 队伍中位置不限，至少2名英雄已经可以技能暴击；18.4费用2；4-2至10-1的相应来源窗口；再次提供冷却5个法杖商店。效果是为已有该能力的友军提供暴击伤害，不能把1名持有无尽之刃的核心说成满足2人的出现门槛。 |
| 预言之子 | 金币至少35、生命值大于50、等级至少10；来源窗口6-1至10-1；冷却200个法杖商店。没有将此等级门槛套到其他法杖。 |
| 法力细雨 / 树丛铠甲 / 回归的好友 | 金币少于10、费用0。Riot明确4-1至5-7；Little Buddy阶段列从4-2开始。本包用官方窗口并记录 `official_patch_override`，保留原始阶段分组。 |
| 超级暴击基础/升级 | 两条各自明示2名技能可暴击英雄，非继承推断。 |
| 零碎（Scrappy）基础/升级 | 来源分别要求棋盘上至少2名/3名无装备英雄。 |
| Phantom Splash 基础/升级 | 分别要求至少2个/4个已贡献但未激活羁绊。 |
| Ride the Wave 基础/升级 | 分别限定准备阶段最初20秒/2秒。 |

Riot低生命值改动明确“低于20”排除属性消耗品、金鹅、重大冒险、易货；Little Buddy相关行写“大于20”。当前目录22个变体记录 `boundary_conflict`：**生命值恰好20时未作资格保证**。本包没有把其中一条边界隐藏掉。

Abandon Ship 的售价条件为逐个累加单位售价时运行小计曾落入15–24范围，不能简化成总棋盘价值必须15–24；遍历顺序未知。变形术类的最初2秒门槛是出现限制，不是效果在战斗开始2秒后触发。

零金币也不能据此断言只剩分解者且必出：18.4增加低金币池，既有强化排除、冷却、阶段与其他条件也会改变候选集合。当前表不提供完整权重，不能补造某条法杖概率。

## 更新与完整性

```powershell
npm run sync:mechanics-conditions
npm run sync:mechanics-conditions -- --offline
npm run sync:mechanics-conditions -- --force
```

机制目录须先发布。已有同版本且实体集合一致的有效条件包默认跳过，不改变原采集时间；`--force` 是显式重录。`--offline` 不联网：已有有效包可复用，也可导入完整本地 HTML/CSV，否则失败并保留旧包。

```powershell
node scripts/sync-mechanics-conditions.mjs --force --offline --from-html=PATH_LBB_HTML --csv=PATH_PUBLIC_CSV --riot-html=PATH_RIOT_HTML --fetched-at=ORIGINAL_CSV_UTC --page-fetched-at=ORIGINAL_PAGE_UTC --riot-fetched-at=ORIGINAL_RIOT_UTC
```

条件包在 `data/mechanics/conditions/<cacheKey>/<UUID>.json`；原始文件在 `data/mechanics/raw/conditions/<cacheKey>/`，保留完整372行CSV和页面用于本机核验。先校验来源、上下文、实际ID集合与写盘哈希，再原子更新 manifest。未知补丁、源格式变化或无效刷新不覆盖最后有效包。读取也核对实际ID集合与传入目录一致，不跨版本、跨实体集合借用。

`tests/mechanics-conditions.test.mjs` 使用独立 fixture，不依赖当前原始CSV或已发布数据。覆盖条件与费用/效果分离、变体差异、未知变体、官方窗口覆盖、HP20差异、来源/CSV校验、版本及实体集合隔离、哈希损坏、零运行时网络、离线导入原时间以及失败刷新保留旧包。
