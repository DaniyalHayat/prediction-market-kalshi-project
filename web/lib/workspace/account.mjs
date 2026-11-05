import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {observeProviderAttempt} from '../runtime/telemetry.mjs';
import {azureOwnerConfig,azureOwnerLogout,verifyAzureOwner} from './azure-owner.mjs';
import {azureOrigin} from './azure-mode.mjs';
import '../../public/dashboard/paper.js';
const SIX_HOURS=6*3600000,EIGHT_HOURS=8*3600000,SEVEN_DAYS=7*86400000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const ownerCookie='market_owner',guestCookie='market_guest';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function authFailure(error){
  const invalidCodes=new Set(['invalid_credentials','bad_jwt','refresh_token_not_found','refresh_token_already_used','user_not_found','session_not_found','session_expired','email_not_confirmed','user_banned']);
  const status=Number(error?.status);
  if(status!==429&&!(status>=500)&&(status===401||invalidCodes.has(error?.code)))return fail('Sign in again to continue.',401);
  return Object.assign(fail('The account identity provider is temporarily unavailable.',503),{retryAfter:status===429?60:15});
}
async function callAuth(run){try{return await observeProviderAttempt('supabase_auth',run);}catch(error){throw authFailure(error);}}
function cookieValue(request,name){const value=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='));return value?.slice(name.length+1)||null;}
function secretKey(secret,purpose){if(typeof secret!=='string'||secret.length<32)throw fail('Private session configuration is pending.',503);return createHash('sha256').update(purpose+'\0'+secret).digest();}
export function sealSession(value,secret,purpose){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secretKey(secret,purpose),iv),body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
export function openSession(value,secret,purpose){try{if(typeof value!=='string'||value.length>8000||!/^[A-Za-z0-9_-]+$/.test(value))return null;const raw=Buffer.from(value,'base64url');if(raw.length<29||raw.toString('base64url')!==value)return null;const decipher=createDecipheriv('aes-256-gcm',secretKey(secret,purpose),raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));}catch{return null;}}
function setCookie(response,name,value,age,secure){response.headers.append('Set-Cookie',`${secure?'__Host-':''}${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(age))}${secure?'; Secure':''}`);}
export function guestSession(previous,now=Date.now()){
  const valid=previous&&uuid(previous.id)&&[previous.created,previous.last,previous.expires].every(Number.isSafeInteger)&&previous.created<=now+5000&&previous.last<=now+5000&&previous.created<=previous.last&&previous.expires===previous.created+SIX_HOURS&&now<previous.expires&&now-previous.last<EIGHT_HOURS;
  return valid?{...previous,last:now}:{id:randomUUID(),created:now,last:now,expires:now+SIX_HOURS};
}
function validateFinancialHistory(ledger){
  const invalid=()=>{throw fail('The paper ledger does not reconcile with its trade and cash history.');};
  const incomplete=()=>{throw fail('Complete trade history is required to verify this paper account. Keep your browser copy and export it before importing a truncated history.');};
  const round=value=>Math.round(value*1e10)/1e10;
  const equal=(a,b,rounding=0)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8+rounding+Number.EPSILON*8*Math.max(Math.abs(a),Math.abs(b));
  const amount=(value,minimum=0,maximum=1e9)=>typeof value==='number'&&Number.isFinite(value)&&value>=minimum&&value<=maximum;
  const dated=value=>typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value));
  const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  if(!amount(ledger.starting_balance,Number.MIN_VALUE))invalid();
  const positions=new Map(ledger.positions.map(row=>[row.id,row])),states=new Map(),events=[];
  let previous=-Infinity,cash=ledger.starting_balance,open=0;
  for(const [index,trade] of ledger.trades.entries()){
    if(!identifier(trade.id)||!identifier(trade.position_id)||!dated(trade.occurred_at)||Date.parse(trade.occurred_at)<previous)invalid();
    previous=Date.parse(trade.occurred_at);
    if(!amount(trade.filled,Number.MIN_VALUE,1e6)||!amount(trade.notional,0,trade.filled+1e-8)||!amount(trade.fee)||!amount(trade.cash,-1e9)||!amount(trade.vwap,0,1)||!equal(trade.notional,trade.filled*trade.vwap,trade.filled*.5e-10+1e-10)||!equal(trade.cash,trade.action==='buy'?trade.notional+trade.fee:trade.notional-trade.fee))invalid();
    if(!equal(trade.fee*100,Math.round(trade.fee*100)))invalid();
    if(trade.unfilled!==undefined&&!amount(trade.unfilled,0,1e6))invalid();
    if(trade.requested!==undefined&&(!amount(trade.requested,trade.filled-1e-8,1e6)||!amount(trade.unfilled)||!equal(trade.requested,trade.filled+trade.unfilled)))invalid();
    if(trade.action!=='settle'&&trade.assumptions!==undefined){
      const assumptions=trade.assumptions;
      if(!assumptions||Array.isArray(assumptions)||typeof assumptions!=='object'||assumptions.coefficient!==undefined&&!amount(assumptions.coefficient,0,1)||assumptions.multiplier!==undefined&&!amount(assumptions.multiplier,0,100)||assumptions.slippage!==undefined&&!amount(assumptions.slippage,0,100)||assumptions.budget!==undefined&&assumptions.budget!==null&&!amount(assumptions.budget,0,1e12))invalid();
    }
    if(trade.fills!==undefined){
      if(!Array.isArray(trade.fills)||!trade.fills.length||trade.fills.length>10000)invalid();
      let quantity=0,notional=0,fee=0;
      for(const fill of trade.fills){
        if(!fill||!amount(fill.price,0,1)||!amount(fill.quantity,Number.MIN_VALUE,1e6)||!amount(fill.notional,0,fill.quantity+1e-8)||!amount(fill.fee)||!equal(fill.notional,fill.price*fill.quantity)||!equal(fill.fee*100,Math.round(fill.fee*100)))invalid();
        if(trade.action!=='settle'&&trade.assumptions){const coefficient=trade.assumptions.coefficient??.07,multiplier=trade.assumptions.multiplier??1,expectedFee=Math.max(0,Math.ceil((coefficient*multiplier*fill.quantity*fill.price*(1-fill.price)-1e-10)*100)/100);if(!equal(fill.fee,expectedFee))invalid();}
        quantity+=fill.quantity;notional+=fill.notional;fee+=fill.fee;
      }
      if(!equal(quantity,trade.filled)||!equal(notional,trade.notional)||!equal(fee,trade.fee))invalid();
    }
    if(trade.fee>trade.filled*25+.01*(trade.fills?.length||1)+1e-8)invalid();
    events.push({time:previous,priority:1,index,trade});
  }
  previous=-Infinity;
  for(const [index,movement] of (ledger.cash_movements||[]).entries()){
    if(!dated(movement.occurred_at)||Date.parse(movement.occurred_at)<previous)invalid();
    previous=Date.parse(movement.occurred_at);events.push({time:previous,priority:movement.action==='add'?0:2,index,movement});
  }
  events.sort((a,b)=>a.time-b.time||a.priority-b.priority||a.index-b.index);
  const cashTolerance=1e-8+events.length*1e-10;
  for(const event of events){
    if(event.movement){
      const movement=event.movement;
      if(movement.action==='decrease'&&movement.amount>Math.max(0,cash)+cashTolerance)invalid();
      cash=round(cash+(movement.action==='add'?movement.amount:-movement.amount));
    }else{
      const trade=event.trade,position=positions.get(trade.position_id);let state=states.get(trade.position_id);
      if(trade.action==='buy'){
        if(state||trade.id!==trade.position_id+':buy'||trade.cash<0||trade.cash>Math.max(0,cash)+cashTolerance||++open>20)invalid();
        state={original_quantity:trade.filled,remaining_quantity:trade.filled,entry_cost:trade.notional,entry_fee:trade.fee,remaining_basis:trade.cash,realized_pnl:0,opened_at:trade.occurred_at};
        states.set(trade.position_id,state);cash=round(cash-trade.cash);
      }else{
        if(!state)incomplete();
        if(state.remaining_quantity<=0||trade.filled>state.remaining_quantity+1e-8)invalid();
        const basis=trade.filled>=state.remaining_quantity-1e-8?state.remaining_basis:state.remaining_basis*trade.filled/state.remaining_quantity;
        if(!equal(trade.released_basis,round(basis))||!equal(trade.realized_pnl,round(trade.cash-basis)))invalid();
        if(trade.action==='settle'){
          if(!equal(trade.filled,state.remaining_quantity)||trade.fee!==0||!['yes','no'].includes(trade.settlement_result)||!equal(trade.vwap,trade.settlement_result===trade.side?1:0)||!dated(trade.quote_as_of))invalid();
          let source;try{source=new URL(trade.quote_source);}catch{invalid();}
          if(source.protocol!=='https:'||source.username||source.password||!['api.elections.kalshi.com','external-api.kalshi.com','api.kalshi.com'].includes(source.hostname)||!source.pathname.endsWith('/markets/'+encodeURIComponent(trade.ticker)))invalid();
          if(position.settlement_result!==trade.settlement_result||position.settlement_source!==source.href||position.settlement_observed_at!==trade.quote_as_of)invalid();
        }
        state.remaining_quantity=round(Math.max(0,state.remaining_quantity-trade.filled));
        state.remaining_basis=state.remaining_quantity?round(state.remaining_basis-basis):0;
        state.realized_pnl=round(state.realized_pnl+trade.realized_pnl);
        if(!state.remaining_quantity){state.closed_at=trade.occurred_at;open--;}
        cash=round(cash+trade.cash);
      }
    }
    if(!amount(cash,-1e12,1e12))invalid();
  }
  for(const position of positions.values()){
    const expected=states.get(position.id);if(!expected)incomplete();
    for(const field of ['original_quantity','remaining_quantity','entry_cost','entry_fee','remaining_basis','realized_pnl'])if(!equal(position[field],expected[field]))invalid();
    if(!identifier(position.id)||!dated(position.opened_at)||Date.parse(position.opened_at)!==Date.parse(expected.opened_at)||expected.closed_at&&(!dated(position.closed_at)||Date.parse(position.closed_at)!==Date.parse(expected.closed_at))||!expected.closed_at&&position.closed_at!==undefined)invalid();
  }
  const adjustments=(ledger.cash_movements||[]).reduce((sum,row)=>sum+(row.action==='add'?row.amount:-row.amount),0),realized=ledger.positions.reduce((sum,row)=>sum+row.realized_pnl,0),basis=ledger.positions.reduce((sum,row)=>sum+row.remaining_basis,0);
  if(!equal(cash,ledger.starting_balance+adjustments+realized-basis,events.length*1e-10))invalid();
}
export function validatePortfolio(input){
  if(!input||!Number.isSafeInteger(input.revision)||input.revision<0||input.revision>1e9||!input.ledger||input.ledger.version!==1||!Array.isArray(input.ledger.positions)||!Array.isArray(input.ledger.trades)||input.ledger.positions.length>1000||input.ledger.trades.length>5000||Buffer.byteLength(JSON.stringify(input))>1500000)throw fail('The paper portfolio exceeds its supported limits.');
  let ledger;try{ledger=globalThis.KalshiPaper.readLedger(JSON.stringify(input.ledger));}catch{throw fail('The paper ledger contains invalid records.');}
  if(ledger.positions.length!==input.ledger.positions.length||ledger.trades.length!==input.ledger.trades.length||(ledger.cash_movements?.length||0)!==(input.ledger.cash_movements?.length||0))throw fail('The paper ledger contains invalid records.');
  const positions=new Map(ledger.positions.map(row=>[row.id,row]));
  if(positions.size!==ledger.positions.length||new Set(ledger.trades.map(row=>row.id)).size!==ledger.trades.length||ledger.trades.some(row=>positions.get(row.position_id)?.ticker!==row.ticker||row.side!==positions.get(row.position_id)?.side))throw fail('The paper ledger contains conflicting identifiers.');
  validateFinancialHistory(ledger);
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
  configured=Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY&&ownerEmail),now=Date.now,secure=process.env.NODE_ENV==='production',
  env=process.env,verifyEntraOwner=verifyAzureOwner}={}){
  const owner=String(ownerEmail||'').trim().toLowerCase();
  const azureLive=env.PREDICTIR_MODE==='live',entra=secure?azureOwnerConfig(env):null;
  configured=azureLive?Boolean(entra&&['consume','readOwnerPortfolio','saveOwnerPortfolio'].every(method=>typeof storage?.[method]==='function')):
    Boolean(configured&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)&&typeof storage?.get==='function'&&typeof storage?.save==='function'&&typeof storage?.consume==='function');
  const methods={session:['GET'],'account/login':['POST'],'account/logout':['POST'],'account/profile':['GET'],'account/portfolio':['GET','PUT']};
  const readCookie=(request,name)=>cookieValue(request,(secure?'__Host-':'')+name);
  const response=value=>Response.json(value,{headers:{'Cache-Control':'no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
  const ownerView=user=>azureLive?{key:user.key,display_name:user.display_name}:{email:user.email};
  async function quota(key,limit,amount=1,ttl=900){if(!storage||!await storage.consume(key,limit,amount,ttl))throw fail('This account action is temporarily rate limited.',429);}
  async function identity(request){
    if(azureLive){
      const user=await verifyEntraOwner(request,entra);
      if(!user)throw fail('Sign in with the authorized Microsoft account to continue.',401);
      return {user};
    }
    const session=openSession(readCookie(request,ownerCookie),secret,'owner');
    if(!session||!Number.isSafeInteger(session.expires)||session.expires<=now()||!uuid(session.id)||!uuid(session.user_id)||typeof session.access_token!=='string'||typeof session.refresh_token!=='string')throw fail('Sign in to access this saved portfolio.',401);
    const retained=await storage?.get('owner-session#'+hash(session.id));
    if(!retained||retained.revoked||retained.user_id!==session.user_id||!Number.isSafeInteger(retained.expires_epoch)||retained.expires_epoch<=Math.floor(now()/1000))throw fail('This sign-in session has ended.',401);
    const auth=authFactory();let current=session;
    if(!Number.isFinite(session.token_expires)||session.token_expires*1000<=now()+60000){
      const refreshed=await callAuth(()=>auth.auth.refreshSession({refresh_token:session.refresh_token}));
      const next=refreshed?.data?.session;
      if(refreshed?.error||!next||typeof next.access_token!=='string'||!next.access_token||typeof next.refresh_token!=='string'||!next.refresh_token||!Number.isFinite(next.expires_at)||next.expires_at*1000<=now())throw authFailure(refreshed?.error);
      current={...session,access_token:next.access_token,refresh_token:next.refresh_token,token_expires:next.expires_at};
    }
    const verified=await callAuth(()=>auth.auth.getUser(current.access_token)),user=verified?.data?.user;
    if(verified?.error||!user)throw authFailure(verified?.error);
    if(user.id!==current.user_id||String(user.email||'').toLowerCase()!==owner||!user.email_confirmed_at)throw fail('This account is not authorized.',401);
    return {session:current,user,refreshed:current!==session};
  }
  return async function accountResponse(request,path){
    try{
      secretKey(secret,'configuration');
      if(!methods[path])throw fail('Unknown account action.',404);
      if(!methods[path].includes(request.method))return Response.json({error:'Method not allowed.'},{status:405,headers:{'Allow':methods[path].join(', '),'Cache-Control':'no-store'}});
      const origin=request.headers.get('origin'),allowedOrigins=azureLive?[azureOrigin(env.APP_ORIGIN||'')]:['https://predictir.dev','https://www.predictir.dev'];
      if(!secure){try{const local=new URL(origin||request.url);if(local.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(local.hostname))allowedOrigins.push(local.origin);}catch{}}
      if(origin&&!allowedOrigins.includes(origin)||['POST','PUT'].includes(request.method)&&!origin)throw fail('Open this action from the application.',403);
      if(request.headers.get('sec-fetch-site')==='cross-site')throw fail('Open this action from the application.',403);
      if(path==='session'&&request.method==='GET'){
        const guest=guestSession(openSession(readCookie(request,guestCookie),secret,'guest'),now());let account,invalidOwner=false;
        if(configured&&(azureLive||readCookie(request,ownerCookie))){try{account=await identity(request);}catch(error){if(error.status!==401)throw error;invalidOwner=!azureLive;}}
        const out=response({kind:account?'owner':'guest',guest:{id:guest.id,created_at:new Date(guest.created).toISOString(),last_active_at:new Date(guest.last).toISOString(),expires_at:new Date(guest.expires).toISOString()},
          ...(account?{owner:ownerView(account.user)}:{}),...(azureLive?{login_provider:'entra'}:{}),login_configured:configured,signup_enabled:false});
        setCookie(out,guestCookie,sealSession(guest,secret,'guest'),(guest.expires-now())/1000,secure);
        if(account?.refreshed)setCookie(out,ownerCookie,sealSession(account.session,secret,'owner'),(account.session.expires-now())/1000,secure);
        if(invalidOwner)setCookie(out,ownerCookie,'',0,secure);
        return out;
      }
      if(path==='account/logout'&&request.method==='POST'){
        if(azureLive)return response({signed_out:false,logout_path:azureOwnerLogout});
        const session=openSession(readCookie(request,ownerCookie),secret,'owner');
        if(session?.id&&storage){const record=await storage.get('owner-session#'+hash(session.id));if(record)await storage.save({...record,revoked:true},true);}
        const out=response({signed_out:true});setCookie(out,ownerCookie,'',0,secure);return out;
      }
      if(!configured)throw fail('Account activation is pending. Public research and guest paper trading remain available.',503);
      if(path==='account/login'&&request.method==='POST'){
        if(azureLive)throw fail('Use Sign in with Microsoft from the account menu.',405);
        const input=await jsonBody(request,4096),email=typeof input.email==='string'?input.email.trim().toLowerCase():'',password=input.password;
        const fingerprint=hash(secret+'\0'+(request.headers.get('x-market-client-ip')||'local'));
        await quota('login-ip#'+fingerprint,8);await quota('login-email#'+hash(secret+'\0'+email),10);
        if(email!==owner||typeof password!=='string'||password.length<8||password.length>200)throw fail('Email or password was not accepted.',401);
        const auth=authFactory(),signed=await callAuth(()=>auth.auth.signInWithPassword({email,password})),user=signed?.data?.user,s=signed?.data?.session;
        if(signed?.error||!user||!s||!uuid(user.id)||typeof s.access_token!=='string'||!s.access_token||typeof s.refresh_token!=='string'||!s.refresh_token||!Number.isFinite(s.expires_at)||s.expires_at*1000<=now())throw authFailure(signed?.error);
        if(String(user.email||'').toLowerCase()!==owner||!user.email_confirmed_at)throw fail('Email or password was not accepted.',401);
        const session={id:randomUUID(),user_id:user.id,access_token:s.access_token,refresh_token:s.refresh_token,token_expires:s.expires_at,expires:now()+SEVEN_DAYS};
        await storage.save({pk:'owner-session#'+hash(session.id),sk:'value',user_id:user.id,revoked:false,expires_epoch:Math.floor(session.expires/1000)});
        const out=response({kind:'owner',owner:{email:user.email},signup_enabled:false});setCookie(out,ownerCookie,sealSession(session,secret,'owner'),SEVEN_DAYS/1000,secure);return out;
      }
      const account=await identity(request),id=account.user.id;
      await quota('account-actions#'+hash(id)+'#'+Math.floor(now()/60000),60,1,120);
      let out;
      if(path==='account/profile'&&request.method==='GET')out=response({...ownerView(account.user),signup_enabled:false});
      else if(path==='account/portfolio'&&request.method==='GET')out=response(await storage.readOwnerPortfolio(id));
      else if(path==='account/portfolio'&&request.method==='PUT'){
        const input=validatePortfolio(await jsonBody(request)),saved=await storage.saveOwnerPortfolio(id,input);
        out=saved.conflict?Response.json(saved.value,{status:409,headers:{'Cache-Control':'no-store'}}):response(saved.value);
      }else throw fail('Unknown account action.',404);
      if(account.refreshed)setCookie(out,ownerCookie,sealSession(account.session,secret,'owner'),(account.session.expires-now())/1000,secure);
      return out;
    }catch(error){return Response.json({error:error.status&&error.status<500?error.message:'The account service is unavailable. Public research and guest paper trading remain available.'},{status:error.status||503,headers:{'Cache-Control':'no-store',...(error.retryAfter?{'Retry-After':String(error.retryAfter)}:{})}});}
  };
}
