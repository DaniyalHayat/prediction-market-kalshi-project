import {newsURL} from './news-reading.mjs';

const sourceLine=/^Sources checked:\s*/i;
const contractLine=/^[^.!?\n]{1,180} \(KX[A-Z0-9._-]+\)$/i;

export function linkParts(line){
  return line.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).filter(Boolean).map(part=>{
    const link=part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
    const url=link&&newsURL(link[2]);
    return url?{text:link[1],url}:{text:part};
  });
}

export function answerSections(text){
  const sections=[],sources=new Map();
  let current={title:'The short answer',lines:[]};
  for(const raw of text.split('\n')){
    const line=raw.trim();
    if(!line)continue;
    if(sourceLine.test(line)){
      const citation=line.replace(sourceLine,'');
      const linked=linkParts(citation).filter(part=>part.url);
      if(linked.length){
        for(const item of linked)sources.set(item.url,item);
        continue;
      }
    }
    if(line.startsWith('## ')){
      if(current.lines.length)sections.push(current);
      current={title:line.slice(3),lines:[]};
    }else if(!sections.length&&!current.lines.length&&contractLine.test(line)){
      continue;
    }else{
      current.lines.push(line);
    }
  }
  if(current.lines.length)sections.push(current);
  return {sections,sources:[...sources.values()]};
}
