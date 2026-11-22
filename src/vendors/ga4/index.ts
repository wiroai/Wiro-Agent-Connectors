// Google Analytics 4, through the Analytics Data API v1beta (reports) and the
// Analytics Admin API v1beta/v1alpha (property settings, key events, custom
// definitions, data streams, Google Ads links, audiences).
//
// Credential: `access_token`, a Google OAuth access token with the scopes
// https://www.googleapis.com/auth/analytics.readonly and .../analytics.edit,
// from an OAuth client in the user's own Google Cloud project. The host signs
// in, refreshes the token and passes the current one on every call.
//
// Account picker `properties` (the GA4 properties the agent may use): every
// tool that names a property checks it against ctx.accounts.properties.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  jsonSize,
  OUTPUT_LIMIT_BYTES,
  requireAccounts,
  ToolFailure,
  truncate,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';

const DATA = 'https://analyticsdata.googleapis.com';
const ADMIN = 'https://analyticsadmin.googleapis.com';
const LABEL = 'Google Analytics';

const DATE = '^([0-9]{4}-[0-9]{2}-[0-9]{2}|today|yesterday|[0-9]{1,4}daysAgo)$';
const FIELD = '^[A-Za-z][A-Za-z0-9_:.\\-]{0,99}$';

const PROPERTY_ID = {
  type: 'string' as const,
  pattern: '^(properties/)?[0-9]{1,20}$',
  description: 'The GA4 property ID, digits only, e.g. "123456789" (list_properties lists them).',
};
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const DIMENSIONS = {
  type: 'array' as const,
  maxItems: 9,
  uniqueItems: true,
  items: { type: 'string' as const, pattern: FIELD },
  description: 'Dimension API names, e.g. ["date", "sessionSource", "sessionMedium"], or custom ones such as "customEvent:plan_tier" (get_metadata lists them).',
};
const METRICS = {
  type: 'array' as const,
  minItems: 1,
  maxItems: 10,
  uniqueItems: true,
  items: { type: 'string' as const, pattern: FIELD },
  description: 'Metric API names, e.g. ["sessions", "totalUsers", "keyEvents", "totalRevenue"] (keyEvents replaced conversions).',
};
const FILTER_HELP =
  'A GA4 FilterExpression as JSON, e.g. {"filter": {"fieldName": "sessionMedium", "stringFilter": {"value": "cpc"}}}, '
  + 'or {"andGroup": {"expressions": [...]}}; inListFilter, numericFilter and betweenFilter work too.';
const ORDER_BYS = {
  type: 'array' as const,
  maxItems: 10,
  items: { type: 'object' as const },
  description: 'GA4 OrderBy objects, e.g. [{"metric": {"metricName": "sessions"}, "desc": true}] or [{"dimension": {"dimensionName": "date"}}].',
};
const AGGREGATIONS = {
  type: 'array' as const,
  uniqueItems: true,
  items: { type: 'string' as const, enum: ['TOTAL', 'MAXIMUM', 'MINIMUM', 'COUNT'] },
  description: 'Extra rows to compute over all rows: TOTAL, MAXIMUM, MINIMUM, COUNT.',
};

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function propertyId(value: string): string {
  return value.replace(/^properties\//, '');
}

/** Refuses a property outside the ones chosen for the connection. */
function chosenProperty(h: ToolHelpers, value: string): string {
  const id = propertyId(value);
  requireAccounts(h.ctx.accounts, 'properties', id, 'property ID');
  return id;
}

/** A metric value as a number when it is one; GA4 sends every value as text. */
function metricValue(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) ? number : value;
}

/** GA4 rows as objects keyed by dimension and metric names. */
function flattenRows(data: any, rows: unknown): Record<string, unknown>[] {
  const dimensions: string[] = Array.isArray(data?.dimensionHeaders) ? data.dimensionHeaders.map((header: any) => String(header?.name)) : [];
  const metrics: string[] = Array.isArray(data?.metricHeaders) ? data.metricHeaders.map((header: any) => String(header?.name)) : [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row: any) => {
    const out: Record<string, unknown> = {};
    dimensions.forEach((name, index) => {
      out[name] = row?.dimensionValues?.[index]?.value ?? null;
    });
    metrics.forEach((name, index) => {
      out[name] = metricValue(row?.metricValues?.[index]?.value);
    });
    return out;
  });
}

function reportHeaders(data: any): Record<string, unknown> {
  return compact({
    dimensions: Array.isArray(data?.dimensionHeaders) ? data.dimensionHeaders.map((header: any) => header?.name) : undefined,
    metrics: Array.isArray(data?.metricHeaders)
      ? data.metricHeaders.map((header: any) => compact({ name: header?.name, type: header?.type }))
      : undefined,
  });
}

function reportMetadata(data: any): Record<string, unknown> | undefined {
  const metadata = data?.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const sampling = Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length
    ? metadata.samplingMetadatas.map((item: any) => compact({ samples_read: metricValue(item?.samplesReadCount), sampling_space: metricValue(item?.samplingSpaceSize) }))
    : undefined;
  const result = compact({
    currency_code: metadata.currencyCode,
    time_zone: metadata.timeZone,
    sampling,
    data_loss_from_other_row: metadata.dataLossFromOtherRow === true ? true : undefined,
    subject_to_thresholding: metadata.subjectToThresholding === true ? true : undefined,
    empty_reason: metadata.emptyReason,
  });
  return Object.keys(result).length ? result : undefined;
}

/** The parts of a report besides its rows: headers, totals and the like, metadata. */
function reportExtras(data: any): Record<string, unknown> {
  return compact({
    ...reportHeaders(data),
    row_count: typeof data?.rowCount === 'number' ? data.rowCount : 0,
    totals: Array.isArray(data?.totals) && data.totals.length ? flattenRows(data, data.totals) : undefined,
    maximums: Array.isArray(data?.maximums) && data.maximums.length ? flattenRows(data, data.maximums) : undefined,
    minimums: Array.isArray(data?.minimums) && data.minimums.length ? flattenRows(data, data.minimums) : undefined,
    metadata: reportMetadata(data),
  });
}

function names(list: string[] | undefined, key: 'name'): Record<string, string>[] | undefined {
  return list?.length ? list.map((name) => ({ [key]: name })) : undefined;
}

interface ReportArgs {
  property_id: string;
  date_ranges: { start_date: string; end_date: string; name?: string }[];
  dimensions?: string[];
  metrics: string[];
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Record<string, unknown>[];
  limit: number;
  offset?: number;
  keep_empty_rows?: boolean;
  currency_code?: string;
  metric_aggregations?: string[];
  cursor?: string;
}

interface RealtimeArgs {
  property_id: string;
  dimensions?: string[];
  metrics: string[];
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Record<string, unknown>[];
  limit: number;
  metric_aggregations?: string[];
  minute_ranges?: { start_minutes_ago?: number; end_minutes_ago?: number; name?: string }[];
  cursor?: string;
}

const REPORT_ERRORS = {
  400: 'Google Analytics did not accept the report request: check the dimension and metric names and that they can be combined (check_compatibility)',
  403: 'Google Analytics refused the report: the connected Google account cannot read this property, or the Analytics Data API is not enabled in its Google Cloud project',
  404: 'Google Analytics found no such property',
};

/**
 * The property IDs a generic API request names: in its path, and in
 * "properties/<id>" inside its query values and its JSON body (the only body
 * api_request sends, so no body goes out unread).
 */
function propertiesNamed(request: ApiToolRequest): string[] {
  const ids = new Set<string>();
  request.segments.forEach((segment, index) => {
    const next = request.segments[index + 1];
    if (segment === 'properties' && next) ids.add(next.split(':')[0] as string);
  });
  const texts = [...Object.values(request.query).flat(), ...(request.json ? [JSON.stringify(request.json)] : [])];
  for (const text of texts) {
    for (const match of text.matchAll(/(?<![A-Za-z])properties\/([0-9]+)/g)) ids.add(match[1] as string);
  }
  return [...ids].filter(Boolean);
}

/**
 * api_request with a JSON body only. The Analytics APIs take nothing else, and
 * a body sent as text would reach them without the property check reading it.
 */
function jsonBodyOnly(tool: ToolDefinition): ToolDefinition {
  if (tool.name !== 'api_request') return tool;
  const properties = { ...tool.inputSchema.properties };
  delete properties['body'];
  delete properties['content_type'];
  properties['json'] = { type: 'object', description: 'A JSON object to send as the body.' };
  return {
    ...tool,
    description: tool.description.replace(' or another body (body and content_type)', ''),
    inputSchema: { ...tool.inputSchema, properties },
  };
}

/** Endpoints the generic tools keep out of reach: deleting a whole property or account, and user access management. */
function guardRequest(request: ApiToolRequest): void {
  if (!/^\/v1(alpha|beta)\//.test(request.path)) {
    throw new ToolFailure('The path must start with /v1beta/ or /v1alpha/, e.g. /v1beta/properties/123456789/keyEvents. Nothing was sent.');
  }
  if (request.method === 'GET') return;
  const segments = request.segments;
  if (segments.some((segment) => segment === 'accessBindings' || segment.startsWith('accessBindings:'))) {
    throw new ToolFailure('Changing who can access a Google Analytics account or property is not offered here: do it in Google Analytics, Admin, Access management. Nothing was sent.');
  }
  const whole = segments.length === 3 && (segments[1] === 'properties' || segments[1] === 'accounts');
  if (request.method === 'DELETE' && whole) {
    throw new ToolFailure('Deleting a whole Google Analytics property or account is not offered here: do it in Google Analytics, Admin. Nothing was sent.');
  }
}

async function runReport(args: ReportArgs, h: ToolHelpers): Promise<Record<string, unknown>> {
  const id = chosenProperty(h, args.property_id);
  const state = h.cursor(args.cursor);
  const offset = typeof state?.['o'] === 'number' ? state['o'] : (args.offset ?? 0);
  const body = compact({
    dateRanges: args.date_ranges.map((range) => compact({ startDate: range.start_date, endDate: range.end_date, name: range.name })),
    dimensions: names(args.dimensions, 'name'),
    metrics: names(args.metrics, 'name'),
    dimensionFilter: args.dimension_filter,
    metricFilter: args.metric_filter,
    orderBys: args.order_bys,
    limit: args.limit,
    offset: offset || undefined,
    keepEmptyRows: args.keep_empty_rows,
    currencyCode: args.currency_code,
    metricAggregations: args.metric_aggregations?.length ? args.metric_aggregations : undefined,
  });
  const { data } = await h.api({ method: 'POST', origin: DATA, path: `/v1beta/properties/${id}:runReport`, json: body, safe: true, errors: REPORT_ERRORS });
  const rows = flattenRows(data, data?.rows);
  const total = typeof data?.rowCount === 'number' ? data.rowCount : rows.length;
  return h.page({
    key: 'rows',
    items: rows,
    extra: { property_id: id, ...reportExtras(data) },
    resumeAt: (index) => h.makeCursor({ o: offset + index }),
    ...(rows.length && offset + rows.length < total ? { nextPage: h.makeCursor({ o: offset + rows.length }) } : {}),
  });
}

const connector = defineConnector({
  vendor: 'ga4',
  label: LABEL,
  origins: [DATA, ADMIN],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Google Analytics access token' },
  accountPickers: [
    {
      key: 'properties',
      label: 'Google Analytics properties',
      description: 'The GA4 properties the agent may report on and configure.',
      multiple: true,
      tool: 'list_properties',
      idField: 'id',
      nameField: 'name',
      legacyField: 'propertyid',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_properties',
      kind: 'read',
      title: 'List Google Analytics properties',
      description:
        'Lists the GA4 properties the connected Google account can open, with their account: property ID, name, account name and '
        + 'account ID, and property type. When the connection is limited to chosen properties, those are marked selected: true, and '
        + 'only they can be used. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const chosen = allowedAccounts(h.ctx.accounts, 'properties');
        const { data } = await h.api({ origin: ADMIN, path: '/v1beta/accountSummaries', query: { pageSize: 200, pageToken } });
        const properties: Record<string, unknown>[] = [];
        for (const account of Array.isArray(data?.accountSummaries) ? data.accountSummaries : []) {
          for (const summary of Array.isArray(account?.propertySummaries) ? account.propertySummaries : []) {
            const id = typeof summary?.property === 'string' ? propertyId(summary.property) : undefined;
            if (!id) continue;
            properties.push(compact({
              id,
              name: typeof summary?.displayName === 'string' ? truncate(summary.displayName, 200) : id,
              account: typeof account?.displayName === 'string' ? truncate(account.displayName, 200) : undefined,
              account_id: typeof account?.account === 'string' ? account.account.replace(/^accounts\//, '') : undefined,
              property_type: summary?.propertyType,
              selected: chosen?.includes(id) ? true : undefined,
            }));
          }
        }
        return h.page({
          key: 'properties',
          items: properties.slice(skip),
          extra: compact({
            note: chosen?.length === 0 ? 'No property is chosen for this connection yet, so every tool that names a property is refused until properties from this list are chosen for it.' : undefined,
          }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'run_report',
      kind: 'read',
      title: 'Run a Google Analytics report',
      description:
        'Runs a GA4 report on one property: metrics by dimensions over up to 4 date ranges, with filters, ordering and totals. Dates are '
        + 'YYYY-MM-DD or today, yesterday, NdaysAgo, in the property\'s time zone. Rows come back as objects keyed by dimension and metric '
        + 'names (money in the property\'s currency), with row_count, metadata (sampling, thresholding) and nextCursor while rows remain. '
        + 'It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: PROPERTY_ID,
          date_ranges: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            default: [{ start_date: '28daysAgo', end_date: 'yesterday' }],
            items: {
              type: 'object',
              properties: {
                start_date: { type: 'string', pattern: DATE, description: 'YYYY-MM-DD, today, yesterday or NdaysAgo.' },
                end_date: { type: 'string', pattern: DATE, description: 'YYYY-MM-DD, today, yesterday or NdaysAgo.' },
                name: { type: 'string', maxLength: 64, description: 'A name for the range, shown in the dateRange column.' },
              },
              required: ['start_date', 'end_date'],
              additionalProperties: false,
            },
            description: 'Date ranges, both ends included (default the last 28 days up to yesterday). Several ranges add a dateRange column.',
          },
          dimensions: DIMENSIONS,
          metrics: METRICS,
          dimension_filter: { type: 'object', description: FILTER_HELP },
          metric_filter: { type: 'object', description: `${FILTER_HELP} Metric filters use numericFilter, e.g. {"filter": {"fieldName": "sessions", "numericFilter": {"operation": "GREATER_THAN", "value": {"int64Value": "100"}}}}.` },
          order_bys: ORDER_BYS,
          limit: { type: 'integer', minimum: 1, maximum: 10000, default: 100, description: 'Rows per page, 1 to 10000 (default 100).' },
          offset: { type: 'integer', minimum: 0, description: 'The first row to return, counting from 0.' },
          keep_empty_rows: { type: 'boolean', description: 'Also return rows whose metrics are all 0.' },
          currency_code: { type: 'string', pattern: '^[A-Z]{3}$', description: 'An ISO 4217 code such as "USD" for money metrics (default the property\'s currency).' },
          metric_aggregations: AGGREGATIONS,
          cursor: CURSOR,
        },
        required: ['property_id', 'metrics'],
        additionalProperties: false,
      },
      run: (args: ReportArgs, h) => runReport(args, h),
    },
    {
      name: 'run_realtime_report',
      kind: 'read',
      title: 'Run a Google Analytics realtime report',
      description:
        'Runs a GA4 realtime report on one property: activity in the last 30 minutes (up to 60 on GA4 360), e.g. activeUsers by country or '
        + 'by unifiedScreenName. minute_ranges picks windows such as the last 5 minutes. Rows come back as objects keyed by dimension and '
        + 'metric names. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: PROPERTY_ID,
          dimensions: { ...DIMENSIONS, description: 'Realtime dimension names, e.g. ["country", "deviceCategory", "unifiedScreenName", "minutesAgo"].' },
          metrics: { ...METRICS, description: 'Realtime metric names, e.g. ["activeUsers", "eventCount", "keyEvents"].' },
          dimension_filter: { type: 'object', description: FILTER_HELP },
          metric_filter: { type: 'object', description: FILTER_HELP },
          order_bys: ORDER_BYS,
          limit: { type: 'integer', minimum: 1, maximum: 10000, default: 100, description: 'Rows to return, 1 to 10000 (default 100).' },
          metric_aggregations: AGGREGATIONS,
          minute_ranges: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              properties: {
                start_minutes_ago: { type: 'integer', minimum: 0, maximum: 59, description: 'Where the window starts, in minutes ago (default 29).' },
                end_minutes_ago: { type: 'integer', minimum: 0, maximum: 59, description: 'Where it ends, in minutes ago (default 0, now).' },
                name: { type: 'string', maxLength: 64 },
              },
              additionalProperties: false,
            },
            description: 'Up to 2 windows inside the last 30 minutes, e.g. [{"start_minutes_ago": 4, "end_minutes_ago": 0}].',
          },
          cursor: CURSOR,
        },
        required: ['property_id', 'metrics'],
        additionalProperties: false,
      },
      async run(args: RealtimeArgs, h) {
        const id = chosenProperty(h, args.property_id);
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const body = compact({
          dimensions: names(args.dimensions, 'name'),
          metrics: names(args.metrics, 'name'),
          dimensionFilter: args.dimension_filter,
          metricFilter: args.metric_filter,
          orderBys: args.order_bys,
          limit: args.limit,
          metricAggregations: args.metric_aggregations?.length ? args.metric_aggregations : undefined,
          minuteRanges: args.minute_ranges?.map((range) => compact({ startMinutesAgo: range.start_minutes_ago, endMinutesAgo: range.end_minutes_ago, name: range.name })),
        });
        const { data } = await h.api({ method: 'POST', origin: DATA, path: `/v1beta/properties/${id}:runRealtimeReport`, json: body, safe: true, errors: REPORT_ERRORS });
        return h.page({
          key: 'rows',
          items: flattenRows(data, data?.rows).slice(skip),
          extra: { property_id: id, ...reportExtras(data) },
          // Realtime numbers move between calls: a continuation runs the report again and skips the rows already returned.
          resumeAt: (index) => h.makeCursor({ s: skip + index }),
        });
      },
    },
    {
      name: 'batch_run_reports',
      kind: 'read',
      title: 'Run several Google Analytics reports',
      description:
        'Runs up to 5 GA4 reports on one property in one call, each a RunReportRequest in the API\'s own JSON (dateRanges, dimensions, '
        + 'metrics, dimensionFilter, orderBys, limit). A report without a limit gets 50 rows. Returns each report\'s rows as objects keyed '
        + 'by dimension and metric names. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: PROPERTY_ID,
          requests: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'object' },
            description: 'RunReportRequest objects, e.g. [{"dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}], "metrics": [{"name": "sessions"}]}].',
          },
        },
        required: ['property_id', 'requests'],
        additionalProperties: false,
      },
      async run(args: { property_id: string; requests: Record<string, unknown>[] }, h) {
        const id = chosenProperty(h, args.property_id);
        const requests = args.requests.map((request) => {
          const { property, ...rest } = request as Record<string, unknown>;
          if (property !== undefined && propertyId(String(property)) !== id) {
            throw new ToolFailure(`Each request must be for property ${id}, the one in property_id. Nothing was sent.`);
          }
          return { limit: 50, ...rest };
        });
        const { data } = await h.api({ method: 'POST', origin: DATA, path: `/v1beta/properties/${id}:batchRunReports`, json: { requests }, safe: true, errors: REPORT_ERRORS });
        const reports = (Array.isArray(data?.reports) ? data.reports : []).map((report: any) => ({ ...reportExtras(report), rows: flattenRows(report, report?.rows) }));
        // Several reports share the 32 KB: when they do not fit, each keeps its first rows.
        let share = 1;
        const cut = () => reports.map((report: { rows: unknown[] }) => (share < 1 ? { ...report, rows: report.rows.slice(0, Math.floor(report.rows.length * share)), rows_returned_of: report.rows.length } : report));
        while (share > 0.01 && jsonSize({ property_id: id, reports: cut() }) > OUTPUT_LIMIT_BYTES - 600) share *= 0.8;
        return share < 1
          ? { property_id: id, reports: cut(), truncated: true, note: 'The reports did not fit 32 KB together: each lists its first rows. Lower the limit of each request, or run them one by one with run_report.' }
          : { property_id: id, reports };
      },
    },
    {
      name: 'get_metadata',
      kind: 'read',
      title: 'List Google Analytics dimensions and metrics',
      description:
        'Lists the dimensions and metrics a GA4 property can report on, its custom definitions included: API name (for run_report), UI '
        + 'name, category and, for metrics, the type. Filter by kind, a search text, or custom ones only. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: PROPERTY_ID,
          kind: { type: 'string', enum: ['all', 'dimensions', 'metrics'], default: 'all', description: 'all (default), dimensions or metrics.' },
          search: { type: 'string', minLength: 1, maxLength: 100, description: 'Only names or categories containing this text, ignoring case, e.g. "revenue".' },
          custom_only: { type: 'boolean', description: 'Only the property\'s custom dimensions and metrics.' },
          cursor: CURSOR,
        },
        required: ['property_id'],
        additionalProperties: false,
      },
      async run(args: { property_id: string; kind: string; search?: string; custom_only?: boolean; cursor?: string }, h) {
        const id = chosenProperty(h, args.property_id);
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ origin: DATA, path: `/v1beta/properties/${id}/metadata`, errors: { 404: REPORT_ERRORS[404] } });
        const needle = args.search?.toLowerCase();
        const items: Record<string, unknown>[] = [];
        const add = (kind: 'dimension' | 'metric', list: unknown) => {
          for (const item of Array.isArray(list) ? list : []) {
            const entry = compact({
              kind,
              api_name: item?.apiName,
              ui_name: item?.uiName,
              category: item?.category,
              type: kind === 'metric' ? item?.type : undefined,
              custom: item?.customDefinition === true ? true : undefined,
              description: typeof item?.description === 'string' ? truncate(item.description, 160) : undefined,
            });
            if (args.custom_only && !entry['custom']) continue;
            if (needle && ![entry['api_name'], entry['ui_name'], entry['category']].some((value) => String(value ?? '').toLowerCase().includes(needle))) continue;
            items.push(entry);
          }
        };
        if (args.kind !== 'metrics') add('dimension', data?.dimensions);
        if (args.kind !== 'dimensions') add('metric', data?.metrics);
        return h.page({
          key: 'fields',
          items: items.slice(skip),
          extra: { property_id: id, total: items.length },
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'check_compatibility',
      kind: 'read',
      title: 'Check Google Analytics dimension and metric compatibility',
      description:
        'Tells whether dimensions and metrics can go in one GA4 report on a property, the usual cause of a refused report. By default '
        + 'it answers for the ones given; list "compatible" or "incompatible" instead lists every field of the property that can or cannot '
        + 'join them. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          property_id: PROPERTY_ID,
          dimensions: { ...DIMENSIONS, maxItems: 20 },
          metrics: { ...METRICS, minItems: 0, maxItems: 20 },
          dimension_filter: { type: 'object', description: FILTER_HELP },
          metric_filter: { type: 'object', description: FILTER_HELP },
          list: {
            type: 'string',
            enum: ['requested', 'compatible', 'incompatible'],
            default: 'requested',
            description: 'requested (default): the fields given; compatible or incompatible: every field of the property with that answer.',
          },
          cursor: CURSOR,
        },
        required: ['property_id'],
        additionalProperties: false,
      },
      async run(args: { property_id: string; dimensions?: string[]; metrics?: string[]; dimension_filter?: Record<string, unknown>; metric_filter?: Record<string, unknown>; list: string; cursor?: string }, h) {
        const id = chosenProperty(h, args.property_id);
        if (!args.dimensions?.length && !args.metrics?.length) {
          throw new ToolFailure('Give at least one dimension or metric to check. Nothing was sent.');
        }
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const body = compact({
          dimensions: names(args.dimensions, 'name'),
          metrics: names(args.metrics, 'name'),
          dimensionFilter: args.dimension_filter,
          metricFilter: args.metric_filter,
          compatibilityFilter: args.list === 'compatible' ? 'COMPATIBLE' : args.list === 'incompatible' ? 'INCOMPATIBLE' : undefined,
        });
        const { data } = await h.api({ method: 'POST', origin: DATA, path: `/v1beta/properties/${id}:checkCompatibility`, json: body, safe: true, errors: REPORT_ERRORS });
        const wanted = new Set([...(args.dimensions ?? []), ...(args.metrics ?? [])]);
        const fields: Record<string, unknown>[] = [];
        const add = (kind: 'dimension' | 'metric', list: unknown, key: 'dimensionMetadata' | 'metricMetadata') => {
          for (const item of Array.isArray(list) ? list : []) {
            const name = item?.[key]?.apiName;
            if (args.list === 'requested' && !wanted.has(name)) continue;
            fields.push(compact({ kind, name, compatibility: item?.compatibility }));
          }
        };
        add('dimension', data?.dimensionCompatibilities, 'dimensionMetadata');
        add('metric', data?.metricCompatibilities, 'metricMetadata');
        return h.page({
          key: 'fields',
          items: fields.slice(skip),
          extra: compact({
            property_id: id,
            all_compatible: args.list === 'requested' ? fields.every((field) => field['compatibility'] === 'COMPATIBLE') : undefined,
          }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    // The rest of the Admin API (property settings, key events, custom dimensions
    // and metrics, data streams, Google Ads links, audiences) and of the Data API.
    ...apiTools({
      label: LABEL,
      description:
        `The Google Analytics Admin and Data APIs with the connected account. Origin ${ADMIN} serves property settings at `
        + '/v1beta/properties/{property_id} and its keyEvents, customDimensions, customMetrics, dataStreams and googleAdsLinks, and audiences '
        + `at /v1alpha/properties/{property_id}/audiences. The default origin ${DATA} is the Data API, whose reports have their own tools. `
        + 'Paths name the property. Reference: https://developers.google.com/analytics/devguides/config/admin/v1/rest.',
      methods: ['POST', 'PATCH', 'DELETE'],
      originArgument: `The API origin: ${DATA} (default, the Data API) or ${ADMIN} (settings).`,
      accounts: { key: 'properties', label: 'property ID', ids: propertiesNamed },
      guard: (request) => guardRequest(request),
    }).map(jsonBodyOnly),
  ],
});

export = connector;
