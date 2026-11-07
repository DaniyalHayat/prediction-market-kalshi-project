const socialHosts=new Set(['api.x.com','x.com','twitter.com','api.twitter.com','www.reddit.com','reddit.com','oauth.reddit.com']);

export const socialEvidenceEnabled=(env=process.env)=>env.PREDICTIR_SOCIAL_EVIDENCE_ENABLED==='1';
export const socialSourceDisabled=(hostname,env=process.env)=>socialHosts.has(hostname)&&!socialEvidenceEnabled(env);
export const socialDisabledResult=()=>({status:'disabled',posts:[],reason:'Social evidence retrieval is disabled for this deployment.'});
