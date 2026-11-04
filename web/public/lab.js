import {sizePaperPosition} from './risk-client.js';
const $=id=>document.getElementById(id),base=(window.MARKET_API_BASE||'').replace(/\/$/,''),money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
let ticker,quote,events,paused=false,journalData,lastAnalysis,token,closesAt=0;
const text=(id,value)=>{$(id).textContent=value;},error=value=>{$('error').hidden=!value;text('error',value||'');};
try{token=localStorage.getItem('market-lab-journal-token');}catch{}
if(!token){token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');try{localStorage.setItem('market-lab-journal-token',token);}catch{}}
async function api(path,options={}){const r=await fetch(base+path,{cache:'no-store',...options});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request unavailable');return data;}
function status(value,live=false){text('status',value);document.querySelector('.connection').classList.toggle('live',live);}
function renderBook(value){
  if(value.ticker!==ticker)return;quote=value;
  const fp=value.raw?.orderbook_fp;if(!fp)return;
  const sorted=rows=>(rows||[]).map(([p,q])=>[Number(p),Number(q)]).sort((a,b)=>b[0]-a[0]);
  const bids=sorted(fp.yes_dollars),asks=sorted(fp.no_dollars).map(([p,q])=>[1-p,q]);
  const bid=bids[0]?.[0],ask=asks[0]?.[0];
  text('bid',bid===undefined?'—':(bid*100).toFixed(2)+'¢');text('ask',ask===undefined?'—':(ask*100).toFixed(2)+'¢');
  text('spread',bid===undefined||ask===undefined?'—':((ask-bid)*100).toFixed(2)+'¢');
  text('quote-source',(value.transport==='exchange-websocket'?'Native exchange WebSocket':'Observed REST snapshot')+' · '+value.as_of);
  $('depth').replaceChildren();$('depth').classList.remove('empty');
  const max=Math.max(1,...bids.slice(0,8).map(r=>r[1]),...asks.slice(0,8).map(r=>r[1]));
  for(let i=0;i<Math.min(8,Math.max(bids.length,asks.length));i++){
    const row=document.createElement('div');row.className='depth-row';
    for(const values of [bids[i],asks[i]]){const cell=document.createElement('span');cell.textContent=values?(values[0]*100).toFixed(2)+'¢ · '+values[1].toLocaleString():'—';cell.style.setProperty('--width',values?(values[1]/max*100)+'%':'0%');row.append(cell);} $('depth').append(row);
  }
  $('provider').href=value.source_url?.startsWith('https:')?value.source_url:'https://docs.kalshi.com/websockets/orderbook-updates';
  text('lineage',JSON.stringify({ticker,observed_at:value.as_of,sequence:value.sequence,transport:value.transport},null,2));
  if(lastAnalysis)analyze(false);
}
async function refresh(){if(!ticker)return;const value=await api('/api/book?ticker='+encodeURIComponent(ticker)+'&contracts=1');renderBook({...value,transport:'public-rest-snapshot'});}
function stream(){events?.close();if(paused||!ticker)return;status('Connecting to exchange');events=new EventSource(base+'/api/stream?ticker='+encodeURIComponent(ticker));
  events.onmessage=event=>{const data=JSON.parse(event.data);if(data.kind==='quote'){renderBook(data);status('Exchange stream connected',true);}else if(data.kind==='connection')status(data.status==='connected'?'Exchange stream connected':data.status,data.status==='connected');};
  events.onerror=()=>status('Stream reconnecting; last quote retained');
}
async function watch(){error('');ticker=$('contracts').value;if(!ticker)return;lastAnalysis=null;$('freeze').disabled=true;
  $('pause').disabled=false;$('refresh').disabled=false;paused=false;text('pause','Pause stream');
  try{const detail=await api('/api/market?ticker='+encodeURIComponent(ticker));closesAt=Date.parse(detail.market.close_time);text('rules',detail.market.rules_primary||'No primary rules were returned. Inspect the exchange contract.');
    if(!['active','open'].includes(detail.market.status)||closesAt<=Date.now()){paused=true;events?.close();status('Contract closed; awaiting settlement');$('freeze').disabled=true;return;}
    await refresh();stream();
    api('/api/fees?ticker='+encodeURIComponent(ticker)).then(fees=>{if(fees.coefficient!==null&&fees.coefficient<=1){$('fee').value=fees.coefficient;
      $('fee').title='Series '+fees.series+' · '+fees.fee_type+' · multiplier '+fees.multiplier+' · observed '+fees.as_of;}}).catch(()=>{});}
  catch(e){error(e.message);}
}
$('lookup').onsubmit=async event=>{event.preventDefault();error('');try{
  const result=await api('/api/resolve?q='+encodeURIComponent($('market').value));$('contracts').replaceChildren();
  for(const m of result.contracts){const option=document.createElement('option');option.value=m.ticker;option.textContent=m.subtitle+' · '+m.ticker;$('contracts').append(option);}
  $('contracts').disabled=!result.contracts.length;$('watch').disabled=!result.contracts.length;
  if(result.contracts.length===1)await watch();else if(!result.contracts.length)error('No matching contracts were returned. Paste an exact ticker.');
}catch(e){error(e.message);}};
$('watch').onclick=watch;$('refresh').onclick=()=>refresh().catch(e=>error(e.message));
$('pause').onclick=()=>{paused=!paused;text('pause',paused?'Resume stream':'Pause stream');if(paused){events?.close();status('Stream paused');}else stream();};
function analyze(showError=true){
  try{
    if(!quote||Date.now()-Date.parse(quote.as_of)>90000)throw new Error('A fresh quote is required; refresh the selected contract');
    if(closesAt && Date.now()>=closesAt)throw new Error('This contract has closed; choose an active contract');
    const low=Number($('low').value)/100,high=Number($('high').value)/100,p=Number($('point').value)/100;
    if(['low','high','point'].some(id=>$(id).value==='')||p<low||p>high)throw new Error('Enter a probability inside your lower and upper bounds');
    const bankroll=Number($('bankroll').value),budget=Number($('budget').value),fee=Number($('fee').value),fp=quote.raw.orderbook_fp;
    if(!fp.yes_dollars?.length||!fp.no_dollars?.length)throw new Error('Two-sided observed liquidity is required');
    if(Math.max(...fp.yes_dollars.map(r=>Number(r[0])))+Math.max(...fp.no_dollars.map(r=>Number(r[0])))>1+1e-9)throw new Error('Crossed quotes cannot support an entry estimate');
    const make=(side,rows)=>({side,...sizePaperPosition({ticker,quoteTicker:quote.ticker,asOf:quote.as_of,bankroll,budget,
      probabilityLow:side==='YES'?low:1-high,probabilityHigh:side==='YES'?high:1-low,
      levels:(rows||[]).map(([price,quantity])=>({price:1-Number(price),quantity:Number(quantity)})),riskFraction:.99,feeCoefficient:fee})});
    const choices=[make('YES',fp.no_dollars),make('NO',fp.yes_dollars)].sort((a,b)=>b.expectedLogGrowth-a.expectedLogGrowth);
    const best=choices[0];lastAnalysis={probability:p,probability_low:low,probability_high:high,ticker};
    $('decision').replaceChildren();const title=document.createElement('strong');title.textContent=best.contracts?best.side+' under your assumptions':'No position under your assumptions';$('decision').append(title);
    const table=document.createElement('table');for(const c of choices){const row=table.insertRow();for(const value of [c.side,c.contracts+' contracts',money(c.cost)+' maximum loss',c.contracts?'break-even '+(c.cost/c.contracts*100).toFixed(2)+'%':'no positive robust edge'])row.insertCell().textContent=value;}$('decision').append(table);
    const note=document.createElement('p');note.className='muted';note.textContent='Integer positions maximize worst-case expected log wealth under the supplied bounds and visible depth. Fees are modeled per price level. This is conditional sizing, not evidence that your probability is correct.';$('decision').append(note);$('freeze').disabled=false;
  }catch(e){$('freeze').disabled=true;if(showError)error(e.message);}
}
$('analysis').onsubmit=event=>{event.preventDefault();error('');analyze();};
const journalHeaders=()=>({'Authorization':'Bearer '+token,'Content-Type':'application/json'});
async function journal(){journalData=await api('/api/journal',{headers:journalHeaders()});const target=$('journal');target.replaceChildren();
  const summary=document.createElement('p');summary.textContent=journalData.evaluation.n?journalData.evaluation.n+' binary settlements · Brier '+journalData.evaluation.brier.toFixed(4):'0 settled predictions. Performance is not yet measurable.';target.append(summary);
  const table=document.createElement('table');table.className='records';let row=table.insertRow();for(const label of ['Contract','Registered probability','Frozen UTC','Status','Brier']){const th=document.createElement('th');th.textContent=label;row.append(th);}
  for(const record of journalData.records){row=table.insertRow();for(const value of [record.frozen.ticker,(record.frozen.probability*100).toFixed(1)+'%',record.frozen.created_at,record.status,record.score?.brier?.toFixed(4)??'Pending settlement'])row.insertCell().textContent=value;}target.append(table);
}
$('freeze').onclick=async()=>{error('');try{analyze();if(!lastAnalysis||$('freeze').disabled)return;await api('/api/journal',{method:'POST',headers:journalHeaders(),body:JSON.stringify(lastAnalysis)});await journal();}catch(e){error(e.message);}};
$('load-journal').onclick=()=>journal().catch(e=>error(e.message));
$('export-journal').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({private_access_token:token,journal:journalData||null},null,2)],{type:'application/json'}));a.download='market-lab-private-journal.json';a.click();URL.revokeObjectURL(a.href);};
$('import-journal').onchange=async event=>{error('');try{const file=event.target.files[0];if(!file||file.size>2e6)throw new Error('Choose a journal export below 2 MB');const input=JSON.parse(await file.text());if(!/^[a-f0-9]{64}$/.test(input.private_access_token))throw new Error('Invalid journal token');token=input.private_access_token;localStorage.setItem('market-lab-journal-token',token);await journal();}catch(e){error(e.message);}};
setInterval(()=>{if(quote)text('freshness','Quote observed '+Math.max(0,Math.floor((Date.now()-Date.parse(quote.as_of))/1000))+' seconds ago');if(quote&&Date.now()-Date.parse(quote.as_of)>90000)$('freeze').disabled=true;
  if(closesAt&&Date.now()>=closesAt&&!paused){paused=true;events?.close();status('Contract closed; awaiting settlement');$('freeze').disabled=true;text('decision','The selected contract has closed. Choose another active contract.');}
},1000);
setInterval(()=>{if(!paused&&!document.hidden&&ticker&&(!quote||Date.now()-Date.parse(quote.as_of)>30000))refresh().catch(()=>{});},10000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)events?.close();else if(!paused&&ticker)stream();});
window.addEventListener('pagehide',()=>events?.close());
