(function(root) {
  "use strict";
  const categories=[
    {id:"crypto",name:"Bitcoin & Ether",short:"Crypto",vertical:"Crypto"},
    {id:"weather",name:"Temperature",short:"Weather",vertical:"Weather"},
    {id:"labor",name:"Unemployment",short:"Labor",vertical:"Macro"},
    {id:"inflation",name:"Inflation",short:"Inflation",vertical:"Macro"},
    {id:"travel",name:"TSA travel",short:"Travel",vertical:"Travel"}
  ];
  const pct=value=>Number.isFinite(value) ? `${(value*100).toFixed(1)}%` : "—";
  const pp=value=>Number.isFinite(value) ? `${value>=0 ? "+" : ""}${(value*100).toFixed(1)} pp` : "—";
  const money=value=>Number.isFinite(value) ? value.toLocaleString("en-US",{style:"currency",currency:"USD"}) : "—";
  const number=value=>Number.isFinite(value) ? value.toLocaleString("en-US",{maximumFractionDigits:2}) : "—";
  const time=value=>value ? new Date(value).toLocaleString() : "Unavailable";
  function paperScores(journal) {
    // One earliest forecast per contract. Repeated hypotheses must not inflate forecast accuracy.
    const first=new Map();
    for(const row of [...journal].sort((a,b)=>String(a.recorded_at).localeCompare(String(b.recorded_at)))) {
      if(!first.has(row.ticker))first.set(row.ticker,row);
    }
    const resolved=[...first.values()].filter(row=>row.outcome===0 || row.outcome===1);
    const paired=resolved.filter(row=>[row.probability,row.market_probability].every(value=>Number.isFinite(value) && value>=0 && value<=1));
    return {resolved:resolved.length,paired:paired.length,
      model_brier:paired.length ? paired.reduce((sum,row)=>sum+(row.probability-row.outcome)**2,0)/paired.length : null,
      market_brier:paired.length ? paired.reduce((sum,row)=>sum+(row.market_probability-row.outcome)**2,0)/paired.length : null};
  }
  const readJournal=()=>{
    try {
      const value=JSON.parse(localStorage.getItem("kalshi.quant.paper.v1") || "[]");
      return Array.isArray(value) ? value.filter(row=>typeof row.id==="string" && typeof row.ticker==="string" && Number.isFinite(row.probability)).slice(-100) : [];
    } catch {return [];}
  };
  function createPanel(React,dataApp) {
    const h=React.createElement,Button=dataApp.Button;
    const ForwardPanel=root.KalshiForwardLab?.createPanel(React,dataApp);
    const note=text=>h("p",{className:"km-note"},text);
    const link=(url,text)=>h("a",{href:url,target:"_blank",rel:"noreferrer"},text);
    const metric=(label,value)=>h("div",{className:"qi-kpi",key:label},h("span",null,label),h("strong",null,value));
    const definition=(label,value)=>h("div",{key:label},h("dt",null,label),h("dd",null,value));
    function Field({label,value,onChange,...props}) {
      return h("label",null,label,h("input",{type:"number",value,onChange:event=>onChange(event.target.value),...props}));
    }
    async function json(url,signal) {
      const response=await fetch(url,{signal,cache:"no-store"});
      const value=await response.json();
      if(!response.ok || value.error)throw new Error(value.error || `Research request failed (${response.status})`);
      return value;
    }
    return function Intelligence({connector="",onInspect,download}) {
      const [reports,setReports]=React.useState({}),[failures,setFailures]=React.useState({}),[busy,setBusy]=React.useState(false);
      const [active,setActive]=React.useState("all"),[modeledOnly,setModeledOnly]=React.useState(true),[search,setSearch]=React.useState("");
      const [analysis,setAnalysis]=React.useState(null),[analyzing,setAnalyzing]=React.useState(""),[analysisError,setAnalysisError]=React.useState("");
      const [quantity,setQuantity]=React.useState("100"),[slippage,setSlippage]=React.useState("2"),[coefficient,setCoefficient]=React.useState("0.07"),[bankroll,setBankroll]=React.useState("1000"),[risk,setRisk]=React.useState("1");
      const [journal,setJournal]=React.useState([]),[journalMessage,setJournalMessage]=React.useState(""),[settling,setSettling]=React.useState(false);
      const [clock,setClock]=React.useState(Date.now);
      const request=React.useRef(null),detailRequest=React.useRef(null),lastStart=React.useRef(0);
      React.useEffect(()=>{setJournal(readJournal());const timer=setInterval(()=>setClock(Date.now()),5000);return()=>clearInterval(timer);},[]);
      const run=React.useCallback(async(force=false)=>{
        if(Date.now()-lastStart.current<60000 && force)return;
        lastStart.current=Date.now();
        request.current?.abort();const controller=new AbortController();request.current=controller;
        setBusy(true);setFailures({});
        const timeout=setTimeout(()=>controller.abort(),90000);
        const queue=[...categories];
        const worker=async()=>{
          while(queue.length && !controller.signal.aborted) {
            const category=queue.shift();
            try {
              const value=await json(`${connector}/api/intelligence?category=${category.id}`,controller.signal);
              if(!controller.signal.aborted)setReports(previous=>({...previous,[category.id]:value}));
            } catch(error) {
              if(!controller.signal.aborted)setFailures(previous=>({...previous,[category.id]:error.message}));
            }
          }
        };
        try {await Promise.all([worker(),worker()]);}
        finally {clearTimeout(timeout);if(request.current===controller){setBusy(false);if(controller.signal.aborted)setAnalysisError("The scan timed out. Completed category reports remain visible; refresh to retry missing sources.");}}
      },[connector]);
      React.useEffect(()=>{
        setReports({});setAnalysis(null);lastStart.current=0;run();
        return()=>{request.current?.abort();detailRequest.current?.abort();};
      },[run]);
      const available=Object.values(reports),total=available.reduce((sum,report)=>sum+(report.summary?.markets || 0),0);
      const modeled=available.reduce((sum,report)=>sum+(report.summary?.modeled || 0),0);
      const candidates=available.reduce((sum,report)=>sum+(report.summary?.conservative_candidates || 0),0);
      const sourceCount=available.reduce((sum,report)=>sum+(report.sources?.length || 0),0);
      const report=active==="all" ? reports.labor || reports.travel || available[0] : reports[active];
      const rows=available.filter(item=>active==="all" || item.category.id===active)
        .flatMap(item=>item.markets.map(market=>({...market,category_id:item.category.id,category_name:item.category.name,quote_as_of:item.quote_lineage.find(line=>line.series===market.series)?.as_of})))
        .filter(row=>(!modeledOnly || row.probability!==undefined) && `${row.title} ${row.ticker}`.toLowerCase().includes(search.toLowerCase()))
        .sort((a,b)=>(b.evidence?.tier || 0)-(a.evidence?.tier || 0) || (b.conservative_edge ?? -Infinity)-(a.conservative_edge ?? -Infinity));
      const fresh=row=>row.quote_as_of && clock-Date.parse(row.quote_as_of)<=90000;
      const inputsValid=quantity!=="" && Number.isInteger(Number(quantity)) && Number(quantity)>0 && Number(quantity)<=1e6 &&
        [slippage,coefficient,bankroll,risk].every(value=>value!=="" && Number.isFinite(Number(value))) &&
        Number(slippage)>=0 && Number(slippage)<=100 && Number(coefficient)>=0 && Number(coefficient)<=1 &&
        Number(bankroll)>=0 && Number(risk)>=0 && Number(risk)<=100;
      async function inspect(row) {
        if(!inputsValid){setAnalysisError("Check the quantity, slippage, fee coefficient and budget inputs.");return;}
        detailRequest.current?.abort();const controller=new AbortController();detailRequest.current=controller;
        const timeout=setTimeout(()=>controller.abort(),60000);
        setAnalyzing(row.ticker);setAnalysisError("");setAnalysis(null);
        const params=new URLSearchParams({category:row.category_id,ticker:row.ticker,contracts:quantity,slippage,coefficient,bankroll,risk});
        try {
          const value=await json(`${connector}/api/intelligence/execution?${params}`,controller.signal);
          if(!controller.signal.aborted)setAnalysis(value);
        } catch(error) {
          if(detailRequest.current===controller)setAnalysisError(error.name==="AbortError" ? "Depth analysis timed out; no estimate was substituted." : error.message);
        } finally {clearTimeout(timeout);if(detailRequest.current===controller)setAnalyzing("");}
      }
      function storeJournal(value,message) {
        setJournal(value);
        try {localStorage.setItem("kalshi.quant.paper.v1",JSON.stringify(value));setJournalMessage(message);}
        catch {setJournalMessage("Browser storage is unavailable. This session still holds the record; export it before leaving.");}
      }
      function record() {
        if(!analysis || !Number.isFinite(analysis.forecast.probability) || !analysis.execution.filled ||
          Date.now()-Date.parse(analysis.book_as_of)>90000 || Date.now()>=Date.parse(analysis.market.close_time || analysis.forecast.close_time))return;
        const id=`${analysis.ticker}:${analysis.as_of}`;
        if(journal.some(row=>row.id===id)){setJournalMessage("This exact forecast is already recorded; its original timestamp was preserved.");return;}
        const row={
          id,ticker:analysis.ticker,category:analysis.category,recorded_at:new Date().toISOString(),model_as_of:analysis.as_of,
          model_version:analysis.model_version,probability:analysis.forecast.probability,
          probability_interval:analysis.forecast.interval,
          market_probability:[analysis.forecast.yes_bid,analysis.forecast.yes_ask].every(Number.isFinite) ? (analysis.forecast.yes_bid+analysis.forecast.yes_ask)/2 : null,
          side:analysis.execution.side,quantity:analysis.execution.filled,estimated_cost:analysis.execution.all_in,
          quote_as_of:analysis.book_as_of,source_as_of:analysis.forecast.source_as_of,source_url:analysis.forecast.source_url,source_sha256:analysis.forecast.source_sha256,
          rules:analysis.market.rules_primary,classification:"Unexecuted hypothetical depth-based fill, not actual trading P&L",outcome:null
        };
        storeJournal([...journal.filter(item=>item.id!==row.id),row].slice(-100),"Hypothesis saved in this browser only. Export it to preserve your research.");
      }
      async function settle() {
        setSettling(true);let value=[...journal],resolved=0,errors=0;
        try {
          for(const entry of [...new Map(value.filter(row=>row.outcome===null).map(row=>[row.ticker,row])).values()].slice(0,10)) {
            try {
              const result=await json(`${connector}/api/market?ticker=${encodeURIComponent(entry.ticker)}`);
              const outcome=result.market?.result;
              if(!["yes","no"].includes(outcome))continue;
              value=value.map(row=>row.ticker===entry.ticker && row.outcome===null ? {...row,outcome:outcome==="yes" ? 1 : 0,resolution_checked_at:result.as_of,
                resolution_source:result.source_url,paper_pnl:(row.side===outcome ? row.quantity : 0)-row.estimated_cost} : row);
              resolved++;
            } catch {errors++;}
          }
          storeJournal(value,`${resolved} official outcomes found; ${errors} lookup failures. At most 10 pending hypotheses checked per request.`);
        } finally {setSettling(false);}
      }
      const scores=paperScores(journal);
      const parameterChange=analysis && (Number(quantity)!==analysis.execution.requested || Number(slippage)!==analysis.assumptions.slippage_cents || Number(coefficient)!==analysis.assumptions.fee_coefficient || Number(bankroll)!==analysis.sizing.bankroll || Number(risk)!==analysis.sizing.risk_percent);
      const analysisFresh=analysis && clock-Date.parse(analysis.book_as_of)<=90000;
      const tradingOpen=analysis && clock<Date.parse(analysis.market.close_time || analysis.forecast.close_time);
      const chartRows=report?.chart || [],rankedCategories=[...categories].sort((a,b)=>{
        const best=id=>Math.max(-1,...(reports[id]?.markets || []).map(row=>row.conservative_edge ?? -1));
        const evidence=id=>Math.max(0,...(reports[id]?.markets || []).map(row=>row.evidence?.tier || 0));
        return evidence(b.id)-evidence(a.id) || best(b.id)-best(a.id);
      });
      const actionLabel=row=>`Inspect ${row.ticker}`;
      return h("section",{className:"qi-root","aria-label":"Independent quantitative research"},
        h("div",{className:"qi-hero"},
          h("div",null,h("span",{className:"km-series-tag"},"QUANT STRATEGY LAB · LIVE DATA / FORWARD EVIDENCE"),
            h("h2",null,"Quant strategy research."),
            h("p",{className:"qi-lede"},"Cross-category signal synthesis, frozen experimental protocols and cost-aware out-of-sample evaluation. Crypto, weather, labor, inflation and travel share the same research pipeline.")),
          h(Button,{type:"button",disabled:busy || clock-lastStart.current<60000,onClick:()=>run(true)},busy ? `Scanning ${Object.keys(reports).length} / 5 categories…` : "Refresh five-category scan")),
        h("div",{className:"qi-kpis"},
          metric("Open contracts covered",number(total)),metric("Independent probabilities",number(modeled)),
          metric("Screened positive-gap hypotheses",number(candidates)),metric("External datasets loaded",number(sourceCount))),
        h("div",{className:"qi-disclaimer"},"Evidence is measured, not branded. The forward engine tests price forecasts against future books after modeled entry and exit costs. Final YES/NO probability accuracy is scored only after official resolution. A large model/market gap alone is not evidence of profitable alpha."),
        ForwardPanel && h(ForwardPanel,{connector,download}),
        h("div",{className:"qi-category-grid"},...rankedCategories.map((category,index)=>{
          const data=reports[category.id],evaluation=data?.evaluation,best=data?.markets.find(row=>Number.isFinite(row.conservative_edge));
          return h(Button,{key:category.id,type:"button",className:"qi-category","aria-pressed":active===category.id,onClick:()=>setActive(category.id)},
            h("span",{className:"qi-category-order"},String(index+1).padStart(2,"0")),
            h("strong",null,category.name),h("span",null,data ? `${data.summary.modeled} modeled / ${data.summary.markets} contracts` : failures[category.id] ? "Source request failed" : "Collecting free data…"),
            h("span",{className:"qi-category-stat"},evaluation ? `Held-out RMSE skill: ${pct(evaluation.rmse_skill)}` : "No calibrated probability backtest"),
            evaluation && h("span",null,`80% interval coverage: ${pct(evaluation.interval_80_coverage)}`),
            h("span",null,best ? `Best stress gap: ${pp(best.conservative_edge)}` : "No eligible model comparison"));
        })),
        h("div",{className:"km-toolbar"},
          h("div",{className:"km-verticals",role:"group","aria-label":"Research category"},
            h(Button,{type:"button","aria-pressed":active==="all",onClick:()=>setActive("all")},"All five"),
            ...categories.map(category=>h(Button,{key:category.id,type:"button","aria-pressed":active===category.id,onClick:()=>setActive(category.id)},category.short))),
          h("label",{className:"km-search"},h("span",null,"Find a research contract"),h("input",{value:search,onChange:event=>setSearch(event.target.value),placeholder:"Search title or ticker"})),
          h("label",{className:"km-auto"},h("input",{type:"checkbox",checked:modeledOnly,onChange:event=>setModeledOnly(event.target.checked)}),"Modeled only")),
        h(dataApp.DataComponent,{id:"qi-scanner",queryId:"scenarios",kind:"table",title:"Model vs market · ranked research hypotheses",variant:"card",
          sourceRows:rows,displayRows:rows,description:"Evidence tier first, fee-adjusted stress gap second. Failed underlying holdouts are flagged; no model has demonstrated a trading win rate. Stale quote comparisons are withheld."},
          h("div",{className:"km-table-scroll qi-scanner-scroll"},h("table",{className:"km-table"},
            h("thead",null,h("tr",null,...["Contract / target","Market YES bid / ask","Model YES","Model band","Research side","After-fee gap","Stress gap","Evidence"].map(text=>h("th",{key:text},text)))),
            h("tbody",null,...rows.slice(0,150).map(row=>h("tr",{key:row.ticker,className:analysis?.ticker===row.ticker ? "is-selected" : ""},
              h("th",{scope:"row"},h(Button,{type:"button",className:"km-contract-select","aria-label":actionLabel(row),disabled:!!analyzing,onClick:()=>inspect(row)},
                row.title,h("small",null,`${row.category_name} · ${row.ticker}`))),
              h("td",null,`${pct(row.yes_bid)} / ${pct(row.yes_ask)}`),
              h("td",null,pct(row.probability)),h("td",null,row.interval ? `${pct(row.interval[0])}–${pct(row.interval[1])}` : "—"),
              h("td",null,row.side ? `Buy ${row.side.toUpperCase()}` : "—"),
              h("td",{className:fresh(row) && row.estimated_edge>0 && row.evidence?.tier>0 ? "km-bid" : ""},fresh(row) ? pp(row.estimated_edge) : "Stale quote"),
              h("td",{className:fresh(row) && row.conservative_edge>0 && row.evidence?.tier>0 ? "km-bid" : ""},fresh(row) ? pp(row.conservative_edge) : "Withheld"),
              h("td",null,row.evidence?.label || row.reason))))),
            !rows.length && h("div",{className:"km-empty"},busy ? "Computing forecasts from the free source datasets…" : "No eligible rows match. Turn off “Modeled only” to inspect exactly why contracts were withheld."),
            rows.length>150 && note("Showing the highest-ranked 150 rows. The full scan is available in the research export."))),
        h("details",{className:"qi-controls"},
          h("summary",null,"Execution and sizing assumptions"),
          h("div",{className:"km-inputs"},
            h(Field,{label:"Research contracts",value:quantity,onChange:setQuantity,min:1,max:1000000,step:1}),
            h(Field,{label:"Slippage cap (¢)",value:slippage,onChange:setSlippage,min:0,max:100,step:.5}),
            h(Field,{label:"Assumed taker fee coefficient",value:coefficient,onChange:setCoefficient,min:0,max:1,step:.0025}),
            h(Field,{label:"Hypothetical bankroll ($)",value:bankroll,onChange:setBankroll,min:0}),
            h(Field,{label:"Loss-budget limit (%)",value:risk,onChange:setRisk,min:0,max:100,step:.25})),
          note("The scan uses a 100-contract catalog fee approximation. Inspecting a contract retrieves its current depth and rules and recomputes the actual modeled filled portion with these inputs.")),
        analyzing && h("div",{className:"km-notice",role:"status"},`Retrieving fresh depth, full rules and external model evidence for ${analyzing}…`),
        analysisError && h("div",{className:"km-notice",role:"alert"},analysisError),
        analysis && h(dataApp.DataComponent,{id:"qi-thesis",queryId:"scenarios",kind:"table",title:"The trade thesis · what must be true",variant:"card",sourceRows:[analysis],displayRows:[analysis]},
          h("div",{className:"qi-thesis"},
            h("div",{className:"qi-thesis-heading"},h("div",null,h("span",{className:"km-series-tag"},`${analysis.category.toUpperCase()} · ${analysis.model_version}`),h("h3",null,analysis.forecast.title)),
              h("div",null,h("strong",{className:"qi-probability"},pct(analysis.forecast.probability)),h("span",null," Independent P(YES) · estimate"))),
            !analysisFresh && h("div",{className:"km-notice"},"Book snapshot is stale. Refresh the analysis before using its execution numbers."),
            !tradingOpen && h("div",{className:"km-notice"},"Trading close has passed or is unknown. New paper records and probability transfers are disabled."),
            analysis.forecast.evidence?.tier===0 && h("div",{className:"km-notice"},`${analysis.forecast.evidence.label}. Hypothetical Kelly sizing is disabled; a large model/market disagreement is not evidence of an opportunity.`),
            parameterChange && h("div",{className:"km-notice"},"Your inputs changed after this analysis. Re-inspect the contract to recompute it."),
            h("div",{className:"km-scenarios"},
              h("div",null,h("h3",null,"Independent evidence"),
                h("dl",{className:"km-definitions"},
                  definition("Model",analysis.forecast.model_name || "Withheld"),
                  definition("Underlying forecast",`${number(analysis.forecast.center)} ${reports[analysis.category]?.category.unit || ""}`),
                  definition("80% value range",analysis.forecast.range_80 ? analysis.forecast.range_80.map(number).join(" – ") : "—"),
                  definition("P(YES) sensitivity / interval",analysis.forecast.interval ? analysis.forecast.interval.map(pct).join(" – ") : "—"),
                  definition("Forecast residual / return samples",number(analysis.forecast.n)),
                  definition("Target observation date",analysis.forecast.target_date || "Unmatched"),
                  definition("Source retrieved",time(analysis.forecast.source_as_of))),
                note(analysis.forecast.interval_kind || analysis.forecast.reason),
                h("p",{className:"km-note"},analysis.forecast.source_url && link(analysis.forecast.source_url,analysis.forecast.source_name))),
              h("div",null,h("h3",null,"Price, fees & execution"),
                h("dl",{className:"km-definitions"},
                  definition("Research side",analysis.execution.side.toUpperCase()),
                  definition("Estimated filled / requested",`${number(analysis.execution.filled)} / ${number(analysis.execution.requested)}`),
                  definition("Estimated VWAP",money(analysis.execution.vwap)),
                  definition("Estimated fees",money(analysis.execution.fee)),
                  definition("All-in filled cost",money(analysis.execution.all_in)),
                  definition("Breakeven probability",pct(analysis.execution.breakeven)),
                  definition("Model expected P&L",money(analysis.expected_pnl)),
                  definition("Depth-adjusted stress gap",pp(analysis.conservative_edge)),
                  definition("Book retrieved",time(analysis.book_as_of)))),
              h("div",null,h("h3",null,"Risk & microstructure"),
                h("dl",{className:"km-definitions"},
                  definition("Quarter-Kelly · adverse model bound",pct(analysis.sizing.quarter_kelly_fraction)),
                  definition("Hypothetical loss budget",money(analysis.sizing.loss_budget)),
                  definition("Budget / visible-depth size cap",`${number(analysis.sizing.depth_and_budget_cap)} contracts`),
                  definition("Top-three-level depth imbalance",pct(analysis.microstructure.depth_imbalance)),
                  definition("YES microprice · not fair odds",pct(analysis.microstructure.microprice)),
                  definition("Bounded taker-flow imbalance",pct(analysis.microstructure.taker_flow_imbalance))),
                note("Kelly is a hypothetical calculation, not a recommendation. A fragile model can turn Kelly sizing into concentrated losses. Correlated positions are not included."))),
            h("details",null,h("summary",null,"Inspect model inputs, rules and failure modes"),
              h("dl",{className:"km-definitions"},...Object.entries(analysis.forecast.inputs || {}).map(([key,value])=>definition(key,Array.isArray(value) ? value.map(number).join(" / ") : typeof value==="number" ? number(value) : String(value)))),
              ...analysis.warnings.map((warning,index)=>h("p",{className:"km-note",key:index},warning)),
              h("h3",null,"Primary resolution rule"),h("p",null,analysis.market.rules_primary || "Not returned"),
              analysis.market.rules_secondary && h("p",null,analysis.market.rules_secondary)),
            h("div",{className:"km-export-actions"},
              h(Button,{type:"button",disabled:!Number.isFinite(analysis.forecast.probability) || !analysisFresh || !tradingOpen || parameterChange || analysis.forecast.evidence?.tier===0,
                onClick:()=>onInspect?.({ticker:analysis.ticker,vertical:categories.find(item=>item.id===analysis.category).vertical,
                  probability:analysis.forecast.probability,side:analysis.execution.side,as_of:analysis.as_of,model_version:analysis.model_version})},"Send model probability to sizing"),
              h(Button,{type:"button",disabled:!Number.isFinite(analysis.forecast.probability) || !analysis.execution.filled || !analysisFresh || !tradingOpen || parameterChange,onClick:record},"Record paper hypothesis"),
              h(Button,{type:"button",onClick:()=>download([analysis],`${analysis.ticker}-quant-thesis.csv`)},"Export full thesis")))),
        report && h("div",{className:"qi-evidence-grid"},
          h(dataApp.EvidenceChart,{id:"qi-holdout",queryId:"scenarios",title:`${report.category.name} · ${report.evaluation ? "chronological holdout" : "source observations"}`,variant:"card",
            rows:chartRows,sourceRows:chartRows,height:260,spec:{type:"line",x:"date",y:"observed",fields:report.evaluation ? ["observed","forecast","baseline"] : ["observed"],valueDecimals:2,stackable:false},
            description:report.evaluation ? "The held-out underlying values were not used to fit ensemble weights or the error distribution. This is not a first-release-vintage or historical trading P&L backtest." : "Observed source values only. Forecast-error calibration is unavailable for this model family."}),
          h(dataApp.DataComponent,{id:"qi-validation",queryId:"scenarios",kind:"table",title:"What has actually been tested",variant:"card",sourceRows:[report.evaluation || {}],displayRows:[report.evaluation || {}]},
            report.evaluation ? h("div",null,h("dl",{className:"km-definitions"},
              definition("Held-out observations",number(report.evaluation.n)),
              definition("Mean absolute forecast error",`${number(report.evaluation.mae)} ${report.category.unit}`),
              definition("Root mean squared error",number(report.evaluation.rmse)),
              definition("Naive-baseline RMSE",number(report.evaluation.baseline_rmse)),
              definition("RMSE skill vs naive",pct(report.evaluation.rmse_skill)),
              definition("80% range · observed coverage",pct(report.evaluation.interval_80_coverage))),
              note("Negative RMSE skill means the model underperformed the naive baseline. Chronological evaluation uses today’s revised history, not the original release vintages. Probability calibration and trading alpha remain unproven."))
              : h("div",null,h("p",{className:"km-notice"},"No calibrated forecast backtest is available for this model family."),note("Sensitivity bands expose explicit assumptions. Do not read a numerical probability as evidence of historical accuracy.")))),
        h("details",{className:"qi-provenance"},
          h("summary",null,`Source ledger & raw observations · ${sourceCount} loaded datasets`),
          h("div",{className:"qi-source-grid"},...available.flatMap(item=>item.sources.map(source=>h("div",{key:`${item.category.id}:${source.source_url}`,className:"qi-source"},
            h("h3",null,source.name),h("dl",{className:"km-definitions"},
              definition("Observations",number(source.row_count)),definition("Latest observation",time(source.latest_observation)),
              definition("Retrieved",time(source.retrieved_at)),definition("Source mode",source.snapshot ? "Archived real-data snapshot" : "Retrieved source data")),h("p",{className:"km-note"},link(source.source_url,"Open original source")),
            source.snapshot && h("p",{className:"km-notice"},`Live source request failed: ${source.fallback_reason}. Original snapshot retrieval time is preserved; no history was synthesized.`),
            note(source.revision_note),h("p",{className:"qi-hash"},`SHA-256 ${source.sha256}`),
            h("div",{className:"km-table-scroll"},h("table",{className:"km-table"},
              h("thead",null,h("tr",null,h("th",null,"Observation"),h("th",null,source.unit))),
              h("tbody",null,...source.rows.slice(-5).reverse().map(row=>h("tr",{key:row.date},h("th",{scope:"row"},row.date),h("td",null,number(row.value)))))))))))),
        h("details",{className:"qi-provenance"},
          h("summary",null,"Related-market consistency scanner"),
          note("A lower threshold must imply at least as much YES probability as a higher threshold, holding source and settlement conditions fixed. These are catalog inconsistencies, not guaranteed executable arbitrages."),
          ...available.flatMap(item=>item.coherence || []).slice(0,30).map(finding=>h("div",{className:"km-notice",key:`${finding.long_yes}:${finding.long_no}`},
            h("strong",null,`${finding.long_yes} YES + ${finding.long_no} NO`),
            h("p",null,`Indicative combined cost ${money(finding.indicative_cost)}; fee-adjusted minimum-margin estimate ${money(finding.indicative_minimum_margin)} per paired contract.`),note(finding.caveat))),
          !available.some(item=>item.coherence?.length) && note("No nested-threshold catalog violations survived the fee approximation in the covered markets.")),
        h(dataApp.DataComponent,{id:"qi-paper",queryId:"scenarios",title:"Prediction journal · prove or reject the edge",kind:"table",variant:"card",sourceRows:journal,displayRows:journal},
          h("div",null,
            note("Browser-local research records only. No order is placed and no real fill is claimed. Official resolutions can score archived predictions, not retroactively improve them. Export regularly; clearing browser data removes these records."),
            h("div",{className:"qi-kpis"},metric("Recorded hypotheses",number(journal.length)),metric("Officially resolved markets",number(scores.resolved)),
              metric("Model Brier · lower is better",number(scores.model_brier)),metric("Recorded market-midpoint Brier",number(scores.market_brier))),
            note(`Scores use ${scores.paired} paired first forecasts with a valid recorded market midpoint. Repeated contracts and missing quote benchmarks do not inflate accuracy.`),
            scores.resolved<50 && note("Fewer than 50 unique resolved markets: insufficient evidence to claim a calibrated probability advantage. Correlated sibling outcomes also reduce the effective sample."),
            h("div",{className:"km-table-scroll"},h("table",{className:"km-table"},h("thead",null,h("tr",null,...["Recorded","Contract / side","Model YES","Market midpoint","Official YES result","Hypothetical P&L"].map(text=>h("th",{key:text},text)))),
              h("tbody",null,...journal.slice(-12).reverse().map(row=>h("tr",{key:row.id},
                h("th",{scope:"row"},time(row.recorded_at)),h("td",null,`${row.ticker} · ${row.side.toUpperCase()}`),h("td",null,pct(row.probability)),
                h("td",null,pct(row.market_probability)),h("td",null,row.outcome===null ? "Pending" : row.outcome ? "YES" : "NO"),h("td",null,money(row.paper_pnl))))))),
            !journal.length && h("div",{className:"km-empty"},"Inspect a contract and record a timestamped hypothesis. The journal starts empty; no synthetic track record is supplied."),
            journalMessage && h("p",{className:"km-note",role:"status"},journalMessage),
            h("div",{className:"km-export-actions"},h(Button,{type:"button",disabled:settling || !journal.some(row=>row.outcome===null),onClick:settle},settling ? "Checking official outcomes…" : "Check official outcomes"),
              h(Button,{type:"button",disabled:!journal.length,onClick:()=>download(journal,"kalshi-model-journal.csv")},"Export prediction journal")))),
        h("details",{className:"qi-provenance"},
          h("summary",null,"Methods, limits & data quality"),
          h("p",null,"TSA uses three weekday-seasonal estimators. Inflation and labor use persistence, a shrunken recent-change forecast and ridge-regularized AR(1) changes. Inverse training-error weights form the ensemble; an untouched chronological holdout measures underlying-value error. Empirical forecast residuals turn supported numeric strikes into probabilities."),
          h("p",null,"Weather combines NWS hourly temperatures and the matching station’s observed maximum with explicit, uncalibrated error assumptions. Crypto uses completed Coinbase hourly candles, EWMA volatility, heavily shrunken drift and a volatility/drift stress grid. These proxy models require careful settlement-source and timing checks."),
          note("The five categories are selected for free numerical data, repeated measurable outcomes and a plausible model-to-contract mapping—not a demonstrated ranking of future profitability. Categories are ordered by evidence tier, then strongest stress gap. Negative RMSE skill or less than 70% observed coverage of an 80% interval triggers a validation warning and disables Kelly sizing. A failed source, missing strike, unsupported horizon or mismatched definition withholds the probability instead of filling it in."),
          ...available.map(item=>h("p",{key:item.category.id,className:"km-note"},`${item.category.name}: ${item.coverage.map(row=>`${row.series}: ${row.records}${row.truncated ? " (first page only)" : ""}`).join("; ")}. ${item.errors.join(" · ")}`)),
          ...Object.entries(failures).map(([id,error])=>h("p",{className:"km-notice",role:"alert",key:id},`${id}: ${error}`))),
        h("div",{className:"km-export-actions"},
          h(Button,{type:"button",disabled:!available.length,onClick:()=>download(available.map(item=>({category:item.category.id,...item,classification:"Unvalidated research estimates; source snapshots and assumptions included"})),"kalshi-five-category-research.csv")},"Export all research & source data"),
          h("span",{className:"km-note"},"Free public sources. No paid data service, cloud account or automated trading required."))
      );
    };
  }
  root.KalshiIntelligence={createPanel,paperScores};
})(globalThis);
