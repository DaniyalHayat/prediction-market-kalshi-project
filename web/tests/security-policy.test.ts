import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {proxy,config} from '../proxy';
import {contentSecurityPolicy} from '../lib/security-policy.mjs';
import {createHash} from 'node:crypto';
import {redeemShareAccess} from '../lib/private-access.mjs';

test('page policies use different request nonces and forward matching CSP for framework hydration',()=>{
  const first=proxy(new NextRequest('https://predictir.dev/'));
  const second=proxy(new NextRequest('https://predictir.dev/'));
  const policy=first.headers.get('content-security-policy')!;
  const nonce=first.headers.get('x-middleware-request-x-nonce')!;
  assert.match(nonce,/^[A-Za-z0-9+/]{24}$/);
  assert.ok(policy.includes("'nonce-"+nonce+"'"));
  assert.equal(first.headers.get('x-middleware-request-content-security-policy'),policy);
  assert.notEqual(second.headers.get('x-middleware-request-x-nonce'),nonce);
  assert.equal(first.headers.get('cache-control'),'private, no-store');
  const scripts=policy.split('; ').find(value=>value.startsWith('script-src '))!;
  if(process.env.NODE_ENV!=='development')assert.ok(!scripts.includes("'unsafe-inline'"));
  assert.match(policy,/script-src-attr 'none'/);
});

test('private HTML, PDFs and APIs stay inside access matching while compiled assets stay outside',()=>{
  const pattern=new RegExp('^'+config.matcher[0]+'$');
  assert.ok(pattern.test('/'));
  assert.ok(pattern.test('/account'));
  for(const path of ['/google7653305cfae6f81b.html','/lab.html','/research/research-audit.pdf','/api/health'])assert.equal(pattern.test(path),true,path);
  for(const path of ['/_next/static/chunks/app.js','/favicon.svg'])assert.equal(pattern.test(path),false,path);
  const staticPolicy=contentSecurityPolicy();
  assert.ok(!staticPolicy.includes("'nonce-"));
  assert.match(staticPolicy,/script-src 'self' https:\/\/www.googletagmanager.com/);
});

test('private entry protects HTML, PDFs and data while a redeemed cookie preserves application hydration',async t=>{
  const keys=['PREDICTIR_SHARE_ACCESS','PREDICTIR_SHARE_TOKEN_HASH','MARKET_EDGE_SECRET'],previous=keys.map(key=>process.env[key]);
  const token='private-fixture-token-'.repeat(3);
  Object.assign(process.env,{PREDICTIR_SHARE_ACCESS:'1',PREDICTIR_SHARE_TOKEN_HASH:createHash('sha256').update(token).digest('hex'),MARKET_EDGE_SECRET:'private-fixture-signing-key-'.repeat(3)});
  t.after(()=>keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}));
  for(const path of ['/','/lab.html','/research/research-audit.pdf']){
    const response=proxy(new NextRequest('https://predictir.dev'+path));
    assert.equal(response.status,307);assert.equal(response.headers.get('location'),'https://predictir.dev/access');
    assert.match(response.headers.get('x-robots-tag')!,/noindex/);assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  }
  assert.equal(proxy(new NextRequest('https://predictir.dev/api/session')).status,401);
  for(const path of ['/access','/healthz','/hibp-verification.txt','/google7653305cfae6f81b.html'])assert.equal(proxy(new NextRequest('https://predictir.dev'+path)).headers.get('x-middleware-next'),'1');
  const redeemed=await redeemShareAccess(new Request('https://predictir.dev/api/access/redeem',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json','X-Forwarded-For':'192.0.2.200'},body:JSON.stringify({token})}));
  assert.equal(redeemed.status,204);
  const authorized=proxy(new NextRequest('https://predictir.dev/',{headers:{Cookie:redeemed.headers.get('set-cookie')!.split(';',1)[0]}}));
  assert.equal(authorized.headers.get('x-middleware-next'),'1');assert.ok(authorized.headers.get('x-middleware-request-x-nonce'));
});
