import {server} from './server.mjs';
import {startPipeline} from './pipeline.mjs';
import {closeStore} from '../lib/cloud/store.mjs';
import {drainMarketRuntime} from './shutdown.mjs';
import {categorySnapshot} from '../lib/workspace/catalog.mjs';
import {structuredLog} from '../lib/runtime-observability.mjs';
const stop=startPipeline();
if(!process.env.PORT)throw new Error('Set PORT before starting the hosted backend');
let catalogTimer;
if(process.env.PREDICTIR_MODE==='live'&&process.env.PREDICTIR_KEEP_CATALOG_WARM==='1'){
  const refresh=()=>void categorySnapshot('sports').catch(()=>structuredLog('catalog.warmup_failed',{category:'sports'}));
  const start=()=>{
    refresh();
    catalogTimer=setInterval(refresh,300000);
    catalogTimer.unref();
  };
  if(server.listening)start();else server.once('listening',start);
}
let draining=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{
  if(draining)return;draining=true;
  clearInterval(catalogTimer);
  try{await drainMarketRuntime({server,stopPipeline:stop,closeStorage:closeStore});process.exit(0);}
  catch{process.stderr.write('Backend shutdown could not fully drain.\n');process.exit(1);}
});
