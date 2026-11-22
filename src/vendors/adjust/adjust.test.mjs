import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'adjTESTtoken0123456789abcdef';
const credentials = { userapitoken: TOKEN };
const IOS = 'abc123def456';
const ANDROID = 'ghi789jkl012';

function setup(handler, accounts = { apps: [IOS] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

const CREATIVES = {
  date_period: '-8d:-1d',
  dimensions: ['app', 'partner_name', 'campaign', 'campaign_id_network', 'creative_network', 'creative_id_network'],
  metrics: ['roas', 'roas_ad', 'cost', 'paid_installs', 'all_revenue'],
  ad_spend_mode: 'mixed',
  currency: 'USD',
  sort: ['-roas'],
  filters: { paid_installs__gte: 50, partner_name__in: ['Facebook Installs', 'Google Ads'] },
};

test('the apps picker: list_apps with no arguments lists app tokens and names', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), null);
  const [picker] = module.accountPickers;
  assert.deepEqual({ ...picker }, { key: 'apps', label: 'Adjust apps', description: 'The apps the agent may report on.', multiple: true, tool: 'list_apps', idField: 'id', nameField: 'name', legacyField: 'apps' });
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://automate.adjust.com/reports-service/filters_data?required_filters=apps');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.apps.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [[IOS, 'Acme Photo iOS'], [ANDROID, 'Acme Photo Android']]);
});

test('get_report scopes to the chosen apps by default and sends every report parameter', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  const { payload, isError } = await callTool(module, 'get_report', CREATIVES, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.path, '/reports-service/report');
  assert.deepEqual(request.query, {
    date_period: '-8d:-1d',
    dimensions: 'app,partner_name,campaign,campaign_id_network,creative_network,creative_id_network',
    metrics: 'roas,roas_ad,cost,paid_installs,all_revenue',
    app_token__in: IOS,
    ad_spend_mode: 'mixed',
    currency: 'USD',
    sort: '-roas',
    paid_installs__gte: '50',
    partner_name__in: 'Facebook Installs,Google Ads',
  });
  assert.deepEqual(payload.apps, [IOS]);
  assert.equal(payload.rowsTotal, 2);
  assert.deepEqual(payload.totals, { roas: 1.41, roas_ad: 0.4, cost: 1392.5, paid_installs: 589, all_revenue: 1450.68 });
  assert.deepEqual(payload.rows[0], {
    app: 'Acme Photo iOS',
    partner_name: 'Facebook Installs',
    campaign: 'Spring Sale (123456789)',
    campaign_id_network: '123456789',
    creative_network: 'Hero Video 16x9',
    creative_id_network: '987654321',
    roas: '1.83',
    roas_ad: '0.92',
    cost: '412.50',
    paid_installs: '187',
    all_revenue: '754.88',
  });
  assert.equal('attr_dependency' in payload.rows[0], false);
});

test('app tokens outside the chosen apps are refused before any request; without a lock the report is account-wide', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  const refused = await callTool(module, 'get_report', { ...CREATIVES, app_tokens: [ANDROID] }, ctx);
  assert.match(refused.payload.error, /^The app ghi789jkl012 is not among the apps chosen for this connection\. Use one of: abc123def456\. Nothing was sent\.$/);
  const nothingChosen = setup(() => jsonResponse(200, {}), {});
  const none = await callTool(nothingChosen.module, 'get_report', CREATIVES, nothingChosen.ctx);
  assert.match(none.payload.error, /^No app is chosen for this connection yet\. Nothing was sent\.$/);
  assert.equal(fetch.calls.length + nothingChosen.fetch.calls.length, 0);

  const open = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')), null);
  const wide = await callTool(open.module, 'get_report', CREATIVES, open.ctx);
  assert.equal(open.fetch.calls[0].query.app_token__in, undefined);
  assert.equal(wide.payload.apps, 'all');
});

test('filters must be "<field>__<operator>", and app tokens go in app_tokens', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const cases = [
    [{ app_token__in: ANDROID }, /Scope apps with app_tokens/],
    [{ partner_name: 'Organic' }, /filters\.partner_name is not a filter/],
    [{ cost__gte: { a: 1 } }, /filters\.cost__gte must be text, a number, or a list of them/],
  ];
  for (const [filters, message] of cases) {
    const { payload } = await callTool(module, 'get_report', { ...CREATIVES, filters }, ctx);
    assert.match(payload.error, message);
  }
  const badPeriod = await callTool(module, 'get_report', { ...CREATIVES, date_period: 'last 7 days' }, ctx);
  assert.match(badPeriod.payload.error, /`date_period` does not have the expected format/);
  assert.equal(fetch.calls.length, 0);
});

test('report rows come in pages of limit rows, and a page over 32 KB is cut where it fits', async () => {
  const report = { rows: Array.from({ length: 1500 }, (_, index) => ({ creative_network: `Creative ${index} `.padEnd(60, 'x'), roas: String(index / 100) })), totals: { roas: 1 }, warnings: [] };
  const { module, fetch, ctx } = setup(() => jsonResponse(200, report));
  const first = await callTool(module, 'get_report', { ...CREATIVES, limit: 1000 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.rows.length;
  const second = await callTool(module, 'get_report', { ...CREATIVES, limit: 1000, cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.rows[0].roas, String(shown / 100));
  assert.equal(fetch.calls.length, 2);

  const small = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  const page = await callTool(small.module, 'get_report', { ...CREATIVES, limit: 1 }, small.ctx);
  assert.equal(page.payload.rows.length, 1);
  const rest = await callTool(small.module, 'get_report', { ...CREATIVES, limit: 1, cursor: page.payload.nextCursor }, small.ctx);
  assert.equal(rest.payload.rows[0].partner_name, 'Google Ads');
  assert.equal(rest.payload.nextCursor, undefined);
});

test('a 204 is an empty report with a note, not an error', async () => {
  const { module, ctx } = setup(() => new Response(null, { status: 204 }));
  const { payload, isError } = await callTool(module, 'get_report', CREATIVES, ctx);
  assert.equal(isError, false);
  assert.deepEqual(payload.rows, []);
  assert.equal(payload.note, 'Adjust has no data for this window and these filters.');
});

test('get_filter_values searches each list and flattens the values', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'filters-data.json')));
  const { payload } = await callTool(module, 'get_filter_values', { lists: ['overview_metrics', 'cohort_metrics'], search: 'roas' }, ctx);
  assert.deepEqual(fetch.calls[0].query, { required_filters: 'overview_metrics,cohort_metrics', overview_metrics__contains: 'roas', cohort_metrics__contains: 'roas' });
  assert.deepEqual(payload.values[0], { list: 'overview_metrics', id: 'roas', name: 'ROAS', shortName: 'ROAS', section: 'revenue', formatting: 'percent', description: 'Return on ad spend across all revenue sources.' });
  assert.equal(payload.values[2].list, 'cohort_metrics');
});

test('list_events asks for the chosen apps\' events', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'events.json')));
  const { payload } = await callTool(module, 'list_events', { search: 'purchase' }, ctx);
  assert.deepEqual(fetch.calls[0].query, { app_token__in: IOS, events__contains: 'purchase' });
  assert.deepEqual(payload.events[0], { id: 'purchase', name: 'Purchase event', shortName: 'PUR', section: 'Revenue', formatting: 'money', appTokens: [IOS], skadEvent: false });
});

test('api_get must name chosen apps in app_token__in, keeps to /reports-service/, and there is no api_request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { rows: [] }));
  assert.equal(module.tools.some((tool) => tool.name === 'api_request'), false);
  const ok = await callTool(module, 'api_get', { path: '/reports-service/pivot_report', query: { app_token__in: IOS, date_period: 'yesterday', dimensions: 'day', metrics: 'installs' } }, ctx);
  assert.equal(ok.isError, false);
  const other = await callTool(module, 'api_get', { path: '/reports-service/report', query: { app_token__in: `${IOS},${ANDROID}` } }, ctx);
  assert.match(other.payload.error, /The app ghi789jkl012 is not among the apps chosen/);
  const none = await callTool(module, 'api_get', { path: '/reports-service/report', query: { date_period: 'yesterday' } }, ctx);
  assert.match(none.payload.error, /names none of the apps chosen for this connection/);
  const outside = await callTool(module, 'api_get', { path: '/control-center/apps' }, ctx);
  assert.match(outside.payload.error, /must start with \/reports-service\//);
  assert.equal(fetch.calls.length, 1);
});

test('errors: a heavy query, a rate limit and a reset token each say what to do', async () => {
  const slow = setup(() => jsonResponse(504, { error: 'timeout' }));
  const timeout = await callTool(slow.module, 'get_report', CREATIVES, slow.ctx);
  assert.match(timeout.payload.error, /split the date range or drop a dimension/);
  const limited = setup(() => jsonResponse(429, { error: 'Too many requests' }, { 'retry-after': '30' }));
  assert.equal((await callTool(limited.module, 'get_report', CREATIVES, limited.ctx)).payload.retryAfter, 30);
  const rejected = setup(() => jsonResponse(401, { error: 'Unauthorized' }));
  assert.match((await callTool(rejected.module, 'list_apps', {}, rejected.ctx)).payload.error, /^Adjust rejected the API token: it was reset or mistyped/);
});

test('log lines carry no token and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  await callTool(module, 'get_report', CREATIVES, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^adjust get_report GET 200 \d+ms$/);
  for (const secret of [TOKEN, IOS, 'Facebook Installs']) assert.equal(logs[0].includes(secret), false);
});
