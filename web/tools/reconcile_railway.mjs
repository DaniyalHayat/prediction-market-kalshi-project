import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execute=promisify(execFile);
const readQuery='query($environmentId:String!,$serviceId:String!){serviceInstance(environmentId:$environmentId,serviceId:$serviceId){serviceId environmentId rootDirectory watchPatterns restartPolicyMaxRetries source{repo} service{projectId}}}';
const updateQuery='mutation($environmentId:String!,$serviceId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)}';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
async function cli(args){const {stdout}=await execute(process.env.RAILWAY_CLI_PATH||'railway',args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1000000});return JSON.parse(stdout);}
export async function reconcileRailway({spec,apply=false,run=cli}){
  if(![spec?.projectId,spec?.environmentId,spec?.serviceId].every(uuid)||typeof spec.repository!=='string'||!/^\w[\w.-]*\/[\w.-]+$/.test(spec.repository)||spec.rootDirectory!=='/web'||JSON.stringify(spec.watchPatterns)!==JSON.stringify(['/web/**'])||spec.restartPolicyMaxRetries!==3)throw new Error('The existing-service configuration manifest is invalid');
  const variables={environmentId:spec.environmentId,serviceId:spec.serviceId};
  async function read(){
    const response=await run(['api',readQuery,'--variables',JSON.stringify(variables),'--compact']),actual=response.data?.serviceInstance;
    if(response.errors||!actual)throw new Error('Railway service inspection was unavailable');
    if(actual.serviceId!==spec.serviceId||actual.environmentId!==spec.environmentId||actual.service?.projectId!==spec.projectId||actual.source?.repo!==spec.repository||actual.rootDirectory!==spec.rootDirectory)throw new Error('The linked service does not match the intended existing project, repository and root directory');
    return actual;
  }
  const before=await read(),patch={};
  for(const key of ['watchPatterns','restartPolicyMaxRetries'])if(JSON.stringify(before[key])!==JSON.stringify(spec[key]))patch[key]=spec[key];
  const result={mode:apply?'apply':'preview',project:spec.projectId,environment:spec.environmentId,service:spec.serviceId,changes:patch,verified:false};
  if(!Object.keys(patch).length)return {...result,verified:true};
  if(!apply)return result;
  const changed=await run(['api',updateQuery,'--variables',JSON.stringify({...variables,input:patch}),'--compact']);
  if(changed.errors||changed.data?.serviceInstanceUpdate!==true)throw new Error('Railway rejected the existing-service settings update');
  const after=await read();if(Object.entries(patch).some(([key,value])=>JSON.stringify(after[key])!==JSON.stringify(value)))throw new Error('Railway settings did not match the reviewed plan after apply');
  return {...result,verified:true};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{
    if(process.argv.slice(2).some(argument=>argument!=='--apply'))throw new Error('Use --apply only after reviewing the preview');
    const spec=JSON.parse(await readFile(new URL('../infra/railway-service.json',import.meta.url),'utf8'));
    console.log(JSON.stringify(await reconcileRailway({spec,apply:process.argv.includes('--apply')}),null,2));
  }catch(error){process.stderr.write('Railway reconciliation failed: '+(error.message.startsWith('Command failed')?'the authenticated CLI request did not complete':error.message)+'\n');process.exitCode=1;}
}
