import { request } from "../live.mjs";

export const CATEGORIES = [
  {id:"travel", name:"TSA travel", short:"Travel", series:["KXTSAD","KXTSA"], source:"TSA checkpoint counts", model:"Weekday seasonal ensemble", unit:"passengers", reason:"Numeric daily outcomes, a directly observable resolution source and repeated same-weekday samples."},
  {id:"weather", name:"Daily temperature", short:"Weather", series:["KXHIGHNY","KXHIGHCHI","KXHIGHMIA"], source:"National Weather Service", model:"Hourly forecast + observed daily maximum", unit:"°F", reason:"Short forecast horizons and physical measurements; forecast uncertainty and station mismatch must be priced."},
  {id:"inflation", name:"US inflation", short:"Inflation", series:["KXCPI"], source:"FRED / Bureau of Labor Statistics", model:"Regularized change ensemble", unit:"% MoM", reason:"A numerical release, long public history and a coherent ladder of thresholds; revisions limit historical validation."},
  {id:"labor", name:"US unemployment", short:"Labor", series:["KXU3"], source:"FRED / Bureau of Labor Statistics", model:"Regularized change ensemble", unit:"%", reason:"A repeated numerical release with long public history. Regime changes and revisions are explicit risks."},
  {id:"crypto", name:"Bitcoin & Ether", short:"Crypto", series:["KXBTC","KXETH"], source:"Coinbase public candles", model:"EWMA return distribution", unit:"USD", reason:"Free, frequent price observations enable realized-volatility estimates. Coinbase is a proxy, not the Kalshi settlement index."}
];
export function categoryById(id) {
  const category = CATEGORIES.find(item => item.id === id);
  if (!category) throw new RangeError("Choose travel, weather, inflation, labor or crypto");
  return category;
}
let catalog;
export async function discoverSeries() {
  if (catalog && Date.now() - catalog.at < 3600000) return catalog.value;
  const found = [];
  for (const ticker of [...new Set(CATEGORIES.flatMap(category=>category.series))]) {
    try {
      const result = await request("/series/"+ticker);
      if (result.data.series) found.push({...result.data.series,source_url:result.source_url});
    } catch (error) {
      if (error.upstream_status === 429) break;
    }
  }
  const value = {
    as_of:new Date().toISOString(),
    categories:CATEGORIES.map(category => ({
      ...category,
      matching_series:found.filter(row=>category.series.includes(row.ticker))
        .map(row=>({ticker:row.ticker,title:row.title,frequency:row.frequency,settlement_sources:row.settlement_sources,source_url:row.source_url}))
    }))
  };
  catalog = {at:Date.now(),value};
  return value;
}
