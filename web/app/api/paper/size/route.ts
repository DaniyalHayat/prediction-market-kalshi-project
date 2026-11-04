import { sizePaperPosition, type SizingInput } from '../../../../lib/paper/risk';
import {proxyBackend} from '../../../../lib/workspace/proxy.mjs';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const proxied=await proxyBackend(request,['paper','size']);if(proxied)return proxied;
  try {
    const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(reader){try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>20000){await reader.cancel();return Response.json({error:'Input too large'},{status:413});}chunks.push(value);}}finally{reader.releaseLock();}}
    const text=Buffer.concat(chunks).toString('utf8');
    const input: SizingInput=JSON.parse(text);
    return Response.json(sizePaperPosition(input),{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    return Response.json({error:error instanceof RangeError ? error.message : 'Invalid simulation input'},{status:400});
  }
}
