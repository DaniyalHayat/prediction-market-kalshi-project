import assert from 'node:assert/strict';
import test from 'node:test';
import {sportsNews} from '../lib/workspace/evidence.mjs';
import {rankEvidence} from '../lib/workspace/source-ranking.mjs';

test('NBA and soccer news use both exact source team IDs while preserving bounded independent requests',async()=>{
  for(const [topic,path] of [['nba','basketball/nba'],['epl','soccer/eng.1']]){
    const calls=[];
    const result=await sportsNews(topic,{sports:{teams:[{id:'367',name:'A'},{id:'357',name:'B'}]},get:async(_name,url,options)=>{
      calls.push(url);assert.equal(options.maximumBytes,300000);assert.equal(options.timeoutMs,4500);
      assert.equal(new URL(url).pathname,'/apis/site/v2/sports/'+path+'/news');
      if(new URL(url).searchParams.get('team')==='357')throw new Error('Fixture source outage');
      return {data:{articles:[{id:'1',headline:'A confirmed lineup update',description:'Independent report.',published:'2026-11-07T10:00:00Z',links:{web:{href:'https://www.espn.com/story/_/id/1'}}}]},as_of:'2026-11-07T11:00:00Z'};
    }});
    assert.deepEqual(calls.map(url=>new URL(url).searchParams.get('team')),['357','367']);
    assert.equal(result.status,'partial');assert.equal(result.articles.length,1);
  }
});

test('verified catalog aliases retain current team updates while unrelated, stale and promotional stories remain excluded',()=>{
  const now=Date.parse('2026-11-07T12:00:00Z');
  const market={ticker:'KXEPLGAME-26NOV07LEETOT-TOT',title:'Tottenham wins',yes_sub_title:'Tottenham'};
  const sports={teams:[{name:'Tottenham Hotspur',aliases:['tottenham hotspur','spurs','tottenham']},{name:'Leeds United',aliases:['leeds united','leeds']}],
    event:{played_at:'2026-11-07T14:00:00Z'}};
  const row={platform:'publisher_metadata',publisher:'ESPN',as_of:'2026-11-07T11:00:00Z'};
  const ranked=rankEvidence([
    {...row,title:'Tottenham coach confirms starting lineup before Leeds United match',url:'https://www.espn.com/soccer/story/1'},
    {...row,title:'Tottenham player ruled out for the match',url:'https://www.espn.com/soccer/story/2'},
    {...row,title:'Manchester United confirms its starting lineup',url:'https://www.espn.com/soccer/story/3'},
    {...row,title:'Tottenham confirmed lineup last year',as_of:'2025-11-07T11:00:00Z',url:'https://www.espn.com/soccer/story/4'},
    {...row,title:'Tottenham free bets promo code',url:'https://www.espn.com/soccer/story/5'}
  ],market,{sports,now});
  assert.equal(ranked.length,2);
  assert.equal(ranked[0].match_scope,'matched');
  assert.ok(ranked.every(item=>item.matched_entities.includes('Tottenham Hotspur')));
});
