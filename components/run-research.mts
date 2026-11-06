import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmdirSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

type Observation={ticker:string;observed_ts:number;settled_ts:number;bid:number;ask:number;midpoint:number;outcome:number};
type Archive={protocol:{holdout_start:string};observations:Observation[]};
const here=fileURLToPath(new URL('.',import.meta.url));
const archived=fileURLToPath(new URL('../web/research-data/settlement-calibration-archive.json',import.meta.url));
const maxBytes=24*1024*1024;
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const jsonl=(rows:object[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';

export function archiveInputs(archive:Archive){
  const cutoff=Date.parse(archive.protocol.holdout_start)/1000;
  if(!Number.isFinite(cutoff)||!Array.isArray(archive.observations))throw new Error('The public archive is missing its holdout protocol.');
  const rows=archive.observations.filter(row=>row.observed_ts>=cutoff&&(row.outcome===0||row.outcome===1));
  if(!rows.length)throw new Error('The archive contains no binary observations in the holdout.');
  return {
    quotes:jsonl(rows.map(row=>({ticker:row.ticker,observed_at:iso(row.observed_ts),yes_bid:row.bid,yes_ask:row.ask}))),
    forecasts:jsonl(rows.map(row=>({ticker:row.ticker,forecast_at:iso(row.observed_ts),settled_at:iso(row.settled_ts),
      probability_yes:row.midpoint,outcome_yes:row.outcome===1})))
  };
}

function readInput(path:string){
  const file=statSync(path);
  if(!file.isFile()||file.size>maxBytes)throw new Error('Use a regular input file no larger than 24 MiB.');
  return readFileSync(path);
}

function run(command:string,args:string[],{cwd=here,input,label}:{cwd?:string;input?:string|Buffer;label:string}){
  const child=spawnSync(command,args,{cwd,input,encoding:'utf8',timeout:120000,maxBuffer:maxBytes,windowsHide:true});
  if(child.error)throw new Error(label+' could not run: '+child.error.message);
  if(child.status!==0)throw new Error(label+' exited with status '+child.status+': '+child.stderr.trim().slice(0,1200));
  return child.stdout;
}

function main(){
  const {values}=parseArgs({options:{
    quotes:{type:'string'},forecasts:{type:'string'},format:{type:'string',default:'json'},archive:{type:'boolean',default:false}
  }});
  if(Boolean(values.quotes)!==Boolean(values.forecasts))throw new Error('Provide both --quotes and --forecasts, or omit both to use the tracked holdout.');
  const format=values.format??'json';
  if(!['json','markdown'].includes(format))throw new Error('Choose json or markdown.');
  const jar=process.env.PREDICTIR_JACKSON_JAR;
  if(!jar||!existsSync(jar))throw new Error('Set PREDICTIR_JACKSON_JAR to the verified jar from components/calibration.');
  const inputs=values.quotes&&values.forecasts?
    {quotes:readInput(values.quotes),forecasts:readInput(values.forecasts)}:
    archiveInputs(JSON.parse(readFileSync(archived,'utf8')));
  if(Object.values(inputs).some(value=>Buffer.byteLength(value)>maxBytes))throw new Error('Input exceeds the 24 MiB work limit.');
  const go=process.env.PREDICTIR_DEPTH_EXE;
  const depth=run(go?resolve(go):'go',go?[]:['run','.'],{cwd:join(here,'depth'),input:inputs.quotes,label:'Go quote replay'});
  const calibration=run('java',['-cp',resolve(jar),join(here,'calibration','Calibration.java')],{input:inputs.forecasts,label:'Java calibration'});
  const staging=mkdtempSync(join(tmpdir(),'predictir-research-'));
  const quotes=join(staging,'depth.json'),forecasts=join(staging,'calibration.json');
  try{
    writeFileSync(quotes,depth,{flag:'wx'});writeFileSync(forecasts,calibration,{flag:'wx'});
    const docker=process.env.PREDICTIR_RECEIPTS_DOCKER_IMAGE;
    if(docker&&values.archive)throw new Error('Use the bundled Ruby runtime for MongoDB archival.');
    const receipt=['receipt.rb','create','--depth',docker?'/reports/depth.json':quotes,
      '--calibration',docker?'/reports/calibration.json':forecasts,'--format',format,...(values.archive?['--archive']:[])];
    const ruby=values.archive?['bundle',['exec','ruby',...receipt]] as const:['ruby',receipt] as const;
    const receiptDir=join(here,'receipts');
    const command=docker?['docker',['run','--rm','--mount','type=bind,source='+staging+',target=/reports,readonly',
      '--mount','type=bind,source='+receiptDir+',target=/app,readonly','--workdir','/app',docker,'ruby',...receipt]] as const:ruby;
    process.stdout.write(run(command[0],[...command[1]],{cwd:receiptDir,label:'Ruby research receipt'}));
  }finally{
    for(const path of [quotes,forecasts])if(existsSync(path))unlinkSync(path);
    rmdirSync(staging);
  }
}

if(import.meta.main)try{main();}catch(error){console.error(error instanceof Error?error.message:'Research run failed.');process.exitCode=1;}
