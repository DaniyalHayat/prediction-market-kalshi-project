import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function applyTestSchema(pool){
  const files=await Promise.all(['001_market_lab.sql','002_pipeline.sql','003_runtime_safety.sql'].map(file=>readFile(new URL('../database/'+file,import.meta.url),'utf8')));
  const signature='market-lab-test-schema:'+createHash('sha256').update(files.join('\n')).digest('hex');
  const client=await pool.connect();
  try{
    if(!(await client.query('SELECT current_database() AS name')).rows[0].name.endsWith('_test'))throw new Error('Schema fixtures require a disposable _test database');
    await client.query("SELECT pg_advisory_lock(hashtextextended('market_lab:migrations',0))");
    const existing=await client.query("SELECT obj_description(oid,'pg_namespace') AS signature FROM pg_namespace WHERE nspname='market_lab'");
    if(existing.rows[0]?.signature===signature)return;
    for(const sql of files)await client.query(sql);
    await client.query(`COMMENT ON SCHEMA market_lab IS '${signature}'`);
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.query("SELECT pg_advisory_unlock(hashtextextended('market_lab:migrations',0))");client.release();}
}
