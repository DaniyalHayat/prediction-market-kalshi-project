import { markets, book, marketDetails, trades, history, workbook, utc, authStatus } from "../../../lib/live.mjs";
import { CATEGORIES, discoverSeries } from "../../../lib/intelligence/catalog.mjs";
import { researchReport, analyzeExecution } from "../../../lib/intelligence/index.mjs";
import { marketCandles, listForward, readForward, startForward, checkpointForward } from "../../../lib/quant/forward.mjs";
import { marketBrief } from "../../../lib/intelligence/brief.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, context) {
  const {path} = await context.params, endpoint = path.join("/"), params = new URL(request.url).searchParams;
  const vertical = params.get("vertical") || "Macro", ticker = params.get("ticker"), contracts = params.has("contracts") ? Number(params.get("contracts")) : 100;
  const headers = {"Cache-Control":"no-store"};
  try {
    let result;
    if(endpoint==="health") result={status:"ok",mode:"read-only GET",signed_requests:authStatus(),refresh_floor_seconds:20,as_of:utc()};
    else if(endpoint==="brief") result=await marketBrief(ticker,{contracts});
    else if(endpoint==="intelligence/catalog") result={categories:CATEGORIES,as_of:utc()};
    else if(endpoint==="intelligence/series") result=await discoverSeries();
    else if(endpoint==="intelligence") result=await researchReport(params.get("category") || "travel");
    else if(endpoint==="intelligence/candles") result=await marketCandles(params.get("category"),ticker);
    else if(endpoint==="intelligence/forward") result=params.get("id") ? await readForward(params.get("id")) : await listForward();
    else if(endpoint==="intelligence/execution") result=await analyzeExecution(params.get("category"),ticker,{
      contracts,slippage:params.has("slippage") ? Number(params.get("slippage")) : 2,
      coefficient:params.has("coefficient") ? Number(params.get("coefficient")) : .07,
      bankroll:params.has("bankroll") ? Number(params.get("bankroll")) : 1000,risk:params.has("risk") ? Number(params.get("risk")) : 1
    });
    else if(endpoint==="markets") result=await markets(vertical);
    else if(endpoint==="book") result=await book(ticker,contracts);
    else if(endpoint==="market") result=await marketDetails(ticker);
    else if(endpoint==="trades") result=await trades(ticker);
    else if(endpoint==="history") result=history(vertical);
    else if(endpoint==="export.xlsx") return new Response(await workbook(vertical),{headers:{...headers,"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":"attachment; filename=\"kalshi-live-research.xlsx\""}});
    else return Response.json({error:"Unknown API path"},{status:404,headers});
    return Response.json(result,{headers});
  } catch(error) {return Response.json({error:error.message,status:"unavailable"},{status:error.status || (error instanceof RangeError?400:503),headers});}
}
export async function POST(request,context) {
  const {path}=await context.params,endpoint=path.join("/"),headers={"Cache-Control":"no-store"};
  try {
    if(!["intelligence/forward/start","intelligence/forward/checkpoint"].includes(endpoint))return Response.json({error:"Unknown paper-research path"},{status:404,headers});
    const text=await request.text();
    if(text.length>8000)return Response.json({error:"Paper protocol too large"},{status:413,headers});
    const input=JSON.parse(text || "{}");
    const result=endpoint.endsWith("/start") ? await startForward(input) : await checkpointForward(input.id);
    return Response.json(result,{status:endpoint.endsWith("/start") ? 201 : 200,headers});
  } catch(error) {return Response.json({error:error.message},{status:error.status || (error instanceof RangeError || error instanceof SyntaxError ? 400 : 503),headers});}
}
