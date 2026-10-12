import { checkAI } from '../server/ai.mjs';
const result = await checkAI();
console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;
