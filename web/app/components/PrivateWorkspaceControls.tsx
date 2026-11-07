'use client';
import {useState} from 'react';
import './private-session.css';

export default function PrivateWorkspaceControls() {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function lock() {
    if(busy)return;
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/access/logout',{method:'POST',credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error();
      window.location.replace('/access');
    }catch{setError('Could not lock the workspace. Try again.');setBusy(false);}
  }
  return <div className="private-session-controls"><button type="button" onClick={lock} disabled={busy} title="Reopen your private link to return">{busy?'Locking…':'Lock workspace'}</button>{error&&<span role="alert">{error}</span>}</div>;
}
