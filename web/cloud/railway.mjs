import {server} from './server.mjs';
import {startPipeline} from './pipeline.mjs';
import {closeStore} from '../lib/cloud/store.mjs';
import {drainMarketRuntime} from './shutdown.mjs';
import {runDatabaseEgressProof} from './egress-proof.mjs';
const stop=startPipeline();
void runDatabaseEgressProof();
if(!process.env.PORT)throw new Error('Set PORT before starting the hosted backend');
let draining=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{
  if(draining)return;draining=true;
  try{await drainMarketRuntime({server,stopPipeline:stop,closeStorage:closeStore});process.exit(0);}
  catch{process.stderr.write('Backend shutdown could not fully drain.\n');process.exit(1);}
});
