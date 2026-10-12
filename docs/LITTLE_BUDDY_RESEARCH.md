# Little Buddy Bot 当前资料范围核验

核验日期：2026-10-08。仅调研公开页面、页面明确声明的公开数据及本机已有包；本次未导入新资料、未做 OCR、未改服务端或游戏数据。中文化与检索架构另见 [接入方案](KNOWLEDGE_INGESTION_PLAN.md)。

Little Buddy Bot 是第三方数据挖掘与机制参考站，不是 Riot 官方游戏说明。它自己的[首页](https://www.littlebuddybot.com/)说明会进行数据挖掘和事实核查，页脚也明确未获 Riot 背书。以下“页面版本”指站点当前声明，不代表已独立逐条核实所有数字。

## 实际资料目录

[用户提供的开局奇遇页](https://www.littlebuddybot.com/tft-encounter-odds)是全站导航的一个入口，正文是开局奇遇概率图表。站点提供的范围比这个单页广：

| 类别 | 实际覆盖的资料 | 已查看的代表来源 |
| --- | --- | --- |
| 系统规则 | 开局奇遇；等级商店概率、卡池数量和经验；强化品质组合概率；战利品法球与分配系统；玩家伤害；金币及刷新订阅 | [商店](https://www.littlebuddybot.com/tft-shop-odds)、[强化品质概率](https://www.littlebuddybot.com/tft-augment-odds)、[法球内容](https://www.littlebuddybot.com/tft-loot-orb-contents)、[分配系统](https://www.littlebuddybot.com/tft-loot-distribution-system) |
| 强化奖励细则 | 多个特定强化的奖励组、掉落或规则，包括随机奖励、金蛋、骰子、开包、前后排相关强化等；不是对局胜率榜 | [金蛋奖励](https://www.littlebuddybot.com/tft-golden-egg)、[混沌召唤奖励](https://www.littlebuddybot.com/tft-call-to-chaos) |
| 强化数据库 | 强化原文、品质、可出现阶段、模式、互斥项与特殊出现条件 | [强化出现规则](https://www.littlebuddybot.com/tft-augments) |
| 羁绊及特殊单位细则 | 棱彩羁绊、魔女奖励、峡谷野怪商店、黑荆棘额外属性、花仙效果及金币、原始祝福、拉克丝形态羁绊加成、灵巧种族效果 | [魔女奖励](https://www.littlebuddybot.com/tft-coven)、[羁绊目录](https://www.littlebuddybot.com/tft-trait-tables) |
| 法杖细则图表 | 英勇献祭、男爵之手、预备叠层、药剂法杖的临时装备效果 | [英勇献祭](https://www.littlebuddybot.com/tft-heroic-sacrifice)、[男爵之手](https://www.littlebuddybot.com/tft-hand-of-baron)、[药剂效果](https://www.littlebuddybot.com/tft-potion-wisps) |
| 法杖数据库 | 实际法杖 ID、费用、回合窗口、模式、特殊门槛、互斥强化及再次提供冷却 | [法杖出现规则](https://www.littlebuddybot.com/tft-wisps) |
| 其他参考 | 赛季更新日程、纹章配方、单人第一阶段及时间线入口 | [其他目录](https://www.littlebuddybot.com/tft-other-info) |

导航的强化表分类下有19个子页入口，羁绊表分类下有8个，法杖细则分类下有4个。这是导航覆盖，不是“所有强化都有完整攻略”的证明；本次对其中代表页面进行了正文核查，未逐一审校整站图内数值。用户所说“海克斯详解”需要区分基本效果、出现限制、奖励明细、攻略推荐和胜率统计：此站已核实的是前三类机制资料，并未核验完整攻略或胜率数据。

## 图片与结构化数据是两种来源

抽查的奇遇、商店、强化品质、法球、奖励、魔女和法杖细则页面主要是 PNG 图表。公开 HTML 能读到标题、版本与图片 alt，但没有这些图表的 HTML 数字表。桌面与移动端常各出现一个图片标签，指向同一素材的不同 CDN 尺寸；不能据此把一张表算成两张。分配系统页面实际有两张不同的素材。

图片 alt 只说明主题，例如奖励、概率、阶段；它不包含完整表格数值。本次未读取图内具体概率或奖励数量，因此不提供这些数值，也未证明每张图和当前补丁逐项一致。将来入库需识别并复核原图单元格和脚注，不能用标题或 alt 补造内容。

两个数据库页面不同：[法杖页](https://www.littlebuddybot.com/tft-wisps)与[强化页](https://www.littlebuddybot.com/tft-augments)的公开 HTML 嵌入了组件，组件声明公开发布的 Google Sheet CSV。可以直接解析明确声明的表格，不必先对这些数据库做 OCR，也不需要猜私有 API。

本次只读核验强化 CSV 为 **254 个不同 ID / 59 列**。字段包含 `mName`、说明、品质、阶段2/3/4、标准/双人/试炼模式、每次强化选择仅允许一个玩家拿到的限制、互斥项、特殊条件、标签及回合变体。该单玩家限制有“奇遇可打破此规则”的来源脚注，不能简化成整局唯一。

强化源 ID 精确匹配当前本机249项目录中的 **248项**；缺少当前目录的“好事成双”。另6条来源行不在当前目录，不能只因存在于表中就作为当前标准模式可选强化发布。本次只验证结构和 ID 覆盖，未对254行全部条件做语义归一化或兼容验证。数据源链接由页面实际组件声明：

[强化公开 CSV](https://docs.google.com/spreadsheets/d/e/2PACX-1vShpiG0SYdP0maB0MQ8WOczlwV22QC6HbuXSIF4oLHgPbQLnrC5xDGe7DghQwC7xW5fhzlj4Nt00pzd/pub?gid=1026955315&single=true&output=csv)。作者绝对更新时间未明确提供；采集时间不能冒充作者更新时间。

## 当前版本的证据与限制

2026-10-08 **07:32:08.961 UTC** 直接读取开局奇遇原站 HTML，HTTP 200，正文同时声明 Set18 与18.4。此次响应的 UTF-8 内容指纹为：

```text
SHA-256: 7a252e01094e1a239cb0e611e36c23aaa7284859b6515665fb3dca6165fe3927
UTF-8 bytes: 214834
HTTP Date: Thu, 08 Oct 2026 07:32:08 GMT
Last-Modified: Wed, 07 Oct 2026 12:15:13 GMT
ETag: W/"3da98d5122a8621af9f2653a141d4d6b"
```

同次调查 web 阅读工具的既有抓取结果仍显示18.3，标注抓取于前一天；这份缓存不能推翻当次原站 HTML 的18.4声明。HTTP Last-Modified 仅是响应元数据，不当作作者对每张图的修订时间。

代表页面新鲜 HTML 也标为18.4，但一些图片文件名仍含18.1、18.2或18.3：奇遇与男爵素材文件名含18.1，金蛋含18.2，分配系统含18.3；魔女与药剂素材含18.4。文件名可沿用，不能仅凭旧文件名断言资料过期；也不能仅凭页面标题断言旧图片已经更新。建议分别保存页面声明补丁、图片内核验补丁、文件名提示和版本核验状态，保留未解决差异。

强化 CSV 于 **2026-10-08 07:32:09.985 UTC** 只读核验，SHA-256 为 `4aed7386db1a031f1cc115e216a0db99f11c3ce2794b820a34790ed475f5943f`。本次没有将它写入任何知识包。

## 本项目已经接入的部分

已经存在的是 Little Buddy **18.4法杖出现条件**，不是首次引入这个网站：完整原始表372行/140列，本地349项机制目录精确映射343项。已收录费用、回合窗口、模式、特殊出现门槛、互斥强化与提供后冷却，并与 Riot18.4官方修订分别保留来源和冲突。6个当前目录实体未记录，29个来源 ID 在当前目录外；不把全部372行称为当前可获得实体。

原始页面采集2026-10-07 16:24:57.905 UTC，CSV采集16:25:45.277 UTC；本轮调研没有重采集或修改该发布包。现有实现及范围见 [法杖条件说明](WISP_CONDITIONS.md)。法杖效果图鉴另来自 CommunityDragon/Tactics，专家评级来自 MetaTFT，不能统称全部来自 Little Buddy。

当前强化基本说明来自现有静态目录；Little Buddy的强化出现限制、金蛋等图表奖励明细、系统概率和羁绊详细奖励尚未通过本次调研新增入库。开发者模式目前查看的是本地 JSON 字段投影；没有部署 MySQL/Milvus/Redis 或 embedding，不能将现有切片查看器称为向量RAG。

## 对后续接入的建议

先复用已有法杖条件族；新工作优先强化结构化出现规则，再挑选金蛋、混沌奖励、法球和魔女等高价值图片表逐表复核，最后补充系统概率与法杖细则。UI和助手应读取同一份中文规范化事实，规则/奖励/概率分别建字段，版本与来源逐字段绑定；图片只作为证据附件，数字和条件保留结构化权威行。数值问答先按赛季、补丁和确切实体过滤，语义检索只能帮助找资料，不能替代条件匹配或概率分母校验。详细方案见 [中文机制资料与检索接入方案](KNOWLEDGE_INGESTION_PLAN.md)。

[网站条款](https://www.littlebuddybot.com/terms-of-service)说明资料按现状提供、不能保证完全准确，并声明TFT图像及内容属于Riot；页脚保留权利。没有从已读条款中确认整站图表的批量再发布或开放许可。此次仅调研链接与结构，不执行全站镜像、中文图表再发布或自动导入。公开可读取、技术可解析和可再发布许可是不同判断。
