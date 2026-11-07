import {parse,parseFragment} from 'parse5';

const ignored=new Set(['script','style','template','noscript','iframe','object']);
const boundaries=new Set(['br','p','div','li','td','th','tr','h1','h2','h3','section']);
const normalize=value=>value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();

export function htmlDocument(value){
  if(typeof value!=='string'||Buffer.byteLength(value)>6_000_000)throw new RangeError('HTML source exceeds the parsing limit');
  return parse(value);
}
export function* htmlElements(root,name){
  const stack=[root];
  while(stack.length){
    const node=stack.pop();
    if(ignored.has(node.tagName))continue;
    if(node.tagName===name)yield node;
    for(let i=(node.childNodes?.length||0)-1;i>=0;i--)stack.push(node.childNodes[i]);
  }
}
export const htmlAttribute=(node,name)=>node.attrs?.find(attribute=>attribute.name===name)?.value;
export function htmlNodeText(root,maximum=6000){
  const stack=[root],parts=[];let length=0;
  while(stack.length&&length<maximum){
    const node=stack.pop();
    if(node.nodeName==='#boundary'){parts.push(' ');length++;continue;}
    if(ignored.has(node.tagName))continue;
    if(node.nodeName==='#text'){
      const value=node.value.slice(0,maximum-length);parts.push(value);length+=value.length;
    }else{
      if(boundaries.has(node.tagName)){parts.push(' ');length++;stack.push({nodeName:'#boundary'});}
      for(let i=(node.childNodes?.length||0)-1;i>=0;i--)stack.push(node.childNodes[i]);
    }
  }
  return normalize(parts.join('')).slice(0,maximum);
}
export function htmlText(value,maximum=6000){
  const source=String(value??'');
  if(!/[<&]/.test(source))return normalize(source).slice(0,maximum);
  if(Buffer.byteLength(source)>1_000_000)throw new RangeError('HTML text exceeds the parsing limit');
  return htmlNodeText(parseFragment(source),maximum);
}
