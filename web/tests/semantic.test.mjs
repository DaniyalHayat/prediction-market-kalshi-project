import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {EMBEDDING_MODEL,embedPublicTexts,publicEvidenceChunks,createEvidenceRepository,reciprocalRankFusion} from '../lib/workspace/semantic.mjs';
import {workspaceEvidence,workspaceGET,workspaceResearch} from '../lib/workspace/router.mjs';
import {applyTestSchema} from './database-fixture.mjs';
const NOW=Date.parse('2026-11-05T02:30:00Z'),ticker='KXNBAGAME-26NOV05LALBOS-LAL',market={ticker,title:'Los Angeles Lakers at Boston Celtics',yes_sub_title:'Los Angeles Lakers',rules_primary:'YES if the Lakers win the scheduled game.',private_journal:'PRIVATE_JOURNAL_SENTINEL'};
const evidence={ticker,as_of:new Date(NOW).toISOString(),items:[{title:'Synthetic fixture: Lakers forward sidelined',excerpt:'A basketball player is unable to play because of an ankle injury. Synthetic retrieval fixture; not a current injury report.',publisher:'Fixture sports source',url:'https://example.org/injury',as_of:new Date(NOW-60000).toISOString(),source_tier:'reported'},{title:'Synthetic fixture: film ticket presales',excerpt:'Cinema audiences buy tickets for a new Hollywood movie. Synthetic retrieval fixture.',publisher:'Fixture film source',url:'https://example.org/film',as_of:new Date(NOW-60000).toISOString()}],account:{email:'PRIVATE_EMAIL_SENTINEL'},journal:{text:'PRIVATE_JOURNAL_SENTINEL'}};
const basis=n=>Array.from({length:384},(_,i)=>i===n?1:0),fixtureEmbed=async texts=>texts.map(text=>basis(/film|Cinema/i.test(text)?1:0));

test('only explicit exact-ticker loads index selected public fields; private journals and Spotify catalog are excluded',async()=>{
  const chunks=publicEvidenceChunks(market,{...evidence,items:[...evidence.items,{title:'Private account',excerpt:'secret',url:'https://example.org/account/profile',as_of:evidence.as_of},{title:'Spotify catalog sentinel',excerpt:'SPOTIFY_CATALOG_SENTINEL',url:'https://api.spotify.com/v1/artists/1',as_of:evidence.as_of}]},{now:NOW});
  assert.ok(chunks.length>=3);assert.ok(chunks.every(r=>r.content.length<=1200&&r.ticker===ticker));assert.ok(!JSON.stringify(chunks).includes('PRIVATE_'));assert.ok(!JSON.stringify(chunks).includes('SPOTIFY_CATALOG_SENTINEL'));
  let calls=0;const repository=createEvidenceRepository({now:()=>NOW,embed:async texts=>{calls++;return fixtureEmbed(texts);}});
  assert.equal((await repository.index(market,evidence)).status,'not_indexed');assert.equal((await repository.index(market,evidence,{enabled:true,selectedTicker:'OTHER'})).status,'not_indexed');assert.equal(calls,0);
});
test('retained search is ticker-scoped, bounded, citation-backed and never triggers evidence ingestion',async()=>{
  const localTicker='FIXTURE-'+randomUUID(),m={...market,ticker:localTicker},e={...evidence,ticker:localTicker},repository=createEvidenceRepository({now:()=>NOW,embed:fixtureEmbed});
  assert.equal((await repository.search(localTicker,'ankle injury')).status,'empty');
  assert.equal((await repository.index(m,e,{enabled:true,selectedTicker:localTicker})).status,'retained_ephemeral');
  assert.equal((await repository.index(m,e,{enabled:true,selectedTicker:localTicker})).embedded_chunks,0);
  const result=await repository.search(localTicker,'ankle injury',{limit:2});assert.equal(result.retrieval.mode,'hybrid_rrf');assert.equal(result.citations[0].url,'https://example.org/injury');assert.ok(result.citations.every(c=>c.ticker===localTicker));assert.ok(result.citations.length<=2);
  assert.equal((await repository.search('FIXTURE-OTHER','ankle injury')).citations.length,0);await assert.rejects(repository.search(localTicker,'x'),RangeError);await assert.rejects(repository.search(localTicker,'ankle',{limit:50}),RangeError);
  const lexical=createEvidenceRepository({now:()=>NOW,embed:async()=>{throw new Error('model fixture unavailable');}}),fallback=await lexical.search(localTicker,'ankle injury');assert.equal(fallback.retrieval.mode,'lexical_only');assert.equal(fallback.citations[0].url,'https://example.org/injury');
  await repository.index(m,{...e,items:[e.items[0]]},{enabled:true,selectedTicker:localTicker});assert.equal((await repository.search(localTicker,'film tickets')).citations.length,0);
});
test('storage reservations close before inference and expired Reddit chunks cannot enter retained search',async()=>{
  let calls=0;const repository=createEvidenceRepository({storage:{consume:async()=>false},now:()=>NOW,embed:async texts=>{calls++;return fixtureEmbed(texts);}});
  assert.equal((await repository.index(market,evidence,{enabled:true,selectedTicker:ticker})).status,'budget_reached');assert.equal(calls,0);
  const value=publicEvidenceChunks(market,{...evidence,items:[{title:'Expired community fixture',excerpt:'Expired retained post',platform:'reddit',url:'https://www.reddit.com/r/nba/comments/abc123/test/',publisher:'r/nba',as_of:new Date(NOW-3600000).toISOString(),retrieved_at:new Date(NOW-1200000).toISOString()}]},{now:NOW});assert.ok(value.every(row=>row.source_kind!=='community_context'));
});
test('provider first-seen time is not relabeled as verified source publication in retained citations',()=>{
  const chunks=publicEvidenceChunks(market,{...evidence,items:[{...evidence.items[0],time_basis:'provider_first_seen'}]},{now:NOW}),source=chunks.find(row=>row.source_url==='https://example.org/injury');assert.equal(source.published_at,null);assert.equal(source.retrieved_at,evidence.as_of);
});
test('retained sports search excludes older non-performance stories after the ranking rules change',async()=>{
  const testTicker='KXNBAGAME-TEST-'+randomUUID(),m={...market,ticker:testTicker},e={...evidence,ticker:testTicker},
    repository=createEvidenceRepository({now:()=>NOW,embed:fixtureEmbed});
  const publicity={...e.items[0],title:'Lakers forward asks a sports betting app to stop using his likeness',
    excerpt:'The request went out to the vendor.',url:'https://example.org/likeness'};
  await repository.index(m,{...e,items:[e.items[0],publicity]},{enabled:true,selectedTicker:testTicker});
  const result=await repository.search(testTicker,'Lakers forward');
  assert.equal(result.status,'available');
  assert.ok(result.citations.some(row=>row.url==='https://example.org/injury'));
  assert.ok(result.citations.every(row=>row.url!=='https://example.org/likeness'));
});
test('reciprocal-rank fusion promotes independent lexical/semantic agreement without calling it confidence',()=>{
  const result=reciprocalRankFusion([{id:'lexical'},{id:'both'}],[{id:'semantic'},{id:'both'}]);assert.equal(result[0].id,'both');assert.equal(result[0].lexical_rank,2);assert.equal(result[0].semantic_rank,2);assert.equal(result[0].confidence,undefined);
});
test('hybrid citations combine cross-chunk agreement once per source while preserving the chosen excerpt',async()=>{
  const ticker='FUSION-'+randomUUID(),url='https://example.org/official?edition=us';
  const docs=[
    ['Ankle injury rumor','Mentions both keywords.','https://example.org/rumor'],
    ['Ankle update','The medical report gives the official game status.',url],
    ['Condition confirmed','He will sit out the game after getting hurt.',url+'&utm_source=mirror#details'],
    ['Different edition','He may play despite the ankle injury.','https://example.org/official?edition=eu'],
    ['Semantic distractor','Speculation that he may be unavailable.','https://example.org/speculation'],
  ];
  const items=docs.map(([title,excerpt,url])=>({title,excerpt,url,publisher:'Fixture',as_of:evidence.as_of}));
  const repository=createEvidenceRepository({now:()=>NOW,embed:async texts=>texts.map(text=>
    /will sit out|speculation that|^ankle injury$/i.test(text)?basis(1):basis(0))});
  await repository.index({ticker,title:'Fixture contract'},{ticker,as_of:evidence.as_of,items},{enabled:true,selectedTicker:ticker});
  const result=await repository.search(ticker,'ankle injury');
  assert.equal(result.retrieval.fusion_unit,'source_url');
  assert.equal(result.citations[0].url,url);
  assert.equal(result.citations[0].lexical_rank,2);
  assert.ok(result.citations[0].semantic_rank<=2);
  assert.equal(result.citations[0].cosine_similarity,null);
  assert.equal(result.citations[0].source_cosine_similarity,1);
  assert.match(result.citations[0].text,/medical report/);
  assert.equal(result.citations.filter(row=>row.url.includes('edition=us')).length,1);
  assert.ok(result.citations.some(row=>row.url.includes('edition=eu')));
});
test('a stalled dense query still returns lexical citations with an explicit retrieval status',async()=>{
  const ticker='DENSE-DEADLINE-'+randomUUID(),m={...market,ticker},e={...evidence,ticker};
  const repository=createEvidenceRepository({now:()=>NOW,embed:async texts=>
    texts.length===1?new Promise(()=>{}):fixtureEmbed(texts)});
  await repository.index(m,e,{enabled:true,selectedTicker:ticker});
  const result=await repository.search(ticker,'ankle injury');
  assert.equal(result.retrieval.mode,'lexical_only');
  assert.equal(result.retrieval.semantic_status,'timed_out');
  assert.equal(result.citations[0].url,'https://example.org/injury');
});
test('a failed dense quota read cannot suppress lexical evidence',async()=>{
  const ticker='DENSE-QUOTA-'+randomUUID(),m={...market,ticker},e={...evidence,ticker};
  let fail=false;
  const repository=createEvidenceRepository({now:()=>NOW,embed:fixtureEmbed,storage:{consume:async()=>{
    if(fail)throw new Error('Fixture quota is unavailable');
    return true;
  }}});
  await repository.index(m,e,{enabled:true,selectedTicker:ticker});
  fail=true;
  const result=await repository.search(ticker,'ankle injury');
  assert.equal(result.retrieval.mode,'lexical_only');
  assert.equal(result.retrieval.semantic_status,'unavailable');
  assert.equal(result.citations[0].url,'https://example.org/injury');
});
test('sports availability favors exact fixture updates over related reports and settlement boilerplate',async()=>{
  const ticker='KXNBAGAME-AVAILABILITY-'+randomUUID(),m={...market,ticker};
  const base={publisher:'Fixture sports source',as_of:evidence.as_of,source_tier:'reported'};
  const items=[{...base,title:'Lakers center downgraded to out for Celtics matchup',excerpt:'A twisted ankle keeps him on the bench.',url:'https://example.org/matchup'}];
  const related_items=[{...base,title:'Injured forward will miss the game',excerpt:'The player will sit out.',url:'https://example.org/related',match_scope:'related'}];
  const repository=createEvidenceRepository({now:()=>NOW,embed:fixtureEmbed});
  await repository.index(m,{ticker,as_of:evidence.as_of,items,related_items},{enabled:true,selectedTicker:ticker});
  const result=await repository.search(ticker,'who is out injured and will miss the game');
  assert.equal(result.retrieval.intent,'sports_availability');
  assert.deepEqual(result.citations.map(c=>c.url),['https://example.org/matchup','https://example.org/related']);
  const mixed=await repository.search(ticker,'who is injured and what are the settlement rules');
  assert.equal(mixed.retrieval.intent,'general');
  assert.ok(mixed.citations.some(c=>c.source_kind==='public_contract_rules'));
});
test('evidence route propagates exact selected trade and Reddit opt-in, while retained search performs no source load',async()=>{
  const calls=[],sources=[{name:'Fixture',url:'https://example.org/rules'}];
  const deps={marketDetails:async t=>{assert.equal(t,ticker);return {market};},request:async path=>{assert.equal(path,'/series/KXNBAGAME');return {data:{series:{settlement_sources:sources}}};},
    workspaceResearch:async()=>{throw new Error('Evidence must never run the forecast');},contractEvidence:async(m,options)=>{calls.push(['evidence',m,options]);assert.deepEqual(await options.settlementSources,sources);return evidence;},
    retainPublicEvidence:async(m,e,options)=>{calls.push(['retain',m,e,options]);return {status:'retained'};}};
  const result=await workspaceEvidence(ticker,{reddit:true,includeX:false},deps);
  assert.equal(result.retention.status,'retained');assert.equal(calls[0][2].selectedTicker,ticker);assert.equal(calls[0][2].redditEnabled,true);assert.equal(calls[0][2].includeX,false);
  assert.equal(calls[1][3].enabled,true);assert.equal(calls[1][3].deferEmbedding,true);
  calls.length=0;
  const replay=await workspaceEvidence(ticker,{retain:false},deps);
  assert.equal(replay.retention,undefined);assert.equal(calls.length,1);assert.equal(calls[0][2].headlineMode,'full');
  let search=0,loads=0;await workspaceGET('workspace/evidence/search',new URLSearchParams({ticker,q:'injury report'}),{workspaceEvidence:async()=>{loads++;},searchRetainedEvidence:async(t,q)=>{search++;assert.equal(t,ticker);assert.equal(q,'injury report');return {citations:[]};}});assert.equal(search,1);assert.equal(loads,0);
  await assert.rejects(workspaceGET('workspace/evidence',new URLSearchParams({ticker,reddit:'yes'}),{}),/0 or 1/);
});
test('deferred inference serves lexical results immediately and never restores superseded documents',async()=>{
  const localTicker='FIXTURE-'+randomUUID(),m={...market,ticker:localTicker},e={...evidence,ticker:localTicker};
  let start,finish;const started=new Promise(resolve=>{start=resolve;});
  const repository=createEvidenceRepository({now:()=>NOW,embed:async texts=>{
    if(texts.length>1){start();await new Promise(resolve=>{finish=resolve;});}
    return fixtureEmbed(texts);
  }});
  const indexed=await repository.index(m,e,{enabled:true,selectedTicker:localTicker,deferEmbedding:true});
  assert.equal(indexed.semantic_status,'queued');
  await started;
  const lexical=await repository.search(localTicker,'What happened to the ankle injury?');
  assert.equal(lexical.retrieval.mode,'lexical_only');assert.equal(lexical.citations[0].url,'https://example.org/injury');
  await repository.index(m,{...e,items:[e.items[0]]},{enabled:true,selectedTicker:localTicker,deferEmbedding:true});
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  const hybrid=await repository.search(localTicker,'ankle injury');
  assert.equal(hybrid.retrieval.mode,'hybrid_rrf');assert.ok(hybrid.citations.every(row=>row.url!=='https://example.org/film'));
});
test('ordinary full research cannot automatically load paid X feeds or alternative evidence charts',async()=>{
  let posts=0,headlineCalls=0;const deps={marketDetails:async()=>({market}),book:async()=>null,marketFees:async()=>null,marketBrief:async(t,o,d)=>{const news=await d.headlines();headlineCalls++;assert.equal(news.status,'not_queried');return {market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:['Fixture']},sources:[],errors:[]};},sportsResearch:async()=>null,musicResearch:async(m,o)=>{assert.equal(o.includeAlternatives,false);return null;},chartPosts:async()=>{posts++;return {posts:[]};}};
  await workspaceResearch(ticker,{},deps);assert.equal(posts,0);assert.equal(headlineCalls,1);
});
test('matched started NBA games explain the pregame/live boundary without claiming the entire series is unsupported',async()=>{
  const deps={marketDetails:async()=>({market}),book:async()=>null,marketFees:async()=>null,marketBrief:async()=>({market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:['No model mapped to this series']},sources:[],errors:[]}),sportsResearch:async()=>({league:'nba',event:{played_at:'2026-01-01T00:00:00Z',completed:false},reason:null,challenger:{available:true,inplay:true,eligible:false}}),musicResearch:async()=>null};
  const result=await workspaceResearch(ticker,{fast:true},deps);assert.equal(result.opinion.side,'PASS');assert.equal(result.forecast.probability,null);assert.match(result.opinion.reason,/game has started/);assert.match(result.opinion.reason,/experimental score-clock/);assert.ok(!result.opinion.reason.includes('No model mapped'));
});
test('actual pinned CPU MiniLM embeds related paraphrases closer than unrelated text',{skip:process.env.SEMANTIC_LIVE_TEST!=='1',timeout:60000},async()=>{
  const vectors=await embedPublicTexts(['The basketball player is sidelined by an ankle injury.','The athlete cannot play because he hurt his ankle.','A film opened at the box office.']);
  assert.equal(vectors.length,3);assert.equal(vectors[0].length,384);for(const vector of vectors)assert.ok(Math.abs(vector.reduce((s,x)=>s+x*x,0)-1)<1e-4);
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);assert.ok(dot(vectors[0],vectors[1])>dot(vectors[0],vectors[2])+.3);assert.equal(EMBEDDING_MODEL.revision,'751bff37182d3f1213fa05d7196b954e230abad9');
});
test('actual PostgreSQL stores public embeddings, fuses native-vector and FTS search, and enforces RLS',{skip:!process.env.MARKET_SEMANTIC_TEST_DATABASE_URL,timeout:60000},async()=>{
  const url=process.env.MARKET_SEMANTIC_TEST_DATABASE_URL;if(!new URL(url).pathname.endsWith('_test'))throw new Error('Use a disposable _test database');const pool=new pg.Pool({connectionString:url,max:2});
  try{
    await applyTestSchema(pool);await pool.query(await readFile(new URL('../database/006_public_evidence.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../database/006_public_evidence.sql',import.meta.url),'utf8'));
    const now=Date.now(),tag='SEMANTIC-'+randomUUID(),m={...market,ticker:tag},e={...evidence,ticker:tag,as_of:new Date(now).toISOString(),items:evidence.items.map(row=>({...row,as_of:new Date(now-60000).toISOString()}))},repository=createEvidenceRepository({storage:{kind:'postgres',db:pool,consume:async()=>true},now:()=>now});
    const indexed=await repository.index(m,e,{enabled:true,selectedTicker:tag});assert.equal(indexed.semantic_status,'embedded');const vectorInstalled=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS present")).rows[0].present;assert.equal(indexed.storage,vectorInstalled?'postgres_pgvector':'postgres_array');
    const result=await repository.search(tag,'athlete cannot participate because he hurt his ankle');assert.equal(result.citations[0].url,'https://example.org/injury');assert.equal(result.retrieval.mode,'hybrid_rrf');assert.ok(result.citations[0].cosine_similarity>.2);
    await Promise.all([e.items[0],e.items[1]].map(item=>repository.index(m,{...e,items:[item]},{enabled:true,selectedTicker:tag})));
    const retained=(await pool.query('SELECT source_url FROM market_lab.public_evidence_chunks WHERE ticker=$1',[tag])).rows;assert.equal(retained.length,2);assert.equal(retained.filter(row=>row.source_url.startsWith('https://example.org/')).length,1);
    const injection=await repository.search(tag,"'; DROP TABLE market_lab.public_evidence_chunks; --");assert.ok(injection.citations.every(c=>c.ticker===tag));assert.ok((await pool.query('SELECT count(*)::int AS n FROM market_lab.public_evidence_chunks WHERE ticker=$1',[tag])).rows[0].n>0);
    const client=await pool.connect();try{await client.query('BEGIN');await client.query('CREATE ROLE semantic_fixture_reader');await client.query('GRANT USAGE ON SCHEMA market_lab TO semantic_fixture_reader');await client.query('GRANT SELECT ON market_lab.public_evidence_chunks TO semantic_fixture_reader');await client.query('SET LOCAL ROLE semantic_fixture_reader');assert.equal((await client.query('SELECT count(*)::int AS n FROM market_lab.public_evidence_chunks')).rows[0].n,0);await client.query('ROLLBACK');}finally{client.release();}
  }finally{await pool.end();}
});
