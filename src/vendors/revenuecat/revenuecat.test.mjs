import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const KEY = 'sk_TESTKEYabcdefghijklmnopqrstuv';
const credentials = { apikey: KEY };
const PROJECT = 'proj1ab2c3d4';

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts: null, fetch });
  return { module, fetch, ctx, logs };
}

function routes(table) {
  return (request) => {
    const handler = table[request.path];
    return handler ? handler(request) : jsonResponse(404, { type: 'resource_missing', message: `not routed: ${request.path}` });
  };
}

test('list_projects sends the key as a Bearer token to api.revenuecat.com and trims each project', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'projects.json')));
  const { payload, isError } = await callTool(module, 'list_projects', {}, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].url, 'https://api.revenuecat.com/v2/projects?limit=100');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(payload, { projects: [{ id: PROJECT, name: 'Acme Photo', createdAt: 1658399423658 }] });
});

test('without project_id the only project is used; several projects are listed back', async () => {
  const { module, fetch, ctx } = setup(routes({
    '/v2/projects': () => jsonResponse(200, fixture(import.meta.url, 'projects.json')),
    [`/v2/projects/${PROJECT}/apps`]: () => jsonResponse(200, fixture(import.meta.url, 'apps.json')),
  }));
  const { payload } = await callTool(module, 'list_apps', {}, ctx);
  assert.deepEqual(fetch.calls.map((call) => call.path), ['/v2/projects', `/v2/projects/${PROJECT}/apps`]);
  assert.equal(payload.projectId, PROJECT);
  assert.deepEqual(payload.apps, [
    { id: 'app1a2b3c4', name: 'Acme Photo iOS', type: 'app_store', bundleId: 'com.example.photo', createdAt: 1658399423658 },
    { id: 'app1a2b3c5', name: 'Acme Photo Android', type: 'play_store', packageName: 'com.example.photo', createdAt: 1658399423700 },
  ]);
  await callTool(module, 'list_apps', { project_id: PROJECT, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[2].query.starting_after, 'app1a2b3c5');
  assert.equal(fetch.calls.length, 3, 'a given project_id needs no lookup');

  const several = setup(() => jsonResponse(200, { items: [{ id: 'projA', name: 'A' }, { id: 'projB', name: 'B' }] }));
  const refused = await callTool(several.module, 'get_overview', {}, several.ctx);
  assert.match(refused.payload.error, /^The RevenueCat API key sees several projects: pass project_id, one of projA \(A\), projB \(B\)\.$/);
  assert.equal(several.fetch.calls.length, 1);
});

test('get_overview returns the cards with their periods and update times', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'overview.json')));
  const { payload } = await callTool(module, 'get_overview', { project_id: PROJECT, currency: 'EUR' }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.revenuecat.com/v2/projects/${PROJECT}/metrics/overview?currency=EUR`);
  assert.equal(payload.currency, 'USD');
  assert.deepEqual(payload.metrics[2], { id: 'mrr', name: 'MRR', value: 184233.5, unit: '$', period: 'P28D', description: 'Monthly Recurring Revenue', lastUpdatedAt: '2026-11-21T16:00:00Z' });
});

test('get_revenue sends the range and revenue type', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'revenue.json')));
  const { payload } = await callTool(module, 'get_revenue', { project_id: PROJECT, start_date: '2026-10-01', end_date: '2026-10-31', revenue_type: 'proceeds' }, ctx);
  assert.deepEqual(fetch.calls[0].query, { start_date: '2026-10-01', end_date: '2026-10-31', revenue_type: 'proceeds' });
  assert.deepEqual(payload, { projectId: PROJECT, startDate: '2026-10-01', endDate: '2026-10-31', revenueType: 'proceeds', currency: 'USD', value: 212034.77 });
  const backwards = await callTool(module, 'get_revenue', { project_id: PROJECT, start_date: '2026-10-31', end_date: '2026-10-01' }, ctx);
  assert.match(backwards.payload.error, /start_date must not be after end_date/);
  assert.equal(fetch.calls.length, 1);
});

test('get_chart_options lists resolutions, segments, filters and selectors', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'chart-options.json')));
  const { payload } = await callTool(module, 'get_chart_options', { project_id: PROJECT, chart_name: 'revenue' }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.revenuecat.com/v2/projects/${PROJECT}/charts/revenue/options?realtime=true`);
  assert.deepEqual(payload.resolutions[2], { id: '2', displayName: 'Month' });
  assert.deepEqual(payload.filters[0].options, [{ id: 'app_store', displayName: 'App Store' }, { id: 'play_store', displayName: 'Play Store' }]);
  assert.equal(payload.filters[1].valueMode, 'inferred_standard');
  assert.equal(payload.userSelectors.revenue_type.default, 'revenue');
});

test('get_chart_options leaves out the values of the largest filters when they do not fit, and lists one filter\'s values in pages', async () => {
  const options = fixture(import.meta.url, 'chart-options.json');
  options.filters.push({
    object: 'chart_filter',
    id: 'product',
    display_name: 'Product',
    group_display_name: 'Product',
    value_mode: 'dynamic',
    options: Array.from({ length: 1500 }, (_, index) => ({ id: `com.example.app.product_${String(index).padStart(4, '0')}`, display_name: `Product number ${index} with a long display name` })),
  });
  const { module, fetch, ctx } = setup(() => jsonResponse(200, options));
  const overview = await callTool(module, 'get_chart_options', { project_id: PROJECT, chart_name: 'revenue' }, ctx);
  assert.equal(overview.isError, false);
  assert.ok(textBytes(overview.result) <= 32 * 1024);
  const product = overview.payload.filters.find((filter) => filter.id === 'product');
  assert.deepEqual(product, { id: 'product', displayName: 'Product', group: 'Product', valueMode: 'dynamic', optionCount: 1500 });
  assert.deepEqual(overview.payload.filters[0].options, [{ id: 'app_store', displayName: 'App Store' }, { id: 'play_store', displayName: 'Play Store' }], 'small filters keep their values');
  assert.deepEqual(overview.payload.notes, ['The values of product are left out to fit: pass filter_id to list them.']);

  const seen = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const { payload, result } = await callTool(module, 'get_chart_options', { project_id: PROJECT, chart_name: 'revenue', filter_id: 'product', ...(cursor ? { cursor } : {}) }, ctx);
    assert.ok(textBytes(result) <= 32 * 1024);
    assert.equal(payload.filter.optionCount, 1500);
    seen.push(...payload.options.map((option) => option.id));
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 1500);
  assert.equal(new Set(seen).size, 1500);
  assert.equal(seen[1499], 'com.example.app.product_1499');

  const unknown = await callTool(module, 'get_chart_options', { project_id: PROJECT, chart_name: 'revenue', filter_id: 'nope' }, ctx);
  assert.match(unknown.payload.error, /^The revenue chart has no filter nope\. Its filters: store, country, product\.$/);
  assert.ok(fetch.calls.every((call) => call.path === `/v2/projects/${PROJECT}/charts/revenue/options`));
});

test('a chart that sends its points as arrays of numbers keeps them as they came (realtime false)', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'chart-arrays.json')));
  const { payload, isError } = await callTool(module, 'get_chart', { project_id: PROJECT, chart_name: 'actives', realtime: false }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].query.realtime, 'false');
  assert.deepEqual(payload.values, [[1759276800, 15230], [1761955200, 15912], [1764547200, null]]);
  assert.deepEqual(payload.summary, { average: { 'Active Subscriptions': 15571 } });
});

test('get_chart encodes filters and selectors as JSON, and returns measures, summary and dated points', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'chart.json')));
  const { payload } = await callTool(module, 'get_chart', {
    project_id: PROJECT,
    chart_name: 'revenue',
    start_date: '2026-10-01',
    end_date: '2026-11-30',
    resolution: '2',
    filters: [{ name: 'store', values: ['app_store'] }],
    selectors: { revenue_type: 'proceeds' },
    segment: 'country',
    limit_num_segments: 5,
  }, ctx);
  const { query } = fetch.calls[0];
  assert.equal(query.realtime, 'true');
  assert.equal(query.resolution, '2');
  assert.deepEqual(JSON.parse(query.filters), [{ name: 'store', values: ['app_store'] }]);
  assert.deepEqual(JSON.parse(query.selectors), { revenue_type: 'proceeds' });
  assert.equal(query.segment, 'country');
  assert.equal(query.limit_num_segments, '5');
  assert.equal(payload.currency, 'USD');
  assert.deepEqual(payload.measures, [
    { index: 0, displayName: 'Revenue', unit: '$', description: 'Revenue' },
    { index: 1, displayName: 'Transactions', unit: '#', description: 'Transactions' },
  ]);
  assert.deepEqual(payload.summary.total, { Revenue: 169000.75, Transactions: 18014 });
  assert.deepEqual(payload.values[0], { date: '2025-10-01', cohort: 1759276800, measure: 0, value: 98000.5, incomplete: false });
  assert.equal(payload.values[3].incomplete, true);
  assert.equal('documentation_link' in payload, false);

  const badSelector = await callTool(module, 'get_chart', { project_id: PROJECT, chart_name: 'revenue', selectors: { revenue_type: { a: 1 } } }, ctx);
  assert.match(badSelector.payload.error, /selectors\.revenue_type must be an option id/);
  const commaValue = await callTool(module, 'get_chart', { project_id: PROJECT, chart_name: 'revenue', filters: [{ name: 'store', values: ['a,b'] }] }, ctx);
  assert.match(commaValue.payload.error, /does not have the expected format/);
  assert.equal(fetch.calls.length, 1);
});

test('a chart with many points is cut to fit and continues where it stopped', async () => {
  const chart = fixture(import.meta.url, 'chart.json');
  chart.values = Array.from({ length: 2000 }, (_, index) => ({ cohort: 1700000000 + index * 86400, measure: index % 2, value: index * 1.5, incomplete: false }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, chart));
  const first = await callTool(module, 'get_chart', { project_id: PROJECT, chart_name: 'revenue' }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.values.length;
  const second = await callTool(module, 'get_chart', { project_id: PROJECT, chart_name: 'revenue', cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.values[0].value, shown * 1.5);
  assert.equal(fetch.calls.length, 2);
});

test('products, offerings and entitlements are trimmed; an offering comes with its packages', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`/v2/projects/${PROJECT}/products`]: () => jsonResponse(200, fixture(import.meta.url, 'products.json')),
    [`/v2/projects/${PROJECT}/offerings/ofrnge1a2b3c4d5`]: () => jsonResponse(200, fixture(import.meta.url, 'offering.json')),
    [`/v2/projects/${PROJECT}/entitlements`]: () => jsonResponse(200, { items: [{ object: 'entitlement', id: 'entla1b2c3d4e5', lookup_key: 'pro', display_name: 'Pro', state: 'active', created_at: 1 }], next_page: null }),
    [`/v2/projects/${PROJECT}/entitlements/entla1b2c3d4e5/products`]: () => jsonResponse(200, fixture(import.meta.url, 'products.json')),
  }));
  const products = await callTool(module, 'list_products', { project_id: PROJECT, app_id: 'app1a2b3c4' }, ctx);
  assert.equal(fetch.calls[0].query.app_id, 'app1a2b3c4');
  assert.deepEqual(products.payload.products[0], {
    id: 'prod1a2b3c4d5',
    storeIdentifier: 'com.example.photo.pro.weekly',
    type: 'subscription',
    displayName: 'Pro Weekly',
    appId: 'app1a2b3c4',
    state: 'active',
    duration: 'P1W',
    trialDuration: 'P3D',
    gracePeriodDuration: 'P3D',
    createdAt: 1658399423658,
  });
  const offering = await callTool(module, 'get_offering', { project_id: PROJECT, offering_id: 'ofrnge1a2b3c4d5' }, ctx);
  assert.equal(fetch.calls[1].query.expand, 'package.product');
  assert.equal(offering.payload.offering.isCurrent, true);
  assert.equal(offering.payload.offering.packages[0].products[0].storeIdentifier, 'com.example.photo.pro.weekly');
  assert.equal(offering.payload.offering.packages[0].products[0].eligibility, 'all');
  assert.equal('metadata' in offering.payload.offering, false);
  const entitlements = await callTool(module, 'list_entitlements', { project_id: PROJECT }, ctx);
  assert.deepEqual(entitlements.payload.entitlements, [{ id: 'entla1b2c3d4e5', lookupKey: 'pro', displayName: 'Pro', state: 'active', createdAt: 1 }]);
  const attached = await callTool(module, 'list_entitlement_products', { project_id: PROJECT, entitlement_id: 'entla1b2c3d4e5' }, ctx);
  assert.equal(attached.payload.products.length, 2);
});

test('api_get reaches only the aggregate routes, and there is no api_request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { object: 'list', items: [] }));
  assert.equal(module.tools.some((tool) => tool.name === 'api_request'), false);
  assert.ok(module.tools.every((tool) => tool.annotations.readOnlyHint), 'every tool reads');
  const ok = await callTool(module, 'api_get', { path: `/v2/projects/${PROJECT}/offerings`, query: { limit: 5 } }, ctx);
  assert.equal(ok.isError, false);
  assert.equal(fetch.calls[0].url, `https://api.revenuecat.com/v2/projects/${PROJECT}/offerings?limit=5`);
  for (const path of [`/v2/projects/${PROJECT}/customers`, `/v2/projects/${PROJECT}/customers/abc/subscriptions`, `/v2/projects/${PROJECT}/apps/app1/public_api_keys`, '/v1/subscribers/abc', `/v2/projects/${PROJECT}/webhooks`, `/v2/projects/${PROJECT}/products/a%2Fb`]) {
    const refused = await callTool(module, 'api_get', { path }, ctx);
    assert.equal(refused.isError, true, path);
  }
  assert.equal(fetch.calls.length, 1);
});

test('errors: a missing permission keeps RevenueCat\'s words, a 429 carries retryAfter, a 401 mentions v1 keys', async () => {
  const forbidden = setup(() => jsonResponse(403, fixture(import.meta.url, 'error-403.json')));
  const refused = await callTool(forbidden.module, 'get_overview', { project_id: PROJECT }, forbidden.ctx);
  assert.equal(refused.payload.status, 403);
  assert.match(refused.payload.error, /lacks the permission for this.*\(HTTP 403\)\. RevenueCat said: "The API key does not have the permission charts_metrics:overview:read\."/);

  const limited = setup(() => jsonResponse(429, { type: 'rate_limit_error', message: 'Too many requests', backoff_ms: 2000 }, { 'retry-after': '2' }));
  const rate = await callTool(limited.module, 'get_overview', { project_id: PROJECT }, limited.ctx);
  assert.equal(rate.payload.retryAfter, 2);

  const rejected = setup(() => jsonResponse(401, { type: 'authentication_error', message: 'Invalid API key' }));
  const unauthorized = await callTool(rejected.module, 'list_projects', {}, rejected.ctx);
  assert.match(unauthorized.payload.error, /a v1 key/);
});

test('log lines carry no key and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, fixture(import.meta.url, 'revenue.json')));
  await callTool(module, 'get_revenue', { project_id: PROJECT, start_date: '2026-10-01', end_date: '2026-10-31' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^revenuecat get_revenue GET 200 \d+ms$/);
  assert.equal(logs[0].includes(KEY), false);
  assert.equal(logs[0].includes(PROJECT), false);
});
