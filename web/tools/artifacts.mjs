import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/dashboard/',import.meta.url);
const manifestURL=new URL('data-app-build.json',root);
const manifest=JSON.parse(await readFile(manifestURL,'utf8'));
const check=process.argv.includes('--check');
for(const [name,signature] of [['favicon.ico','00000100'],['favicon.png','89504e470d0a1a0a']]){
  const bytes=await readFile(new URL('../public/'+name,import.meta.url));
  if(bytes.subarray(0,signature.length/2).toString('hex')!==signature)throw new Error('Browser asset is not an image: '+name);
}
let mismatch=false;
for(const kind of ['html','snapshot',...(manifest.runtime?['runtime']:[])]) {
  const entry=manifest[kind],url=new URL(entry.path,root);
  let bytes=await readFile(url);
  if(!check) {
    bytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
    await writeFile(url,bytes);
  }
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(entry.sha256!==sha256 || entry.bytes!==bytes.length)mismatch=true;
  entry.sha256=sha256;entry.bytes=bytes.length;
}
if(manifest.sourceSnapshotSha256!==manifest.snapshot.sha256)mismatch=true;
manifest.sourceSnapshotSha256=manifest.snapshot.sha256;
delete manifest.runtimeSha256;
if(check && mismatch)throw new Error('Artifact manifest differs from checked-in bytes');
if(!check)await writeFile(manifestURL,JSON.stringify(manifest,null,2)+'\n');
console.log('Artifact bytes and SHA-256 hashes verified');
