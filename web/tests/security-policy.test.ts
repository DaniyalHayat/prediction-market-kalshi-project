import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {proxy,config} from '../proxy';
import {contentSecurityPolicy} from '../lib/security-policy.mjs';

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

test('static verification and scripts are outside page proxy matching',()=>{
  const pattern=new RegExp('^'+config.matcher[0]+'$');
  assert.ok(pattern.test('/'));
  assert.ok(pattern.test('/account'));
  for(const path of ['/google7653305cfae6f81b.html','/lab.html','/_next/static/chunks/app.js','/api/health','/favicon.svg'])assert.equal(pattern.test(path),false,path);
  const staticPolicy=contentSecurityPolicy();
  assert.ok(!staticPolicy.includes("'nonce-"));
  assert.match(staticPolicy,/script-src 'self' https:\/\/www.googletagmanager.com/);
});
