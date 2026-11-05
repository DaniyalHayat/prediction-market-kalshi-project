export const PREFERENCE_KEY='kalshi-market-lab:appearance:v1';
export const DEFAULT_PREFERENCES=Object.freeze({theme:'graphite',layout:'balanced',density:'comfortable',model:'validated'});
export const THEMES={
  graphite:{name:'Graphite',description:'Neutral black, clear blue accents',panel:'#10151d',ink:'#edf2f9',muted:'#a9b6c8',accent:'#8db8ff'},
  midnight:{name:'Midnight',description:'Deep navy with cool highlights',panel:'#0b1016',ink:'#e8f2ff',muted:'#a2b8cf',accent:'#9bcdff'},
  light:{name:'Light',description:'Paper white for bright rooms',panel:'#ffffff',ink:'#172231',muted:'#536173',accent:'#174d91'}
};
export function appearance(value){
  let data=value;
  if(typeof data==='string'){try{data=JSON.parse(data);}catch{data=null;}}
  return {theme:Object.hasOwn(THEMES,data?.theme)?data.theme:DEFAULT_PREFERENCES.theme,
    layout:['balanced','analysis','wide-list'].includes(data?.layout)?data.layout:DEFAULT_PREFERENCES.layout,
    density:['comfortable','compact'].includes(data?.density)?data.density:DEFAULT_PREFERENCES.density,
    model:['validated','challenger'].includes(data?.model)?data.model:DEFAULT_PREFERENCES.model};
}
export function contrastRatio(a,b){
  const luminance=hex=>{
    if(!/^#[a-f\d]{6}$/i.test(hex))throw new RangeError('Six-digit colors are required');
    const channels=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  };
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
