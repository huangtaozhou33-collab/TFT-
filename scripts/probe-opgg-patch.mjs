import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPGG_PATCH_URL = 'https://op.gg/zh-cn/tft/meta-trends/comps';
export const RIOT_SCHEDULE_URL = 'https://support.riotgames.com/en-us/tft/events/patch-schedule-teamfight-tactics/';
const ALLOWED_URLS = new Set([OPGG_PATCH_URL, RIOT_SCHEDULE_URL]);
const MAX_PAGE_BYTES = 5_000_000;
const PATCH_PATTERN = /^\d{1,2}\.\d{1,2}[A-Z]?$/i;

function textContent(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&colon;|&#58;|&#x3A;/gi, ':')
    .replace(/\s+/g, ' ').trim();
}

function attr(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function visibleMarkup(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
}

// Read the selected control and its displayed label, never the largest option,
// URL parameter, or a version embedded in unrelated hydration data.
export function parseOPGGPatch(html) {
  const markup = visibleMarkup(String(html));
  const signals = [];
  let invalidSignal = false;
  for (const select of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select\s*>/gi)) {
    if (![attr(select[1], 'id'), attr(select[1], 'name')].some(value => value?.toLowerCase() === 'version')) continue;
    for (const option of select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
      if (!/(?:^|\s)selected(?=\s|=|$)/i.test(option[1])) continue;
      const value = (attr(option[1], 'value') ?? textContent(option[2])).trim();
      if (PATCH_PATTERN.test(value)) signals.push({ kind: 'selected_option', patch: value.toUpperCase() });
      else invalidSignal = true;
    }
  }
  for (const label of markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi)) {
    if (attr(label[1], 'for')?.toLowerCase() !== 'version') continue;
    const labelText = textContent(label[2]);
    const values = [...labelText.matchAll(/(?:版本|Version)\s*[:：]\s*(\d{1,2}\.\d{1,2}[A-Z]?)(?![\w.])/gi)];
    for (const match of values) signals.push({ kind: 'version_label', patch: match[1].toUpperCase() });
    if (!values.length) invalidSignal = true;
  }
  const candidates = [...new Set(signals.map(signal => signal.patch))];
  const status = !invalidSignal && candidates.length === 1 ? 'known' : 'unknown';
  return { status, patch: status === 'known' ? candidates[0] : null, candidates, signals,
    reason: status === 'known' ? null : invalidSignal || candidates.length > 1 ? 'ambiguous_version_control' : 'version_control_missing' };
}

const MONTHS = new Map('January February March April May June July August September October November December'.split(' ').map((name, index) => [name.toLowerCase(), index + 1]));

function pacificDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseRiotSchedule(html, now = new Date()) {
  if (!Number.isFinite(new Date(now).getTime())) throw new Error('Invalid checkedAt date.');
  const markup = visibleMarkup(String(html));
  const entries = [];
  for (const table of markup.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    if (!/Scheduled Date\s*\(Pacific Time\)/i.test(textContent(table[1]))) continue;
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(cell => textContent(cell[1]));
      if (cells.length !== 2) continue;
      const patch = cells[0].match(/^TFT\s+(\d{1,2}\.\d{1,2}[A-Z]?)$/i)?.[1]?.toUpperCase();
      const date = cells[1].match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+\([^)]*\))?$/);
      const month = date && MONTHS.get(date[1].toLowerCase());
      if (!patch || !date || !month) continue;
      const scheduledDate = `${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`;
      const parsedDate = new Date(`${scheduledDate}T00:00:00Z`);
      if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== scheduledDate) continue;
      entries.push({ patch, scheduledDate });
    }
  }
  const today = pacificDate(new Date(now));
  const past = entries.filter(entry => entry.scheduledDate <= today).sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
  const latest = past.filter(entry => entry.scheduledDate === past[0]?.scheduledDate);
  const candidates = [...new Set(latest.map(entry => entry.patch))];
  const known = candidates.length === 1;
  return { status: known ? 'known' : 'unknown', scheduledPatch: known ? candidates[0] : null,
    mainPatch: known ? candidates[0].replace(/[A-Z]$/, '') : null,
    scheduledDate: known ? latest[0].scheduledDate : null, dateInPacificTime: today,
    timezone: 'America/Los_Angeles', transitionDay: known && latest[0].scheduledDate === today,
    effectiveAt: null, reason: known ? null : candidates.length > 1 ? 'ambiguous_schedule' : 'no_elapsed_schedule_entry',
    note: '计划日期只作交叉核对，不证明各地区或统计源已切换，也不证明 B 补丁已生效。' };
}

export async function fetchPatchPage(url, { fetchImpl = fetch } = {}) {
  if (!ALLOWED_URLS.has(url)) throw new Error('Only the fixed public patch evidence URLs are allowed.');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { Accept: 'text/html' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.url && response.url !== url) throw new Error('Unexpected response URL.');
  if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected an HTML page.');
  if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) throw new Error('Page size limit exceeded.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body.');
  const buffers = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new Error('Page size limit exceeded.');
      buffers.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(buffers);
  return { html: bytes.toString('utf8'), pageHash: createHash('sha256').update(bytes).digest('hex') };
}

export async function probeOPGGPatch({ fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = new Date(now).toISOString();
  const urls = [OPGG_PATCH_URL, RIOT_SCHEDULE_URL];
  const pages = await Promise.allSettled(urls.map(url => fetchPatchPage(url, { fetchImpl })));
  const evidence = pages.map((page, index) => ({ url: urls[index], checkedAt,
    status: page.status === 'fulfilled' ? 'ok' : 'unavailable',
    pageHash: page.status === 'fulfilled' ? page.value.pageHash : null,
    ...(page.status === 'rejected' ? { error: page.reason?.message ?? 'Page request failed.' } : {}) }));
  const sourcePage = pages[0].status === 'fulfilled' ? parseOPGGPatch(pages[0].value.html) : { status: 'unknown', patch: null, reason: 'source_page_unavailable' };
  const calendar = pages[1].status === 'fulfilled' ? parseRiotSchedule(pages[1].value.html, new Date(now)) : { status: 'unknown', scheduledPatch: null, reason: 'schedule_unavailable' };
  const warnings = [];
  if (sourcePage.patch && calendar.mainPatch && sourcePage.patch.replace(/[A-Z]$/, '') !== calendar.mainPatch) warnings.push('source_page_differs_from_planned_calendar');
  if (calendar.transitionDay) warnings.push('scheduled_transition_day');
  return { schemaVersion: 1, readOnly: true, status: sourcePage.status, source: 'OP.GG', checkedAt,
    sourcePatch: null, assignedPatch: sourcePage.patch, method: sourcePage.patch ? 'source_page' : null,
    pageHash: evidence[0].pageHash, evidence, sourcePage, calendar, warnings,
    note: '仅探测当前默认页面版本；不是统计 API 自报版本，不修改数据库或当前补丁，不能重贴旧快照版本。' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) {
    console.error('Usage: node scripts/probe-opgg-patch.mjs (read-only; no arguments)');
    process.exitCode = 2;
  } else {
    try {
      const report = await probeOPGGPatch();
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'known') process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
