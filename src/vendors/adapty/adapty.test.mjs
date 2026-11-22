import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const KEY = 'secret_live_TESTabcdefghijklmnop.qrstuvwxyz';
const credentials = { apikey: KEY };
const BASE = 'https://api-admin.adapty.io/api/v1/client-api/metrics';

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts: null, fetch });
  return { module, fetch, ctx, logs };
}

test('get_chart posts the chart request with the Api-Key header and keeps each metric\'s total, points and definition', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'analytics-revenue.json')));
  const { payload, isError } = await callTool(module, 'get_chart', {
    chart_id: 'revenue',
    date_from: '2026-08-01',
    date_to: '2026-10-31',
    compare_from: '2026-05-01',
    compare_to: '2026-07-31',
    filters: { country: ['us'], store: ['app_store'], store_product_id: ['app_store:premium_monthly'] },
    period_unit: 'month',
    segmentation: 'store_product_id',
    timezone: 'Europe/Berlin',
  }, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${BASE}/analytics/`);
  assert.equal(request.headers.authorization, `Api-Key ${KEY}`);
  assert.equal(request.headers['adapty-tz'], 'Europe/Berlin');
  assert.deepEqual(request.json, {
    chart_id: 'revenue',
    filters: {
      date: ['2026-08-01', '2026-10-31'],
      compare_date: ['2026-05-01', '2026-07-31'],
      country: ['us'],
      store: ['app_store'],
      store_product_id: ['app_store:premium_monthly'],
    },
    period_unit: 'month',
    segmentation: 'store_product_id',
    format: 'json',
  });
  assert.deepEqual(payload.dateRange, ['2026-08-01', '2026-10-31']);
  assert.equal(payload.timezone, 'Europe/Berlin');
  const revenue = payload.metrics.revenue;
  assert.equal(revenue.value, 130316.75);
  assert.equal(revenue.compareValueFrom, 118220.4);
  assert.equal(revenue.unit, 'USD');
  assert.equal(revenue.aggregation, 'sum');
  assert.equal(revenue.points.length, 3);
  assert.match(revenue.definition, /^Total money received from both subscriptions and one-time purchases\. .* 5 monthly \$10 subs & 1 yearly \$100 sub$/);
  assert.equal('is_json' in revenue, false);
  assert.equal(payload.metrics.proceeds.value, 110768.74);
});

test('without dates the last 28 full days ending yesterday are asked for, and the chart defaults to revenue', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: {} }));
  await callTool(module, 'get_chart', {}, ctx);
  const { json } = fetch.calls[0];
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  assert.equal(json.chart_id, 'revenue');
  assert.equal(json.period_unit, 'month');
  assert.deepEqual(json.filters.date, [day(28), day(1)]);
});

test('bad ranges and filters are refused before anything is sent', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: {} }));
  const cases = [
    [{ date_from: '2026-10-01' }, /Give date_from and date_to together/],
    [{ date_from: '2026-10-31', date_to: '2026-10-01' }, /date_from must not be after date_to/],
    [{ compare_from: '2026-01-01' }, /Give compare_from and compare_to together/],
    [{ filters: { store_product_id: ['premium_monthly'] } }, /`filters\.store_product_id\[0\]` does not have the expected format/],
    [{ filters: { segment_id: ['not-a-uuid'] } }, /`filters\.segment_id\[0\]` does not have the expected format/],
    [{ filters: { email: ['a@example.com'] } }, /unknown field in `filters` "email"/],
    [{ chart_id: 'revenu' }, /`chart_id` must be one of/],
  ];
  for (const [args, message] of cases) {
    const { payload } = await callTool(module, 'get_chart', args, ctx);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 0);
});

test('a chart too long for one result comes in pages, cut at the same point in every metric', async () => {
  const many = (value) => Array.from({ length: 900 }, (_, index) => ({ date: `day-${index}`, value: value + index, segment: 'app_store:premium_monthly_with_a_long_name' }));
  const big = { data: { revenue: { data: many(1000), value: 1, title: 'revenue', unit: 'USD' }, proceeds: { data: many(800), value: 2, title: 'proceeds', unit: 'USD' } } };
  const { module, fetch, ctx } = setup(() => jsonResponse(200, big));
  const first = await callTool(module, 'get_chart', { date_from: '2024-01-01', date_to: '2026-06-17', period_unit: 'day' }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.metrics.revenue.points.length;
  assert.equal(first.payload.metrics.proceeds.points.length, shown);
  assert.match(first.payload.note, new RegExp(`^Points 1 to ${shown} of 900 are shown`));
  const second = await callTool(module, 'get_chart', { date_from: '2024-01-01', date_to: '2026-06-17', period_unit: 'day', cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.metrics.revenue.points[0].date, `day-${shown}`);
  assert.equal(fetch.calls.length, 2);
});

test('get_conversion sends the period pair, a numeric starting period as a number', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'conversion.json')));
  const { payload } = await callTool(module, 'get_conversion', { from_period: '1', to_period: '6+', date_from: '2026-01-01', date_to: '2026-10-31', period_unit: 'month' }, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/conversion/`);
  assert.deepEqual(fetch.calls[0].json, { filters: { date: ['2026-01-01', '2026-10-31'] }, from_period: 1, to_period: '6+', period_unit: 'month', format: 'json' });
  assert.equal(payload.title, 'Conversion rate from Paid to more than 6 months');
  assert.equal(payload.value, 20.6);
  assert.equal(payload.unit, 'percent');
  assert.equal(payload.points.length, 2);
});

test('get_funnel, get_retention, get_ltv and get_cohorts call their endpoints with their own fields', async () => {
  const replies = {
    '/api/v1/client-api/metrics/funnel/': fixture(import.meta.url, 'funnel.json'),
    '/api/v1/client-api/metrics/retention/': fixture(import.meta.url, 'retention.json'),
    '/api/v1/client-api/metrics/ltv/': fixture(import.meta.url, 'ltv.json'),
    '/api/v1/client-api/metrics/cohort/': fixture(import.meta.url, 'cohort.json'),
  };
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, replies[request.path]));
  const range = { date_from: '2026-08-01', date_to: '2026-10-31' };

  const funnel = await callTool(module, 'get_funnel', range, ctx);
  assert.equal(fetch.calls[0].json.show_value_as, 'both');
  assert.equal(funnel.payload.segments[0].type, 'total');
  assert.equal(funnel.payload.segments[0].values[1].following_changes.value, 61200);

  const retention = await callTool(module, 'get_retention', { ...range, use_trial: true }, ctx);
  assert.equal(fetch.calls[1].json.use_trial, true);
  assert.equal(retention.payload.title, 'Subscription retention');
  assert.equal(retention.payload.rows[0].values[2].value, 48.2);

  const ltv = await callTool(module, 'get_ltv', { ...range, period_unit: 'month', period_type: 'renewals' }, ctx);
  assert.deepEqual(fetch.calls[2].json, { filters: { date: ['2026-08-01', '2026-10-31'] }, period_unit: 'month', period_type: 'renewals', format: 'json' });
  assert.equal(ltv.payload.bases.revenue.value, 38.4);
  assert.equal(ltv.payload.bases.revenue.definition, 'Realized LTV.');
  assert.equal(ltv.payload.bases.revenue.points[0].cohort_size, 5210);
  assert.equal(ltv.payload.bases.net_revenue.value, 29.9);

  const cohorts = await callTool(module, 'get_cohorts', { ...range, accounting_type: 'proceeds', value_field: 'revenue' }, ctx);
  assert.deepEqual(fetch.calls[3].json, {
    filters: { date: ['2026-08-01', '2026-10-31'] },
    period_unit: 'month',
    period_type: 'renewals',
    value_type: 'absolute',
    value_field: 'revenue',
    accounting_type: 'proceeds',
    prediction_months: 12,
    format: 'json',
  });
  assert.equal(cohorts.payload.cohorts[0].total_proceeds_usd, 52020.43);
  assert.equal(cohorts.payload.cohorts[0].values[1].currently_active_period, true);
  assert.equal(cohorts.payload.accountingType, 'proceeds');
});

test('every tool is a read: the POSTs are marked safe and only the six analytics endpoints exist', async () => {
  const { module } = setup(() => jsonResponse(200, {}));
  assert.deepEqual([...module.tools].map((tool) => tool.name), ['get_chart', 'get_conversion', 'get_funnel', 'get_retention', 'get_ltv', 'get_cohorts']);
  assert.ok(module.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.deepEqual([...module.origins], ['https://api-admin.adapty.io']);
});

test('errors: a refused request gets the status and a hint, a 429 asks to wait, a 401 says to replace the key', async () => {
  const refused = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-400.json')));
  const bad = await callTool(refused.module, 'get_chart', {}, refused.ctx);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /^Adapty did not accept the request: .* \(HTTP 400\)\./);

  const limited = setup(() => jsonResponse(429, { errors: [], error_code: 'throttled', status_code: 429 }));
  const rate = await callTool(limited.module, 'get_funnel', {}, limited.ctx);
  assert.match(rate.payload.error, /^Adapty rate limit reached \(HTTP 429\)\. Wait a while before retrying\.$/);

  const rejected = setup(() => jsonResponse(401, { errors: [{ source: 'non_field_errors', errors: ['Invalid API key'] }], error_code: 'not_authenticated', status_code: 401 }));
  const unauthorized = await callTool(rejected.module, 'get_cohorts', {}, rejected.ctx);
  assert.match(unauthorized.payload.error, /^Adapty rejected the API key: it was replaced or mistyped/);
});

test('log lines carry no key and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, fixture(import.meta.url, 'funnel.json')));
  await callTool(module, 'get_funnel', { filters: { attribution_campaign: ['secret-campaign'] } }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^adapty get_funnel POST 200 \d+ms$/);
  assert.equal(logs[0].includes(KEY), false);
  assert.equal(logs[0].includes('secret-campaign'), false);
});
