import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const REQUIRED_RESEARCH_ARCHIVES=Object.freeze([
  'crypto-minute-archive.json.gz',
  'nba-completed-games-2026-11-04.json.gz',
  'nba-quarter-replay-2026-11-04.json.gz',
  'nfl-heldout-predictions-2025.json',
  'settlement-calibration-archive.json',
  'weather-settlement-archive.json',
  'weekly-tsa-archive.json'
]);

export function checkRailwayDockerfile(source){
  const instructions=String(source).replace(/\\\r?\n/g,' ').split(/\r?\n/);
  if(instructions.some(line=>/^\s*VOLUME(?:\s|$)/i.test(line)))throw new Error('Railway does not support Docker VOLUME instructions. Configure persistent mounts through Railway only when required.');
  const copies=instructions.filter(line=>/^\s*COPY\s/i.test(line)).join('\n');
  const wildcardCopy=/^\s*COPY\s+research-data\s+\.\/research-data\/?\s*$/im.test(copies);
  const missing=REQUIRED_RESEARCH_ARCHIVES.filter(name=>!wildcardCopy&&!copies.includes(name));
  if(missing.length)throw new Error('Railway Dockerfile is missing required research archives: '+missing.join(', '));
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{checkRailwayDockerfile(await readFile(new URL('../Dockerfile',import.meta.url),'utf8'));process.stdout.write('Railway Dockerfile compatibility check passed.\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
