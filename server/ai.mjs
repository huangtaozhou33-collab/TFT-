import {buildCompletion,normalizeCompletion} from './model-providers.mjs';
import {readCompletionStream} from './completion-stream.mjs';
import { readConfig, publicConfig } from './env.mjs';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

export class AIError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

let lastCheck = { ready: false, checkedAt: null, reason: '尚未完成真实调用验证' };
let checkedConfig;
export function aiStatus() {
  const current = readConfig();
  if (checkedConfig && (checkedConfig.provider !== current.provider || checkedConfig.key !== current.key || checkedConfig.baseUrl !== current.baseUrl || checkedConfig.model !== current.model || JSON.stringify(checkedConfig.inference)!==JSON.stringify(current.inference))) {
    return { ...publicConfig(), ready: false, checkedAt: null, reason: '配置已变化，请重新测试连接' };
  }
  return { ...publicConfig(), ...lastCheck };
}

function apiUrl(config, path) {
  let url;
  try { url = new URL(config.baseUrl.replace(/\/$/, '') + path); } catch { throw new AIError('INVALID_AI_URL', 'AI_BASE_URL 不是有效网址', 400); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AIError('INVALID_AI_URL', 'AI_BASE_URL 必须使用不含凭据的 HTTPS 地址', 400);
  return url;
}

export async function providerRequest(path, body, { timeoutMs = 65000, config = readConfig() } = {}) {
  if (!config.key) throw new AIError('AI_KEY_MISSING', `请在服务端配置 ${config.provider && config.provider!=='compatible' ? config.provider.toUpperCase()+'_API_KEY' : 'AI_API_KEY'}；百科和装备规划仍然可用。`, 503);
  let response;
  try {
    response = await fetch(apiUrl(config, path), {
      method: body ? 'POST' : 'GET',
      headers: { ...(config.provider==='anthropic'?{'x-api-key':config.key,'anthropic-version':'2023-06-01'}:{Authorization:`Bearer ${config.key}`}), 'Content-Type': 'application/json' },
      redirect:'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof AIError) throw err;
    const cause = err.cause?.code;
    const label = cause === 'ENOTFOUND' ? 'DNS 解析失败' : err.name === 'TimeoutError' ? '请求超时' : cause?.startsWith('CERT') ? 'TLS 证书验证失败' : '网络连接失败';
    throw new AIError('AI_NETWORK_ERROR', `模型服务 ${label}。请检查当前网络和 API 地址。`);
  }
  if (!response.ok) {
    // Never expose provider bodies: they can echo credentials or unrelated account details.
    await response.body?.cancel().catch(() => {});
    const labels = { 400: '请求参数或模型不被支持', 401: 'API 密钥无效', 402: '账户余额不足', 403: 'API 访问被拒绝', 404: 'API 路径或模型不存在', 429: '请求过于频繁，请稍后再试', 500: '服务内部错误', 503: '服务暂时不可用' };
    throw new AIError(`AI_HTTP_${response.status}`, `模型服务 返回 HTTP ${response.status}：${labels[response.status] || '上游调用失败'}`, response.status === 401 ? 503 : 502);
  }
  let data;
  if(body?.stream){try{return await readCompletionStream(response);}catch{throw new AIError('AI_INVALID_STREAM','模型流式响应不完整或格式无效。');}}
  try { data = await response.json(); } catch { throw new AIError('AI_INVALID_RESPONSE', '模型服务 未返回有效 JSON'); }
  return data;
}

export function completionBody(config,messages,tools) {
  return buildCompletion(config,messages,tools);
}

export async function chatCompletion(messages, tools, options={}) {
  const config = readConfig();
  const body = completionBody(config,messages,tools);
  const result = normalizeCompletion(await providerRequest(config.provider==='anthropic'?'/messages':'/chat/completions', body, { config,timeoutMs:options.timeoutMs??config.inference.requestTimeoutMs }),config.provider);
  if(result.choices?.[0]?.finish_reason==='length')throw new AIError('AI_TOKEN_LIMIT','本次思考或回答达到 token 上限，请提高 AI_MAX_TOKENS 或缩小问题范围。');
  const message = result.choices?.[0]?.message;
  if (!message || (!message.content && !message.tool_calls?.length)) throw new AIError('AI_EMPTY_RESPONSE', '模型没有返回有效回答');
  lastCheck = { ready: true, checkedAt: new Date().toISOString(), reason: null, model: config.model };
  checkedConfig = config;
  return { message, usage: result.usage || null };
}

export async function checkAI() {
  const config = readConfig();
  checkedConfig = config;
  try {
    // A successful generation is authoritative; some providers do not list aliases in /models.
    const ids = [config.model];
    const probe={...config,inference:{...config.inference,thinking:'disabled',maxTokens:1024}};
    const result = normalizeCompletion(await providerRequest(config.provider==='anthropic'?'/messages':'/chat/completions', completionBody(probe,[{role:'user',content:'请只回复：连接成功'}]), {config,timeoutMs:45000}),config.provider);
    const reply = result.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new AIError('AI_EMPTY_RESPONSE', '模型连通但未返回文本');
    lastCheck = { ready: true, checkedAt: new Date().toISOString(), reason: null, model: config.model };
    return { ...aiStatus(), reply: reply.trim(), testedModels: ids };
  } catch (error) {
    lastCheck = { ready: false, checkedAt: new Date().toISOString(), reason: error.message, code: error.code || 'AI_ERROR' };
    return aiStatus();
  }
}
