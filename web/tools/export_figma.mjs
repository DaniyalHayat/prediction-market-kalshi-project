import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {copyPublicAssets} from './public-assets.mjs';

const out = process.env.MARKET_FIGMA_DIR || '../.figma-export';
const backend = new URL(process.env.MARKET_PUBLIC_API || 'https://xgcpzl73zl4yxyr0.s28.lambda-web.us-east-2.on.aws');
if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('Use a public HTTPS origin for the backend');
}

await copyPublicAssets(out);
const workbench = join(out, 'lab.html');
const html = await readFile(workbench, 'utf8');
await writeFile(workbench, html.replace('<head>', '<head><script>window.MARKET_API_BASE=' + JSON.stringify(backend.origin) + '</script>'));

for (const [name, target] of [['index.html', 'lab.html'], ['dashboard/index.html', '../lab.html']]) {
  await writeFile(join(out, name), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Kalshi Market Lab</title></head><body><a href="${target}">Open Kalshi Market Lab</a></body></html>`);
}
console.log('Figma static frontend prepared; live APIs remain on the documented AWS backend');
