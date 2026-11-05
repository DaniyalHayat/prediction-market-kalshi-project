import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationOriginMatches} from '../lib/workspace/proxy.mjs';

test('development loopback normalization preserves legitimate local posts without accepting foreign origins, ports or production aliases',()=>{
  assert.equal(applicationOriginMatches('http://127.0.0.1:8768','http://localhost:8768/api/workspace/execution-research',{development:true}),true);
  assert.equal(applicationOriginMatches('http://127.0.0.1:8768','http://localhost:8768/api/workspace/execution-research',{development:false}),false);
  assert.equal(applicationOriginMatches('http://attacker.example:8768','http://localhost:8768/api/x',{development:true}),false);
  assert.equal(applicationOriginMatches('http://127.0.0.1:9999','http://localhost:8768/api/x',{development:true}),false);
  assert.equal(applicationOriginMatches('https://127.0.0.1:8768','http://localhost:8768/api/x',{development:true}),false);
  assert.equal(applicationOriginMatches('https://predictir.dev','https://predictir.dev/api/x',{development:false}),true);
  assert.equal(applicationOriginMatches('null','https://predictir.dev/api/x',{development:true}),false);
  assert.equal(applicationOriginMatches('http://127.0.0.1:8768','https://predictir.dev/api/x',{development:true}),false);
});
