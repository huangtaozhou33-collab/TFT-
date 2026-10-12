# PC 原生阵容码核验

核验日期：2026-10-08。当前目录：Set18 / TFTSet18，资产16.20，规则 set18-assets16.20-recipes18.4-v4。

[Riot 13.7 官方说明](https://teamfighttactics.leagueoflegends.com/en-sg/news/game-updates/teamfight-tactics-patch-13-7-notes-2025/)确认可在游戏中粘贴阵容码。它没有提供装备或棋盘坐标编码规范。

[作者的格式实现](https://github.com/ttkienn/TFT-Team-Planner-Code/blob/main/TFT.js)及[最初的格式说明](https://gist.github.com/bangingheads/243e396f78be1a4d49dc0577abf57a0b)提供以下依据：01使用每槽2个十六进制字符，02使用3个字符；零值为空槽；末尾为mutator。01按完整mutator来源池的character_id排序，以1开始编号，不能先删掉未映射实体再编号。02使用来源中的team_planner_code。README把字符块写作byte，本文按实际代码处理。实现为独立原生ESM，没有复制或安装整库。

本次实际下载的[固定资产映射](https://raw.communitydragon.org/16.20/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json)采集于2026-10-08T06:45:28.855Z。TFTSet18有65行，全部character_id精确对应当前目录。当前目录另外9个拉克丝形态未在PC映射中出现，编码明确拒绝，未构造别名或编号。版本包保存上下文、实体指纹、映射哈希与原采集时间；运行时只读本地包。

已从本地OP.GG统计记录逐一核验10套真实阵容码：全部为02格式、10个槽位；非零编号还原的英雄名单与各自units完全一致。首套为023ed4283fc40440b4153fb430000000TFTSet18，共8个棋子。解码得到阿木木、森林石像、远古巨龙、艾翁、凯南、茂凯、德莱文、塔里克。独立fixture包含此已知向量，并验证双向编码。

原生码只保存棋子和赛季标识。装备、坐标和星级并不在这些字符块中；解码结果的items为空、cell为null，star=1仅为编辑器默认值。若码精确命中当前有效OP.GG记录且棋子多重集合一致，额外返回sourceLayout；它保留独立证据，不修改码内字段。坐标保留源x=1..7/y=1..4。缺失或非法坐标/星级仍为null。

2026-10-08只读核查[OP.GG官方阵容编辑器](https://op.gg/tft/tools/team-builder)的公开声明组件：[坐标转换组件](https://c-tft-web.op.gg/_next/static/chunks/5923-875d594a93cc412d.js)模块73782将源坐标转换为零基矩阵行列，公式为row=4-y、col=x-1；反向转换为y=4-row、x=col+1。[棋盘显示组件](https://c-tft-web.op.gg/_next/static/chunks/7695-1df72a0b3b5e5636.js)模块12406导入该组件，使用普通flex-col按矩阵行的顺序显示，没有反转。因此y=4在最上方前排，y=1在最下方后排，x=1在最左侧、x=7在最右侧；偶数显示行向右错开。sourceLayout.coordinateSystem.frontRowY为4，verification保留页面、映射组件链接与公式。首套来源中茂凯(6,4)和艾翁(1,1)按此分别显示在前排和后排；这项方向核验只适用于额外OP.GG来源布局，仍不把坐标当成原生码内字段。

两份已检查来源（PC映射和当前cdragon.setData.champions）均未提供teamSize、populationCost或mOccupiesTeamSlot等人口占用字段。英雄tier/cost是费用，traits.amount是羁绊计数，不用来推算人口。V2规划器另读取当前静态目录的精确 `DA_18_ApexPredator` 羁绊描述：“远古巨龙占用2个弈子栏位，并提供+2峡谷野怪羁绊”，因此对这名特殊棋子按两栏计算，普通棋子按一栏，显示“所需基础人口”。这属于名单规则计算，含待摆放棋子，未计皇冠、强化、羁绊的额外容量；不把它标为OP.GG观测玩家等级。特殊规则缺失时保持未知。

尚未通过真实PC游戏客户端进行粘贴验收，不能宣称已验证客户端接受所有01/02变体。此实现限制当前标准mutator、10槽和已验证编号；未知编号、其他格式、错误赛季和超容量输入会报错，避免静默丢失棋子。移动端专用格式不在本次范围。
