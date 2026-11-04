import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'kalshi-cms-'));
try {
  const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./verify-worker.ts',import.meta.url))],
    {stdio:'inherit',env:{...process.env,CMS_VERIFY_URL:'file:'+join(directory,'research.db').replaceAll('\\','/')}});
  if(child.error)throw child.error;
  if(child.status!==0)throw new Error('CMS verification subprocess failed: '+child.status);
} finally {
  const inside=relative(tmpdir(),directory);
  if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Refusing cleanup outside the temporary directory');
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
