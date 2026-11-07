'use client';
import Script from 'next/script';
import {useEffect,useRef,useState} from 'react';
import {ANALYTICS_CONSENT_KEY,deniedConsent,applyAnalyticsConsent,sanitizeAnalyticsEvent,analyticsPageContext,analyticsConfig,analyticsProvider} from './analytics-policy.mjs';
import './analytics.css';

const provider=analyticsProvider({gtm:process.env.NEXT_PUBLIC_GTM_CONTAINER_ID||'',ga:process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID||''});
const measurementID=provider?.kind==='ga'?provider.id:null;
const knownMeasurementID=/^G-[A-Z0-9]+$/.test(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID||'')?process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID:null;
export default function Analytics({nonce}) {
  const [consent,setConsent]=useState('unknown'),[open,setOpen]=useState(false),[privacySignal,setPrivacySignal]=useState(false),[storageError,setStorageError]=useState(false);
  const enabled=useRef(false),configured=useRef(false),pageSent=useRef(false),scriptReady=useRef(false);
  function prepare(){
    if(!provider)return;
    enabled.current=true;
    window.dataLayer=window.dataLayer||[];
    window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};
    if(!configured.current){
      window.gtag('consent','default',deniedConsent);
      window.gtag('set','ads_data_redaction',true);window.gtag('set','url_passthrough',false);
      applyAnalyticsConsent(window,true,knownMeasurementID);
      const context=analyticsConfig(window.location.href,document.referrer);
      if(provider.kind==='gtm'){window.dataLayer.push({...context,'gtm.start':Date.now(),event:'gtm.js'});}
      else{window.gtag('js',new Date());window.gtag('config',measurementID,context);}configured.current=true;
    }else applyAnalyticsConsent(window,true,knownMeasurementID);
    if(scriptReady.current)sendPage();
  }
  function sendPage(){
    if(!enabled.current||!provider||pageSent.current)return;
    pageSent.current=true;send('page_view',{});
  }
  function send(name,params){
    if(!enabled.current||!provider)return;
    const value={market_ticker:'',market_category:'',reading_mode:'',cash_action:'',save_action:'',...analyticsPageContext(window.location.href,document.referrer),...params};
    if(provider.kind==='gtm')window.dataLayer.push({event:name,...value});
    else window.gtag('event',name,{...value,send_to:measurementID});
  }
  function stop(){
    enabled.current=false;if(!provider)return;
    applyAnalyticsConsent(window,false,knownMeasurementID);
    for(const entry of document.cookie.split(';')){
      const name=entry.split('=')[0].trim();if(!/^_ga(?:_|$)/.test(name))continue;
      for(const domain of ['',window.location.hostname,'.'+window.location.hostname])document.cookie=`${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure${domain?'; Domain='+domain:''}`;
    }
  }
  useEffect(()=>{
    const signal=navigator.globalPrivacyControl===true||navigator.doNotTrack==='1';setPrivacySignal(signal);
    let saved;try{saved=localStorage.getItem(ANALYTICS_CONSENT_KEY);}catch{setStorageError(true);}
    if(signal||saved==='denied'){stop();setConsent('denied');}
    else if(saved==='allowed'&&provider){prepare();setConsent('allowed');}
    else {setOpen(Boolean(provider));setConsent('unknown');}
    const storage=event=>{if(event.key===ANALYTICS_CONSENT_KEY&&event.newValue!=='allowed'){stop();setConsent('denied');setOpen(false);}};
    window.addEventListener('storage',storage);return()=>{enabled.current=false;window.removeEventListener('storage',storage);};
  },[]);
  useEffect(()=>{
    if(consent!=='allowed'||!provider)return;
    const click=event=>{
      if(!enabled.current||!(event.target instanceof Element))return;
      const target=event.target.closest('[data-analytics-market],[data-analytics-category]');if(!target)return;
      const value=target.hasAttribute('data-analytics-market')?sanitizeAnalyticsEvent('market_select',{ticker:target.dataset.analyticsMarket,category:target.dataset.analyticsCategory}):
        sanitizeAnalyticsEvent('category_select',{category:target.dataset.analyticsCategory});
      if(value)send(value.name,value.params);
    };
    const custom=event=>{const value=sanitizeAnalyticsEvent(event.detail?.name,event.detail?.params);if(value)send(value.name,value.params);};
    document.addEventListener('click',click);window.addEventListener('market-lab:analytics',custom);return()=>{document.removeEventListener('click',click);window.removeEventListener('market-lab:analytics',custom);};
  },[consent]);
  function choose(value){
    if(value==='allowed'&&(!provider||privacySignal))return;
    if(value==='allowed')prepare();else stop();
    try{localStorage.setItem(ANALYTICS_CONSENT_KEY,value);}catch{setStorageError(true);}
    setConsent(value);setOpen(false);
  }
  return <>
    {consent==='allowed'&&provider&&<Script nonce={nonce} id={provider.kind==='gtm'?'market-lab-gtm':'market-lab-ga4'} src={provider.kind==='gtm'?'https://www.googletagmanager.com/gtm.js?id='+provider.id:'https://www.googletagmanager.com/gtag/js?id='+measurementID} strategy="afterInteractive" onReady={()=>{scriptReady.current=true;sendPage();}}/>}
    <button type="button" className="analytics-settings" aria-expanded={open} aria-controls="analytics-consent" onClick={()=>setOpen(value=>!value)}>Analytics settings</button>
    {open&&<section id="analytics-consent" className="analytics-consent" aria-label="Analytics preferences">
      <strong>Optional analytics</strong><p>{provider?'Allow visit counts, public market selections and use of research and paper tools. Balances, trade amounts, chat, journals and account details stay private.':'Analytics is not configured for this deployment. No Google Analytics is loaded.'}</p>
      {privacySignal&&<p>Your browser privacy signal keeps analytics off.</p>}{storageError&&<p>Your preference could not be saved. It applies to this session.</p>}
      <div><button type="button" onClick={()=>choose('denied')}>No analytics</button><button type="button" disabled={!provider||privacySignal} onClick={()=>choose('allowed')}>Allow analytics</button></div>
    </section>}
  </>;
}
