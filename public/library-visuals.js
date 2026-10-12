// Unmodified reviewed source image. CSS viewports show the game icons alongside Chinese labels.
export const LOOT_ATLAS = Object.freeze({ src:'/assets/library/loot-orbs-set18.png', width:1100, height:1512,
  sha256:'445baec81afd5a1bcd3fb0f4a519a859435d3a6fed8419d817647d281b9c407e',
  sourceUrl:'https://www.littlebuddybot.com/tft-loot-orb-contents', imageUpdatedAt:'2026-08-26' });
export const LOOT_ORBS = [
  {id:'gray',name:'灰色法球',prefix:'灰球',hint:'弈子、金币与消耗品',crop:{x:212,y:22,w:38,h:38}},
  {id:'blue',name:'蓝色法球',prefix:'蓝球',hint:'弈子与金币等奖励',crop:{x:760,y:16,w:48,h:48}},
  {id:'gold',name:'金色法球',prefix:'金球',hint:'金币、锻造器与装备',crop:{x:275,y:598,w:60,h:64}},
  {id:'prismatic',name:'棱彩法球',prefix:'棱彩球',hint:'神器、光明装备等奖励',crop:{x:1025,y:596,w:66,h:66}}
];
const REWARD_ICONS = [
  ['小型英雄复制器',{x:80,y:439,w:60,h:60}],['次级英雄复制器',{x:80,y:439,w:60,h:60}],['英雄复制器',{x:969,y:362,w:59,h:60}],
  ['装备拆卸器',{x:140,y:362,w:60,h:60}],['重铸器',{x:140,y:287,w:60,h:60}],
  ['基础装备锻造器',{x:841,y:804,w:55,h:59}],['成装锻造器',{x:80,y:804,w:59,h:59}],
  ['神器锻造器',{x:777,y:726,w:59,h:59}],['杰作升级',{x:777,y:803,w:59,h:61}],
  ['光明幸运装备宝箱',{x:838,y:952,w:61,h:61}],['光明版幸运装备宝箱',{x:838,y:952,w:61,h:61}]
];
const UNIT_ICONS = {1:{x:80,y:134,w:60,h:60},2:{x:80,y:211,w:59,h:59},3:{x:632,y:134,w:60,h:60},4:{x:969,y:134,w:59,h:60},5:{x:489,y:725,w:60,h:60}};
export function lootRewardTokens(text) {
  const result=[];
  for(const [name,crop] of REWARD_ICONS) for(let start=text.indexOf(name);start>=0;start=text.indexOf(name,start+name.length)) result.push({name,crop,start,end:start+name.length});
  for(const match of text.matchAll(/\d+个([1-5])费弈子/g)) result.push({name:match[0],crop:UNIT_ICONS[match[1]],start:match.index,end:match.index+match[0].length});
  for(const match of text.matchAll(/\d+金币/g)) result.push({name:match[0],crop:{x:357,y:212,w:44,h:40},start:match.index,end:match.index+match[0].length});
  for(const match of text.matchAll(/\d+个(棱彩球|灰球|蓝球|金球)/g))result.push({name:match[0],crop:LOOT_ORBS.find(orb=>orb.prefix===match[1]).crop,start:match.index,end:match.index+match[0].length});
  // Small duplicator includes the regular duplicator's name; retain the longer exact label.
  const chosen=[];
  for(const token of result.sort((a,b)=>(b.end-b.start)-(a.end-a.start))) if(!chosen.some(item=>token.start<item.end&&token.end>item.start))chosen.push(token);
  return chosen.sort((a,b)=>a.start-b.start);
}
export function gameIcon(visual,{el,size=44}={}) {
  const {crop}=visual,scale=Math.min(size/crop.w,size/crop.h);
  return el('span',{class:'library-game-icon','aria-hidden':'true',style:{width:`${size}px`,height:`${size}px`}},
    el('img',{src:LOOT_ATLAS.src,alt:visual.name,loading:'lazy',style:{width:`${LOOT_ATLAS.width*scale}px`,height:`${LOOT_ATLAS.height*scale}px`,left:`${(size-crop.w*scale)/2-crop.x*scale}px`,top:`${(size-crop.h*scale)/2-crop.y*scale}px`}}));
}
