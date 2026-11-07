import {constants,promises as fs} from 'node:fs';

export async function readBoundedTextFile(path,maximum,message='File exceeds the inspection limit'){
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>16_000_000)throw new RangeError('Invalid file inspection limit');
  const handle=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  try{
    const info=await handle.stat();
    if(!info.isFile())throw Object.assign(new Error('Inspection requires a regular file'),{code:'INVALID_FILE_TYPE',status:503});
    if(info.size>maximum)throw Object.assign(new Error(message),{code:'FILE_TOO_LARGE',status:503});
    const chunks=[];let total=0;
    while(total<=maximum){
      const buffer=Buffer.allocUnsafe(Math.min(65536,maximum-total+1));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      total+=bytesRead;
      if(total>maximum)throw Object.assign(new Error(message),{code:'FILE_TOO_LARGE',status:503});
      chunks.push(buffer.subarray(0,bytesRead));
    }
    return Buffer.concat(chunks,total).toString('utf8');
  }finally{await handle.close();}
}
