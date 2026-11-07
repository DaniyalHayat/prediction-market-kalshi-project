import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRailwayDockerfile,REQUIRED_RESEARCH_ARCHIVES} from '../tools/check_railway_dockerfile.mjs';

test('Railway rejects persistent Docker declarations while allowing a writable ephemeral cache',()=>{
  const continued=['  VOLUME \\','    /tmp/cache'].join('\n');
  for(const instruction of ['VOLUME ["/tmp/cache"]','volume /tmp/cache',continued])assert.throws(()=>checkRailwayDockerfile('FROM node\n'+instruction),/does not support Docker VOLUME/);
  const archives=REQUIRED_RESEARCH_ARCHIVES.map(name=>'COPY research-data/'+name+' ./research-data/'+name).join('\n');
  assert.doesNotThrow(()=>checkRailwayDockerfile('FROM node\n# VOLUME is intentionally absent\nENV CACHE=/tmp/cache\nRUN mkdir -p /tmp/cache\nUSER node\n'+archives));
});

test('Railway requires every named research archive or an explicit full-directory copy',()=>{
  const exact=REQUIRED_RESEARCH_ARCHIVES.map(name=>'COPY research-data/'+name+' ./research-data/'+name).join('\n');
  assert.doesNotThrow(()=>checkRailwayDockerfile('FROM node\n'+exact));
  assert.throws(()=>checkRailwayDockerfile('FROM node\nCOPY research-data/weather-settlement-archive.json ./research-data/weather-settlement-archive.json'),/nfl-heldout-predictions-2025.json/);
  assert.doesNotThrow(()=>checkRailwayDockerfile('FROM node\nCOPY research-data ./research-data'));
});
