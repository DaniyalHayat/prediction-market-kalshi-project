import {sourceText} from './providers.mjs';
export function robotsAllowed(text,path,userAgent='KalshiMarketLab'){
  if(typeof text!=='string'||text.length>100000)return false;
  const groups=[];let agents=[],rules=[],hasRule=false;
  const commit=()=>{if(agents.length)groups.push({agents,rules});agents=[];rules=[];hasRule=false;};
  for(const line of text.split(/\r?\n/)){
    const value=line.replace(/#.*/,'').trim(),match=value.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);if(!match)continue;
    const type=match[1].toLowerCase(),pattern=match[2].trim();
    if(type==='user-agent'){if(hasRule)commit();agents.push(pattern.toLowerCase());}
    else if(agents.length){hasRule=true;if(pattern)rules.push({allow:type==='allow',pattern});}
  }commit();
  const matching=groups.map(g=>({...g,specificity:Math.max(-1,...g.agents.map(a=>a==='*'?0:userAgent.toLowerCase().includes(a)?a.length:-1))})).filter(g=>g.specificity>=0),specificity=Math.max(-1,...matching.map(g=>g.specificity));
  const applicable=matching.filter(g=>g.specificity===specificity).flatMap(g=>g.rules).filter(r=>new RegExp('^'+r.pattern.split('*').map(s=>s.replace(/[.+?^{}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\\$$/,'$')).test(path)).sort((a,b)=>b.pattern.length-a.pattern.length||Number(b.allow)-Number(a.allow));
  return applicable[0]?.allow??true;
}
export async function permittedPublicPage(id,url,{maximumBytes=1_000_000,ttl=3600,fetcher=fetch}={}){
  const target=new URL(url),robot=await sourceText(id+' robots',target.origin+'/robots.txt',{ttl:86400,maximumBytes:100000,fetcher});
  if(!robotsAllowed(robot.data.text,target.pathname+target.search)||!robotsAllowed(robot.data.text,target.pathname+target.search,'GPTBot'))return {status:'robots_blocked',source_url:url,as_of:robot.as_of,reason:'The public source’s robots policy disallows automated retrieval. No page request was made.'};
  const page=await sourceText(id,url,{ttl,maximumBytes,fetcher});
  if(/(?:captcha|access denied|verify you are human|blocked by network security)/i.test(page.data.text.slice(0,100000)))return {status:'access_blocked',source_url:url,as_of:page.as_of,reason:'The public source requested an access or human-verification check. Retrieval stopped.'};
  return {status:'available',...page};
}
