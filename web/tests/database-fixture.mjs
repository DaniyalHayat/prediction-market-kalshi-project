import {readFile} from 'node:fs/promises';
export async function applyTestSchema(pool){
  const client=await pool.connect();
  try{
    await client.query("SELECT pg_advisory_lock(hashtextextended('market_lab:migrations',0))");
    for(const file of ['001_market_lab.sql','002_pipeline.sql','003_runtime_safety.sql'])await client.query(await readFile(new URL('../database/'+file,import.meta.url),'utf8'));
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.query("SELECT pg_advisory_unlock(hashtextextended('market_lab:migrations',0))");client.release();}
}
