import {getPayload} from 'payload';
import {researchConfig} from './config';
const secret=process.env.PAYLOAD_SECRET;
if(!secret)throw new Error('Set a private PAYLOAD_SECRET of at least 32 characters');
const payload=await getPayload({config:researchConfig(process.env.CMS_DATABASE_URL ?? 'file:./research-notes.db',secret)});
try {
  const [operation,...args]=process.argv.slice(2);
  if(operation==='add') {
    const [ticker,sourceURL,...words]=args;
    if(!ticker || !sourceURL || !words.length)throw new Error('Usage: cms add TICKER https://source thesis text');
    console.log(JSON.stringify(await payload.create({collection:'research-notes',data:{ticker,sourceURL,thesis:words.join(' ')},overrideAccess:true}),null,2));
  } else if(operation==='review') {
    if(!args[0])throw new Error('Supply a note ID');
    console.log(JSON.stringify(await payload.update({collection:'research-notes',id:args[0],data:{status:'reviewed'},overrideAccess:true}),null,2));
  } else if(operation==='list') {
    console.log(JSON.stringify(await payload.find({collection:'research-notes',overrideAccess:true,limit:100}),null,2));
  } else throw new Error('Use cms add, cms review or cms list');
} finally {
  await payload.destroy();
  (payload.db as unknown as {client:{close:()=>void}}).client.close();
}
