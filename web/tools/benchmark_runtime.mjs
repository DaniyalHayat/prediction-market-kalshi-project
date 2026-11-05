import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {createMarketServer} from '../cloud/server.mjs';
import {PriceIndex} from '../lib/price-index.mjs';
import {makePostgresStore} from '../lib/postgres-store.mjs';
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*q)-1)];
const report={created_at:new Date().toISOString(),scope:'Synthetic fixtures on the local machine, not production latency, forecast skill or a cloud capacity guarantee.',runtime:process.version};
const index=new PriceIndex();for(let i=0;i<2000;i++)index.set(.1+i/10000,10+i);
const serialize=limit=>JSON.stringify(index.top(limit));
const loop=limit=>{const values=[];for(let repeat=0;repeat<7;repeat++){const started=performance.now();for(let i=0;i<300;i++)serialize(limit);values.push(performance.now()-started);}return median(values);};
report.book_snapshot={levels:2000,iterations:300,repetitions:7,all_levels_median_ms:loop(2000),top100_median_ms:loop(100),all_levels_bytes:Buffer.byteLength(serialize(2000)),top100_bytes:Buffer.byteLength(serialize(100)),scope:'Bounded broadcast materialization only. Full indexed replica is retained; fresh REST depth still governs fills.'};
const edgeSecret='benchmark-edge-'.repeat(4);
report.http=[];report.http_scope='Real localhost HTTP handling, tracing, bounded fixture JSON and eight synthetic visitor identities; excludes external APIs, database calls and deployed network latency.';
for(const concurrency of [1,8,32]){
  const instance=createMarketServer({production:true,edgeSecret,storageEnabled:()=>false,logger:()=>{},getRoute:async()=>Response.json({markets:Array.from({length:100},(_,i)=>({ticker:'FIXTURE-'+i,title:'Synthetic benchmark market',yes_bid:.4,yes_ask:.42}))})});
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.address().port,latencies=[],statuses=[];let next=0;
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();const started=performance.now();
  try{await Promise.all(Array.from({length:concurrency},async()=>{while(next<240){const requestId=next++;const start=performance.now();const response=await fetch(base+'/api/workspace/catalog',{headers:{'x-market-edge-secret':edgeSecret,'x-market-country':'US','x-market-client-ip':'198.51.100.'+(requestId%8+1)}});await response.arrayBuffer();statuses.push(response.status);latencies.push(performance.now()-start);}}));}
  finally{instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));lag.disable();}
  report.http.push({concurrency,requests:latencies.length,successful:statuses.filter(s=>s===200).length,p50_ms:median(latencies),p95_ms:percentile(latencies,.95),p99_ms:percentile(latencies,.99),requests_per_second:latencies.length/((performance.now()-started)/1000),event_loop_p99_ms:lag.percentile(99)/1e6});
}
{
  const listeners=new Map(),tickers=Array.from({length:12},(_,i)=>'FIXTURE-'+i),latencies=[];let bytes=0,frames=0,updates=0;
  const feed={status:'connected',add:async(ticker,listener)=>{if(!listeners.has(ticker))listeners.set(ticker,new Set());listeners.get(ticker).add(listener);listener({kind:'connection',status:'connected'});return()=>listeners.get(ticker)?.delete(listener);}};
  const instance=createMarketServer({production:true,edgeSecret,storageEnabled:()=>false,logger:()=>{},feed});await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+instance.address().port+'/api/portfolio/stream?tickers='+tickers.join(','),controllers=Array.from({length:8},()=>new AbortController()),readers=[];
  const responses=await Promise.all(controllers.map((controller,i)=>fetch(url,{headers:{'x-market-edge-secret':edgeSecret,'x-market-country':'US','x-market-client-ip':'198.51.100.'+(i+1)},signal:controller.signal})));
  const read=responses.map(async response=>{const reader=response.body.getReader();readers.push(reader);let pending='';try{while(true){const row=await reader.read();if(row.done)break;bytes+=row.value.length;pending+=new TextDecoder().decode(row.value);const packets=pending.split('\n\n');pending=packets.pop();for(const packet of packets)if(packet.startsWith('event: book\n')){const value=JSON.parse(packet.split('\ndata: ')[1]);frames++;latencies.push(performance.now()-value.benchmark_sent_ms);}}}catch{}});
  const started=performance.now(),rows=Array.from({length:100},(_,i)=>[(.2+i/10000).toFixed(4),'100']);
  const timer=setInterval(()=>{for(const ticker of tickers){updates++;const value={kind:'quote',ticker,as_of:new Date().toISOString(),benchmark_sent_ms:performance.now(),raw:{orderbook_fp:{yes_dollars:rows,no_dollars:rows}}};for(const fn of listeners.get(ticker)||[])fn(value);}},25);
  await new Promise(resolve=>setTimeout(resolve,2200));clearInterval(timer);for(const controller of controllers)controller.abort();await Promise.all(read);instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));
  report.broadcast={streams:8,tickers:12,fixture_levels_per_side:100,source_updates:updates,delivered_book_frames:frames,uncoalesced_frames:updates*8,bytes,p50_source_to_reader_ms:median(latencies),p99_source_to_reader_ms:percentile(latencies,.99),duration_ms:performance.now()-started,scope:'Actual local multiplex SSE with synthetic 40Hz full-book inputs; latest-state coalescing and eight subscribers. Not a production exchange latency claim.'};
}
if(process.env.MARKET_TEST_DATABASE_URL){
  const url=process.env.MARKET_TEST_DATABASE_URL;if(!new URL(url).pathname.endsWith('_test'))throw new Error('Database benchmarks require a disposable _test database');
  const storage=makePostgresStore({connectionString:url}),client=await storage.db.connect();
  async function time(sql,values=[]){const runs=[];let plan;for(let i=0;i<7;i++){const result=await client.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql,values);plan=result.rows[0]['QUERY PLAN'][0];runs.push(plan['Execution Time']);}return {median_execution_ms:median(runs),plan:plan.Plan};}
  try{
    await client.query('CREATE TEMP TABLE runtime_observations(provider text,scope text,metric text,entity text,measurement_date date,value float8,batch_id int)');
    await client.query("INSERT INTO runtime_observations SELECT 'apple','us','rank','entity-'||(i%1000),date '2026-01-01'+(i/1000)::int,i%100,1 FROM generate_series(1,200000) AS i");
    await client.query('CREATE INDEX runtime_old_chart ON runtime_observations(provider,scope,metric,measurement_date,entity); ANALYZE runtime_observations');
    const chart="SELECT measurement_date,value,batch_id FROM runtime_observations WHERE provider='apple' AND scope='us' AND metric='rank' AND entity='entity-42' ORDER BY measurement_date DESC LIMIT 400";
    const before=await time(chart);await client.query('CREATE INDEX runtime_new_chart ON runtime_observations(provider,scope,metric,entity,measurement_date DESC) INCLUDE(value,batch_id)');
    const after=await time(chart);
    await client.query("CREATE TEMP TABLE runtime_markets(id int,observed_at timestamptz,title text,document tsvector GENERATED ALWAYS AS(to_tsvector('english',title)) STORED)");
    await client.query("INSERT INTO runtime_markets SELECT i,now()-i*interval '1 second',CASE WHEN i%1000=0 THEN 'Solar flare measurement' ELSE 'Synthetic market observation '||i END FROM generate_series(1,200000) AS i; ANALYZE runtime_markets");
    const text="SELECT count(*) FROM runtime_markets WHERE document@@websearch_to_tsquery('english','solar flare')",recent="SELECT count(*) FROM runtime_markets WHERE observed_at>now()-interval '1 hour'";
    const searchBefore=await time(text),timeBefore=await time(recent);
    await client.query('CREATE INDEX runtime_search ON runtime_markets USING gin(document); CREATE INDEX runtime_time ON runtime_markets USING brin(observed_at) WITH(pages_per_range=32)');
    const searchAfter=await time(text),timeAfter=await time(recent);
    await client.query('CREATE TEMP TABLE runtime_partitioned(id int,observed_at date) PARTITION BY RANGE(observed_at)');
    for(let month=1;month<=12;month++){const from=`2026-${String(month).padStart(2,'0')}-01`,to=month===12?'2027-01-01':`2026-${String(month+1).padStart(2,'0')}-01`;await client.query(`CREATE TEMP TABLE runtime_part_${month} PARTITION OF runtime_partitioned FOR VALUES FROM ('${from}') TO ('${to}')`);}
    await client.query("INSERT INTO runtime_partitioned SELECT i,date '2026-01-01'+(i%365)::int FROM generate_series(1,200000) AS i; ANALYZE runtime_partitioned");
    const partition=await time("SELECT count(*) FROM runtime_partitioned WHERE observed_at>=date '2026-09-01' AND observed_at<date '2026-09-02'");
    await client.query("CREATE TEMP TABLE runtime_unpartitioned AS TABLE runtime_partitioned; CREATE INDEX runtime_unpartitioned_date ON runtime_unpartitioned(observed_at); ANALYZE runtime_unpartitioned");
    const regular=await time("SELECT count(*) FROM runtime_unpartitioned WHERE observed_at>=date '2026-09-01' AND observed_at<date '2026-09-02'");
    const payload={ticker:'FIXTURE',price:.4,source:{provider:'fixture',url:'https://example.com',hash:'a'.repeat(64)},unused:Array.from({length:50},(_,i)=>({id:i,text:'Synthetic metadata'}))};
    const projected={ticker:payload.ticker,source:{provider:payload.source.provider}};
    report.database={rows_per_fixture:200000,repetitions:7,chart:{before,after},full_text:{before:searchBefore,after:searchAfter},recent_time:{before:timeBefore,after:timeAfter},partitioning:{partitioned:partition,unpartitioned_btree:regular,scope:'12 synthetic monthly partitions; one-day query. Do not infer a benefit over an indexed table without comparing both.'},projection:{full_bytes:Buffer.byteLength(JSON.stringify(payload)),selected_fields_bytes:Buffer.byteLength(JSON.stringify(projected)),scope:'Equivalent field projection is available in a parameterized nested SQL/REST query. This measures bytes, not GraphQL parser or network performance; no GraphQL endpoint is claimed.'}};
  }finally{client.release();await storage.close();}
}
const output=new URL('../docs/runtime-benchmark.json',import.meta.url);await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file:output.pathname,book_snapshot:report.book_snapshot,http:report.http,database:report.database?{rows:report.database.rows_per_fixture,chart_before_ms:report.database.chart.before.median_execution_ms,chart_after_ms:report.database.chart.after.median_execution_ms,fts_before_ms:report.database.full_text.before.median_execution_ms,fts_after_ms:report.database.full_text.after.median_execution_ms,time_before_ms:report.database.recent_time.before.median_execution_ms,time_after_ms:report.database.recent_time.after.median_execution_ms,partition_ms:report.database.partitioning.partitioned.median_execution_ms,regular_ms:report.database.partitioning.unpartitioned_btree.median_execution_ms}:null},null,2));
