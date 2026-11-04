import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/dashboard/',import.meta.url);
const manifestURL=new URL('data-app-build.json',root);
const manifest=JSON.parse(await readFile(manifestURL,'utf8'));
let mismatch=false;
for(const kind of ['html','snapshot']) {
  const entry=manifest[kind],bytes=await readFile(new URL(entry.path,root));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(entry.sha256!==sha256 || entry.bytes!==bytes.length)mismatch=true;
  entry.sha256=sha256;entry.bytes=bytes.length;
}
manifest.sourceSnapshotSha256=manifest.snapshot.sha256;
if(process.argv.includes('--check') && mismatch)throw new Error('Artifact manifest differs from checked-in bytes');
if(!process.argv.includes('--check'))await writeFile(manifestURL,JSON.stringify(manifest,null,2)+'\n');
console.log('Artifact bytes and SHA-256 hashes verified');
