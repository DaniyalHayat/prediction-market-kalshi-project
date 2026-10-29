(function(root) {
  "use strict";
  const categories=[["crypto","Crypto"],["weather","Weather"],["labor","Labor"],["inflation","Inflation"],["travel","Travel"]];
  const dollars=value=>Number.isFinite(value) ? value.toLocaleString("en-US",{style:"currency",currency:"USD"}) : "—";
  const percent=value=>Number.isFinite(value) ? `${(value*100).toFixed(1)}%` : "—";
  function createPanel(React,dataApp) {
    const h=React.createElement,Button=dataApp.Button;
    const note=text=>h("p",{className:"km-note"},text);
    function Field({label,value,set,...props}){return h("label",null,label,h("input",{type:"number",value,onChange:event=>set(event.target.value),...props}));}
    async function call(base,path,input,signal) {
      const response=await fetch(`${base}/api/intelligence/forward${path}`,input===undefined ? {signal,cache:"no-store"} :
        {method:"POST",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
      const value=await response.json();
      if(!response.ok)throw new Error(value.error || `Forward research request failed: ${response.status}`);
      return value;
    }
    return function ForwardPanel({connector="",download}) {
      const [selected,setSelected]=React.useState(categories.map(([id])=>id)),[quantity,setQuantity]=React.useState("10");
      const [breadth,setBreadth]=React.useState("1"),[seconds,setSeconds]=React.useState(60),[fee,setFee]=React.useState("0.07");
      const [run,setRun]=React.useState(null),[listing,setListing]=React.useState({runs:[],aggregates:[]}),[busy,setBusy]=React.useState("");
      const [evidence,setEvidence]=React.useState([]);
      const [error,setError]=React.useState(""),[clock,setClock]=React.useState(Date.now),[aggregate,setAggregate]=React.useState(true);
      const clockOffset=React.useRef(0),controller=React.useRef(null);
      const accept=value=>{
        if(value.server_time)clockOffset.current=Date.now()-Date.parse(value.server_time);
        setRun(value);try{localStorage.setItem("kalshi.quant.last-forward.v2",value.id);}catch{}
      };
      async function refresh() {
        const value=await call(connector,"");setListing(value);return value;
      }
      React.useEffect(()=>{
        const abort=new AbortController();controller.current=abort;
        fetch(new URL("./evidence/index.json",document.baseURI),{signal:abort.signal})
          .then(response=>response.ok ? response.json() : {runs:[]})
          .then(value=>{if(!abort.signal.aborted)setEvidence((value.runs || []).filter(row=>/^[a-f0-9-]{36}$/.test(row.id) && row.path===`${row.id}.json`));})
          .catch(()=>{});
        call(connector,"",undefined,abort.signal).then(async value=>{
          if(abort.signal.aborted)return;setListing(value);
          let id;
          try{id=localStorage.getItem("kalshi.quant.last-forward.v2");}catch{}
          const item=value.runs.find(row=>row.id===id) || value.runs[0];
          if(item){const restored=await call(connector,`?id=${encodeURIComponent(item.id)}`,undefined,abort.signal);if(!abort.signal.aborted)accept(restored);}
        }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
        const timer=setInterval(()=>setClock(Date.now()),1000);
        return()=>{abort.abort();clearInterval(timer);};
      },[connector]);
      async function checkpoint(id) {
        setBusy("Observing future books");setError("");
        try {
          const value=await call(connector,"/checkpoint",{id},controller.current?.signal);
          setRun(previous=>previous?.id===id ? value : previous);await refresh();
        }catch(e){if(e.name!=="AbortError")setError(e.message);}
        finally{setBusy("");}
      }
      React.useEffect(()=>{
        if(run?.status!=="pending")return;
        const wait=Math.max(0,Date.parse(run.frozen.due_at)-(Date.now()-clockOffset.current));
        const timer=setTimeout(()=>checkpoint(run.id),wait+500);
        return()=>clearTimeout(timer);
      },[run?.id,run?.status,run?.frozen.due_at,connector]);
      async function start() {
        setBusy("Freezing protocol & live inputs");setError("");
        try {
          const value=await call(connector,"/start",{categories:selected,seconds,per_category:Number(breadth),contracts:Number(quantity),coefficient:Number(fee),slippage:2},controller.current?.signal);
          accept(value);await refresh();
        }catch(e){if(e.name!=="AbortError")setError(e.message);}
        finally{setBusy("");}
      }
      async function load(id) {
        setError("");
        try {accept(await call(connector,`?id=${encodeURIComponent(id)}`));}catch(e){setError(e.message);}
      }
      const pending=run?.status==="pending",remaining=pending ? Math.max(0,Math.ceil((Date.parse(run.frozen.due_at)-(clock-clockOffset.current))/1000)) : 0;
      const protocolGroup=listing.aggregates?.find(item=>item.protocol_hash===run?.protocol_hash);
      const summary=aggregate && protocolGroup ? protocolGroup.summary : run?.result?.summary || [];
      const validInputs=selected.length && quantity!=="" && Number.isInteger(Number(quantity)) && Number(quantity)>0 && Number(quantity)<=1000 &&
        ["1","2"].includes(breadth) && fee!=="" && Number.isFinite(Number(fee)) && Number(fee)>=0 && Number(fee)<=1;
      return h(dataApp.DataComponent,{id:"qf-forward",queryId:"scenarios",kind:"table",variant:"card",title:"Forward engine · freeze now, observe later",sourceRows:summary,displayRows:summary,
        description:"Prospective 60-second / 5-minute / 15-minute quote markouts. All declared strategies, abstentions and losses are retained. No actual orders are placed."},
        h("div",{className:"qf-engine"},
          h("div",{className:"qf-status"},
            h("div",null,h("strong",null,pending ? remaining ? `${remaining}s to out-of-sample observation` : "Collecting the held-out observation…" : run?.result ? "Future observation recorded" : "No forward cohort frozen yet"),
              note(pending ? "Predictions and cost assumptions are locked. The server rejects early checkpoints; the browser requests new order books after the due time." :
                "Balanced quotas across five categories—not a TSA-only test. Short-horizon markouts and final-settlement probability scores are separate experiments.")),
            h(Button,{type:"button",disabled:!!busy || pending || !validInputs,onClick:start},busy || "Freeze balanced cohort")),
          h("details",{className:"qi-controls"},h("summary",null,"Preregistered experiment settings"),
            h("div",{className:"km-verticals",role:"group","aria-label":"Forward categories"},
              ...categories.map(([id,label])=>h(Button,{key:id,type:"button",disabled:pending || !!busy,"aria-pressed":selected.includes(id),
                onClick:()=>setSelected(previous=>previous.includes(id) ? previous.filter(item=>item!==id) : [...previous,id])},label))),
            h("div",{className:"km-inputs"},
              h(Field,{label:"Contracts per hypothesis",value:quantity,set:setQuantity,min:1,max:1000,step:1,disabled:pending}),
              h(Field,{label:"Markets per category (1–2)",value:breadth,set:setBreadth,min:1,max:2,step:1,disabled:pending}),
              h(Field,{label:"Frozen taker fee coefficient",value:fee,set:setFee,min:0,max:1,step:.0025,disabled:pending})),
            h("div",{className:"km-verticals",role:"group","aria-label":"Forward horizon"},
              ...[[60,"60 seconds"],[300,"5 minutes"],[900,"15 minutes"]].map(([value,label])=>h(Button,{key:value,type:"button",disabled:pending,"aria-pressed":seconds===value,onClick:()=>setSeconds(value)},label))),
            note("Selection is by liquidity and event diversity before future prices exist. Cost-filtered hypotheses abstain unless predicted price movement covers the spread, entry and exit fees, plus a 0.5¢ buffer. The unfiltered control exposes fee drag; it is not a recommendation.")),
          error && h("div",{role:"alert",className:"km-notice"},error),
          run && h("div",{className:"qf-proof"},
            h("span",null,`Cohort ${run.id}`),h("span",null,run.frozen.strategy_version),
            h("span",null,`${run.frozen.legs.filter(leg=>!leg.error).length} observed entry books · ${run.frozen.protocol.seconds}s protocol`),
            h("span",null,`Frozen fee c=${run.frozen.protocol.coefficient} · quantity ${run.frozen.protocol.contracts} · ${run.frozen.protocol.slippage}¢ slippage cap`),
            h("span",null,run.audit.verified ? "Audit chain verified" : "Audit unavailable")),
          h("div",{className:"km-toolbar"},
            h("div",{className:"km-verticals",role:"group","aria-label":"Forward evidence scope"},
              h(Button,{type:"button","aria-pressed":aggregate,onClick:()=>setAggregate(true)},"Identical-protocol aggregate"),
              h(Button,{type:"button","aria-pressed":!aggregate,onClick:()=>setAggregate(false)},"Selected cohort")),
            protocolGroup && note(`${protocolGroup.cohorts} frozen cohorts · ${protocolGroup.pending_cohorts} awaiting observation · ${protocolGroup.multiple_testing_family_size} registered candidate/protocol tests. Protocol variants are never mixed.`)),
          h("div",{className:"km-table-scroll"},h("table",{className:"km-table"},
            h("thead",null,h("tr",null,...["Predeclared candidate","Entries / closed","Gross paper markout","Modeled fees","Net paper markout","Price RMSE / persistence","Event groups","Evidence"].map(label=>h("th",{key:label},label)))),
            h("tbody",null,...summary.map(row=>h("tr",{key:row.strategy},
              h("th",{scope:"row"},row.name,h("small",{className:"qf-role"},row.role)),
              h("td",null,`${row.entries} / ${row.closed}`),
              h("td",null,dollars(row.gross_pnl)),h("td",null,dollars(row.fees)),
              h("td",{className:row.net_pnl>0 ? "km-bid" : ""},row.entries ? dollars(row.net_pnl) : "Abstained"),
              h("td",null,Number.isFinite(row.mean_squared_error) ? `${Math.sqrt(row.mean_squared_error).toFixed(4)} / ${Math.sqrt(row.persistence_mse).toFixed(4)}` : "—"),
              h("td",null,row.independent_event_groups),h("td",null,row.evidence)))))),
          !summary.length && h("div",{className:"km-empty"},"No synthetic performance history. Freeze a cohort to lock signals now; future prices are retrieved only after the chosen horizon."),
          note("Net P&L uses entry asks and exit bids with both modeled taker fees, not midpoint-to-midpoint paper profits. Partial exits, failed retrievals and observations over 30s late are exposed and excluded from complete-trade scoring. Strategy portfolios are hypothetical alternatives, not simultaneously executed fills."),
          run?.result && h("details",{className:"qi-provenance"},
            h("summary",null,"Observed per-contract outcomes & missing-data audit"),
            ...run.result.markouts.map(mark=>h("div",{key:mark.ticker,className:"qf-markout"},
              h("strong",null,`${mark.category} · ${mark.ticker}`),
              note(mark.error || `${mark.elapsed_seconds.toFixed(2)}s actual horizon · ${mark.on_time ? "within protocol window" : "late, excluded from horizon scoring"} · YES midpoint ${percent(mark.entry_mid)} → ${percent(mark.exit_mid)}`),
              !mark.error && h("div",{className:"km-table-scroll"},h("table",{className:"km-table"},
                h("thead",null,h("tr",null,...["Candidate","Forecast YES mid","Action","Entry / exit filled","Unliquidated","Net paper P&L"].map(label=>h("th",{key:label},label)))),
                h("tbody",null,...mark.signals.map(signal=>h("tr",{key:signal.strategy},h("th",{scope:"row"},signal.name),
                  h("td",null,percent(signal.predicted_yes_mid)),h("td",null,signal.action),
                  h("td",null,signal.quantity ? `${signal.quantity} / ${signal.exit?.filled ?? 0}` : "—"),
                  h("td",null,signal.remaining_quantity ?? "—"),h("td",null,dollars(signal.net_pnl)))))))))),
          run && h("details",{className:"qi-provenance"},h("summary",null,"Frozen inputs, model diagnostics & inference limits"),
            ...run.frozen.legs.map(leg=>h("div",{key:leg.ticker,className:"qf-markout"},h("strong",null,`${leg.category} · ${leg.ticker}`),
              note(leg.error || `${leg.ridge.available ? `Ridge: ${leg.ridge.n} observed minute pairs, chronological holdout skill ${percent(leg.ridge.evaluation.rmse_skill)}` : leg.ridge.reason} · ${leg.ou?.available ? `OU: ${leg.ou.n} observed irregular transitions, held-out likelihood gain ${leg.ou.evaluation.heldout_nll_gain.toFixed(4)}` : leg.ou?.reason || "No irregular-time model in this older cohort"} · source probability ${percent(leg.final_outcome_probability)} is a separate settlement-horizon forecast.`))),
            note("Candidates: purged ridge returns, irregular-time OU reversion, queue / signed-flow pressure, external-source reversion, weighted isotonic relative value, a robust median ensemble and an unfiltered diagnostic control. Sparse quote histories are modeled at their real observation gaps, never by inventing missing bars."),
            note("Confidence intervals resample whole recorded event groups, with a familywise correction across all candidates. Fewer than 30 event groups, missing pending outcomes or incomplete exits cannot demonstrate positive forward evidence. Even positive paper evidence is not proof of actual executable profitability."),
            h("p",{className:"qi-hash"},`Latest audit SHA-256: ${run.audit.last_hash}`),note(run.storage)),
          h("div",{className:"km-export-actions"},
            h(Button,{type:"button",disabled:!run,onClick:()=>download([run],`kalshi-${run.id}-forward-audit.csv`)},"Export frozen protocol & observed outcomes"),
            h(Button,{type:"button",disabled:!!busy,onClick:()=>refresh().catch(e=>setError(e.message))},"Refresh server-local archive")),
          listing.runs.length>0 && h("details",{className:"qi-provenance"},h("summary",null,`Cohort archive · ${listing.runs.length} frozen protocols`),
            h("div",{className:"km-export-actions"},...listing.runs.slice(0,10).map(item=>h(Button,{key:item.id,type:"button",disabled:!!busy,onClick:()=>load(item.id)},`${item.created_at ? new Date(item.created_at).toLocaleTimeString() : item.id} · ${item.status}`)))),
          evidence.length>0 && h("details",{className:"qi-provenance"},
            h("summary",null,`Archived validation evidence · ${evidence.length} recorded runs, not live cohorts`),
            note("These dated validation artifacts are retained across publishing, including losses. They are not automatically merged into current server-local performance or represented as actual fills."),
            h("div",{className:"km-table-scroll"},h("table",{className:"km-table"},
              h("thead",null,h("tr",null,...["Recorded UTC","Version","Control entries","Control net paper P&L","Replayable audit"].map(label=>h("th",{key:label},label)))),
              h("tbody",null,...evidence.map(row=>h("tr",{key:row.id},
                h("th",{scope:"row"},row.recorded_at),h("td",null,row.strategy_version),h("td",null,row.control_entries),
                h("td",null,dollars(row.control_net_pnl)),
                h("td",null,h("a",{href:new URL(`./evidence/${row.path}`,document.baseURI).href,download:row.path},"Download original record")))))))),
          note("Runs live in bounded server-local files, not a shared cloud database. Keep this tab open for the timed observation, or run the documented Python collector. Export results before redeploying; another server instance may not have the same archive.")
        ));
    };
  }
  root.KalshiForwardLab={createPanel};
})(globalThis);
