const SCALE=10000,SIZE=SCALE+2;

export class PriceIndex {
  constructor() {
    this.quantity=new Float64Array(SIZE);this.countTree=new Int32Array(SIZE);
    this.quantityTree=new Float64Array(SIZE);this.costTree=new Float64Array(SIZE);this.size=0;
  }
  tick(price) {
    const tick=Math.round(price*SCALE);
    if(!Number.isFinite(price)||price<0||price>1||Math.abs(price-tick/SCALE)>1e-9)throw new RangeError('Unsupported price precision');
    return tick+1;
  }
  update(tree,index,delta) { for(let i=index;i<SIZE;i+=i&-i)tree[i]+=delta; }
  get(price) {return this.quantity[this.tick(price)]||0;}
  set(price,value) {
    if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid depth quantity');
    const index=this.tick(price),old=this.quantity[index],change=Number(value>0)-Number(old>0);
    this.quantity[index]=value;this.size+=change;this.update(this.countTree,index,change);
    this.update(this.quantityTree,index,value-old);this.update(this.costTree,index,(value-old)*price); return this;
  }
  delete(price) {const old=this.get(price);this.set(price,0);return old>0;}
  sum(tree,index) {let result=0;for(let i=index;i>0;i-=i&-i)result+=tree[i];return result;}
  prefix(price) {const index=this.tick(price);return {quantity:this.sum(this.quantityTree,index),cost:this.sum(this.costTree,index)};}
  select(rank) {
    let index=0;
    for(let bit=8192;bit;bit>>=1) {const next=index+bit;if(next<SIZE&&this.countTree[next]<rank){rank-=this.countTree[next];index=next;}}
    return index+1;
  }
  best() {return this.size?(this.select(this.size)-1)/SCALE:null;}
  top(limit=this.size) {
    const rows=[];
    for(let rank=this.size;rank>Math.max(0,this.size-limit);rank--) {const index=this.select(rank);rows.push([(index-1)/SCALE,this.quantity[index]]);}
    return rows;
  }
  *keys() {for(const [price] of this.top())yield price;}
  *[Symbol.iterator]() {yield* this.top();}
}
