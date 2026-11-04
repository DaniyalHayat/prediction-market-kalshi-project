import { buildConfig, type CollectionConfig } from 'payload';
import { sqliteAdapter } from '@payloadcms/db-sqlite';
const authenticated=({req}: {req:{user?:unknown}})=>Boolean(req.user);
const Notes: CollectionConfig={slug:'research-notes',access:{read:authenticated,create:authenticated,update:authenticated,delete:authenticated},
  fields:[{name:'ticker',type:'text',required:true,index:true},{name:'thesis',type:'textarea',required:true},
    {name:'sourceURL',type:'text',required:true,validate:(value:unknown)=>{
      try {return typeof value==='string' && new URL(value).protocol==='https:' || 'Use an HTTPS source URL';}
      catch {return 'Use an HTTPS source URL';}
    }},{name:'status',type:'select',options:['draft','reviewed'],defaultValue:'draft',required:true}]};
export function researchConfig(url:string,secret:string) {
  if(secret.length<32)throw new Error('CMS secret must have at least 32 characters');
  return buildConfig({secret,telemetry:false,collections:[{slug:'users',auth:true,fields:[],
    access:{read:authenticated,create:authenticated,update:authenticated,delete:authenticated}},Notes],
    db:sqliteAdapter({client:{url},push:true}),typescript:{outputFile:'cms/payload-types.ts'}});
}
