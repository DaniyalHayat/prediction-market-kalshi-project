import assert from 'node:assert/strict';
import test from 'node:test';
import {assistantContext,assistantPayload} from '../ui/assistant-context.mjs';
import {readNews} from '../ui/news-reading.mjs';
import {EXECUTION_DEFAULTS} from '../ui/execution-state.mjs';

test('Ask why submits the selected panel and model without copying the displayed recommendation',()=>{
  for(const panel of ['analysis','history','rules','sources','evidence','paper']){
    const launch=assistantContext(panel,'KX-A',{detail:'full',result:undefined,verdict:'Invented verdict'});
    const messages=[{role:'user',content:launch.question}];
    const payload=assistantPayload('KX-A','challenger',messages,launch);
    assert.deepEqual(payload,{ticker:'KX-A',model:'challenger',panel,detail:'full',messages});
    assert.match(launch.question,/KX-A/);
    assert.doesNotMatch(launch.question,/Invented verdict/);
  }
});

test('the execution question uses the submitted controls and rejects results from another contract',()=>{
  const result={ticker:'KX-A',controls:{...EXECUTION_DEFAULTS,action:'sell',side:'no',contracts:7,horizon_seconds:600},book_as_of:'2026-11-05T12:00:00Z'};
  assert.equal(assistantContext('execution','KX-B',{result}),null);
  const launch=assistantContext('execution','KX-A',{detail:'full',result});
  assert.match(launch.question,/sell NO, 7 contracts over 600 seconds/);
  assert.match(launch.question,/2026-11-05T12:00:00.000Z/);
  assert.deepEqual(assistantPayload('KX-A','validated',[],launch).execution_controls,result.controls);
});

test('news reading respects reporting scope, deduplicates tracked URLs and syndicated headlines, and excludes disabled feeds',()=>{
  const story=(title,url,publisher,platform)=>({title,url,publisher,platform});
  const lead=story('Star confirmed to start','https://league.example/report?fixture=7','League');
  const second=story('Coach confirms rotation','https://sports.example/coach','Sports');
  const related=story('Travel delays reported','https://town.example/travel','Town news');
  const social=story('Travel delays reported','https://reddit.com/r/team/post','Community','reddit');
  const data={items:[lead,story('Tracked copy','https://www.league.example/report?utm_source=app&fixture=7#entry','Mirror'),second,social],
    related_items:[story('Star confirmed to start!','https://mirror.example/report','Mirror'),related],
    news_sections:[{heading:'What changed',text:'Duplicated lead'},{heading:'Settlement check',text:'Check the exact fixture.'}]};
  const result=readNews(data,[second,story('Unranked report','https://local.example/story','Local'),story('Unsafe link','javascript:alert(1)','Unsafe')],{reddit:true});
  assert.deepEqual(result.matched.map(row=>row.title),[lead.title,second.title]);
  assert.equal(result.second.title,second.title);
  assert.deepEqual(result.related.map(row=>row.title),[related.title]);
  assert.deepEqual(result.social,[]);
  assert.equal(result.headlines.length,1);
  assert.deepEqual(result.sections.map(row=>row.heading),['Settlement check']);
  const socialOnly={items:[story('Roster speculation','https://reddit.com/r/team/post','Community','reddit')]};
  assert.equal(readNews(socialOnly).social.length,0);
  assert.equal(readNews(socialOnly,[],{reddit:true}).social.length,1);
});
