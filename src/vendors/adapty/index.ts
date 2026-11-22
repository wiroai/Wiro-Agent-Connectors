// Adapty, through its Analytics Export API
// (https://adapty.io/docs/api-export-analytics): one app's aggregate
// subscription analytics, as the Adapty Dashboard's charts show them.
//
// Credential: `apikey`, the app's secret API key (secret_live_...), from the
// Adapty Dashboard -> App settings -> General -> API keys. An Adapty key
// belongs to one app, so every answer covers that app. It goes in the
// Authorization: Api-Key header to https://api-admin.adapty.io only.
//
// Aggregate numbers only: the module calls the six analytics endpoints
// (analytics, conversion, funnel, retention, ltv, cohort) and nothing else,
// never Adapty's server-side API or a user profile. They are reads sent by
// POST, so they are marked safe.

import { defineConnector, jsonSize, OUTPUT_LIMIT_BYTES, ToolFailure, truncate, type ToolDefinition, type ToolHelpers } from '../../core/index.js';

type JsonSchema = ToolDefinition['inputSchema'];

const ORIGIN = 'https://api-admin.adapty.io';
const BASE = '/api/v1/client-api/metrics';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Room kept under the output limit for the fields a cut result adds. */
const ROOM = 600;

const CHARTS = [
  'revenue', 'mrr', 'arr', 'arpu', 'arppu', 'subscriptions_active', 'subscriptions_new', 'subscriptions_renewal_cancelled', 'subscriptions_expired',
  'trials_active', 'trials_new', 'trials_renewal_cancelled', 'trials_expired', 'grace_period', 'billing_issue', 'refund_events', 'refund_money',
  'non_subscriptions', 'installs',
];
const SEGMENTATIONS = [
  'period', 'renewal_status', 'cancellation_reason', 'store_product_id', 'country', 'store', 'paywall_id', 'audience_id', 'placement_id', 'flow_id',
  'flow_screen_id', 'segment_id', 'duration', 'offer_category', 'offer_type', 'offer_id', 'attribution_source', 'attribution_status',
  'attribution_channel', 'attribution_campaign', 'attribution_adgroup', 'attribution_adset', 'attribution_creative', 'day', 'week', 'month', 'year',
];
const PERIOD_UNITS = ['day', 'week', 'month', 'quarter', 'year'];

const ERRORS = {
  400: 'Adapty did not accept the request: a field, value or date it does not know. For a filter value you are not sure of, run the same call with that field as segmentation and use the exact values it shows',
  401: "Adapty rejected the API key: it was replaced or mistyped. Paste the app's current secret key (App settings, General tab)",
};

const DATE = { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const UUID_LIST = (what: string): JsonSchema => ({
  type: 'array',
  items: { type: 'string', pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' },
  minItems: 1,
  maxItems: 100,
  description: `Adapty ${what} ids (UUIDs, from the item's URL in the Adapty Dashboard). Never guess one.`,
});
const TEXT_LIST = (description: string, pattern = '^.{1,200}$'): JsonSchema => ({
  type: 'array',
  items: { type: 'string', pattern },
  minItems: 1,
  maxItems: 100,
  description,
});

const FILTERS: JsonSchema = {
  type: 'object',
  description: 'Filters; each is a list of values, and values in one list are ORed.',
  properties: {
    country: TEXT_LIST('Two-letter country codes, e.g. ["us", "de"].', '^[A-Za-z]{2}$'),
    store: TEXT_LIST('Stores, e.g. ["app_store", "play_store"].'),
    store_product_id: TEXT_LIST('Store-qualified product ids, "<store>:<product_id>", e.g. ["app_store:premium_monthly"]. A bare product id is refused.', '^[a-z_]+:.{1,200}$'),
    duration: TEXT_LIST('Subscription durations.'),
    offer_category: TEXT_LIST('Offer categories, e.g. ["introductory"] or ["promotional"].'),
    offer_type: TEXT_LIST('Offer types.'),
    offer_id: TEXT_LIST('Offer ids.'),
    attribution_source: TEXT_LIST('Attribution sources (integrations).'),
    attribution_status: TEXT_LIST('"organic" or "non-organic".'),
    attribution_channel: TEXT_LIST('Attribution channels.'),
    attribution_campaign: TEXT_LIST('Attribution campaigns.'),
    attribution_adgroup: TEXT_LIST('Attribution ad groups.'),
    attribution_adset: TEXT_LIST('Attribution ad sets.'),
    attribution_creative: TEXT_LIST('Attribution creatives.'),
    segment_id: UUID_LIST('segment'),
    audience_id: UUID_LIST('audience'),
    paywall_id: UUID_LIST('paywall'),
    placement_id: UUID_LIST('placement'),
    flow_id: UUID_LIST('flow'),
    flow_screen_id: TEXT_LIST('Flow screens, "<flow_id>:<screen_id>".', '^[^:]{1,100}:.{1,100}$'),
    virtual_currency: TEXT_LIST('Virtual currency codes, or "no-virtual-currency".'),
  },
  additionalProperties: false,
};

const COMMON: Record<string, JsonSchema> = {
  date_from: { ...DATE, description: 'The first day, YYYY-MM-DD. With date_to; default: the last 28 full days, ending yesterday (UTC).' },
  date_to: { ...DATE, description: 'The last day, YYYY-MM-DD; both ends are included.' },
  compare_from: { ...DATE, description: 'A period to compare with: its first day (with compare_to).' },
  compare_to: { ...DATE, description: 'The comparison period\'s last day.' },
  filters: FILTERS,
  timezone: {
    type: 'string',
    pattern: '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$',
    description: 'The time zone Adapty groups days in, an IANA name such as Europe/Berlin. Name it in the report.',
  },
};
const SEGMENTATION: JsonSchema = { type: 'string', enum: SEGMENTATIONS, description: 'One grouping, e.g. country, store, store_product_id, attribution_channel, or week.' };
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result, with the same other arguments.' };
const PERIOD_UNIT: JsonSchema = { type: 'string', enum: PERIOD_UNITS, description: 'The interval of the points: day, week, month, quarter or year.' };
const DATE_TYPE: JsonSchema = {
  type: 'string',
  enum: ['purchase_date', 'profile_install_date'],
  description: 'Which date counts: purchase_date (the purchase, default) or profile_install_date (the install).',
};

interface CommonArgs {
  date_from?: string;
  date_to?: string;
  compare_from?: string;
  compare_to?: string;
  filters?: Record<string, string[]>;
  timezone?: string;
  cursor?: string;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Adapty's own definition of a metric, as plain text (it comes as HTML). */
function definition(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const plain = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain ? truncate(plain, 400) : undefined;
}

/** The filters object every endpoint takes: the date range, the comparison period and the other filters. */
function filtersOf(args: CommonArgs): Record<string, unknown> {
  let from = args.date_from;
  let to = args.date_to;
  if ((from === undefined) !== (to === undefined)) throw new ToolFailure('Give date_from and date_to together, or neither for the last 28 days. Nothing was sent to Adapty.');
  if (from === undefined || to === undefined) {
    const yesterday = Date.now() - DAY_MS;
    from = day(yesterday - 27 * DAY_MS);
    to = day(yesterday);
  }
  if (from > to) throw new ToolFailure('date_from must not be after date_to. Nothing was sent to Adapty.');
  const filters: Record<string, unknown> = { date: [from, to] };
  if ((args.compare_from === undefined) !== (args.compare_to === undefined)) {
    throw new ToolFailure('Give compare_from and compare_to together. Nothing was sent to Adapty.');
  }
  if (args.compare_from !== undefined && args.compare_to !== undefined) {
    if (args.compare_from > args.compare_to) throw new ToolFailure('compare_from must not be after compare_to. Nothing was sent to Adapty.');
    filters['compare_date'] = [args.compare_from, args.compare_to];
  }
  for (const [key, values] of Object.entries(args.filters ?? {})) filters[key] = values;
  return filters;
}

/** One POST to an analytics endpoint. It changes nothing, so it is marked safe. */
async function metrics(h: ToolHelpers, endpoint: string, body: Record<string, unknown>, timezone?: string): Promise<any> {
  const { data } = await h.api({
    method: 'POST',
    path: `${BASE}/${endpoint}/`,
    json: { ...body, format: 'json' },
    safe: true,
    errors: ERRORS,
    ...(timezone ? { headers: { 'adapty-tz': timezone } } : {}),
  });
  if (data === null || typeof data !== 'object') throw new ToolFailure('Adapty answered with something other than JSON.');
  return data;
}

function rangeOf(body: Record<string, unknown>): Record<string, unknown> {
  const filters = body['filters'] as Record<string, unknown>;
  return compact({ dateRange: filters['date'], compareRange: filters['compare_date'] });
}

/**
 * A result with several lists of points side by side (one per metric), cut at
 * the same place when it does not fit: the cursor continues each list there.
 */
function fitParallel(
  h: ToolHelpers,
  base: Record<string, unknown>,
  lists: Array<{ name: string; meta: Record<string, unknown>; items: unknown[] }>,
  skip: number,
  key: string,
): Record<string, unknown> {
  const longest = Math.max(0, ...lists.map((list) => list.items.length));
  const build = (count: number): Record<string, unknown> => ({
    ...base,
    [key]: Object.fromEntries(lists.map((list) => [list.name, { ...list.meta, points: list.items.slice(skip, skip + count) }])),
  });
  const remaining = Math.max(0, longest - skip);
  const whole = build(remaining);
  if (jsonSize(whole) <= OUTPUT_LIMIT_BYTES - ROOM) return whole;
  let low = 1;
  let high = remaining - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonSize(build(middle)) <= OUTPUT_LIMIT_BYTES - ROOM) low = middle;
    else high = middle - 1;
  }
  const more = skip + low < longest;
  return {
    ...build(low),
    truncated: true,
    note: `Points ${skip + 1} to ${skip + low} of ${longest} are shown${more ? ': pass nextCursor back as cursor for the rest, or ask for a longer period_unit' : ''}.`,
    ...(more ? { nextCursor: h.makeCursor({ o: skip + low }) } : {}),
  };
}

function skipOf(h: ToolHelpers, cursor: string | undefined): number {
  const state = h.cursor(cursor);
  return typeof state?.['o'] === 'number' ? state['o'] : 0;
}

function trimMetric(metric: any): Record<string, unknown> {
  return compact({
    title: metric?.title,
    metricName: metric?.metric_name,
    value: metric?.value,
    valueFrom: metric?.value_from,
    valueTo: metric?.value_to,
    compareValueFrom: metric?.compare_value_from,
    compareValueTo: metric?.compare_value_to,
    unit: metric?.unit,
    aggregation: metric?.default_aggregation,
    recommendedPeriod: metric?.recommended_period,
    definition: definition(metric?.description),
  });
}

const connector = defineConnector({
  vendor: 'adapty',
  label: 'Adapty',
  origins: [ORIGIN],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'Adapty secret API key' },
  authHeaders: (credentials) => ({ authorization: `Api-Key ${credentials['apikey']}` }),
  tools: [
    {
      name: 'get_chart',
      kind: 'read',
      title: 'Get an Adapty analytics chart',
      description:
        "One of the app's analytics charts over a date range: revenue (with revenue, proceeds after store commission, and net revenue after taxes), MRR, "
        + 'ARR, ARPU, ARPPU, active and new subscriptions and trials, cancellations, expirations, grace period, billing issues, refunds, one-time '
        + 'purchases or installs. Each metric has its total for the period (value; never add up points of an average metric), its points by period or '
        + 'group, the comparison values when compare dates are given, its unit and Adapty\'s definition. Revenue counts on the purchase day; for '
        + 'revenue by install date use get_cohorts.',
      inputSchema: {
        type: 'object',
        properties: {
          chart_id: { type: 'string', enum: CHARTS, default: 'revenue', description: 'The chart (default revenue).' },
          ...COMMON,
          period_unit: { ...PERIOD_UNIT, default: 'month' },
          date_type: DATE_TYPE,
          segmentation: SEGMENTATION,
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: CommonArgs & { chart_id: string; period_unit: string; date_type?: string; segmentation?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({ chart_id: args.chart_id, filters: filtersOf(args), period_unit: args.period_unit, date_type: args.date_type, segmentation: args.segmentation });
        const data = await metrics(h, 'analytics', body, args.timezone);
        const metricsData = data?.data && typeof data.data === 'object' ? data.data : {};
        const lists = Object.entries(metricsData).map(([name, metric]: [string, any]) => ({
          name,
          meta: trimMetric(metric),
          items: Array.isArray(metric?.data) ? metric.data : [],
        }));
        return fitParallel(h, compact({ chart: args.chart_id, ...rangeOf(body), periodUnit: args.period_unit, segmentation: args.segmentation, timezone: args.timezone }), lists, skip, 'metrics');
      },
    },
    {
      name: 'get_conversion',
      kind: 'read',
      title: 'Get an Adapty conversion rate',
      description:
        'A conversion rate between two subscription periods, such as from the first paid period (from_period 1) to more than 6 months (to_period "6+"), '
        + 'the pair Adapty documents. value is the rate in percent and title names the conversion: report another pair only when title names it.',
      inputSchema: {
        type: 'object',
        properties: {
          from_period: { type: 'string', pattern: '^[A-Za-z0-9+_-]{1,20}$', description: 'The starting period, e.g. "1".' },
          to_period: { type: 'string', pattern: '^[A-Za-z0-9+_-]{1,20}$', description: 'The period converted to, e.g. "6+".' },
          ...COMMON,
          period_unit: { ...PERIOD_UNIT, default: 'day' },
          date_type: DATE_TYPE,
          segmentation: SEGMENTATION,
          cursor: CURSOR,
        },
        required: ['from_period', 'to_period'],
        additionalProperties: false,
      },
      async run(args: CommonArgs & { from_period: string; to_period: string; period_unit: string; date_type?: string; segmentation?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({
          filters: filtersOf(args),
          // Adapty's own example sends a number for a numeric starting period.
          from_period: /^\d+$/.test(args.from_period) ? Number(args.from_period) : args.from_period,
          to_period: args.to_period,
          period_unit: args.period_unit,
          date_type: args.date_type,
          segmentation: args.segmentation,
        });
        const data = await metrics(h, 'conversion', body, args.timezone);
        return h.page({
          key: 'points',
          items: (Array.isArray(data?.data) ? data.data : []).slice(skip),
          extra: compact({ ...rangeOf(body), ...trimMetric(data), timezone: args.timezone }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'get_funnel',
      kind: 'read',
      title: 'Get the Adapty funnel',
      description:
        'Where users drop off, from install to paywall shown, trial and paid periods: each stage with the users who reached it (value), their share of '
        + 'the first stage (value_relative) and the users lost before the next stage. The segment of type total is the whole app.',
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          show_value_as: { type: 'string', enum: ['absolute', 'relative', 'both'], default: 'both', description: 'absolute, relative or both (default).' },
          segmentation: SEGMENTATION,
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: CommonArgs & { show_value_as: string; segmentation?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({ filters: filtersOf(args), show_value_as: args.show_value_as, segmentation: args.segmentation });
        const data = await metrics(h, 'funnel', body, args.timezone);
        return h.page({
          key: 'segments',
          items: (Array.isArray(data?.data) ? data.data : []).slice(skip),
          extra: compact({ ...rangeOf(body), timezone: args.timezone }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'get_retention',
      kind: 'read',
      title: 'Get Adapty subscription retention',
      description: 'How many subscribers stay, period by period, counted from the first paid period or, with use_trial, from the trial.',
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          use_trial: { type: 'boolean', default: false, description: 'true counts from the trial.' },
          segmentation: SEGMENTATION,
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: CommonArgs & { use_trial: boolean; segmentation?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({ filters: filtersOf(args), use_trial: args.use_trial, segmentation: args.segmentation });
        const data = await metrics(h, 'retention', body, args.timezone);
        return h.page({
          key: 'rows',
          items: (Array.isArray(data?.data) ? data.data : []).slice(skip),
          extra: compact({ ...rangeOf(body), title: data?.title, metricName: data?.metric_name, valueType: data?.value_type, definition: definition(data?.description), timezone: args.timezone }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'get_ltv',
      kind: 'read',
      title: 'Get Adapty lifetime value',
      description:
        'Realized lifetime value (revenue for the period divided by the subscribers at its start, not a prediction) on three bases: revenue, proceeds '
        + 'and net revenue, each with its total and rows (the total row first) with cohort sizes and values per period. Say which basis you quote.',
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          period_unit: PERIOD_UNIT,
          period_type: { type: 'string', enum: ['renewals', 'days'], description: 'Count periods by renewals or by days.' },
          segmentation: SEGMENTATION,
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: CommonArgs & { period_unit?: string; period_type?: string; segmentation?: string }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({ filters: filtersOf(args), period_unit: args.period_unit, period_type: args.period_type, segmentation: args.segmentation });
        const data = await metrics(h, 'ltv', body, args.timezone);
        const lists = ['revenue', 'proceeds', 'net_revenue']
          .filter((name) => data?.[name] && typeof data[name] === 'object')
          .map((name) => ({
            name,
            meta: compact({ title: data[name].title, value: data[name].value, unit: data[name].unit, definition: definition(data[name].description) }),
            items: Array.isArray(data[name].data) ? data[name].data : [],
          }));
        return fitParallel(h, compact({ ...rangeOf(body), periodUnit: args.period_unit, periodType: args.period_type, segmentation: args.segmentation, timezone: args.timezone }), lists, skip, 'bases');
      },
    },
    {
      name: 'get_cohorts',
      kind: 'read',
      title: 'Get Adapty install cohorts',
      description:
        'Install cohorts: per install period, the installs, subscribers, subscriptions, revenue, proceeds and net revenue in USD, ARPU and ARPPU, with '
        + 'values per period and predictions. Revenue counts on each user\'s install date, as ad reports do. A period with currently_active_period true '
        + 'is still running and will grow. Takes no segmentation.',
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          period_unit: { ...PERIOD_UNIT, default: 'month' },
          period_type: { type: 'string', enum: ['renewals', 'days'], default: 'renewals', description: 'Count periods by renewals (default) or by days.' },
          value_type: { type: 'string', enum: ['absolute', 'relative'], default: 'absolute', description: 'absolute (default) or relative values.' },
          value_field: { type: 'string', enum: ['revenue', 'arppu', 'arpu', 'arpas', 'subscribers', 'subscriptions'], default: 'revenue', description: 'The value shown per period (default revenue).' },
          accounting_type: { type: 'string', enum: ['revenue', 'proceeds', 'net_revenue'], default: 'revenue', description: 'revenue (default), proceeds or net_revenue.' },
          renewal_days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 3650 }, maxItems: 50, uniqueItems: true, description: 'Days since install, with period_type days.' },
          prediction_months: { type: 'integer', enum: [3, 6, 9, 12, 18, 24], default: 12, description: 'Months of prediction: 3, 6, 9, 12 (default), 18 or 24.' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: CommonArgs & { period_unit: string; period_type: string; value_type: string; value_field: string; accounting_type: string; renewal_days?: number[]; prediction_months: number }, h) {
        const skip = skipOf(h, args.cursor);
        const body = compact({
          filters: filtersOf(args),
          period_unit: args.period_unit,
          period_type: args.period_type,
          value_type: args.value_type,
          value_field: args.value_field,
          accounting_type: args.accounting_type,
          renewal_days: args.renewal_days,
          prediction_months: args.prediction_months,
        });
        const data = await metrics(h, 'cohort', body, args.timezone);
        return h.page({
          key: 'cohorts',
          items: (Array.isArray(data?.data) ? data.data : []).slice(skip),
          extra: compact({ ...rangeOf(body), periodUnit: args.period_unit, valueField: args.value_field, accountingType: args.accounting_type, timezone: args.timezone }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
  ],
});

export = connector;
