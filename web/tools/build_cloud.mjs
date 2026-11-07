import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {copyPublicAssets} from './public-assets.mjs';
const out=process.env.MARKET_BUILD_DIR || '../.cloud-build/predictir';
await mkdir(out,{recursive:true});
await copyPublicAssets(out+'/public');
await build({entryPoints:['lib/paper/risk.ts'],outfile:out+'/public/risk-client.js',bundle:true,platform:'browser',target:'es2022',format:'esm',minify:true});
for(const [source,target] of [['cloud/server.mjs','index.js'],['cloud/worker.mjs','worker.mjs']])
  await build({entryPoints:[source],outfile:out+'/'+target,bundle:true,platform:'node',target:'node22',format:'esm',
    banner:{js:"import {createRequire as __nodeCreateRequire} from 'node:module';const require=__nodeCreateRequire(import.meta.url);"},
    external:['bufferutil','utf-8-validate'],minify:true});
await writeFile(out+'/package.json',JSON.stringify({name:'market-lab-cloud',type:'module',private:true}));
console.log('Cloud package built at '+out);
