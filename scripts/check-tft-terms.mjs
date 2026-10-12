// Explicit, small provider audit. Not part of npm test; never logs credentials.
import { providerRequest, chatCompletion } from '../server/ai.mjs';
import { publicConfig, readConfig } from '../server/env.mjs';
import { answerChat } from '../server/chat.mjs';
import { getDeveloperTrace } from '../server/developer-traces.mjs';
import { getCatalog } from '../server/data.mjs';
import { buildExplorerIndex, searchExplorerEntities } from '../public/explorer-search.js';

const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8);
if (!process.argv.includes('--allow-provider') || !['baseline', 'agent', 'grounded'].includes(phase)) {
  console.error('Usage: node scripts/check-tft-terms.mjs --allow-provider --phase=baseline|agent|grounded');
  process.exit(2);
}
const report = { checkedAt: new Date().toISOString(), phase, configuredModel: publicConfig().model,
  scope: 'Small one-shot terminology audit, not access to pretraining data or a general accuracy benchmark.', calls: [], results: [] };
try {
  if (phase === 'baseline') {
    const terms = ['豹女', '小法', '木木', '猪妹', '宝石', '轮子妈', '青龙刀', '羊刀', '法爆', '板甲', '偷偷', 'D牌', '卡50慢D', '大D', '锁血', '抢节奏', '打工仔', '追三', '吃利息', '海克斯'];
    const questions = [
      ...terms.map(term => `云顶之弈语境中“${term}”是什么意思？`),
      '玩家说“给妮蔻”，仅凭这句话能确定是英雄还是复制道具吗？',
      '玩家说“法杖”，没有赛季和上下文，能确定是装备还是赛季玩法吗？',
      '只凭预训练记忆，能否给出当前补丁豹女、木木同时上场且豹女带饮血的三件套胜率与样本量？',
      '云顶里的“星砂回响连锁”是什么意思？不确定请明确说明。'
    ];
    const config = readConfig();
    const response = await providerRequest('/chat/completions', { model: config.model, thinking: { type: 'disabled' }, stream: false,
      max_tokens: 2600, messages: [{ role: 'system', content: '你在接受中文游戏术语测试。无资料库、无浏览器、无工具。只根据已有知识回答，不知道或有歧义就说明，不编造当前赛季数据。返回JSON对象{"answers":[{"id":1,"answer":"最多60字"}]}，保持题目顺序。' },
        { role: 'user', content: questions.map((q, i) => `${i + 1}. ${q}`).join('\n') }] });
    report.calls.push({ model: response.model, usage: response.usage, finishReason: response.choices?.[0]?.finish_reason });
    const content = response.choices?.[0]?.message?.content || '';
    let answers;
    try { answers = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')).answers; } catch { answers = null; }
    report.results = Array.isArray(answers) ? questions.map((question, i) => ({ id: i + 1, question, answer: answers.find(a => a.id === i + 1)?.answer ?? null })) : [{ parseFailed: true, content }];
  } else if (phase === 'grounded') {
    const catalog = await getCatalog(), index = buildExplorerIndex(catalog);
    const aliases = ['豹女', '木木', '板甲', '反甲', '饮血'];
    const facts = aliases.map(alias => ({ alias, candidates: searchExplorerEntities(index, alias).slice(0, 3).map(({type, entity}) => ({type, id: entity.id, name: entity.name})) }));
    const question = '按所附当前赛季词典，回答板甲与反甲的正式名称；再把“豹女和木木同时上场，豹女带饮血，查豹女三件套”解析为conditions和carrierId。只返回JSON，不查询或编造胜率。词典：' + JSON.stringify(facts);
    const config = readConfig();
    const response = await providerRequest('/chat/completions', { model: config.model, thinking: { type: 'disabled' }, stream: false, max_tokens: 700,
      messages: [{ role: 'system', content: '以提供的已核对词典作名称与ID映射。conditions数组使用type/id，装备额外指定holderId；carrierId是查看出装的英雄ID。有歧义则说明，不自行换条件。' }, {role:'user',content:question}] });
    report.calls.push({ model: response.model, usage: response.usage, finishReason: response.choices?.[0]?.finish_reason });
    report.results.push({ facts, answer: response.choices?.[0]?.message?.content || '' });
  } else {
    const questions = [
      '豹女和木木同时上场，豹女带饮血，查最佳三件套及样本量。',
      '卡50慢D和大D有什么区别？锁血是不是每回合都要赢？'
    ];
    for (const question of questions) {
      let result, failure;
      try {
        result = await answerChat({ messages: [{ role: 'user', content: question }], pageContext: { view: 'comps', readonly: true } }, {
          chatCompletion: async (messages, tools) => {
            if (report.calls.length >= 6) throw Object.assign(new Error('Explicit audit call budget exhausted'), { code: 'AUDIT_BUDGET' });
            const completion = await chatCompletion(messages, tools);
            report.calls.push({ question, usage: completion.usage, toolCalls: (completion.message.tool_calls || []).map(c => ({ name: c.function?.name, arguments: c.function?.arguments })) });
            return completion;
          }
        });
      } catch (error) { failure = { code: error.code || 'AUDIT_FAILED', traceId: error.traceId }; }
      const trace = getDeveloperTrace(result?.traceId || failure?.traceId);
      report.results.push({ question, reply: result?.reply ?? null, failure, tools: trace?.tools?.map(t => ({ name: t.name, phase: t.phase, args: t.args,
        executionStatus: t.status, status: t.result?.status, query: t.result?.query, coverage: t.result?.coverage, retrieval: t.result?.retrieval,
        requestedChampion: t.result?.requestedChampion, evidenceTitles: t.result?.evidence?.map?.(e => e.title) })) });
    }
  }
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ...report, failure: { code: error.code || 'AUDIT_FAILED', message: 'Audit did not complete; provider body and credentials omitted.' } }, null, 2));
  process.exitCode = 1;
}
// Close read-only infrastructure clients started by the standalone audit.
process.exit(process.exitCode || 0);
