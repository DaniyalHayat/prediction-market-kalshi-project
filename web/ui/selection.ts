import type {ModelPreference} from './preferences';

type ContractLabel = {
  ticker?: string;
  title?: string;
  yes_sub_title?: string;
  subtitle?: string;
};
type Ticker = {ticker: string};
type Market = Ticker & ContractLabel & {
  category?: string;
  close_time?: string;
  status?: string;
  result?: string;
  event_ticker?: string;
  observed_at?: string;
  as_of?: string;
};
type QuoteLevel = readonly [price: string, quantity: string];
type Book = Ticker & {
  as_of?: string;
  transport?: string;
  metrics?: {book_ask?: number | null; book_bid?: number | null};
  raw?: {orderbook_fp?: {yes_dollars?: QuoteLevel[] | null; no_dollars?: QuoteLevel[] | null}};
};
type Research = Ticker & {
  market?: Market | null;
  view_model?: ModelPreference;
  error?: string;
};
type Fees = {series?: string; coefficient?: number | null; source_url?: string; as_of?: string};
type Scoped = Ticker & {generation: number};

export type Selection = Readonly<{
  ticker: string | null;
  generation: number;
  market: Market | null;
  book: Book | null;
  research: Research | null;
  fees: Fees | null;
  loading: boolean;
  error: string | null;
}>;
export type SelectionAction =
  | {type: 'clear'}
  | {type: 'select'; market: Market}
  | (Scoped & {type: 'error'; error: string})
  | (Scoped & {type: 'context'; value: {market?: Market | null; fees?: Fees | null}})
  | (Scoped & {type: 'book'; value: Book})
  | (Scoped & {type: 'research'; value: Research});

export const initialSelection: Selection = Object.freeze({
  ticker: null, generation: 0, market: null, book: null, research: null, fees: null, loading: false, error: null
});

export function contractTitle(market?: ContractLabel | null): string {
  if (!market) return 'Choose a contract';
  const title = market.title || market.ticker || 'Choose a contract';
  const outcome = market.yes_sub_title || market.subtitle;
  return outcome && !title.toLocaleLowerCase().includes(outcome.toLocaleLowerCase()) ? `${title} · ${outcome}` : title;
}

export function refreshMarketRows<T extends Ticker>(current: readonly T[], incoming: readonly T[]): T[] {
  const latest = new Map(incoming.map(row => [row.ticker, row]));
  const result: T[] = [];
  for (const row of current) {
    const update = latest.get(row.ticker);
    if (update) {
      result.push(update);
      latest.delete(row.ticker);
    }
  }
  return [...result, ...latest.values()];
}

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  if (action.type === 'clear') return {...initialSelection, generation: state.generation + 1};
  if (action.type === 'select') return {...initialSelection, ticker: action.market.ticker, market: action.market,
    generation: state.generation + 1, loading: true};
  if (action.generation !== state.generation || action.ticker !== state.ticker) return state;
  if (action.type === 'error') return {...state, loading: false, error: action.error};
  if (action.type === 'context') {
    const {market, fees} = action.value;
    if (!market || market.ticker !== state.ticker) return {...state, loading: false, error: 'The response did not match this contract'};
    return {...state, market, fees: fees || null, loading: false, error: null};
  }
  if (action.type === 'book') {
    if (action.value.ticker !== state.ticker) return state;
    const current = Date.parse(state.book?.as_of ?? ''), next = Date.parse(action.value.as_of ?? '');
    if (!Number.isFinite(next) || Number.isFinite(current) && next < current) return state;
    return {...state, book: action.value};
  }
  if (action.type === 'research') {
    if (action.value.ticker !== state.ticker) return state;
    const candidate = action.value.market;
    const market = candidate && candidate.ticker === state.ticker
      ? {...state.market, ...candidate, category: candidate.category || state.market?.category}
      : state.market;
    return {...state, research: action.value, market};
  }
  return state;
}
