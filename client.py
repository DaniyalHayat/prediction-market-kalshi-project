"""Bounded GET-only Kalshi client with persistent responses and request lineage."""
import hashlib, json, time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from pathlib import Path

BASE = 'https://external-api.kalshi.com/trade-api/v2'

def utc():
    return datetime.now(timezone.utc).isoformat()

class Client:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.requests = []

    def get(self, path, **params):
        if not path.startswith(('/markets', '/series/', '/historical/')) or '..' in path:
            raise ValueError('Only public research endpoints are allowed')
        url = BASE + path + ('?' + urlencode(params) if params else '')
        filename = hashlib.sha256(url.encode()).hexdigest()[:20]+'.json'
        cached = self.directory / filename
        if cached.exists():
            envelope = json.loads(cached.read_text())
            self.requests.append({k:envelope[k] for k in ('url','retrieved_at','sha256')})
            return envelope['data']
        for attempt in range(4):
            try:
                req = Request(url, headers={'User-Agent':'KalshiMarketLab/1.0 public-data-research','Accept':'application/json'})
                with urlopen(req, timeout=25) as response:
                    raw = response.read()
                data = json.loads(raw)
                envelope = {'url':url, 'retrieved_at':utc(), 'sha256':hashlib.sha256(raw).hexdigest(), 'data':data}
                cached.write_text(json.dumps(envelope, ensure_ascii=False), encoding='utf-8')
                self.requests.append({k:envelope[k] for k in ('url','retrieved_at','sha256')})
                time.sleep(.12)
                return data
            except HTTPError as exc:
                if exc.code not in (429,500,502,503,504) or attempt==3:
                    raise
                retry = exc.headers.get('Retry-After','')
                time.sleep(min(15,float(retry)) if retry.isdigit() else 2**attempt)
            except (URLError, TimeoutError):
                if attempt==3:
                    raise
                time.sleep(2**attempt)

    def markets(self, series, status, max_pages=4):
        rows, seen, cursor = [], set(), ''
        for page in range(max_pages):
            params={'series_ticker':series,'status':status,'limit':200}
            if cursor:
                params['cursor']=cursor
            data = self.get('/markets', **params)
            rows.extend(data['markets'])
            cursor = data.get('cursor','')
            if not cursor:
                return rows, False
            if cursor in seen:
                raise ValueError('Repeated pagination cursor')
            seen.add(cursor)
        return rows, bool(cursor)
