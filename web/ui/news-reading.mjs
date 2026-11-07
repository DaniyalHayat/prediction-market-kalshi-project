const rows=value=>Array.isArray(value)?value:[];
const social=item=>['reddit','x'].includes(item?.platform);
const titleKey=value=>String(value||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export function newsURL(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}

function articleKey(value){
  const safe=new URL(value);
  for(const name of [...safe.searchParams.keys()]){
    if(/^(?:utm_.+|fbclid|gclid|ref_src)$/i.test(name))safe.searchParams.delete(name);
  }
  safe.searchParams.sort();
  const socialID=safe.hostname.match(/^(?:www\.)?(?:x|twitter)\.com$/)&&safe.pathname.match(/\/status\/(\d+)/)?.[1];
  return socialID?'x/status/'+socialID:safe.hostname.replace(/^www\./,'')+safe.pathname.replace(/\/+$/,'')+safe.search;
}

export function readNews(value,articles,{reddit=false,x=false}={}){
  const seenLinks=new Set(),seenTitles=new Set(),news={matched:[],related:[],social:[],headlines:[]};
  const directRows=rows(value?.items),relatedRows=rows(value?.related_items);
  for(const [scope,items] of [['matched',directRows.filter(item=>!social(item))],['related',relatedRows.filter(item=>!social(item))],
    ['social',[...directRows,...relatedRows].filter(social)],['headlines',articles]]){
    for(const item of rows(items)){
      if(item?.platform==='reddit'&&!reddit||item?.platform==='x'&&!x)continue;
      const url=newsURL(item?.url),title=titleKey(item?.title);
      if(!url||!title)continue;
      const key=articleKey(url);
      if(seenLinks.has(key)||seenTitles.has(title))continue;
      seenLinks.add(key);seenTitles.add(title);
      news[social(item)?'social':scope].push({...item,url});
    }
  }
  const direct=news.matched.length>0,ranked=direct?news.matched:news.related;
  const lead=ranked[0];
  const second=lead?.publisher?ranked.find((item,index)=>index>0&&item.publisher&&titleKey(item.publisher)!==titleKey(lead.publisher)):null;
  const highlighted=[lead,second].filter(Boolean);
  const sections=rows(value?.news_sections).filter(row=>row?.text&&
    !['What changed','Why it matters','What the sources cover'].includes(row.heading));
  return {...news,lead,second,direct,sections,
    moreMatched:news.matched.filter(row=>!highlighted.includes(row)),
    moreRelated:news.related.filter(row=>!highlighted.includes(row))};
}

