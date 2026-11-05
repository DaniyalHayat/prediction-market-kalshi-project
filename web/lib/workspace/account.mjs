import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {observeProviderAttempt} from '../runtime/telemetry.mjs';
import '../../public/dashboard/paper.js';
const SIX_HOURS=6*3600000,EIGHT_HOURS=8*3600000,SEVEN_DAYS=7*86400000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const ownerCookie='market_owner',guestCookie='market_guest';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function cookieValue(request,name){const value=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='));return value?.slice(name.length+1)||null;}
function secretKey(secret,purpose){if(typeof secret!=='string'||secret.length<32)throw fail('Private session configuration is pending.',503);return createHash('sha256').update(purpose+'\0'+secret).digest();}
export function sealSession(value,secret,purpose){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secretKey(secret,purpose),iv),body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
export function openSession(value,secret,purpose){try{if(typeof value!=='string'||value.length>8000||!/^[A-Za-z0-9_-]+$/.test(value))return null;const raw=Buffer.from(value,'base64url');if(raw.length<29||raw.toString('base64url')!==value)return null;const decipher=createDecipheriv('aes-256-gcm',secretKey(secret,purpose),raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));}catch{return null;}}
function setCookie(response,name,value,age,secure){response.headers.append('Set-Cookie',`${secure?'__Host-':''}${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(age))}${secure?'; Secure':''}`);}
export function guestSession(previous,now=Date.now()){
  const valid=previous&&uuid(previous.id)&&[previous.created,previous.last,previous.expires].every(Number.isSafeInteger)&&previous.created<=now+5000&&previous.last<=now+5000&&previous.created<=previous.last&&previous.expires===previous.created+SIX_HOURS&&now<previous.expires&&now-previous.last<EIGHT_HOURS;
  return valid?{...previous,last:now}:{id:randomUUID(),created:now,last:now,expires:now+SIX_HOURS};
}
export function validatePortfolio(input){
  if(!input||!Number.isSafeInteger(input.revision)||input.revision<0||input.revision>1e9||!input.ledger||input.ledger.version!==1||!Array.isArray(input.ledger.positions)||!Array.isArray(input.ledger.trades)||input.ledger.positions.length>1000||input.ledger.trades.length>5000||Buffer.byteLength(JSON.stringify(input))>1500000)throw fail('The paper portfolio exceeds its supported limits.');
  let ledger;try{ledger=globalThis.KalshiPaper.readLedger(JSON.stringify(input.ledger));}catch{throw fail('The paper ledger contains invalid records.');}
  if(ledger.positions.length!==input.ledger.positions.length||ledger.trades.length!==input.ledger.trades.length||(ledger.cash_movements?.length||0)!==(input.ledger.cash_movements?.length||0))throw fail('The paper ledger contains invalid records.');
  const positions=new Map(ledger.positions.map(row=>[row.id,row]));
  if(positions.size!==ledger.positions.length||new Set(ledger.trades.map(row=>row.id)).size!==ledger.trades.length||ledger.trades.some(row=>positions.get(row.position_id)?.ticker!==row.ticker||row.side!==positions.get(row.position_id)?.side))throw fail('The paper ledger contains conflicting identifiers.');
  if(!Array.isArray(input.watchlist)||input.watchlist.length>200||input.watchlist.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_.-]{1,140}$/.test(value)))throw fail('Supply up to 200 valid saved contracts.');
  return {ledger,watchlist:[...new Set(input.watchlist)],revision:input.revision};
}
async function jsonBody(request,maximum=1500000){
  if(!(request.headers.get('content-type')||'').startsWith('application/json'))throw fail('Use a JSON request.',415);
  const reader=request.body?.getReader();let bytes=0;const parts=[];
  if(reader)try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>maximum){await reader.cancel();throw fail('The request is too large.',413);}parts.push(item.value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('The request must be valid JSON.');}
}
export function makeAccountHandler({storage,secret=process.env.ACCOUNT_COOKIE_SECRET||process.env.ASSISTANT_SERVICE_SECRET,ownerEmail=process.env.MARKET_OWNER_EMAIL,
  authFactory=()=>createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),
  configured=Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY&&ownerEmail),now=Date.now,secure=process.env.NODE_ENV==='production'}={}){
  const owner=String(ownerEmail||'').trim().toLowerCase();
  configured=Boolean(configured&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)&&typeof storage?.get==='function'&&typeof storage?.save==='function'&&typeof storage?.consume==='function');
  const methods={session:['GET'],'account/login':['POST'],'account/logout':['POST'],'account/profile':['GET'],'account/portfolio':['GET','PUT']};
  const readCookie=(request,name)=>cookieValue(request,(secure?'__Host-':'')+name);
  const response=value=>Response.json(value,{headers:{'Cache-Control':'no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
  async function quota(key,limit,amount=1,ttl=900){if(!storage||!await storage.consume(key,limit,amount,ttl))throw fail('This account action is temporarily rate limited.',429);}
  async function identity(request){
    const session=openSession(readCookie(request,ownerCookie),secret,'owner');
    if(!session||!Number.isSafeInteger(session.expires)||session.expires<=now()||!uuid(session.id)||!uuid(session.user_id)||typeof session.access_token!=='string'||typeof session.refresh_token!=='string')throw fail('Sign in to access this saved portfolio.',401);
    const retained=await storage?.get('owner-session#'+hash(session.id));
    if(!retained||retained.revoked||retained.user_id!==session.user_id||!Number.isSafeInteger(retained.expires_epoch)||retained.expires_epoch<=Math.floor(now()/1000))throw fail('This sign-in session has ended.',401);
    const auth=authFactory();let current=session;
    if(!Number.isFinite(session.token_expires)||session.token_expires*1000<=now()+60000){
      const refreshed=await observeProviderAttempt('supabase_auth',()=>auth.auth.refreshSession({refresh_token:session.refresh_token}));
      if(refreshed.error||!refreshed.data?.session)throw fail('Sign in again to continue.',401);
      current={...session,access_token:refreshed.data.session.access_token,refresh_token:refreshed.data.session.refresh_token,token_expires:refreshed.data.session.expires_at};
    }
    const verified=await observeProviderAttempt('supabase_auth',()=>auth.auth.getUser(current.access_token)),user=verified.data?.user;
    if(verified.error||!user||user.id!==current.user_id||String(user.email||'').toLowerCase()!==owner||!user.email_confirmed_at)throw fail('This account is not authorized.',401);
    return {session:current,user,refreshed:current!==session};
  }
  return async function accountResponse(request,path){
    try{
      secretKey(secret,'configuration');
      if(!methods[path])throw fail('Unknown account action.',404);
      if(!methods[path].includes(request.method))return Response.json({error:'Method not allowed.'},{status:405,headers:{'Allow':methods[path].join(', '),'Cache-Control':'no-store'}});
      const origin=request.headers.get('origin'),allowedOrigins=['https://predictir.dev','https://www.predictir.dev'];
      if(!secure){try{const local=new URL(origin||request.url);if(local.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(local.hostname))allowedOrigins.push(local.origin);}catch{}}
      if(origin&&!allowedOrigins.includes(origin)||['POST','PUT'].includes(request.method)&&!origin)throw fail('Open this action from the application.',403);
      if(request.headers.get('sec-fetch-site')==='cross-site')throw fail('Open this action from the application.',403);
      if(path==='session'&&request.method==='GET'){
        const guest=guestSession(openSession(readCookie(request,guestCookie),secret,'guest'),now());let account,invalidOwner=false;
        if(configured&&readCookie(request,ownerCookie)){try{account=await identity(request);}catch(error){if(error.status!==401)throw error;invalidOwner=true;}}
        const out=response({kind:account?'owner':'guest',guest:{id:guest.id,created_at:new Date(guest.created).toISOString(),last_active_at:new Date(guest.last).toISOString(),expires_at:new Date(guest.expires).toISOString()},
          ...(account?{owner:{email:account.user.email}}:{}),login_configured:configured,signup_enabled:false});
        setCookie(out,guestCookie,sealSession(guest,secret,'guest'),(guest.expires-now())/1000,secure);
        if(account?.refreshed)setCookie(out,ownerCookie,sealSession(account.session,secret,'owner'),(account.session.expires-now())/1000,secure);
        if(invalidOwner)setCookie(out,ownerCookie,'',0,secure);
        return out;
      }
      if(path==='account/logout'&&request.method==='POST'){
        const session=openSession(readCookie(request,ownerCookie),secret,'owner');
        if(session?.id&&storage){const record=await storage.get('owner-session#'+hash(session.id));if(record)await storage.save({...record,revoked:true},true);}
        const out=response({signed_out:true});setCookie(out,ownerCookie,'',0,secure);return out;
      }
      if(!configured)throw fail('Account activation is pending. Public research and guest paper trading remain available.',503);
      if(path==='account/login'&&request.method==='POST'){
        const input=await jsonBody(request,4096),email=typeof input.email==='string'?input.email.trim().toLowerCase():'',password=input.password;
        const fingerprint=hash(secret+'\0'+(request.headers.get('x-market-client-ip')||'local'));
        await quota('login-ip#'+fingerprint,8);await quota('login-email#'+hash(secret+'\0'+email),10);
        if(email!==owner||typeof password!=='string'||password.length<8||password.length>200)throw fail('Email or password was not accepted.',401);
        const auth=authFactory(),signed=await observeProviderAttempt('supabase_auth',()=>auth.auth.signInWithPassword({email,password})),user=signed.data?.user,s=signed.data?.session;
        if(signed.error||!user||!s||!uuid(user.id)||typeof s.access_token!=='string'||!s.access_token||typeof s.refresh_token!=='string'||!s.refresh_token||!Number.isFinite(s.expires_at)||s.expires_at*1000<=now()||String(user.email||'').toLowerCase()!==owner||!user.email_confirmed_at)throw fail('Email or password was not accepted.',401);
        const session={id:randomUUID(),user_id:user.id,access_token:s.access_token,refresh_token:s.refresh_token,token_expires:s.expires_at,expires:now()+SEVEN_DAYS};
        await storage.save({pk:'owner-session#'+hash(session.id),sk:'value',user_id:user.id,revoked:false,expires_epoch:Math.floor(session.expires/1000)});
        const out=response({kind:'owner',owner:{email:user.email},signup_enabled:false});setCookie(out,ownerCookie,sealSession(session,secret,'owner'),SEVEN_DAYS/1000,secure);return out;
      }
      const account=await identity(request),id=account.user.id;
      await quota('account-actions#'+hash(id)+'#'+Math.floor(now()/60000),60,1,120);
      let out;
      if(path==='account/profile'&&request.method==='GET')out=response({email:account.user.email,signup_enabled:false});
      else if(path==='account/portfolio'&&request.method==='GET')out=response(await storage.readOwnerPortfolio(id));
      else if(path==='account/portfolio'&&request.method==='PUT'){
        const input=validatePortfolio(await jsonBody(request)),saved=await storage.saveOwnerPortfolio(id,input);
        out=saved.conflict?Response.json(saved.value,{status:409,headers:{'Cache-Control':'no-store'}}):response(saved.value);
      }else throw fail('Unknown account action.',404);
      if(account.refreshed)setCookie(out,ownerCookie,sealSession(account.session,secret,'owner'),(account.session.expires-now())/1000,secure);
      return out;
    }catch(error){return Response.json({error:error.status&&error.status<500?error.message:'The account service is unavailable. Public research and guest paper trading remain available.'},{status:error.status||503,headers:{'Cache-Control':'no-store'}});}
  };
}
