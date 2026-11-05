import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publicSource, assertCurrentPublicAssets} from './public-assets.mjs';

await assertCurrentPublicAssets();
for(const [name,signature] of [['favicon.ico','00000100'],['favicon.png','89504e470d0a1a0a']]){
  const bytes=await readFile(join(publicSource,name));
  if(bytes.subarray(0,signature.length/2).toString('hex')!==signature)throw new Error('Browser asset is not an image: '+name);
}
console.log('Public browser assets verified');
