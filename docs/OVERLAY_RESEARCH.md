# TFT Overlay 竞品调研：Academy、MetaTFT、Little Buddy Bot

核查时间：2026-10-08 03:26 Australia/Sydney（2026-10-07 16:26 UTC）。范围是公开网页、发布者公告和开发者文档；未安装产品，未进入真实对局，未开发或修改应用代码。下文“已证实”表示公开一手来源明确陈述，不代表我们已实测其当前客户端行为。

## 关键结论

1. **TFT Academy 有自己的桌面 Overlay。** 当前 Overwolf 商店发布者为 Next Level Tactics LLC，列出的平台是 Electron；官网更新记录为 0.9.22 / 2026-09-28。它的发布者明确说明：应用独立运行、无需另装 Overwolf 客户端，但使用 Overwolf 服务读取并记录游戏事件。把它写成“不使用 Overwolf”会遗漏技术依赖。[官方商店](https://www.overwolf.com/app/next_level_tactics_llc-tftacademy)、[发布者公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/)、[更新记录](https://tftacademy.com/overlay/updates)
2. **MetaTFT 也有自己的 Overlay，当前同时提供 Overwolf 和 Electron 独立版。** 商店的“official”指 MetaTFT.com 自有产品，不能翻译成“Riot 官方”。[官方商店](https://www.overwolf.com/app/metatft.com-metatft)
3. **MetaTFT 回合 Win Chance 是机器学习预测，不是战斗引擎模拟。** 官方 FAQ 描述为真实回合训练的神经网络；不使用站位，且在战斗开始、不能调整棋盘时才展示。它不是阵容最终吃鸡率，也不是把同一场战斗重复跑 N 次得到的模拟胜率。[官方 Win Chance 说明](https://www.metatft.com/win-chance)
4. **Little Buddy Bot 目前可核实的是独立机制参考资料站。** 官网自述个人项目、定期数据挖掘与核验；没有找到其自有 Overlay、桌面安装包或与 TFT Academy 同团队/同公司的一手公告。Academy 与它可以作为不同资料源配合使用，不能据此认定产品从属或正式合作。[LBB 官网](https://www.littlebuddybot.com/)、[Academy 团队介绍](https://tftacademy.com/about/dishsoap)
5. **可读取的事件不等于可在局内展示、推荐。** Riot 当前 TFT 政策允许赛前已存在的静态参考，禁止局内追踪对手棋盘/行动、预测其下一步，以及根据动态局面直接规定玩家应做什么。竞品商店仍宣传“lobby scouting”，不能用这类营销文本证明该功能全部符合现行政策。[Riot TFT 政策](https://developer.riotgames.com/docs/tft)

## 功能矩阵

“未证实”表示本轮一手来源未提供足够证据，并非断言产品没有该功能。“官网有”与“Overlay 内有”分别记录。

| 能力 | TFT Academy 自有 Overlay | MetaTFT 自有 Overlay | Little Buddy Bot |
| --- | --- | --- | --- |
| 游戏上方悬浮窗 | 已证实：固定阵容、商店标记、阶段提示、可移动 HUD。[公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/)、[更新](https://tftacademy.com/overlay/updates) | 已证实：阵容可固定在游戏界面，商店提醒；商店列出两种桌面发行方式。[商店](https://www.overwolf.com/app/metatft.com-metatft) | 未证实自有 Overlay；官网提供网页参考表。[官网](https://www.littlebuddybot.com/) |
| 自己局内棋盘自动追踪 | 有游戏事件采集、对局录制和规划器；公开公告不足以证明完整实时自动棋盘清单和每项追踪字段。[公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/) | 已证实产品说明中的 Live Tracker：更新自己的棋盘，可点击棋子跳转出装统计；现行客户端未实测。[使用说明](https://ghost.metatft.com/how-to-use-the-metatft-app/) | 未证实；资料表不等于自动局面读取。 |
| 对手侦查 | 未找到自动对手棋盘追踪的官方功能说明。Builder 可手动放敌方棋子，不足以证明自动侦查。[Builder](https://tftacademy.com/tools/builder) | 当前商店宣传 lobby scouting / matchup tracking；较早教程描述对手历史习惯、段位、交战间隔。需分清历史玩家画像、交战记录与实时棋盘；政策冲突见下文。[商店](https://www.overwolf.com/app/metatft.com-metatft)、[教程](https://ghost.metatft.com/how-to-use-the-metatft-app/) | 未证实。 |
| 单次战斗胜率估算 | 本轮未找到自有战斗胜率模型、模拟器或算法的一手说明。 | 已证实 Win Chance 神经网络预测；战斗开始时显示；不是站位模拟。[FAQ](https://www.metatft.com/win-chance) | 未证实。 |
| 装备建议 | 已证实专家装备/神器等级、阵容配装、备选配装和选装时对应阵容参考。[发布者公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/) | 已证实装备/持有者/三件套等统计参考；具体数据时效、筛选口径应单独标明。[使用说明](https://ghost.metatft.com/how-to-use-the-metatft-app/) | 有合成和机制表；未证实个人化装备推荐引擎。[官网](https://www.littlebuddybot.com/) |
| 强化推荐 | 已证实 Frodan/Dishsoap 专家评级、阶段评级和关联阵容；不应写成样本胜率。[公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/) | 当前官网为 Spencer 专家榜；商店“live augment stats”与官网说明“停止显示强化统计”不一致，不能把商店措辞当现行统计实证。[强化页](https://www.metatft.com/augments)、[教程](https://ghost.metatft.com/how-to-use-the-metatft-app/) | 强化出现规则、掉落/奖励等机制参考；不等于强化强度统计。[官网](https://www.littlebuddybot.com/) |
| 历史战绩 / 复盘 | 已证实录像、关键事件、Report Cards、笔记及个人历史；更新记录显示继续修复 profile/录像功能。[商店](https://www.overwolf.com/app/next_level_tactics_llc-tftacademy)、[更新](https://tftacademy.com/overlay/updates) | 已证实详细逐回合历史、经济/生命/经验变化和回合棋盘截图。[使用说明](https://ghost.metatft.com/how-to-use-the-metatft-app/) | 未证实玩家战绩/录像。 |
| 赛季特殊玩法 / 条件 | 官网有 Set 18 Wisps；更新记录确认过 Set 17 Gods 阵容建议和事件录像。不能自动推定现在会识别全部 Wisp 条件。[Set 18 页](https://tftacademy.com/learn/new-set)、[更新](https://tftacademy.com/overlay/updates) | 官网有 Set 18 Wisp 专家榜；本轮没有证实 Overlay 内对当前 Wisp 出现条件的完整自动识别。2024 Charm 数据采集不等于2026 Wisp已完整支持。[Wisp 榜](https://www.metatft.com/wisp-tiers)、[2024 发布者文章](https://www.patreon.com/MetaTFT/posts/early-access-109571414) | 官网明确有 Set 18 Wisp offer rules（18.4）、Wisp表和强化/羁绊隐含机制，是其显著差异点。[Wisp 规则](https://www.littlebuddybot.com/tft-wisps) |

## 数据从哪一层来

| 层次 | 可以证实什么 | 不应据此推出什么 |
| --- | --- | --- |
| Riot 公网 REST | 当前目录包含 tft-match-v1、tft-league-v1、tft-summoner-v1、spectator-tft-v5。TFT 文档把 match history 作为历史接口说明；排行榜、身份、赛后阵容等适合此层。[官方接口目录](https://developer.riotgames.com/apis)、[TFT 文档](https://developer.riotgames.com/docs/tft) | 不能把 REST 简化成“完全没有 live接口”，因为有 spectator；也不能由 spectator 存在推出它提供每回合 shop/bench/六角格棋盘事件流。本轮公开材料没有证明该能力。 |
| 本机 Overwolf GEP | 官方 TFT 文档列出 board/bench/store、自己的金币/生命/经验、回合与战斗开始/结束等事件；还有 opponent_board_pieces 与全玩家回合棋盘字段。它是本机游戏事件/状态入口，不是 Riot公网REST。[TFT GEP](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/teamfight-tactics/) | 字段可用不等于允许局内对手追踪；同页还有强化数据禁用警示。不能宣称所有字段对任意新项目都获准。文档样例也不是当前服务可用性实测。 |
| Overwolf Electron | 官方 GEP 文档支持 Electron应用的游戏检测、订阅事件、状态更新；Overlay、事件和Recorder是不同能力。独立安装包可以使用这些包。[Electron GEP 概览](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/Overview/)、[官方样例说明](https://github.com/overwolf/ow-electron-packages-sample/blob/main/README.md) | 不必捆绑完整Overwolf客户端，不代表自己重写了数据采集，也不代表零平台依赖。 |
| 产品自己的数据/服务 | Academy明确使用Overwolf服务；MetaTFT明确局内采集逐回合资料，其历史比Riot接口更详细。MetaTFT 2024 Charm文章明确特定赛季机制数据来自app用户而非Riot API。[Academy 公告](https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/)、[MetaTFT 历史说明](https://ghost.metatft.com/how-to-use-the-metatft-app/)、[Charm 文章](https://www.patreon.com/MetaTFT/posts/early-access-109571414) | 不能将该证据推广成“所有Meta统计只来自app”或“App覆盖全体玩家无偏”。服务端模型、采样权重、传输协议和完整采集架构未公开。 |
| 静态机制资料 | LBB公开表示数据挖掘和人工核验；其Wisp出现规则是知识库，和对局采集/结果预测不同。[LBB 官网](https://www.littlebuddybot.com/) | 知道出现条件不意味着能读取玩家实际满足条件，也不能自动形成胜率榜。 |

**实现层推断，非产品源码实证：** 使用GEP的应用可以把本机事件归一成逐回合状态，再将阵容/装备的已存在资料显示在悬浮窗，并留存复盘。事件采集、窗口展示、静态指南和远端统计模型应是分开的模块；这是公开API能支持的架构推断。未发现足以确认Academy或MetaTFT具体进程通信、后端框架、OCR或全部本地接口路径的公开证据，不给它们编造实现细节。

GEP文档目前含Set 17 Gods字段与Set 18棋子样例，但本轮未找到独立Wisp命名事件。由此只能说“特殊玩法字段需逐赛季核验”，不能判断现有store/item字段一定可读出全部Wisp选择。[TFT GEP](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/teamfight-tactics/)

## 胜率与评级的口径

| 类型 | 计算对象 | 本次产品证据 |
| --- | --- | --- |
| 历史统计 | 已发生样本的平均名次、前四/第一率或回合胜率，受版本、段位、样本和选择偏差影响。 | MetaTFT阵容/装备参考。不能用阵容第一率代替当前双方战斗胜率。 |
| 机器学习战斗预测 | 输入双方当前静态阵容特征，模型输出此对局的胜出概率。 | MetaTFT Win Chance；FAQ明确使用单位/星级、装备、羁绊和强化，不含站位。 |
| 战斗模拟 | 复现攻击、施法、目标选择、站位及随机过程，多次运行统计胜出次数。 | 本轮没有找到这三款产品使用此方式的官方证据。MetaTFT Team Builder也不应因有“对战棋盘”就叫模拟器。 |
| 专家评级 | 作者根据经验给予S/A/B/C/D等攻略等级。 | Academy专家榜、MetaTFT Spencer强化/Wisp榜；不是胜率或统计模型输出。 |

MetaTFT早期FAQ自报验证集胜者准确率75%；2024-08-06的Team Builder文章自报250万次matchups训练、83%验证准确率，仍明确不含站位。**这些是不同时间的作者自报指标，不是我们测试结果，也不是当前Set 18误差保证**；没有公开验证集、概率校准、跨补丁泛化或每种特殊机制覆盖结果。模型可以受历史资料训练，但输出不是简单查某阵容的历史胜率。[FAQ](https://www.metatft.com/win-chance)、[2024模型说明](https://www.patreon.com/MetaTFT/posts/early-access-109571414)

## 现行政策对功能边界的影响

按本次读取的[Riot TFT Developer Policy](https://developer.riotgames.com/docs/tft)作必要归纳：

- 静态赛前指南、装备资料及多种备选决策，可在局内继续查阅；赛后复盘被鼓励。
- 基于当前局面即时调整、直接告诉玩家买谁/如何行动，会落入政策禁止范围。不能把“只读”当许可：只读软件也可能消除原有决策或信息追踪的技能考验。
- 禁止局内（包括加载画面）追踪对手棋子/行动、预测下一步；对手/大厅常玩英雄、羁绊、强化等汇总画像同样被点名禁止。历史文章宣传的scouting不能直接复制为新项目需求。
- 产品只要向玩家提供服务，即使不使用官方API，也需在开发者门户登记。分发平台的合规承诺不能代替具体功能的Riot审查。

强化数据须额外区别：Riot当前TFT文档部分仍以Legends规则及静态强化metadata示例表述；Overwolf当前TFT事件页则对augment data给出禁止展示警示，MetaTFT官网现用专家榜。该文本差异不构成绕开限制的依据；本轮没有把强化“live stats”营销文案认作可采集发布的授权。[Overwolf 强化警示](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/teamfight-tactics/#augments)、[MetaTFT 强化页](https://www.metatft.com/augments)

战斗开始后展示估计值是MetaTFT解释自身设计边界的方式，不是我们查到的Riot对所有战斗概率功能的普遍豁免。采集用于赛后研究与采集用于局内直接行动建议，也应区分。[Win Chance 官方解释](https://www.metatft.com/win-chance)

Vanguard方面，Riot FAQ认为基于API、客户端与in-game API的应用仍应可工作；外部内存读取工具不能继续采用旧方式，且不存在Vanguard白名单。LCU/in-game API也不由DevRel提供兼容保证。这里仅说明数据接入边界，不能由“还能运行”推出功能获准。[Riot Vanguard FAQ，2024-04-01](https://www.riotgames.com/en/DevRel/vanguard-faq)

## 对本项目的调研判断

若未来单独决定做桌面入口，最清晰的第一层价值是把现有、注明版本和来源的静态资料/专家榜放进可固定的参考窗，并保留用户选择与赛后复盘。自动动态指导、对手侦查、预测行动不能仅按竞品文案列入范围。单次战斗预测还需要独立数据采集、模型评估与展示边界，LLM根据描述给一个百分数不能等同MetaTFT这类训练模型。

LBB值得研究的是“隐藏机制与条件表”的资料组织和核验方法；Academy值得研究的是专家阵容、阶段提示、备选方案与复盘交互；MetaTFT值得研究的是统计查询、逐回合记录与有明确定义的模型反馈。三者的资料性质不同，不能把它们统一称作实时AI教练。

## 来源核查记录

以下均于本次核查访问；内容日期与访问日期区分记录。

| 来源 | URL | 页面日期 / 本次状态 |
| --- | --- | --- |
| Academy官网产品页 | https://tftacademy.com/overlay | 可读；产品说明 |
| Academy商店页 | https://www.overwolf.com/app/next_level_tactics_llc-tftacademy | 当前列Electron0.9.22，2026-09-28 |
| Academy官方账户开放测试公告 | https://www.reddit.com/r/CompetitiveTFT/comments/1rpkdpg/tftacademy_overlay_open_beta_is_live/ | 发布者TFT_Academy；页面相对日期约7个月前；不推算绝对日 |
| Academy更新日志 | https://tftacademy.com/overlay/updates | 最新可读0.9.22 / 2026-09-28 |
| Academy Set18 | https://tftacademy.com/learn/new-set | 可读；官网特殊玩法入口 |
| Academy团队说明 | https://tftacademy.com/about/dishsoap | 可读；与Frodan共同运营 |
| MetaTFT商店页 | https://www.overwolf.com/app/metatft.com-metatft | Overwolf0.2.767/Electron0.2.766，2026-10-06 |
| MetaTFT使用说明 | https://ghost.metatft.com/how-to-use-the-metatft-app/ | 标题日期2023-08-11；正文部分已有强化政策更新；功能可能留存历史措辞 |
| MetaTFT Win Chance | https://www.metatft.com/win-chance | 主页面需JS；本轮搜索索引可读官方完整FAQ，未实测客户端 |
| MetaTFT模型/Charm公告 | https://www.patreon.com/MetaTFT/posts/early-access-109571414 | 2024-08-06；发布者MetaTFT；历史赛季说明 |
| MetaTFT Wisp榜 | https://www.metatft.com/wisp-tiers | 本轮文本抓取需JS；专家归属采用本项目2026-10-07真实浏览器核验记录，见MECHANICS_SOURCES.md |
| Little Buddy Bot | https://www.littlebuddybot.com/ | 可读；个人资料站；无Overlay安装入口 |
| LBB Wisp规则 | https://www.littlebuddybot.com/tft-wisps | 标题明确18.4；完整规则来自页面声明的公开CSV，本项目另行核对并录入343个实际ID，详见WISP_CONDITIONS.md；仍不代表完整候选池或已知概率 |
| Riot TFT政策/文档 | https://developer.riotgames.com/docs/tft | 本次现行公开文本；未显示明确最后更新日期 |
| Riot接口目录 | https://developer.riotgames.com/apis | 当前列spectator-tft-v5等；未请求受密钥保护的对局接口 |
| Riot Vanguard FAQ | https://www.riotgames.com/en/DevRel/vanguard-faq | 2024-04-01官方说明 |
| Overwolf TFT GEP | https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/teamfight-tactics/ | 当前公开字段/警示；不等于字段本机实测可用 |
| Overwolf Electron GEP | https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/Overview/ | 当前官方API概览 |
| Overwolf官方Electron样例 | https://github.com/overwolf/ow-electron-packages-sample/blob/main/README.md | 官方仓库公开说明；未下载或运行 |

LBB与Academy关系的结论仅为“未找到官方从属/合作证据”。检索时出现的Set13“Academy trait sponsored item lists”指游戏羁绊，不是TFT Academy产品整合；不能误当合作证据。未登录支持Discord或向开发者发消息，也没有通过用户评论替代一手事实。
