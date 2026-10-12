import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {CHAT_PROVIDERS,providerPreset} from './model-providers.mjs';
import {modelSettings} from './model-settings.mjs';

export const ROOT = resolve(import.meta.dirname, '..');

export function inferenceSettings(get) {
  const integer=(key,fallback,min,max)=>{const raw=get(key);if(!raw)return fallback;const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${key} 必须为 ${min}–${max} 的整数`);return value;};
  const choice=(key,fallback,values)=>{const value=get(key)||fallback;if(!values.includes(value))throw new Error(`${key} 必须为 ${values.join(' / ')}`);return value;};
  return {thinking:choice('AI_THINKING','enabled',['enabled','disabled']),reasoningEffort:choice('AI_REASONING_EFFORT','high',['low','medium','high','max']),thinkingBudget:integer('AI_THINKING_BUDGET',4096,1024,32768),
    maxTokens:integer('AI_MAX_TOKENS',8192,1024,65536),maxToolCalls:integer('AI_MAX_TOOL_CALLS',12,1,32),maxRounds:integer('AI_MAX_ROUNDS',8,2,16),
    requestTimeoutMs:integer('AI_REQUEST_TIMEOUT_MS',120000,10000,300000),turnTimeoutMs:integer('AI_TURN_TIMEOUT_MS',240000,30000,600000)};
}

// Read on every request so filling .env never requires a server restart.
export function localEnvironment() {
  let contents = '';
  try { contents = readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch {}
  const local = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    local[match[1]] = value;
  }
  return local;
}
export function readConfig() {
  const local=localEnvironment();
  const get = key => local[key] || process.env[key] || '';
  const selected=modelSettings().chat,configuredProvider=get('AI_PROVIDER')||'deepseek';
  const provider=selected?.provider||configuredProvider,preset=providerPreset(CHAT_PROVIDERS,provider);
  return {
    provider,key:get(`${provider.toUpperCase()}_API_KEY`)||(provider===configuredProvider?get('AI_API_KEY'):''),
    baseUrl:get(`${provider.toUpperCase()}_BASE_URL`)||(!selected?get('AI_BASE_URL'):'')||preset.baseUrl,
    model:selected?.model||get('AI_MODEL')||preset.model,
    inference: {...inferenceSettings(get),...selected?.inference},
    riotKey: get('RIOT_API_KEY'), riotRegion: get('RIOT_REGION') || 'asia',
    port: Number(get('PORT')) || 3000
  };
}

export function publicConfig() {
  const c = readConfig();
  return { configured: Boolean(c.key), model: c.model, provider:c.provider, inference:c.inference };
}
