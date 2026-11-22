// Roasit, through its report API at https://roasit.com/api: mobile
// attribution numbers for the apps of a Roasit account. Installs, spend,
// cohort revenue, ROAS and retention by network, campaign, ad group and
// creative, iOS SKAdNetwork, install reconciliation and data freshness, as
// the Roasit dashboard's Reports screen shows them.
//
// Credential: `apitoken`, a Roasit API token (roapi_...), from Roasit ->
// Account -> API tokens. It is read-only: it sees the apps the account sees,
// and Roasit answers any method but GET with 403. It goes in the
// Authorization: Bearer header to https://roasit.com only.
//
// The apps picker (key "apps", Roasit's 12-character app tokens) limits every
// app-level read to the apps chosen for the connection.

import { apiTools, defineConnector, jsonSize, OUTPUT_LIMIT_BYTES, requireAccounts, truncate, type ApiToolRequest, type ToolHelpers } from '../../core/index.js';

const ORIGIN = 'https://roasit.com';
const MAX_ROWS = 1000;
/** Room kept under the output limit for the fields a cut result adds. */
const ROOM = 800;

const ERRORS = {
  400: 'Roasit did not accept the request: an unknown metric, a metric not allowed with these dimensions or filters, an unknown network slug, a campaign, ad group or ad the app does not have, two values that select the same rows, or bad dates',
  401: 'Roasit rejected the API token: it was revoked or mistyped. Create a new one on the Account page',
  403: 'Roasit does not open this route to API tokens',
  404: 'Roasit found no such app: the app token is wrong, or the account behind the token cannot see that app',
};

const APP_TOKEN = { type: 'string' as const, pattern: '^[0-9a-f]{12}$', description: 'The app token, 12 lower-case hex characters, from list_apps.' };
const DATE = { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const VALUES = (description: string, pattern = '^[^,]{1,200}$') => ({
  type: 'array' as const,
  items: { type: 'string' as const, pattern },
  minItems: 1,
  maxItems: 50,
  uniqueItems: true,
  description,
});

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function requireApp(h: ToolHelpers, appToken: string): void {
  requireAccounts(h.ctx.accounts, 'apps', appToken, 'app');
}

async function get(h: ToolHelpers, path: string, query?: Record<string, string | number | undefined>): Promise<any> {
  const { data } = await h.api({ path, errors: ERRORS, ...(query ? { query } : {}) });
  return data;
}

function skipOf(h: ToolHelpers, cursor: string | undefined): number {
  const state = h.cursor(cursor);
  return typeof state?.['o'] === 'number' ? state['o'] : 0;
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

/**
 * A reply of unknown shape that must fit 32 KB: its longest lists are halved
 * until it does, and the result says which lists were cut and how long they
 * were.
 */
function fitLists(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || jsonSize(data) <= OUTPUT_LIMIT_BYTES - ROOM) return data;
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown> | unknown[];
  const lengths = new Map<string, number>();
  const lists = (): Array<{ path: string; holder: any; key: string | number; list: unknown[] }> => {
    const found: Array<{ path: string; holder: any; key: string | number; list: unknown[] }> = [];
    const visit = (value: any, path: string, depth: number): void => {
      if (depth > 2 || typeof value !== 'object' || value === null) return;
      for (const [key, item] of Object.entries(value)) {
        const here = path ? `${path}.${key}` : key;
        if (Array.isArray(item)) found.push({ path: here, holder: value, key, list: item });
        else visit(item, here, depth + 1);
      }
    };
    if (Array.isArray(copy)) found.push({ path: 'items', holder: { items: copy }, key: 'items', list: copy });
    else visit(copy, '', 0);
    return found;
  };
  for (let round = 0; round < 40 && jsonSize(copy) > OUTPUT_LIMIT_BYTES - ROOM; round++) {
    const longest = lists().sort((a, b) => jsonSize(b.list) - jsonSize(a.list))[0];
    if (!longest || longest.list.length <= 1) break;
    if (!lengths.has(longest.path)) lengths.set(longest.path, longest.list.length);
    longest.list.length = Math.floor(longest.list.length / 2);
  }
  const cut = [...lengths.entries()].map(([path, total]) => `${path} (${total})`).join(', ');
  return {
    ...(Array.isArray(copy) ? { items: copy } : copy),
    truncated: true,
    note: `Long lists were cut to fit 32 KB: ${cut}. Narrow the request, or read the rest with api_get.`,
  };
}

/** The app tokens a generic request names, for the account lock: /api/apps/<token>/... or app_token in the query. */
function requestApps(request: ApiToolRequest): string[] {
  const [, collection, token] = request.segments;
  const ids: string[] = [];
  if (collection === 'apps' && token) ids.push(token);
  for (const value of request.query['app_token'] ?? []) ids.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
  return ids;
}

function trimApp(app: any): Record<string, unknown> {
  return compact({
    app_token: app?.app_token,
    name: app?.name,
    reportingCurrency: app?.reporting_currency,
    platforms: Array.isArray(app?.platforms) ? app.platforms : undefined,
    androidPackage: app?.package_android,
    iosBundle: app?.bundle_ios,
    appleAppId: app?.apple_app_id,
    createdAt: app?.created_at,
  });
}

const connector = defineConnector({
  vendor: 'roasit',
  label: 'Roasit',
  origins: [ORIGIN],
  credentials: ['apitoken'],
  credentialLabels: { apitoken: 'Roasit API token' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['apitoken']}` }),
  accountPickers: [
    {
      key: 'apps',
      label: 'Roasit apps',
      description: 'The apps the agent may report on.',
      multiple: true,
      tool: 'list_apps',
      idField: 'app_token',
      nameField: 'name',
      legacyField: 'apps',
    },
  ],
  tools: [
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get the Roasit account',
      description: 'Who the token is: the Roasit account behind it (access_all true means it sees every app) and the token\'s own name and prefix.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const data = await get(h, '/api/me');
        return compact({
          id: data?.id,
          name: data?.name,
          email: data?.email,
          accessAll: data?.access_all,
          token: data?.token && typeof data.token === 'object' ? compact({ id: data.token.id, name: data.token.name, prefix: data.token.prefix }) : undefined,
        });
      },
    },
    {
      name: 'list_apps',
      kind: 'read',
      title: 'List Roasit apps',
      description:
        'Lists the apps the token can see: app token (the id every report takes), name, reporting currency, platforms (ios, android, web) and the '
        + 'store ids (iOS bundle and Apple ID, Android package). Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const data = await get(h, '/api/apps');
        const apps: any[] = Array.isArray(data) ? data : Array.isArray(data?.apps) ? data.apps : [];
        return offsetPage(h, 'apps', apps.map(trimApp), skipOf(h, args.cursor), MAX_ROWS, {});
      },
    },
    {
      name: 'get_report',
      kind: 'read',
      title: 'Get a Roasit report',
      description:
        "One app's report, equal to the Roasit dashboard's Reports screen: rows by the dimensions with the metrics asked for, totals (ratios of sums: "
        + 'quote them), the currency, notes, days whose spend is not final, and how deep each network\'s spend goes. null means not available yet, never '
        + 'zero. Creative ROAS, for example: dimensions network, campaign, ad and metrics installs, spend, cpi, rev_all, roas_all, sorted -spend. Keep '
        + 'platform for a one-platform view. Rows come in pages: pass nextCursor back as cursor with the same other arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          app_token: APP_TOKEN,
          from: { ...DATE, description: 'The first UTC install day, YYYY-MM-DD (at most 366 days before to).' },
          to: { ...DATE, description: 'The last UTC install day, YYYY-MM-DD; reports usually end yesterday.' },
          dimensions: {
            type: 'array',
            items: { type: 'string', enum: ['day', 'platform', 'country', 'network', 'campaign', 'adgroup', 'ad'] },
            minItems: 1,
            uniqueItems: true,
            description: 'Grouping (default day); leave day out to sum the whole period.',
          },
          metrics: VALUES('Metric ids, e.g. ["installs", "spend", "cpi", "rev_all", "roas_all", "roas_7", "ret_1", "ret_7"]; list_metrics has them all.', '^[a-z0-9_]{1,64}$'),
          platform: VALUES('Only these platforms: ios, android, web.', '^(ios|android|web|other|unknown)$'),
          country: VALUES('Only these ISO country codes.', '^[A-Za-z]{2}$'),
          network: VALUES('Only these network slugs, e.g. ["meta", "google"] (list_networks has them).', '^[a-z0-9_]{1,64}$'),
          campaign: VALUES('Only these campaign names (exact, from list_dimension_values).'),
          adgroup: VALUES('Only these ad group names (exact).'),
          ad: VALUES('Only these ad names (exact).'),
          campaign_id: VALUES('Only these ad network campaign ids.'),
          adgroup_id: VALUES('Only these ad network ad group ids.'),
          ad_id: VALUES('Only these ad network ad or creative ids.'),
          iap: { type: 'string', enum: ['net', 'gross'], description: 'In-app revenue net of store commission (default, like the dashboard) or gross.' },
          sort: { type: 'string', pattern: '^-?[a-z0-9_]{1,64}$', description: 'A metric to sort by, - for descending, e.g. -spend.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: 200, description: `Rows per page, 1 to ${MAX_ROWS} (default 200).` },
          cursor: CURSOR,
        },
        required: ['app_token', 'from', 'to'],
        additionalProperties: false,
      },
      async run(args: {
        app_token: string; from: string; to: string; dimensions?: string[]; metrics?: string[]; platform?: string[]; country?: string[]; network?: string[];
        campaign?: string[]; adgroup?: string[]; ad?: string[]; campaign_id?: string[]; adgroup_id?: string[]; ad_id?: string[]; iap?: string; sort?: string;
        limit: number; cursor?: string;
      }, h) {
        requireApp(h, args.app_token);
        const skip = skipOf(h, args.cursor);
        const list = (values: string[] | undefined): string | undefined => values?.join(',');
        const data = await get(h, '/api/report', {
          app_token: args.app_token,
          from: args.from,
          to: args.to,
          dimensions: list(args.dimensions),
          metrics: list(args.metrics),
          platform: list(args.platform),
          country: list(args.country),
          network: list(args.network),
          campaign: list(args.campaign),
          adgroup: list(args.adgroup),
          ad: list(args.ad),
          campaign_id: list(args.campaign_id),
          adgroup_id: list(args.adgroup_id),
          ad_id: list(args.ad_id),
          iap: args.iap,
          sort: args.sort,
          // Roasit's own cap; the rows still come in pages of limit here.
          limit: MAX_ROWS,
        });
        const rows: unknown[] = Array.isArray(data?.rows) ? data.rows : [];
        return offsetPage(h, 'rows', rows, skip, args.limit, compact({
          app: data?.app,
          from: data?.from,
          to: data?.to,
          currency: data?.currency,
          iap: data?.iap,
          dimensions: data?.dimensions,
          metrics: Array.isArray(data?.metrics)
            ? data.metrics.map((metric: any) => compact({ id: metric?.id, label: metric?.label, kind: metric?.kind, desc: typeof metric?.desc === 'string' ? truncate(metric.desc, 200) : undefined }))
            : undefined,
          rowsTotal: data?.rows_total,
          totals: data?.totals,
          lines: Array.isArray(data?.lines) && data.lines.length ? data.lines : undefined,
          spendNotFinalDays: Array.isArray(data?.spend_not_final_days) && data.spend_not_final_days.length ? data.spend_not_final_days : undefined,
          spendGranularity: data?.spend_granularity,
          notes: Array.isArray(data?.notes) && data.notes.length ? data.notes : undefined,
          rowsCap: typeof data?.rows_total === 'number' && data.rows_total > rows.length
            ? `Roasit returns at most ${MAX_ROWS} rows; the report has ${data.rows_total}. Sort it or narrow the filters to see the rest; totals cover every row.`
            : undefined,
        }));
      },
    },
    {
      name: 'list_metrics',
      kind: 'read',
      title: 'List Roasit report metrics',
      description:
        'The metric catalogue of get_report: each metric\'s id, label, kind (int, money, money_signed, pct, num), group, description, and the dimensions '
        + 'and filters it is allowed with. Check it before combining a metric with a breakdown. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const data = await get(h, '/api/report/metrics');
        const metrics: any[] = Array.isArray(data) ? data : Array.isArray(data?.metrics) ? data.metrics : [];
        return offsetPage(h, 'metrics', metrics.map((metric) => compact({
          id: metric?.id,
          label: metric?.label,
          kind: metric?.kind,
          group: metric?.group,
          desc: typeof metric?.desc === 'string' ? truncate(metric.desc, 300) : undefined,
          dimensions: metric?.dimensions,
          filters: metric?.filters,
        })), skipOf(h, args.cursor), MAX_ROWS, {});
      },
    },
    {
      name: 'list_networks',
      kind: 'read',
      title: 'List Roasit networks',
      description: 'The network slugs a report uses (meta, google, tiktok, applovin, apple_search_ads, organic, untrusted, ...) with labels and whether each is paid; with app_token, also that app\'s own network values.',
      inputSchema: { type: 'object', properties: { app_token: APP_TOKEN }, additionalProperties: false },
      async run(args: { app_token?: string }, h) {
        if (args.app_token) requireApp(h, args.app_token);
        const data = await get(h, '/api/report/networks', { app_token: args.app_token });
        const networks: any[] = Array.isArray(data?.networks) ? data.networks : [];
        return { networks: networks.map((network) => compact({ slug: network?.slug, label: network?.label, paid: network?.paid })) };
      },
    },
    {
      name: 'get_skan_report',
      kind: 'read',
      title: 'Get a Roasit SKAdNetwork report',
      description:
        "An app's iOS SKAdNetwork numbers: postback status (last verified is the proof SKAN works), rows by day and network with installs, redownloads, "
        + 'installs with a conversion value, estimated revenue, coarse values, spend, CPI and ROAS, and the SKAN sources not mapped to a campaign yet. '
        + 'Postbacks arrive 24 to 72 hours late; never add SKAN installs to report installs. Rows come in pages.',
      inputSchema: {
        type: 'object',
        properties: {
          app_token: APP_TOKEN,
          from: { ...DATE, description: 'The first day (default: 30 days ago).' },
          to: { ...DATE, description: 'The last day.' },
          network: { type: 'string', pattern: '^[a-z0-9_]{1,64}$', description: 'Only this SKAN network slug.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: 200, description: `Rows per page, 1 to ${MAX_ROWS} (default 200).` },
          cursor: CURSOR,
        },
        required: ['app_token'],
        additionalProperties: false,
      },
      async run(args: { app_token: string; from?: string; to?: string; network?: string; limit: number; cursor?: string }, h) {
        requireApp(h, args.app_token);
        const data = await get(h, `/api/apps/${args.app_token}/skan`, { from: args.from, to: args.to, network: args.network });
        const rows: unknown[] = Array.isArray(data?.rows) ? data.rows : [];
        return offsetPage(h, 'rows', rows, skipOf(h, args.cursor), args.limit, compact({
          appToken: args.app_token,
          status: data?.status,
          currency: data?.currency,
          unmapped: Array.isArray(data?.unmapped) && data.unmapped.length ? data.unmapped.slice(0, 100) : undefined,
        }));
      },
    },
    {
      name: 'get_reconciliation',
      kind: 'read',
      title: 'Get Roasit install reconciliation',
      description:
        'The attribution audit for an app on iOS or Android: the installs the store counted, the installs each network claimed, and their ratio (above 1, '
        + 'the networks together claim more installs than happened). comparable false means draw no conclusion. Web has none. Ends yesterday by default.',
      inputSchema: {
        type: 'object',
        properties: {
          app_token: APP_TOKEN,
          platform: { type: 'string', enum: ['ios', 'android'], description: 'The platform.' },
          from: { ...DATE, description: 'The first day.' },
          to: { ...DATE, description: 'The last day.' },
        },
        required: ['app_token', 'platform'],
        additionalProperties: false,
      },
      async run(args: { app_token: string; platform: string; from?: string; to?: string }, h) {
        requireApp(h, args.app_token);
        return fitLists(await get(h, `/api/apps/${args.app_token}/reconciliation`, { platform: args.platform, from: args.from, to: args.to }));
      },
    },
    {
      name: 'get_data_freshness',
      kind: 'read',
      title: 'Get Roasit data freshness',
      description:
        "Whether an app's Roasit data is current: the last nightly pull and its errors per source (a failing spend or revenue pull makes that source's "
        + 'numbers stale), events in the last 24 hours and whether the SDK still sends, the last verified SKAN postback, and for a web app its browser '
        + 'SDK and Stripe sales.',
      inputSchema: { type: 'object', properties: { app_token: APP_TOKEN }, required: ['app_token'], additionalProperties: false },
      async run(args: { app_token: string }, h) {
        requireApp(h, args.app_token);
        return fitLists(await get(h, `/api/apps/${args.app_token}/connections`));
      },
    },
    {
      name: 'list_dimension_values',
      kind: 'read',
      title: 'List an app\'s Roasit filter values',
      description: "The exact values get_report's filters take for an app: its networks, campaigns, ad groups and ads (a name the app does not have is refused).",
      inputSchema: { type: 'object', properties: { app_token: APP_TOKEN }, required: ['app_token'], additionalProperties: false },
      async run(args: { app_token: string }, h) {
        requireApp(h, args.app_token);
        return fitLists(await get(h, `/api/apps/${args.app_token}/dimensions`));
      },
    },
    {
      name: 'list_events',
      kind: 'read',
      title: 'List an app\'s Roasit events',
      description: "An app's SDK event catalogue and its conversion mapping to Meta, TikTok and Google: is the purchase event still arriving?",
      inputSchema: { type: 'object', properties: { app_token: APP_TOKEN }, required: ['app_token'], additionalProperties: false },
      async run(args: { app_token: string }, h) {
        requireApp(h, args.app_token);
        return fitLists(await get(h, `/api/apps/${args.app_token}/events`));
      },
    },
    // Only api_get: the token can make GET calls only. Under an account lock a
    // request must name a chosen app.
    ...apiTools({
      label: 'Roasit',
      description:
        'The Roasit API at https://roasit.com/api, with the connected read-only token: paths start with /api/, such as /api/report (app_token in query) '
        + 'or /api/apps/<app_token>/connections. Under an account lock a request must name a chosen app in the path (/api/apps/<app_token>/...) or in '
        + 'app_token.',
      basePath: '/api/',
      accounts: { key: 'apps', label: 'app', ids: requestApps },
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

export = connector;
