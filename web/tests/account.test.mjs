import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {makeAccountHandler,sealSession,openSession,guestSession,validatePortfolio} from '../lib/workspace/account.mjs';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';
import {setupOwner} from '../tools/setup_owner.mjs';

const secret='fixture-private-session-'.repeat(3),ownerEmail='owner@example.test',ownerId='11111111-1111-4111-8111-111111111111',start=Date.UTC(2026,10,4),empty={version:1,positions:[],trades:[],starting_balance:10000,cash_movements:[]};
function fixture(options={}){
  const records=new Map(),calls={login:0,verify:0,refresh:0};let time=start;
  const user={id:ownerId,email:ownerEmail,email_confirmed_at:new Date(start).toISOString()},session={access_token:'fixture-access-private',refresh_token:'fixture-refresh-private',expires_at:start/1000+3600};
  const auth={auth:{signInWithPassword:async()=>{calls.login++;return {data:{user,session}};},getUser:async()=>{calls.verify++;return {data:{user}};},refreshSession:async()=>{calls.refresh++;return {data:{session:{...session,access_token:'refreshed-private',expires_at:time/1000+3600}}};}}};
  const storage={consume:async()=>true,get:async key=>records.get(key),save:async value=>{records.set(value.pk,value);},readOwnerPortfolio:async()=>({ledger:empty,watchlist:[],revision:1}),saveOwnerPortfolio:async(_id,input)=>({conflict:false,value:{...input,revision:input.revision+1}})};
  const handler=makeAccountHandler({storage,secret,ownerEmail,authFactory:()=>auth,configured:true,now:()=>time,secure:true,...options});
  const request=(path,{method='GET',body,cookie,headers={}}={})=>handler(new Request('https://predictir.dev/api/'+path,{method,headers:{Origin:'https://predictir.dev',...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),path);
  const login=()=>request('account/login',{method:'POST',body:{email:ownerEmail,password:'fixture-password-only'}});
  return {request,login,records,calls,auth,user,storage,setTime:value=>{time=value;}};
}
const cookie=response=>response.headers.getSetCookie().find(value=>value.startsWith('__Host-market_owner=')).split(';')[0];

test('encrypted cookie rejects tampering, purpose substitution, malformed base64 and expiry renewal',()=>{
  const value={id:randomUUID(),expires:start+1000},sealed=sealSession(value,secret,'owner');
  assert.deepEqual(openSession(sealed,secret,'owner'),value);assert.equal(openSession(sealed,secret,'guest'),null);
  assert.equal(openSession(sealed.slice(0,-4)+'AAAA',secret,'owner'),null);assert.equal(openSession(sealed+'=',secret,'owner'),null);
  const guest=guestSession(null,start);assert.equal(guestSession(guest,start+1000).id,guest.id);
  assert.notEqual(guestSession(guest,start+6*3600000).id,guest.id);assert.notEqual(guestSession({...guest,last:start+6000},start).id,guest.id);
});

test('guest response and owner login keep tokens private and use host-only HttpOnly secure cookies',async()=>{
  const f=fixture(),guest=await f.request('session'),guestData=await guest.json();assert.equal(guestData.signup_enabled,false);assert.equal(guestData.kind,'guest');
  assert.match(guest.headers.getSetCookie()[0],/^__Host-market_guest=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=21600; Secure$/);
  const signed=await f.login();assert.equal(signed.status,200);assert.match(cookie(signed),/^__Host-market_owner=/);
  assert.match(signed.headers.getSetCookie()[0],/HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);assert.equal(signed.headers.get('cache-control'),'no-store');
  assert.ok(!JSON.stringify(await signed.json()).includes('private'));assert.equal(f.records.size,1);
  assert.ok(!JSON.stringify([...f.records.values()]).includes('fixture-access'));
});

test('guest cookies stay stable when Supabase is configured but the owner account is not activated',async()=>{
  const f=fixture({ownerEmail:'',configured:true,authFactory:()=>{throw new Error('Guest access must not initialize owner authentication');}});
  const first=await f.request('session'),initial=await first.json();assert.equal(first.status,200);assert.equal(initial.kind,'guest');assert.equal(initial.login_configured,false);
  const retained=first.headers.getSetCookie().find(value=>value.startsWith('__Host-market_guest=')).split(';')[0];
  f.setTime(start+1000);const next=await f.request('session',{cookie:retained}),value=await next.json();assert.equal(next.status,200);assert.equal(value.kind,'guest');assert.equal(value.guest.id,initial.guest.id);assert.equal(value.guest.expires_at,initial.guest.expires_at);
  assert.equal((await f.request('account/profile')).status,503);
});

test('owner allowlist, cross-site and missing-origin writes fail before provider authentication',async()=>{
  const f=fixture();
  assert.equal((await f.request('account/login',{method:'POST',body:{email:'other@example.test',password:'valid-fixture-password'}})).status,401);
  assert.equal((await f.request('account/login',{method:'POST',body:{email:ownerEmail,password:'valid-fixture-password'},headers:{Origin:'https://attacker.test'}})).status,403);
  assert.equal((await f.request('account/login',{method:'POST',body:{email:ownerEmail,password:'valid-fixture-password'},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const absent=new Request('https://predictir.dev/api/account/logout',{method:'POST'}),handler=makeAccountHandler({secret,configured:false,secure:true});
  assert.equal((await handler(absent,'account/logout')).status,403);assert.equal(f.calls.login,0);
  assert.equal((await f.request('account/signup',{method:'POST'})).status,404);assert.equal((await f.request('account/login')).status,405);
});

test('verified sessions refresh, revoke on logout and clear stale owner cookies without leaking provider errors',async()=>{
  const f=fixture(),signed=await f.login(),sessionCookie=cookie(signed);
  f.setTime(start+3590000);const refreshed=await f.request('session',{cookie:sessionCookie});assert.equal((await refreshed.json()).kind,'owner');assert.equal(f.calls.refresh,1);assert.equal(refreshed.headers.getSetCookie().length,2);
  const active=cookie(refreshed);assert.equal((await f.request('account/logout',{method:'POST',cookie:active})).status,200);
  assert.equal((await f.request('account/portfolio',{cookie:active})).status,401);
  const stale=await f.request('session',{cookie:active});assert.equal((await stale.json()).kind,'guest');assert.ok(stale.headers.getSetCookie().some(value=>value.startsWith('__Host-market_owner=;')&&value.includes('Max-Age=0')));
  const other=fixture();other.auth.auth.signInWithPassword=async()=>{throw new Error('PRIVATE_PROVIDER_DETAIL');};const failed=await other.login();assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('PRIVATE_PROVIDER_DETAIL'));
});

test('getUser outages preserve owner and guest cookies and recover without switching to a guest account',async()=>{
  for(const status of [429,500,503]){
    const f=fixture(),signed=await f.login(),active=cookie(signed),verify=f.auth.auth.getUser;
    f.auth.auth.getUser=async()=>({error:{status,message:'PRIVATE_UPSTREAM_ERROR'},data:{user:null}});
    const failure=await f.request('session',{cookie:active+'; __Host-market_guest=retained-guest'});
    assert.equal(failure.status,503);assert.equal(failure.headers.get('Retry-After'),status===429?'60':'15');assert.deepEqual(failure.headers.getSetCookie(),[]);
    const body=await failure.json();assert.equal(body.kind,undefined);assert.ok(!JSON.stringify(body).includes('PRIVATE_UPSTREAM'));
    f.auth.auth.getUser=verify;assert.equal((await (await f.request('session',{cookie:active})).json()).kind,'owner');
  }
  const f=fixture(),active=cookie(await f.login());f.auth.auth.getUser=async()=>{throw new Error('PRIVATE_NETWORK_ERROR');};
  const failure=await f.request('session',{cookie:active});assert.equal(failure.status,503);assert.equal(failure.headers.get('Retry-After'),'15');assert.deepEqual(failure.headers.getSetCookie(),[]);
});

test('refresh outages and incomplete results preserve sessions while actual invalid refresh tokens clear them',async()=>{
  for(const result of [{error:{status:429},data:{}},{error:{status:503},data:{}},{error:null,data:{session:{}}},null]){
    const f=fixture(),active=cookie(await f.login()),refresh=f.auth.auth.refreshSession;f.setTime(start+3590000);f.auth.auth.refreshSession=async()=>result;
    const failure=await f.request('session',{cookie:active});assert.equal(failure.status,503);assert.deepEqual(failure.headers.getSetCookie(),[]);assert.ok(failure.headers.get('Retry-After'));
    f.auth.auth.refreshSession=refresh;assert.equal((await (await f.request('session',{cookie:active})).json()).kind,'owner');
  }
  const network=fixture(),networkCookie=cookie(await network.login());network.setTime(start+3590000);network.auth.auth.refreshSession=async()=>{throw new Error('PRIVATE_REFRESH_NETWORK_ERROR');};
  const unavailable=await network.request('session',{cookie:networkCookie});assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('Retry-After'),'15');assert.deepEqual(unavailable.headers.getSetCookie(),[]);
  const f=fixture(),active=cookie(await f.login());f.setTime(start+3590000);f.auth.auth.refreshSession=async()=>({error:{status:400,code:'refresh_token_not_found'},data:{}});
  const invalid=await f.request('session',{cookie:active});assert.equal(invalid.status,200);assert.equal((await invalid.json()).kind,'guest');assert.ok(invalid.headers.getSetCookie().some(value=>value.startsWith('__Host-market_owner=;')&&value.includes('Max-Age=0')));
});

test('authorized portfolio writes reject fabricated finances before calling persistence',async()=>{
  const f=fixture(),active=cookie(await f.login());let writes=0;
  f.storage.saveOwnerPortfolio=async()=>{writes++;return {conflict:false,value:{}};};
  const ledger={version:1,starting_balance:100,positions:[{id:'p',ticker:'KXTEST-YES',side:'yes',original_quantity:1,remaining_quantity:1,entry_cost:-500,entry_fee:-1,remaining_basis:1,realized_pnl:1000000}],trades:[{id:'t',position_id:'p',ticker:'KXTEST-YES',side:'yes',action:'buy',filled:100,cash:-500,fee:-1}]};
  const rejected=await f.request('account/portfolio',{method:'PUT',cookie:active,body:{revision:0,watchlist:[],ledger}});
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/reconcile/);assert.equal(writes,0);
});

test('portfolio validation rejects dropped rows, duplicate identities and malformed saved contracts',()=>{
  assert.equal(validatePortfolio({ledger:empty,watchlist:['KXTEST-YES','KXTEST-YES'],revision:0}).watchlist.length,1);
  assert.throws(()=>validatePortfolio({ledger:{...empty,positions:[{id:'bad'}]},watchlist:[],revision:0}));
  assert.throws(()=>validatePortfolio({ledger:empty,watchlist:['https://secret.example'],revision:0}));
  assert.throws(()=>validatePortfolio({ledger:empty,watchlist:[],revision:-1}));
});

test('development guest writes accept loopback origins across local preview ports',async()=>{
  const handler=makeAccountHandler({secret,configured:false,secure:false});
  const request=new Request('http://localhost/api/account/logout',{method:'POST',headers:{Origin:'http://127.0.0.1:8768'}});
  const out=await handler(request,'account/logout');assert.equal(out.status,200);assert.match(out.headers.getSetCookie()[0],/^market_owner=;.*Max-Age=0$/);
});

test('owner setup preview has no external effects and fixture apply requests confirmed creation without mail',async()=>{
  let calls=0,received;
  const createAuthClient=()=>({auth:{admin:{createUser:async input=>{calls++;received=input;return {error:null};}}}});
  assert.equal((await setupOwner({email:ownerEmail,createAuthClient})).mode,'preview');assert.equal(calls,0);
  await assert.rejects(setupOwner({email:ownerEmail,password:'x'.repeat(201),url:'https://fixture.invalid',key:'fixture-key',apply:true,createAuthClient}),/12 through 200/);
  const result=await setupOwner({email:ownerEmail,password:'fixture-password',url:'https://fixture.invalid',key:'fixture-key',apply:true,createAuthClient});
  assert.equal(calls,1);assert.equal(received.email_confirm,true);assert.equal(result.email_sent,false);assert.ok(!JSON.stringify(result).includes('fixture-password'));
});

test('PostgreSQL owner portfolio CAS prevents lost updates and scopes records by verified user id',{skip:!process.env.MARKET_TEST_DATABASE_URL},async()=>{
  const connectionString=process.env.MARKET_TEST_DATABASE_URL;if(!new URL(connectionString).pathname.endsWith('_test'))throw new Error('Use a disposable _test database');
  const store=makePostgresStore({connectionString}),owner=randomUUID(),other=randomUUID();
  try{
    await applyTestSchema(store.db);await store.db.query(await readFile(new URL('../database/004_owner_portfolios.sql',import.meta.url),'utf8'));
    const initial=await Promise.all([1,2].map(amount=>store.saveOwnerPortfolio(owner,{ledger:{...empty,starting_balance:amount*10000},watchlist:[],revision:0})));
    assert.equal(initial.filter(row=>!row.conflict).length,1);assert.equal((await store.readOwnerPortfolio(owner)).revision,1);
    const outcomes=await Promise.all([1,2].map(amount=>store.saveOwnerPortfolio(owner,{ledger:{...empty,starting_balance:amount*20000},watchlist:['KXTEST-YES'],revision:1})));
    assert.equal(outcomes.filter(row=>!row.conflict).length,1);assert.equal((await store.readOwnerPortfolio(owner)).revision,2);
    assert.deepEqual(await store.readOwnerPortfolio(other),{ledger:null,watchlist:[],revision:0});
    const stale=await store.saveOwnerPortfolio(owner,{ledger:empty,watchlist:[],revision:1});assert.equal(stale.conflict,true);assert.equal(stale.value.revision,2);
    assert.equal((await store.saveOwnerPortfolio(other,{ledger:empty,watchlist:[],revision:2})).conflict,true);
    const f=fixture({storage:store});f.user.id=randomUUID();const active=cookie(await f.login());
    const authenticated=await Promise.all([1,2].map(amount=>f.request('account/portfolio',{method:'PUT',cookie:active,body:{revision:0,watchlist:[],owner_id:other,ledger:{...empty,starting_balance:amount*10000}}})));
    assert.deepEqual(authenticated.map(row=>row.status).sort(),[200,409]);assert.equal((await store.readOwnerPortfolio(f.user.id)).revision,1);assert.equal((await store.readOwnerPortfolio(other)).revision,0);
    const invalid=await f.request('account/portfolio',{method:'PUT',cookie:active,body:{revision:1,watchlist:[],ledger:{...empty,starting_balance:-1}}});assert.equal(invalid.status,400);assert.equal((await store.readOwnerPortfolio(f.user.id)).revision,1);
  }finally{await store.close();}
});
