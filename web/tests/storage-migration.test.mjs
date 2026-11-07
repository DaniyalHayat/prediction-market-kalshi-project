import assert from 'node:assert/strict';
import test from 'node:test';
import {migratePredictirStorage} from '../ui/storage-migration.mjs';
import {purgeExpiredGuestData} from '../ui/guest-session.mjs';
import {PAPER_STORAGE} from '../ui/paper-state.mjs';

class MemoryStorage{
  values=new Map();
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
const legacy='kalshi-market-lab:';
const marker='predictir:storage-migrated:v1';

test('branding migration preserves exact paper, owner-cache, watchlist and appearance records',()=>{
  const storage=new MemoryStorage();
  const records={
    'paper-journal:v1':JSON.stringify({starting_balance:17234.56,positions:[{id:'position-1',remaining_quantity:4}],trades:[{id:'entry-1'}]}),
    'active-account:v1':'owner:owner@example.org',
    'account-cache:v1:owner:owner@example.org':'private-ledger-snapshot',
    'account-cache:v1:watchlist:guest:guest-1':'["KXEXAMPLE-YES"]',
    'appearance:v1':'{"theme":"midnight","density":"compact"}',
    'analytics-consent:v1':'denied'
  };
  for(const [key,value]of Object.entries(records))storage.setItem(legacy+key,value);
  storage.setItem('unrelated-service:token','untouched');
  assert.equal(migratePredictirStorage(storage),true);
  for(const [key,value]of Object.entries(records)){
    assert.equal(storage.getItem('predictir:'+key),value);
    assert.equal(storage.getItem(legacy+key),value);
  }
  assert.equal(storage.getItem(marker),'complete');
  assert.equal(storage.getItem('unrelated-service:token'),'untouched');
});

test('newer Predictir records win while a previous analytics denial remains effective',()=>{
  const storage=new MemoryStorage();
  storage.setItem(legacy+'paper-journal:v1','older');
  storage.setItem(PAPER_STORAGE,'newer');
  storage.setItem(legacy+'analytics-consent:v1','denied');
  storage.setItem('predictir:analytics-consent:v1','allowed');
  migratePredictirStorage(storage);
  assert.equal(storage.getItem(PAPER_STORAGE),'newer');
  assert.equal(storage.getItem('predictir:analytics-consent:v1'),'denied');
});

test('an interrupted migration rolls back only copied records and leaves legacy data available',()=>{
  const storage=new MemoryStorage();
  storage.setItem(legacy+'paper-journal:v1','retained-ledger');
  storage.setItem(legacy+'appearance:v1','retained-theme');
  const set=storage.setItem.bind(storage);
  storage.setItem=(key,value)=>{if(key==='predictir:appearance:v1')throw new Error('Quota exceeded');set(key,value);};
  assert.throws(()=>migratePredictirStorage(storage),/Quota exceeded/);
  assert.equal(storage.getItem(marker),null);
  assert.equal(storage.getItem(PAPER_STORAGE),null);
  assert.equal(storage.getItem(legacy+'paper-journal:v1'),'retained-ledger');
  storage.setItem=set;
  assert.equal(migratePredictirStorage(storage),true);
  assert.equal(storage.getItem(PAPER_STORAGE),'retained-ledger');
});

test('completed migration cannot resurrect an expired guest ledger from its retained legacy copy',()=>{
  const storage=new MemoryStorage(),now=Date.parse('2026-11-07T12:00:00Z');
  storage.setItem(legacy+'guest-session:v1',JSON.stringify({id:'guest-1',created_at:'2026-11-07T00:00:00Z',last_active_at:'2026-11-07T01:00:00Z',expires_at:'2026-11-07T06:00:00Z'}));
  storage.setItem(legacy+'active-account:v1','guest:guest-1');
  storage.setItem(legacy+'paper-journal:v1','expired-ledger');
  assert.equal(purgeExpiredGuestData(storage,now).removed,true);
  assert.equal(storage.getItem(PAPER_STORAGE),null);
  assert.equal(migratePredictirStorage(storage),false);
  assert.equal(storage.getItem(PAPER_STORAGE),null);
});

