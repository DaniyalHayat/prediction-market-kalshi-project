import {readFile} from 'node:fs/promises';
import {makePostgresStore} from '../lib/postgres-store.mjs';
const url=process.env.MARKET_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Set MARKET_TEST_DATABASE_URL to a disposable database ending in _test');
const storage=makePostgresStore({connectionString:url});
try{
  for(const name of ['001_market_lab.sql','002_pipeline.sql','003_runtime_safety.sql'])await storage.db.query(await readFile(new URL('../database/'+name,import.meta.url),'utf8'));
  await storage.db.query('CREATE EXTENSION IF NOT EXISTS pgtap');
  const output=await storage.db.query(await readFile(new URL('../database/tests/runtime_safety.sql',import.meta.url),'utf8'));
  const lines=output.flatMap(result=>result.rows||[]).flatMap(row=>Object.values(row)).filter(value=>typeof value==='string');
  console.log(lines.join('\n'));
  if(lines.some(line=>/^not ok\b|^# (?:Looks like|Failed)/m.test(line)))throw new Error('Database pgTAP assertions failed');
}finally{await storage.close();}
