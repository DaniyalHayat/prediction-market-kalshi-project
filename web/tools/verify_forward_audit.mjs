import { readFile } from "node:fs/promises";
import { verifyAuditEntries } from "../lib/quant/forward.mjs";

if(!process.argv[2]) {
  console.error("Usage: node tools/verify_forward_audit.mjs path/to/observed-cohort.json");
  process.exit(1);
}
const artifact=JSON.parse(await readFile(process.argv[2],"utf8"));
if(!Array.isArray(artifact.audit_headers))throw new Error("Artifact has no replayable audit headers; export it again from the app.");
const events=artifact.audit_headers.map(header=>({...header,content:header.type==="freeze" ? artifact.frozen : artifact.result}));
const hash=verifyAuditEntries(events);
if(hash!==artifact.audit.last_hash || events[0].hash!==artifact.audit.freeze_hash)throw new Error("Public audit anchor mismatch");
console.log(JSON.stringify({id:artifact.id,events:events.length,verified:true,last_hash:hash,
  qualification:"Internal hash-chain consistency verified; this is not an exchange-signed fill or an independent trusted timestamp."},null,2));
