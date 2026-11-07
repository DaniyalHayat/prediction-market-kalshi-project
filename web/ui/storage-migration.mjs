const legacyPrefix='kalshi-market-lab:';
const prefix='predictir:';
const marker=prefix+'storage-migrated:v1';
const known=['guest-session:v1','active-account:v1','paper-journal:v1','paper-starting-balance:v1','appearance:v1','analytics-consent:v1'];

export function migratePredictirStorage(storage){
  if(storage.getItem(marker)==='complete')return false;
  const keys=new Set(known.map(key=>legacyPrefix+key));
  if(typeof storage.key==='function'&&Number.isSafeInteger(storage.length)){
    for(let index=0;index<storage.length;index++){
      const key=storage.key(index);
      if(typeof key==='string'&&key.startsWith(legacyPrefix))keys.add(key);
    }
  }
  const copied=[];
  try{
    for(const oldKey of keys){
      const value=storage.getItem(oldKey);if(value===null)continue;
      const key=prefix+oldKey.slice(legacyPrefix.length),previous=storage.getItem(key);
      if(previous!==null&&!(key===prefix+'analytics-consent:v1'&&value==='denied'&&previous!=='denied'))continue;
      storage.setItem(key,value);copied.push({key,value,previous});
    }
    storage.setItem(marker,'complete');
    return copied.length>0;
  }catch(error){
    for(const {key,value,previous} of copied.reverse()){
      if(storage.getItem(key)!==value)continue;
      if(previous===null)storage.removeItem(key);else storage.setItem(key,previous);
    }
    throw error;
  }
}

