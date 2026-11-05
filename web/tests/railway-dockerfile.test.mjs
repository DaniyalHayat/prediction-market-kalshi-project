import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRailwayDockerfile} from '../tools/check_railway_dockerfile.mjs';

test('Railway rejects persistent Docker declarations while allowing a writable ephemeral cache',()=>{
  const continued=['  VOLUME \\','    /tmp/cache'].join('\n');
  for(const instruction of ['VOLUME ["/tmp/cache"]','volume /tmp/cache',continued])assert.throws(()=>checkRailwayDockerfile('FROM node\n'+instruction),/does not support Docker VOLUME/);
  assert.doesNotThrow(()=>checkRailwayDockerfile('FROM node\n# VOLUME is intentionally absent\nENV CACHE=/tmp/cache\nRUN mkdir -p /tmp/cache\nUSER node\n'));
});
