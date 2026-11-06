import type {ModelPreference} from './preferences';

type ForecastTiming = {max_source_age_seconds?: number | null};
type Source = {url?: string | null; [key: string]: unknown};
type Sports = {availability?: unknown[] | null; availability_note?: string | null; [key: string]: unknown};
type Extensions = {sports?: Sports | null; [key: string]: unknown};
type News = {status?: string; [key: string]: unknown};
type ResearchRefresh = {
  ticker: string;
  view_model?: ModelPreference;
  forecast?: ForecastTiming | null;
  extensions?: Extensions | null;
  sources?: (Source | null)[] | null;
  news?: News | null;
};
type RetainedFields = 'news' | 'extensions' | 'sources';
type MergedRefresh<T extends ResearchRefresh> = Omit<T, RetainedFields> & Pick<ResearchRefresh, RetainedFields>;

export function researchRefreshDelay(value?: Pick<ResearchRefresh, 'forecast'> | null): number {
  const maximumAge = value?.forecast?.max_source_age_seconds;
  return maximumAge !== undefined && Number(maximumAge) <= 60 ? 20_000 : 60_000;
}

export function mergeResearchRefresh<T extends ResearchRefresh>(previous: ResearchRefresh | null | undefined, next: T): MergedRefresh<T> {
  if (!previous || previous.ticker !== next.ticker || previous.view_model !== next.view_model) return next;
  const extensions: Extensions = {...previous.extensions, ...next.extensions};
  if (next.extensions?.sports) {
    extensions.sports = {
      ...next.extensions.sports,
      availability: previous.extensions?.sports?.availability || [],
      availability_note: previous.extensions?.sports?.availability_note,
    };
  }
  const sources = new Map<string, Source>();
  for (const row of [...(previous.sources || []), ...(next.sources || [])]) {
    if (row?.url) sources.set(row.url, row);
  }
  return {...next, news: next.news?.status === 'not_queried' ? previous.news : next.news, extensions, sources: [...sources.values()]};
}
