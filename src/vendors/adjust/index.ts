// Adjust, through its Report Service API (https://dev.adjust.com/en/api/rs-api/):
// attribution reports for the apps of an Adjust account, such as
// creative-level ROAS, campaign and network rollups, cohorts and SKAdNetwork.
//
// Credential: `userapitoken`, the Adjust API token from the dashboard ->
// Account settings -> My profile. One token covers every app of the account.
// It goes in the Authorization: Bearer header to https://automate.adjust.com
// only. The Report Service API is read-only, and so is the module.
//
// The apps picker (key "apps", Adjust's 12-character app tokens) limits every
// report to the apps chosen for the connection.

import { allowedAccounts, apiTools, defineConnector, requireAccounts, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';

const ORIGIN = 'https://automate.adjust.com';
const MAX_ROWS = 1000;
const FILTER_KEY = /^[a-z0-9_]{1,80}__(in|not_in|contains|exclude|starts_with|not_starts_with|ends_with|not_ends_with|lt|lte|gt|gte|eq|ne)$/;

const ERRORS = {
  400: 'Adjust did not accept the report: most often a metric that does not go with these dimensions or a malformed date_period. Check the metric with get_filter_values',
  401: 'Adjust rejected the API token: it was reset or mistyped. Copy the current token from Account settings -> My profile',
  403: 'The Adjust account behind the token has no access to this app or data',
  504: 'Adjust took too long to build the report: split the date range or drop a dimension',
};

const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const APP_TOKENS = {
  type: 'array' as const,
  items: { type: 'string' as const, pattern: '^[A-Za-z0-9]{6,32}$' },
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  description: 'Adjust app tokens (12 characters, from list_apps). Default: the apps chosen for the connection, or the whole account when none are.',
};

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/**
 * The app tokens a report is scoped to. Under an account lock they must be
 * chosen ones, and no tokens means all the chosen ones; without a lock, no
 * tokens means the whole account.
 */
function scopedApps(h: ToolHelpers, given: string[] | undefined): string[] | undefined {
  const allowed = allowedAccounts(h.ctx.accounts, 'apps');
  if (given?.length) {
    requireAccounts(h.ctx.accounts, 'apps', given, 'app');
    return given;
  }
  if (allowed === null) return undefined;
  if (!allowed.length) throw new ToolFailure('No app is chosen for this connection yet. Nothing was sent.');
  return allowed;
}

/** Extra report filters: "<dimension or metric>__<operator>" with a value or a list. */
function reportFilters(filters: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (key.startsWith('app_token__')) throw new ToolFailure('Scope apps with app_tokens, not a filter. Nothing was sent to Adjust.');
    if (!FILTER_KEY.test(key)) {
      throw new ToolFailure(`filters.${key} is not a filter: use "<dimension or metric>__<operator>", such as partner_name__in or paid_installs__gte. Nothing was sent to Adjust.`);
    }
    const list = Array.isArray(value) ? value : [value];
    if (!list.length || !list.every((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))) {
      throw new ToolFailure(`filters.${key} must be text, a number, or a list of them. Nothing was sent to Adjust.`);
    }
    out[key] = list.map(String).join(',');
  }
  return out;
}

function trimRow(row: any): Record<string, unknown> {
  if (typeof row !== 'object' || row === null) return {};
  const { attr_dependency: _dependency, ...rest } = row as Record<string, unknown>;
  return rest;
}

function trimOption(item: any, list?: string): Record<string, unknown> {
  return compact({
    list,
    id: item?.id,
    name: item?.name,
    shortName: item?.short_name,
    section: item?.section,
    formatting: item?.formatting,
    description: typeof item?.description === 'string' ? truncate(item.description, 200) : undefined,
  });
}

/** A list cut to `limit` items a page and to the size limit, continued with an offset. */
function offsetPage(h: ToolHelpers, key: string, items: unknown[], skip: number, limit: number, extra: Record<string, unknown>): Record<string, unknown> {
  const end = Math.min(items.length, skip + limit);
  return h.page({
    key,
    items: items.slice(skip, end),
    extra,
    resumeAt: (index) => h.makeCursor({ o: skip + index }),
    ...(end < items.length ? { nextPage: h.makeCursor({ o: end }) } : {}),
  });
}

function skipOf(h: ToolHelpers, cursor: string | undefined): number {
  const state = h.cursor(cursor);
  return typeof state?.['o'] === 'number' ? state['o'] : 0;
}

const connector = defineConnector({
  vendor: 'adjust',
  label: 'Adjust',
  origins: [ORIGIN],
  credentials: ['userapitoken'],
  credentialLabels: { userapitoken: 'Adjust API token' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['userapitoken']}` }),
  accountPickers: [
    {
      key: 'apps',
      label: 'Adjust apps',
      description: 'The apps the agent may report on.',
      multiple: true,
      tool: 'list_apps',
      idField: 'id',
      nameField: 'name',
      legacyField: 'apps',
    },
  ],
  tools: [
    {
      name: 'list_apps',
      kind: 'read',
      title: 'List Adjust apps',
      description: 'Lists the apps of the Adjust account behind the token: the app token (id, 12 characters) and name of each. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const { data } = await h.api({ path: '/reports-service/filters_data', query: { required_filters: 'apps' }, errors: ERRORS });
        const apps: any[] = Array.isArray(data?.apps) ? data.apps : [];
        return offsetPage(h, 'apps', apps.map((app) => compact({ id: app?.id, name: app?.name })), skip, MAX_ROWS, {});
      },
    },
    {
      name: 'get_report',
      kind: 'read',
      title: 'Get an Adjust report',
      description:
        'An Adjust report: rows grouped by the dimensions, with the metrics asked for, plus totals and warnings, as the Report Service API returns them '
        + '(row values come as text). Creative ROAS, for example: dimensions app, partner_name, campaign, campaign_id_network, creative_network, '
        + 'creative_id_network and metrics roas, roas_ad, cost, paid_installs, all_revenue. SKAdNetwork: os_names ["ios"] and skad_* metrics; never add '
        + 'installs and skad_installs. Rows come in pages: pass nextCursor back as cursor with the same other arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          date_period: {
            type: 'string',
            pattern: '^(today|yesterday|this_week|last_week|this_month|last_month|this_month_until_yesterday|\\d{4}-\\d{2}-\\d{2}:\\d{4}-\\d{2}-\\d{2}|-\\d{1,4}d:-?\\d{1,4}d)$',
            description: 'The dates: logical (yesterday, last_week, last_month, this_month_until_yesterday...), absolute (2026-11-01:2026-11-07, inclusive) or relative (-8d:-1d, the last 7 full days; -9d:-2d for SKAdNetwork).',
          },
          dimensions: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z0-9_]{1,80}$' },
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            description: 'Grouping, e.g. ["app", "partner_name", "campaign"], ["day"] or ["country_code"].',
          },
          metrics: {
            type: 'array',
            items: { type: 'string', pattern: '^[A-Za-z0-9_]{1,120}$' },
            minItems: 1,
            maxItems: 50,
            uniqueItems: true,
            description: 'Metrics, e.g. ["roas", "cost", "installs", "paid_installs", "all_revenue"]; get_filter_values lists the catalogue.',
          },
          app_tokens: APP_TOKENS,
          filters: {
            type: 'object',
            description: 'More filters, "<dimension or metric>__<operator>" to a value or list, e.g. {"partner_name__in": ["Organic"], "paid_installs__gte": 50}. Operators: in, not_in, contains, exclude, starts_with, not_starts_with, ends_with, not_ends_with, lt, lte, gt, gte, eq, ne.',
          },
          os_names: { type: 'array', items: { type: 'string', pattern: '^[a-z_]{2,30}$' }, minItems: 1, maxItems: 10, uniqueItems: true, description: 'Operating systems, e.g. ["ios"].' },
          ad_spend_mode: { type: 'string', enum: ['adjust', 'network', 'mixed'], description: 'mixed (recommended) reconciles both sources; network matches the ad networks\' own cost.' },
          attribution_source: { type: 'string', enum: ['first', 'dynamic'], description: 'dynamic (default) splits in-app revenue across install and reattribution; first credits the install source only.' },
          attribution_types: { type: 'array', items: { type: 'string', enum: ['click', 'impression', 'engaged_ad'] }, minItems: 1, uniqueItems: true, description: 'Only these attribution types.' },
          cohort_maturity: { type: 'string', enum: ['mature', 'immature'], description: 'mature (default) shows zero for cohorts not mature yet; immature shows live values.' },
          reattributed: { type: 'string', enum: ['all', 'true', 'false'], description: 'all (default), only reattributed, or none.' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Money in this currency, e.g. USD (default: the account\'s).' },
          utc_offset: { type: 'string', pattern: '^[+-]\\d{2}:\\d{2}$', description: 'The report\'s time zone as an offset, e.g. +01:00.' },
          sort: { type: 'array', items: { type: 'string', pattern: '^-?[A-Za-z0-9_]{1,120}$' }, minItems: 1, maxItems: 5, description: 'Sort fields, - for descending, e.g. ["-roas"].' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: 200, description: `Rows per page, 1 to ${MAX_ROWS} (default 200).` },
          cursor: CURSOR,
        },
        required: ['date_period', 'dimensions', 'metrics'],
        additionalProperties: false,
      },
      async run(args: {
        date_period: string; dimensions: string[]; metrics: string[]; app_tokens?: string[]; filters?: Record<string, unknown>; os_names?: string[];
        ad_spend_mode?: string; attribution_source?: string; attribution_types?: string[]; cohort_maturity?: string; reattributed?: string;
        currency?: string; utc_offset?: string; sort?: string[]; limit: number; cursor?: string;
      }, h) {
        const skip = skipOf(h, args.cursor);
        const apps = scopedApps(h, args.app_tokens);
        const filters = reportFilters(args.filters);
        const { data } = await h.api({
          path: '/reports-service/report',
          query: {
            date_period: args.date_period,
            dimensions: args.dimensions.join(','),
            metrics: args.metrics.join(','),
            app_token__in: apps?.join(','),
            os_names: args.os_names?.join(','),
            ad_spend_mode: args.ad_spend_mode,
            attribution_source: args.attribution_source,
            attribution_types: args.attribution_types?.join(','),
            cohort_maturity: args.cohort_maturity,
            reattributed: args.reattributed,
            currency: args.currency,
            utc_offset: args.utc_offset,
            sort: args.sort?.join(','),
            ...filters,
          },
          errors: ERRORS,
        });
        const rows: unknown[] = (Array.isArray(data?.rows) ? data.rows : []).map(trimRow);
        const warnings = Array.isArray(data?.warnings) && data.warnings.length ? data.warnings.map((item: unknown) => truncate(String(typeof item === 'string' ? item : JSON.stringify(item)), 300)) : undefined;
        return offsetPage(h, 'rows', rows, skip, args.limit, compact({
          datePeriod: args.date_period,
          apps: apps ?? 'all',
          rowsTotal: rows.length,
          totals: data?.totals,
          warnings,
          note: rows.length ? undefined : 'Adjust has no data for this window and these filters.',
        }));
      },
    },
    {
      name: 'get_filter_values',
      kind: 'read',
      title: 'List Adjust filter values and metrics',
      description:
        'What a report may use: the metric catalogue (overview_metrics, cohort_metrics, event_metrics, cost_metrics, skad_metrics), dimensions, '
        + 'networks, partners, countries, currencies, os_names, ad_spend_mode, attribution_types and more, each value with its id (what a report takes), '
        + 'name and section. search narrows each list to ids and names that contain it. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          lists: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z_]{2,40}$' },
            minItems: 1,
            maxItems: 10,
            uniqueItems: true,
            description: 'The lists, e.g. ["overview_metrics", "cohort_metrics"] or ["dimensions"] or ["partners"].',
          },
          search: { type: 'string', minLength: 1, maxLength: 100, description: 'Only values whose id or name contains this, e.g. roas.' },
          cursor: CURSOR,
        },
        required: ['lists'],
        additionalProperties: false,
      },
      async run(args: { lists: string[]; search?: string; cursor?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const query: Record<string, string> = { required_filters: args.lists.join(',') };
        if (args.search) for (const list of args.lists) query[`${list}__contains`] = args.search;
        const { data } = await h.api({ path: '/reports-service/filters_data', query, errors: ERRORS });
        const items: unknown[] = [];
        for (const list of args.lists) {
          for (const item of Array.isArray(data?.[list]) ? data[list] : []) items.push(trimOption(item, list));
        }
        return offsetPage(h, 'values', items, skip, MAX_ROWS, {});
      },
    },
    {
      name: 'list_events',
      kind: 'read',
      title: 'List Adjust events',
      description:
        "The in-app events of the apps, by their machine slug (id), which per-event metrics use, such as <slug>_events or <slug>_revenue: name, "
        + 'section, the apps that have it, and whether it is a SKAdNetwork event. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          app_tokens: APP_TOKENS,
          search: { type: 'string', minLength: 1, maxLength: 100, description: 'Only events whose slug or name contains this, e.g. purchase.' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { app_tokens?: string[]; search?: string; cursor?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const apps = scopedApps(h, args.app_tokens);
        const { data } = await h.api({ path: '/reports-service/events', query: { app_token__in: apps?.join(','), events__contains: args.search }, errors: ERRORS });
        const events: unknown[] = (Array.isArray(data) ? data : []).map((event: any) => compact({
          ...trimOption(event),
          appTokens: Array.isArray(event?.app_token) ? event.app_token : undefined,
          skadEvent: event?.is_skad_event,
        }));
        return offsetPage(h, 'events', events, skip, MAX_ROWS, {});
      },
    },
    // Only api_get: the Report Service API is read-only. Under an account
    // lock, a request must name chosen apps in app_token__in.
    ...apiTools({
      label: 'Adjust',
      description:
        'The Adjust Report Service API at https://automate.adjust.com/reports-service, with the connected token: paths start with /reports-service/, '
        + 'such as /reports-service/report, /reports-service/pivot_report or /reports-service/csv_report, with the report parameters in query '
        + '(date_period, dimensions, metrics, app_token__in, ...). Under an account lock, app_token__in must list only chosen apps. '
        + 'Reference: https://dev.adjust.com/en/api/rs-api/.',
      basePath: '/reports-service/',
      accounts: {
        key: 'apps',
        label: 'app',
        ids: (request) => (request.query['app_token__in'] ?? []).flatMap((value) => value.split(',')).map((token) => token.trim()).filter(Boolean),
      },
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

export = connector;
