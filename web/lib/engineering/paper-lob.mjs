export function normalizePaperOrder({id, owner, side, price, quantity, timeInForce = 'GTC'}) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || typeof owner !== 'string' || !owner || owner.length > 80 || !['buy', 'sell'].includes(side) || !Number.isSafeInteger(price) || price < 1 || price > 99 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000 || !['GTC', 'IOC', 'FOK'].includes(timeInForce)) throw new RangeError('Invalid paper limit order');
  return {id, owner, side, price, quantity, timeInForce};
}

export class PaperLimitOrderBook {
  constructor({maximumOrders = 10000} = {}) {
    if (!Number.isInteger(maximumOrders) || maximumOrders < 1 || maximumOrders > 100000) throw new RangeError('Invalid paper order capacity');
    this.orders = new Map(); this.levels = {buy: new Map(), sell: new Map()}; this.sequence = 0; this.maximumOrders = maximumOrders;
  }
  submit(order) {
    const {id, owner, side, price, quantity, timeInForce} = normalizePaperOrder(order);
    if (this.orders.has(id)) throw Object.assign(new Error('Duplicate active order'), {code: 'DUPLICATE_ACTIVE_ORDER'});
    if (timeInForce === 'GTC' && this.orders.size >= this.maximumOrders) throw Object.assign(new Error('Paper order capacity reached'), {code: 'PAPER_ORDER_CAPACITY'});
    const opposite = side === 'buy' ? 'sell' : 'buy', prices = [...this.levels[opposite].keys()].sort((a, b) => side === 'buy' ? a - b : b - a);
    const crosses = value => side === 'buy' ? value <= price : value >= price;
    if (timeInForce === 'FOK') {
      const available = prices.filter(crosses).reduce((total, value) => total + this.levels[opposite].get(value).filter(order => order.owner !== owner).reduce((sum, order) => sum + order.remaining, 0), 0);
      if (available < quantity) return {id, status: 'cancelled', remaining: quantity, fills: [], paper_only: true};
    }
    const taker = {id, owner, side, price, remaining: quantity, sequence: ++this.sequence}, fills = [];
    for (const value of prices) {
      if (!crosses(value) || !taker.remaining) break;
      const queue = this.levels[opposite].get(value);
      for (let i = 0; i < queue.length && taker.remaining;) {
        const maker = queue[i];
        if (maker.owner === owner) { this.orders.delete(maker.id); queue.splice(i, 1); continue; }
        const size = Math.min(maker.remaining, taker.remaining); maker.remaining -= size; taker.remaining -= size;
        fills.push({maker_id: maker.id, taker_id: id, price: value, quantity: size, paper_only: true});
        if (!maker.remaining) { this.orders.delete(maker.id); queue.splice(i, 1); } else i++;
      }
      if (!queue.length) this.levels[opposite].delete(value);
    }
    if (taker.remaining && timeInForce === 'GTC') {
      if (!this.levels[side].has(price)) this.levels[side].set(price, []);
      this.levels[side].get(price).push(taker); this.orders.set(id, taker);
    }
    return {id, status: !taker.remaining ? 'filled' : timeInForce === 'GTC' ? 'resting' : 'cancelled', remaining: taker.remaining, fills, paper_only: true};
  }
  cancel(id, owner) {
    const order = this.orders.get(id); if (!order || order.owner !== owner) return false;
    const queue = this.levels[order.side].get(order.price); queue.splice(queue.indexOf(order), 1);
    if (!queue.length) this.levels[order.side].delete(order.price); this.orders.delete(id); return true;
  }
  snapshot() {
    const levels = side => [...this.levels[side]].sort(([a], [b]) => side === 'buy' ? b - a : a - b).map(([price, queue]) => ({price, quantity: queue.reduce((total, order) => total + order.remaining, 0), orders: queue.length}));
    return {paper_only: true, sequence: this.sequence, bids: levels('buy'), asks: levels('sell'), active_orders: this.orders.size};
  }
}
