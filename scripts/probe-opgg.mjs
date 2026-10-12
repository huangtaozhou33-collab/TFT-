import { mkdir, writeFile } from 'node:fs/promises';
import { OPGGClient, describeError, unwrapTool } from './opgg-client.mjs';

const dir = new URL('../data/raw/', import.meta.url);
await mkdir(dir, { recursive: true });
const client = new OPGGClient(process.env.OPGG_MCP_URL || 'https://mcp-api.op.gg/mcp');
const evidence = { endpoint: client.endpoint, fetchedAt: new Date().toISOString(), dnsOrder: 'ipv4first', status: 'unavailable', stages: [] };
try {
  const tools = await client.initialize();
  evidence.stages.push({ name: 'initialize+tools/list', status: 'ok', protocol: client.protocol, serverInfo: client.serverInfo, toolCount: tools.length });
  await writeFile(new URL('opgg-tools.json', dir), JSON.stringify({ fetchedAt: evidence.fetchedAt, tools }, null, 2));
  const tftTools = tools.filter(tool => tool.name.startsWith('tft_'));
  console.log(JSON.stringify({ tftTools: process.argv.includes('--verbose') ? tftTools : tftTools.map(tool => ({ name: tool.name, required: tool.inputSchema.required ?? [] })) }, null, 2));
  if (process.argv.includes('--all')) {
    const calls = [
      ['tft_list_meta_decks', {}],
      ['tft_list_item_combinations', { lang: 'zh_CN' }],
      ['tft_list_augments', { lang: 'zh_CN' }],
      ['tft_get_champion_item_build', { champion_id: tools.find(tool => tool.name === 'tft_get_champion_item_build').inputSchema.properties.champion_id.enum.find(id => /Ahri/.test(id)) }],
      ['tft_list_champions_for_item', { item_id: tools.find(tool => tool.name === 'tft_list_champions_for_item').inputSchema.properties.item_id.enum.find(id => /InfinityEdge$/.test(id)) }],
    ];
    for (const [name, args] of calls) {
      try {
        const raw = await client.call(name, args); const body = unwrapTool(raw);
        await writeFile(new URL(`opgg-${name}.json`, dir), JSON.stringify({ fetchedAt: new Date().toISOString(), endpoint: client.endpoint, tool: name, args, result: raw, body }, null, 2));
        evidence.stages.push({ name, status: 'ok', bodyKeys: Object.keys(body), payloadBytes: JSON.stringify(body).length });
      } catch (error) { evidence.stages.push({ name, status: 'failed', ...describeError(error) }); }
      console.log(JSON.stringify(evidence.stages.at(-1)));
    }
    evidence.stages.push({ name: 'tft_get_play_style', status: 'schema_verified', reason: 'Requires a real player region and PUUID. No player identifier was supplied; no profile was collected.' });
  } else if (process.argv.includes('--call')) {
    const name = process.argv.find(arg => arg.startsWith('--tool='))?.slice(7) || 'tft_list_meta_decks';
    const argsText = process.argv.find(arg => arg.startsWith('--args='))?.slice(7);
    const args = argsText ? JSON.parse(argsText) : {};
    const raw = await client.call(name, args);
    const body = unwrapTool(raw);
    await writeFile(new URL(`opgg-${name}.json`, dir), JSON.stringify({ fetchedAt: new Date().toISOString(), endpoint: client.endpoint, tool: name, args, result: raw, body }, null, 2));
    evidence.stages.push({ name, status: 'ok', bodyKeys: Object.keys(body), payloadBytes: JSON.stringify(body).length });
    console.log(JSON.stringify(evidence.stages.at(-1)));
  }
  const businessStages = evidence.stages.filter(stage => stage.name.startsWith('tft_') && ['ok', 'failed'].includes(stage.status));
  const failedCount = businessStages.filter(stage => stage.status === 'failed').length;
  evidence.status = failedCount === 0 ? 'live' : failedCount === businessStages.length ? 'unavailable' : 'degraded';
} catch (error) { evidence.stages.push({ name: 'failure', status: 'failed', ...describeError(error) }); console.error(JSON.stringify(evidence)); process.exitCode = 1; }
finally { await client.close().catch(() => {}); await writeFile(new URL('../opgg-status.json', dir), JSON.stringify(evidence, null, 2)); }
