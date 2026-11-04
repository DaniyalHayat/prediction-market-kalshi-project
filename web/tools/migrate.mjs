import {readFile,readdir} from 'node:fs/promises';
import {makePostgresStore} from '../lib/postgres-store.mjs';
if(!process.env.DATABASE_URL)throw new Error('Set the backend-only DATABASE_URL before migrating');
const storage=makePostgresStore();
try {
  const directory=new URL('../database/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>/^\d.*\.sql$/.test(f)).sort())await storage.db.query(await readFile(new URL(file,directory),'utf8'));
  console.log('Market Lab schema and private table policies applied');
} finally {await storage.close();}
