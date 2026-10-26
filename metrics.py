"""Pure calculations; dollar prices are in [0, 1], quantities are contracts."""
from decimal import Decimal, InvalidOperation
from datetime import datetime
from statistics import mean
import math

def number(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None

def timestamp(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())

def valid_quote(bid, ask):
    # Boundary quotes are retained: a zero bid can be a real endpoint value.
    return bid is not None and ask is not None and 0 <= bid <= ask <= 1

def book_metrics(payload, contracts=100):
    if contracts <= 0:
        raise ValueError('contracts must be positive')
    book = payload.get('orderbook_fp')
    if not isinstance(book, dict):
        raise ValueError('Missing fixed-point orderbook_fp')
    def levels(key):
        out = {}
        for row in book.get(key) or []:
            if not isinstance(row, list) or len(row) != 2:
                raise ValueError('Invalid order-book level')
            try:
                p, q = map(Decimal, row)
            except (InvalidOperation, TypeError):
                raise ValueError('Invalid decimal level') from None
            if not p.is_finite() or not q.is_finite() or not 0 <= p <= 1 or q < 0:
                raise ValueError('Invalid level value')
            if q:
                out[p] = out.get(p, Decimal(0)) + q
        return out
    yes, no = levels('yes_dollars'), levels('no_dollars')
    bids = sorted(yes.items(), reverse=True)
    asks = sorted((Decimal(1)-p, q) for p, q in no.items())
    bid = bids[0][0] if bids else None
    ask = asks[0][0] if asks else None
    crossed = bid is not None and ask is not None and bid > ask
    quote_ok = bid is not None and ask is not None and not crossed
    # Hypothetical static-book buy: no routing, execution or fee assumption.
    remaining, cost, filled = Decimal(str(contracts)), Decimal(0), Decimal(0)
    if not crossed:
        for price, qty in asks:
            take = min(remaining, qty)
            cost += take * price
            filled += take
            remaining -= take
            if remaining == 0:
                break
    depth = sum(q for p, q in asks if p <= ask+Decimal('.02')) if ask is not None and not crossed else None
    return {
        'book_bid': float(bid) if bid is not None else None,
        'book_ask': float(ask) if ask is not None else None,
        'book_spread_cents': float((ask-bid)*100) if quote_ok else None,
        'book_midpoint': float((ask+bid)/2) if quote_ok else None,
        'ask_depth_2c': float(depth) if depth is not None else None,
        'sim_requested': contracts, 'sim_filled': float(filled),
        'sim_fill_ratio': float(filled/Decimal(str(contracts))),
        'sim_cost': float(cost), 'sim_vwap': float(cost/filled) if filled else None,
        'sim_slippage_cents': float((cost/filled-ask)*100) if filled else None,
        'book_state': 'crossed' if crossed else 'two-sided' if quote_ok else 'one-sided' if bids or asks else 'empty',
    }

def preclose_quote(candles, cutoff, max_age=7200):
    eligible = []
    for c in candles:
        t = c.get('end_period_ts')
        b = number(c.get('yes_bid', {}).get('close_dollars'))
        a = number(c.get('yes_ask', {}).get('close_dollars'))
        if isinstance(t, int) and 0 <= cutoff-t <= max_age and valid_quote(b, a):
            eligible.append((t, b, a))
    if not eligible:
        return None
    t, b, a = max(eligible, key=lambda row: row[0])
    return {'quote_ts':t,'probability':(b+a)/2,'spread_cents':(a-b)*100,'quote_age_minutes':(cutoff-t)/60}

def brier(p, y):
    if not 0 <= p <= 1 or y not in (0, 1):
        raise ValueError('Invalid probability or binary outcome')
    return (p-y)**2

def reliability(rows):
    bins = []
    for i in range(10):
        group = [r for r in rows if min(9, int(r['probability']*10)) == i]
        if group:
            bins.append({'bin':f'{i*10}–{(i+1)*10}%', 'n':len(group),
                'mean_probability':mean(r['probability'] for r in group),
                'observed_yes_rate':mean(r['outcome'] for r in group)})
    return bins
