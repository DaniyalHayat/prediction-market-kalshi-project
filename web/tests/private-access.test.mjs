import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {SHARE_COOKIE,SHARE_COOKIE_SECONDS,redeemShareAccess,logoutShareAccess,shareCookieAuthorized,privateAccessResponse,publicAccessPath} from '../lib/private-access.mjs';
import {proxyBackend} from '../lib/workspace/proxy.mjs';
import {assistantResponse} from '../lib/workspace/assistant.mjs';
import {createMarketServer} from '../cloud/server.mjs';

const token=randomBytes(32).toString('base64url'),now=Date.parse('2026-11-07T12:00:00Z');
const env={PREDICTIR_SHARE_ACCESS:'1',PREDICTIR_SHARE_TOKEN_HASH:createHash('sha256').update(token).digest('hex'),MARKET_EDGE_SECRET:'fixture-edge-key-'.repeat(4)};
function request(value=token,{origin='https://predictir.dev',ip='192.0.2.10',url='https://predictir.dev/api/access/redeem'}={}){
  return new Request(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':ip},body:JSON.stringify({token:value})});
}
async function cookie(ip='192.0.2.11'){const response=await redeemShareAccess(request(token,{ip}),{env,now});assert.equal(response.status,204);return response.headers.get('set-cookie').split(';',1)[0];}
function environment(t){t.mock.method(Date,'now',()=>now);const keys=['PREDICTIR_SHARE_ACCESS','PREDICTIR_SHARE_TOKEN_HASH','MARKET_EDGE_SECRET','MARKET_BACKEND_URL'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,env);process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';t.after(()=>{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];});}

test('a fragment-delivered capability exchanges for a bounded HttpOnly cookie without reflecting the token',async()=>{
  const response=await redeemShareAccess(request(),{env,now}),set=response.headers.get('set-cookie');
  assert.equal(response.status,204);assert.equal(await response.text(),'');assert.ok(!set.includes(token));
  for(const attribute of ['Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age='+SHARE_COOKIE_SECONDS])assert.ok(set.includes(attribute));
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('x-robots-tag'),/noindex/);
  assert.equal(shareCookieAuthorized(set,env,now+1000),true);
});

test('tampering, duplicate cookies, expiry, verifier rotation and signing-key rotation revoke access',async()=>{
  const value=await cookie();
  assert.equal(shareCookieAuthorized(value+'x',env,now),false);
  assert.equal(shareCookieAuthorized(value+'; '+value,env,now),false);
  assert.equal(shareCookieAuthorized(value,env,now+SHARE_COOKIE_SECONDS*1000),false);
  assert.equal(shareCookieAuthorized(value,{...env,PREDICTIR_SHARE_TOKEN_HASH:'a'.repeat(64)},now),false);
  assert.equal(shareCookieAuthorized(value,{...env,MARKET_EDGE_SECRET:'replacement-fixture-key-'.repeat(3)},now),false);
  assert.equal(privateAccessResponse(new Request('https://predictir.dev/api/session'),env,now).status,401);
});

test('missing configuration fails closed and redemption rejects CSRF, query-token delivery and oversized bodies',async()=>{
  assert.equal((await redeemShareAccess(request(),{env:{PREDICTIR_SHARE_ACCESS:'1'},now})).status,503);
  assert.equal(shareCookieAuthorized('',{PREDICTIR_SHARE_ACCESS:'1'},now),false);
  assert.equal((await redeemShareAccess(request(token,{origin:'https://other.invalid'}),{env,now})).status,403);
  assert.equal((await redeemShareAccess(request(token,{url:'https://predictir.dev/api/access/redeem?token=forbidden'}),{env,now})).status,403);
  const bad=await redeemShareAccess(request('wrong',{ip:'192.0.2.12'}),{env,now});assert.equal(bad.status,401);assert.ok(!(await bad.text()).includes('wrong'));
  const large=await redeemShareAccess(request('x'.repeat(300),{ip:'192.0.2.13'}),{env,now});assert.equal(large.status,413);
});

test('redemption is rate limited and logout removes only the share cookie',async()=>{
  const statuses=[];for(let i=0;i<11;i++)statuses.push((await redeemShareAccess(request('wrong',{ip:'192.0.2.14'}),{env,now})).status);
  assert.equal(statuses.filter(value=>value===401).length,10);assert.equal(statuses.at(-1),429);
  const response=await logoutShareAccess(new Request('https://predictir.dev/api/access/logout',{method:'POST',headers:{Origin:'https://predictir.dev'}}),{env});
  assert.equal(response.status,204);assert.match(response.headers.get('set-cookie'),new RegExp('^'+SHARE_COOKIE+'=;'));assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await logoutShareAccess(new Request('https://predictir.dev/api/access/logout'),{env})).status,405);
});

test('frontend API and assistant access checks run before upstream requests or model usage',async t=>{
  environment(t);let calls=0;
  const denied=await proxyBackend(new Request('https://predictir.dev/api/workspace/catalog'),['workspace','catalog'],{fetcher:async()=>{calls++;return Response.json({})}});
  assert.equal(denied.status,401);assert.equal(calls,0);
  const answer=await assistantResponse(new Request('https://predictir.dev/api/assistant',{method:'POST',body:'{}'}),{createClient:async()=>{calls++;throw Error('must not run')}});
  assert.equal(answer.status,401);assert.equal(calls,0);
  const value=await cookie('192.0.2.15');
  const allowed=await proxyBackend(new Request('https://predictir.dev/api/workspace/catalog',{headers:{Cookie:value+'; owner_cookie=private'}}),['workspace','catalog'],{
    fetcher:async(_url,options)=>{calls++;assert.equal(new Headers(options.headers).get('cookie'),value);return Response.json({ok:true});}});
  assert.equal(allowed.status,200);assert.equal(calls,1);
});

test('backend direct entry, API and forged edge claims are blocked while readiness and authenticated forwarding work',async t=>{
  const value=await cookie('192.0.2.16'),server=createMarketServer({production:true,edgeSecret:env.MARKET_EDGE_SECRET,serviceSecret:'fixture-service-key-'.repeat(4),shareAccess:true,shareTokenHash:env.PREDICTIR_SHARE_TOKEN_HASH,now:()=>now,storageEnabled:()=>false,logger:()=>{},getRoute:async()=>Response.json({ok:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const path of ['/','/lab.html','/api/health','/api/workspace/catalog'])assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers:{'x-market-edge-secret':env.MARKET_EDGE_SECRET}})).status,401);
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers:{Cookie:value}})).status,401);
  const health=await fetch(base+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});
  const allowed=await fetch(base+'/api/workspace/catalog',{headers:{Cookie:value,'x-market-edge-secret':env.MARKET_EDGE_SECRET,'x-market-country':'US'}});assert.equal(allowed.status,200);
  assert.match(allowed.headers.get('x-robots-tag'),/noindex/);
});

test('public paths are limited to bootstrap, static framework assets, readiness and exact ownership files',()=>{
  for(const path of ['/access','/api/access/redeem','/healthz','/google7653305cfae6f81b.html','/hibp-verification.txt','/_next/static/a.js'])assert.equal(publicAccessPath(path),true,path);
  for(const path of ['/','/api/session','/lab.html','/research/research-audit.pdf','/_next/image','/access/other','/hibp-verification.txt/other'])assert.equal(publicAccessPath(path),false,path);
});
