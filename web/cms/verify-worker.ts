import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {getPayload} from 'payload';
import {researchConfig} from './config';
if(!process.env.CMS_VERIFY_URL)throw new Error('Use the CMS verification launcher');
const payload=await getPayload({config:researchConfig(process.env.CMS_VERIFY_URL,randomBytes(32).toString('hex'))});
try{
  const note=await payload.create({collection:'research-notes',data:{ticker:'SYNTHETIC-TEST',thesis:'Fixture thesis, not a live recommendation',sourceURL:'https://example.test/source'},overrideAccess:true});
  const updated=await payload.update({collection:'research-notes',id:note.id,data:{status:'reviewed'},overrideAccess:true});
  assert.equal(updated.status,'reviewed');
  const stored=await payload.find({collection:'research-notes',where:{ticker:{equals:'SYNTHETIC-TEST'}},overrideAccess:true});
  assert.equal(stored.totalDocs,1);
  let anonymousBlocked=false;
  try{const result=await payload.find({collection:'research-notes',overrideAccess:false});anonymousBlocked=result.totalDocs===0;}
  catch{anonymousBlocked=true;}
  assert.ok(anonymousBlocked);
  console.log(JSON.stringify({payloadSQLite:true,createReadUpdate:true,anonymousReadBlocked:true,fixtureOnly:true}));
}finally{
  await payload.destroy();
  (payload.db as unknown as {client:{close:()=>void}}).client.close();
}
