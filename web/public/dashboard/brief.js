(function(root){
  "use strict";
  const pct=x=>Number.isFinite(x)?`${(x*100).toFixed(1)}%`:"Not estimated";
  const date=x=>x?new Date(x).toLocaleString():"Unavailable";
  function safe(url){try{const u=new URL(url);return u.protocol==="https:"?u.href:null;}catch{return null;}}
  function createPanel(React,dataApp){
    const h=React.createElement;
    return function MarketBrief({selected,contracts=100}){
      const [brief,setBrief]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState("");
      const abort=React.useRef(null);
      const load=React.useCallback(async()=>{
        abort.current?.abort();if(!selected?.ticker)return;
        const controller=new AbortController();abort.current=controller;setBusy(true);setError("");
        const timer=setTimeout(()=>controller.abort(),75000);
        try{
          const response=await fetch(`/api/brief?${new URLSearchParams({ticker:selected.ticker,contracts:String(contracts)})}`,{signal:controller.signal,cache:"no-store"});
          const value=await response.json();if(!response.ok)throw new Error(value.error||"Research is temporarily unavailable.");
          if(!controller.signal.aborted)setBrief(value);
        }catch(e){if(abort.current===controller)setError(e.name==="AbortError"?"The evidence request timed out. Retry when the source is available.":e.message);}
        finally{clearTimeout(timer);if(abort.current===controller)setBusy(false);}
      },[selected?.ticker,contracts]);
      React.useEffect(()=>{setBrief(null);load();return()=>abort.current?.abort();},[load]);
      if(!selected)return null;
      const f=brief?.forecast,decision=brief?.decision;
      const probability=f?.probability,marketP=selected.midpoint;
      const rows=brief?[{ticker:brief.ticker,as_of:brief.as_of,probability,interval:f?.interval,model:f?.model_name,decision:decision?.side,source_url:f?.source_url}]:[];
      const link=(url,label)=>safe(url)?h("a",{href:safe(url),target:"_blank",rel:"noopener noreferrer"},label):null;
      return h(dataApp.DataComponent,{id:"km-brief",queryId:"scenarios",title:"Independent research · selected contract",kind:"table",variant:"card",sourceRows:rows,displayRows:rows},
        h("div",{className:"kb-header"},h("div",null,h("p",{className:"kb-ticker"},selected.ticker),h("h3",null,selected.title)),h("button",{type:"button",onClick:load,disabled:busy},busy?"Gathering evidence…":"Refresh analysis")),
        error&&h("p",{className:"km-notice",role:"status"},error),
        !brief&&h("p",{className:"km-note"},busy?"Checking official rules, external measurements and relevant reporting…":"Select a contract to inspect its evidence."),
        brief&&h(React.Fragment,null,
          h("div",{className:"kb-metrics"},
            h("div",null,h("span",null,"Independent P(YES) · estimate"),h("strong",null,pct(probability))),
            h("div",null,h("span",null,"Market YES midpoint"),h("strong",null,pct(marketP))),
            h("div",null,h("span",null,"Model uncertainty / sensitivity"),h("strong",null,Array.isArray(f?.interval)?f.interval.map(pct).join(" – "):"Unavailable"))),
          h("p",{className:"kb-stance"},decision?.label||"Insufficient evidence to select a side"),
          h("p",{className:"kb-summary"},brief.summary),
          h("p",{className:"km-note"},f?.model_name?`${f.model_name}. Source retrieved ${date(f.source_as_of)}.`:f?.reason||"This contract has no validated independent probability model."),
          (decision?.reasons||[]).length>0&&h("ul",{className:"kb-reasons"},...(decision.reasons||[]).map((r,i)=>h("li",{key:i},r))),
          h("div",{className:"kb-columns"},
            h("section",null,h("h4",null,"What can change the outcome"),...(brief.drivers||[]).map((d,i)=>h("div",{className:"kb-driver",key:i},h("strong",null,d.name),h("p",null,d.detail)))),
            h("section",null,h("h4",null,"Recent reporting"),
              !(brief.news?.articles||[]).length&&h("p",{className:"km-note"},brief.news?.status==="unavailable"?"News is temporarily unavailable. Official rules and measured data remain separate evidence.":"No relevant headlines were returned."),
              ...(brief.news?.articles||[]).map((a,i)=>h("article",{className:"kb-news",key:i},link(a.url,a.title),h("small",null,`${a.domain||a.publisher||"Publisher"} · ${a.published_at?"Published "+date(a.published_at):"Seen "+date(a.seen_at)}`))),
              h("p",{className:"km-note"},"Headline context is not a calibrated predictor and does not change the model probability."))),
          h("details",{className:"kb-rules"},h("summary",null,"Resolution rules and evidence sources"),h("p",null,brief.rules?.primary||"Primary rules unavailable."),h("p",null,brief.rules?.secondary||""),h("p",null,`Trading closes: ${date(brief.rules?.close_time)}. Research compiled: ${date(brief.as_of)}.`),...(brief.sources||[]).map((s,i)=>h("p",{key:i},link(s.url||s.source_url,s.name||s.label||s.url||s.source_url))),f?.source_url&&h("p",null,link(f.source_url,"Independent measurement source"))),
          h("p",{className:"km-note"},"Estimates are research hypotheses. Fees, available depth and model uncertainty can erase a numerical advantage; paper results do not establish executable profitability.")));
    };
  }
  root.KalshiBrief={createPanel,safe};
})(typeof globalThis!=="undefined"?globalThis:this);
