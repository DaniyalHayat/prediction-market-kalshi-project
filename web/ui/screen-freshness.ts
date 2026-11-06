type ScreenTiming = {
  ticker?: string;
  inplay?: boolean;
  max_source_age_seconds?: number | null;
  as_of?: string | null;
  quote_as_of?: string | null;
  close_time?: string | null;
  event_start?: string | null;
  source_as_of?: string | null;
  probability?: number | null;
  probability_yes?: number | null;
  settlement_value?: number | null;
  refresh_error?: boolean;
};
type ScreenRows = ScreenTiming & {
  candidates?: ScreenTiming[] | null;
  paper_scenarios?: ScreenTiming[] | null;
  watchlist?: ScreenTiming[] | null;
};
type FreshnessOptions = {now?: number; checkedAt?: string | null; error?: unknown};
type Freshness =
  | {current: true; expires_at: number; reason: null}
  | {current: false; expires_at?: number; reason: string};
type Forecast = ScreenTiming & {interval?: readonly number[] | null};
type Opinion = {side?: string; reason?: string; supported_allocation?: number | null};
type ResearchScreen = {
  opinion?: Opinion | null;
  forecast?: Forecast | null;
  as_of?: string | null;
  quote_as_of?: string | null;
  sources?: {kind?: string; retrieved_at?: string | null}[] | null;
  market?: {close_time?: string | null} | null;
  error?: unknown;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function screenRefreshDelay(value?: ScreenRows | null): number {
  const rows = [...(value?.candidates || []), ...(value?.paper_scenarios || []), ...(value?.watchlist || [])];
  if (!rows.length && value?.ticker) rows.push(value);
  return rows.some(row => row.inplay || finite(row.max_source_age_seconds) && row.max_source_age_seconds <= 60)
    ? 20_000 : 60_000;
}

export function screenFreshness(row?: ScreenTiming | null, {now = Date.now(), checkedAt, error}: FreshnessOptions = {}): Freshness {
  if (error || row?.refresh_error) return {current: false, reason: 'Refresh failed. The previous screen is withheld until its evidence can be checked again.'};
  const quote = Date.parse(row?.quote_as_of || row?.as_of || checkedAt || '');
  if (!finite(quote) || quote > now + 5_000) return {current: false, reason: 'A usable matching quote observation time is unavailable.'};
  let expires = quote + 90_000;
  const close = Date.parse(row?.close_time || '');
  if (finite(close)) expires = Math.min(expires, close);
  const eventStart = Date.parse(row?.event_start || '');
  if (finite(eventStart)) expires = Math.min(expires, eventStart);
  if (row && (finite(row.probability) || finite(row.probability_yes) || finite(row.settlement_value))) {
    const source = Date.parse(row.source_as_of || '');
    const maximum = finite(row.max_source_age_seconds) ? Math.min(86_400, Math.max(10, row.max_source_age_seconds)) : row.inplay ? 30 : 86_400;
    if (!finite(source) || source > now + 5_000) return {current: false, reason: 'The independent forecast source time could not be verified.'};
    expires = Math.min(expires, source + maximum * 1_000);
  }
  return now >= expires
    ? {current: false, expires_at: expires, reason: 'The matching quote, forecast source or contract window has expired. Refresh before using this screen.'}
    : {current: true, expires_at: expires, reason: null};
}

export function displayedOpinion<T extends ScreenTiming>(row: T, now = Date.now()) {
  const freshness = screenFreshness(row, {now});
  return freshness.current ? row : {
    ...row, side: 'STALE', stale: true, probability: null, interval: null, supported_allocation: 0, reason: freshness.reason
  };
}

export function researchScreenOpinion(value?: ResearchScreen | null, now = Date.now()) {
  if (!value?.opinion) return null;
  return displayedOpinion({
    ...value.opinion, probability: value.forecast?.probability, interval: value.forecast?.interval,
    source_as_of: value.forecast?.source_as_of, max_source_age_seconds: value.forecast?.max_source_age_seconds,
    as_of: value.as_of, quote_as_of: value.quote_as_of || value.sources?.find(row => row.kind === 'order_book')?.retrieved_at,
    inplay: Boolean(value.forecast?.inplay), close_time: value.market?.close_time, refresh_error: Boolean(value.error)
  }, now);
}

type RefreshTask = (signal: AbortSignal, force: boolean) => PromiseLike<void> | void;
type RefreshOptions = {visible: () => boolean; onError?: (error: unknown) => void};

export function createVisibleRefresh(run: RefreshTask, {visible, onError = () => {}}: RefreshOptions) {
  let stopped = false, active: AbortController | null = null, resumePending = false;
  async function refresh(force = false) {
    if (stopped || !visible()) return;
    if (active) {
      if (force) resumePending = true;
      return;
    }
    const controller = new AbortController();
    active = controller;
    try { await run(controller.signal, force); }
    catch (error) { if (!controller.signal.aborted && !stopped) onError(error); }
    finally {
      if (active === controller) active = null;
      if (resumePending && !stopped && visible()) {
        resumePending = false;
        queueMicrotask(() => { void refresh(true); });
      }
    }
  }
  return {
    refresh,
    visibilityChanged() {
      if (!visible()) {
        resumePending = false;
        active?.abort();
      } else {
        void refresh(true);
      }
    },
    stop() {
      stopped = true;
      resumePending = false;
      active?.abort();
    },
  };
}
