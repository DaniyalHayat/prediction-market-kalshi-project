/* Shared, dependency-free research calculations; the UI uses the dashboard's React. */
(function (root) {
  "use strict";
  const numeric = value => value === null || value === undefined || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Number(value);
  const round = value => Math.round(value * 1e10) / 1e10;
  function levels(raw, side) {
    const fp = raw?.orderbook_fp;
    if (!fp || !["yes", "no"].includes(side)) throw new Error("A fixed-point book and YES or NO side are required.");
    const read = key => {
      const map = new Map();
      if (fp[key] !== undefined && !Array.isArray(fp[key])) throw new Error("Invalid book levels.");
      for (const row of fp[key] || []) {
        if (!Array.isArray(row) || row.length !== 2) throw new Error("Invalid book level.");
        const p = numeric(row[0]), q = numeric(row[1]);
        if (p === null || q === null || p < 0 || p > 1 || q < 0) throw new Error("Invalid price or depth.");
        if (q) map.set(p, (map.get(p) || 0) + q);
      }
      return [...map].sort((a, b) => b[0] - a[0]);
    };
    const yes = read("yes_dollars"), no = read("no_dollars");
    if (yes.length && no.length && yes[0][0] + no[0][0] > 1 + 1e-10) throw new Error("Crossed book: execution estimates are withheld.");
    return (side === "yes" ? no : yes).map(([p, q]) => [round(1 - p), q]).sort((a, b) => a[0] - b[0]);
  }
  function simulate(raw, side, quantity, {slippage = 2, coefficient = .07, multiplier = 1} = {}) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1e6) throw new Error("Enter 1–1,000,000 whole contracts.");
    if (![slippage, coefficient, multiplier].every(Number.isFinite) || slippage < 0 || slippage > 100 || coefficient < 0 || coefficient > 1 || multiplier < 0 || multiplier > 100) throw new Error("Check the slippage and fee assumptions.");
    const asks = levels(raw, side), best = asks[0]?.[0] ?? null;
    const limit = best === null ? null : Math.min(1, round(best + slippage / 100));
    let remaining = quantity, cost = 0, fee = 0, filled = 0, available = 0;
    const fills = [];
    for (const [price, depth] of asks) {
      if (price > limit + 1e-10) break;
      available += depth;
      const take = Math.min(remaining, depth);
      if (take <= 0) continue;
      // Round each aggregated price level up; actual per-execution billing may differ.
      const levelFee = Math.max(0, Math.ceil((coefficient * multiplier * take * price * (1 - price) - 1e-10) * 100) / 100);
      cost += take * price; fee += levelFee; filled += take; remaining -= take;
      fills.push({price, quantity: take, fee: levelFee, cumulative: round(filled)});
    }
    const allIn = round(cost + fee);
    return {side, requested: quantity, filled: round(filled), unfilled: round(remaining), available: round(available), best, limit,
      cost: round(cost), fee: round(fee), allIn, vwap: filled ? round(cost / filled) : null,
      slippage: filled ? round((cost / filled - best) * 100) : null,
      breakeven: filled ? round(allIn / filled) : null,
      winPnl: filled ? round(filled - allIn) : null, lossPnl: filled ? -allIn : null, fills};
  }
  function sizePosition(raw, side, budget, options) {
    if (!Number.isFinite(budget) || budget < 0) throw new Error("Enter a nonnegative loss budget.");
    const depth = simulate(raw, side, 1, options).available;
    let low = 0, high = Math.min(1e6, Math.floor(depth));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (simulate(raw, side, middle, options).allIn <= budget + 1e-10) low = middle;
      else high = middle - 1;
    }
    return low;
  }
  function createWorkbench(React, dataApp) {
    const h = React.createElement;
    const money = n => n === null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", {style:"currency", currency:"USD"});
    const count = n => n === null ? "—" : n.toLocaleString("en-US", {maximumFractionDigits:2});
    const cents = n => n === null ? "—" : `${(n * 100).toFixed(2)}¢`;
    const when = t => t ? new Date(t).toLocaleString() : "Not retrieved";
    const note = text => h("p", {className:"km-note"}, text);
    const metric = (label, value) => h("span", {key:label}, label, h("strong", null, value));
    const definition = (label, value) => h("div", {key:label}, h("dt", null, label), h("dd", null, value));
    function Field({label, value, setValue, ...props}) {
      return h("label", null, label, h("input", {type:"number", value, onChange:e=>setValue(e.target.value), ...props}));
    }
    return function Workbench({selected, book, live, connector, contracts, setContracts, download, modelTransfer}) {
      const [side, setSide] = React.useState("yes"), [slippage, setSlippage] = React.useState("2");
      const [coefficient, setCoefficient] = React.useState("0.07"), [multiplier, setMultiplier] = React.useState("1");
      const [bankroll, setBankroll] = React.useState("1000"), [risk, setRisk] = React.useState("1"), [probability, setProbability] = React.useState("50");
      const [details, setDetails] = React.useState(null), [ruleError, setRuleError] = React.useState(""), [reviewed, setReviewed] = React.useState([]);
      const [clock, setClock] = React.useState(Date.now);
      const [transferredModel, setTransferredModel] = React.useState(null);
      React.useEffect(() => {
        if (modelTransfer && selected && modelTransfer.ticker === selected.ticker && Number.isFinite(modelTransfer.probability)) {
          setProbability((modelTransfer.probability*100).toFixed(2));
          if (["yes","no"].includes(modelTransfer.side)) setSide(modelTransfer.side);
          setTransferredModel(modelTransfer);
        }
      }, [modelTransfer, selected?.ticker]);
      React.useEffect(() => {
        const timer = setInterval(() => setClock(Date.now()), 5000);
        return () => clearInterval(timer);
      }, []);
      React.useEffect(() => {
        if (!selected) return;
        let active = true;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
        fetch(`${connector}/api/market?ticker=${encodeURIComponent(selected.ticker)}`, {signal:controller.signal, cache:"no-store"})
          .then(async response => {if (!response.ok) throw new Error("Resolution details unavailable. Verify on Kalshi before trading."); return response.json();})
          .then(value => {
            if (value.market?.ticker !== selected.ticker) throw new Error("Market rules did not match the selected ticker.");
            if (active) setDetails(value);
          })
          .catch(() => {if (active) setRuleError("Resolution details unavailable. Verify on Kalshi before trading.");})
          .finally(() => clearTimeout(timer));
        return () => {active = false; controller.abort(); clearTimeout(timer);};
      }, [selected?.ticker, connector]);
      const current = book?.ticker === selected?.ticker ? book : null;
      const age = current ? Math.max(0, Math.floor((clock - Date.parse(current.as_of)) / 1000)) : null;
      const fresh = live && current && Number.isFinite(age) && age <= 90;
      const options = {slippage:numeric(slippage), coefficient:numeric(coefficient), multiplier:numeric(multiplier)};
      const bankrollN = numeric(bankroll), riskN = numeric(risk), p = numeric(probability);
      const budgetValid = bankrollN !== null && bankrollN >= 0 && riskN !== null && riskN >= 0 && riskN <= 100;
      const budget = budgetValid ? bankrollN * riskN / 100 : null;
      let execution = null, sized = null, error = "";
      if (fresh) {
        try {
          execution = simulate(current.raw, side, Number(contracts), options);
          if (budgetValid) sized = sizePosition(current.raw, side, budget, options);
        } catch (e) {error = e.message;}
      }
      const rule = details?.market;
      const sourceRule = rule?.rules_primary || selected?.rules_primary;
      const sideProbability = p !== null && p >= 0 && p <= 100 ? (side === "yes" ? p / 100 : 1 - p / 100) : null;
      const ev = execution?.filled && sideProbability !== null ? execution.filled * sideProbability - execution.allIn : null;
      const research = [{
        classification:"Hypothetical research estimate; not an order or executable quote", ticker:selected?.ticker,
        quote_as_of:current?.as_of, quote_source:current?.source_url, quote_fresh:!!fresh,
        side, requested_contracts:contracts, ...options, bankroll:bankrollN, risk_percent:riskN, loss_budget:budget,
        assumed_probability_yes_percent:p, estimate:execution, expected_pnl:ev, depth_limited_size:sized,
        transferred_model:transferredModel,
        rules_as_of:details?.as_of, rules_source:details?.source_url, primary_rules:sourceRule || null,
        secondary_rules:rule?.rules_secondary || null, reviewed_checks:reviewed
      }];
      const field = (label, value, setValue, props={}) => h(Field, {key:label, label, value, setValue, ...props});
      const body = h("div", null,
        h("div", {className:"km-notice"}, h("strong", null, "Estimates, not live quotes. "),
          "Uses only retrieved depth. Fees are editable assumptions, not a verified market fee schedule. No order is placed."),
        h("div", {className:`km-feed-status ${fresh ? "is-live" : "is-snapshot"}`, role:"status"},
          h("span", {className:"km-dot"}), h("strong", null, fresh ? "Public book snapshot" : current ? "Stale book · estimates withheld" : "Awaiting public depth"),
          h("span", null, when(current?.as_of)), age !== null && h("span", null, `${age}s old · 90s freshness cutoff`)),
        selected && note(`${selected.title} · ${selected.ticker}`),
        h("div", {className:"km-scenarios"},
          h("div", null,
            h("h3", null, "01 · Depth & execution"),
            h("div", {className:"km-verticals", role:"group", "aria-label":"Simulated purchase side"},
              ...["yes", "no"].map(value => h(dataApp.Button, {key:value, type:"button", "aria-pressed":side===value, onClick:()=>setSide(value)}, `Buy ${value.toUpperCase()}`))),
            h("div", {className:"km-inputs"},
              field("Requested contracts", contracts, value=>setContracts(value), {min:1, max:1000000, step:1}),
              field("Max slippage from best ask (¢)", slippage, setSlippage, {min:0, max:100, step:.5})),
            h("div", {className:"km-fill-summary"},
              metric("Estimated filled", execution ? `${count(execution.filled)} / ${count(execution.requested)}` : "—"),
              metric("Estimated VWAP", cents(execution?.vwap ?? null)),
              metric("Price slippage", execution ? `${execution.slippage?.toFixed(2) ?? "—"}¢` : "—")),
            execution && h("dl", {className:"km-definitions"},
              definition("Best ask · book snapshot", cents(execution.best)),
              definition("Maximum eligible price", cents(execution.limit)),
              definition("Visible depth within limit", `${count(execution.available)} contracts`),
              definition("Unfilled · not extrapolated", `${count(execution.unfilled)} contracts`)),
            error && h("p", {role:"alert", className:"km-notice"}, error),
            execution?.unfilled > 0 && h("p", {className:"km-notice"}, "Insufficient depth inside your slippage limit. Costs below apply only to the estimated filled portion."),
            !fresh && note("A fresh book for this exact contract is required. Refresh the market feed; saved quotes never produce an execution estimate."),
            note("YES asks = 1 − NO bids; NO asks = 1 − YES bids. Slippage is measured against the selected side’s best ask. Depth can vanish before an order arrives.")),
          h("div", null,
            h("h3", null, "02 · Fees & breakeven"),
            h("div", {className:"km-inputs"},
              field("Assumed taker coefficient", coefficient, setCoefficient, {min:0, max:1, step:.0025}),
              field("Assumed series multiplier", multiplier, setMultiplier, {min:0, max:100, step:.1})),
            h("dl", {className:"km-definitions"},
              definition("Estimated contract cost", money(execution?.cost ?? null)),
              definition("Estimated fees", money(execution?.fee ?? null)),
              definition("All-in cost / maximum loss", execution?.filled ? money(execution.allIn) : "—"),
              definition(`Breakeven P(${side.toUpperCase()})`, execution?.filled ? `${(execution.breakeven * 100).toFixed(2)}%` : "—"),
              definition("P&L if selected side wins", money(execution?.winPnl ?? null)),
              definition("P&L if selected side loses", money(execution?.lossPnl ?? null))),
            note("Fee estimate = ceil to cents(c × multiplier × filled quantity × price × (1 − price)) at each aggregated price level. Actual billing, maker fees and market-specific schedules may differ. No exit, settlement, tax or funding costs modeled."),
            h("p", {className:"km-note"}, h("a", {href:"https://kalshi.com/fee-schedule", target:"_blank", rel:"noreferrer"}, "Verify current fee schedule"))),
          h("div", null,
            h("h3", null, "03 · Position sizing"),
            h("div", {className:"km-inputs"},
              field("Hypothetical bankroll ($)", bankroll, setBankroll, {min:0, step:100}),
              field("Maximum loss budget (%)", risk, setRisk, {min:0, max:100, step:.25}),
              field("Your assumed P(YES) (%)", probability, value=>{setProbability(value);setTransferredModel(null);}, {min:0, max:100, step:1})),
            transferredModel && note(`Copied from unvalidated independent model ${transferredModel.model_version}, retrieved ${when(transferredModel.as_of)}. This is a research estimate, not verified fair odds.`),
            h("div", {className:"km-fill-summary"},
              metric("Loss budget", money(budget)),
              metric("Budget & depth cap", sized === null ? "—" : `${count(sized)} contracts`)),
            h("dl", {className:"km-definitions"},
              definition("Expected P&L · your probability", money(ev)),
              definition("Requested fill exceeds budget", execution?.filled && budget !== null ? execution.allIn > budget ? "Yes · reduce size" : "No" : "—")),
            h(dataApp.Button, {type:"button", disabled:!sized, onClick:()=>setContracts(sized)}, "Use budget-limited size"),
            !budgetValid && note("Bankroll must be nonnegative; loss budget must be between 0% and 100%."),
            sideProbability === null && note("Enter an assumed probability between 0% and 100% to estimate expected P&L."),
            note("The largest whole-contract size that fits the loss budget, estimated fees and visible depth inside your limit. Capped at 1,000,000 contracts. Not a recommendation; ignores correlated positions. The default 50% is a user scenario, not a forecast."))),
        execution?.fills.length > 0 && h("details", {className:"km-contract-detail"},
          h("summary", null, "Inspect modeled fills by price level"),
          h("div", {className:"km-table-scroll"}, h("table", {className:"km-table"},
            h("thead", null, h("tr", null, ...["Price", "Estimated fill", "Cumulative", "Estimated fee"].map(text=>h("th", {key:text}, text)))),
            h("tbody", null, ...execution.fills.map(fill=>h("tr", {key:fill.price},
              h("th", {scope:"row"}, cents(fill.price)), h("td", null, count(fill.quantity)), h("td", null, count(fill.cumulative)), h("td", null, money(fill.fee)))))))),
        h("div", {className:"km-export-actions"},
          h(dataApp.Button, {type:"button", disabled:!selected, onClick:()=>download(research, `kalshi-${selected.ticker}-research.csv`)}, "Export research & assumptions CSV")),
        h("div", {className:"km-connector"},
          h("h3", null, "04 · Resolution rules & pre-trade review"),
          note(details ? `Market details retrieved ${when(details.as_of)}. Closing, expiration and settlement are not the same event.` : !selected ? "Select a contract to review its resolution rules." : ruleError || "Loading full market rules…"),
          sourceRule ? h("details", {open:true, className:"km-contract-detail"},
            h("summary", null, details ? "Primary resolution rules · retrieved from Kalshi" : "Primary rules · catalog / saved snapshot"),
            h("p", null, sourceRule)) : h("p", {className:"km-notice"}, "Primary resolution criteria are missing. Do not infer the rules from the title."),
          rule?.rules_secondary && h("details", {className:"km-contract-detail"}, h("summary", null, "Secondary rules & exceptions"), h("p", null, rule.rules_secondary)),
          h("dl", {className:"km-definitions"},
            definition("Trading close · local timezone", when(rule?.close_time || selected?.close_time)),
            definition("Expected expiration · local timezone", when(rule?.expected_expiration_time)),
            definition("Latest expiration · local timezone", when(rule?.latest_expiration_time || rule?.expiration_time)),
            definition("May close early", typeof rule?.can_close_early === "boolean" ? rule.can_close_early ? "Yes · inspect early-close conditions" : "No" : "Not supplied"),
            definition("Market status / result", `${rule?.status || "Not supplied"} / ${rule?.result || "Unresolved or not supplied"}`)),
          rule?.early_close_condition && note(`Early-close condition: ${rule.early_close_condition}`),
          note("If no secondary rules are returned, that does not prove there are no exceptions. Confirm official settlement sources, revisions, postponements, cancellation terms and timezone on Kalshi. Your checks are session-only acknowledgements, not automated verification."),
          ...["I checked the exact YES criterion and official settlement source.", "I checked the close, expiration and source timezone.", "I reviewed exceptions, revisions and cancellation / postponement terms."].map((text, index) =>
            h("label", {className:"km-auto", key:index},
              h("input", {type:"checkbox", checked:reviewed.includes(index), disabled:!sourceRule, onChange:e=>setReviewed(previous=>e.target.checked ? [...previous, index] : previous.filter(item=>item!==index))}), text)),
          note(`${reviewed.length} / 3 acknowledged for this contract. Acknowledgements reset when you change contracts.`),
          details && h("p", {className:"km-note"}, h("a", {href:details.source_url, target:"_blank", rel:"noreferrer"}, "Inspect original market-detail response")),
          selected && h("p", {className:"km-note"}, h("a", {href:`https://kalshi.com/markets/${encodeURIComponent((selected.series || selected.ticker.split("-")[0]).toLowerCase())}`, target:"_blank", rel:"noreferrer"}, "Open series on Kalshi · confirm this exact ticker"))));
      return h(dataApp.DataComponent, {id:"km-research", queryId:"scenarios", title:"Trade research · execution, cost & risk",
        kind:"table", variant:"card", sourceRows:research, displayRows:research,
        description:"Hypothetical calculations derived from public book snapshots and your assumptions. Read-only research; no trading keys or order submission."}, body);
    };
  }
  root.KalshiResearch = {levels, simulate, sizePosition, createWorkbench};
})(globalThis);
