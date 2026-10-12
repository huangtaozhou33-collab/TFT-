export function node(tag, attrs = {}, ...children) {
  const out = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') out.textContent = String(value);
    else if (key === 'class') out.className = value;
    else if (key.startsWith('on')) out.addEventListener(key.slice(2), value);
    else if (['value','checked','selected','disabled'].includes(key)) out[key] = value;
    else out.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) out.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return out;
}
export const action = (label, onclick, extra = {}) => node('button', { type:'button', class:'data-button', onclick, ...extra }, label);
export function icon(entity, className = '') {
  const box = node('span', { class:`data-icon ${className}`, title:entity?.name || '未收录', 'aria-label':entity?.name || '未收录' });
  box.append(node('span', { class:'data-icon-fallback', 'aria-hidden':'true', text:entity?.name?.slice(0,1) || '?' }));
  if (!entity?.icon) return box;
  try {
    const url = new URL(entity?.icon, location.origin);
    if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) box.append(node('img', { src:url.href, alt:'', loading:'lazy', referrerpolicy:'no-referrer', onload:()=>box.querySelector('.data-icon-fallback')?.remove(), onerror:event=>event.target.remove() }));
  } catch {}
  return box;
}
export const numeric = value => Number.isFinite(value) ? value.toLocaleString('zh-CN',{maximumFractionDigits:2}) : '—';
export const percent = value => Number.isFinite(value) ? `${(value*100).toFixed(1)}%` : '—';
export function metrics(stats, compact = false) {
  return node('div',{class:`data-metrics${compact?' compact':''}`}, [['均次',numeric(stats?.avgPlacement)],['前四',percent(stats?.top4Rate)],['登顶',percent(stats?.winRate)],['样本',numeric(stats?.sampleSize)]].map(([label,value])=>node('div',{},node('span',{text:label}),node('strong',{text:value}))));
}
export function sourceLine(evidence = {}) {
  return node('div',{class:'data-source'},node('span',{text:evidence?.source || '来源未提供'}),node('span',{text:`统计版本 ${evidence?.sourcePatch || '未提供'}`}),node('span',{text:evidence?.rank || evidence?.population?.rank || '段位未提供'}));
}
export const empty = message => node('div',{class:'data-empty',text:message});
export function itemIcons(ids, items, onClick) {
  return node('div',{class:'data-item-icons'}, ids.map(id=>onClick ? action(icon(items.get(id)),()=>onClick(id),{class:'data-icon-button','aria-label':`查看${items.get(id)?.name || '装备'}`}) : icon(items.get(id))));
}
export const CATEGORIES = [['component','基础散件'],['core','普通装备'],['radiant','光明装备'],['artifact','奥恩神器'],['emblem','转职']];
