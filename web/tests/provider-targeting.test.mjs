import test from 'node:test';
import assert from 'node:assert/strict';
import {publicXFeed,xSearchScope} from '../lib/workspace/social.mjs';
import {evidenceSearchTerms} from '../lib/workspace/source-ranking.mjs';
import {contractEvidence} from '../lib/workspace/evidence.mjs';
import {parseSpotifyReferences,spotifyReferences,musicIdentity} from '../lib/workspace/music.mjs';
const NOW=Date.parse('2026-11-05T03:00:00Z');
function memoryStore(){const values=new Map(),cache=new Map(),quotas=new Map();return {values,quotas,get:async key=>values.get(key),save:async row=>values.set(row.pk,row),consume:async(key,limit,amount=1)=>{const used=quotas.get(key)||0;if(used+amount>limit)return false;quotas.set(key,used+amount);return true;},cached:async(key,ttl,producer)=>{if(!cache.has(key))cache.set(key,Promise.resolve().then(()=>producer({publishRecord:async row=>values.set(row.pk,row)})));try{return await cache.get(key);}catch(error){cache.delete(key);throw error;}}};}
const searchResponse={as_of:new Date(NOW).toISOString(),data:{data:[{id:'2118176390805647692',author_id:'123',text:'Lakers confirmed injury update',created_at:new Date(NOW-60000).toISOString()}],includes:{users:[{id:'123',username:'NBA'}]},meta:{result_count:1}}};

test('selected-contract X query binds allowlisted authors and sanitized exact entities',()=>{
  const market={yes_sub_title:'Los Angeles Lakers'},sports={teams:[{name:'Los Angeles Lakers'},{name:'Boston Celtics'}],availability:[{name:'LeBron James'}]};
  const terms=evidenceSearchTerms(market,{sports}),scope=xSearchScope('nba',terms);
  assert.ok(terms.includes('lakers'));assert.ok(terms.includes('LeBron James'));assert.match(scope.query,/from:ShamsCharania OR from:NBA/);assert.match(scope.query,/"Los Angeles Lakers"/);assert.match(scope.query,/-is:retweet -is:reply$/);
  assert.equal(xSearchScope('nba',[...terms].reverse()).key,scope.key);
  const injected=xSearchScope('nba',['Lakers") OR from:shill ("']);assert.ok(!injected.query.includes('from:shill'));assert.equal(xSearchScope('other',['Lakers']),null);assert.equal(xSearchScope('nba',[]),null);
});

test('targeted X search performs one bounded read, reserves expansions and shares its scope cache',async()=>{
  const durable=memoryStore();let calls=0;const deps={store:durable,now:()=>NOW,env:{X_BEARER_TOKEN:'fixture'},sourceJSON:async(_,value)=>{calls++;const url=new URL(value);assert.equal(url.pathname,'/2/tweets/search/recent');assert.equal(url.searchParams.get('max_results'),'10');assert.equal(url.searchParams.get('next_token'),null);return searchResponse;}};
  const options={topic:'nba',entities:['Lakers'],enabled:true};
  const first=await publicXFeed(options,deps),second=await publicXFeed(options,deps);assert.equal(calls,1);assert.equal(first.posts[0].author,'NBA');assert.deepEqual(first.posts,second.posts);assert.equal(first.scope,'selected_entities');assert.equal(durable.quotas.get('x-posts#2026-11'),10);assert.equal(durable.quotas.get('x-cost-milliusd#2026-11'),70);assert.equal(first.coverage.truncated,false);
});

test('targeted search closes on allowance denial and rejects unverified authors without publishing a cursor',async()=>{
  const durable=memoryStore();let calls=0;const base={now:()=>NOW,env:{X_BEARER_TOKEN:'fixture'},sourceJSON:async()=>{calls++;return {...searchResponse,data:{...searchResponse.data,includes:{users:[{id:'123',username:'unlisted_account'}]}}};}};
  assert.equal((await publicXFeed({topic:'nba',entities:['Lakers'],enabled:true},{...base,store:{...durable,consume:async()=>false}})).status,'budget_reached');assert.equal(calls,0);
  const value=await publicXFeed({topic:'nba',entities:['Lakers'],enabled:true},{...base,store:durable});assert.equal(value.status,'unavailable');assert.equal([...durable.values.keys()].some(key=>key.startsWith('x-search-cursor#')),false);
});

test('targeted cache lease loss does not create an X provider cooldown',async()=>{
  const durable=memoryStore();durable.kind='postgres';durable.cached=async(key,ttl,producer)=>producer({publishRecord:async()=>{throw Object.assign(new Error('lost'),{code:'CACHE_LEASE_LOST'});}});
  const value=await publicXFeed({topic:'nba',entities:['Lakers'],enabled:true},{store:durable,now:()=>NOW,env:{X_BEARER_TOKEN:'fixture'},sourceJSON:async()=>searchResponse});assert.equal(value.status,'refreshing');assert.equal(await durable.get('x-public-cooldown'),undefined);
});

test('targeted cursor advances with exact numeric IDs and marks bounded pagination gaps',async()=>{
  const durable=memoryStore(),scope=xSearchScope('nba',['Lakers']),old={...searchResponse.data.data[0],author:'NBA',title:'Older copy',excerpt:'Older copy',url:'https://x.com/NBA/status/2118176390805647692'};
  durable.values.set('x-search-cursor#'+scope.key,{newest_id:'2118176390805647692',posts:[old]});
  const result=await publicXFeed({topic:'nba',entities:['Lakers'],enabled:true},{store:durable,now:()=>NOW,env:{X_BEARER_TOKEN:'fixture'},sourceJSON:async(_,value)=>{assert.equal(new URL(value).searchParams.get('since_id'),'2118176390805647692');return {...searchResponse,data:{...searchResponse.data,data:[{...searchResponse.data.data[0],id:'2118176390805647693'}],meta:{result_count:1,next_token:'unfollowed-next-page'}}};}});
  assert.equal(result.coverage.truncated,true);assert.equal((await durable.get('x-search-cursor#'+scope.key)).newest_id,'2118176390805647693');assert.equal(result.posts.length,2);
});

test('evidence retrieval passes selected entities to X without broad topic-only fetching',async()=>{
  let options;await contractEvidence({ticker:'SELECTED',title:'NBA game',yes_sub_title:'Los Angeles Lakers'},{enabled:true,selectedTicker:'SELECTED',sports:{teams:[{name:'Los Angeles Lakers'},{name:'Boston Celtics'}]}},{now:()=>NOW,sportsNews:async()=>({articles:[]}),publicXFeed:async value=>{options=value;return {posts:[]};},redditEvidence:async()=>({posts:[]})});assert.ok(options.entities.includes('lakers'));assert.ok(options.entities.includes('Boston Celtics'));
});

test('Spotify references require exact artist or track identity rather than a similar search result',async()=>{
  const id='0123456789012345678901',row={id,name:'Sabrina Carpenter',external_urls:{spotify:'https://open.spotify.com/artist/'+id}};
  assert.equal(parseSpotifyReferences({artists:{items:[row,{...row,name:'Sabrina Annlynn Carpenter'}]}},{query:'Sabrina Carpenter'}).length,1);
  const track={...row,name:'Espresso',artists:[{name:'Sabrina Carpenter'}],external_urls:{spotify:'https://open.spotify.com/track/'+id}};
  assert.equal(parseSpotifyReferences({tracks:{items:[track,{...track,artists:[{name:'Other singer'}]}]}},{query:'Espresso',kind:'track',artist:'Sabrina Carpenter'}).length,1);
  assert.throws(()=>parseSpotifyReferences({},{query:'Espresso',kind:'track'}),/schema/);assert.equal(parseSpotifyReferences({artists:{items:[{...row,external_urls:{spotify:'https://token@open.spotify.com/artist/'+id}}]}},{query:'Sabrina Carpenter'}).length,0);
  const result=await spotifyReferences('Espresso',{kind:'track',artist:'Sabrina Carpenter',getToken:async()=>'fixture',get:async(_,value)=>{const url=new URL(value);assert.equal(url.searchParams.get('type'),'track');assert.equal(url.searchParams.get('market'),'US');return {as_of:new Date(NOW).toISOString(),data:{tracks:{items:[track]}}};}});assert.equal(result.references[0].kind,'track');assert.match(result.policy,/excluded from all model packets/);
});

test('music identity preserves song and artist when both are structured',()=>{
  assert.deepEqual(musicIdentity({custom_strike:{Artist:'Sabrina Carpenter',Song:'Espresso'}}),{artist:'Sabrina Carpenter',song:'Espresso',kind:'track'});assert.deepEqual(musicIdentity({title:'Which song will be #1?',yes_sub_title:'Thriller'}),{artist:null,song:'Thriller',kind:'track'});assert.equal(musicIdentity({title:'Which artist will be #1?',yes_sub_title:'Yes'}).artist,null);
});
