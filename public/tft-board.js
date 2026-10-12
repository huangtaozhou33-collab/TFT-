import { computeLineupTraits, computeLineupPopulation } from './lineup-model.js';

const list = value => Array.isArray(value) ? value : [];
const knownNumber = value => typeof value === 'number' && Number.isFinite(value);
const idOf = item => typeof item === 'string' ? item : item?.id || item?.itemId;

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'disabled') node.disabled = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  const add = child => {
    if (Array.isArray(child)) return child.forEach(add);
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(add);
  return node;
}

function imageURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function portrait(entity, className, label = '') {
  const icon = imageURL(entity?.icon);
  if (!icon) return element('span', { class: `${className} tft-icon-fallback`, text: (entity?.name || label || '?').slice(0, 1), 'aria-hidden': 'true' });
  return element('img', { class: className, src: icon, alt: '', loading: 'lazy', decoding: 'async', onerror: event => { event.target.hidden = true; } });
}

function validCell(cell) {
  return cell && Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 1 && cell.x <= 7 && cell.y >= 1 && cell.y <= 4;
}

function cellLabel(cell) { return `第 ${cell.x} 列 · 第 ${cell.y} 排`; }

function maps(catalog) {
  return { champions: new Map(list(catalog?.champions).map(entity => [entity.id, entity])), items: new Map(list(catalog?.items).map(entity => [entity.id, entity])) };
}

function equipment(unit, itemMap, className = 'tft-unit-items') {
  return element('span', { class: className }, list(unit.items).map(value => {
    const item = itemMap.get(idOf(value));
    return element('span', { class: 'tft-item-icon', title: item?.name || '装备资料未收录', 'aria-label': item?.name || '装备资料未收录' }, portrait(item, 'tft-item-image'));
  }));
}

function unitContents(unit, championMap, itemMap) {
  const champion = championMap.get(unit.championId);
  const star = Number.isInteger(unit.star) && unit.star >= 1 && unit.star <= 3 ? unit.star : null;
  return [portrait(champion, 'tft-unit-portrait'), star ? element('span', { class: 'tft-unit-stars', text: '★'.repeat(star), 'aria-hidden': 'true' }) : null, equipment(unit, itemMap)];
}

/**
 * A display-only state component. It never modifies units or corrects coordinates.
 * x grows left to right; y=4 is the top display row and y=1 the bottom row.
 * Click and drag changes are requests to the parent, which validates and commits them.
 */
export function renderTftBoard({ units = [], catalog, compact = false, editable = false, selectedInstanceId = null, onCellClick, onUnitClick, onMove } = {}) {
  const allUnits = list(units); const { champions, items } = maps(catalog);
  const placed = new Map(); const unplaced = [];
  for (const unit of allUnits) {
    if (!validCell(unit.cell)) {
      unplaced.push({ unit, reason: unit.cell == null ? '尚未摆放' : '坐标无效，需核对' });
      continue;
    }
    const key = `${unit.cell.x}:${unit.cell.y}`;
    if (placed.has(key)) unplaced.push({ unit, reason: `位置冲突（${unit.cell.x}, ${unit.cell.y}），需核对` });
    else placed.set(key, unit);
  }
  const selected = allUnits.find(unit => unit.instanceId === selectedInstanceId);
  const root = element('section', { class: `tft-board-wrap${compact ? ' compact' : ''}${editable ? ' editable' : ''}`, 'aria-label': editable ? '可编辑阵容棋盘' : '阵容站位棋盘' });
  const board = element('div', { class: 'tft-board', 'aria-label': '四排七列棋盘，第四排为前排，第一排为后排' });
  const move = (unit, to) => {
    if (editable && unit && typeof onMove === 'function') onMove({ instanceId: unit.instanceId, from: unit.cell ?? null, to });
  };
  const acceptDrop = (event, to) => {
    event.preventDefault();
    const instanceId = event.dataTransfer?.getData('text/plain');
    const unit = allUnits.find(entry => entry.instanceId === instanceId);
    if (unit) move(unit, to);
  };
  for (let y = 4; y >= 1; y -= 1) {
    const row = element('div', { class: `tft-board-row${y % 2 === 0 ? ' shifted' : ''}`, 'data-row': y });
    for (let x = 1; x <= 7; x += 1) {
      const cell = { x, y }; const unit = placed.get(`${x}:${y}`);
      const champion = unit ? champions.get(unit.championId) : null;
      const unitName = champion?.name || '英雄资料未收录';
      const interactive = editable || (unit && typeof onUnitClick === 'function');
      const label = unit ? `${unitName}，${cellLabel(cell)}${Number.isInteger(unit.star) && unit.star >= 1 && unit.star <= 3 ? `，${unit.star} 星` : ''}${list(unit.items).length ? `，装备：${list(unit.items).map(value => items.get(idOf(value))?.name || '未收录装备').join('、')}` : ''}` : `${cellLabel(cell)}，空格`;
      const attributes = {
        class: `tft-board-cell${unit ? ' occupied' : ''}${unit?.instanceId === selectedInstanceId ? ' selected' : ''}${knownNumber(champion?.cost) ? ` cost-${champion.cost}` : ''}`,
        title: label, 'aria-label': label, 'data-x': x, 'data-y': y,
        ...(interactive ? { type: 'button', 'aria-pressed': Boolean(unit && unit.instanceId === selectedInstanceId), onclick: () => {
          if (editable && selected && unit?.instanceId !== selected.instanceId) {
            if (typeof onMove === 'function') move(selected, cell);
            else onCellClick?.(cell, unit || null);
          } else if (unit) onUnitClick?.(unit);
          else onCellClick?.(cell, null);
        } } : { role: 'img' })
      };
      if (editable && typeof onMove === 'function') {
        attributes.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; };
        attributes.ondrop = event => acceptDrop(event, cell);
      }
      if (editable && unit && typeof onMove === 'function') {
        attributes.draggable = 'true';
        attributes.ondragstart = event => { event.dataTransfer?.setData('text/plain', unit.instanceId); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
      }
      row.append(element(interactive ? 'button' : 'div', attributes, element('span', { class: 'tft-cell-surface' }), unit ? unitContents(unit, champions, items) : element('span', { class: 'tft-empty-mark', text: '·', 'aria-hidden': 'true' }), element('span', { class: 'tft-cell-coordinate', text: `${x},${y}`, 'aria-hidden': 'true' })));
    }
    board.append(row);
  }
  root.append(element('div', { class: 'tft-board-direction' }, element('span', { text: '前排 · 第 4 排' }), element('span', { text: '左 → 右  1 — 7' })), board, element('div', { class: 'tft-board-direction bottom' }, element('span', { text: '后排 · 第 1 排' }), editable ? element('span', { text: selected ? `已选择：${champions.get(selected.championId)?.name || '未收录英雄'}` : '选择棋子，再点击格子' }) : null));
  if (editable || unplaced.length) {
    const bench = element('div', { class: 'tft-bench', 'aria-label': '未摆放与待核对棋子' }, element('div', { class: 'tft-bench-heading' }, element('strong', { text: '备战席 / 待核对' }), element('span', { text: `${unplaced.length} 名` }), editable && selected?.cell != null && typeof onMove === 'function' ? element('button', { type: 'button', class: 'tft-bench-action', text: '移至备战席', onclick: () => move(selected, null) }) : null));
    if (editable && typeof onMove === 'function') {
      bench.addEventListener('dragover', event => event.preventDefault());
      bench.addEventListener('drop', event => acceptDrop(event, null));
    }
    const benchUnits = element('div', { class: 'tft-bench-units' });
    for (const { unit, reason } of unplaced) {
      const champion = champions.get(unit.championId); const interactive = editable || typeof onUnitClick === 'function';
      benchUnits.append(element(interactive ? 'button' : 'div', { class: `tft-bench-unit${unit.instanceId === selectedInstanceId ? ' selected' : ''}`, ...(interactive ? { type: 'button', onclick: () => onUnitClick?.(unit), 'aria-pressed': unit.instanceId === selectedInstanceId } : {}), title: `${champion?.name || '未收录英雄'} · ${reason}` }, portrait(champion, 'tft-bench-portrait'), element('span', { class: 'tft-bench-unit-copy' }, element('strong', { text: champion?.name || '未收录英雄' }), element('small', { text: reason })), equipment(unit, items, 'tft-bench-items')));
    }
    bench.append(unplaced.length ? benchUnits : element('p', { class: 'tft-bench-empty', text: '没有待摆放棋子。' })); root.append(bench);
  }
  return root;
}

export function renderLineupSummary({ units = [], catalog } = {}) {
  const allUnits = list(units); let traits = []; let failure = false;
  try { traits = list(computeLineupTraits(allUnits, catalog)); } catch { failure = true; }
  const seen = new Set(); let placedCount = 0;
  for (const unit of allUnits) { if (!validCell(unit.cell)) continue; const key = `${unit.cell.x}:${unit.cell.y}`; if (!seen.has(key)) { seen.add(key); placedCount += 1; } }
  const population = computeLineupPopulation(allUnits, catalog);
  const root = element('section', { class: 'tft-lineup-summary', 'aria-label': '所需基础人口与规划羁绊，含未摆放棋子' }, element('div', { class: 'tft-lineup-population', title: population.note }, element('strong', { text: population.requiredSlots ?? '未知' }), element('span', { text: '所需基础人口' }), element('small', { text: `${allUnits.length} 名棋子 · 已摆 ${placedCount} · 未摆 ${allUnits.length - placedCount}` })));
  const traitList = element('div', { class: 'tft-lineup-traits' });
  for (const trait of traits) {
    const next = knownNumber(trait.nextThreshold) ? `；下一档 ${trait.nextThreshold}` : '';
    const active = trait.active && knownNumber(trait.activeThreshold) ? `；规划满足 ${trait.activeThreshold} 人档` : '；规划未达到激活档位';
    traitList.append(element('span', { class: `tft-trait-chip${trait.active ? ' active' : ''}`, title: `${trait.name}：${trait.count}${active}${next}${trait.description ? `\n${trait.description}` : ''}` }, portrait(trait, 'tft-trait-icon'), element('strong', { text: trait.count }), element('span', { text: trait.name }), knownNumber(trait.nextThreshold) ? element('small', { text: `/ ${trait.nextThreshold}` }) : null));
  }
  root.append(element('div', { class: 'tft-lineup-trait-group' }, element('p', { class: 'tft-lineup-trait-label', text: '规划羁绊（含待摆放）' }), traits.length ? traitList : element('p', { class: 'tft-summary-empty', text: failure ? '羁绊暂无法解析。' : '当前没有可解析的羁绊。' })));
  return root;
}
