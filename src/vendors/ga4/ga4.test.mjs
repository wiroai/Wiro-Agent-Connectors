import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.example-access-token';
const credentials = { access_token: TOKEN };
const DATA = 'https://analyticsdata.googleapis.com';
const ADMIN = 'https://analyticsadmin.googleapis.com';

function setup(handler, accounts = { properties: ['300100100'] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);
// Values from the sandboxed module come from another realm: compare them as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the module declares its origins, the access token and the properties picker', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), [DATA, ADMIN]);
  assert.deepEqual(plain(module.credentials), ['access_token']);
  assert.deepEqual(plain(module.requiredCredentials), [['access_token']]);
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.accountPickers), [{
    key: 'properties',
    label: 'Google Analytics properties',
    description: 'The GA4 properties the agent may report on and configure.',
    multiple: true,
    tool: 'list_properties',
    idField: 'id',
    nameField: 'name',
    legacyField: 'propertyid',
  }]);
  const kinds = Object.fromEntries(module.tools.map((tool) => [tool.name, tool.annotations.readOnlyHint ? 'read' : 'write']));
  assert.deepEqual(kinds, {
    list_properties: 'read',
    run_report: 'read',
    run_realtime_report: 'read',
    batch_run_reports: 'read',
    get_metadata: 'read',
    check_compatibility: 'read',
    api_get: 'read',
    api_request: 'write',
  });
});

test('the properties picker: list_properties flattens account summaries, with the bearer token, and pages with the cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'account-summaries.json')), null);
  const [picker] = module.accountPickers;
  const first = await callTool(module, picker.tool, {}, ctx);
  assert.equal(first.isError, false);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `${ADMIN}/v1beta/accountSummaries?pageSize=200`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(first.payload.properties, [
    { id: '300100100', name: 'example.com - GA4', account: 'Example Store', account_id: '200100100', property_type: 'PROPERTY_TYPE_ORDINARY' },
    { id: '300100200', name: 'Example App', account: 'Example Store', account_id: '200100100', property_type: 'PROPERTY_TYPE_ORDINARY' },
    { id: '300200100', name: 'blog.example.org', account: 'Example Blog', account_id: '200200200', property_type: 'PROPERTY_TYPE_ORDINARY' },
  ]);
  assert.deepEqual(first.payload.properties.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [
    ['300100100', 'example.com - GA4'],
    ['300100200', 'Example App'],
    ['300200100', 'blog.example.org'],
  ]);

  await callTool(module, picker.tool, { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.pageToken, 'next-page-token-1');
});

test('run_report posts a Data API report for a chosen property and returns rows keyed by name, totals and metadata', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'run-report.json')));
  const filter = { filter: { fieldName: 'sessionMedium', stringFilter: { value: 'cpc' } } };
  const { payload, isError } = await callTool(module, 'run_report', {
    property_id: 'properties/300100100',
    date_ranges: [{ start_date: '2026-03-01', end_date: '2026-03-31' }],
    dimensions: ['sessionSource', 'sessionMedium'],
    metrics: ['sessions', 'keyEvents', 'totalRevenue'],
    dimension_filter: filter,
    order_bys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 3,
    metric_aggregations: ['TOTAL'],
  }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${DATA}/v1beta/properties/300100100:runReport`);
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(fetch.calls[0].json, {
    dateRanges: [{ startDate: '2026-03-01', endDate: '2026-03-31' }],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
    dimensionFilter: filter,
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 3,
    metricAggregations: ['TOTAL'],
  });
  assert.equal(payload.property_id, '300100100');
  assert.deepEqual(payload.rows[0], { sessionSource: 'google', sessionMedium: 'cpc', sessions: 1520, keyEvents: 41, totalRevenue: 2310.5 });
  assert.equal(payload.rows.length, 3);
  assert.deepEqual(payload.totals, [{ sessionSource: 'RESERVED_TOTAL', sessionMedium: 'RESERVED_TOTAL', sessions: 2955, keyEvents: 67, totalRevenue: 3112.75 }]);
  assert.equal(payload.row_count, 7);
  assert.deepEqual(payload.metadata, { currency_code: 'USD', time_zone: 'America/Los_Angeles', subject_to_thresholding: true });
  assert.deepEqual(payload.metrics, [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'keyEvents', type: 'TYPE_FLOAT' }, { name: 'totalRevenue', type: 'TYPE_CURRENCY' }]);

  // 7 rows in all, 3 returned: the cursor asks for the next ones.
  await callTool(module, 'run_report', { property_id: '300100100', metrics: ['sessions'], limit: 3, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.offset, 3);
  assert.deepEqual(fetch.calls[1].json.dateRanges, [{ startDate: '28daysAgo', endDate: 'yesterday' }], 'the default range');
});

test('every property tool refuses a property outside the chosen ones before sending anything', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  for (const [tool, args] of [
    ['run_report', { property_id: '999', metrics: ['sessions'] }],
    ['run_realtime_report', { property_id: '999', metrics: ['activeUsers'] }],
    ['batch_run_reports', { property_id: '999', requests: [{ metrics: [{ name: 'sessions' }] }] }],
    ['get_metadata', { property_id: '999' }],
    ['check_compatibility', { property_id: '999', metrics: ['sessions'] }],
  ]) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true, tool);
    assert.match(payload.error, /The property ID 999 is not among the property IDs chosen for this connection\. Use one of: 300100100\. Nothing was sent\./, tool);
  }
  assert.equal(fetch.calls.length, 0);
});

test('run_realtime_report sends minute ranges and returns rows; a cut list continues by skipping', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'realtime.json')));
  const { payload } = await callTool(module, 'run_realtime_report', {
    property_id: '300100100',
    dimensions: ['country', 'deviceCategory'],
    metrics: ['activeUsers'],
    minute_ranges: [{ start_minutes_ago: 4, end_minutes_ago: 0 }],
  }, ctx);
  assert.equal(fetch.calls[0].url, `${DATA}/v1beta/properties/300100100:runRealtimeReport`);
  assert.deepEqual(fetch.calls[0].json, {
    dimensions: [{ name: 'country' }, { name: 'deviceCategory' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 100,
    minuteRanges: [{ startMinutesAgo: 4, endMinutesAgo: 0 }],
  });
  assert.deepEqual(payload.rows, [
    { country: 'United States', deviceCategory: 'mobile', activeUsers: 42 },
    { country: 'Germany', deviceCategory: 'desktop', activeUsers: 7 },
  ]);
  assert.equal(payload.nextCursor, undefined);
});

test('batch_run_reports gives each request 50 rows unless it says otherwise, and refuses another property', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'batch.json')));
  const { payload } = await callTool(module, 'batch_run_reports', {
    property_id: '300100100',
    requests: [
      { metrics: [{ name: 'sessions' }], dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }] },
      { metrics: [{ name: 'totalRevenue' }], dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], limit: 5, property: 'properties/300100100' },
    ],
  }, ctx);
  assert.equal(fetch.calls[0].url, `${DATA}/v1beta/properties/300100100:batchRunReports`);
  assert.deepEqual(fetch.calls[0].json.requests.map((request) => request.limit), [50, 5]);
  assert.equal(fetch.calls[0].json.requests[1].property, undefined);
  assert.deepEqual(payload.reports.map((report) => report.rows), [[{ sessions: 3120 }], [{ totalRevenue: 15210.4 }]]);

  const other = await callTool(module, 'batch_run_reports', { property_id: '300100100', requests: [{ property: 'properties/42', metrics: [{ name: 'sessions' }] }] }, ctx);
  assert.match(other.payload.error, /must be for property 300100100/);
  assert.equal(fetch.calls.length, 1);
});

test('batch_run_reports cuts each report\'s rows when the reports do not fit 32 KB together', async () => {
  const big = (name) => ({
    dimensionHeaders: [{ name: 'pagePath' }],
    metricHeaders: [{ name }],
    rows: Array.from({ length: 400 }, (_, index) => ({ dimensionValues: [{ value: `/blog/a-fairly-long-article-path-number-${index}` }], metricValues: [{ value: String(index) }] })),
    rowCount: 400,
  });
  const { module, ctx } = setup(() => jsonResponse(200, { reports: [big('sessions'), big('screenPageViews')] }));
  const { result, payload, isError } = await callTool(module, 'batch_run_reports', { property_id: '300100100', requests: [{ limit: 400 }, { limit: 400 }] }, ctx);
  assert.equal(isError, false);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 32 * 1024);
  assert.equal(payload.truncated, true);
  assert.equal(payload.reports[0].rows_returned_of, 400);
  assert.ok(payload.reports[0].rows.length > 10 && payload.reports[0].rows.length < 400);
  assert.match(payload.note, /did not fit 32 KB together/);
});

test('get_metadata lists fields trimmed, filtered by kind, text and custom definitions', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'metadata.json')));
  const all = await callTool(module, 'get_metadata', { property_id: '300100100' }, ctx);
  assert.equal(fetch.calls[0].url, `${DATA}/v1beta/properties/300100100/metadata`);
  assert.equal(all.payload.total, 6);
  assert.deepEqual(all.payload.fields[0], { kind: 'dimension', api_name: 'date', ui_name: 'Date', category: 'Time', description: 'The date of the event, formatted as YYYYMMDD.' });

  const revenue = await callTool(module, 'get_metadata', { property_id: '300100100', kind: 'metrics', search: 'REVENUE' }, ctx);
  assert.deepEqual(revenue.payload.fields.map((item) => item.api_name), ['totalRevenue', 'purchaseRevenue']);
  assert.equal(revenue.payload.fields[0].type, 'TYPE_CURRENCY');

  const custom = await callTool(module, 'get_metadata', { property_id: '300100100', custom_only: true }, ctx);
  assert.deepEqual(custom.payload.fields.map((item) => [item.api_name, item.custom]), [['customEvent:plan_tier', true]]);
});

test('check_compatibility answers for the fields given, or lists every compatible field', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'compatibility.json')));
  const requested = await callTool(module, 'check_compatibility', { property_id: '300100100', dimensions: ['date', 'itemName'], metrics: ['sessions'] }, ctx);
  assert.equal(fetch.calls[0].url, `${DATA}/v1beta/properties/300100100:checkCompatibility`);
  assert.deepEqual(fetch.calls[0].json, { dimensions: [{ name: 'date' }, { name: 'itemName' }], metrics: [{ name: 'sessions' }] });
  assert.deepEqual(requested.payload.fields, [
    { kind: 'dimension', name: 'date', compatibility: 'COMPATIBLE' },
    { kind: 'dimension', name: 'itemName', compatibility: 'INCOMPATIBLE' },
    { kind: 'metric', name: 'sessions', compatibility: 'COMPATIBLE' },
  ]);
  assert.equal(requested.payload.all_compatible, false);

  const compatible = await callTool(module, 'check_compatibility', { property_id: '300100100', metrics: ['sessions'], list: 'compatible' }, ctx);
  assert.equal(fetch.calls[1].json.compatibilityFilter, 'COMPATIBLE');
  assert.equal(compatible.payload.fields.length, 5);
  assert.equal(compatible.payload.all_compatible, undefined);

  const none = await callTool(module, 'check_compatibility', { property_id: '300100100' }, ctx);
  assert.match(none.payload.error, /at least one dimension or metric/);
  assert.equal(fetch.calls.length, 2);
});

test('api_get reaches the Admin API for a chosen property, and refuses paths that name no chosen property', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'key-events.json')));
  const read = await callTool(module, 'api_get', { origin: ADMIN, path: '/v1beta/properties/300100100/keyEvents' }, ctx);
  assert.equal(read.isError, false);
  assert.equal(fetch.calls[0].url, `${ADMIN}/v1beta/properties/300100100/keyEvents`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(read.payload.data.keyEvents[0].eventName, 'purchase');

  const audiences = await callTool(module, 'api_get', { origin: ADMIN, path: '/v1alpha/properties/300100100/audiences' }, ctx);
  assert.equal(audiences.isError, false);
  assert.equal(fetch.calls[1].url, `${ADMIN}/v1alpha/properties/300100100/audiences`);

  for (const path of ['/v1beta/properties/42/keyEvents', '/v1beta/accountSummaries', '/v1beta/accounts/200100100']) {
    const refused = await callTool(module, 'api_get', { origin: ADMIN, path }, ctx);
    assert.match(refused.payload.error, /names none of the property IDs chosen|not among the property IDs chosen/, path);
  }
  const elsewhere = await callTool(module, 'api_get', { path: '/v2/properties/300100100' }, ctx);
  assert.match(elsewhere.payload.error, /must start with \/v1beta\/ or \/v1alpha\//);
  assert.equal(fetch.calls.length, 2);
});

test('api_request sends Admin writes once, keeps property deletion and access management out of reach, and reports an unclear outcome', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { name: 'properties/300100100/keyEvents/6001002', eventName: 'newsletter_signup', countingMethod: 'ONCE_PER_EVENT' }));
  const created = await callTool(module, 'api_request', {
    method: 'POST',
    origin: ADMIN,
    path: '/v1beta/properties/300100100/keyEvents',
    json: { eventName: 'newsletter_signup', countingMethod: 'ONCE_PER_EVENT' },
  }, ctx);
  assert.equal(created.isError, false);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.deepEqual(fetch.calls[0].json, { eventName: 'newsletter_signup', countingMethod: 'ONCE_PER_EVENT' });

  const deleteProperty = await callTool(module, 'api_request', { method: 'DELETE', origin: ADMIN, path: '/v1beta/properties/300100100' }, ctx);
  assert.match(deleteProperty.payload.error, /Deleting a whole Google Analytics property or account is not offered here/);
  const access = await callTool(module, 'api_request', { method: 'POST', origin: ADMIN, path: '/v1alpha/properties/300100100/accessBindings', json: { user: 'someone@example.com', roles: ['predefinedRoles/admin'] } }, ctx);
  assert.match(access.payload.error, /Changing who can access/);
  const otherInBody = await callTool(module, 'api_request', { method: 'PATCH', origin: ADMIN, path: '/v1beta/properties/300100100/customDimensions/1', json: { name: 'properties/42/customDimensions/1' } }, ctx);
  assert.match(otherInBody.payload.error, /The property ID 42 is not among the property IDs chosen/);
  assert.equal(fetch.calls.length, 1);

  const broken = setup(() => jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }));
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', origin: ADMIN, path: '/v1beta/properties/300100100/customDimensions', json: { parameterName: 'plan_tier', displayName: 'Plan Tier', scope: 'USER' } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('errors: the vendor\'s words, 401 names the access token, 429 carries retryAfter, and the logs hold no token or arguments', async () => {
  const invalid = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-invalid-field.json')));
  const bad = await callTool(invalid.module, 'run_report', { property_id: '300100100', metrics: ['sesions'] }, invalid.ctx);
  assert.equal(bad.isError, true);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /check_compatibility/);
  assert.match(bad.payload.error, /Field sesions is not a valid metric/);

  const expired = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-unauthenticated.json')));
  const denied = await callTool(expired.module, 'list_properties', {}, expired.ctx);
  assert.match(denied.payload.error, /Google Analytics rejected the credentials \(HTTP 401\).*Google Analytics access token/);

  const limited = setup(() => jsonResponse(429, fixture(import.meta.url, 'error-quota.json'), { 'retry-after': '30' }));
  const quota = await callTool(limited.module, 'run_report', { property_id: '300100100', metrics: ['sessions'] }, limited.ctx);
  assert.equal(quota.payload.status, 429);
  assert.equal(quota.payload.retryAfter, 30);

  const offline = setup(() => textResponse(502, '<html>bad gateway</html>'));
  const gateway = await callTool(offline.module, 'get_metadata', { property_id: '300100100' }, offline.ctx);
  assert.match(gateway.payload.error, /server error \(HTTP 502\)/);

  const logged = [...invalid.logs, ...expired.logs, ...limited.logs, ...offline.logs].join('\n');
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged, /ya29|sesions|300100100/);

  const missing = setup(() => jsonResponse(200, {}));
  missing.ctx.credentials = {};
  const notConnected = await callTool(missing.module, 'list_properties', {}, missing.ctx);
  assert.match(notConnected.payload.error, /Google Analytics is not connected: the Google Analytics access token is missing/);
  assert.equal(missing.fetch.calls.length, 0);
});
