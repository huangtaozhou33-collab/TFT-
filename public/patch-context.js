import { node as n } from './data-ui.js';

// Source-declared and calendar-assigned patches remain separate evidence.
export function patchContext(evidence = {}) {
  if (evidence?.patchAttribution?.method === 'explicit_request_and_source_metadata' && evidence.requestedPatch) {
    return { patch: evidence.requestedPatch, inferred: false, requested: true, label: `${evidence.requestedPatch} · 查询范围`,
      note: `请求明确指定此补丁；来源当前补丁元数据为 ${evidence.sourceCurrentPatch || '未知'}。统计响应本身未回显补丁，不等于逐行提供了补丁标记。` };
  }
  const sourcePatch = evidence?.sourcePatch || evidence?.gamePatch || null;
  const assignedPatch = evidence?.assignedPatch || (evidence?.patchAssignment ? evidence?.effectivePatch : null);
  const patch = sourcePatch || assignedPatch || null;
  const inferred = !sourcePatch && Boolean(assignedPatch);
  return { patch, inferred, label: patch ? `${patch}${inferred ? ' · 推定' : ''}` : '未知',
    note: inferred ? (evidence?.patchAssignment?.note || '来源未提供统计补丁，按采集时间对应的补丁推定。') : '' };
}

export function patchDetails(evidence) {
  const context = patchContext(evidence);
  if (!context.inferred && !context.requested) return null;
  const checkedAt = evidence?.patchAssignment?.checkedAt;
  const checkedDate = checkedAt ? new Date(checkedAt) : null;
  const urls = (Array.isArray(evidence?.patchAssignment?.evidenceUrls) ? evidence.patchAssignment.evidenceUrls : []).slice(0, 5).flatMap(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? [url.href] : []; } catch { return []; }
  });
  return n('details', { class: 'data-patch-note' }, n('summary', { text: '版本依据' }), n('p', { text: context.note }),
    checkedDate && Number.isFinite(checkedDate.getTime()) ? n('p', { text: `核对时间 ${checkedDate.toLocaleString('zh-CN')}` }) : null,
    urls.map((href, index) => n('a', { href, target: '_blank', rel: 'noopener noreferrer', text: `版本依据 ${index + 1} ` })));
}

export function sourceLine(evidence = {}) {
  return n('div', { class: 'data-source' }, n('span', { text: evidence?.source || '来源未提供' }),
    n('span', { text: `统计版本 ${patchContext(evidence).label}` }),
    n('span', { text: evidence?.rank || evidence?.population?.rank || '段位未提供' }), patchDetails(evidence));
}
