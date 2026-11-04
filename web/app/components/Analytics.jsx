'use client';
import Script from 'next/script';
import {useEffect,useRef,useState} from 'react';
import {ANALYTICS_CONSENT_KEY,deniedConsent,sanitizeAnalyticsEvent,analyticsPageContext,analyticsConfig} from './analytics-policy.mjs';
import './analytics.css';

const configuredID=process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID||'';
const measurementID=/^G-[A-Z0-9]+$/.test(configuredID)?configuredID:null;
export default function Analytics() {
  const [consent,setConsent]=useState('unknown'),[open,setOpen]=useState(false),[privacySignal,setPrivacySignal]=useState(false),[storageError,setStorageError]=useState(false);
  const enabled=useRef(false),configured=useRef(false),pageSent=useRef(false),scriptReady=useRef(false);
  function prepare(){
    if(!measurementID)return;
    enabled.current=true;window['ga-disable-'+measurementID]=false;
    window.dataLayer=window.dataLayer||[];
    window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};
    if(!configured.current){
      window.gtag('consent','default',deniedConsent);
      window.gtag('set','ads_data_redaction',true);window.gtag('set','url_passthrough',false);
      window.gtag('consent','update',{...deniedConsent,analytics_storage:'granted'});
      window.gtag('js',new Date());window.gtag('config',measurementID,analyticsConfig(window.location.href,document.referrer));configured.current=true;
    }else window.gtag('consent','update',{...deniedConsent,analytics_storage:'granted'});
    if(scriptReady.current)sendPage();
  }
  function sendPage(){
    if(!enabled.current||!measurementID||pageSent.current)return;
    pageSent.current=true;window.gtag('event','page_view',{...analyticsPageContext(window.location.href,document.referrer),send_to:measurementID});
  }
  function stop(){
    enabled.current=false;if(!measurementID)return;
    window['ga-disable-'+measurementID]=true;
    for(const entry of document.cookie.split(';')){
      const name=entry.split('=')[0].trim();if(!/^_ga(?:_|$)/.test(name))continue;
      for(const domain of ['',window.location.hostname,'.'+window.location.hostname])document.cookie=`${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure${domain?'; Domain='+domain:''}`;
    }
  }
  useEffect(()=>{
    const signal=navigator.globalPrivacyControl===true||navigator.doNotTrack==='1';setPrivacySignal(signal);
    let saved;try{saved=localStorage.getItem(ANALYTICS_CONSENT_KEY);}catch{setStorageError(true);}
    if(signal||saved==='denied'){stop();setConsent('denied');}
    else if(saved==='allowed'&&measurementID){prepare();setConsent('allowed');}
    else {setOpen(Boolean(measurementID));setConsent('unknown');}
    const storage=event=>{if(event.key===ANALYTICS_CONSENT_KEY&&event.newValue!=='allowed'){stop();setConsent('denied');setOpen(false);}};
    window.addEventListener('storage',storage);return()=>{enabled.current=false;window.removeEventListener('storage',storage);};
  },[]);
  useEffect(()=>{
    if(consent!=='allowed'||!measurementID)return;
    const click=event=>{
      if(!enabled.current||!(event.target instanceof Element))return;
      const target=event.target.closest('[data-analytics-market],[data-analytics-category]');if(!target)return;
      const value=target.hasAttribute('data-analytics-market')?sanitizeAnalyticsEvent('market_select',{ticker:target.dataset.analyticsMarket,category:target.dataset.analyticsCategory}):
        sanitizeAnalyticsEvent('category_select',{category:target.dataset.analyticsCategory});
      if(value)window.gtag('event',value.name,{...analyticsPageContext(window.location.href,document.referrer),...value.params,send_to:measurementID});
    };
    document.addEventListener('click',click);return()=>document.removeEventListener('click',click);
  },[consent]);
  function choose(value){
    if(value==='allowed'&&(!measurementID||privacySignal))return;
    if(value==='allowed')prepare();else stop();
    try{localStorage.setItem(ANALYTICS_CONSENT_KEY,value);}catch{setStorageError(true);}
    setConsent(value);setOpen(false);
  }
  return <>
    {consent==='allowed'&&measurementID&&<Script id="market-lab-ga4" src={'https://www.googletagmanager.com/gtag/js?id='+measurementID} strategy="afterInteractive" onReady={()=>{scriptReady.current=true;sendPage();}}/>}
    <button type="button" className="analytics-settings" aria-expanded={open} aria-controls="analytics-consent" onClick={()=>setOpen(value=>!value)}>Analytics settings</button>
    {open&&<section id="analytics-consent" className="analytics-consent" aria-label="Analytics preferences">
      <strong>Optional analytics</strong><p>{measurementID?'Google Analytics can count visits and public market/category selections. Chat, journals, probability inputs and paper budgets are excluded.':'Analytics is not configured for this deployment. No Google Analytics is loaded.'}</p>
      {privacySignal&&<p>Your browser privacy signal keeps analytics off.</p>}{storageError&&<p>Your preference could not be saved. It applies to this session.</p>}
      <div><button type="button" onClick={()=>choose('denied')}>No analytics</button><button type="button" disabled={!measurementID||privacySignal} onClick={()=>choose('allowed')}>Allow analytics</button></div>
    </section>}
  </>;
}
