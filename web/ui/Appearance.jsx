'use client';
import {X,Check} from 'lucide-react';
import Modal from './Modal';
import {THEMES} from './preferences';
export default function Appearance({value,onChange,onClose,storageError}){
  return <Modal titleId="appearance-title" onClose={onClose} className="appearance-dialog">
    <div className="dialog-heading"><div><h2 id="appearance-title">Your workspace</h2><p>Appearance stays on this device.</p></div><button className="icon-button" aria-label="Close appearance settings" onClick={onClose}><X size={20}/></button></div>
    <fieldset className="preference-group"><legend>Theme</legend><div className="theme-options">{Object.entries(THEMES).map(([id,theme])=><label className={'theme-choice '+(value.theme===id?'chosen':'')} key={id}>
      <input type="radio" name="workspace-theme" value={id} checked={value.theme===id} onChange={()=>onChange({...value,theme:id})}/>
      <span className={'theme-preview '+id}><i/><i/><i/>{value.theme===id&&<Check size={17}/>}</span><strong>{theme.name}</strong><small>{theme.description}</small>
    </label>)}</div></fieldset>
    <fieldset className="preference-group"><legend>Layout</legend><div className="choice-buttons">{[['balanced','Balanced','Markets and analysis side by side'],['analysis','Analysis focus','More room for charts and evidence'],['wide-list','Market focus','A wider contract list']].map(([id,title,detail])=><label key={id}><input type="radio" name="workspace-layout" checked={value.layout===id} onChange={()=>onChange({...value,layout:id})}/><span><strong>{title}</strong><small>{detail}</small></span></label>)}</div></fieldset>
    <fieldset className="preference-group"><legend>Spacing</legend><div className="choice-buttons horizontal">{[['comfortable','Comfortable'],['compact','Compact']].map(([id,title])=><label key={id}><input type="radio" name="workspace-density" checked={value.density===id} onChange={()=>onChange({...value,density:id})}/><strong>{title}</strong></label>)}</div></fieldset>
    <fieldset className="preference-group"><legend>Research model</legend><div className="choice-buttons">{[['validated','Baseline model','Baseline models with per-contract validation and conservative cost screens'],['challenger','Experimental ensemble','Compare the trained NBA challenger in paper research; its promotion gate remains explicit']].map(([id,title,detail])=><label key={id}><input type="radio" name="workspace-model" checked={value.model===id} onChange={()=>onChange({...value,model:id})}/><span><strong>{title}</strong><small>{detail}</small></span></label>)}</div></fieldset>
    {storageError&&<p className="notice" role="status">This preference applies now, but your browser could not save it.</p>}
    <p className="footnote">All themes keep readable text, visible focus indicators and distinct positive, negative and review states. Compact spacing keeps the same text size. <a href="/research/research-audit.pdf" target="_blank" rel="noreferrer">Methods and audit PDF</a></p>
  </Modal>;
}
