import {readFile,writeFile} from 'node:fs/promises';
import {analyzePublicTraderEvidence} from '../lib/workspace/trader-evidence.mjs';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node tools/analyze_public_traders.mjs public-closed-trades.json analysis.json');
const result=analyzePublicTraderEvidence(JSON.parse(await readFile(input,'utf8')));
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({accepted:result.accepted,rejected:result.rejected.length,scope:result.scope}));
