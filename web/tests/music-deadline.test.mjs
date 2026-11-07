import test from 'node:test';
import assert from 'node:assert/strict';
import {appleChart,musicResearch} from '../lib/workspace/music.mjs';
import {sourceJSON} from '../lib/workspace/providers.mjs';

const market={title:'Apple Music top song',custom_strike:{Song:'Unmatched fixture song'}};
const publish=async()=>({persisted:true});

test('a healthy Apple chart remains dated, parsed and available to the music report',async()=>{
  const data={feed:{country:'us',updated:new Date().toISOString(),results:[{id:'123',name:'Fixture song',artistName:'Fixture artist',artistId:'456',url:'https://music.apple.com/us/song/123'}]}};
  const get=(id,url,options)=>sourceJSON(id+' healthy fixture',url,{...options,fetcher:async()=>Response.json(data)});
  const result=await musicResearch(market,{includeSpotify:false,includeAlternatives:false,getAppleChart:()=>appleChart({get,publish})});
  assert.equal(result.diagnostics.apple.status,'available');
  assert.equal(result.apple.tracks[0].rank,1);
  assert.equal(result.apple.tracks[0].id,'123');
  assert.match(result.apple.measurement_date,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.apple.persistence.persisted,true);
});

test('a stalled optional Apple response is aborted within the interactive budget and stays explicitly unavailable',async()=>{
  let signal;
  const get=(id,url,options)=>sourceJSON(id+' stalled fixture',url,{...options,fetcher:async(_url,request)=>{
    signal=request.signal;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const keepalive=setTimeout(()=>{},9000),start=performance.now();
  try{
    const result=await musicResearch(market,{includeSpotify:false,includeAlternatives:false,getAppleChart:()=>appleChart({get,publish})});
    const elapsed=performance.now()-start;
    assert.ok(signal.aborted);
    assert.ok(elapsed>=3500&&elapsed<8000,'A stalled chart must finish well before the former16-second wait');
    assert.equal(result.diagnostics.apple.status,'unavailable');
    assert.match(result.apple.error,/could not be retrieved|unavailable/i);
    assert.deepEqual(result.apple.tracks,[]);
    assert.equal(result.forecast.probability,null);
    assert.equal(result.spotify.status,'not_queried');
  }finally{clearTimeout(keepalive);}
});
