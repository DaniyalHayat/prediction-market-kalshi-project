import {readFile} from 'node:fs/promises';
const args=Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--')?[v.slice(2),a[i+1]]:null).filter(Boolean));
if(args['key-file']){
  const raw=await readFile(args['key-file'],'utf8');
  const pem=raw.match(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/)?.[0];
  if(!pem||!args['key-id'])throw new Error('Supply a PEM key file and API Key ID');
  process.env.KALSHI_PRIVATE_KEY=pem;process.env.KALSHI_API_KEY_ID=args['key-id'];
}
process.env.MARKET_LOCAL_SERVER='1';
await import('../cloud/server.mjs');
