import { randomUUID } from 'node:crypto';

const traces = new Map();
export const developerTraceRetention = Object.freeze({
  storage: 'process_memory', maxTraces: 50, ttlMs: 3600000, maxTraceChars: 400000,
  maxTools: 16, maxContextSegments: 20, maxSegmentChars: 48000,
  note: '仅本机进程内最近50条，1小时后或重启后移除；不是持久日志或Redis。',
});
const secretKey = /api[_-]?key|authorization|password|secret|token|cookie|system[_-]?prompt|messages|history|providerRaw/i;

function redactText(value, limit = 48000) {
  return String(value).replace(/\bsk[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^"'\s,;&}\\]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, limit);
}

export function sanitizeDeveloperData(value, depth = 0) {
  if (depth > 12) return '[深度上限：已省略]';
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value) && value.length <= 48000) {
      try { return JSON.stringify(sanitizeDeveloperData(JSON.parse(value), depth + 1)); } catch { /* Plain source text. */ }
    }
    return redactText(value);
  }
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 128).map(entry => sanitizeDeveloperData(entry, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 128).filter(([key]) => !secretKey.test(key)
    && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, entry]) =>
    [key, key === 'error' ? '工具未完成；原始错误已省略。' : sanitizeDeveloperData(entry, depth + 1)]));
}

function expire() {
  const now = Date.now();
  for (const [id, trace] of traces) if (Date.parse(trace.expiresAt) <= now) traces.delete(id);
  while (traces.size > developerTraceRetention.maxTraces) traces.delete(traces.keys().next().value);
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function withTrace(id, update) {
  expire(); const trace = traces.get(id); if (!trace) return null;
  update(trace); bound(trace); return trace;
}
function bound(trace) {
  if (JSON.stringify(trace).length <= developerTraceRetention.maxTraceChars) return;
  trace.storageTruncated = true;
  for (const tool of trace.tools) tool.result = { status: tool.result?.status ?? null, omitted: true, contextSegmentId: tool.contextSegmentId };
  while (JSON.stringify(trace).length > developerTraceRetention.maxTraceChars) {
    const longest = [...trace.modelContext].sort((a, b) => b.content.length - a.content.length)[0];
    if (longest?.content.length > 512) {
      longest.content = longest.content.slice(0, Math.max(512, Math.floor(longest.content.length / 2)));
      longest.truncated = true;
    } else if (trace.statRows.length) trace.statRows.pop();
    else break;
  }
  if (JSON.stringify(trace).length > developerTraceRetention.maxTraceChars) {
    const small = (value, depth = 0) => depth > 4 ? '[已省略]' : typeof value === 'string' ? value.slice(0, 512)
      : Array.isArray(value) ? value.slice(0, 16).map(entry => small(entry, depth + 1))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, entry]) => [key, small(entry, depth + 1)])) : value;
    trace.versionFilters = small(trace.versionFilters);
    trace.tools = trace.tools.map(tool => ({ ...small(tool), args: { omitted: true, note: '记录容量上限' },
      result: { omitted: true, contextSegmentId: tool.contextSegmentId } }));
    trace.cache.reads = small(trace.cache.reads);
    trace.citations.retrieved = small(trace.citations.retrieved);
    trace.citations.cited = small(trace.citations.cited);
    trace.omissions = { reason: 'maxTraceChars', note: '超量参数/证据已缩短或省略；不能据此声称完整追溯。' };
    while (JSON.stringify(trace).length > developerTraceRetention.maxTraceChars) {
      if (trace.cache.reads.length) trace.cache.reads.pop();
      else if (trace.citations.retrieved.length) trace.citations.retrieved.pop();
      else if (trace.citations.cited.length) trace.citations.cited.pop();
      else if (trace.tools.length) trace.tools.pop();
      else { trace.versionFilters = { mode: 'current_version_only', omitted: true }; break; }
    }
  }
}
function references(value) {
  return typeof value === 'string' ? [...value.matchAll(/\[(S[1-9]\d*)\]/g)].map(match => match[1]) : [];
}
function numeric(value) {
  return value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim()
    || !Number.isFinite(Number(value)) ? null : Number(value);
}
function sourceList(output) {
  const values = [output?.sourceEvidence, output?.evidence,
    ...(Array.isArray(output?.data) ? output.data : []).map(row => row?.sourceEvidence ?? row?.evidence),
    output?.sourceDeck?.evidence].flat().filter(value => value && typeof value === 'object');
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
}
function sourceTimeAge(fetchedAt) {
  const time = Date.parse(fetchedAt);
  return Number.isFinite(time) && time <= Date.now() ? Math.floor((Date.now() - time) / 1000) : null;
}
function rowFacts(output, toolIndex) {
  const primary = Array.isArray(output?.data) ? output.data : Array.isArray(output?.matched) ? output.matched
    : Array.isArray(output?.entries) ? output.entries : [];
  const values = [...primary, ...(output?.sourceDeck?.stats ? [{ ...output.sourceDeck, traceSourcePath: 'sourceDeck' }] : [])];
  return values.slice(0, 64).filter(value => value && typeof value === 'object').map((row, index) => ({
    traceRowId: `T${toolIndex}:R${index + 1}`, sourceRowId: row.id ?? null, sourcePath: row.traceSourcePath ?? 'data',
    toolIndex, id: row.id ?? row.championId ?? row.traitId ?? null, name: row.name ?? row.championName ?? null,
    kind: row.kind ?? null, championId: row.championId ?? null,
    itemIds: row.itemIds ?? (Array.isArray(row.items) ? row.items.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean) : null),
    stats: row.stats ?? null, citation: row.citation ?? output.citation ?? null,
    sourceEvidence: row.sourceEvidence ?? row.evidence ?? output.sourceEvidence ?? output.evidence ?? null,
    rank: index + 1, metricValue: output.selection?.metric ? numeric(row.stats?.[output.selection.metric]) : null,
    similarityScore: null, rerankScore: null,
  }));
}

export function beginDeveloperTrace({ mode = 'answer', question = '', toolLimit = 4 } = {}) {
  expire();
  const createdAt = new Date().toISOString(), id = `trace_${randomUUID()}`;
  traces.set(id, { id, mode, status: 'running', createdAt,
    expiresAt: new Date(Date.now() + developerTraceRetention.ttlMs).toISOString(), completedAt: null,
    question: redactText(question, 4000), versionFilters: null, tools: [], statRows: [], modelContext: [], modelInputs: [],
    citations: { retrieved: [], cited: [], unresolvedIds: [] },
    budget: { limit: toolLimit, executed: 0, denied: 0, remaining: toolLimit },
    cache: { reads: [], redis: { status: 'not_connected', hit: null }, onlineRefresh: false,
      note: 'delivery来自实际工具；未探测Redis命中。ageSeconds按原始采集时间计算，未知时间为null；数据缓存不由本次读取刷新。' },
    storageTruncated: false,
  });
  expire(); return id;
}

export function setDeveloperTraceContext(id, versionFilters, evidence = []) {
  withTrace(id, trace => { trace.versionFilters = sanitizeDeveloperData(versionFilters); trace.citations.retrieved = sanitizeDeveloperData(evidence); });
}

export function addDeveloperContext(id, { kind, phase, toolName, content }) {
  let segmentId = null;
  withTrace(id, trace => {
    if (trace.modelContext.length >= developerTraceRetention.maxContextSegments) { trace.storageTruncated = true; return; }
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { unavailable: true, note: '非JSON资料未记录。' }; }
    const cleaned = JSON.stringify(sanitizeDeveloperData(parsed));
    segmentId = `C${trace.modelContext.length + 1}`;
    trace.modelContext.push({ id: segmentId, kind, phase, ...(toolName ? { toolName: redactText(toolName, 80) } : {}),
      content: cleaned.slice(0, developerTraceRetention.maxSegmentChars),
      truncated: cleaned.length > developerTraceRetention.maxSegmentChars,
      redacted: cleaned !== content, submittedIn: [] });
  });
  return segmentId;
}

export function recordDeveloperTool(id, { name, args, phase, output, serialized, startedAt, completedAt,
  toolCallId = null, denied = false, evidence = [] }) {
  let segmentId = null;
  withTrace(id, trace => {
    denied ? trace.budget.denied++ : trace.budget.executed++;
    trace.budget.remaining = Math.max(0, trace.budget.limit - trace.budget.executed);
    trace.citations.retrieved = sanitizeDeveloperData(evidence);
    if (trace.tools.length >= developerTraceRetention.maxTools) { trace.storageTruncated = true; return; }
    segmentId = addDeveloperContext(id, { kind: 'tool_result', phase, toolName: name, content: serialized });
    const index = trace.tools.length + 1;
    let submittedOutput; try { submittedOutput = JSON.parse(serialized); } catch { submittedOutput = {}; }
    const selection = submittedOutput?.selection ?? (submittedOutput?.query ? { metric: submittedOutput.query.sort ?? null,
      direction: submittedOutput.query.sortDirection ?? null, minimumSampleSize: submittedOutput.query.minSample ?? null,
      mode: 'cached_aggregate_row_membership', matchedRows: submittedOutput.matchedRecords ?? null } : null);
    const metric=selection?.metric??selection?.sort??null;
    const ranking = { method: metric ? 'source_metric_sort' : selection?.mode ?? 'source_or_catalog_order',
      metric, direction: selection?.direction ?? (metric ? metric==='avgPlacement'?'asc':'desc' : null),
      minimumSampleSize: selection?.minimumSampleSize ?? selection?.minSample ?? null, basis: selection?.basis ?? null,
      similarityScore: null, rerankScore: null, confidenceScore: null,
      note: '排序值是来源指标或目录匹配顺序，不是事实可信度；此工具未提供向量或重排分数。' };
    const retrieval = name === 'search_knowledge' ? submittedOutput?.retrieval : null;
    if (retrieval && ['hybrid', 'lexical', 'unavailable'].includes(retrieval.mode)) {
      Object.assign(ranking, { method: `knowledge_${retrieval.mode}`, retrieval,
        note: retrieval.mode === 'hybrid'
          ? '实际使用关键词与向量混合检索，并优先保留匹配的术语义项；工具未提供逐片段相似度或重排分数，排序不代表事实可信度。'
          : '实际知识检索模式及向量状态见 retrieval；没有提供逐片段相似度或重排分数，排序不代表事实可信度。' });
    }
    trace.tools.push(sanitizeDeveloperData({ index, name, phase, args, toolCallId, startedAt, completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      status: denied ? 'budget_denied' : output?.error ? 'error' : 'ok', result: submittedOutput,
      selection, ranking, contextSegmentId: segmentId }));
    trace.statRows.push(...sanitizeDeveloperData(rowFacts(submittedOutput, index)));
    const sources = sourceList(submittedOutput);
    trace.cache.reads.push(...sanitizeDeveloperData((sources.length ? sources : [null]).map(source => ({
      toolIndex: index, name, status: output?.status ?? null,
      delivery: output?.delivery ?? source?.delivery ?? null, cacheKey: output?.cacheKey ?? source?.cacheKey ?? null,
      fetchedAt: source?.fetchedAt ?? output?.fetchedAt ?? null,
      sourceTime: source?.sourceTime ?? output?.sourceTime ?? null,
      sourcePatch: source?.sourcePatch ?? output?.sourcePatch ?? null,
      ageSeconds: sourceTimeAge(source?.fetchedAt ?? output?.fetchedAt),
    }))));
  });
  return segmentId;
}

export function recordDeveloperSubmission(id, turn, segmentIds) {
  withTrace(id, trace => {
    trace.modelInputs.push({ turn, submittedAt: new Date().toISOString(), segmentIds: segmentIds.filter(Boolean),
      delivery: 'passed_to_completion', providerAccepted: null });
    for (const segment of trace.modelContext) if (segmentIds.includes(segment.id)) segment.submittedIn.push(turn);
  });
}

export function finishDeveloperTrace(id, { status, reply = '', evidence, error, stage = null } = {}) {
  withTrace(id, trace => {
    trace.status = status; trace.completedAt = new Date().toISOString();
    if (evidence) trace.citations.retrieved = sanitizeDeveloperData(evidence);
    const ids = new Set(references(reply));
    trace.citations.cited = trace.citations.retrieved.filter(source => ids.has(source.id));
    trace.citations.unresolvedIds = [...ids].filter(sourceId => !trace.citations.retrieved.some(source => source.id === sourceId));
    // Final text stays in the normal chat response; traces retain only its
    // citation resolution, avoiding model echoes of prompts or old messages.
    if (error) trace.failure = { code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'CHAT_FAILED',
      stage, message: '本轮未完成；原始异常与提供方响应已省略。' };
  });
}

export function listDeveloperTraces({ limit = 20, offset = 0 } = {}) {
  expire();
  limit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  const all = [...traces.values()].reverse();
  return { traces: all.slice(offset, offset + limit).map(trace => ({ id: trace.id, mode: trace.mode,
    status: trace.status, createdAt: trace.createdAt, expiresAt: trace.expiresAt, question: trace.question,
    toolCount: trace.tools.length, rowCount: trace.statRows.length, citedCount: trace.citations.cited.length })),
    total: all.length, offset, limit, retention: developerTraceRetention };
}
export function getDeveloperTrace(id) { expire(); const trace = typeof id === 'string' ? traces.get(id) : null; return trace ? copy(trace) : null; }

export function developerRetrievalPreview(id) {
  const trace = getDeveloperTrace(id); if (!trace) return null;
  const knowledgeTools = trace.tools.filter(tool => tool.name === 'search_knowledge');
  return { mode: 'prefetch_preview', traceId: id, question: trace.question, versionFilters: trace.versionFilters,
    tools: trace.tools, recall: { method: 'actual_tool_prefetch', fragments: trace.modelContext.filter(segment => segment.kind === 'tool_result').map(segment =>
      ({ segmentId: segment.id, toolName: segment.toolName })), rows: trace.statRows,
      entityIds: [...new Set(trace.statRows.map(row => row.id).filter(Boolean))],
      knowledgeEvidenceCount: knowledgeTools.reduce((sum, tool) => sum + (Array.isArray(tool.result?.evidence) ? tool.result.evidence.length : 0), 0),
      knowledgeRetrievals: knowledgeTools.map(tool => ({ toolIndex: tool.index, ...tool.result?.retrieval })),
      note: '实际预取后的工具结果与聚合行；知识检索模式见 knowledgeRetrievals。预览不会提交聊天模型。' },
    ranking: trace.tools.map(tool => ({ toolIndex: tool.index, name: tool.name, ...tool.ranking })),
    reranking: { status: 'not_connected', score: null, note: '未接入独立重排模型；向量检索状态见各工具的 retrieval。排序不代表事实可信度。' },
    modelContext: trace.modelContext, cache: trace.cache, budget: trace.budget };
}
