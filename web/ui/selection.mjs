export const initialSelection = Object.freeze({ticker: null, generation: 0, market: null, book: null, research: null, fees: null, loading: false, error: null});

export function contractTitle(market) {
  if (!market) return 'Choose a contract';
  const title = market.title || market.ticker;
  const outcome = market.yes_sub_title || market.subtitle;
  return outcome && !title.toLocaleLowerCase().includes(outcome.toLocaleLowerCase()) ? `${title} · ${outcome}` : title;
}
export function refreshMarketRows(current,incoming){
  const latest=new Map(incoming.map(row=>[row.ticker,row])),result=[];
  for(const row of current){if(latest.has(row.ticker)){result.push(latest.get(row.ticker));latest.delete(row.ticker);}}
  return [...result,...latest.values()];
}

export function selectionReducer(state, action) {
  if (action.type === 'clear') return {...initialSelection,generation:state.generation+1};
  if (action.type === 'select') return {...initialSelection, ticker: action.market.ticker, market: action.market,
    generation: state.generation + 1, loading: true};
  if (action.generation !== state.generation || action.ticker !== state.ticker) return state;
  if (action.type === 'error') return {...state, loading: false, error: action.error};
  if (action.type === 'context') {
    if (action.value.market?.ticker !== state.ticker) return {...state, loading: false, error: 'The response did not match this contract'};
    return {...state, market: action.value.market, fees: action.value.fees || null, loading: false, error: null};
  }
  if (action.type === 'book') {
    if (action.value.ticker !== state.ticker) return state;
    const current = Date.parse(state.book?.as_of), next = Date.parse(action.value.as_of);
    if (!Number.isFinite(next) || Number.isFinite(current) && next < current) return state;
    return {...state, book: action.value};
  }
  if (action.type === 'research') {
    if(action.value.ticker!==state.ticker)return state;
    const market=action.value.market?.ticker===state.ticker?{...state.market,...action.value.market,category:action.value.market.category||state.market?.category}:state.market;
    return {...state,research:action.value,market};
  }
  return state;
}
