export const REVIEW_INTERVAL_MS=25*60*1000;
const FIRST_REVIEW_MS=2*60*1000;
export const REVIEW_DEADLINE_MS=8000;
export const REVIEW_SETTINGS_KEY='predictir.position-reviews.v1';

export function positionReviewInput(position,positions,model){
  const quantity=position.remaining_quantity;
  const shared_quantity=positions.filter(row=>row.ticker===position.ticker&&row.side===position.side)
    .reduce((sum,row)=>sum+row.remaining_quantity,0);
  return {ticker:position.ticker,side:position.side,quantity,basis:position.remaining_basis,shared_quantity,model};
}

export function duePositionReviews(positions,settings,now=Date.now()){
  return positions.filter(row=>{
    const setting=settings[row.id],opened=Date.parse(row.opened_at)||0;
    const due=setting?.checked?setting.checked+REVIEW_INTERVAL_MS:opened+FIRST_REVIEW_MS;
    return row.remaining_quantity>1e-8&&!setting?.paused&&now>=due;
  });
}

export function reviewSettings(raw){
  try{
    const records=JSON.parse(raw||'{}');
    return Object.fromEntries(Object.entries(records).slice(-1000).filter(([id,row])=>
      /^[\w-]{1,100}$/.test(id)&&row&&typeof row==='object').map(([id,row])=>[id,{
      paused:row.paused===true,checked:Number.isFinite(row.checked)?row.checked:0,sell:row.sell===true,unread:row.unread===true
    }]));
  }catch{return {};}
}

export function automaticReviewSignal(action,previous={}){
  const notify=action==='SELL'&&!previous.sell&&!previous.paused;
  return {notify,sell:action==='SELL'||(action==='REVIEW'&&previous.sell===true),
    unread:notify||(previous.unread===true&&action!=='HOLD'&&action!=='SETTLE')};
}
