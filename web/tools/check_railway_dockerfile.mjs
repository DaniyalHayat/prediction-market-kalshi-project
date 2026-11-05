import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function checkRailwayDockerfile(source){
  const instructions=String(source).replace(/\\\r?\n/g,' ').split(/\r?\n/);
  if(instructions.some(line=>/^\s*VOLUME(?:\s|$)/i.test(line)))throw new Error('Railway does not support Docker VOLUME instructions. Configure persistent mounts through Railway only when required.');
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{checkRailwayDockerfile(await readFile(new URL('../Dockerfile',import.meta.url),'utf8'));process.stdout.write('Railway Dockerfile compatibility check passed.\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
