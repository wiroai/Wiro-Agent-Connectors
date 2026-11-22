import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'roapi_TESTabcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const credentials = { apitoken: TOKEN };
const GAME = 'a1b2c3d4e5f6';
const PUZZLE = 'b71c0e93d2a4';

function setup(handler, accounts = { apps: [GAME] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

const CREATIVES = {
  app_token: GAME,
  platform: ['ios'],
  from: '2026-11-14',
  to: '2026-11-20',
  dimensions: ['network', 'campaign', 'ad'],
  metrics: ['installs', 'spend', 'cpi', 'rev_all', 'roas_all'],
  sort: '-spend',
};

test('get_account reads who the token is with the Bearer header', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'me.json')));
  const { payload } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://roasit.com/api/me');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, { id: 42, name: 'Example Games', email: 'owner@example.com', accessAll: true, token: { id: 7, name: 'AI agent', prefix: 'roapi_Ab3' } });
});

test('the apps picker: list_apps with no arguments gives app tokens and names', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), null);
  const [picker] = module.accountPickers;
  assert.deepEqual({ ...picker }, {
    key: 'apps',
    label: 'Roasit apps',
    description: 'The apps the agent may report on, each with all its platforms (a report picks the platform). Reports cover only the apps chosen here, so choose an app added to Roasit later too.',
    multiple: true,
    tool: 'list_apps',
    idField: 'app_token',
    nameField: 'name',
    legacyField: 'apps',
  });
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.deepEqual(payload.apps.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [[GAME, 'My Game'], [PUZZLE, 'Puzzle Pro']]);
  assert.deepEqual(payload.apps[0], {
    app_token: GAME,
    name: 'My Game',
    reportingCurrency: 'USD',
    platforms: ['ios', 'android'],
    androidPackage: 'com.example.game',
    iosBundle: 'com.example.game',
    appleAppId: '1234567890',
    createdAt: '2026-01-10T09:00:00Z',
  });
  assert.equal('appleAppId' in payload.apps[1], false, 'empty store ids are left out');
  assert.ok(payload.apps.every((app) => !('selected' in app)), 'no lock, no marks');
  assert.equal(payload.note, undefined);
});

test('list_apps marks the apps chosen for the connection with their platforms, and says when none is chosen', async () => {
  const chosen = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')));
  const { payload } = await callTool(chosen.module, 'list_apps', {}, chosen.ctx);
  assert.deepEqual(payload.apps.map((app) => [app.app_token, app.selected, app.platforms]), [[GAME, true, ['ios', 'android']], [PUZZLE, undefined, payload.apps[1].platforms]]);
  assert.equal(payload.note, undefined);

  for (const accounts of [{}, { apps: [] }]) {
    const none = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), accounts);
    const unchosen = await callTool(none.module, 'list_apps', {}, none.ctx);
    assert.equal(unchosen.isError, false, 'the list itself still answers');
    assert.ok(unchosen.payload.apps.every((app) => !('selected' in app)));
    assert.match(unchosen.payload.note, /^No app is chosen for this connection yet, so every app-level tool is refused until apps from this list are chosen for it\.$/);
  }
});

test('with no app chosen, every app-level tool refuses with one sentence before anything is sent', async () => {
  const NONE = /^No app is chosen for this Roasit connection yet, and it reports only on the apps chosen for it\. Ask whoever manages the connection to choose them \(list_apps lists the apps the token sees\)\. Nothing was sent to Roasit\.$/;
  const replies = {
    '/api/me': fixture(import.meta.url, 'me.json'),
    '/api/report/metrics': fixture(import.meta.url, 'metrics.json'),
    '/api/report/networks': fixture(import.meta.url, 'networks.json'),
  };
  for (const accounts of [{}, { apps: [] }]) {
    const { module, fetch, ctx } = setup((request) => jsonResponse(200, replies[request.path] ?? {}), accounts);
    const calls = [
      ['get_report', CREATIVES],
      ['get_skan_report', { app_token: GAME }],
      ['get_reconciliation', { app_token: GAME, platform: 'ios' }],
      ['get_data_freshness', { app_token: GAME }],
      ['list_dimension_values', { app_token: GAME }],
      ['list_events', { app_token: GAME }],
      ['list_networks', { app_token: GAME }],
      ['api_get', { path: `/api/apps/${GAME}/connections` }],
    ];
    for (const [tool, args] of calls) {
      const { payload, isError } = await callTool(module, tool, args, ctx);
      assert.equal(isError, true, tool);
      assert.match(payload.error, NONE, tool);
    }
    assert.equal(fetch.calls.length, 0);
    // What is not about one app still answers.
    for (const [tool, args] of [['get_account', {}], ['list_metrics', {}], ['list_networks', {}]]) {
      assert.equal((await callTool(module, tool, args, ctx)).isError, false, tool);
    }
    assert.deepEqual(fetch.calls.map((call) => call.path), ['/api/me', '/api/report/metrics', '/api/report/networks']);
  }
});

test('get_report sends one app with comma lists and returns the dashboard\'s rows, totals, notes and spend depth', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  const { payload, isError } = await callTool(module, 'get_report', { ...CREATIVES, network: ['meta', 'google'] }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].path, '/api/report');
  assert.deepEqual(fetch.calls[0].query, {
    app_token: GAME,
    from: '2026-11-14',
    to: '2026-11-20',
    dimensions: 'network,campaign,ad',
    metrics: 'installs,spend,cpi,rev_all,roas_all',
    platform: 'ios',
    network: 'meta,google',
    sort: '-spend',
    limit: '1000',
  });
  assert.equal(payload.currency, 'USD');
  assert.deepEqual(payload.totals, { installs: 589, spend: 1392.5, roas_all: 1.21 });
  assert.deepEqual(payload.spendNotFinalDays, ['2026-11-20']);
  assert.deepEqual(payload.spendGranularity, { meta: 'ad', google: 'campaign' });
  assert.equal(payload.notes.length, 2);
  assert.equal(payload.lines[0].line, 'reinstalls');
  assert.equal(payload.rows[2].roas_all, null, 'null stays null: not available yet');
  assert.equal(payload.rows.length, 3);
  assert.equal(payload.rowsCap, undefined);
});

test('get_report refuses an app outside the chosen ones, and values that would break a comma list', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  const refused = await callTool(module, 'get_report', { ...CREATIVES, app_token: PUZZLE }, ctx);
  assert.match(refused.payload.error, /^The app b71c0e93d2a4 is not among the apps chosen for this connection\. Use one of: a1b2c3d4e5f6\. Nothing was sent\.$/);
  const comma = await callTool(module, 'get_report', { ...CREATIVES, campaign: ['Spring, UA'] }, ctx);
  assert.match(comma.payload.error, /`campaign\[0\]` does not have the expected format/);
  const badToken = await callTool(module, 'get_report', { ...CREATIVES, app_token: 'NOT-HEX' }, ctx);
  assert.match(badToken.payload.error, /`app_token` does not have the expected format/);
  assert.equal(fetch.calls.length, 0);
});

test('report rows come in pages, and a capped report says so', async () => {
  const report = fixture(import.meta.url, 'report.json');
  report.rows = Array.from({ length: 1000 }, (_, index) => ({ network: 'meta', campaign: `Campaign ${index} `.padEnd(80, 'x'), installs: index }));
  report.rows_total = 4210;
  const { module, fetch, ctx } = setup(() => jsonResponse(200, report));
  const first = await callTool(module, 'get_report', { ...CREATIVES, limit: 1000 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  assert.match(first.payload.rowsCap, /the report has 4210/);
  const shown = first.payload.rows.length;
  const second = await callTool(module, 'get_report', { ...CREATIVES, limit: 1000, cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.rows[0].installs, shown);
  assert.equal(fetch.calls.length, 2);
});

test('the app-level reads name the app in the path, after the account check', async () => {
  const replies = {
    [`/api/apps/${GAME}/skan`]: fixture(import.meta.url, 'skan.json'),
    [`/api/apps/${GAME}/connections`]: fixture(import.meta.url, 'connections.json'),
    [`/api/apps/${GAME}/reconciliation`]: { total: { store_installs: 1000, claims_by_network: { meta: 700, google: 500 }, overcount_ratio: 1.2, comparable: true } },
    [`/api/apps/${GAME}/dimensions`]: { networks: ['meta'], campaigns: ['Spring UA'], adgroups: [], ads: ['Hero video 9x16'] },
    [`/api/apps/${GAME}/events`]: { events: [{ name: 'purchase', last_seen: '2026-11-21T08:00:00Z', mapping: { meta: 'Purchase' } }] },
    '/api/report/networks': fixture(import.meta.url, 'networks.json'),
    '/api/report/metrics': fixture(import.meta.url, 'metrics.json'),
  };
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, replies[request.path]));
  const skan = await callTool(module, 'get_skan_report', { app_token: GAME, from: '2026-11-12', to: '2026-11-19', network: 'meta' }, ctx);
  assert.deepEqual(fetch.calls[0].query, { from: '2026-11-12', to: '2026-11-19', network: 'meta' });
  assert.equal(skan.payload.status.last_verified, '2026-11-21T07:10:00Z');
  assert.equal(skan.payload.rows[0].with_value, 40);
  assert.deepEqual(skan.payload.unmapped, [{ network: 'applovin', source_id: '3901' }]);

  const freshness = await callTool(module, 'get_data_freshness', { app_token: GAME }, ctx);
  assert.equal(freshness.payload.last_sync.errors.applovin, 'report key rejected');
  const reconciliation = await callTool(module, 'get_reconciliation', { app_token: GAME, platform: 'android' }, ctx);
  assert.equal(fetch.calls[2].query.platform, 'android');
  assert.equal(reconciliation.payload.total.overcount_ratio, 1.2);
  const dimensions = await callTool(module, 'list_dimension_values', { app_token: GAME }, ctx);
  assert.deepEqual(dimensions.payload.campaigns, ['Spring UA']);
  const events = await callTool(module, 'list_events', { app_token: GAME }, ctx);
  assert.equal(events.payload.events[0].mapping.meta, 'Purchase');
  const networks = await callTool(module, 'list_networks', { app_token: GAME }, ctx);
  assert.deepEqual(networks.payload.networks, [{ slug: 'meta', label: 'Meta', paid: true }, { slug: 'organic', label: 'Organic', paid: false }]);
  const metrics = await callTool(module, 'list_metrics', {}, ctx);
  assert.deepEqual(metrics.payload.metrics[1].dimensions, ['day', 'platform', 'country']);

  const other = await callTool(module, 'get_data_freshness', { app_token: PUZZLE }, ctx);
  assert.match(other.payload.error, /not among the apps chosen/);
  assert.equal(fetch.calls.length, 7);
});

test('a reply of unknown shape that is too long has its longest lists cut, with a note', async () => {
  const campaigns = Array.from({ length: 3000 }, (_, index) => `Campaign number ${index}`);
  const { module, ctx } = setup(() => jsonResponse(200, { networks: ['meta', 'google'], campaigns, ads: [] }));
  const { result, payload } = await callTool(module, 'list_dimension_values', { app_token: GAME }, ctx);
  assert.ok(textBytes(result) <= 32 * 1024);
  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.networks, ['meta', 'google']);
  assert.ok(payload.campaigns.length < 3000 && payload.campaigns.length > 0);
  assert.match(payload.note, /campaigns \(3000\)/);
});

test('api_get must name a chosen app, keeps to /api/, and there is no api_request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { ok: true }));
  assert.equal(module.tools.some((tool) => tool.name === 'api_request'), false);
  assert.ok(module.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal((await callTool(module, 'api_get', { path: `/api/apps/${GAME}/connections` }, ctx)).isError, false);
  assert.equal((await callTool(module, 'api_get', { path: '/api/report', query: { app_token: GAME, from: '2026-11-01', to: '2026-11-07' } }, ctx)).isError, false);
  const other = await callTool(module, 'api_get', { path: `/api/apps/${PUZZLE}/events` }, ctx);
  assert.match(other.payload.error, /The app b71c0e93d2a4 is not among the apps chosen/);
  const none = await callTool(module, 'api_get', { path: '/api/me' }, ctx);
  assert.match(none.payload.error, /names none of the apps chosen for this connection/);
  const outside = await callTool(module, 'api_get', { path: '/admin' }, ctx);
  assert.match(outside.payload.error, /must start with \/api\//);
  assert.equal(fetch.calls.length, 2);
});

test('errors: Roasit\'s own words, a closed route, and a rate limit', async () => {
  const bad = setup(() => jsonResponse(400, { error: 'metric store_installs is not allowed with dimension network' }));
  const refused = await callTool(bad.module, 'get_report', CREATIVES, bad.ctx);
  assert.match(refused.payload.error, /\(HTTP 400\)\. Roasit said: "metric store_installs is not allowed with dimension network"\./);
  const closed = setup(() => jsonResponse(403, { error: 'this route is not available with an API token' }));
  assert.match((await callTool(closed.module, 'list_events', { app_token: GAME }, closed.ctx)).payload.error, /^Roasit does not open this route to API tokens \(HTTP 403\)/);
  const limited = setup(() => jsonResponse(429, { error: 'rate limited', retry_after: 20 }, { 'retry-after': '20' }));
  assert.equal((await callTool(limited.module, 'get_report', CREATIVES, limited.ctx)).payload.retryAfter, 20);
});

test('tool texts name only Roasit, never another company', () => {
  const { module } = loadModuleFor(import.meta.url);
  for (const tool of module.tools) {
    const texts = `${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`.replace(/\["[a-z_", ]+\]|\([a-z_, .]+\)/g, '');
    assert.doesNotMatch(texts, /\b(Meta|TikTok|Google|Stripe|Facebook|AppLovin|Apple Search Ads)\b/, tool.name);
  }
});

test('log lines carry no token and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, fixture(import.meta.url, 'report.json')));
  await callTool(module, 'get_report', CREATIVES, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^roasit get_report GET 200 \d+ms$/);
  for (const secret of [TOKEN, GAME, '2026-11-14']) assert.equal(logs[0].includes(secret), false);
});
