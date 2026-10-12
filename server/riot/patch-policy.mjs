import { readFile } from 'node:fs/promises';
import { sha256, stableJSON } from '../../scripts/stats-cache.mjs';
import { getPool, getActiveRelease } from '../storage/repository.mjs';
import { probeOPGGPatch } from '../../scripts/probe-opgg-patch.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const stamp = value => typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
export function validPatchWindow(window) {
  return window?.platform === 'kr' && Number.isInteger(window.season) && /^\d+\.\d+$/.test(window.patch || '')
    && window.method === 'calendar_and_page_inference' && Number.isFinite(stamp(window.from))
    && stamp(window.from) < stamp(window.to) && stamp(window.to) <= stamp(window.checkedAt)
    && Array.isArray(window.evidenceUrls) && window.evidenceUrls.length >= 2
    && window.evidenceUrls.every(url => { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password
      && ['teamfighttactics.leagueoflegends.com', 'support.riotgames.com', 'op.gg'].includes(u.hostname); } catch { return false; } });
}
export function inferMatchPatch({ platform, season, start, end, rawVersion }, windows = []) {
  // A new, non-placeholder format needs an explicit mapping, not a guessed major version.
  if (rawVersion && !rawVersion.includes('?')) return { patch: null, reason: 'unmapped_source_version' };
  const matching = windows.filter(w => validPatchWindow(w) && w.platform === platform && w.season === season
    && Number.isFinite(start) && Number.isFinite(end) && start < end && start >= stamp(w.from) && end < stamp(w.to));
  if (!matching.length) return { patch: null, reason: 'outside_verified_time_window' };
  if (new Set(matching.map(w => w.patch)).size !== 1) return { patch: null, reason: 'conflicting_patch_windows' };
  const window = matching.sort((a,b) => stamp(b.checkedAt) - stamp(a.checkedAt))[0];
  return { patch: window.patch, attribution: { ...window, policyHash: sha256(window), sourcePatch: null,
    label: '按比赛时间推定主补丁', hotfix: null, gameStartedAt: start, gameEndedAt: end } };
}
export function windowFromProbe(report, season) {
  const { calendar, sourcePage } = report || {};
  if (report?.status !== 'known' || calendar?.status !== 'known' || sourcePage?.status !== 'known'
    || sourcePage.patch !== calendar.mainPatch || !/^\d+\.\d+$/.test(sourcePage.patch || '')
    || Number(sourcePage.patch.split('.')[0]) !== season || !/^\d{4}-\d{2}-\d{2}$/.test(calendar.scheduledDate || '')) return null;
  const start = Date.parse(calendar.scheduledDate + 'T00:00:00Z') + 36 * 3600000;
  if (!Number.isFinite(start) || start >= stamp(report.checkedAt)) return null;
  const window = { platform: 'kr', season, patch: sourcePage.patch, from: new Date(start).toISOString(),
    to: report.checkedAt, checkedAt: report.checkedAt, method: 'calendar_and_page_inference',
    evidenceUrls: report.evidence.filter(e => e.status === 'ok').map(e => e.url), hotfix: null,
    note: '官方计划日期与来源当前主补丁一致；换版日期后36小时至核查时刻为推定窗口，非地区精确生效时间。热修未知，不自动切换项目当前版本。' };
  return validPatchWindow(window) ? window : null;
}
export async function loadRiotPatchWindows(db = null) {
  const seed = JSON.parse(await readFile(new URL('../../data/riot/patch-windows.json', import.meta.url), 'utf8'));
  db ??= await getPool();
  const [rows] = await db.execute('SELECT payload FROM riot_collection_jobs WHERE job_key=?', ['riot:patch-policy:v1']);
  return [...(seed.windows || []), ...(rows[0] ? parse(rows[0].payload).windows || [] : [])].filter(validPatchWindow);
}
export async function refreshRiotPatchWindows({ db = null, probe = probeOPGGPatch } = {}) {
  db ??= await getPool();
  const release = await getActiveRelease(db);
  if (!release) return { status: 'no_release' };
  const report = await probe(), window = windowFromProbe(report, release.season);
  if (!window) return { status: 'review_required', code: 'PATCH_EVIDENCE_UNRESOLVED' };
  const windows = await loadRiotPatchWindows(db);
  // Retain historical windows: an old match must never acquire today's patch label.
  const merged = windows.filter(w => !(w.platform === window.platform && w.patch === window.patch && w.from === window.from));
  merged.push(window);
  await db.execute('INSERT INTO riot_collection_jobs(job_key,payload) VALUES(?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)',
    ['riot:patch-policy:v1', stableJSON({ windows: merged })]);
  return { status: 'updated', patch: window.patch, from: window.from, to: window.to, hotfix: null };
}
