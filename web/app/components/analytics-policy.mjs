const categories=new Set(['sports','macro','crypto','travel','weather','science','climate','culture']);
const routes=new Set(['/','/lab.html','/dashboard/index.html']);
export const ANALYTICS_CONSENT_KEY='predictir:analytics-consent:v1';
export const deniedConsent={analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'};
export function applyAnalyticsConsent(target,allowed,measurementID){
  target.dataLayer=target.dataLayer||[];
  target.gtag=target.gtag||function(){target.dataLayer.push(arguments);};
  if(measurementID)target['ga-disable-'+measurementID]=!allowed;
  target.gtag('consent','update',{...deniedConsent,analytics_storage:allowed?'granted':'denied'});
}
export function analyticsProvider({gtm='',ga=''}={}){
  return /^GTM-[A-Z0-9]+$/.test(gtm)?{kind:'gtm',id:gtm}:/^G-[A-Z0-9]+$/.test(ga)?{kind:'ga',id:ga}:null;
}
const publicTicker=value=>typeof value==='string'&&value.length<=140&&/^KX[A-Z0-9_.]{1,40}-[A-Z0-9_.-]+$/.test(value)&&!value.includes('..');

export function sanitizeAnalyticsEvent(name,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const ticker=input.ticker??input.market_ticker,category=input.category??input.market_category,action=input.action??input.cash_action??input.save_action,mode=input.mode??(input.reading_mode==='long_read'?'long':input.reading_mode);
  if(name==='category_select')return categories.has(category)?{name,params:{market_category:category}}:null;
  if(name==='paper_cash_adjustment')return ['add','decrease'].includes(action)?{name,params:{cash_action:action}}:null;
  if(['analysis_read_mode','news_read_mode'].includes(name))return ['summary','long'].includes(mode)?{name,params:{reading_mode:mode==='long'?'long_read':'summary',...(publicTicker(ticker)?{market_ticker:ticker}:{})}}:null;
  if(['paper_entry','paper_close','saved_market'].includes(name))return publicTicker(ticker)?{name,params:{market_ticker:ticker,...(name==='saved_market'&&['save','remove'].includes(action)?{save_action:action}:{})}}:null;
  if(name!=='market_select'||!publicTicker(ticker))return null;
  return {name,params:{market_ticker:ticker,...(categories.has(category)?{market_category:category}:{})}};
}
export function emitAnalytics(name,input){
  if(typeof window==='undefined')return;
  const event=sanitizeAnalyticsEvent(name,input);if(event)window.dispatchEvent(new CustomEvent('market-lab:analytics',{detail:event}));
}
export function analyticsPageContext(address,referrer='') {
  let path='/',pageOrigin='https://predictir.dev',origin='';
  try{const url=new URL(address);if(['http:','https:'].includes(url.protocol)){pageOrigin=url.origin;path=routes.has(url.pathname)?url.pathname:'/other';}}catch{}
  try{const url=new URL(referrer);if(['http:','https:'].includes(url.protocol))origin=url.origin;}catch{}
  return {page_location:pageOrigin+path,page_referrer:origin,page_title:'Predictir'};
}
export function analyticsConfig(address,referrer='') {
  return {...analyticsPageContext(address,referrer),send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,
    campaign_id:'',campaign_name:'',campaign_source:'',campaign_medium:'',campaign_term:'',campaign_content:'',
    cookie_expires:2592000,cookie_update:false,cookie_flags:'SameSite=Lax;Secure',linker:{accept_incoming:false,domains:[],decorate_forms:false}};
}
