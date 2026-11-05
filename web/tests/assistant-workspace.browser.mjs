import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {executionResearch} from '../lib/workspace/execution-research.mjs';

const local=new URL(process.env.PREDICTIR_TEST_URL||'http://127.0.0.1:37641');
assert.equal(local.hostname,'127.0.0.1','Run this fixture against a local workspace.');
const library=process.env.PLAYWRIGHT_CORE_PATH;
const {chromium}=await import(library?pathToFileURL(library).href:'playwright-core');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,headless:true});
const context=await browser.newContext({viewport:{width:1680,height:1050}});
await context.addInitScript(()=>localStorage.setItem('predictir:appearance:v1','{"model":"challenger"}'));

const now=Date.now(),as_of=new Date(now).toISOString(),close_time=new Date(now+86400000).toISOString();
const markets=[
  {ticker:'KXTEST-ALPHA',title:'Alpha kickoff',rules_primary:'Alpha wins the named fixture.'},
  {ticker:'KXTEST-BETA',title:'Beta kickoff',rules_primary:'Beta wins the named fixture.'},
].map(market=>({...market,category:'sports',status:'active',yes_ask:.4,yes_bid:.35,close_time,volume_24h:100}));
const book=ticker=>({ticker,as_of,raw:{orderbook_fp:{yes_dollars:[['.35','100']],no_dollars:[['.60','100']]}}});
const reporting=(title,publisher,url,excerpt)=>({title,publisher,url,excerpt,as_of,why_relevant:'Names Alpha and the exact fixture.',impact:'Check the final lineup before using this report.'});
const events=[],payloads=[];
const news=ticker=>({ticker,as_of,items:[
  reporting('Starter cleared','League report','https://league.example/lineup','Alpha’s starter has been cleared for this fixture.'),
  reporting('Tracked duplicate','Mirror','https://league.example/lineup?utm_source=repeat','This duplicate should disappear.'),
  reporting('Minutes limit reported','Sports desk','https://sports.example/minutes','The coach expects a first-half minutes limit.'),
],related_items:[reporting('Earlier team preparation','Local desk','https://local.example/earlier','Team preparation report for a different fixture.')],
news_sections:[{heading:'What changed',text:'The old generated lead should disappear.'},{heading:'Settlement check',text:'Check the named fixture after the official result.'}],
source_links:[{label:'League record',kind:'official',url:'https://league.example/results',detail:'Official result for the fixture.'}]});

await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==local.origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const ticker=url.searchParams.get('ticker')||markets[0].ticker;
  const market=markets.find(row=>row.ticker===ticker)||markets[0];
  const json=value=>route.fulfill({json:value});
  if(url.pathname==='/api/session')return json({kind:'guest',guest:{id:'browser-qa',issued_at:as_of,expires_at:close_time}});
  if(url.pathname==='/api/workspace/markets')return json({markets});
  if(url.pathname==='/api/workspace/context')return json({market,fees:{coefficient:.07}});
  if(url.pathname==='/api/workspace/history')return json({ticker,as_of,rows:[]});
  if(url.pathname==='/api/book')return json(book(ticker));
  if(url.pathname==='/api/stream')return route.fulfill({status:204,contentType:'text/event-stream'});
  if(url.pathname==='/api/workspace/opinions')return json({opinions:[]});
  if(url.pathname==='/api/workspace/research')return json({ticker,market,as_of,quote_as_of:as_of,
    forecast:{probability:.6,interval:[.5,.7],model_name:'Fixture model',source_as_of:as_of,validation:{reason:'The validation used completed games only.'}},
    summary:'Fixture forecast.',opinion:{side:'PASS',reason:'The conservative range does not clear costs.'},
    decision:{reasons:['The conservative range does not clear costs.','This matchup has a small holdout sample.']},drivers:[],
    sources:[{label:'League record',url:'https://league.example/results'}]});
  if(url.pathname==='/api/workspace/evidence'){
    const preview=url.searchParams.get('preview');
    events.push(['news',ticker,url.searchParams.get('model'),preview]);
    return json({...news(ticker),...(preview==='0'?{retention:{status:'retained',chunks:3}}:{})});
  }
  if(url.pathname==='/api/workspace/execution-research'){
    const {ticker,controls}=request.postDataJSON();
    const market=markets.find(row=>row.ticker===ticker);
    return json({...executionResearch({market,book:book(ticker),controls,now}),version:'execution-research-v1'});
  }
  if(url.pathname==='/api/assistant'){
    const payload=request.postDataJSON();
    payloads.push(payload);events.push(['assistant',payload.ticker,payload.panel]);
    return route.fulfill({contentType:'text/plain',body:`Fixture answer for ${payload.ticker} (${payload.panel}).`});
  }
  return json({});
});

try{
  const page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(local.href);
  const assistant=page.getByRole('complementary',{name:'Contract research assistant'});
  const ask=async (button,panel,ticker='KXTEST-ALPHA',detail='brief',model='challenger')=>{
    const before=payloads.length;
    await page.getByRole('button',{name:button,exact:true}).click();
    await assistant.getByText(`Fixture answer for ${ticker} (${panel}).`,{exact:true}).waitFor();
    assert.equal(payloads.length,before+1,'One click automatically submits exactly one question');
    const payload=payloads.at(-1);
    assert.equal(payload.ticker,ticker);
    assert.equal(payload.panel,panel);
    assert.equal(payload.detail,detail);
    assert.equal(payload.model,model);
    assert.match(payload.messages.at(-1).content,new RegExp(ticker));
    await assistant.getByRole('button',{name:'Close assistant'}).click();
    return payload;
  };
  assert.equal(await page.getByTestId('selected-title').textContent(),'Alpha kickoff');
  await ask('Ask why about exchange price history','history');
  await page.getByRole('tab',{name:'Analysis'}).click();
  const analysisMode=page.getByRole('group',{name:'Contract analysis reading length'});
  await analysisMode.getByRole('button',{name:'Long read'}).click();
  await page.getByText('This matchup has a small holdout sample.',{exact:true}).waitFor();
  await ask('Ask why about this analysis','analysis','KXTEST-ALPHA','full');
  const newsPanel=page.getByRole('region',{name:'Contract news and context'});
  await newsPanel.getByText('Best-matched report',{exact:true}).waitFor();
  await newsPanel.getByText('Another publisher',{exact:true}).waitFor();
  assert.equal(await newsPanel.getByText('This duplicate should disappear.').count(),0);
  assert.equal(await newsPanel.getByText('Coverage and limits',{exact:true}).count(),0);
  await newsPanel.getByRole('button',{name:'Long read'}).click();
  await newsPanel.getByText('Coverage and limits',{exact:true}).waitFor();
  assert.equal(await newsPanel.getByText('The old generated lead should disappear.').count(),0);
  assert.ok(events.some(row=>row.join('|')==='news|KXTEST-ALPHA|challenger|1'));
  assert.ok(!events.some(row=>row[0]==='news'&&row[3]==='0'),'Changing reading length does not fetch paid sources');
  await ask('Ask why about this contract news','evidence','KXTEST-ALPHA','full');
  const retained=events.findIndex(row=>row.join('|')==='news|KXTEST-ALPHA|challenger|0');
  assert.ok(retained>=0&&retained<events.findIndex(row=>row.join('|')==='assistant|KXTEST-ALPHA|evidence'));
  await page.getByRole('tab',{name:'Rules & sources'}).click();
  await ask('Ask why about settlement rules','rules');
  await ask('Ask why about source records','sources');
  await page.getByRole('tab',{name:'Paper position'}).click();
  const paper=await ask('Ask why about paper position sizing','paper');
  assert.deepEqual(Object.keys(paper).sort(),['detail','messages','model','panel','ticker']);
  await page.getByRole('tab',{name:'Execution lab'}).click();
  const lab=page.getByRole('region',{name:'Execution research lab'});
  const controls=lab.locator('.execution-form');
  await controls.getByLabel(/^Side/).selectOption('no');
  await controls.getByLabel('Contracts',{exact:true}).fill('7');
  await page.getByRole('button',{name:'Run scenario'}).click();
  await page.getByRole('region',{name:'Submitted execution scenario'}).waitFor();
  await controls.getByLabel('Contracts',{exact:true}).fill('9');
  await page.getByText('Settings changed. These results use the previous settings.',{exact:false}).waitFor();
  const execution=await ask('Ask why about the submitted execution scenario','execution','KXTEST-ALPHA','full');
  assert.equal(execution.execution_controls.side,'no');
  assert.equal(execution.execution_controls.contracts,7);
  await page.getByRole('button',{name:'Open Beta kickoff',exact:true}).click();
  assert.equal(await page.getByTestId('selected-ticker').textContent(),'KXTEST-BETA');
  await ask('Ask why about exchange price history','history','KXTEST-BETA');
  await page.getByRole('button',{name:'Appearance and models',exact:true}).click();
  await page.getByRole('radio',{name:/Validated model view/}).check();
  await page.getByRole('button',{name:'Close appearance settings'}).click();
  await ask('Ask why about exchange price history','history','KXTEST-BETA','brief','validated');
  assert.deepEqual(errors,[]);
  console.log('Browser assertions passed for scoped auto-submit, model and contract switches, retained news, paper privacy and submitted execution controls.');
}finally{await browser.close();}
