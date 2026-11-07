export function forecastSourceAllowed(value){
  if(typeof value!=='string')return false;
  try{
    const url=new URL(value);
    return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&url.hostname.replace(/\.$/,'')!=='api.spotify.com';
  }catch{return false;}
}
