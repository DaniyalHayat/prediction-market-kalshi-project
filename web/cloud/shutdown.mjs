export async function drainMarketRuntime({server,stopPipeline,closeStorage,timeoutMs=8000}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid shutdown deadline');
  let timer;const idle=setInterval(()=>server.closeIdleConnections?.(),100);
  const cleanup=(async()=>{
    const results=await Promise.allSettled([
      Promise.resolve().then(stopPipeline),
      new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()))
    ]);
    await closeStorage();
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    return 'drained';
  })();
  try{return await Promise.race([cleanup,new Promise(resolve=>{timer=setTimeout(()=>{server.closeAllConnections?.();resolve('deadline');},timeoutMs);})]);}
  finally{clearTimeout(timer);clearInterval(idle);}
}
