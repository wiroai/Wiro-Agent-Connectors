import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.example-ads-token';
const DEV = 'EXAMPLE-DEV-TOKEN';
const ORIGIN = 'https://googleads.googleapis.com';
const CUSTOMER = '1112223333';
const MANAGER = '4445556666';
/** A client account below MANAGER (customer-clients.json), which the Google account does not open directly. */
const CLIENT = '1231231234';
const LOOKUP = '/v26/customers:listAccessibleCustomers';
const QUERY = 'SELECT campaign.id, campaign.name FROM campaign';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function setup(handler, { accounts = { customers: [CUSTOMER] }, credentials = { access_token: TOKEN } } = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

/** Google Ads where the Google account opens CUSTOMER directly: the account lookup is answered, every other request goes to `handler`. */
const direct = (handler) => (request) => (request.path === LOOKUP ? jsonResponse(200, { resourceNames: [`customers/${CUSTOMER}`] }) : handler(request));

/** The requests a call sent besides the account lookup. */
const sent = (fetch) => fetch.calls.filter((call) => call.path !== LOOKUP);

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);
const plain = (value) => JSON.parse(JSON.stringify(value));

// A 1 x 1 PNG's first bytes: the module tells the type from them.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

/**
 * Google Ads with three accounts opened directly (accessible-customers.json), MANAGER managing the accounts in
 * `below`, and 7778889999 not enabled; any other request gets `answer`.
 */
function hierarchy({ answer = () => jsonResponse(200, fixture(import.meta.url, 'search-campaigns.json')), below = [CLIENT] } = {}) {
  return (request) => {
    if (request.path === LOOKUP) return jsonResponse(200, fixture(import.meta.url, 'accessible-customers.json'));
    const customer = request.path.split('/')[3];
    const query = request.json?.query ?? '';
    if (customer === '7778889999') return jsonResponse(403, fixture(import.meta.url, 'error-not-enabled.json'));
    if (query.startsWith('SELECT customer_client.id FROM customer_client WHERE')) {
      const asked = query.split('= ')[1];
      if (customer !== MANAGER || !below.includes(asked)) return jsonResponse(200, { fieldMask: 'customerClient.id' });
      return jsonResponse(200, asked === CLIENT
        ? fixture(import.meta.url, 'customer-client-match.json')
        : { results: [{ customerClient: { resourceName: `customers/${MANAGER}/customerClients/${asked}`, id: asked } }], fieldMask: 'customerClient.id' });
    }
    if (customer === MANAGER) return jsonResponse(200, fixture(import.meta.url, query.includes('FROM customer_client') ? 'customer-clients.json' : 'customer-manager.json'));
    if (customer === CUSTOMER && query.includes('FROM customer LIMIT 1')) return jsonResponse(200, fixture(import.meta.url, 'customer-direct.json'));
    return answer(request);
  };
}

test('the module declares the access token as required and the developer token and manager ID as optional, with the customers picker', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), [ORIGIN]);
  assert.deepEqual(plain(module.credentials), ['access_token', 'developertoken', 'managercustomerid']);
  assert.deepEqual(plain(module.requiredCredentials), [['access_token']]);
  assert.deepEqual(plain(module.accountPickers), [{
    key: 'customers',
    label: 'Google Ads accounts',
    description: 'The Google Ads accounts the agent may report on and change.',
    multiple: true,
    tool: 'list_customers',
    idField: 'id',
    nameField: 'name',
    legacyField: 'customerid',
  }]);
  const kinds = Object.fromEntries(module.tools.map((tool) => [tool.name, tool.annotations]));
  for (const name of ['list_customers', 'search', 'generate_keyword_ideas', 'hash_user_identifiers', 'api_get']) assert.equal(kinds[name].readOnlyHint, true, name);
  assert.deepEqual([kinds.mutate.destructiveHint, kinds.mutate.idempotentHint], [true, false]);
  assert.deepEqual([kinds.upload_customer_match.destructiveHint, kinds.upload_customer_match.idempotentHint], [true, false]);
  assert.deepEqual([kinds.upload_image_asset.readOnlyHint, kinds.upload_image_asset.destructiveHint], [false, false]);
  const request = module.tools.find((tool) => tool.name === 'api_request');
  assert.deepEqual(plain(request.inputSchema.properties.method.enum), ['POST']);
  assert.ok(request.inputSchema.properties.login_customer_id);
  assert.match(request.description, /check with search \(GAQL\)/);
  // JSON bodies only: a body sent as text would pass the account lock unread.
  assert.deepEqual(Object.keys(request.inputSchema.properties).sort(), ['json', 'login_customer_id', 'method', 'path', 'query']);
  assert.doesNotMatch(request.description, /content_type/);
  for (const tool of module.tools) assert.ok(tool.description.length <= 1024, tool.name);
});

test('the customers picker lists direct accounts, the clients of manager accounts with their login ID, and inaccessible ones', async () => {
  const { module, fetch, ctx } = setup(hierarchy(), { accounts: null, credentials: { access_token: TOKEN, developertoken: DEV } });
  const [picker] = module.accountPickers;
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/v26/customers:listAccessibleCustomers`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(fetch.calls.every((call) => call.headers['developer-token'] === undefined), 'an old developer token is never sent: Google ignores it and will refuse it');
  const detail = fetch.calls.find((call) => call.path === `/v26/customers/${CUSTOMER}/googleAds:search`);
  assert.equal(detail.method, 'POST');
  assert.equal(detail.headers['login-customer-id'], CUSTOMER, 'each account is read as itself');
  assert.match(detail.json.query, /FROM customer LIMIT 1/);
  assert.deepEqual(payload.customers, [
    { id: '1112223333', name: 'Example Store', status: 'ENABLED', manager: false, currency_code: 'USD', time_zone: 'America/Los_Angeles' },
    { id: '4445556666', name: 'Example Agency MCC', status: 'ENABLED', manager: true, currency_code: 'USD', time_zone: 'America/New_York' },
    { id: '1231231234', name: 'Client Bakery', status: 'ENABLED', manager: false, currency_code: 'EUR', time_zone: 'Europe/Berlin', level: 1, login_customer_id: MANAGER },
    { id: '9876543210', name: 'Client Florist', status: 'SUSPENDED', manager: false, currency_code: 'GBP', time_zone: 'Europe/London', level: 2, login_customer_id: MANAGER },
    { id: '7778889999', name: '7778889999', status: 'NOT_ACCESSIBLE', note: 'Google Ads answered HTTP 403 for this account.' },
  ]);
  assert.equal(payload.accessible_accounts, 3);
  assert.ok(payload.customers.every((item) => /^[0-9]{10}$/.test(field(item, picker.idField)) && typeof field(item, picker.nameField) === 'string'));
  assert.equal(payload.nextCursor, undefined);
});

test('list_customers marks the accounts chosen for the connection as selected, client accounts included', async () => {
  const { module, ctx } = setup(hierarchy(), { accounts: { customers: [CUSTOMER, '9876543210', '7778889999'] } });
  const { payload } = await callTool(module, 'list_customers', {}, ctx);
  assert.deepEqual(payload.customers.map((item) => [item.id, item.selected]), [
    ['1112223333', true],
    ['4445556666', undefined],
    ['1231231234', undefined],
    ['9876543210', true],
    ['7778889999', true],
  ]);
  assert.match(module.tools.find((tool) => tool.name === 'list_customers').description, /marked selected: true/);
});

test('list_customers reads accounts ten at a time and continues with the cursor', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => String(2000000000 + index));
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith(':listAccessibleCustomers')) return jsonResponse(200, { resourceNames: ids.map((id) => `customers/${id}`) });
    const id = request.path.split('/')[3];
    return jsonResponse(200, { results: [{ customer: { id, descriptiveName: `Account ${id}`, manager: false, status: 'ENABLED' } }] });
  }, { accounts: null });
  const first = await callTool(module, 'list_customers', {}, ctx);
  assert.equal(first.payload.customers.length, 10);
  assert.equal(fetch.calls.length, 11);
  const second = await callTool(module, 'list_customers', { cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(second.payload.customers.map((item) => item.id), ['2000000010']);
  assert.equal(second.payload.nextCursor, undefined);
});

test('search posts GAQL for a chosen account and returns flat rows named like the query, paging with the page token', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'search-campaigns.json')), { credentials: { access_token: TOKEN, managercustomerid: '444-555-6666' } });
  const query = 'SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS';
  const { payload, isError } = await callTool(module, 'search', { customer_id: '111-222-3333', query }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/v26/customers/${CUSTOMER}/googleAds:search`);
  assert.deepEqual(fetch.calls[0].json, { query });
  assert.equal(fetch.calls[0].headers['login-customer-id'], MANAGER, 'the connection\'s manager account, dashes removed');
  assert.equal(fetch.calls[0].headers['developer-token'], undefined);
  assert.deepEqual(payload.rows[0], {
    'campaign.resource_name': 'customers/1112223333/campaigns/20001',
    'campaign.status': 'ENABLED',
    'campaign.advertising_channel_type': 'SEARCH',
    'campaign.name': 'Shoes - Search - US',
    'campaign.id': '20001',
    'metrics.clicks': '1234',
    'metrics.cost_micros': '555300000',
    'metrics.impressions': '56789',
    'metrics.ctr': 0.02173,
    'metrics.average_cpc': 450000,
    'metrics.conversions': 15,
    'campaign_budget.resource_name': 'customers/1112223333/campaignBudgets/30001',
    'campaign_budget.amount_micros': '20000000',
  });
  assert.equal(payload.customer_id, CUSTOMER);

  await callTool(module, 'search', { customer_id: CUSTOMER, query, login_customer_id: '9998887777', cursor: payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].json, { query, pageToken: 'CJ6R2KmCMxIAGAE' });
  assert.equal(fetch.calls[1].headers['login-customer-id'], '9998887777', 'the argument wins over the connection\'s manager account');

  const refused = await callTool(module, 'search', { customer_id: '9998887777', query }, ctx);
  assert.match(refused.payload.error, /The Google Ads account 9998887777 is not among the Google Ads accounts chosen for this connection\. Use one of: 1112223333\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 2, 'no account lookup either: the connection names its manager account');
});

test('search reads a full 10,000-row page over 4 MB and returns its first rows with a cursor', async () => {
  const row = (index) => ({
    keywordView: { resourceName: `customers/${CUSTOMER}/keywordViews/40001~${70000000 + index}` },
    adGroupCriterion: { keyword: { text: `example keyword number ${index} with a few more words`, matchType: 'PHRASE' }, criterionId: String(70000000 + index) },
    metrics: { clicks: String(index), impressions: String(index * 20), costMicros: String(index * 1000), conversions: 0.5 },
    segments: { date: '2026-11-01' },
  });
  // Google's replies are indented, about 1 KB a row for a keyword report.
  const body = JSON.stringify({ results: Array.from({ length: 10000 }, (_, index) => row(index)), nextPageToken: 'page-2', fieldMask: 'keywordView.resourceName' }, null, 2);
  assert.ok(Buffer.byteLength(body) > 4 * 1024 * 1024 && Buffer.byteLength(body) < 8 * 1024 * 1024, `${Buffer.byteLength(body)} bytes`);
  const { module, ctx } = setup(direct(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
  const { result, payload, isError } = await callTool(module, 'search', { customer_id: CUSTOMER, query: 'SELECT keyword_view.resource_name FROM keyword_view WHERE segments.date DURING LAST_30_DAYS' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 32 * 1024);
  assert.equal(payload.truncated, true);
  assert.ok(payload.rows.length > 10 && payload.nextCursor);
  assert.equal(payload.rows[0]['ad_group_criterion.keyword.text'], 'example keyword number 0 with a few more words');
  assert.match(module.tools.find((tool) => tool.name === 'search').description, /bound a query that can match more than a few thousand rows/);
});

test('search keeps lists such as responsive search ad headlines whole, with snake_case keys', async () => {
  const { module, ctx } = setup(direct(() => jsonResponse(200, fixture(import.meta.url, 'search-ads.json'))));
  const { payload } = await callTool(module, 'search', { customer_id: CUSTOMER, query: 'SELECT ad_group_ad.ad.responsive_search_ad.headlines FROM ad_group_ad' }, ctx);
  assert.deepEqual(payload.rows[0]['ad_group_ad.ad.responsive_search_ad.headlines'], [{ text: 'Example Store Shoes', pinned_field: 'HEADLINE_1' }, { text: 'Free Returns' }]);
  assert.deepEqual(payload.rows[0]['ad_group_ad.ad.final_urls'], ['https://shop.example.com/shoes']);
  assert.equal(payload.rows[0]['ad_group_ad.ad_strength'], 'GOOD');
});

test('login: an account the Google account opens directly goes without login-customer-id, after one lookup per access token', async () => {
  const { module, fetch, ctx } = setup(direct(() => jsonResponse(200, fixture(import.meta.url, 'search-campaigns.json'))));
  await callTool(module, 'search', { customer_id: CUSTOMER, query: QUERY }, ctx);
  await callTool(module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: {} }], validate_only: true }, ctx);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    `GET ${LOOKUP}`,
    `POST /v26/customers/${CUSTOMER}/googleAds:search`,
    `POST /v26/customers/${CUSTOMER}/googleAds:mutate`,
  ]);
  assert.ok(fetch.calls.every((call) => call.headers['login-customer-id'] === undefined));
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);

  // A new access token (the next sign-in, or another Google account) is looked up again.
  await callTool(module, 'search', { customer_id: CUSTOMER, query: QUERY }, { ...ctx, credentials: { access_token: 'ya29.another-token' } });
  assert.equal(fetch.calls.filter((call) => call.path === LOOKUP).length, 2);
});

test('login: a client account goes through the manager account found above it, and that is kept', async () => {
  const { module, fetch, ctx } = setup(hierarchy(), { accounts: { customers: [CLIENT] } });
  const { payload, isError } = await callTool(module, 'search', { customer_id: CLIENT, query: QUERY }, ctx);
  assert.equal(isError, false, payload.error);
  const asked = `SELECT customer_client.id FROM customer_client WHERE customer_client.id = ${CLIENT}`;
  assert.deepEqual(fetch.calls.map((call) => [call.path, call.json?.query, call.headers['login-customer-id']]), [
    [LOOKUP, undefined, undefined],
    [`/v26/customers/${CUSTOMER}/googleAds:search`, asked, CUSTOMER],
    [`/v26/customers/${MANAGER}/googleAds:search`, asked, MANAGER],
    [`/v26/customers/${CLIENT}/googleAds:search`, QUERY, MANAGER],
  ]);
  await callTool(module, 'generate_keyword_ideas', { customer_id: CLIENT, keywords: ['shoes'] }, ctx);
  assert.equal(fetch.calls.length, 5, 'the manager account is kept: no second lookup');
  assert.equal(fetch.calls[4].headers['login-customer-id'], MANAGER);
});

test('login: list_customers keeps each client account\'s manager, and managers are asked first', async () => {
  // 5556667777 is a level-3 client below MANAGER, which list_customers does not list.
  const { module, fetch, ctx } = setup(hierarchy({ below: [CLIENT, '5556667777'] }), { accounts: null });
  await callTool(module, 'list_customers', {}, ctx);
  const listed = fetch.calls.length;
  await callTool(module, 'search', { customer_id: CLIENT, query: QUERY }, ctx);
  assert.equal(fetch.calls.length, listed + 1, 'no lookup');
  assert.equal(fetch.calls.at(-1).headers['login-customer-id'], MANAGER);
  await callTool(module, 'search', { customer_id: CUSTOMER, query: QUERY }, ctx);
  assert.equal(fetch.calls.at(-1).headers['login-customer-id'], undefined, 'an account opened directly needs none');

  await callTool(module, 'search', { customer_id: '5556667777', query: QUERY }, ctx);
  const asked = fetch.calls.slice(listed + 2);
  assert.deepEqual(asked.map((call) => [call.path.split('/')[3], call.headers['login-customer-id']]), [
    [MANAGER, MANAGER],
    ['5556667777', MANAGER],
  ], 'the known manager is asked first; the account seen not to be a manager is not asked');
});

test('login: an account no manager account leads to goes without it, Google Ads asks for login_customer_id, and the search is not repeated', async () => {
  const { module, fetch, ctx } = setup(hierarchy({ answer: () => jsonResponse(403, fixture(import.meta.url, 'error-user-permission-denied.json')) }), { accounts: null });
  const first = await callTool(module, 'mutate', { customer_id: '9998887777', operations: [{ campaignOperation: {} }] }, ctx);
  assert.match(first.payload.error, /reached through a manager account \(give login_customer_id\)/);
  assert.match(first.payload.error, /Nothing was changed/);
  assert.equal(first.payload.outcome, undefined);
  const write = fetch.calls.at(-1);
  assert.equal(write.path, '/v26/customers/9998887777/googleAds:mutate');
  assert.equal(write.headers['login-customer-id'], undefined);
  // The three accounts were asked (one could not be: HTTP 403); none manages the account.
  assert.equal(fetch.calls.filter((call) => call.json?.query?.startsWith('SELECT customer_client.id')).length, 3);
  const before = fetch.calls.length;
  await callTool(module, 'search', { customer_id: '9998887777', query: QUERY }, ctx);
  assert.equal(fetch.calls.length, before + 1, 'what was not found is kept too');
});

test('login: the call\'s argument and the connection\'s manager account ID go first, with no lookup', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { results: [] }));
  await callTool(module, 'search', { customer_id: CUSTOMER, query: QUERY, login_customer_id: '444-555-6666' }, ctx);
  assert.deepEqual(fetch.calls.map((call) => [call.path, call.headers['login-customer-id']]), [[`/v26/customers/${CUSTOMER}/googleAds:search`, MANAGER]]);
  const withManager = setup(() => jsonResponse(200, { results: [] }), { credentials: { access_token: TOKEN, managercustomerid: MANAGER } });
  await callTool(withManager.module, 'api_get', { path: `/v26/customers/${CUSTOMER}/operations/1` }, withManager.ctx);
  assert.deepEqual(withManager.fetch.calls.map((call) => [call.path, call.headers['login-customer-id']]), [[`/v26/customers/${CUSTOMER}/operations/1`, MANAGER]]);
});

test('login: a lookup that fails stops the call before its own request, so a write changed nothing', async () => {
  const unauthorized = setup((request) => (request.path === LOOKUP
    ? jsonResponse(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
    : jsonResponse(200, {})));
  const refused = await callTool(unauthorized.module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: {} }] }, unauthorized.ctx);
  assert.match(refused.payload.error, /Google Ads rejected the credentials \(HTTP 401\)/);
  assert.match(refused.payload.error, /Nothing was changed/);
  assert.equal(refused.payload.outcome, undefined);
  assert.equal(unauthorized.fetch.calls.length, 1, 'only the lookup');

  const down = setup((request) => (request.path === LOOKUP ? jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }) : jsonResponse(200, {})));
  const unavailable = await callTool(down.module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: '1', emails: ['a@example.com'] }, down.ctx);
  assert.match(unavailable.payload.error, /server error \(HTTP 503\).*Nothing was changed/);
  assert.equal(unavailable.payload.outcome, undefined);
  assert.equal(down.fetch.calls.length, 1);
});

test('login: the generic tools find it once the account lock passed the path, and refuse other accounts before any lookup', async () => {
  const { module, fetch, ctx } = setup(hierarchy({ answer: () => jsonResponse(200, { results: [] }) }), { accounts: { customers: [CLIENT] } });
  const applied = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CLIENT}/campaigns:mutate`, json: { operations: [] } }, ctx);
  assert.equal(applied.isError, false, applied.payload.error);
  assert.equal(fetch.calls.at(-1).path, `/v26/customers/${CLIENT}/campaigns:mutate`);
  assert.equal(fetch.calls.at(-1).headers['login-customer-id'], MANAGER);
  const before = fetch.calls.length;
  const other = await callTool(module, 'api_get', { path: '/v26/customers/9998887777/campaigns/1' }, ctx);
  assert.match(other.payload.error, /The Google Ads account 9998887777 is not among/);
  assert.equal(fetch.calls.length, before, 'nothing sent, the lookup included');
  await callTool(module, 'api_get', { path: '/v26/googleAdsFields/campaign.name' }, ctx);
  assert.equal(fetch.calls.at(-1).headers['login-customer-id'], undefined, 'a path that names no account needs no login');
});

test('mutate sends the operations once and names each created resource; another account in the operations is refused', async () => {
  const { module, fetch, ctx } = setup(direct(() => jsonResponse(200, fixture(import.meta.url, 'mutate-created.json'))));
  const operations = [
    { campaignBudgetOperation: { create: { resourceName: `customers/${CUSTOMER}/campaignBudgets/-1`, name: 'Budget', amountMicros: 20000000, deliveryMethod: 'STANDARD' } } },
    { campaignOperation: { create: { resourceName: `customers/${CUSTOMER}/campaigns/-2`, name: 'Shoes - Search', status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: `customers/${CUSTOMER}/campaignBudgets/-1`, targetSpend: {} } } },
    { adGroupOperation: { create: { resourceName: `customers/${CUSTOMER}/adGroups/-3`, campaign: `customers/${CUSTOMER}/campaigns/-2`, name: 'Main', status: 'PAUSED' } } },
    { adGroupAdOperation: { create: { adGroup: `customers/${CUSTOMER}/adGroups/-3`, status: 'PAUSED', ad: { finalUrls: ['https://shop.example.com'] } } } },
  ];
  const { payload, isError } = await callTool(module, 'mutate', { customer_id: CUSTOMER, operations }, ctx);
  assert.equal(isError, false);
  assert.equal(sent(fetch)[0].url, `${ORIGIN}/v26/customers/${CUSTOMER}/googleAds:mutate`);
  assert.deepEqual(sent(fetch)[0].json, { mutateOperations: operations });
  assert.deepEqual(payload.results, [
    { type: 'campaign_budget', resource_name: 'customers/1112223333/campaignBudgets/30003' },
    { type: 'campaign', resource_name: 'customers/1112223333/campaigns/20003' },
    { type: 'ad_group', resource_name: 'customers/1112223333/adGroups/40003' },
    { type: 'ad_group_ad', resource_name: 'customers/1112223333/adGroupAds/40003~50003' },
  ]);

  const cross = await callTool(module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: { update: { resourceName: 'customers/9998887777/campaigns/1', status: 'PAUSED' }, updateMask: 'status' } }] }, ctx);
  assert.match(cross.payload.error, /The Google Ads account 9998887777 is not among the Google Ads accounts chosen/);
  const padded = await callTool(module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: { update: { resourceName: `customers/0${CUSTOMER}/campaigns/1`, status: 'PAUSED' }, updateMask: 'status' } }] }, ctx);
  assert.match(padded.payload.error, /The Google Ads account 01112223333 is not among the Google Ads accounts chosen/);
  const open = setup(direct(() => jsonResponse(200, {})), { accounts: null });
  const crossOpen = await callTool(open.module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: { update: { resourceName: 'customers/9998887777/campaigns/1', status: 'PAUSED' }, updateMask: 'status' } }] }, open.ctx);
  assert.match(crossOpen.payload.error, /name another account \(9998887777\) than 1112223333/);
  assert.equal(sent(fetch).length + open.fetch.calls.length, 1);

  // A final URL whose path holds "/customers/<digits>" names no account.
  const shop = setup(direct(() => jsonResponse(200, { mutateOperationResponses: [{ adGroupAdResult: { resourceName: `customers/${CUSTOMER}/adGroupAds/40003~50004` } }] })));
  const ad = { adGroupAdOperation: { create: { adGroup: `customers/${CUSTOMER}/adGroups/40003`, ad: { finalUrls: ['https://shop.example.com/customers/9998887777/welcome'] } } } };
  const shopped = await callTool(shop.module, 'mutate', { customer_id: CUSTOMER, operations: [ad] }, shop.ctx);
  assert.equal(shopped.isError, false, shopped.payload.error);
  assert.equal(sent(shop.fetch).length, 1);
});

test('a mutate with many operations still returns a result that fits, listing the first resources and the total', async () => {
  const responses = Array.from({ length: 1000 }, (_, index) => ({ adGroupCriterionResult: { resourceName: `customers/${CUSTOMER}/adGroupCriteria/40001~${70000000 + index}` } }));
  const { module, ctx } = setup(direct(() => jsonResponse(200, { mutateOperationResponses: responses })));
  const operations = Array.from({ length: 1000 }, () => ({ adGroupCriterionOperation: { create: {} } }));
  const { result, payload, isError } = await callTool(module, 'mutate', { customer_id: CUSTOMER, operations }, ctx);
  assert.equal(isError, false);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 32 * 1024);
  assert.equal(payload.results_total, 1000);
  assert.ok(payload.results.length > 100 && payload.results.length < 1000);
  assert.match(payload.results_note, /search lists the rest/);
});

test('mutate reports partial failures with the operation and field, and validate_only changes nothing', async () => {
  const partial = setup(direct(() => jsonResponse(200, fixture(import.meta.url, 'mutate-partial.json'))));
  const result = await callTool(partial.module, 'mutate', { customer_id: CUSTOMER, partial_failure: true, operations: [{ adGroupCriterionOperation: { create: {} } }, { adGroupCriterionOperation: { create: {} } }] }, partial.ctx);
  assert.equal(sent(partial.fetch)[0].json.partialFailure, true);
  assert.deepEqual(result.payload.failures, [{
    operation: 1,
    message: 'Too long.',
    error_code: 'string_length_error: TOO_LONG',
    field: 'mutate_operations[1].ad_group_criterion_operation.create.keyword.text',
  }]);
  assert.equal(result.payload.results[0].resource_name, 'customers/1112223333/adGroupCriteria/40001~60001');

  const validate = setup(direct(() => jsonResponse(200, { mutateOperationResponses: [{}] })));
  const checked = await callTool(validate.module, 'mutate', { customer_id: CUSTOMER, validate_only: true, operations: [{ campaignOperation: { update: { resourceName: `customers/${CUSTOMER}/campaigns/20001`, status: 'PAUSED' }, updateMask: 'status' } }] }, validate.ctx);
  assert.equal(sent(validate.fetch)[0].json.validateOnly, true);
  assert.deepEqual(checked.payload, { customer_id: CUSTOMER, validate_only: true, valid: true });

  // A validation that fails on the server is a plain failure: nothing could have changed.
  const flaky = setup(direct(() => jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } })));
  const failed = await callTool(flaky.module, 'mutate', { customer_id: CUSTOMER, validate_only: true, operations: [{ campaignOperation: {} }] }, flaky.ctx);
  assert.equal(failed.payload.outcome, undefined);
  assert.match(failed.payload.error, /server error/);
});

test('mutate and the other writes report an unclear outcome once, with search as the check', async () => {
  const broken = setup(direct(() => jsonResponse(500, { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } })));
  const unknown = await callTool(broken.module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: {} }] }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'search');
  assert.equal(sent(broken.fetch).length, 1);

  const timeout = setup(direct(() => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  }));
  const generic = await callTool(timeout.module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}/recommendations:apply`, json: { operations: [{ resourceName: `customers/${CUSTOMER}/recommendations/abc` }] } }, timeout.ctx);
  assert.equal(generic.payload.outcome, 'unknown');
  assert.equal(generic.payload.check, 'search');
  assert.equal(sent(timeout.fetch).length, 1);
});

test('upload_image_asset downloads the image, checks its type and creates the asset with its bytes in base64', async () => {
  const { module, fetch, ctx } = setup(direct((request) => (request.origin === ORIGIN
    ? jsonResponse(200, { results: [{ resourceName: `customers/${CUSTOMER}/assets/70001` }] })
    : bytesResponse(200, PNG, { 'content-type': 'application/octet-stream' }))));
  const assets = () => fetch.calls.filter((call) => call.path.endsWith('/assets:mutate'));
  const { payload } = await callTool(module, 'upload_image_asset', { customer_id: CUSTOMER, image_url: 'https://cdn.example.com/banner.png', name: 'Spring sale - square', login_customer_id: MANAGER }, ctx);
  assert.equal(fetch.calls[0].url, 'https://cdn.example.com/banner.png');
  assert.equal(fetch.calls[0].headers.authorization, undefined, 'no credential goes to the media URL');
  assert.equal(fetch.calls[1].url, `${ORIGIN}/v26/customers/${CUSTOMER}/assets:mutate`);
  assert.equal(fetch.calls[1].headers['login-customer-id'], MANAGER);
  assert.deepEqual(fetch.calls[1].json, { operations: [{ create: { name: 'Spring sale - square', type: 'IMAGE', imageAsset: { data: Buffer.from(PNG).toString('base64') } } }] });
  assert.deepEqual(payload, { customer_id: CUSTOMER, resource_name: 'customers/1112223333/assets/70001', mime_type: 'image/png', bytes: PNG.length });

  // Google Ads wants a unique name for an image asset: one left out becomes the file name and the time.
  await callTool(module, 'upload_image_asset', { customer_id: CUSTOMER, image_url: 'https://cdn.example.com/img/spring%20banner.png?v=2' }, ctx);
  assert.match(assets()[1].json.operations[0].create.name, /^spring banner\.png [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
  assert.equal(assets()[1].headers['login-customer-id'], undefined, 'an account opened directly');
  await callTool(module, 'upload_image_asset', { customer_id: CUSTOMER, image_url: 'https://cdn.example.com/' }, ctx);
  assert.match(assets()[2].json.operations[0].create.name, /^Image [0-9]{4}-/);

  const text = setup(direct(() => textResponse(200, 'not an image')));
  const refused = await callTool(text.module, 'upload_image_asset', { customer_id: CUSTOMER, image_url: 'https://cdn.example.com/x.png' }, text.ctx);
  assert.match(refused.payload.error, /not a JPEG, PNG or GIF/);
  assert.equal(text.fetch.calls.length, 1, 'only the download');
});

test('generate_keyword_ideas sends the seeds, language and locations, and returns ideas with numbers', async () => {
  const { module, fetch, ctx } = setup(direct(() => jsonResponse(200, fixture(import.meta.url, 'keyword-ideas.json'))));
  const { payload } = await callTool(module, 'generate_keyword_ideas', { customer_id: CUSTOMER, keywords: ['trail running shoes'], url: 'https://shop.example.com/trail', geo_target_constants: ['2840'] }, ctx);
  assert.equal(sent(fetch)[0].url, `${ORIGIN}/v26/customers/${CUSTOMER}:generateKeywordIdeas`);
  assert.deepEqual(sent(fetch)[0].json, {
    language: 'languageConstants/1000',
    geoTargetConstants: ['geoTargetConstants/2840'],
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    pageSize: 50,
    keywordAndUrlSeed: { url: 'https://shop.example.com/trail', keywords: ['trail running shoes'] },
  });
  assert.deepEqual(payload.ideas[0], { text: 'trail running shoes', avg_monthly_searches: 27100, competition: 'HIGH', competition_index: 86, low_top_of_page_bid_micros: '650000', high_top_of_page_bid_micros: '2410000' });
  assert.equal(payload.total, 812);
  await callTool(module, 'generate_keyword_ideas', { customer_id: CUSTOMER, site: 'example.com', cursor: payload.nextCursor }, ctx);
  assert.deepEqual(sent(fetch)[1].json.siteSeed, { site: 'example.com' });
  assert.equal(sent(fetch)[1].json.pageToken, 'keyword-ideas-page-2');

  const none = await callTool(module, 'generate_keyword_ideas', { customer_id: CUSTOMER }, ctx);
  assert.match(none.payload.error, /Give seed keywords, a url, both, or a site/);
  assert.equal(sent(fetch).length, 2);
});

test('upload_customer_match hashes normalized identifiers, then creates, fills and runs one job', async () => {
  const job = `customers/${CUSTOMER}/offlineUserDataJobs/80001`;
  const { module, fetch, ctx } = setup(direct((request) => {
    if (request.path.endsWith('offlineUserDataJobs:create')) return jsonResponse(200, { resourceName: job });
    if (request.path.endsWith(':addOperations')) return jsonResponse(200, {});
    return jsonResponse(200, { name: `customers/${CUSTOMER}/operations/90001` });
  }));
  const { payload, isError } = await callTool(module, 'upload_customer_match', {
    customer_id: CUSTOMER,
    user_list: '12345',
    emails: [' Jane.Doe@Gmail.com ', 'not-an-email', 'ops@Example.com'],
    phones: ['+1 (555) 123-4567', '5551234567'],
    ad_user_data_consent: 'GRANTED',
    ad_personalization_consent: 'GRANTED',
  }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(sent(fetch).map((call) => call.path), [
    `/v26/customers/${CUSTOMER}/offlineUserDataJobs:create`,
    `/v26/${job}:addOperations`,
    `/v26/${job}:run`,
  ]);
  assert.deepEqual(sent(fetch)[0].json, { job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { userList: `customers/${CUSTOMER}/userLists/12345`, consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } } } });
  assert.deepEqual(sent(fetch)[1].json, {
    enablePartialFailure: true,
    operations: [
      { create: { userIdentifiers: [{ hashedEmail: sha256('janedoe@gmail.com') }] } },
      { create: { userIdentifiers: [{ hashedEmail: sha256('ops@example.com') }] } },
      { create: { userIdentifiers: [{ hashedPhoneNumber: sha256('+15551234567') }] } },
    ],
  });
  assert.doesNotMatch(JSON.stringify(fetch.calls.map((call) => call.json)), /Jane|Doe|example\.com|5551234567"/i, 'no plain identifier is sent');
  assert.equal(payload.job, job);
  assert.equal(payload.identifiers_sent, 3);
  assert.deepEqual(payload.skipped_emails, { count: 1, first_indices: [1] });
  assert.deepEqual(payload.skipped_phones, { count: 1, first_indices: [1] });
  assert.match(payload.status_query, /FROM offline_user_data_job WHERE offline_user_data_job\.resource_name = 'customers\/1112223333\/offlineUserDataJobs\/80001'/);
  assert.doesNotMatch(JSON.stringify(payload), /Jane|ops@/i, 'the result echoes no identifier');

  const remove = setup(direct((request) => (request.path.endsWith(':create') ? jsonResponse(200, { resourceName: job }) : jsonResponse(200, {}))));
  await callTool(remove.module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: `customers/${CUSTOMER}/userLists/12345`, operation: 'remove', hashed_emails: ['A'.repeat(64)] }, remove.ctx);
  assert.deepEqual(sent(remove.fetch)[1].json.operations, [{ remove: { userIdentifiers: [{ hashedEmail: 'a'.repeat(64) }] } }]);
});

test('upload_customer_match refuses another account\'s list and invalid input, and names the job when the run is unclear', async () => {
  const { module, fetch, ctx } = setup(direct(() => jsonResponse(200, {})));
  const other = await callTool(module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: 'customers/9998887777/userLists/1', emails: ['a@example.com'] }, ctx);
  assert.match(other.payload.error, /belongs to another account/);
  const empty = await callTool(module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: '1' }, ctx);
  assert.match(empty.payload.error, /at least one email or phone/);
  const invalid = await callTool(module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: '1', phones: ['5551234567'] }, ctx);
  assert.match(invalid.payload.error, /None of the emails or phone numbers is valid/);
  assert.equal(fetch.calls.length, 0);

  const job = `customers/${CUSTOMER}/offlineUserDataJobs/80002`;
  const flaky = setup(direct((request) => {
    if (request.path.endsWith(':create')) return jsonResponse(200, { resourceName: job });
    if (request.path.endsWith(':addOperations')) return jsonResponse(200, {});
    return jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } });
  }));
  const unknown = await callTool(flaky.module, 'upload_customer_match', { customer_id: CUSTOMER, user_list: '1', emails: ['a@example.com'] }, flaky.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'search');
  assert.match(unknown.payload.error, /offlineUserDataJobs\/80002/);
  assert.equal(sent(flaky.fetch).length, 3, 'nothing sent twice');
});

test('hash_user_identifiers returns one hash per input, in order, and sends nothing', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const { payload } = await callTool(module, 'hash_user_identifiers', {
    emails: ['John.Smith@googlemail.com', 'bad', 'Jane.Doe+Shopping@GMAIL.com', 'user.name+NYC@Example.com'],
    phones: ['+44 20 7946 0958'],
  }, ctx);
  assert.deepEqual(payload, {
    hashed_emails: [sha256('johnsmith@googlemail.com'), null, sha256('janedoe@gmail.com'), sha256('user.name+nyc@example.com')],
    hashed_phone_numbers: [sha256('+442079460958')],
    invalid_emails: [1],
  });
  assert.equal(fetch.calls.length, 0);
});

test('api_get and api_request: login_customer_id, the account lock, free metadata paths, and no access management', async () => {
  const { module, fetch, ctx } = setup(direct(() => jsonResponse(200, { results: [] })));
  const apply = await callTool(module, 'api_request', {
    method: 'POST',
    path: `/v26/customers/${CUSTOMER}/recommendations:apply`,
    json: { operations: [{ resourceName: `customers/${CUSTOMER}/recommendations/abc` }] },
    login_customer_id: MANAGER,
  }, ctx);
  assert.equal(apply.isError, false);
  assert.equal(fetch.calls[0].headers['login-customer-id'], MANAGER);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/v26/customers/${CUSTOMER}/recommendations:apply`);

  const adjustments = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}:uploadConversionAdjustments`, json: { conversionAdjustments: [], partialFailure: true } }, ctx);
  assert.equal(adjustments.isError, false, 'the account segment may carry a method');

  const fields = await callTool(module, 'api_get', { path: '/v26/googleAdsFields/campaign.name' }, ctx);
  assert.equal(fields.isError, false);

  const elsewhere = await callTool(module, 'api_request', { method: 'POST', path: '/v26/customers/9998887777/campaigns:mutate', json: { operations: [] } }, ctx);
  assert.match(elsewhere.payload.error, /The Google Ads account 9998887777 is not among/);
  const inBody = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}/campaigns:mutate`, json: { operations: [{ update: { resourceName: 'customers/9998887777/campaigns/1' } }] } }, ctx);
  assert.match(inBody.payload.error, /The Google Ads account 9998887777 is not among/);
  // The same body sent as text is refused before anything is read or sent.
  const raw = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}/productLinks:create`, body: '{"productLink":{"googleAds":{"customer":"customers/9998887777"}}}', content_type: 'application/json' }, ctx);
  assert.match(raw.payload.error, /Invalid arguments for api_request: unknown arguments "body", "content_type"/);
  // A zero-padded ID is no chosen ID, in the body or in the path.
  const padded = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}/productLinks:create`, json: { productLink: { googleAds: { customer: 'customers/09998887777' } } } }, ctx);
  assert.match(padded.payload.error, /The Google Ads account 09998887777 is not among/);
  const paddedPath = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/0${CUSTOMER}/campaigns:mutate`, json: { operations: [] } }, ctx);
  assert.match(paddedPath.payload.error, /The Google Ads account 01112223333 is not among/);
  const inQuery = await callTool(module, 'api_get', { path: `/v26/customers/${CUSTOMER}/operations/1`, query: { filter: 'customers/9998887777' } }, ctx);
  assert.match(inQuery.payload.error, /The Google Ads account 9998887777 is not among/);
  const unnamed = await callTool(module, 'api_request', { method: 'POST', path: '/v26/googleAdsFields:search', json: { query: 'SELECT name' } }, ctx);
  assert.match(unnamed.payload.error, /names none of the Google Ads accounts chosen/);
  const access = await callTool(module, 'api_request', { method: 'POST', path: `/v26/customers/${CUSTOMER}/customerUserAccesses:mutate`, json: { operation: {} } }, ctx);
  assert.match(access.payload.error, /Changing who can access a Google Ads account/);
  const wrongVersion = await callTool(module, 'api_get', { path: '/v23/customers:listAccessibleCustomers' }, setup(() => jsonResponse(200, {}), { accounts: null }).ctx);
  assert.match(wrongVersion.payload.error, /The path must start with \/v26\//);
  assert.equal(sent(fetch).length, 3);
  assert.equal(fetch.calls.length, 4, 'one lookup, for the call that named the account without a login');
});

test('errors: the module\'s sentences, the vendor\'s words, 429 retryAfter, a missing token, and logs without secrets', async () => {
  const invalid = setup(direct(() => jsonResponse(400, fixture(import.meta.url, 'error-invalid-argument.json'))));
  const bad = await callTool(invalid.module, 'search', { customer_id: CUSTOMER, query: 'SELECT campaign.nme FROM campaign' }, invalid.ctx);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /did not accept the query: check the GAQL syntax/);
  assert.match(bad.payload.error, /api_get \/v26\/googleAdsFields\/<field> tells whether a field exists/);
  assert.match(bad.payload.error, /Request contains an invalid argument/);

  const denied = setup(direct(() => jsonResponse(403, fixture(import.meta.url, 'error-not-enabled.json'))));
  const forbidden = await callTool(denied.module, 'mutate', { customer_id: CUSTOMER, operations: [{ campaignOperation: {} }] }, denied.ctx);
  assert.match(forbidden.payload.error, /give login_customer_id/);
  assert.match(forbidden.payload.error, /Nothing was changed/);

  const limited = setup(direct(() => jsonResponse(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '30' })));
  const quota = await callTool(limited.module, 'search', { customer_id: CUSTOMER, query: 'SELECT campaign.id FROM campaign' }, limited.ctx);
  assert.equal(quota.payload.retryAfter, 30);

  const missing = setup(() => jsonResponse(200, {}), { credentials: { developertoken: DEV } });
  const notConnected = await callTool(missing.module, 'list_customers', {}, missing.ctx);
  assert.match(notConnected.payload.error, /Google Ads is not connected: the Google Ads access token is missing/);
  assert.equal(missing.fetch.calls.length, 0);

  const logged = [...invalid.logs, ...denied.logs, ...limited.logs].join('\n');
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged, /ya29|EXAMPLE-DEV|1112223333|campaign\.nme/);
});
