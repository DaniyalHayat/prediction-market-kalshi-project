import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
await import('./prepare_dashboard.mjs');
const out=process.env.MARKET_FIGMA_DIR||'../.figma-export';
await mkdir(out,{recursive:true});await cp('public',out,{recursive:true});
const base=process.env.MARKET_PUBLIC_API||'https://xgcpzl73zl4yxyr0.s28.lambda-web.us-east-2.on.aws';
if(new URL(base).protocol!=='https:')throw new Error('Use a public HTTPS backend');
for(const name of ['lab.html','dashboard/index.html']){
  const path=out+'/'+name,html=await readFile(path,'utf8');
  await writeFile(path,html.replace('<head>','<head><script>window.MARKET_API_BASE='+JSON.stringify(base)+'</script>'));
}
await writeFile(out+'/index.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=dashboard/index.html"><title>Kalshi Market Lab</title></head><body><a href="dashboard/index.html">Open Kalshi Market Lab</a></body></html>');
console.log('Figma static frontend prepared; live APIs remain on the documented AWS backend');
