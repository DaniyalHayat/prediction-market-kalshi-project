const categories=new Set(['sports','macro','crypto','travel','weather','science','climate','culture']);
const routes=new Set(['/','/lab.html','/dashboard/index.html']);
export const ANALYTICS_CONSENT_KEY='kalshi-market-lab:analytics-consent:v1';
export const deniedConsent={analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'};

export function sanitizeAnalyticsEvent(name,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  if(name==='category_select')return categories.has(input.category)?{name,params:{market_category:input.category}}:null;
  if(name!=='market_select'||typeof input.ticker!=='string'||input.ticker.length>140||!/^KX[A-Z0-9_.]{1,40}-[A-Z0-9_.-]+$/.test(input.ticker)||input.ticker.includes('..'))return null;
  return {name,params:{market_ticker:input.ticker,...(categories.has(input.category)?{market_category:input.category}:{})}};
}
export function analyticsPageContext(address,referrer='') {
  let path='/',pageOrigin='https://predictir.dev',origin='';
  try{const url=new URL(address);if(['http:','https:'].includes(url.protocol)){pageOrigin=url.origin;path=routes.has(url.pathname)?url.pathname:'/other';}}catch{}
  try{const url=new URL(referrer);if(['http:','https:'].includes(url.protocol))origin=url.origin;}catch{}
  return {page_location:pageOrigin+path,page_referrer:origin,page_title:'Kalshi Market Lab'};
}
export function analyticsConfig(address,referrer='') {
  return {...analyticsPageContext(address,referrer),send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,
    campaign_id:'',campaign_name:'',campaign_source:'',campaign_medium:'',campaign_term:'',campaign_content:'',
    cookie_expires:2592000,cookie_update:false,cookie_flags:'SameSite=Lax;Secure',linker:{accept_incoming:false,domains:[],decorate_forms:false}};
}
