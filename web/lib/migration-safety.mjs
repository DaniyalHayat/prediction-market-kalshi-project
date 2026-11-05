import {createHash} from 'node:crypto';
export const migrationHash=sql=>createHash('sha256').update(sql.replaceAll('\r\n','\n')).digest('hex');
export function assertAdditiveMigration(sql){
  if(typeof sql!=='string'||sql.length>2_000_000)throw new RangeError('Migration is missing or exceeds the review bound');
  if(/\bEXECUTE\s+(?:format\s*\(\s*)?['"]\s*(?:DROP|TRUNCATE|DELETE)\b/i.test(sql))throw new Error('Dynamic destructive SQL requires a separate reviewed maintenance procedure');
  const cleaned=sql.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\r\n]*/g,' ').replace(/'(?:''|[^'])*'/g,"''");
  if(/\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\s+(?!ON\b|OR\b)(?:TABLE\s+)?[a-z_"]/i.test(cleaned))throw new Error('Destructive SQL is blocked by the normal migration path');
  return true;
}
