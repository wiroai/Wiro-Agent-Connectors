// RevenueCat, through its REST API v2 (https://www.revenuecat.com/docs/api-v2):
// a project's aggregate subscription numbers and its configuration.
//
// Credential: `apikey`, a RevenueCat secret API key of version V2 (sk_...),
// from Project settings -> API keys -> + New secret API key, read-only for
// Charts & Metrics and Project configuration, with no access to Customer
// information. It goes in the Authorization: Bearer header to
// https://api.revenuecat.com only.
//
// Aggregate numbers only: the module reaches projects, apps, overview and
// revenue metrics, charts, products, offerings and entitlements with GET, and
// nothing else. No customer, subscription, purchase, invoice, audience,
// collaborator, audit log, webhook or key route, no v1, and no writes.

import { apiTools, defineConnector, jsonSize, OUTPUT_LIMIT_BYTES, ToolFailure, truncate, type ApiRequest, type QueryValue, type ToolHelpers } from '../../core/index.js';

const ORIGIN = 'https://api.revenuecat.com';
/** The aggregate routes: everything the module may read. A percent-escape never passes. */
const AGGREGATE_PATH =
  /^\/v2\/projects(?:\/[^/%]+\/(?:apps(?:\/[^/%]+)?|metrics\/(?:overview|revenue)|charts\/[^/%]+(?:\/options)?|products(?:\/[^/%]+)?|offerings(?:\/[^/%]+)?|entitlements(?:\/[^/%]+(?:\/products)?)?))?\/?$/;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'BRL', 'KRW', 'CNY', 'MXN', 'SEK', 'PLN', 'NZD', 'CHF', 'DKK', 'HKD', 'IDR', 'INR', 'KES', 'MYR', 'NOK', 'PKR', 'SGD', 'TRY', 'TWD', 'ZAR'];
/** Room kept under the output limit for the fields a folded result adds. */
const ROOM = 1000;

const ERRORS = {
  401: 'RevenueCat rejected the API key: it was revoked or mistyped, or it is a v1 key (a V2 secret key is needed)',
  403: 'The RevenueCat API key lacks the permission for this: overview, revenue and charts need Charts & Metrics read, projects, apps, products, offerings and entitlements need Project configuration read',
  404: 'RevenueCat found no such project, chart, offering, entitlement or product',
};

type Query = Record<string, QueryValue | undefined>;

const PROJECT_ID = {
  type: 'string' as const,
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'The project id (starts with proj), from list_projects. Leave out when the key sees one project.',
};
const RESOURCE_ID = { type: 'string' as const, pattern: '^[A-Za-z0-9_-]{1,128}$' };
const DATE = { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const CURRENCY = { type: 'string' as const, enum: CURRENCIES, description: 'Convert money to this currency (default USD).' };
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const CHART_NAME = {
  type: 'string' as const,
  pattern: '^[a-z][a-z0-9_-]{1,63}$',
  description:
    'The chart: revenue, mrr, mrr_movement, arr, actives, actives_new, actives_movement, trials, trials_new, trials_movement, '
    + 'trial_conversion_rate, trial_conversion, initial_conversion, conversion_to_paying, trial_cancellation, customers_new, customers_active, '
    + 'churn, subscription_retention, subscription_status, ltv_per_customer, ltv_per_paying_customer, cohort_explorer, prediction_explorer, '
    + 'refund_rate, refunds, refund_request, non-subscription_purchases, and the ad, paywall and retention message charts.',
};

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value, max) : undefined;
}

async function get(h: ToolHelpers, path: string, query?: Query): Promise<any> {
  const request: ApiRequest = { path, errors: ERRORS, ...(query ? { query } : {}) };
  const { data } = await h.api(request);
  return data;
}

/** The project of the call: the one given, or the only one the key sees. */
async function projectOf(h: ToolHelpers, given: string | undefined): Promise<string> {
  if (given) return given;
  const data = await get(h, '/v2/projects', { limit: 20 });
  const projects: any[] = Array.isArray(data?.items) ? data.items : [];
  if (projects.length === 1 && typeof projects[0]?.id === 'string') return projects[0].id;
  if (!projects.length) throw new ToolFailure('The RevenueCat API key sees no project.');
  const listed = projects.slice(0, 20).map((project) => `${project?.id} (${truncate(String(project?.name ?? ''), 60)})`).join(', ');
  throw new ToolFailure(`The RevenueCat API key sees several projects: pass project_id, one of ${listed}.`);
}

/** The starting_after of a list's next_page, if there is one. */
function nextStartingAfter(data: any): string | undefined {
  if (typeof data?.next_page !== 'string' || !data.next_page) return undefined;
  try {
    return new URL(data.next_page, ORIGIN).searchParams.get('starting_after') ?? undefined;
  } catch {
    return undefined;
  }
}

/** One page of a RevenueCat list, continued with starting_after, and cut to fit when needed. */
async function listPage(
  h: ToolHelpers,
  options: { key: string; path: string; query?: Query; cursor?: string; map(item: any): unknown; extra?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const state = h.cursor(options.cursor);
  const after = typeof state?.['s'] === 'string' ? state['s'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const data = await get(h, options.path, { limit: 100, ...options.query, starting_after: after });
  const items: unknown[] = (Array.isArray(data?.items) ? data.items : []).map(options.map);
  const next = nextStartingAfter(data);
  return h.page({
    key: options.key,
    items: items.slice(skip),
    ...(options.extra ? { extra: options.extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...(after ? { s: after } : {}), o: skip + index }),
    ...(next ? { nextPage: h.makeCursor({ s: next, o: 0 }) } : {}),
  });
}

function trimApp(app: any): Record<string, unknown> {
  return compact({
    id: app?.id,
    name: app?.name,
    type: app?.type,
    bundleId: app?.app_store?.bundle_id ?? app?.mac_app_store?.bundle_id,
    packageName: app?.play_store?.package_name ?? app?.amazon?.package_name,
    createdAt: app?.created_at,
  });
}

function trimProduct(product: any): Record<string, unknown> {
  return compact({
    id: product?.id,
    storeIdentifier: product?.store_identifier,
    type: product?.type,
    displayName: product?.display_name,
    appId: product?.app_id,
    state: product?.state,
    duration: product?.subscription?.duration,
    trialDuration: product?.subscription?.trial_duration,
    gracePeriodDuration: product?.subscription?.grace_period_duration,
    consumable: product?.one_time?.is_consumable,
    createdAt: product?.created_at,
  });
}

function trimOffering(offering: any): Record<string, unknown> {
  const packages: any[] = Array.isArray(offering?.packages?.items) ? offering.packages.items : [];
  return compact({
    id: offering?.id,
    lookupKey: offering?.lookup_key,
    displayName: offering?.display_name,
    isCurrent: offering?.is_current,
    state: offering?.state,
    createdAt: offering?.created_at,
    packages: packages.length
      ? packages.map((pkg) => compact({
        id: pkg?.id,
        lookupKey: pkg?.lookup_key,
        displayName: pkg?.display_name,
        position: pkg?.position,
        products: (Array.isArray(pkg?.products?.items) ? pkg.products.items : []).map((item: any) => compact({
          eligibility: item?.eligibility_criteria,
          ...(item?.product && typeof item.product === 'object' ? trimProduct(item.product) : { id: item?.product_id }),
        })),
      }))
      : undefined,
  });
}

function trimEntitlement(entitlement: any): Record<string, unknown> {
  return compact({
    id: entitlement?.id,
    lookupKey: entitlement?.lookup_key,
    displayName: entitlement?.display_name,
    state: entitlement?.state,
    createdAt: entitlement?.created_at,
  });
}

/**
 * A chart point, with the period start as a date next to RevenueCat's Unix
 * time. RevenueCat sends a point as an object, or for some charts as an array
 * of numbers: those pass through as they came.
 */
function trimPoint(point: any): unknown {
  if (typeof point !== 'object' || point === null || Array.isArray(point)) return point;
  const cohort = typeof point.cohort === 'number' ? point.cohort : undefined;
  let date: string | undefined;
  if (cohort !== undefined) {
    const time = cohort > 1e11 ? cohort : cohort * 1000;
    const parsed = new Date(time);
    if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().slice(0, 10);
  }
  return compact({
    date,
    cohort,
    measure: point.measure,
    segment: point.segment,
    period: point.period,
    value: point.value,
    incomplete: point.incomplete,
    confidence: point.confidence,
  });
}

function trimFilter(filter: any): Record<string, unknown> {
  return compact({ id: filter?.id, displayName: filter?.display_name, group: filter?.group_display_name, valueMode: filter?.value_mode });
}

function trimOption(option: any): Record<string, unknown> {
  return compact({ id: option?.id, displayName: option?.display_name });
}

function indexed(list: unknown, map: (item: any) => Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  return Array.isArray(list) ? list.map((item, index) => ({ index, ...map(item) })) : undefined;
}

const connector = defineConnector({
  vendor: 'revenuecat',
  label: 'RevenueCat',
  origins: [ORIGIN],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'RevenueCat secret API key' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['apikey']}` }),
  tools: [
    {
      name: 'list_projects',
      kind: 'read',
      title: 'List RevenueCat projects',
      description: 'Lists the RevenueCat projects the key sees (a secret key normally sees one): id (starts with proj) and name. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        return listPage(h, {
          key: 'projects',
          path: '/v2/projects',
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: (project: any) => compact({ id: project?.id, name: project?.name, createdAt: project?.created_at }),
        });
      },
    },
    {
      name: 'list_apps',
      kind: 'read',
      title: 'List RevenueCat apps',
      description:
        "Lists the project's apps: id, name, store type (app_store, play_store, stripe, amazon, mac_app_store, rc_billing, paddle, roku, test_store, "
        + 'external, galaxy) and bundle ID or package name. A chart\'s app filter takes the app id. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ID, cursor: CURSOR }, additionalProperties: false },
      async run(args: { project_id?: string; cursor?: string }, h) {
        const project = await projectOf(h, args.project_id);
        return listPage(h, {
          key: 'apps',
          path: `/v2/projects/${encodeURIComponent(project)}/apps`,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimApp,
          extra: { projectId: project },
        });
      },
    },
    {
      name: 'get_overview',
      kind: 'read',
      title: 'Get RevenueCat overview metrics',
      description:
        "The dashboard's overview cards: active trials, active subscriptions, MRR, revenue, new customers and active customers. Period P0D means "
        + 'now, P28D the last 28 days; revenue is gross (before store fees and taxes). Each card has its update time.',
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ID, currency: CURRENCY }, additionalProperties: false },
      async run(args: { project_id?: string; currency?: string }, h) {
        const project = await projectOf(h, args.project_id);
        const data = await get(h, `/v2/projects/${encodeURIComponent(project)}/metrics/overview`, { currency: args.currency });
        return compact({
          projectId: project,
          currency: data?.currency,
          metrics: (Array.isArray(data?.metrics) ? data.metrics : []).map((metric: any) => compact({
            id: metric?.id,
            name: metric?.name,
            value: metric?.value,
            unit: metric?.unit,
            period: metric?.period,
            description: text(metric?.description, 300),
            lastUpdatedAt: metric?.last_updated_at_iso8601,
          })),
        });
      },
    },
    {
      name: 'get_revenue',
      kind: 'read',
      title: 'Get RevenueCat revenue for a date range',
      description:
        'Total revenue for a date range, both ends included (a range that includes today has a partial last day): gross revenue, revenue net of taxes, '
        + 'or proceeds after taxes and store commissions.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: PROJECT_ID,
          start_date: { ...DATE, description: 'The first day, YYYY-MM-DD.' },
          end_date: { ...DATE, description: 'The last day, YYYY-MM-DD.' },
          revenue_type: { type: 'string', enum: ['revenue', 'revenue_net_of_taxes', 'proceeds'], default: 'revenue', description: 'revenue (gross, default), revenue_net_of_taxes, or proceeds.' },
          currency: CURRENCY,
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
      async run(args: { project_id?: string; start_date: string; end_date: string; revenue_type: string; currency?: string }, h) {
        if (args.start_date > args.end_date) throw new ToolFailure('start_date must not be after end_date. Nothing was sent to RevenueCat.');
        const project = await projectOf(h, args.project_id);
        const data = await get(h, `/v2/projects/${encodeURIComponent(project)}/metrics/revenue`, {
          start_date: args.start_date,
          end_date: args.end_date,
          revenue_type: args.revenue_type,
          currency: args.currency,
        });
        return compact({ projectId: project, startDate: data?.start_date, endDate: data?.end_date, revenueType: data?.revenue_type, currency: data?.currency, value: data?.value });
      },
    },
    {
      name: 'get_chart_options',
      kind: 'read',
      title: 'Get a RevenueCat chart\'s options',
      description:
        'What a chart takes: its resolutions (pass the id as resolution), the filters with their values, the segments to group by, and its selectors '
        + '(such as revenue_type or conversion_timeframe). Read it before get_chart; never guess an option id. A filter whose values do not fit '
        + 'comes with optionCount only: pass its id as filter_id to list its values, in pages with cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: PROJECT_ID,
          chart_name: CHART_NAME,
          realtime: { type: 'boolean', default: true, description: 'Realtime data (default true); some charts exist only in realtime.' },
          filter_id: { type: 'string', minLength: 1, maxLength: 100, description: 'Only this filter\'s values, e.g. country or product.' },
          cursor: CURSOR,
        },
        required: ['chart_name'],
        additionalProperties: false,
      },
      async run(args: { project_id?: string; chart_name: string; realtime: boolean; filter_id?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const project = await projectOf(h, args.project_id);
        const data = await get(h, `/v2/projects/${encodeURIComponent(project)}/charts/${encodeURIComponent(args.chart_name)}/options`, { realtime: args.realtime });
        const filters: any[] = Array.isArray(data?.filters) ? data.filters : [];
        const optionsOf = (filter: any): any[] => (Array.isArray(filter?.options) ? filter.options : []);

        if (args.filter_id !== undefined) {
          const filter = filters.find((item) => item?.id === args.filter_id);
          if (!filter) {
            const ids = filters.map((item) => item?.id).filter((id) => typeof id === 'string').slice(0, 50);
            throw new ToolFailure(`The ${args.chart_name} chart has no filter ${args.filter_id}.${ids.length ? ` Its filters: ${ids.join(', ')}.` : ' It has no filters.'}`);
          }
          const options = optionsOf(filter);
          return h.page({
            key: 'options',
            items: options.slice(skip).map(trimOption),
            extra: { projectId: project, chart: args.chart_name, filter: { ...trimFilter(filter), optionCount: options.length } },
            resumeAt: (index) => h.makeCursor({ o: skip + index }),
          });
        }

        const listed = filters.map((filter) => {
          const options = optionsOf(filter);
          return { ...trimFilter(filter), ...(options.length ? { options: options.map(trimOption) } : {}) } as Record<string, unknown>;
        });
        const result = (notes?: string[]): Record<string, unknown> => compact({
          projectId: project,
          chart: args.chart_name,
          resolutions: (Array.isArray(data?.resolutions) ? data.resolutions : []).map((item: any) => compact({ id: item?.id, displayName: item?.display_name })),
          segments: (Array.isArray(data?.segments) ? data.segments : []).map((item: any) => compact({ id: item?.id, displayName: item?.display_name, group: item?.group_display_name })),
          filters: listed,
          userSelectors: data?.user_selectors,
          notes: notes?.length ? notes : undefined,
        });
        // The largest filters give up their values, one by one, until the result fits.
        const folded: string[] = [];
        const bySize = listed
          .map((filter, index) => ({ index, size: jsonSize(filter['options'] ?? []) }))
          .filter((item) => Array.isArray(listed[item.index]?.['options']))
          .sort((a, b) => b.size - a.size);
        for (const { index } of bySize) {
          if (jsonSize(result()) <= OUTPUT_LIMIT_BYTES - ROOM) break;
          const filter = listed[index] as Record<string, unknown>;
          const count = (filter['options'] as unknown[]).length;
          delete filter['options'];
          filter['optionCount'] = count;
          folded.push(String(filter['id']));
        }
        return result(folded.length
          ? [`The values of ${folded.join(', ')} are left out to fit: pass filter_id to list them.`]
          : undefined);
      },
    },
    {
      name: 'get_chart',
      kind: 'read',
      title: 'Get a RevenueCat chart',
      description:
        "A chart's data, as the dashboard shows it: measures, segments (the total first), points by period (with incomplete marking a partial period; "
        + 'a chart that sends points as arrays of numbers keeps them as they came) and the summary (total and average per measure; quote it rather '
        + 'than adding points). Take resolution, filter, segment and selector ids from get_chart_options. Long point lists come in pages: pass '
        + 'nextCursor back as cursor with the same other arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: PROJECT_ID,
          chart_name: CHART_NAME,
          start_date: { ...DATE, description: 'The first day, YYYY-MM-DD (UTC).' },
          end_date: { ...DATE, description: 'The last day, YYYY-MM-DD (UTC).' },
          resolution: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,20}$', description: 'A resolution id from get_chart_options, e.g. "0" for day.' },
          realtime: { type: 'boolean', default: true, description: 'Realtime data (default true).' },
          filters: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 100, description: 'A filter id from get_chart_options, e.g. store or country.' },
                values: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^,]+$' }, minItems: 1, maxItems: 100, description: 'Value ids; several are ORed.' },
              },
              required: ['name', 'values'],
              additionalProperties: false,
            },
            description: 'Filters; separate entries are ANDed, e.g. [{"name": "store", "values": ["app_store"]}].',
          },
          selectors: { type: 'object', description: 'Selector ids to option ids, e.g. {"revenue_type": "proceeds"}. Others keep their defaults.' },
          segment: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$', description: 'Group by this segment id from get_chart_options, e.g. country.' },
          limit_num_segments: { type: 'integer', minimum: 1, maximum: 50, description: 'Keep the top N segments and fold the rest into Other.' },
          aggregate: { type: 'string', enum: ['total', 'average', 'average,total'], description: 'Return only the summary (total, average or both), with no points.' },
          currency: CURRENCY,
          include_annotations: { type: 'boolean', description: 'true adds the notes the team put on the chart (releases, launches).' },
          cursor: CURSOR,
        },
        required: ['chart_name'],
        additionalProperties: false,
      },
      async run(args: {
        project_id?: string; chart_name: string; start_date?: string; end_date?: string; resolution?: string; realtime: boolean;
        filters?: Array<{ name: string; values: string[] }>; selectors?: Record<string, unknown>; segment?: string; limit_num_segments?: number;
        aggregate?: string; currency?: string; include_annotations?: boolean; cursor?: string;
      }, h) {
        if (args.start_date && args.end_date && args.start_date > args.end_date) throw new ToolFailure('start_date must not be after end_date. Nothing was sent to RevenueCat.');
        const selectors = args.selectors ?? {};
        for (const [key, value] of Object.entries(selectors)) {
          if (typeof value !== 'string' && typeof value !== 'number') throw new ToolFailure(`selectors.${key} must be an option id (text). Nothing was sent to RevenueCat.`);
        }
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const project = await projectOf(h, args.project_id);
        const data = await get(h, `/v2/projects/${encodeURIComponent(project)}/charts/${encodeURIComponent(args.chart_name)}`, {
          realtime: args.realtime,
          start_date: args.start_date,
          end_date: args.end_date,
          resolution: args.resolution,
          filters: args.filters?.length ? JSON.stringify(args.filters) : undefined,
          selectors: Object.keys(selectors).length ? JSON.stringify(selectors) : undefined,
          segment: args.segment,
          limit_num_segments: args.limit_num_segments,
          aggregate: args.aggregate,
          currency: args.currency,
          include_annotations: args.include_annotations,
        });
        const values: unknown[] = (Array.isArray(data?.values) ? data.values : []).map(trimPoint);
        return h.page({
          key: 'values',
          items: values.slice(skip),
          extra: compact({
            projectId: project,
            chart: args.chart_name,
            displayName: data?.display_name,
            description: text(data?.description, 500),
            resolution: data?.resolution,
            startDate: data?.start_date,
            endDate: data?.end_date,
            currency: data?.yaxis_currency,
            lastComputedAt: data?.last_computed_at,
            measures: indexed(data?.measures, (item) => compact({ displayName: item?.display_name, unit: item?.unit, description: text(item?.description, 200) })),
            segments: indexed(data?.segments, (item) => compact({ displayName: item?.display_name, isTotal: item?.is_total, isOther: item?.is_other })),
            periods: indexed(data?.periods, (item) => compact({ displayName: item?.display_name, unit: item?.unit })),
            summary: data?.summary,
            userSelectors: data?.user_selectors,
            annotations: Array.isArray(data?.annotations) && data.annotations.length
              ? data.annotations.map((note: any) => compact({ description: text(note?.description, 300), startDate: note?.start_date, endDate: note?.end_date }))
              : undefined,
          }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'list_products',
      kind: 'read',
      title: 'List RevenueCat products',
      description:
        "Lists the project's products: store identifier, type (subscription, one_time, consumable, non_consumable, non_renewing_subscription), display "
        + 'name, app, state, and for subscriptions the duration and trial duration (ISO 8601, P1M is a month). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { project_id: PROJECT_ID, app_id: { ...RESOURCE_ID, description: 'Only this app\'s products, from list_apps.' }, cursor: CURSOR },
        additionalProperties: false,
      },
      async run(args: { project_id?: string; app_id?: string; cursor?: string }, h) {
        const project = await projectOf(h, args.project_id);
        return listPage(h, {
          key: 'products',
          path: `/v2/projects/${encodeURIComponent(project)}/products`,
          query: { app_id: args.app_id },
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimProduct,
          extra: { projectId: project },
        });
      },
    },
    {
      name: 'list_offerings',
      kind: 'read',
      title: 'List RevenueCat offerings',
      description: "Lists the project's offerings: id, lookup key, display name, state, and is_current for the one the apps show by default. Pass nextCursor back as cursor for more; never conclude there is no current offering from a partial page.",
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ID, cursor: CURSOR }, additionalProperties: false },
      async run(args: { project_id?: string; cursor?: string }, h) {
        const project = await projectOf(h, args.project_id);
        return listPage(h, {
          key: 'offerings',
          path: `/v2/projects/${encodeURIComponent(project)}/offerings`,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimOffering,
          extra: { projectId: project },
        });
      },
    },
    {
      name: 'get_offering',
      kind: 'read',
      title: 'Get a RevenueCat offering',
      description: 'One offering with its packages and the products in each package (store identifier, type, duration, trial duration).',
      inputSchema: {
        type: 'object',
        properties: { project_id: PROJECT_ID, offering_id: { ...RESOURCE_ID, description: 'The offering id, from list_offerings.' } },
        required: ['offering_id'],
        additionalProperties: false,
      },
      async run(args: { project_id?: string; offering_id: string }, h) {
        const project = await projectOf(h, args.project_id);
        const data = await get(h, `/v2/projects/${encodeURIComponent(project)}/offerings/${encodeURIComponent(args.offering_id)}`, { expand: 'package.product' });
        return { projectId: project, offering: trimOffering(data) };
      },
    },
    {
      name: 'list_entitlements',
      kind: 'read',
      title: 'List RevenueCat entitlements',
      description: "Lists the project's entitlements: id, lookup key, display name and state. Pass nextCursor back as cursor for more.",
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ID, cursor: CURSOR }, additionalProperties: false },
      async run(args: { project_id?: string; cursor?: string }, h) {
        const project = await projectOf(h, args.project_id);
        return listPage(h, {
          key: 'entitlements',
          path: `/v2/projects/${encodeURIComponent(project)}/entitlements`,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimEntitlement,
          extra: { projectId: project },
        });
      },
    },
    {
      name: 'list_entitlement_products',
      kind: 'read',
      title: 'List the products of a RevenueCat entitlement',
      description: 'Lists the products attached to one entitlement. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { project_id: PROJECT_ID, entitlement_id: { ...RESOURCE_ID, description: 'The entitlement id, from list_entitlements.' }, cursor: CURSOR },
        required: ['entitlement_id'],
        additionalProperties: false,
      },
      async run(args: { project_id?: string; entitlement_id: string; cursor?: string }, h) {
        const project = await projectOf(h, args.project_id);
        return listPage(h, {
          key: 'products',
          path: `/v2/projects/${encodeURIComponent(project)}/entitlements/${encodeURIComponent(args.entitlement_id)}/products`,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimProduct,
          extra: { projectId: project, entitlementId: args.entitlement_id },
        });
      },
    },
    // Only api_get, and only on the aggregate routes: the key stays read-only
    // and away from customer data, whatever its permissions.
    ...apiTools({
      label: 'RevenueCat',
      description:
        'The RevenueCat REST API v2 at https://api.revenuecat.com/v2, with the connected secret key, on its aggregate routes only: /v2/projects, '
        + 'and under /v2/projects/<id>/: apps, apps/<id>, metrics/overview, metrics/revenue, charts/<name>, charts/<name>/options, products, '
        + 'products/<id>, offerings, offerings/<id>, entitlements, entitlements/<id> and entitlements/<id>/products. Customer, subscription, '
        + 'purchase and other routes are refused. Reference: https://www.revenuecat.com/docs/api-v2.',
      basePath: '/v2/projects',
      guard(request) {
        if (!AGGREGATE_PATH.test(request.path)) {
          throw new ToolFailure('This connector reads aggregate RevenueCat numbers only: the path must be one of its aggregate routes (projects, apps, metrics, charts, products, offerings, entitlements). Nothing was sent.');
        }
      },
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

export = connector;
