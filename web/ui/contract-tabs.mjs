export const CONTRACT_TABS=Object.freeze([['overview','Overview'],['research','Analysis'],['paper','Paper position'],['execution','Execution lab'],['rules','Rules & sources']]);
export function moveContractTab(current,key){
  const ids=CONTRACT_TABS.map(([id])=>id),index=ids.indexOf(current);
  if(index<0)return null;
  if(key==='Home')return ids[0];if(key==='End')return ids.at(-1);
  if(key==='ArrowRight')return ids[(index+1)%ids.length];
  if(key==='ArrowLeft')return ids[(index-1+ids.length)%ids.length];
  return null;
}
