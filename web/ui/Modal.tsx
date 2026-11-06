'use client';
import {useEffect,useRef} from 'react';
import type {ReactNode,RefObject} from 'react';

export function usePanelFocus(ref:RefObject<HTMLElement|null>,onClose:()=>void,{modal=true}={}) {
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const panel=ref.current,previous=document.activeElement;
    if(!panel)return;
    const controls=()=>[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')]
      .filter(el=>el.getClientRects().length&&!el.closest('[hidden],[inert]'));
    (panel.querySelector<HTMLElement>('[data-initial-focus]')||controls()[0]||panel).focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current?.();return;}
      if(event.key!=='Tab'||!modal)return;
      const items=controls(),first=items[0],last=items.at(-1);
      if(!first){event.preventDefault();panel.focus();}
      else if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
    panel.addEventListener('keydown',key);
    return()=>{panel.removeEventListener('keydown',key);if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[ref,modal]);
}

export default function Modal({titleId,onClose,children,className=''}:{titleId:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const panel=useRef<HTMLElement|null>(null);usePanelFocus(panel,onClose);
  return <div className="overlay" onClick={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={panel} tabIndex={-1}
    className={'dialog '+className} role="dialog" aria-modal="true" aria-labelledby={titleId}>{children}</section></div>;
}
