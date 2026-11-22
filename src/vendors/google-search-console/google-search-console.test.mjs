import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.example-search-console-token';
const credentials = { access_token: TOKEN };
const ORIGIN = 'https://searchconsole.googleapis.com';
const DOMAIN = 'sc-domain:example.com';
const PREFIX = 'https://www.example.com/';
const DAY = 24 * 60 * 60 * 1000;

function setup(handler, accounts = { sites: [DOMAIN, PREFIX] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);
const plain = (value) => JSON.parse(JSON.stringify(value));
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Answers Search Analytics queries: by date (the latest-day probe), totals, or rows for one period. */
function analytics(request) {
  const body = request.json;
  if (body?.dimensions?.[0] === 'date') return jsonResponse(200, fixture(import.meta.url, 'query-dates.json'));
  const before = body.endDate < '2026-10-23';
  if (!body?.dimensions) return jsonResponse(200, fixture(import.meta.url, before ? 'totals-before.json' : 'totals-now.json'));
  return jsonResponse(200, fixture(import.meta.url, before ? 'query-queries-before.json' : 'query-queries.json'));
}

test('the module declares its origin, the access token, the sites picker, and only read tools', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), [ORIGIN]);
  assert.deepEqual(plain(module.credentials), ['access_token']);
  assert.deepEqual(plain(module.accountPickers), [{
    key: 'sites',
    label: 'Search Console properties',
    description: 'The Search Console properties the agent may report on.',
    multiple: true,
    tool: 'list_sites',
    idField: 'id',
    nameField: 'name',
    legacyField: 'siteurl',
  }]);
  assert.deepEqual(plain(module.tools.map((tool) => tool.name)), ['list_sites', 'query_search_analytics', 'compare_periods', 'list_sitemaps', 'inspect_url', 'api_get']);
  assert.ok(module.tools.every((tool) => tool.annotations.readOnlyHint), 'the scope is read-only, so every tool reads');
});

test('the sites picker: list_sites leaves out unverified properties and names Domain and URL-prefix properties', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'sites.json')), null);
  const [picker] = module.accountPickers;
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/webmasters/v3/sites`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.sites, [
    { id: DOMAIN, name: 'example.com', property_type: 'domain', permission_level: 'siteOwner' },
    { id: PREFIX, name: PREFIX, property_type: 'url_prefix', permission_level: 'siteFullUser' },
    { id: 'https://shop.example.org/', name: 'https://shop.example.org/', property_type: 'url_prefix', permission_level: 'siteRestrictedUser' },
  ]);
  assert.equal(payload.unverified_left_out, 1);
  assert.equal(payload.note, undefined, 'no lock, no note');
  assert.deepEqual(payload.sites.map((item) => field(item, picker.idField)), [DOMAIN, PREFIX, 'https://shop.example.org/']);
  assert.ok(payload.sites.every((item) => typeof field(item, picker.nameField) === 'string'));
});

test('list_sites marks the properties chosen for the connection as selected, lists the others too, and says when none is chosen', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'sites.json')));
  const { payload } = await callTool(module, 'list_sites', {}, ctx);
  assert.deepEqual(payload.sites.map((item) => [item.id, item.selected]), [[DOMAIN, true], [PREFIX, true], ['https://shop.example.org/', undefined]]);
  assert.equal(payload.note, undefined);
  assert.match(module.tools.find((tool) => tool.name === 'list_sites').description, /marked selected: true/);

  for (const accounts of [{}, { sites: [] }]) {
    const none = setup(() => jsonResponse(200, fixture(import.meta.url, 'sites.json')), accounts);
    const unchosen = await callTool(none.module, 'list_sites', {}, none.ctx);
    assert.equal(unchosen.isError, false, 'the list itself still answers');
    assert.equal(unchosen.payload.sites.length, 3);
    assert.ok(unchosen.payload.sites.every((item) => !('selected' in item)));
    assert.equal(unchosen.payload.unverified_left_out, 1);
    assert.match(unchosen.payload.note, /^No property is chosen for this connection yet, so every tool that names a property is refused until properties from this list are chosen for it\.$/);
  }
});

test('query_search_analytics posts the query with the property encoded in the path, and pages with start rows', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'query-queries.json')));
  const { payload, isError } = await callTool(module, 'query_search_analytics', {
    site_url: PREFIX,
    start_date: '2026-10-01',
    end_date: '2026-10-28',
    dimensions: ['query'],
    filters: [{ dimension: 'country', expression: 'usa' }, { dimension: 'page', operator: 'contains', expression: '/blog/' }],
    row_limit: 3,
  }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query`);
  assert.deepEqual(fetch.calls[0].json, {
    startDate: '2026-10-01',
    endDate: '2026-10-28',
    dimensions: ['query'],
    type: 'web',
    dimensionFilterGroups: [{ groupType: 'and', filters: [
      { dimension: 'country', operator: 'equals', expression: 'usa' },
      { dimension: 'page', operator: 'contains', expression: '/blog/' },
    ] }],
    rowLimit: 3,
    dataState: 'final',
  });
  assert.deepEqual(payload.rows[0], { query: 'example widgets', clicks: 1204, impressions: 20110, ctr: 0.0599, position: 2.42 });
  assert.equal(payload.site_url, PREFIX);
  assert.equal(payload.start_date, '2026-10-01');
  assert.equal(payload.aggregation, 'byProperty');

  // A full page means more rows may follow.
  await callTool(module, 'query_search_analytics', { site_url: PREFIX, dimensions: ['query'], row_limit: 3, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.startRow, 3);
  assert.equal(fetch.calls[1].json.startDate, '2026-10-01', 'the continuation keeps the first page\'s range');
  assert.equal(fetch.calls.length, 2);
});

test('last_days counts back from the latest day with data, found with a 10-day date query', async () => {
  const { module, fetch, ctx } = setup(analytics);
  const { payload } = await callTool(module, 'query_search_analytics', { site_url: DOMAIN, last_days: 7, dimensions: ['query'] }, ctx);
  assert.equal(fetch.calls.length, 2);
  const probe = fetch.calls[0].json;
  assert.deepEqual(probe.dimensions, ['date']);
  assert.equal(probe.rowLimit, 20);
  assert.equal(addDays(probe.startDate, 10), probe.endDate);
  assert.equal(fetch.calls[1].url, `${ORIGIN}/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query`);
  assert.equal(fetch.calls[1].json.endDate, '2026-11-19');
  assert.equal(fetch.calls[1].json.startDate, '2026-11-13');
  assert.equal(payload.end_date, '2026-11-19');

  const both = await callTool(module, 'query_search_analytics', { site_url: DOMAIN, start_date: '2026-10-01', last_days: 7 }, ctx);
  assert.match(both.payload.error, /Give both start_date and end_date, or last_days/);
  const reversed = await callTool(module, 'query_search_analytics', { site_url: DOMAIN, start_date: '2026-10-09', end_date: '2026-10-01' }, ctx);
  assert.match(reversed.payload.error, /start_date is after end_date/);
  assert.equal(fetch.calls.length, 2);
});

test('compare_periods compares totals and ranks the queries that lost and gained clicks', async () => {
  const { module, fetch, ctx } = setup(analytics);
  const { payload, isError } = await callTool(module, 'compare_periods', { site_url: DOMAIN, dimension: 'query', last_days: 28 }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 5, 'latest day, two totals, two row sets');
  assert.deepEqual(payload.current, { start_date: '2026-10-23', end_date: '2026-11-19' });
  assert.deepEqual(payload.previous, { start_date: '2026-09-25', end_date: '2026-10-22' });
  assert.deepEqual(fetch.calls[2].json, { startDate: '2026-09-25', endDate: '2026-10-22', type: 'web', rowLimit: 1, dataState: 'final' });
  assert.deepEqual(payload.totals.change, { clicks: -720, clicks_pct: -6.4, impressions: 11105, impressions_pct: 2.8, ctr: -0.0025, position: 0.44 });
  assert.deepEqual(payload.losers.map((row) => [row.query, row.change]), [['example widgets', -286], ['cheap widgets', -90]]);
  assert.deepEqual(payload.gainers.map((row) => [row.query, row.change]), [['widget size guide', 230], ['buy widgets online', 132]]);
  assert.deepEqual(payload.losers[0], { query: 'example widgets', clicks_now: 1204, clicks_before: 1490, change: -286, impressions_now: 20110, impressions_before: 21002, position_now: 2.42, position_before: 1.9 });
  assert.deepEqual(payload.rows_compared, { current: 3, previous: 3 });

  const yearly = setup(analytics);
  const year = await callTool(yearly.module, 'compare_periods', { site_url: DOMAIN, start_date: '2024-02-01', end_date: '2024-02-29', compare_to: 'previous_year' }, yearly.ctx);
  assert.deepEqual(year.payload.previous, { start_date: '2023-02-01', end_date: '2023-02-28' });
  assert.equal(yearly.fetch.calls.length, 2, 'totals only, no dimension');
  assert.equal(year.payload.losers, undefined);
});

test('list_sitemaps trims each sitemap and flags one not downloaded since it was submitted', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'sitemaps.json')));
  const { payload } = await callTool(module, 'list_sitemaps', { site_url: PREFIX, sitemap_index: 'https://www.example.com/sitemap.xml' }, ctx);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps?sitemapIndex=https%3A%2F%2Fwww.example.com%2Fsitemap.xml`);
  assert.deepEqual(payload.sitemaps[0], {
    path: 'https://www.example.com/sitemap.xml',
    is_sitemaps_index: true,
    last_submitted: '2026-11-01T08:12:44.120Z',
    last_downloaded: '2026-11-20T02:41:09.553Z',
    errors: 0,
    warnings: 0,
    contents: [{ type: 'web', submitted: 1840 }],
  });
  assert.equal(payload.sitemaps[1].not_downloaded_since_submitted, true);
  assert.equal(payload.sitemaps[1].errors, 1);
  assert.equal(payload.sitemaps[1].is_pending, true);
});

test('inspect_url posts the page and the plain property id, and trims the index status', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'inspect.json')));
  const { payload } = await callTool(module, 'inspect_url', { site_url: DOMAIN, url: 'https://www.example.com/widgets/' }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/v1/urlInspection/index:inspect`);
  assert.deepEqual(fetch.calls[0].json, { inspectionUrl: 'https://www.example.com/widgets/', siteUrl: DOMAIN, languageCode: 'en-US' });
  assert.equal(payload.verdict, 'PASS');
  assert.equal(payload.coverage_state, 'Submitted and indexed');
  assert.equal(payload.google_canonical, 'https://www.example.com/widgets/');
  assert.deepEqual(payload.rich_results, { verdict: 'PASS', detected: [{ type: 'Product snippets', items: 1, issues: [{ message: 'Missing field "aggregateRating"', severity: 'WARNING' }] }] });
  assert.match(payload.report_link, /^https:\/\/search\.google\.com\/search-console\/inspect/);
  assert.equal(payload.mobile_usability, undefined);
});

test('a property outside the chosen ones is refused before anything is sent, by every tool and by api_get', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  for (const [tool, args] of [
    ['query_search_analytics', { site_url: 'sc-domain:example.org', start_date: '2026-10-01', end_date: '2026-10-02' }],
    ['compare_periods', { site_url: 'sc-domain:example.org' }],
    ['list_sitemaps', { site_url: 'sc-domain:example.org' }],
    ['inspect_url', { site_url: 'sc-domain:example.org', url: 'https://example.org/' }],
  ]) {
    const { payload } = await callTool(module, tool, args, ctx);
    assert.match(payload.error, /The site sc-domain:example\.org is not among the sites chosen for this connection\. Use one of: sc-domain:example\.com, https:\/\/www\.example\.com\/\. Nothing was sent\./, tool);
  }
  // A chosen site further down the path (a sitemap URL) does not count.
  const sneaky = await callTool(module, 'api_get', { path: `/webmasters/v3/sites/sc-domain%3Aexample.org/sitemaps/${encodeURIComponent(PREFIX)}` }, ctx);
  assert.match(sneaky.payload.error, /not among the sites chosen/);
  const list = await callTool(module, 'api_get', { path: '/webmasters/v3/sites' }, ctx);
  assert.match(list.payload.error, /names none of the sites chosen/);
  assert.equal(fetch.calls.length, 0);

  const read = await callTool(module, 'api_get', { path: `/webmasters/v3/sites/${encodeURIComponent(DOMAIN)}` }, setup(() => jsonResponse(200, { siteUrl: DOMAIN, permissionLevel: 'siteOwner' })).ctx);
  assert.deepEqual(read.payload, { status: 200, data: { siteUrl: DOMAIN, permissionLevel: 'siteOwner' } });
});

test('errors: a refused property names the likely causes, 429 carries retryAfter, and logs hold no token or arguments', async () => {
  const forbidden = setup(() => jsonResponse(403, fixture(import.meta.url, 'error-forbidden.json')), null);
  const refused = await callTool(forbidden.module, 'query_search_analytics', { site_url: 'sc-domain:example.org', start_date: '2026-10-01', end_date: '2026-10-28' }, forbidden.ctx);
  assert.equal(refused.payload.status, 403);
  assert.match(refused.payload.error, /cannot open this property, it is not verified for it, or the Search Console API is not enabled/);
  assert.match(refused.payload.error, /User does not have sufficient permission/);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '900' }));
  const quota = await callTool(limited.module, 'inspect_url', { site_url: DOMAIN, url: 'https://www.example.com/a' }, limited.ctx);
  assert.equal(quota.payload.retryAfter, 900);

  const logged = [...forbidden.logs, ...limited.logs].join('\n');
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged, /ya29|example\.org|example\.com/);
});
