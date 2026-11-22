import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.example-merchant-token';
const credentials = { access_token: TOKEN };
const ORIGIN = 'https://merchantapi.googleapis.com';
const ACCOUNT = '5550001';
const SOURCE = `accounts/${ACCOUNT}/dataSources/9990001`;
const KEY = { account_id: ACCOUNT, offer_id: 'SKU789', content_language: 'en', feed_label: 'US' };
// base64url("en~US~SKU789"), unpadded: the product ID form Google recommends.
const ENCODED = Buffer.from('en~US~SKU789').toString('base64url');

function setup(handler, accounts = { accounts: [ACCOUNT] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the module declares its origin, the access token, the accounts picker and honest kinds', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), [ORIGIN]);
  assert.deepEqual(plain(module.credentials), ['access_token']);
  assert.deepEqual(plain(module.accountPickers), [{
    key: 'accounts',
    label: 'Merchant Center accounts',
    description: 'The Merchant Center accounts the agent may read and change.',
    multiple: true,
    tool: 'list_accounts',
    idField: 'id',
    nameField: 'name',
    legacyField: 'merchantid',
  }]);
  const hints = Object.fromEntries(module.tools.map((tool) => [tool.name, [tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint]]));
  assert.deepEqual(hints.insert_product, [false, true, true], 'insert replaces the input with the same key');
  assert.deepEqual(hints.update_product, [false, true, true]);
  assert.deepEqual(hints.delete_product, [false, true, true]);
  assert.deepEqual(hints.create_data_source, [false, false, false]);
  assert.deepEqual(hints.api_request, [false, true, false]);
  for (const name of ['list_accounts', 'list_products', 'get_product', 'list_data_sources', 'list_account_issues', 'summarize_product_statuses', 'search_reports', 'api_get']) {
    assert.equal(hints[name][0], true, name);
  }
});

test('the accounts picker: list_accounts lists every account the Google account can open, and pages', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'accounts.json')), null);
  const [picker] = module.accountPickers;
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/accounts/v1/accounts?pageSize=250`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.accounts, [
    { id: '5550001', name: 'Example Outdoor Store', time_zone: 'America/New_York', language: 'en-US' },
    { id: '5550002', name: 'Example Outdoor EU', time_zone: 'Europe/Berlin', language: 'de-DE', test_account: true },
  ]);
  assert.deepEqual(payload.accounts.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [['5550001', 'Example Outdoor Store'], ['5550002', 'Example Outdoor EU']]);
  await callTool(module, picker.tool, { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.pageToken, 'accounts-page-2');
});

test('list_products trims each processed product to its key fields, price and status, and pages', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'products.json')));
  const { payload } = await callTool(module, 'list_products', { account_id: ACCOUNT, page_size: 2 }, ctx);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/products/v1/accounts/${ACCOUNT}/products?pageSize=2`);
  assert.deepEqual(payload.products[0], {
    name: 'accounts/5550001/products/en~US~SKU123',
    offer_id: 'SKU123',
    content_language: 'en',
    feed_label: 'US',
    data_source: SOURCE,
    title: 'Trail Running Shoes',
    link: 'https://shop.example.com/p/SKU123',
    image_link: 'https://shop.example.com/i/SKU123.jpg',
    price: { amount: 129.99, amount_micros: '129990000', currency_code: 'USD' },
    availability: 'IN_STOCK',
    condition: 'NEW',
    brand: 'Example Outdoor',
    gtins: ['01234567890128'],
    status: { destinations: [{ reporting_context: 'SHOPPING_ADS', approved: ['US'] }, { reporting_context: 'FREE_LISTINGS', approved: ['US'] }] },
  });
  assert.deepEqual(payload.products[1].status.issues, [{ code: 'missing_gtin', severity: 'DISAPPROVED', resolution: 'merchant_action', attribute: 'gtin', reporting_context: 'SHOPPING_ADS', description: 'Missing value [gtin]', countries: ['US'] }]);
  assert.equal(payload.products[1].sale_price.amount, 14.99);
  await callTool(module, 'list_products', { account_id: ACCOUNT, page_size: 2, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.pageToken, 'products-page-2');
});

test('get_product asks for the base64url product ID and returns every attribute with the full issue detail', async () => {
  const product = fixture(import.meta.url, 'products.json').products[1];
  const { module, fetch, ctx } = setup(() => jsonResponse(200, product));
  const { payload } = await callTool(module, 'get_product', { ...KEY, offer_id: 'SKU456' }, ctx);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/products/v1/accounts/${ACCOUNT}/products/${Buffer.from('en~US~SKU456').toString('base64url')}`);
  assert.equal(payload.attributes.title, 'Hiking Socks (3 pairs)');
  assert.equal(payload.status.issues[0].detail, 'Add a GTIN for this branded product.');
  assert.equal(payload.status.issues[0].documentation, 'https://support.google.com/merchants/answer/6324461');

  // An offer ID with reserved characters is encoded whole, so it never breaks the path.
  await callTool(module, 'get_product', { ...KEY, offer_id: 'size/10~blue', legacy_local: true }, ctx);
  assert.equal(fetch.calls[1].path, `/products/v1/accounts/${ACCOUNT}/products/${Buffer.from('local~en~US~size/10~blue').toString('base64url')}`);
});

test('insert_product posts the input with its data source; an unclear outcome sends nothing twice', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'product-input.json')));
  const attributes = { title: 'Camping Lantern', availability: 'IN_STOCK', price: { amountMicros: '34990000', currencyCode: 'USD' } };
  const { payload, isError } = await callTool(module, 'insert_product', { ...KEY, data_source: '9990001', product_attributes: attributes, custom_attributes: [{ name: 'season', value: 'summer' }] }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].path, `/products/v1/accounts/${ACCOUNT}/productInputs:insert`);
  assert.equal(fetch.calls[0].query.dataSource, SOURCE);
  assert.deepEqual(fetch.calls[0].json, { offerId: 'SKU789', contentLanguage: 'en', feedLabel: 'US', productAttributes: attributes, customAttributes: [{ name: 'season', value: 'summer' }] });
  assert.equal(payload.product, 'accounts/5550001/products/en~US~SKU789');
  assert.match(payload.note, /get_product/);

  const otherSource = await callTool(module, 'insert_product', { ...KEY, data_source: 'accounts/42/dataSources/1', product_attributes: attributes }, ctx);
  assert.match(otherSource.payload.error, /belongs to another account/);
  assert.equal(fetch.calls.length, 1);

  const broken = setup(() => jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }));
  const unknown = await callTool(broken.module, 'insert_product', { ...KEY, data_source: '9990001', product_attributes: attributes }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_product');
  assert.equal(broken.fetch.calls.length, 1);
});

test('update_product patches only the given attributes, with an update mask that also clears the removed ones', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'product-input.json')));
  const { payload } = await callTool(module, 'update_product', {
    ...KEY,
    data_source: SOURCE,
    product_attributes: { price: { amountMicros: '29990000', currencyCode: 'USD' }, availability: 'IN_STOCK' },
    custom_attributes: [{ name: 'season', value: 'winter' }],
    remove_attributes: ['salePrice', 'availability'],
  }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].path, `/products/v1/accounts/${ACCOUNT}/productInputs/${ENCODED}`);
  assert.equal(fetch.calls[0].query.dataSource, SOURCE);
  assert.equal(fetch.calls[0].query.updateMask, 'productAttributes.price,productAttributes.availability,productAttributes.salePrice,custom_attribute.season');
  assert.deepEqual(fetch.calls[0].json, { productAttributes: { price: { amountMicros: '29990000', currencyCode: 'USD' }, availability: 'IN_STOCK' }, customAttributes: [{ name: 'season', value: 'winter' }] });
  assert.deepEqual(payload.updated, ['productAttributes.price', 'productAttributes.availability', 'productAttributes.salePrice', 'custom_attribute.season']);

  const nothing = await callTool(module, 'update_product', { ...KEY, data_source: SOURCE }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 1);
});

test('delete_product deletes the input from its data source, and refuses an account outside the chosen ones', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const { payload } = await callTool(module, 'delete_product', { ...KEY, data_source: '9990001' }, ctx);
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/products/v1/accounts/${ACCOUNT}/productInputs/${ENCODED}?dataSource=${encodeURIComponent(SOURCE)}`);
  assert.equal(payload.deleted, true);

  for (const [tool, args] of [
    ['delete_product', { ...KEY, account_id: '42', data_source: '1' }],
    ['list_products', { account_id: '42' }],
    ['search_reports', { account_id: '42', query: 'SELECT offer_id FROM product_view' }],
    ['summarize_product_statuses', { account_id: '42' }],
  ]) {
    const refused = await callTool(module, tool, args, ctx);
    assert.match(refused.payload.error, /The Merchant Center account 42 is not among the Merchant Center accounts chosen for this connection\. Use one of: 5550001\. Nothing was sent\./, tool);
  }
  assert.equal(fetch.calls.length, 1);
});

test('list_data_sources names each source\'s type and input; create_data_source makes an API primary source', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET'
    ? jsonResponse(200, fixture(import.meta.url, 'data-sources.json'))
    : jsonResponse(200, fixture(import.meta.url, 'data-sources.json').dataSources[0])));
  const { payload } = await callTool(module, 'list_data_sources', { account_id: ACCOUNT }, ctx);
  assert.equal(fetch.calls[0].url, `${ORIGIN}/datasources/v1/accounts/${ACCOUNT}/dataSources?pageSize=100`);
  assert.deepEqual(payload.data_sources.map((source) => [source.id, source.input, source.type]), [['9990001', 'API', 'primary_product'], ['9990002', 'FILE', 'primary_product'], ['9990003', 'API', 'promotion']]);
  assert.deepEqual(payload.data_sources[1].file, { name: 'products.xml', fetch_uri: 'https://shop.example.com/feeds/products.xml' });

  const created = await callTool(module, 'create_data_source', { account_id: ACCOUNT, display_name: 'Agent API feed', feed_label: 'US', content_language: 'en', countries: ['US'] }, ctx);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.deepEqual(fetch.calls[1].json, { displayName: 'Agent API feed', primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en', countries: ['US'] } });
  assert.equal(created.payload.name, SOURCE);

  const half = await callTool(module, 'create_data_source', { account_id: ACCOUNT, display_name: 'x', feed_label: 'US' }, ctx);
  assert.match(half.payload.error, /together, or neither/);
  assert.equal(fetch.calls.length, 2);
});

test('list_account_issues and summarize_product_statuses trim issues and counts', async () => {
  const issues = setup(() => jsonResponse(200, fixture(import.meta.url, 'account-issues.json')));
  const listed = await callTool(issues.module, 'list_account_issues', { account_id: ACCOUNT, language_code: 'en-US' }, issues.ctx);
  assert.equal(issues.fetch.calls[0].url, `${ORIGIN}/accounts/v1/accounts/${ACCOUNT}/issues?pageSize=100&languageCode=en-US`);
  assert.deepEqual(listed.payload.issues[0], {
    title: 'Unclaimed website',
    severity: 'CRITICAL',
    impacted: [{ reporting_context: 'SHOPPING_ADS', regions: [{ region: 'US', severity: 'CRITICAL' }] }],
    detail: 'Your website is not claimed. Verify and claim your website to show products.',
    documentation: 'https://support.google.com/merchants/answer/7527436',
  });

  const statuses = setup(() => jsonResponse(200, fixture(import.meta.url, 'aggregate-statuses.json')));
  const summary = await callTool(statuses.module, 'summarize_product_statuses', { account_id: ACCOUNT, reporting_context: 'SHOPPING_ADS', country: 'US' }, statuses.ctx);
  assert.equal(statuses.fetch.calls[0].path, `/issueresolution/v1/accounts/${ACCOUNT}/aggregateProductStatuses`);
  assert.equal(statuses.fetch.calls[0].query.filter, 'reportingContext = "SHOPPING_ADS" AND country = "US"');
  assert.deepEqual(summary.payload.statuses[0].issues[0], { code: 'missing_gtin', severity: 'DISAPPROVED', resolution: 'MERCHANT_ACTION', attribute: 'gtin', description: 'Missing value [gtin]', products: 29, documentation: 'https://support.google.com/merchants/answer/6324461' });
  assert.deepEqual([summary.payload.statuses[0].active, summary.payload.statuses[0].disapproved], [1520, 41]);
  assert.deepEqual(summary.payload.statuses[1], { reporting_context: 'FREE_LISTINGS', country: 'US', active: 1561, pending: 0, disapproved: 12, expiring: 0 });
});

test('search_reports posts the query and flattens each row to snake_case fields', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, fixture(import.meta.url, request.json.query.includes('price_competitiveness') ? 'price-report.json' : 'report.json')));
  const query = 'SELECT offer_id, title, clicks, impressions, click_through_rate FROM product_performance_view WHERE date DURING LAST_30_DAYS';
  const { payload } = await callTool(module, 'search_reports', { account_id: ACCOUNT, query, page_size: 2 }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${ORIGIN}/reports/v1/accounts/${ACCOUNT}/reports:search`);
  assert.deepEqual(fetch.calls[0].json, { query, pageSize: 2 });
  assert.equal(payload.view, 'product_performance_view');
  assert.deepEqual(payload.rows[0], { offer_id: 'SKU123', title: 'Trail Running Shoes', clicks: '421', impressions: '18230', click_through_rate: 0.0231, marketing_method: 'ADS' });
  await callTool(module, 'search_reports', { account_id: ACCOUNT, query, page_size: 2, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.pageToken, 'report-page-2');

  const prices = await callTool(module, 'search_reports', { account_id: ACCOUNT, query: 'SELECT offer_id, price, benchmark_price FROM price_competitiveness_product_view' }, ctx);
  assert.deepEqual(prices.payload.rows[0], { offer_id: 'SKU123', 'price.amount_micros': '129990000', 'price.currency_code': 'USD', 'benchmark_price.amount_micros': '119990000', 'benchmark_price.currency_code': 'USD', report_country_code: 'US' });
});

test('api_get and api_request reach the rest of the Merchant API inside the account lock, without account deletion or user management', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { name: `accounts/${ACCOUNT}/homepage`, uri: 'https://shop.example.com', claimed: true }));
  const read = await callTool(module, 'api_get', { path: `/accounts/v1/accounts/${ACCOUNT}/homepage` }, ctx);
  assert.equal(read.payload.data.claimed, true);
  const claim = await callTool(module, 'api_request', { method: 'POST', path: `/accounts/v1/accounts/${ACCOUNT}/homepage:claim`, json: {} }, ctx);
  assert.equal(claim.isError, false);
  assert.equal(fetch.calls[1].url, `${ORIGIN}/accounts/v1/accounts/${ACCOUNT}/homepage:claim`);

  const promo = await callTool(module, 'api_request', { method: 'POST', path: `/promotions/v1/accounts/${ACCOUNT}/promotions:insert`, json: { promotion: { promotionId: 'BF10' }, dataSource: 'accounts/42/dataSources/1' } }, ctx);
  assert.match(promo.payload.error, /The Merchant Center account 42 is not among/);
  const removal = await callTool(module, 'api_request', { method: 'DELETE', path: `/accounts/v1/accounts/${ACCOUNT}` }, ctx);
  assert.match(removal.payload.error, /Deleting a whole Merchant Center account is not offered here/);
  const user = await callTool(module, 'api_request', { method: 'POST', path: `/accounts/v1/accounts/${ACCOUNT}/users`, query: { userId: 'someone@example.com' }, json: { accessRights: ['ADMIN'] } }, ctx);
  assert.match(user.payload.error, /Managing the users/);
  const unversioned = await callTool(module, 'api_get', { path: `/accounts/${ACCOUNT}` }, setup(() => jsonResponse(200, {}), null).ctx);
  assert.match(unversioned.payload.error, /must start with a sub-API and its version/);
  const all = await callTool(module, 'api_get', { path: '/accounts/v1/accounts' }, ctx);
  assert.match(all.payload.error, /names none of the Merchant Center accounts chosen/);
  assert.equal(fetch.calls.length, 2);
});

test('errors: the vendor\'s words, an unregistered project explained, 429 retryAfter, and clean logs', async () => {
  const invalid = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-invalid.json')));
  const bad = await callTool(invalid.module, 'insert_product', { ...KEY, data_source: '9990001', product_attributes: { availability: 'in stock' } }, invalid.ctx);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /upper-case enums/);
  assert.match(bad.payload.error, /Invalid value: "in stock"/);
  assert.match(bad.payload.error, /Nothing was changed/);

  const unregistered = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-not-registered.json')), null);
  const denied = await callTool(unregistered.module, 'list_accounts', {}, unregistered.ctx);
  assert.match(denied.payload.error, /not registered with this account yet \(register it once: see the connector's README\) \(HTTP 401\)/);
  assert.match(denied.payload.error, /is not registered with the merchant account/);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '30' }));
  const quota = await callTool(limited.module, 'list_products', { account_id: ACCOUNT }, limited.ctx);
  assert.equal(quota.payload.retryAfter, 30);

  const logged = [...invalid.logs, ...unregistered.logs, ...limited.logs].join('\n');
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged, /ya29|SKU789|5550001|in stock/);
});
