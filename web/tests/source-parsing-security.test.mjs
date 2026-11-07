import test from 'node:test';
import assert from 'node:assert/strict';
import {constants,promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {htmlText} from '../lib/runtime/html-text.mjs';
import {readBoundedTextFile} from '../lib/runtime/bounded-file.mjs';
import {forecastSourceAllowed} from '../lib/workspace/forecast-source-policy.mjs';
import {parseTsa} from '../lib/intelligence/sources.mjs';
import {parseKworbUS} from '../lib/workspace/music-alternatives.mjs';
import {publicResearch} from '../lib/workspace/mcp.mjs';

test('HTML metadata is parsed once, excludes executable containers and preserves literal encoded text',()=>{
  assert.equal(htmlText('<div title="x > y">Good <b>report</b></div><script>BAD</script><style>BAD</style><p>Next&nbsp;item</p>'),'Good report Next item');
  assert.equal(htmlText('&amp;lt;img src=x onerror=BAD&amp;gt;'),'&lt;img src=x onerror=BAD&gt;');
  assert.equal(htmlText('&#x1F3B5; &copy; &#39; &#x110000;'),'🎵 © \' �');
  assert.equal(htmlText('1 < 2 and 3 > 2'),'1 < 2 and 3 > 2');
  assert.equal(htmlText('<p>A</p>B'),'A B');
  assert.equal(htmlText('x'.repeat(100),12).length,12);
  assert.equal(htmlText('<!-- BAD --><noscript>BAD</noscript>visible'),'visible');
  assert.throws(()=>htmlText('&'.repeat(1_000_001)),/limit/);
});

test('TSA table parsing handles browser-valid omitted cells and quoted angle brackets',()=>{
  const html='<table><tr><td title="a > b">11/1/2026<td>2,345,678<tr><td>11/2/2026<td><b>2,456,789</b></table>';
  assert.deepEqual(parseTsa(html,Date.parse('2026-11-03')),[{date:'2026-11-01',value:2345678},{date:'2026-11-02',value:2456789}]);
});

test('secondary chart uses parsed cells, preserves one entity-decoding pass and existing coverage checks',()=>{
  const rows=Array.from({length:50},(_,i)=>'<tr><td>'+(i+1)+'</td><td>=</td><td><a href="../artist/a.html">Artist &amp;lt;b&amp;gt;</a> - <a title="x > y" href="../track/'+String(i).padStart(22,'0')+'.html">Song &#x1F3B5; '+i+'</a></td>'+Array.from({length:8},(_,n)=>'<td>'+(n===3?'1,234':'1')+'</td>').join('')+'</tr>').join('');
  const html='Spotify Daily Chart - United States - 2026/11/03<table id="spotifydaily"><tr><th>Streams</th></tr>'+rows+'</table>';
  const result=parseKworbUS(html,Date.parse('2026-11-04'));
  assert.equal(result.tracks.length,50);
  assert.equal(result.tracks[0].artist,'Artist &lt;b&gt;');
  assert.equal(result.tracks[0].name,'Song 🎵 0');
  assert.equal(result.tracks[0].streams,1234);
});

test('research source policy parses host identity and rejects Spotify API variants and invalid URLs',()=>{
  for(const url of ['https://API.SPOTIFY.COM/v1/artists/a','https://api.spotify.com./v1/a','https://user:pass@example.org/a','javascript:alert(1)','not a URL',undefined])assert.equal(forecastSourceAllowed(url),false);
  const allowed='https://news.example.org/?q=api.spotify.com';
  assert.equal(forecastSourceAllowed(allowed),true);
  assert.deepEqual(publicResearch({sources:[{url:'https://API.SPOTIFY.COM/v1/a'},{url:allowed}]}).sources,[{url:allowed}]);
});

test('bounded file reads enforce byte limits and close their descriptor',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'predictir-file-bound-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const path=join(dir,'snapshot.json');
  await fs.writeFile(path,'éé');
  assert.equal(await readBoundedTextFile(path,4),'éé');
  await assert.rejects(readBoundedTextFile(path,3),error=>error.code==='FILE_TOO_LARGE'&&error.status===503);
  await fs.rename(path,path+'.moved');
  assert.equal(await readBoundedTextFile(path+'.moved',4),'éé');
  await assert.rejects(readBoundedTextFile(dir,20));
});

test('path replacement after opening cannot switch the inspected descriptor to a larger file',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'predictir-file-race-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const path=join(dir,'snapshot.json');
  await fs.writeFile(path,'safe');
  const original=fs.open.bind(fs);let closed=false;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await original(...args),close=handle.close.bind(handle);
    handle.close=async()=>{closed=true;return close();};
    await fs.rename(path,path+'.old');
    await fs.writeFile(path,'x'.repeat(100000));
    return handle;
  });
  assert.equal(await readBoundedTextFile(path,4),'safe');
  assert.equal(closed,true);
});

test('growth after descriptor inspection remains bounded by the read loop',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'predictir-file-growth-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const path=join(dir,'snapshot.json');
  await fs.writeFile(path,'safe');
  const original=fs.open.bind(fs);let readBytes=0,closed=false;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await original(...args),stat=handle.stat.bind(handle),read=handle.read.bind(handle),close=handle.close.bind(handle);
    handle.stat=async()=>{const info=await stat();await fs.appendFile(path,'x'.repeat(100000));return info;};
    handle.read=async(...input)=>{const result=await read(...input);readBytes+=result.bytesRead;return result;};
    handle.close=async()=>{closed=true;return close();};
    return handle;
  });
  await assert.rejects(readBoundedTextFile(path,4),error=>error.code==='FILE_TOO_LARGE');
  assert.equal(readBytes,5);
  assert.equal(closed,true);
});

test('symbolic links cannot redirect local inspection on platforms with O_NOFOLLOW',async t=>{
  if(!constants.O_NOFOLLOW)return t.skip('This platform does not expose O_NOFOLLOW');
  const dir=await fs.mkdtemp(join(tmpdir(),'predictir-file-link-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(join(dir,'target'),'secret');
  await fs.symlink(join(dir,'target'),join(dir,'link'));
  await assert.rejects(readBoundedTextFile(join(dir,'link'),10),error=>error.code==='ELOOP');
});
