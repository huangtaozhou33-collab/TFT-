import { parseReferenceCSV } from '../server/library-data.mjs';
import { AUGMENT_DESCRIPTIONS_ZH } from './library-descriptions.mjs';

const TRAIT_NAMES = {Primal:'野兽之灵',Blossom:'灵魂莲华','Flora Fatalis':'绝命花妖',Coven:'魔女',Fae:'花仙子',Blackthorn:'黑荆棘',Elderwood:'永恒之森',Riftbeast:'峡谷野怪',Sprykin:'约德尔人和朋友',Rival:'宿敌'};
export function translateOfferingCondition(value) {
  if (!value) return '来源未列额外特殊条件；仍受阶段、模式与互斥规则限制。';
  const trait=value.match(/^Requires (.+) to be active\.$/)?.[1];
  if (TRAIT_NAMES[trait]) return `需要激活${TRAIT_NAMES[trait]}羁绊。`;
  const conditions={
    'Requires Inferno at Silver tier or higher.':'需要地狱火羁绊达到白银档或更高。',
    'Requires at least 4 champions without items.':'需要至少4名没有装备的弈子。',
    'Only offered if you do not own Avatar.':'仅在未拥有大元素使拉克丝时提供。',
    'Requires at least 3 champions with Lunar or Solar.':'需要至少3名拥有月蚀骑士或日蚀骑士羁绊的弈子。',
    'Requires either Solar or Lunar to be active.':'需要日蚀骑士或月蚀骑士至少一项激活。',
    'Requires at least 40 Tactician Health.':'需要玩家生命值至少40。',
    'Requires at least 4 units sharing a trait.':'需要至少4名弈子共享同一种羁绊。',
    'Requires at least 1 champion with 7 copies.':'需要至少一种弈子已有7张拷贝。'
  };
  if (!conditions[value]) throw new Error(`未翻译的强化条件：${value}`);
  return conditions[value];
}
export function normalizeAugmentRules(text,catalog) {
  const records=parseReferenceCSV(text), byId=new Map(catalog.augments.map(entity=>[entity.id,entity]));
  for (const header of ['mName','Stage 2','Stage 3','Stage 4','Special Conditions','1 Player']) if(!(header in records[0])) throw new Error(`强化CSV缺少列：${header}`);
  const outsideCatalog=records.filter(row=>!byId.has(row.mName)).map(row=>({id:row.mName,nameOriginal:row.Name}));
  const rules=records.filter(row=>byId.has(row.mName)).map(row=>({
    id:row.mName,name:byId.get(row.mName).name,nameOriginal:row.Name,
    descriptionZh:AUGMENT_DESCRIPTIONS_ZH[row.mName] ?? null,
    tier:{Silver:'白银',Gold:'黄金',Prismatic:'棱彩'}[row.Tier] ?? row.Tier,
    stages:[2,3,4].filter(stage=>Boolean(row[`Stage ${stage}`]?.trim())),
    modes:[['Standard','标准模式'],['Doubles','双人作战'],['Tockers','发条试炼']].filter(([key])=>row[key]?.trim()).map(([,name])=>name),
    onePlayerPerRound:Boolean(row['1 Player']?.trim()),
    onePlayerNote:row['1 Player']?.trim()?'每轮强化选择仅向同大厅1名玩家提供；强化奇遇可能打破此限制。':null,
    conditionsZh:[translateOfferingCondition(row['Special Conditions'])],
    conditionOriginal:row['Special Conditions'] || null,
    exclusions:Array.from({length:25},(_,i)=>row[`MutuallyExclusiveItem${i+1}`]).filter(Boolean).map(id=>({id,name:byId.get(id)?.name ?? null,catalogMapped:byId.has(id)})),
    roundVariantsOriginal:row['Round Variants'] || null,sourcePatch:'18.4'
  }));
  return {rules,coverage:{sourceRows:records.length,matchedRows:rules.length,outsideCatalog,missingIds:catalog.augments.filter(entity=>!rules.some(rule=>rule.id===entity.id)).map(entity=>entity.id)}};
}

// Each explanation is a Chinese paraphrase of a particular CSV field, not an
// inferred orb count. Unknown source text stops publication for review.
const BONUS_NOTES = [
  ['Artifact Anvil becomes an orb only if the unit bench is full.','仅弈子备战席满时，神器锻造器以法球发放。'],
  ['Artifact Anvil becomes an orb if the unit bench is full; Reforger if the item bench is full.','弈子备战席满时神器锻造器成为法球；装备栏满时重铸器成为法球。'],
  ['Immediate: 1 Bow orb. Delayed: 2 after 1,000 attacks.','立即：1个反曲之弓法球。累计1000次攻击后：2个。'],
  ['Immediate: 1 orb containing 2 Gloves. Delayed: 1 Gloves orb after 5 player combats.','立即：1个含2个拳套的法球。5场玩家战斗后：1个拳套法球。'],
  ['Immediate: 1 orb containing 2 Gloves. Delayed: 1 Gloves orb after 3 player combats.','立即：1个含2个拳套的法球。3场玩家战斗后：1个拳套法球。'],
  ['Immediate: 0. Delayed: 1 champion orb per later level-up.','立即0个；之后每次升级发放1个弈子法球。'],
  ['Component is an orb; both champions go to the unit bench or board overflow.','散件以法球发放；两名弈子直接进入备战席，满时溢出至棋盘。'],
  ['Immediate: 0. Delayed: 1 component-anvil orb after the death threshold.','立即0个；达到阵亡门槛后发放1个基础装备锻造器法球。'],
  ['Loose gold.','金币直接掉落。'],
  ['1 champion per orb; current packages contain 3-6 champions.','每名弈子独立1个法球；来源组合含3–6名弈子。'],
  ['1 champion per orb; current packages contain 4-6 champions.','每名弈子独立1个法球；来源组合含4–6名弈子。'],
  ['Immediate: 1 component orb. Delayed: 1 in each of the next 6 rounds.','立即1个散件法球；接下来6回合各1个。'],
  ['Rolls 1-3: 0; rolls 4-8: 1 bundled orb; roll 9: 2 orbs including the later egg hatch.','骰子结果1–3：0个；4–8：1个组合奖励法球；9：2个，含之后的龙蛋孵化。'],
  ['Immediate: 1 champion; later: 1 per level. Each becomes an orb only if the unit bench is full.','立即1名弈子，之后每级1名；仅备战席满时转为法球。'],
  ['Immediate: 0. Delayed: 1 anvil orb at each of levels 5–8.','立即0个；升到5、6、7、8级时各1个锻造器法球。'],
  ['Immediate: 1 Sword orb. Delayed: 2 after 65,000 physical damage.','立即1个暴风大剑法球；造成65000物理伤害后2个。'],
  ['Immediate: 3 champion orbs. Delayed: 3 after 6 rounds.','立即3个弈子法球；6回合后再发3个。'],
  ['10 separate orbs: 1 per current 5-cost.','10个独立法球，每种5费弈子1个。'],
  ['Immediate: 0. Delayed: 1 component orb if you win the next player combat.','立即0个；赢得下一场玩家战斗后1个散件法球。'],
  ['Immediate: 1 component orb. Delayed: 1 per qualifying replacement.','立即1个散件法球；之后每次符合条件的替换再发1个。'],
  ['Immediate: 1 component orb. Delayed: 1 after each of the next 7 wins.','立即1个散件法球；之后7次胜利每次再发1个。'],
  ['Immediate: 0. Delayed cashout: 1 orb per returned reward element.','立即0个；兑现时每种返回的奖励各1个法球。'],
  ['B.F. Sword is in the orb; gold is loose.','暴风大剑在法球中，金币直接掉落。'],
  ['Champion is an orb; Training Dummy goes directly to the board.','弈子以法球发放；训练假人直接出现在棋盘。'],
  ['Immediate: 4 separate orbs: 2 champions and 2 copies of one component.','立即4个独立法球：2名弈子，以及同一种散件的2份拷贝。'],
  ['Reforger becomes an orb only if the item bench is full.','仅装备栏满时，重铸器转为法球。'],
  ['Each Reforger becomes an orb only if the item bench is full.','每个重铸器仅在装备栏满时转为法球。'],
  ['Placeable plants; not loot orbs.','可摆放植物，按来源不计战利品法球。'],
  ['Immediate: 1 champion orb. Delayed: 1 bundled cashout orb.','立即1个弈子法球；之后兑现为1个组合奖励法球。'],
  ['Immediate: 1 Belt orb. Delayed: 2 after taking 75,000 damage.','立即1个巨人腰带法球；承受75000伤害后2个。'],
  ['Immediate: 1 Emblem orb. Delayed: 1 at each later stage start.','立即1个纹章法球；之后每阶段开始再发1个。'],
  ['Immediate: 1 Tear orb. Delayed: 2 after spending 6,500 Mana.','立即1个女神之泪法球；消耗6500法力后2个。'],
  ['Immediate: 1 Artifact orb. Delayed cashout: 4 separate orbs.','立即1个神器法球；之后兑现发放4个独立法球。'],
  ['Immediate: 0 orbs; Health is lost now. Delayed: 3 champion orbs after 5 player combats; gold is loose.','立即0个，先扣生命值；5场玩家战斗后3个弈子法球，金币直接掉落。'],
  ['Immediate: Emblem becomes an orb if the item bench is full; champion if the unit bench is full. Later: 1 champion per stage, orb only if the unit bench is full.','立即奖励：装备栏满时纹章转为法球，备战席满时弈子转为法球。之后每阶段1名弈子，同样仅备战席满时转为法球。'],
  ['Immediate: 0 orbs; gold is loose. Delayed: 1 Infinity Force orb on Stage 3-7.','立即0个，金币直接掉落；3-7发放1个三相之力法球。'],
  ["4 component-copy orbs: 1 per component. Veigar and Rek'Sai go to the unit bench.",'4个散件复制法球，每件散件1个；维迦和雷克塞进入备战席。'],
  ['Immediate: 0. Delayed: 1 Artifact Anvil orb.','立即0个；之后1个神器锻造器法球。'],
  ['Copy goes to the bench and overflows to the board.','复制弈子进入备战席，满时溢出至棋盘。'],
  ['Immediate: 1 Artifact Anvil orb. Delayed: 1 every 10 player combats.','立即1个神器锻造器法球；之后每10场玩家战斗再发1个。'],
  ['Loose gold coins; not eligible.','金币直接掉落，按来源不触发意外之礼。'],
  ['Each champion becomes an orb only if the unit bench is full.','每名弈子仅在备战席满时转为法球。'],
  ['Immediate: 2 Gloves orbs. Delayed: 1 after 4 player combats.','立即2个拳套法球；4场玩家战斗后1个。'],
  ['Immediate: 2 orbs. Delayed: 2 at each of the next 2 stage starts.','立即2个法球；接下来2个阶段开始时各2个。'],
  ['Hugeify: 0; every other branch: 1 bundled orb, including the egg hatch.','巨化分支0个；其他各分支1个组合奖励法球，包含龙蛋孵化。'],
  ['Spear of Shojin is an orb; Lux goes to the unit bench and the trait choice is an armory.','朔极之矛以法球发放；拉克丝进入备战席，羁绊形态通过武器库选择。'],
  ['Immediate: 0. Delayed: 1 Duplicator orb at level 9.','立即0个；9级时1个英雄复制器法球。'],
  ['14 separate orbs: 1 per current 1-cost.','14个独立法球，每种1费弈子1个。'],
  ['1 Artifact Anvil orb. The Component Anvil is added directly to the freed unit-bench slot; final gold is loose.','1个神器锻造器法球；基础装备锻造器直接放入释放出的备战席位置，最终金币直接掉落。'],
  ['Immediate: 0. Delayed: 1 orb per completed craft.','立即0个；每次完成合成发放1个法球。'],
  ['Immediate: 0. Delayed: 1 champion orb per qualifying round, plus 1 Gloves orb at the threshold.','立即0个；每个符合条件的回合1个弈子法球，达到门槛另发1个拳套法球。'],
  ['Immediate: 0. Delayed: 1 component orb at each of 4 thresholds.','立即0个；4个门槛各发1个散件法球。'],
  ['Copied champion becomes an orb only if the unit bench is full.','复制弈子仅在备战席满时转为法球。'],
  ['Remover is an orb; Radiant item is chosen from an armory.','装备拆卸器以法球发放；光明装备通过武器库选择。'],
  ['Each copied component becomes an orb only if it cannot be placed on the board.','每件复制散件仅在无法放到棋盘时转为法球。'],
  ['Item is granted directly.','装备直接发放。'],
  ['Evolution is an armory; gold is loose.','进化选项通过武器库选择，金币直接掉落。'],
  ['Immediate: 1 completed-item orb. Delayed: 1 component after 8 player combats.','立即1个成装法球；8场玩家战斗后1个散件。'],
  ['Immediate: 1 completed-item orb. Delayed: 1 component after 4 player combats.','立即1个成装法球；4场玩家战斗后1个散件。'],
  ["Immediate: 1 Mogul's Mail orb. Delayed: 1 Gambler's Blade orb after 7 player combats.",'立即1个大亨之铠法球；7场玩家战斗后1个投机者之刃法球。'],
  ['Rerolls/Hugeify: 0; other outcomes: 1 bundled orb.','刷新/巨化分支0个；其他结果1个组合奖励法球。'],
  ['Immediate: 0. Delayed: 2 component orbs after 5 combats.','立即0个；5场战斗后2个散件法球。'],
  ['BFF is placed directly on the board.','毛茸茸大朋友直接出现在棋盘。'],
  ["Immediate: 1 Emblem orb. Delayed: 1 Tactician's Cape after 3 rounds.",'立即1个纹章法球；3回合后1个金锅铲冠冕。'],
  ['Immediate: 1 Lesser Duplicator orb. Delayed: 1 after 5 player combats.','立即1个次级英雄复制器法球；5场玩家战斗后再发1个。'],
  ['Collectible, but all three mushrooms carry BonusGift.IgnoreLoot.','蘑菇可以拾取，但3个蘑菇都被来源标记为不触发意外之礼。'],
  ['Delayed: 1 bundled hatch orb. The egg itself adds 1 only if the unit bench is full.','孵化时1个组合奖励法球；龙蛋本体仅备战席满时另计1个。'],
  ['Immediate: 0. Delayed: 1 per breakpoint; later breakpoints repeat the level-14 reward.','立即0个；每次奖励档位1个法球，超过14种后重复14种羁绊奖励。'],
  ['Immediate: 0 orbs; champion goes to the unit bench. Delayed: 1 bundled cashout orb.','立即0个，弈子进入备战席；之后兑现为1个组合奖励法球。'],
  ['Immediate: 2 Duplicator orbs. Later champion becomes an orb only if the unit bench is full.','立即2个英雄复制器法球；之后的弈子仅备战席满时转为法球。'],
  ['Immediate: 1 component orb. Delayed: up to 3 completion orbs.','立即1个散件法球；之后最多3个完成奖励法球。']
];
export function buildBonusGiftDocument(text,catalog,mechanics) {
  const records=parseReferenceCSV(text), translations=new Map(BONUS_NOTES);
  const entities=new Map([...['champions','items','traits','augments'].flatMap(type=>catalog[type].map(entity=>[entity.id,{...entity,type}])),...mechanics.map(entry=>[entry.id,{...entry,type:'wisps'}])]);
  const category={'Orb':'法球','Non-Orb':'直接发放','Conditional':'满足条件时成为法球','Mixed':'混合发放'};
  const types={Wisp:'法杖',Augment:'海克斯',Trait:'羁绊',Encounter:'奇遇'};
  const accepted=records.filter(row=>entities.has(row.mName)), excluded=records.filter(row=>!entities.has(row.mName));
  const rows=accepted.map(row=>{
    if(row['Loot Description'] && !translations.has(row['Loot Description'])) throw new Error(`额外礼物说明需翻译：${row['Loot Description']}`);
    const entity=entities.get(row.mName),variant=entity.type==='wisps'?({base:'基础',upgraded:'升级',prismatic:'棱彩'})[entity.upgrade?.variant]:null;
    const originalCount=row['Number of Orbs'] || '',countTranslations={Varies:'随触发次数变化','1 normally; 2 on overflow':'通常1个；溢出时2个'};
    if(/[a-z]{3,}/i.test(originalCount)&&!Object.hasOwn(countTranslations,originalCount))throw new Error(`法球数量需翻译：${originalCount}`);
    const count=countTranslations[originalCount] ?? (originalCount.includes('\uFFFD')?'来源数量字段待核验':originalCount || '未列');
    return {cells:[variant?`${entity.name} · ${variant}`:entity.name,types[row.Type] ?? '其他',category[row['Loot Category']] ?? '来源未列',count,translations.get(row['Loot Description']) || '来源未列额外说明'],entity:{type:entity.type,id:row.mName}};
  });
  return {id:'bonus-gift',slug:'tft-bonus-gift',title:'意外之礼 · 哪些奖励以法球发放',category:'augment',summary:'按奖励来源查法球数量、直接发放与备战席满时的特殊交互。',aliases:['Bonus Gift','Bonus Gift+','额外礼物'],entities:[{type:'augments',id:'DA_BonusGift'},{type:'augments',id:'DA_BonusGiftPlus'}],
    rules:['意外之礼涉及“拾取法球”条件，金币、武器库选择或直接进入棋盘的奖励需要分别判断。','即时与延迟奖励分别列出；多个奖励装在同一法球时不按物品数量计算法球个数。','本专题来源标记18.3，保留为参考；未核验18.4是否沿用。'],
    tables:[{title:'奖励来源与法球计数',columns:['来源名称','类型','发放方式','法球数量','触发说明'],rows}],
    sourceImages:[],sourcePatch:'18.3',imageUpdatedAt:null,applicability:'reference_only',retrievalEligible:false,
    coverage:{sourceRows:records.length,matchedRows:accepted.length,excludedRows:excluded.length, note:'仅展示可映射到当前中文目录的实体；其余来源未借用相似名称。'}};
}
