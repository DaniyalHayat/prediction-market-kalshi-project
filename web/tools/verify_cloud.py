import argparse
import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

import requests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('base')
    parser.add_argument('--owner-file', required=True)
    args = parser.parse_args()
    base = args.base.rstrip('/')
    session = requests.Session()
    receipt = {'verified_at': datetime.now(timezone.utc).isoformat(), 'base': base}
    start = time.perf_counter()
    health = session.get(base + '/api/health', timeout=30)
    health.raise_for_status()
    receipt['health_seconds'] = round(time.perf_counter() - start, 3)
    receipt['cloud_storage'] = health.json()['cloud_storage']
    response = session.get('https://external-api.kalshi.com/trade-api/v2/markets',
                           params={'series_ticker': 'KXBTC15M', 'status': 'open', 'limit': 3}, timeout=20)
    response.raise_for_status()
    ticker = response.json()['markets'][0]['ticker']
    observed = []
    with session.get(base + '/api/stream', params={'ticker': ticker}, stream=True, timeout=(20, 35)) as stream:
        stream.raise_for_status()
        for line in stream.iter_lines(chunk_size=1):
            if not line.startswith(b'data: '):
                continue
            item = json.loads(line[6:])
            if item.get('kind') == 'connection' and item.get('status') == 'unavailable':
                raise RuntimeError(item['reason'])
            if item.get('kind') == 'quote':
                observed.append(item)
                if len(observed) == 3:
                    break
    receipt['native_stream'] = {'ticker': ticker, 'quotes': len(observed),
                                'first_sequence': observed[0]['sequence'], 'last_sequence': observed[-1]['sequence'],
                                'transport': observed[-1]['transport'], 'last_observed_at': observed[-1]['as_of']}
    owner = secrets.token_hex(32)
    headers = {'Authorization': 'Bearer ' + owner}
    response = session.post(base + '/api/journal', headers=headers,
                            json={'ticker': ticker, 'probability': .5, 'probability_low': .4, 'probability_high': .6}, timeout=30)
    response.raise_for_status()
    frozen = response.json()
    first = session.get(base + '/api/journal', headers=headers, timeout=30)
    first.raise_for_status()
    other = session.get(base + '/api/journal', headers={'Authorization': 'Bearer ' + secrets.token_hex(32)}, timeout=30)
    other.raise_for_status()
    assert len(first.json()['records']) == 1 and not other.json()['records']
    receipt['private_journal'] = {'forecast_id': frozen['id'], 'freeze_hash': frozen['freeze_hash'],
                                  'status': frozen['status'], 'owner_isolation_verified': True,
                                  'purpose': 'Prospective integration smoke test with an explicitly arbitrary 50% input; not a research performance result'}
    p = Path(args.owner_file)
    p.parent.mkdir(exist_ok=True, parents=True)
    p.write_text(json.dumps({'base': base, 'token': owner, 'id': frozen['id']}), encoding='utf-8')
    target = Path('docs/cloud-verification.json')
    target.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
