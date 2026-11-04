import {server} from './server.mjs';
import {startPipeline} from './pipeline.mjs';
const stop=startPipeline();
if(!process.env.PORT)throw new Error('Set PORT before starting the hosted backend');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),8000).unref();});
