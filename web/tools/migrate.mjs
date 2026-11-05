import {readFile,readdir} from 'node:fs/promises';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {assertAdditiveMigration,migrationHash} from '../lib/migration-safety.mjs';
if(!process.env.DATABASE_URL)throw new Error('Set the backend-only DATABASE_URL before migrating');
const storage=makePostgresStore();
let client;
try {
  const directory=new URL('../database/',import.meta.url);
  const files=[];
  for(const file of (await readdir(directory)).filter(f=>/^\d.*\.sql$/.test(f)).sort()){
    const sql=(await readFile(new URL(file,directory),'utf8')).replaceAll('\r\n','\n');assertAdditiveMigration(sql);files.push({file,sql,hash:migrationHash(sql)});
  }
  client=await storage.db.connect();await client.query("SET lock_timeout='5s'");
  await client.query("SELECT pg_advisory_lock(hashtextextended('market_lab:migrations',0))");
  const exists=(await client.query("SELECT to_regclass('market_lab.schema_migrations') IS NOT NULL AS present")).rows[0].present;
  const applied=new Map(exists?(await client.query('SELECT name,sha256 FROM market_lab.schema_migrations')).rows.map(row=>[row.name,row.sha256]):[]);
  for(const file of files)if(applied.has(file.file)&&applied.get(file.file)!==file.hash)throw new Error('An applied migration changed: '+file.file);
  const pending=files.filter(file=>!applied.has(file.file));
  if(!process.argv.includes('--apply'))console.log(JSON.stringify({mode:'preview',pending:pending.map(({file,hash})=>({file,sha256:hash})),message:'Review the SQL, confirm recovery coverage, then rerun with --apply. The destructive-statement lint is an additional guard, not a replacement for SQL review.'},null,2));
  else{
    await client.query('CREATE SCHEMA IF NOT EXISTS market_lab; CREATE TABLE IF NOT EXISTS market_lab.schema_migrations(name text PRIMARY KEY,sha256 char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()); ALTER TABLE market_lab.schema_migrations ENABLE ROW LEVEL SECURITY');
    for(const file of pending){
      try{await client.query(file.sql);await client.query('INSERT INTO market_lab.schema_migrations(name,sha256) VALUES($1,$2)',[file.file,file.hash]);}
      catch(error){await client.query('ROLLBACK').catch(()=>{});throw new Error('Migration failed: '+file.file+' (SQLSTATE '+String(error.code||'unknown').slice(0,10)+')');}
    }
    console.log(JSON.stringify({mode:'applied',migrations:pending.map(file=>file.file)}));
  }
} finally {if(client){await client.query("SELECT pg_advisory_unlock(hashtextextended('market_lab:migrations',0))").catch(()=>{});client.release();}await storage.close();}
