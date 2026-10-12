// Shared request contract; single ranks are exact tiers, not "and above".
export const RANK_TIERS = [['IRON','黑铁'],['BRONZE','青铜'],['SILVER','白银'],['GOLD','黄金'],['PLATINUM','铂金'],['EMERALD','翡翠'],['DIAMOND','钻石'],['MASTER','大师'],['GRANDMASTER','宗师'],['CHALLENGER','王者']];
export const RANK_OPTIONS = [['PLATINUM_PLUS','铂金及以上'],['ALL','全部段位'],...RANK_TIERS];
export const DEFAULT_RANK = 'PLATINUM_PLUS';
export const validRank = value => RANK_OPTIONS.some(([id])=>id===value);
export function rankScope(value = DEFAULT_RANK) {
  if (!validRank(value)) throw Object.assign(new Error('请选择有效段位；单个段位只统计该段位。'), {code:'INVALID_STAT_RANK',status:400});
  return (value==='ALL'?RANK_TIERS:value===DEFAULT_RANK?RANK_TIERS.slice(4):RANK_TIERS.filter(([id])=>id===value)).map(([id])=>id).sort();
}
export const rankLabel = value => RANK_OPTIONS.find(([id])=>id===value)?.[1] || '段位未知';
export function scopeRank(ranks) { return RANK_OPTIONS.find(([id])=>rankScope(id).join(',')===[...ranks].sort().join(','))?.[0] || null; }
export function pageRank() {
  const value = new URL(typeof location==='undefined'||!location.href?'http://localhost/':location.href).searchParams.get('rank');
  return validRank(value)?value:DEFAULT_RANK;
}
export function savePageRank(rank) {
  rankScope(rank);
  const url=new URL(location.href);url.searchParams.set('rank',rank);history.replaceState(null,'',url);
}
export function rankPicker(rank,onChange,label='统计段位') {
  const wrapper=document.createElement('label');wrapper.className='data-scope-select';
  const caption=document.createElement('span');caption.textContent='段位';
  const select=document.createElement('select');select.setAttribute('aria-label',label);
  for(const [id,name] of RANK_OPTIONS) { const option=document.createElement('option');option.value=id;option.textContent=name;option.selected=id===rank;select.append(option); }
  select.addEventListener('change',()=>{savePageRank(select.value);onChange(select.value);});
  wrapper.append(caption,select);return wrapper;
}
