"""Refresh: python -m kalshi_lab refresh. Offline replay: python -m kalshi_lab replay."""
import csv, json, sqlite3, argparse, statistics, sys
from pathlib import Path
from datetime import datetime, timezone
from .client import Client, utc, BASE
from .metrics import number, timestamp, valid_quote, book_metrics, preclose_quote, brier, reliability

ROOT=Path(__file__).resolve().parents[1]
SERIES=('KXFEDDECISION','KXCPI','KXHIGHNY')

def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf-8')

def collect():
    run= datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    rawdir=ROOT/'data'/'raw'/run
    client=Client(rawdir)
    bundle={'run_id':run,'started_at':utc(),'open':[],'settled':[],'books':{},'candles':{},'errors':[],'coverage':[]}
    for series in SERIES:
        rows,truncated=client.markets(series,'open')
        bundle['open'].extend(dict(m,series=series) for m in rows)
        bundle['coverage'].append({'series':series,'status':'open','records':len(rows),'truncated':truncated})
        print(f'{series}: {len(rows)} open markets',flush=True)
    # Bounded public research sample; no account/position endpoints.
    ordered=sorted(bundle['open'],key=lambda m:number(m.get('volume_24h_fp')) or 0,reverse=True)[:40]
    for m in ordered:
        try:
            bundle['books'][m['ticker']]={'retrieved_at':utc(),'data':client.get('/markets/'+m['ticker']+'/orderbook',depth=0)}
        except Exception as exc:
            bundle['errors'].append({'stage':'book','ticker':m['ticker'],'error':type(exc).__name__+': '+str(exc)})
    rows,truncated=client.markets('KXHIGHNY','settled',max_pages=1)
    # Select complete events, not an arbitrary number of adjacent strike rows.
    event_times={}
    for m in rows:
        event_times[m['event_ticker']]=m['close_time']
    events=set(sorted(event_times,key=event_times.get,reverse=True)[:20])
    bundle['settled']=[dict(m,series='KXHIGHNY') for m in rows if m['event_ticker'] in events]
    bundle['coverage'].append({'series':'KXHIGHNY','status':'settled','fetched_records':len(rows),'selected_events':len(events),'records':len(bundle['settled']),'truncated':truncated})
    for i,m in enumerate(bundle['settled']):
        cutoff=timestamp(m['close_time'])-86400
        try:
            bundle['candles'][m['ticker']]=client.get('/series/KXHIGHNY/markets/'+m['ticker']+'/candlesticks',start_ts=cutoff-7200,end_ts=cutoff,period_interval=60)
        except Exception as exc:
            bundle['errors'].append({'stage':'history','ticker':m['ticker'],'error':type(exc).__name__+': '+str(exc)})
        if i%30==0:
            print(f'Historical quotes {i+1}/{len(bundle["settled"])}',flush=True)
    bundle['completed_at']=utc()
    bundle['requests']=client.requests
    write_json(rawdir/'bundle.json',bundle)
    write_json(ROOT/'data/latest.json',{'bundle':str((rawdir/'bundle.json').relative_to(ROOT)).replace('\\','/')})
    return bundle

def transform(bundle):
    live, evaluation, exclusions, history = [],[],[],[]
    seen=set()
    for m in bundle['open']:
        if m['ticker'] in seen:
            exclusions.append({'ticker':m['ticker'],'stage':'catalog','reason':'duplicate ticker'});continue
        seen.add(m['ticker'])
        bid,ask=number(m.get('yes_bid_dollars')),number(m.get('yes_ask_dollars'))
        ok=valid_quote(bid,ask)
        row={k:m.get(k) for k in ('ticker','event_ticker','title','series','close_time','rules_primary','rules_secondary')}
        row.update({'yes_bid':bid,'yes_ask':ask,'midpoint':(bid+ask)/2 if ok else None,'spread_cents':(ask-bid)*100 if ok else None,
            'volume_24h':number(m.get('volume_24h_fp')),'open_interest':number(m.get('open_interest_fp')),
            'last_price':number(m.get('last_price_dollars')),'catalog_quote_valid':ok,'book_state':'not sampled',
            'book_spread_cents':None,'ask_depth_2c':None,'sim_vwap':None,'sim_fill_ratio':None,'sim_slippage_cents':None})
        book=bundle['books'].get(m['ticker'])
        if book:
            try:
                row.update(book_metrics(book['data']))
                row['book_retrieved_at']=book['retrieved_at']
            except ValueError as exc:
                exclusions.append({'ticker':m['ticker'],'stage':'book','reason':str(exc)})
                row['book_state']='invalid'
        flags=[]
        if not ok:flags.append('invalid catalog quote')
        if ok and row['spread_cents']>=10:flags.append('spread ≥10¢')
        if row['volume_24h']==0:flags.append('no 24h volume')
        if row['ask_depth_2c'] is not None and row['ask_depth_2c']<100:flags.append('thin near-touch asks')
        if row['book_state'] in ('empty','one-sided','crossed','invalid'):flags.append(row['book_state']+' book')
        row['flags']='; '.join(flags) or 'no selected flags'
        live.append(row)
    seen=set()
    for m in bundle['settled']:
        ticker=m['ticker']
        if ticker in seen:
            exclusions.append({'ticker':ticker,'stage':'evaluation','reason':'duplicate ticker'});continue
        seen.add(ticker)
        cutoff=timestamp(m['close_time'])-86400
        candles=bundle['candles'].get(ticker,{}).get('candlesticks',[])
        for c in candles:
            history.append({'ticker':ticker,'event_ticker':m['event_ticker'],'end_period_ts':c['end_period_ts'],'yes_bid':number(c.get('yes_bid',{}).get('close_dollars')),'yes_ask':number(c.get('yes_ask',{}).get('close_dollars'))})
        q=preclose_quote(candles,cutoff)
        if m.get('result') not in ('yes','no') or not q:
            exclusions.append({'ticker':ticker,'stage':'evaluation','reason':'nonbinary result or no valid quote within 2h of cutoff'});continue
        y=int(m['result']=='yes')
        evaluation.append(dict(q,ticker=ticker,event_ticker=m['event_ticker'],title=m['title'],cutoff_ts=cutoff,close_time=m['close_time'],outcome=y,brier=brier(q['probability'],y)))
    # Within-event correlation: report event count and event-weighted score too.
    event_scores={}
    for r in evaluation:event_scores.setdefault(r['event_ticker'],[]).append(r['brier'])
    spreads=[r['spread_cents'] for r in live if r['spread_cents'] is not None]
    summary={'run_id':bundle['run_id'],'as_of':bundle['completed_at'],'open_markets':len(live),'book_samples':len(bundle['books']),
        'two_sided_books':sum(r['book_state']=='two-sided' for r in live),
        'median_spread_cents':statistics.median(spreads) if spreads else None,
        'wide_spread_markets':sum(x>=10 for x in spreads),'zero_volume_markets':sum(r['volume_24h']==0 for r in live),
        'evaluated_markets':len(evaluation),'evaluated_events':len(event_scores),'settled_candidates':len(bundle['settled']),
        'brier':statistics.mean(r['brier'] for r in evaluation) if evaluation else None,
        'event_weighted_brier':statistics.mean(statistics.mean(v) for v in event_scores.values()) if event_scores else None,
        'neutral_baseline_brier':.25,'history_rows':len(history),'request_errors':len(bundle['errors'])}
    return {'summary':summary,'markets':live,'evaluation':evaluation,'reliability':reliability(evaluation),'history':history,'exclusions':exclusions,'coverage':bundle['coverage'],'errors':bundle['errors'],'requests':bundle['requests']}

def csv_out(name,rows):
    path=ROOT/'reports'/name
    path.parent.mkdir(exist_ok=True)
    if not rows:
        path.write_text('',encoding='utf-8');return
    fields=list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w',newline='',encoding='utf-8') as f:
        writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader();writer.writerows(rows)

def save(result):
    write_json(ROOT/'reports/results.json',result)
    for name in ('markets','evaluation','reliability','history','exclusions'):
        csv_out(name+'.csv',result[name])
    db=ROOT/'data/market_lab.sqlite'
    with sqlite3.connect(db) as con:
        for table in ('markets','evaluation','history','reliability'):
            rows=result[table]
            con.execute(f'DROP TABLE IF EXISTS {table}')
            if not rows:continue
            keys=list(dict.fromkeys(k for r in rows for k in r))
            types={k:('REAL' if any(isinstance(r.get(k),(int,float)) for r in rows) else 'TEXT') for k in keys}
            con.execute(f'CREATE TABLE {table} ('+', '.join('"'+k+'" '+types[k] for k in keys)+')')
            con.executemany(f'INSERT INTO {table} VALUES ('+','.join('?' for _ in keys)+')',[[r.get(k) for k in keys] for r in rows])
        con.execute('CREATE UNIQUE INDEX IF NOT EXISTS market_ticker ON markets(ticker)')
    write_snapshot(result)
    print(json.dumps(result['summary'],indent=2))

def write_snapshot(result):
    queries={}
    definitions={'markets':'One current market per ticker. Catalog prices in dollars per $1 contract; spreads in cents; volume/open interest in contracts. Books sampled for the top 40 by 24h volume across selected series; not sampled is not zero.',
      'evaluation':'One settled binary KXHIGHNY market. Midpoint of the last valid hourly bid/ask closing quote at or before close_time minus 24h; maximum lag 2h. Brier=(p-y)^2. No post-cutoff quote enters the forecast.',
      'reliability':'Ten equal-width probability bins; observed yes rate and mean pre-close midpoint. Empty bins omitted. Contracts within an event are dependent.',
      'history':'Hourly bid/ask closing quotes in a two-hour window ending 24h before contractual close; UTC Unix seconds.',
      'summary':'Snapshot coverage and descriptive diagnostics. Median spread uses valid catalog quotes only. Neutral 50% Brier baseline is 0.25, not a competitive fitted forecast.'}
    for name in definitions:
        queries[name]={'rows':[result[name]] if name=='summary' else result[name], 'source':{'type':'api','label':'Kalshi public REST API','url':'https://docs.kalshi.com/getting_started/quick_start_market_data','fetchedAt':result['summary']['as_of'],'tables':[name],
            'evidenceFlow':[{'title':'Public API collection','detail':'GET-only requests; exact URLs, UTC retrieval times and response hashes are in reports/results.json requests and data/raw.'},{'title':'Transformation','detail':'python -m kalshi_lab replay; kalshi_lab/pipeline.py and metrics.py; fixed 24h horizon, 2h lag cap, no fitted model.'}],
            'metricDefinitions':[{'label':name,'definition':definitions[name]}], 'caveats':['Bounded selected-series snapshot, not the full exchange.','Historical evaluation is NYC weather only, 20 recent events; not evidence of profitable trading.','Quotes are market prices, not independently estimated true probabilities.']},
            'methods':[{'language':'python','code':'python -m kalshi_lab replay'}]}
    snapshot={'surface':'dashboard','title':'Kalshi Market Lab','generatedAt':result['summary']['as_of'],'status':'reviewed','filters':[],'queries':queries}
    write_json(ROOT/'reports/dashboard_snapshot.json',snapshot)
    target=ROOT/'dashboard/src/data.json'
    if target.exists():write_json(target,snapshot)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['refresh','replay'])
    args=parser.parse_args()
    if args.command=='refresh':bundle=collect()
    else:
        loc=json.loads((ROOT/'data/latest.json').read_text())
        bundle=json.loads((ROOT/loc['bundle']).read_text(encoding='utf-8'))
    save(transform(bundle))

if __name__=='__main__':main()
