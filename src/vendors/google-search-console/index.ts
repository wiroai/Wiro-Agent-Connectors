// Google Search Console, through the Search Console API (Search Analytics,
// sites and sitemaps under /webmasters/v3, URL Inspection under /v1). It only
// reads: the connection's scope is webmasters.readonly.
//
// Credential: `access_token`, a Google OAuth access token with the scope
// https://www.googleapis.com/auth/webmasters.readonly, from an OAuth client in
// the user's own Google Cloud project. The host signs in, refreshes the token
// and passes the current one on every call.
//
// Account picker `sites` (the Search Console properties the agent may read):
// a Domain property is "sc-domain:example.com", a URL-prefix property its
// address with the trailing slash, "https://www.example.com/".

import { allowedAccounts, apiTools, defineConnector, requireAccounts, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';

const LABEL = 'Google Search Console';
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'hour', 'searchAppearance', 'brandedClassification'] as const;
const TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews', 'webMultimodal'] as const;
const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] as const;
const UNVERIFIED = new Set(['siteUnverifiedUser', 'SITE_UNVERIFIED_USER']);

const SITE_URL = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 2048,
  pattern: '^(sc-domain:[^\\s/]+|https?://\\S+)$',
  description: 'The property id exactly as list_sites gives it: "sc-domain:example.com" for a Domain property, or the address with its trailing slash, "https://www.example.com/".',
};
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const TYPE = { type: 'string' as const, enum: [...TYPES], default: 'web', description: 'The search type: web (default), image, video, news, discover, googleNews or webMultimodal.' };
const FILTERS = {
  type: 'array' as const,
  maxItems: 20,
  items: {
    type: 'object' as const,
    properties: {
      dimension: { type: 'string' as const, enum: ['query', 'page', 'country', 'device', 'searchAppearance', 'brandedClassification'] },
      operator: { type: 'string' as const, enum: [...OPERATORS], default: 'equals' },
      expression: { type: 'string' as const, minLength: 1, maxLength: 4096 },
    },
    required: ['dimension', 'expression'],
    additionalProperties: false,
  },
  description:
    'Filters that must all match, e.g. [{"dimension": "country", "expression": "usa"}, {"dimension": "page", "operator": "contains", "expression": "/blog/"}]. '
    + 'Operators: equals (default, case-sensitive for page and query), notEquals, contains, notContains, includingRegex, excludingRegex (RE2). '
    + 'country takes a three-letter ISO 3166-1 code (usa, deu); device DESKTOP, MOBILE or TABLET; brandedClassification BRANDED or NON_BRANDED (equals only).',
};
const DATES = {
  start_date: { type: 'string' as const, pattern: DATE, description: 'The first day, YYYY-MM-DD in Pacific Time. Give it with end_date, or use last_days.' },
  end_date: { type: 'string' as const, pattern: DATE, description: 'The last day, YYYY-MM-DD in Pacific Time, included.' },
  last_days: {
    type: 'integer' as const,
    minimum: 1,
    maximum: 480,
    description: 'Instead of dates: the last N days that have data (default 28). Search Console data arrives 2 to 3 days late, so the range ends on the latest day with data, which the result names.',
  },
};

interface Filter {
  dimension: string;
  operator: string;
  expression: string;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function round(value: unknown, digits: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  return isoDate(dayMs(date) + days * DAY_MS);
}

/** The same day a year earlier (29 February becomes 28 February). */
function yearEarlier(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year - 1, month - 1, day));
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0);
  return isoDate(target.getTime());
}

/** Today in Pacific Time, or a few hours behind it: never a day ahead. */
function pacificToday(): string {
  return isoDate(Date.now() - 8 * 60 * 60 * 1000);
}

function siteFor(h: ToolHelpers, site: string): { site: string; path: string } {
  requireAccounts(h.ctx.accounts, 'sites', site, 'site');
  return { site, path: `/webmasters/v3/sites/${encodeURIComponent(site)}` };
}

const QUERY_ERRORS = {
  400: 'Google Search Console did not accept the query: check the dates (YYYY-MM-DD), the filters and that aggregation_type byProperty is not used with a page grouping',
  403: 'Google Search Console refused the request: the connected Google account cannot open this property, it is not verified for it, or the Search Console API is not enabled in its Google Cloud project',
  404: 'Google Search Console found no such property for the connected Google account',
};

interface QueryBody {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  type: string;
  filters?: Filter[];
  aggregationType?: string;
  rowLimit: number;
  startRow?: number;
  dataState?: string;
}

async function query(h: ToolHelpers, path: string, body: QueryBody): Promise<any> {
  const { data } = await h.api({
    method: 'POST',
    path: `${path}/searchAnalytics/query`,
    json: compact({
      startDate: body.startDate,
      endDate: body.endDate,
      dimensions: body.dimensions?.length ? body.dimensions : undefined,
      type: body.type,
      dimensionFilterGroups: body.filters?.length
        ? [{ groupType: 'and', filters: body.filters.map((filter) => ({ dimension: filter.dimension, operator: filter.operator ?? 'equals', expression: filter.expression })) }]
        : undefined,
      aggregationType: body.aggregationType,
      rowLimit: body.rowLimit,
      startRow: body.startRow || undefined,
      dataState: body.dataState,
    }),
    safe: true,
    errors: QUERY_ERRORS,
  });
  return data;
}

/** The latest day with data, following Google's advice: the last 10 days grouped by date. */
async function latestDay(h: ToolHelpers, path: string, type: string, dataState: string | undefined): Promise<string> {
  const today = pacificToday();
  const data = await query(h, path, {
    startDate: addDays(today, -10),
    endDate: today,
    dimensions: ['date'],
    type,
    rowLimit: 20,
    dataState: dataState === 'hourly_all' ? 'all' : dataState,
  });
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const last = rows[rows.length - 1]?.keys?.[0];
  if (typeof last !== 'string' || !new RegExp(DATE).test(last)) {
    throw new ToolFailure(`${LABEL} has no ${type} data for this property in the last 10 days, so there is no latest day to count from. Give start_date and end_date instead.`);
  }
  return last;
}

/** The range a call covers: its dates, or the last N days with data. */
async function rangeFor(
  h: ToolHelpers,
  path: string,
  args: { start_date?: string; end_date?: string; last_days?: number; type: string; data_state?: string },
): Promise<{ start: string; end: string }> {
  if (args.start_date || args.end_date) {
    if (!args.start_date || !args.end_date) throw new ToolFailure('Give both start_date and end_date, or last_days. Nothing was sent.');
    if (args.last_days !== undefined) throw new ToolFailure('Give start_date and end_date, or last_days, not both. Nothing was sent.');
    if (dayMs(args.start_date) > dayMs(args.end_date)) throw new ToolFailure('start_date is after end_date. Nothing was sent.');
    return { start: args.start_date, end: args.end_date };
  }
  const end = await latestDay(h, path, args.type, args.data_state);
  return { start: addDays(end, -((args.last_days ?? 28) - 1)), end };
}

function trimRow(row: any, dimensions: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  dimensions.forEach((name, index) => {
    out[name] = row?.keys?.[index] ?? null;
  });
  return {
    ...out,
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: round(row?.ctr, 4) ?? 0,
    position: round(row?.position, 2) ?? null,
  };
}

function incomplete(data: any): Record<string, unknown> {
  const metadata = data?.metadata ?? {};
  return compact({
    first_incomplete_date: metadata.firstIncompleteDate ?? metadata.first_incomplete_date,
    first_incomplete_hour: metadata.firstIncompleteHour ?? metadata.first_incomplete_hour,
  });
}

interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

function totalsOf(data: any): Totals {
  const row = Array.isArray(data?.rows) ? data.rows[0] : undefined;
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: round(row?.ctr, 4) ?? 0,
    position: round(row?.position, 2) ?? null,
  };
}

function percent(now: number, before: number): number | null {
  return before ? round(((now - before) / before) * 100, 1) ?? null : null;
}

interface QueryArgs {
  site_url: string;
  start_date?: string;
  end_date?: string;
  last_days?: number;
  dimensions?: string[];
  type: string;
  filters?: Filter[];
  aggregation_type?: string;
  row_limit: number;
  start_row?: number;
  data_state: string;
  cursor?: string;
}

interface CompareArgs {
  site_url: string;
  dimension?: string;
  start_date?: string;
  end_date?: string;
  last_days?: number;
  compare_to: 'previous_period' | 'previous_year';
  type: string;
  filters?: Filter[];
  metric: 'clicks' | 'impressions';
  limit: number;
  row_limit: number;
}

function trimSitemap(sitemap: any): Record<string, unknown> {
  return compact({
    path: sitemap?.path,
    type: sitemap?.type,
    is_sitemaps_index: sitemap?.isSitemapsIndex === true ? true : undefined,
    is_pending: sitemap?.isPending === true ? true : undefined,
    last_submitted: sitemap?.lastSubmitted,
    last_downloaded: sitemap?.lastDownloaded,
    errors: Number(sitemap?.errors ?? 0),
    warnings: Number(sitemap?.warnings ?? 0),
    // contents[].indexed is deprecated by Google and left out.
    contents: Array.isArray(sitemap?.contents)
      ? sitemap.contents.map((item: any) => compact({ type: item?.type, submitted: item?.submitted !== undefined ? Number(item.submitted) : undefined }))
      : undefined,
    not_downloaded_since_submitted:
      sitemap?.lastSubmitted && (!sitemap?.lastDownloaded || Date.parse(sitemap.lastDownloaded) < Date.parse(sitemap.lastSubmitted)) ? true : undefined,
  });
}

function trimInspection(result: any): Record<string, unknown> {
  const index = result?.indexStatusResult ?? {};
  const rich = result?.richResultsResult;
  return compact({
    verdict: index.verdict,
    coverage_state: index.coverageState,
    indexing_state: index.indexingState,
    robots_txt_state: index.robotsTxtState,
    page_fetch_state: index.pageFetchState,
    last_crawl_time: index.lastCrawlTime,
    crawled_as: index.crawledAs,
    google_canonical: index.googleCanonical,
    user_canonical: index.userCanonical,
    sitemaps: Array.isArray(index.sitemap) && index.sitemap.length ? index.sitemap.slice(0, 20) : undefined,
    referring_urls: Array.isArray(index.referringUrls) && index.referringUrls.length ? index.referringUrls.slice(0, 20) : undefined,
    rich_results: rich
      ? compact({
        verdict: rich.verdict,
        detected: Array.isArray(rich.detectedItems)
          ? rich.detectedItems.map((item: any) => compact({
            type: item?.richResultType,
            items: Array.isArray(item?.items) ? item.items.length : undefined,
            issues: Array.isArray(item?.items)
              ? item.items.flatMap((entry: any) => (Array.isArray(entry?.issues) ? entry.issues : []))
                .slice(0, 10)
                .map((issue: any) => compact({ message: typeof issue?.issueMessage === 'string' ? truncate(issue.issueMessage, 300) : undefined, severity: issue?.severity }))
              : undefined,
          }))
          : undefined,
      })
      : undefined,
    amp: result?.ampResult ? compact({ verdict: result.ampResult.verdict, url: result.ampResult.ampUrl }) : undefined,
    report_link: result?.inspectionResultLink,
  });
}

const connector = defineConnector({
  vendor: 'google-search-console',
  label: LABEL,
  origins: ['https://searchconsole.googleapis.com'],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Google Search Console access token' },
  accountPickers: [
    {
      key: 'sites',
      label: 'Search Console properties',
      description: 'The Search Console properties the agent may report on.',
      multiple: true,
      tool: 'list_sites',
      idField: 'id',
      nameField: 'name',
      legacyField: 'siteurl',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_sites',
      kind: 'read',
      title: 'List Search Console properties',
      description:
        'Lists the Search Console properties the connected Google account has verified access to: the property id (sc-domain:example.com '
        + 'or https://www.example.com/), a display name, whether it is a Domain or URL-prefix property, and the permission level. '
        + 'Unverified properties have no data and are left out. When the connection is limited to chosen properties, those are marked '
        + 'selected: true, and only they can be used.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const chosen = allowedAccounts(h.ctx.accounts, 'sites');
        const { data } = await h.api({ path: '/webmasters/v3/sites' });
        const entries: any[] = Array.isArray(data?.siteEntry) ? data.siteEntry : [];
        const sites = entries
          .filter((entry) => typeof entry?.siteUrl === 'string' && !UNVERIFIED.has(entry?.permissionLevel))
          .map((entry) => {
            const domain = entry.siteUrl.startsWith('sc-domain:');
            return compact({
              id: entry.siteUrl,
              name: domain ? entry.siteUrl.slice('sc-domain:'.length) : entry.siteUrl,
              property_type: domain ? 'domain' : 'url_prefix',
              permission_level: entry.permissionLevel,
              selected: chosen?.includes(entry.siteUrl) ? true : undefined,
            });
          });
        const skipped = entries.length - sites.length;
        return h.page({
          key: 'sites',
          items: sites.slice(skip),
          extra: compact({
            unverified_left_out: skipped || undefined,
            note: chosen?.length === 0 ? 'No property is chosen for this connection yet, so every tool that names a property is refused until properties from this list are chosen for it.' : undefined,
          }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'query_search_analytics',
      kind: 'read',
      title: 'Query Search Console performance',
      description:
        'Google Search clicks, impressions, CTR (0 to 1) and average position (lower is better) for one property, grouped by query, page, '
        + 'country, device, date, hour, search appearance or branded classification, with filters, for given dates or the last N days with '
        + 'data. Rows come sorted by clicks (by date when grouped by date). The API returns top rows, not every row: for totals, group by '
        + 'nothing or by date. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          site_url: SITE_URL,
          ...DATES,
          dimensions: {
            type: 'array',
            uniqueItems: true,
            maxItems: 6,
            items: { type: 'string', enum: [...DIMENSIONS] },
            description: 'How rows are grouped, in order, e.g. ["query"] or ["page", "device"]. None gives one total row. hour needs data_state hourly_all.',
          },
          type: TYPE,
          filters: FILTERS,
          aggregation_type: {
            type: 'string',
            enum: ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'],
            description: 'auto (default), byPage or byProperty; keep auto when grouping or filtering by page.',
          },
          row_limit: { type: 'integer', minimum: 1, maximum: 25000, default: 100, description: 'Rows per page, 1 to 25000 (default 100).' },
          start_row: { type: 'integer', minimum: 0, description: 'The first row, counting from 0.' },
          data_state: {
            type: 'string',
            enum: ['final', 'all', 'hourly_all'],
            default: 'final',
            description: 'final (default): finished days only; all: adds fresh, partial days; hourly_all: hourly data for an hour grouping.',
          },
          cursor: CURSOR,
        },
        required: ['site_url'],
        additionalProperties: false,
      },
      async run(args: QueryArgs, h) {
        const { site, path } = siteFor(h, args.site_url);
        const state = h.cursor(args.cursor);
        const startRow = typeof state?.['r'] === 'number' ? state['r'] : (args.start_row ?? 0);
        // A continuation keeps the range of the first page, even if a new day of data arrived since.
        const range = typeof state?.['s'] === 'string' && typeof state?.['e'] === 'string'
          ? { start: state['s'], end: state['e'] }
          : await rangeFor(h, path, args);
        const dimensions = args.dimensions ?? [];
        const data = await query(h, path, {
          startDate: range.start,
          endDate: range.end,
          dimensions,
          type: args.type,
          filters: args.filters,
          ...(args.aggregation_type ? { aggregationType: args.aggregation_type } : {}),
          rowLimit: args.row_limit,
          startRow,
          dataState: args.data_state,
        });
        const rows = (Array.isArray(data?.rows) ? data.rows : []).map((row: any) => trimRow(row, dimensions));
        const cursorAt = (row: number) => h.makeCursor({ r: row, s: range.start, e: range.end });
        return h.page({
          key: 'rows',
          items: rows,
          extra: compact({
            site_url: site,
            start_date: range.start,
            end_date: range.end,
            type: args.type,
            data_state: args.data_state,
            dimensions: dimensions.length ? dimensions : undefined,
            aggregation: data?.responseAggregationType,
            ...incomplete(data),
            note: rows.length ? undefined : 'No rows: Search Console has no data for this range and filter (the last 2 to 3 days are usually missing).',
          }),
          resumeAt: (index) => cursorAt(startRow + index),
          ...(rows.length >= args.row_limit ? { nextPage: cursorAt(startRow + rows.length) } : {}),
        });
      },
    },
    {
      name: 'compare_periods',
      kind: 'read',
      title: 'Compare Search Console periods',
      description:
        'Compares two periods of the same length for one property: totals (clicks, impressions, CTR, position) with the change, and with a '
        + 'dimension the keys (queries, pages, countries, devices) that lost and gained the most clicks or impressions. The current period is '
        + 'given dates or the last N days with data; the other is the period just before or the same dates a year earlier. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          site_url: SITE_URL,
          dimension: { type: 'string', enum: ['query', 'page', 'country', 'device', 'searchAppearance'], description: 'Rank the movers by this key. Leave out for totals only.' },
          ...DATES,
          compare_to: {
            type: 'string',
            enum: ['previous_period', 'previous_year'],
            default: 'previous_period',
            description: 'previous_period (default): the same number of days just before; previous_year: the same dates a year earlier.',
          },
          type: TYPE,
          filters: FILTERS,
          metric: { type: 'string', enum: ['clicks', 'impressions'], default: 'clicks', description: 'What the movers are ranked by (default clicks).' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Losers and gainers to list each, 1 to 100 (default 10).' },
          row_limit: { type: 'integer', minimum: 10, maximum: 25000, default: 1000, description: 'Top rows read per period for the movers, 10 to 25000 (default 1000).' },
        },
        required: ['site_url'],
        additionalProperties: false,
      },
      async run(args: CompareArgs, h) {
        const { site, path } = siteFor(h, args.site_url);
        const current = await rangeFor(h, path, args);
        const length = Math.round((dayMs(current.end) - dayMs(current.start)) / DAY_MS) + 1;
        const previous = args.compare_to === 'previous_year'
          ? { start: yearEarlier(current.start), end: yearEarlier(current.end) }
          : { start: addDays(current.start, -length), end: addDays(current.start, -1) };
        const base = { type: args.type, filters: args.filters, dataState: 'final' };
        const totalsNow = totalsOf(await query(h, path, { ...base, startDate: current.start, endDate: current.end, rowLimit: 1 }));
        const totalsBefore = totalsOf(await query(h, path, { ...base, startDate: previous.start, endDate: previous.end, rowLimit: 1 }));
        const result: Record<string, unknown> = {
          site_url: site,
          type: args.type,
          current: { start_date: current.start, end_date: current.end },
          previous: { start_date: previous.start, end_date: previous.end },
          totals: {
            current: totalsNow,
            previous: totalsBefore,
            change: compact({
              clicks: totalsNow.clicks - totalsBefore.clicks,
              clicks_pct: percent(totalsNow.clicks, totalsBefore.clicks),
              impressions: totalsNow.impressions - totalsBefore.impressions,
              impressions_pct: percent(totalsNow.impressions, totalsBefore.impressions),
              ctr: round(totalsNow.ctr - totalsBefore.ctr, 4),
              position: totalsNow.position !== null && totalsBefore.position !== null ? round(totalsNow.position - totalsBefore.position, 2) : undefined,
            }),
          },
        };
        if (!args.dimension) return result;

        const rowsNow = await query(h, path, { ...base, startDate: current.start, endDate: current.end, dimensions: [args.dimension], rowLimit: args.row_limit });
        const rowsBefore = await query(h, path, { ...base, startDate: previous.start, endDate: previous.end, dimensions: [args.dimension], rowLimit: args.row_limit });
        const index = (data: any) => new Map<string, any>((Array.isArray(data?.rows) ? data.rows : []).map((row: any) => [String(row?.keys?.[0]), row]));
        const now = index(rowsNow);
        const before = index(rowsBefore);
        const metric = args.metric;
        const movers = [...new Set([...now.keys(), ...before.keys()])].map((key) => {
          const a = now.get(key);
          const b = before.get(key);
          return compact({
            [args.dimension as string]: key,
            [`${metric}_now`]: a?.[metric] ?? 0,
            [`${metric}_before`]: b?.[metric] ?? 0,
            change: (a?.[metric] ?? 0) - (b?.[metric] ?? 0),
            [metric === 'clicks' ? 'impressions_now' : 'clicks_now']: a?.[metric === 'clicks' ? 'impressions' : 'clicks'] ?? 0,
            [metric === 'clicks' ? 'impressions_before' : 'clicks_before']: b?.[metric === 'clicks' ? 'impressions' : 'clicks'] ?? 0,
            position_now: round(a?.position, 2),
            position_before: round(b?.position, 2),
          });
        });
        const byChange = (sign: number) => movers
          .filter((row) => Math.sign(row['change'] as number) === sign)
          .sort((x, y) => sign * ((y['change'] as number) - (x['change'] as number)))
          .slice(0, args.limit);
        return {
          ...result,
          dimension: args.dimension,
          metric,
          rows_compared: { current: now.size, previous: before.size },
          losers: byChange(-1),
          gainers: byChange(1),
          note: 'A key missing from one period may only have fallen below the top rows read (row_limit), not to zero.',
        };
      },
    },
    {
      name: 'list_sitemaps',
      kind: 'read',
      title: 'List Search Console sitemaps',
      description:
        'Lists the sitemaps submitted for one property, or the sitemaps inside a sitemap index: path, type, last submitted and downloaded, '
        + 'pending, error and warning counts, URLs submitted per content type, and a flag when Google has not downloaded it since it was '
        + 'last submitted.',
      inputSchema: {
        type: 'object',
        properties: {
          site_url: SITE_URL,
          sitemap_index: { type: 'string', format: 'uri', maxLength: 2048, description: 'The URL of a sitemap index, to list the sitemaps inside it.' },
          cursor: CURSOR,
        },
        required: ['site_url'],
        additionalProperties: false,
      },
      async run(args: { site_url: string; sitemap_index?: string; cursor?: string }, h) {
        const { site, path } = siteFor(h, args.site_url);
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: `${path}/sitemaps`, query: { sitemapIndex: args.sitemap_index }, errors: { 403: QUERY_ERRORS[403], 404: QUERY_ERRORS[404] } });
        const sitemaps = (Array.isArray(data?.sitemap) ? data.sitemap : []).map(trimSitemap);
        return h.page({
          key: 'sitemaps',
          items: sitemaps.slice(skip),
          extra: { site_url: site, total: sitemaps.length },
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'inspect_url',
      kind: 'read',
      title: 'Inspect a URL in Search Console',
      description:
        'Shows how Google indexed one URL of a property (the indexed version, not a live test): verdict, coverage, indexing, robots.txt '
        + 'and fetch state, last crawl, Google\'s and the page\'s canonical, sitemaps and referring URLs, rich results, and a link to the '
        + 'same report in Search Console. Google allows 2,000 inspections per property per day and 600 per minute. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          site_url: SITE_URL,
          url: { type: 'string', format: 'uri', maxLength: 2048, description: 'The full URL of a page under the property.' },
          language_code: { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$', default: 'en-US', description: 'The language of the messages (default en-US).' },
        },
        required: ['site_url', 'url'],
        additionalProperties: false,
      },
      async run(args: { site_url: string; url: string; language_code: string }, h) {
        const { site } = siteFor(h, args.site_url);
        const { data } = await h.api({
          method: 'POST',
          path: '/v1/urlInspection/index:inspect',
          json: { inspectionUrl: args.url, siteUrl: site, languageCode: args.language_code },
          safe: true,
          errors: {
            ...QUERY_ERRORS,
            400: 'Google Search Console did not accept the inspection: the URL must be a full address under the property',
            429: 'Google Search Console inspection quota reached',
          },
        });
        return { site_url: site, url: args.url, ...trimInspection(data?.inspectionResult) };
      },
    },
    // The rest of the read-only API: one property, one sitemap.
    ...apiTools({
      label: LABEL,
      description:
        'The Search Console API at https://searchconsole.googleapis.com/webmasters/v3 with the connected account, read-only: '
        + '/webmasters/v3/sites/{site_url} and /webmasters/v3/sites/{site_url}/sitemaps/{sitemap_url}, each id percent-encoded, '
        + 'e.g. /webmasters/v3/sites/sc-domain%3Aexample.com. Reference: https://developers.google.com/webmaster-tools/v1/api_reference_index.',
      basePath: '/webmasters/v3/',
      // The property is the segment after "sites"; a sitemap URL further on never counts as one.
      accounts: { key: 'sites', label: 'site', ids: (request) => request.segments.flatMap((segment, index) => (segment === 'sites' && request.segments[index + 1] ? [request.segments[index + 1] as string] : [])) },
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

export = connector;
