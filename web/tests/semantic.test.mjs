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
test('reciprocal-rank fusion promotes independent lexical/semantic agreement without calling it confidence',()=>{
  const result=reciprocalRankFusion([{id:'lexical'},{id:'both'}],[{id:'semantic'},{id:'both'}]);assert.equal(result[0].id,'both');assert.equal(result[0].lexical_rank,2);assert.equal(result[0].semantic_rank,2);assert.equal(result[0].confidence,undefined);
});
test('evidence route propagates exact selected trade and Reddit opt-in, while retained search performs no source load',async()=>{
  const calls=[],deps={workspaceResearch:async(t,options)=>{calls.push(['research',t,options]);return {market,news:{articles:[]},extensions:{sports:{league:'nba'},music:{scope:'fixture'}}};},contractEvidence:async(m,options)=>{calls.push(['evidence',m,options]);return evidence;},retainPublicEvidence:async(m,e,options)=>{calls.push(['retain',m,e,options]);return {status:'retained'};}};
  const result=await workspaceEvidence(ticker,{reddit:true,includeX:false},deps);assert.equal(result.retention.status,'retained');assert.equal(calls[1][2].selectedTicker,ticker);assert.equal(calls[1][2].redditEnabled,true);assert.equal(calls[1][2].includeX,false);assert.equal(calls[1][2].sports.league,'nba');assert.equal(calls[2][3].enabled,true);
  let search=0,loads=0;await workspaceGET('workspace/evidence/search',new URLSearchParams({ticker,q:'injury report'}),{workspaceEvidence:async()=>{loads++;},searchRetainedEvidence:async(t,q)=>{search++;assert.equal(t,ticker);assert.equal(q,'injury report');return {citations:[]};}});assert.equal(search,1);assert.equal(loads,0);
  await assert.rejects(workspaceGET('workspace/evidence',new URLSearchParams({ticker,reddit:'yes'}),{}),/0 or 1/);
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
