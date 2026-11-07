import test from 'node:test';
import assert from 'node:assert/strict';
import {contractEvidence} from '../lib/workspace/evidence.mjs';
import {collectCommunityContext,collectOfficialEvidence,parseFedCalendar,parseHurricaneFeed} from '../lib/workspace/public-evidence.mjs';
import {permittedPublicPage} from '../lib/workspace/public-pages.mjs';
import {publicEvidenceChunks} from '../lib/workspace/semantic.mjs';

const now=Date.parse('2026-11-07T02:00:00Z');
const asOf=new Date(now).toISOString();
const fed={ticker:'KXFED-26DEC-T4.00',title:'Federal Reserve rate above 4%',close_time:'2026-12-09T20:00:00Z',rules_primary:'If the Federal Reserve rate is above 4% on December 9, 2026, the market resolves to Yes.'};
const calendar='<h4>2026 FOMC Meetings</h4>'+
  '<div class="fomc-meeting__month">October</div><div class="fomc-meeting__date">27-28</div>'+
  '<div class="fomc-meeting__month">December</div><div class="fomc-meeting__date">8-9*</div>';
const tech={ticker:'KXLLM1-26NOV30-OAI',title:'Top LLM',custom_strike:{Organization:'OpenAI'},rules_primary:'If OpenAI has the top-ranked LLM on Nov 30, 2026, then the market resolves to Yes.'};
const hurricane={ticker:'KXHURRICANE-26DEC01EPACMAJ-8',rules_primary:'If the National Weather Service records at least eight in the Eastern Pacific from May 15, 2026 through Dec 1, 2026, this resolves to Yes.'};
const page=(data,stamp=asOf)=>({status:'available',as_of:stamp,sha256:'sample',data:{text:data}});

test('FOMC collection requires a matching series, decision day and exact official calendar row',async()=>{
  assert.deepEqual(parseFedCalendar(calendar),[{start:'2026-10-27',end:'2026-10-28'},{start:'2026-12-08',end:'2026-12-09'}]);
  let requests=0;
  const get=async(name,url)=>{requests++;assert.equal(new URL(url).hostname,'www.federalreserve.gov');return page(calendar);};
  const result=await collectOfficialEvidence(fed,{now,get});
  assert.equal(result.status,'available');
  assert.equal(result.rows[0].retrieved_at,asOf);
  assert.equal(result.rows[0].time_basis,'retrieved_at');
  assert.match(result.rows[0].excerpt,/2026-12-08 through 2026-12-09/);
  assert.equal((await collectOfficialEvidence({...fed,close_time:'2026-12-10T00:01:00Z',rules_primary:fed.rules_primary.replace('December 9','December 8')},{now,get})).status,'not_applicable');
  assert.equal((await collectOfficialEvidence({...fed,ticker:'KXOTHER-26DEC'},{now,get})).status,'not_applicable');
  assert.equal(requests,1);
});

test('official page honors robots denial and only tolerates a missing policy on the approved FOMC URL',async()=>{
  const url='https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
  const paths=[];
  const attempt=robots=>async href=>{
    paths.push(new URL(href).pathname);
    return new URL(href).pathname==='/robots.txt'?robots:new Response(calendar);
  };
  const denied=await permittedPublicPage('calendar',url,{fetcher:attempt(new Response('User-agent: *\nDisallow: /monetarypolicy/'))});
  assert.equal(denied.status,'robots_blocked');
  assert.deepEqual(paths.splice(0),['/robots.txt']);
  const interstitial=await permittedPublicPage('calendar interstitial',url,{fetcher:attempt(new Response('<!doctype html><html>Policy page</html>'))});
  assert.equal(interstitial.status,'robots_blocked');
  assert.deepEqual(paths.splice(0),['/robots.txt']);
  const allowed=await permittedPublicPage('calendar missing policy',url,{fetcher:attempt(new Response('Not found',{status:404}))});
  assert.equal(allowed.status,'available');
  assert.deepEqual(paths.splice(0),['/robots.txt','/monetarypolicy/fomccalendars.htm']);
  await assert.rejects(permittedPublicPage('other','https://www.federalreserve.gov/other.htm',{fetcher:attempt(new Response('Not found',{status:404}))}),{upstream_status:404});
  assert.deepEqual(paths.splice(0),['/robots.txt']);
  await assert.rejects(permittedPublicPage('calendar forbidden',url,{fetcher:attempt(new Response('Forbidden',{status:403}))}),{upstream_status:403});
  assert.deepEqual(paths,['/robots.txt']);
});

test('NHC collection validates basin, bulletin publisher, observation window and freshness',async()=>{
  const row=(label,id,date,host='www.nhc.noaa.gov')=>'<item><title>'+label+'</title><link>https://'+host+
    '/'+id+'</link><pubDate>'+date+'</pubDate><description><![CDATA[Known <b>facts</b> &amp; conditions.]]></description></item>';
  const xml='<rss><channel><title>NHC Eastern North Pacific</title>'+
    row('Tropical Weather Outlook','current','Fri, 06 Nov 2026 23:58:00 GMT')+
    row('There are no tropical cyclones at this time','empty','Fri, 06 Nov 2026 23:00:00 GMT')+
    row('Tropical Weather Outlook','old','Tue, 03 Nov 2026 01:00:00 GMT')+
    row('Hurricane Advisory','foreign','Fri, 06 Nov 2026 23:00:00 GMT','invalid.example')+
    row('Hurricane Advisory','future','Sat, 07 Nov 2026 03:00:00 GMT')+'</channel></rss>';
  const get=async(name,url)=>{assert.equal(url,'https://www.nhc.noaa.gov/index-ep.xml');return page(xml);};
  const out=await collectOfficialEvidence(hurricane,{now,get});
  assert.deepEqual(out.rows.map(r=>[r.url,r.excerpt,r.published_at]),[['https://www.nhc.noaa.gov/current','Known facts & conditions.','2026-11-06T23:58:00.000Z']]);
  assert.throws(()=>parseHurricaneFeed(xml,{code:'at'},now),/Unexpected NHC basin/);
  assert.throws(()=>parseHurricaneFeed('<!DOCTYPE rss>'+xml,{code:'ep'},now),/Unrecognized NHC RSS/);
  assert.equal((await collectOfficialEvidence({...hurricane,rules_primary:hurricane.rules_primary.replace('Eastern Pacific','Pacific')},{now,get})).status,'not_applicable');
});

test('discussion fallback uses an exact named technical query and keeps weak or private metadata out',async()=>{
  const sample={title:'OpenAI releases a model',created_at:'2026-11-06T10:00:00Z',points:9,num_comments:3,author:'not exposed',url:'https://third-party.example'};
  const get=async(name,href)=>{
    const url=new URL(href);
    assert.equal(url.origin,'https://hn.algolia.com');
    assert.equal(url.searchParams.get('query'),'OpenAI');
    assert.equal(url.searchParams.get('tags'),'story');
    return {as_of:asOf,data:{hits:[
      {...sample,objectID:'12'},{...sample,objectID:'12'},{...sample,objectID:'34',num_comments:1},
      {...sample,objectID:'56',title:'OpenAIspaper releases a model'},{...sample,objectID:'78',title:'OpenAI and online forums'},
      {...sample,objectID:'90',created_at:'2026-10-01T10:00:00Z'},
      {...sample,objectID:'92',title:'OpenAI seems to be silently re-enabling model training on Codex chats'},
      {...sample,objectID:'94'}
    ]}};
  };
  const out=await collectCommunityContext(tech,{now,get});
  assert.equal(out.status,'available');
  assert.equal(out.rows.length,1);
  assert.equal(out.rows[0].platform,'hacker_news');
  assert.equal(out.rows[0].url,'https://news.ycombinator.com/item?id=12');
  assert.equal(Object.hasOwn(out.rows[0],'author'),false);
  assert.equal((await collectCommunityContext({...tech,ticker:'KXNFLGAME-26NOV08ARISEA-ARI'},{now,get})).status,'not_applicable');
  assert.equal((await collectCommunityContext({...tech,custom_strike:{Organization:'Other'}},{now,get})).status,'not_applicable');
});

test('exact contract evidence exposes public checks and opted-in technology discussion separately',async()=>{
  let officialCalls=0,communityCalls=0;
  const official={title:'The scheduled FOMC decision',excerpt:'Official date',url:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',publisher:'Federal Reserve',
    platform:'official_observation',retrieved_at:asOf};
  const community={title:'OpenAI releases a model',excerpt:'9 points',url:'https://news.ycombinator.com/item?id=12',platform:'hacker_news',retrieved_at:asOf};
  const dependencies={
    now:()=>now,
    fetchContractHeadlines:async()=>({status:'empty',articles:[]}),
    sportsNews:async()=>({status:'not_applicable',articles:[]}),
    redditEvidence:async()=>({status:'not_configured',posts:[]}),
    collectOfficialEvidence:async market=>{officialCalls++;return market===fed?{name:'Federal Reserve',status:'available',rows:[official]}:{status:'not_applicable',rows:[]};},
    collectCommunityContext:async()=>{communityCalls++;return {name:'Hacker News',status:'available',rows:[community]};}
  };
  const options={enabled:true,headlineMode:'full'};
  const fedEvidence=await contractEvidence(fed,{...options,selectedTicker:fed.ticker},dependencies);
  assert.deepEqual(fedEvidence.official_observations,[official]);
  assert.equal(fedEvidence.experimental_sensitivity.probability_adjustment,null);
  assert.equal(fedEvidence.items.length,0);
  assert.equal(publicEvidenceChunks(fed,fedEvidence,{now}).find(row=>row.source_kind==='official_observation').published_at,null);
  assert.equal(communityCalls,0);
  const techEvidence=await contractEvidence(tech,{...options,selectedTicker:tech.ticker,redditEnabled:true},dependencies);
  assert.deepEqual(techEvidence.community_items,[community]);
  assert.equal(techEvidence.feeds.find(row=>row.kind==='reddit').status,'not_configured');
  assert.equal(techEvidence.feeds.find(row=>row.kind==='hacker_news').status,'available');
  assert.ok(publicEvidenceChunks(tech,{...techEvidence,items:[community]},{now}).every(row=>row.source_url!==community.url));
  assert.equal(communityCalls,1);
  await contractEvidence(tech,{...options,selectedTicker:tech.ticker,redditEnabled:true}, {...dependencies,redditEvidence:async()=>({status:'available',posts:[]})});
  assert.equal(communityCalls,1);
  const unmapped=await contractEvidence(tech,{...options,selectedTicker:tech.ticker,redditEnabled:true}, {...dependencies,redditEvidence:async()=>({status:'not_applicable',posts:[]})});
  assert.deepEqual(unmapped.community_items,[community]);
  assert.equal(communityCalls,2);
  await contractEvidence(tech,{...options,headlineMode:'official',news:{provider:'fixture'},selectedTicker:tech.ticker},dependencies);
  assert.equal(officialCalls,4);
});
