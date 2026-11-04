import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,createPrivateKey} from 'node:crypto';
import {MarketFeed} from '../lib/cloud/feed.mjs';
import {signedHeaders,BASE} from '../lib/live.mjs';
const args=Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--')?[v.slice(2),a[i+1]]:null).filter(Boolean));
if(!args['key-file']||!args['key-id'])throw new Error('Provide a local key file and API Key ID; private key contents are never printed');
const raw=await readFile(args['key-file'],'utf8'),pem=raw.match(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/)?.[0];
if(!pem)throw new Error('The file does not contain a PEM private key');
const credentials={id:args['key-id'],pem},url=BASE+'/markets?series_ticker=KXBTC15M&status=open&limit=10';
const response=await fetch(url,{headers:signedHeaders('GET',url,Date.now(),{id:credentials.id,key:createPrivateKey(pem)}),signal:AbortSignal.timeout(12000)});
if(!response.ok)throw new Error('Public market lookup HTTP '+response.status);
const data=await response.json(),ticker=args.ticker || data.markets?.find(m=>Date.parse(m.close_time)>Date.now())?.ticker;
if(!ticker)throw new Error('No active test market is available');
const feed=new MarketFeed({credentials:async()=>credentials}),quotes=[];
let remove;
try {
  await new Promise(async(resolve,reject)=>{
    const timer=setTimeout(()=>quotes.length?resolve():reject(new Error('No exchange snapshot received within 25 seconds')),25000);
    try {remove=await feed.add(ticker,message=>{
      if(message.kind==='quote'){
        quotes.push(message);
        if(quotes.length>=3){clearTimeout(timer);resolve();}
      }
    });}catch(error){clearTimeout(timer);reject(error);}
  });
} finally {remove?.();}
const receipt={verified_at:new Date().toISOString(),ticker,transport:'authenticated exchange WebSocket',
  quotes_received:quotes.length,first_sequence:quotes[0].sequence,last_sequence:quotes.at(-1).sequence,
  first_observed_at:quotes[0].as_of,last_observed_at:quotes.at(-1).as_of,
  final_book_sha256:createHash('sha256').update(JSON.stringify(quotes.at(-1).raw)).digest('hex'),
  account_or_order_requests:0,private_key_included:false};
await mkdir('docs',{recursive:true});await writeFile('docs/stream-verification.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
