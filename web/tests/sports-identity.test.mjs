import assert from 'node:assert/strict';
import test from 'node:test';
import {matchGame} from '../lib/workspace/sports.mjs';

const team=(id,name,code,aliases)=>({id,name,code,aliases});
const catalog=(league,teams,date,home,away)=>({league,teams,games:[],scheduled:[{id:'game',played_at:date,home_id:home,away_id:away}]});

test('catalog team codes resolve abbreviated exchange labels across a complete dated matchup',()=>{
  const epl=catalog('epl',[
    team('357','Leeds United','LEE',['leeds united','leeds']),
    team('367','Tottenham Hotspur','TOT',['tottenham hotspur','spurs','tot']),
    team('363','Chelsea','CHE',['chelsea','blues'])
  ],'2026-11-07T12:30:00Z','357','367');
  const market={ticker:'KXEPLGAME-26NOV07LEETOT-TOT',yes_sub_title:'Tottenham',title:'Tottenham wins',
    rules_primary:'If Tottenham wins the Leeds United vs Tottenham professional EPL soccer game originally scheduled for Nov 7, 2026, the market resolves to Yes.'};
  assert.equal(matchGame(market,epl).side,'away');
  assert.match(matchGame({...market,yes_sub_title:'Chelsea'},epl).reason,/YES outcome/);
  assert.match(matchGame({...market,ticker:'KXEPLGAME-26NOV08LEETOT-TOT'},epl).reason,/scheduled-date/);
  assert.equal(matchGame({...market,ticker:'KXEPLGAME-26NOV07LEETOT-TIE',yes_sub_title:'Tie'},epl).side,'draw');
});

test('source abbreviations and exchange aliases match all teams without confusing shared cities',()=>{
  const nba=catalog('nba',[
    team('12','LA Clippers','LAC',['la clippers','clippers','la','lac']),
    team('13','Los Angeles Lakers','LAL',['los angeles lakers','lakers','los angeles','lal']),
    team('21','Phoenix Suns','PHX',['phoenix suns','suns','phoenix','phx'])
  ],'2026-11-11T02:00:00Z','21','12');
  const market={ticker:'KXNBAGAME-26NOV10LACPHX-LAC',yes_sub_title:'Los Angeles C',title:'Los Angeles C wins',rules_primary:'Los Angeles C vs Phoenix'};
  assert.equal(matchGame(market,nba).side,'away');
  assert.equal(matchGame({...market,ticker:'KXNBAGAME-26NOV10LACPHX-PHX',yes_sub_title:'Phoenix'},nba).side,'home');
  assert.match(matchGame({...market,yes_sub_title:'Lakers'},nba).reason,/YES outcome/);
  const derby={...nba,scheduled:[{id:'derby',played_at:'2026-11-11T02:00:00Z',home_id:'13',away_id:'12'}]};
  assert.match(matchGame({...market,ticker:'KXNBAGAME-26NOV10LACLAL-LAL',yes_sub_title:'Los Angeles'},derby).reason,/YES outcome/);
});

test('known provider abbreviation variants resolve paired participants and outcome identity',()=>{
  for(const [league,source,exchange,name,label] of [
    ['nba','NO','NOP','New Orleans Pelicans','New Orleans'],
    ['nba','GS','GSW','Golden State Warriors','Golden State'],
    ['epl','BHA','BRI','Brighton & Hove Albion','Brighton'],
    ['epl','MNC','MCI','Manchester City','Manchester City']
  ]){
    const data=catalog(league,[team('a',name,source,[name.toLowerCase(),label.toLowerCase()]),team('b','Opponent City','OPP',['opponent city'])],
      '2026-11-07T15:00:00Z','a','b');
    const prefix=league==='nba'?'KXNBAGAME':'KXEPLGAME';
    assert.equal(matchGame({ticker:prefix+'-26NOV07'+exchange+'OPP-'+exchange,yes_sub_title:label},data).side,'home');
  }
});
