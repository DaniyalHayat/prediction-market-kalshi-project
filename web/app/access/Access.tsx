'use client';
import {useEffect,useRef,useState} from 'react';

export default function Access(){
  const [state,setState]=useState('Opening your private preview…');
  const opening=useRef<Promise<Response>|null>(null);
  useEffect(()=>{
    let active=true;
    if(!opening.current){
      const fragment=window.location.hash.slice(1);
      window.history.replaceState(null,'','/access');
      if(!/^[A-Za-z0-9_-]{43,128}$/.test(fragment)){setState('Open the private link you were given.');return;}
      opening.current=fetch('/api/access/redeem',{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({token:fragment})});
    }
    void opening.current.then(response=>{
      if(!active)return;
      if(response.ok)window.location.replace('/');
      else setState(response.status===429?'Too many attempts. Please try the link again in one minute.':'This link is no longer active. Ask for a new private link.');
    }).catch(()=>{if(active)setState('The preview could not connect. Please open your private link again.');});
    return ()=>{active=false;};
  },[]);
  return <main style={{minHeight:'100dvh',display:'grid',placeItems:'center',background:'#080808',color:'#f5f5f5',padding:24,fontFamily:'Arial, sans-serif'}}>
    <section style={{maxWidth:420,width:'100%',border:'1px solid #303030',borderRadius:18,padding:32,background:'#111'}}>
      <p style={{fontSize:12,color:'#a8a8a8',letterSpacing:2,textTransform:'uppercase'}}>Private preview</p>
      <h1 style={{fontSize:34,letterSpacing:-1,margin:'18px 0'}}>Predictir</h1>
      <p role="status" aria-live="polite" style={{fontSize:16,lineHeight:1.6,color:'#d0d0d0'}}>{state}</p>
      <p style={{fontSize:13,lineHeight:1.6,color:'#888',marginTop:26}}>A private link opens the app directly. No account is needed to explore.</p>
    </section>
  </main>;
}
