import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = `ck_${'a'.repeat(40)}`;
const SECRET = `cs_${'b'.repeat(40)}`;
const credentials = { storeurl: 'https://example.com/shop', consumerkey: KEY, consumersecret: SECRET };
const BASIC = `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`;
const API = 'https://example.com/shop/wp-json/wc/v3';
const pages = (total, count) => ({ 'x-wp-total': String(total), 'x-wp-totalpages': String(count) });

function setup(handler, overrides = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: { ...credentials, ...overrides }, fetch });
  return { module, fetch, ctx, logs };
}

test('list_products sends Basic auth (never query credentials), trims each product and pages with a cursor that keeps the filters', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'products.json'), pages(3, 2)));
  const first = await callTool(module, 'list_products', { search: 'drip', stock_status: 'instock', per_page: 2 }, ctx);
  assert.equal(first.isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/shop/wp-json/wc/v3/products');
  assert.equal(request.headers.authorization, BASIC);
  assert.equal(request.query.consumer_key, undefined);
  assert.equal(request.query.search, 'drip');
  assert.equal(request.query.status, 'any');
  assert.equal(request.query.stock_status, 'instock');
  assert.equal(request.query.per_page, '2');
  assert.equal(request.query.page, '1');
  assert.match(request.query._fields, /^id,name,type,status,sku,price/);
  assert.deepEqual(first.payload.products[0], {
    id: 101,
    name: 'Ceramic Pour-Over Dripper',
    type: 'simple',
    status: 'publish',
    sku: 'DRIP-01',
    price: '24.00',
    regular_price: '29.00',
    sale_price: '24.00',
    on_sale: true,
    stock_status: 'instock',
    manage_stock: true,
    stock_quantity: 18,
    categories: [{ id: 15, name: 'Brewing & Gear' }],
    total_sales: 57,
    permalink: 'https://example.com/shop/product/ceramic-pour-over-dripper/',
    date_modified: '2026-11-19T11:02:31',
  });
  assert.equal(first.payload.products[1].variations, 3);
  assert.equal(first.payload.products[1].stock_quantity, undefined, 'no quantity when stock is not tracked');
  assert.equal(first.payload.total, 3);

  await callTool(module, 'list_products', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '2');
  assert.equal(fetch.calls[1].query.search, 'drip');
  assert.equal(fetch.calls[1].query.per_page, '2');
});

test('the store URL keeps its WordPress subdirectory and drops a REST or admin path pasted with it', async () => {
  for (const [storeurl, path] of [
    ['https://example.com/shop/wp-json/wc/v3/', '/shop/wp-json/wc/v3/products'],
    ['example.com/shop/wp-admin/edit.php?post_type=product', '/shop/wp-json/wc/v3/products'],
    ['https://store.example.com/', '/wp-json/wc/v3/products'],
  ]) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, []), { storeurl });
    await callTool(module, 'list_products', {}, ctx);
    assert.equal(fetch.calls[0].path, path, storeurl);
  }
  const plain = setup(() => jsonResponse(200, []), { storeurl: 'http://example.com' });
  const refused = await callTool(plain.module, 'list_products', {}, plain.ctx);
  assert.match(refused.payload.error, /WooCommerce is not connected correctly: the WooCommerce store URL must be an https address/);
  assert.equal(plain.fetch.calls.length, 0);
});

test('a page over 32 KB is cut and continues after the last product returned', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, name: `Product ${index} `.padEnd(290, 'x'), permalink: `https://example.com/shop/p/${index}/${'y'.repeat(60)}` }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, many, pages(100, 1)));
  const first = await callTool(module, 'list_products', { per_page: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.products.length;
  const second = await callTool(module, 'list_products', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '1');
  assert.equal(second.payload.products[0].id, 1000 + shown);
});

test('get_product returns a variable product with its variations and who manages their stock', async () => {
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/variations')
    ? jsonResponse(200, fixture(import.meta.url, 'variations.json'), pages(120, 2))
    : jsonResponse(200, fixture(import.meta.url, 'product-variable.json'))));
  const { payload } = await callTool(module, 'get_product', { id: 102 }, ctx);
  assert.equal(fetch.calls[0].url, `${API}/products/102`);
  assert.equal(fetch.calls[1].url, `${API}/products/102/variations?per_page=100&page=1`);
  assert.equal(payload.description, '<p>Soft cotton tee with our logo.</p>');
  assert.deepEqual(payload.attributes, [{ name: 'Size', options: ['S', 'M', 'L'], variation: true, visible: true }]);
  assert.deepEqual(payload.images, [{ id: 77, src: 'https://example.com/shop/wp-content/uploads/2026/11/tee.jpg', alt: 'Black logo tee' }]);
  assert.deepEqual(payload.variations[1], { id: 202, sku: 'TEE-M', status: 'publish', attributes: 'Size: M', price: '20.00', regular_price: '20.00', stock_status: 'instock', manage_stock: 'parent', backorders: 'no' });
  assert.ok(payload.nextCursor, '120 variations: a second page');
  assert.equal('meta_data' in payload, false);
  await callTool(module, 'get_product', { id: 102, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[3].url, `${API}/products/102/variations?per_page=100&page=2`);

  const simple = setup(() => jsonResponse(200, fixture(import.meta.url, 'product-created.json')));
  await callTool(simple.module, 'get_product', { id: 140 }, simple.ctx);
  assert.equal(simple.fetch.calls.length, 1, 'no variations request for a simple product');
});

test('create_product saves a draft with the given fields and more_fields, and refuses more_fields that repeat an argument', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, fixture(import.meta.url, 'product-created.json')));
  const { payload, isError } = await callTool(module, 'create_product', {
    name: 'Glass Cold Brew Jar',
    sku: 'JAR-1L',
    regular_price: '34.00',
    description: '<p>One litre.</p>',
    categories: [15],
    images: [{ src: 'https://cdn.example.net/jar.jpg', alt: 'Jar' }],
    manage_stock: true,
    stock_quantity: 25,
    more_fields: { dimensions: { length: '12', width: '12', height: '20' }, backorders: 'no' },
  }, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${API}/products`);
  assert.deepEqual(request.json, {
    name: 'Glass Cold Brew Jar',
    sku: 'JAR-1L',
    regular_price: '34.00',
    description: '<p>One litre.</p>',
    categories: [15],
    images: [{ src: 'https://cdn.example.net/jar.jpg', alt: 'Jar' }],
    manage_stock: true,
    stock_quantity: 25,
    type: 'simple',
    status: 'draft',
    dimensions: { length: '12', width: '12', height: '20' },
    backorders: 'no',
  });
  assert.equal(payload.id, 140);
  assert.equal(payload.status, 'draft');
  assert.deepEqual(payload.dimensions, { length: '12', width: '12', height: '20' });

  const clash = await callTool(module, 'create_product', { name: 'X', more_fields: { stock_quantity: 5, variations: [] } }, ctx);
  assert.match(clash.payload.error, /more_fields must not repeat stock_quantity, variations/);
  const notVariable = await callTool(module, 'create_product', { name: 'X', variations: [{ attributes: [{ name: 'Size', option: 'S' }] }] }, ctx);
  assert.match(notVariable.payload.error, /variations are for type variable only/);
  assert.equal(fetch.calls.length, 1);
});

test('create_product with variations creates them right after the product and reports the ones refused', async () => {
  const variable = { ...fixture(import.meta.url, 'product-created.json'), id: 150, type: 'variable', name: 'Hoodie' };
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/variations/batch') ? jsonResponse(200, fixture(import.meta.url, 'variations-batch.json')) : jsonResponse(201, variable)));
  const { payload } = await callTool(module, 'create_product', {
    name: 'Hoodie',
    type: 'variable',
    attributes: [{ name: 'Size', options: ['S', 'M'], variation: true, visible: true }],
    variations: [
      { attributes: [{ name: 'Size', option: 'S' }], regular_price: '45.00', sku: 'HOOD-S' },
      { attributes: [{ name: 'Size', option: 'M' }], regular_price: '45.00', sku: 'DRIP-01' },
    ],
  }, ctx);
  assert.equal(fetch.calls.length, 2);
  assert.equal('variations' in fetch.calls[0].json, false, 'the product is created without them');
  assert.equal(fetch.calls[1].url, `${API}/products/150/variations/batch`);
  assert.deepEqual(fetch.calls[1].json.create[0], { attributes: [{ name: 'Size', option: 'S' }], regular_price: '45.00', sku: 'HOOD-S' });
  assert.equal(payload.id, 150);
  assert.deepEqual(payload.variations, [{ id: 301, sku: 'HOOD-S', status: 'publish', attributes: 'Size: S', price: '45.00', regular_price: '45.00', stock_status: 'instock', manage_stock: false }]);
  assert.deepEqual(payload.variation_errors, ['variation 2: Invalid or duplicated SKU.']);
});

test('when the variations of a new product fail, the result says the product exists', async () => {
  const variable = { ...fixture(import.meta.url, 'product-created.json'), id: 150, type: 'variable' };
  const args = { name: 'Hoodie', type: 'variable', variations: [{ attributes: [{ name: 'Size', option: 'S' }] }] };
  const refused = setup((request) => (request.path.endsWith('/batch') ? jsonResponse(400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): create' }) : jsonResponse(201, variable)));
  const failed = await callTool(refused.module, 'create_product', args, refused.ctx);
  assert.equal(failed.isError, true);
  assert.match(failed.payload.error, /^WooCommerce created the product \(id 150, status draft\), but not its variations: .*Invalid parameter\(s\): create.*POST \/wc\/v3\/products\/150\/variations\/batch/);
  assert.doesNotMatch(failed.payload.error, /Nothing was changed/);

  const broken = setup((request) => (request.path.endsWith('/batch') ? jsonResponse(502, {}) : jsonResponse(201, variable)));
  const unknown = await callTool(broken.module, 'create_product', args, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_products');
  assert.match(unknown.payload.error, /WooCommerce created the product \(id 150, status draft\), but its variations got no clear answer/);
  assert.equal(broken.fetch.calls.length, 2);
});

test('a duplicated SKU keeps WooCommerce\'s words, and a read-only key gets a hint', async () => {
  const sku = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-sku.json')));
  const duplicate = await callTool(sku.module, 'create_product', { name: 'Jar', sku: 'JAR-1L' }, sku.ctx);
  assert.equal(duplicate.payload.status, 400);
  assert.match(duplicate.payload.error, /WooCommerce rejected the request \(HTTP 400\): Invalid or duplicated SKU\. Nothing was changed\./);

  const readOnly = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-read-only.json')));
  const denied = await callTool(readOnly.module, 'update_product', { id: 140, regular_price: '30.00' }, readOnly.ctx);
  assert.match(denied.payload.error, /does not have write permissions.*Read\/Write permissions/);
});

test('update_product changes a product or a variation, and checks the stock before changing it', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.method === 'GET'
    ? { ...fixture(import.meta.url, 'product-created.json'), stock_quantity: 25 }
    : { ...fixture(import.meta.url, 'product-created.json'), stock_quantity: 30 }));
  const { payload } = await callTool(module, 'update_product', { id: 140, stock_quantity: 30, expected_stock_quantity: 25 }, ctx);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[1].method, 'PUT');
  assert.equal(fetch.calls[1].url, `${API}/products/140`);
  assert.deepEqual(fetch.calls[1].json, { stock_quantity: 30 });
  assert.equal(payload.stock_quantity, 30);
  assert.equal(payload.previous_stock_quantity, 25);

  const moved = await callTool(module, 'update_product', { id: 140, stock_quantity: 30, expected_stock_quantity: 20 }, ctx);
  assert.match(moved.payload.error, /The stock is 25 now, not 20: it changed since it was read\. Read it again and decide again\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 3, 'only the read');

  const variation = setup((request) => jsonResponse(200, request.method === 'GET' ? fixture(import.meta.url, 'variations.json')[1] : fixture(import.meta.url, 'variations.json')[0]));
  const parent = await callTool(variation.module, 'update_product', { id: 102, variation_id: 202, stock_quantity: 4 }, variation.ctx);
  assert.match(parent.payload.error, /managed by its parent product/);
  const price = await callTool(variation.module, 'update_product', { id: 102, variation_id: 201, sale_price: '15.00' }, variation.ctx);
  assert.equal(variation.fetch.calls[1].method, 'PUT');
  assert.equal(variation.fetch.calls[1].url, `${API}/products/102/variations/201`);
  assert.deepEqual(variation.fetch.calls[1].json, { sale_price: '15.00' });
  assert.equal(price.payload.id, 201);
  const productField = await callTool(variation.module, 'update_product', { id: 102, variation_id: 201, name: 'New' }, variation.ctx);
  assert.match(productField.payload.error, /name is for the product, not a variation/);
  const nothing = await callTool(variation.module, 'update_product', { id: 102 }, variation.ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(variation.fetch.calls.length, 2);
});

test('list_orders and get_order: no contact details unless asked, notes on request', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/notes')) return jsonResponse(200, fixture(import.meta.url, 'order-notes.json'));
    if (request.path.endsWith('/orders')) return jsonResponse(200, fixture(import.meta.url, 'orders.json'), pages(1, 1));
    return jsonResponse(200, fixture(import.meta.url, 'order.json'));
  });
  const list = await callTool(module, 'list_orders', { status: ['processing', 'on-hold'], after: '2026-11-01' }, ctx);
  assert.equal(fetch.calls[0].query.status, 'processing,on-hold');
  assert.equal(fetch.calls[0].query.after, '2026-11-01');
  assert.deepEqual(list.payload.orders[0], {
    id: 5521,
    number: '5521',
    status: 'processing',
    date_created: '2026-11-21T19:04:11',
    date_paid: '2026-11-21T19:04:15',
    total: '53.90',
    currency: 'EUR',
    customer_id: 88,
    payment_method_title: 'Credit card',
    items: [{ name: 'Ceramic Pour-Over Dripper', quantity: 2, total: '48.00', product_id: 101 }],
    refunded: '5.00',
  });

  const plain = await callTool(module, 'get_order', { id: 5521 }, ctx);
  assert.equal(plain.payload.billing, undefined);
  assert.equal(plain.payload.customer_note, 'Please gift wrap');
  assert.deepEqual(plain.payload.line_items[0], { id: 9001, name: 'Ceramic Pour-Over Dripper', product_id: 101, sku: 'DRIP-01', quantity: 2, price: 24, subtotal: '48.00', total: '48.00', total_tax: '8.00' });
  assert.equal('payment_url' in plain.payload, false);
  assert.equal(JSON.stringify(plain.payload).includes('wc_order_abc123'), false, 'the order key is never shown');

  const full = await callTool(module, 'get_order', { id: 5521, include_notes: true, include_customer_details: true }, ctx);
  assert.equal(full.payload.billing.email, 'ada@example.com');
  assert.equal(full.payload.shipping.city, 'Berlin');
  assert.deepEqual(full.payload.notes[1], { id: 802, date_created: '2026-11-21T19:30:00', author: 'shopmanager', note: 'Packed & ready', customer_note: true });
});

test('update_order, add_order_note and create_refund send exactly what was asked', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/notes')) return jsonResponse(201, fixture(import.meta.url, 'note-created.json'));
    if (request.path.endsWith('/refunds')) return jsonResponse(201, fixture(import.meta.url, 'refund-created.json'));
    return jsonResponse(200, { ...fixture(import.meta.url, 'order.json'), status: 'completed' });
  });
  const updated = await callTool(module, 'update_order', { id: 5521, status: 'completed' }, ctx);
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].url, `${API}/orders/5521`);
  assert.deepEqual(fetch.calls[0].json, { status: 'completed' });
  assert.equal(updated.payload.status, 'completed');
  assert.equal(updated.payload.billing, undefined);
  const refundedStatus = await callTool(module, 'update_order', { id: 5521, status: 'refunded' }, ctx);
  assert.match(refundedStatus.payload.error, /`status` must be one of/);

  const note = await callTool(module, 'add_order_note', { id: 5521, note: 'Shipped with DHL.' }, ctx);
  assert.deepEqual(fetch.calls[1].json, { note: 'Shipped with DHL.', customer_note: false });
  assert.equal(note.payload.id, 803);

  const refund = await callTool(module, 'create_refund', { order_id: 5521, amount: '24.00', reason: 'Returned', line_items: [{ id: 9001, quantity: 1, refund_total: '24.00' }] }, ctx);
  assert.equal(fetch.calls[2].url, `${API}/orders/5521/refunds`);
  assert.deepEqual(fetch.calls[2].json, { amount: '24.00', reason: 'Returned', line_items: [{ id: 9001, quantity: 1, refund_total: '24.00' }], api_refund: false, api_restock: false });
  assert.equal(refund.payload.id, 5540);
  assert.equal(refund.payload.refunded_payment, false);
  await callTool(module, 'create_refund', { order_id: 5521, amount: '5.00', refund_payment: true, restock_items: true }, ctx);
  assert.equal(fetch.calls[3].json.api_refund, true);
  assert.equal(fetch.calls[3].json.api_restock, true);
});

test('coupons, customers and reports', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/coupons')) return request.method === 'POST' ? jsonResponse(201, fixture(import.meta.url, 'coupon-created.json')) : jsonResponse(200, fixture(import.meta.url, 'coupons.json'), pages(1, 1));
    if (request.path.endsWith('/customers')) return jsonResponse(200, fixture(import.meta.url, 'customers.json'), pages(1, 1));
    if (request.path.endsWith('/reports/sales')) return jsonResponse(200, fixture(import.meta.url, 'report-sales.json'));
    if (request.path.endsWith('/reports/top_sellers')) return jsonResponse(200, fixture(import.meta.url, 'report-top-sellers.json'));
    return jsonResponse(200, fixture(import.meta.url, 'report-orders-totals.json'));
  });
  const coupons = await callTool(module, 'list_coupons', { code: 'WELCOME10' }, ctx);
  assert.equal(fetch.calls[0].query.code, 'WELCOME10');
  assert.equal(coupons.payload.coupons[0].usage_count, 41);
  assert.equal('used_by' in coupons.payload.coupons[0], false, 'who used it is left out');

  const created = await callTool(module, 'create_coupon', { code: 'WINTER15', discount_type: 'percent', amount: '15', usage_limit: 200, minimum_amount: '30.00', product_categories: [15], exclude_sale_items: true, date_expires: '2027-01-31' }, ctx);
  assert.deepEqual(fetch.calls[1].json, { code: 'WINTER15', discount_type: 'percent', amount: '15', usage_limit: 200, minimum_amount: '30.00', product_categories: [15], exclude_sale_items: true, date_expires: '2027-01-31' });
  assert.equal(created.payload.code, 'winter15');

  const customers = await callTool(module, 'list_customers', { email: 'ada@example.com' }, ctx);
  assert.equal(fetch.calls[2].query.role, 'customer');
  assert.equal(fetch.calls[2].query.email, 'ada@example.com');
  assert.deepEqual(customers.payload.customers[0], { id: 88, email: 'ada@example.com', first_name: 'Ada', last_name: 'Example', username: 'ada', role: 'customer', is_paying_customer: true, date_created: '2026-09-14T12:00:00' });

  const sales = await callTool(module, 'get_report', { report: 'sales', date_min: '2026-11-20', date_max: '2026-11-21' }, ctx);
  assert.equal(fetch.calls[3].url, `${API}/reports/sales?date_min=2026-11-20&date_max=2026-11-21`);
  assert.equal(sales.payload.summary.total_sales, '1250.40');
  assert.deepEqual(sales.payload.totals[1], { date: '2026-11-21', sales: '640.20', orders: 14, items: 23, tax: '79.20', shipping: '35.00', discount: '12.00', customers: 2 });
  const top = await callTool(module, 'get_report', { report: 'top_sellers', period: 'month' }, ctx);
  assert.equal(fetch.calls[4].query.period, 'month');
  assert.deepEqual(top.payload.top_sellers[0], { product_id: 101, title: 'Ceramic Pour-Over Dripper', quantity: 12 });
  const totals = await callTool(module, 'get_report', { report: 'orders_totals' }, ctx);
  assert.equal(fetch.calls[5].url, `${API}/reports/orders/totals`);
  assert.deepEqual(totals.payload.counts[1], { slug: 'processing', name: 'Processing', total: 6 });

  const both = await callTool(module, 'get_report', { report: 'sales', period: 'week', date_min: '2026-11-01' }, ctx);
  assert.match(both.payload.error, /not both/);
  const undated = await callTool(module, 'get_report', { report: 'orders_totals', period: 'week' }, ctx);
  assert.match(undated.payload.error, /takes no period or dates/);
  assert.equal(fetch.calls.length, 6);
});

test('list_terms and create_term: attributes are not paged, attribute values need their attribute, an existing term comes back', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'POST') return jsonResponse(400, fixture(import.meta.url, 'term-exists.json'));
    if (request.path.endsWith('/attributes')) return jsonResponse(200, fixture(import.meta.url, 'attributes.json'));
    return jsonResponse(200, fixture(import.meta.url, 'categories.json'), pages(1, 1));
  });
  const categories = await callTool(module, 'list_terms', {}, ctx);
  assert.equal(fetch.calls[0].url, `${API}/products/categories?per_page=100&page=1`);
  assert.deepEqual(categories.payload.categories[0], { id: 15, name: 'Brewing & Gear', slug: 'brewing-gear', count: 12 });
  const attributes = await callTool(module, 'list_terms', { taxonomy: 'attributes' }, ctx);
  assert.equal(fetch.calls[1].url, `${API}/products/attributes`);
  assert.deepEqual(attributes.payload.attributes[0], { id: 1, name: 'Color', slug: 'pa_color', type: 'select' });
  const missing = await callTool(module, 'list_terms', { taxonomy: 'attribute_terms' }, ctx);
  assert.match(missing.payload.error, /attribute_terms needs attribute_id/);
  await callTool(module, 'list_terms', { taxonomy: 'attribute_terms', attribute_id: 1 }, ctx);
  assert.equal(fetch.calls[2].path, '/shop/wp-json/wc/v3/products/attributes/1/terms');

  const created = await callTool(module, 'create_term', { taxonomy: 'categories', name: 'Brewing & Gear' }, ctx);
  assert.equal(fetch.calls[3].method, 'POST');
  assert.equal(fetch.calls[4].query.search, 'Brewing & Gear');
  assert.deepEqual(created.payload, { id: 15, name: 'Brewing & Gear', slug: 'brewing-gear', count: 12, existing: true });
});

test('errors: the hints, a 404 page, a rate limit, and unclear writes reported as unknown after one request', async () => {
  const auth = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const denied = await callTool(auth.module, 'list_orders', {}, auth.ctx);
  assert.equal(denied.payload.vendorCode, 'woocommerce_rest_cannot_view');
  assert.match(denied.payload.error, /Sorry, you cannot list resources.*drops the Authorization header/);

  const page = setup(() => textResponse(404, '<html>Not found</html>', { 'content-type': 'text/html' }));
  const missing = await callTool(page.module, 'list_products', {}, page.ctx);
  assert.match(missing.payload.error, /found nothing there \(HTTP 404\)\. Check that the store URL is the address of the site the store runs on/);

  const limited = setup(() => jsonResponse(429, { code: 'rate_limited', message: 'Too many requests' }, { 'retry-after': '20' }));
  const rate = await callTool(limited.module, 'list_coupons', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 20);

  for (const [tool, args, check] of [
    ['create_coupon', { code: 'X', discount_type: 'percent', amount: '5' }, 'list_coupons'],
    ['create_refund', { order_id: 1, amount: '1.00' }, 'get_order'],
    ['update_order', { id: 1, status: 'completed' }, 'get_order'],
  ]) {
    const broken = setup(() => jsonResponse(503, { code: 'unavailable', message: 'Down' }));
    const unknown = await callTool(broken.module, tool, args, broken.ctx);
    assert.equal(unknown.payload.outcome, 'unknown', tool);
    assert.equal(unknown.payload.check, check);
    assert.equal(broken.fetch.calls.length, 1);
  }
});

test('api_get and api_request stay on the WooCommerce routes of the store', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, [{ id: 1 }], pages(1, 1)));
  const read = await callTool(module, 'api_get', { path: '/wc/v3/customers/88/downloads' }, ctx);
  assert.equal(fetch.calls[0].url, `${API}/customers/88/downloads`);
  assert.equal(fetch.calls[0].headers.authorization, BASIC);
  assert.deepEqual(read.payload.headers, { 'x-wp-total': '1', 'x-wp-totalpages': '1' });
  await callTool(module, 'api_get', { path: '/wc-analytics/reports/revenue/stats', query: { interval: 'day' } }, ctx);
  assert.equal(fetch.calls[1].url, 'https://example.com/shop/wp-json/wc-analytics/reports/revenue/stats?interval=day');
  await callTool(module, 'api_request', { method: 'POST', path: '/wc/v3/products/batch', json: { update: [{ id: 101, regular_price: '30.00' }] } }, ctx);
  assert.equal(fetch.calls[2].url, `${API}/products/batch`);
  await callTool(module, 'api_get', { path: '/wc/v3/webhooks' }, ctx);
  assert.equal(fetch.calls[3].url, `${API}/webhooks`);

  for (const [tool, args, pattern] of [
    ['api_get', { path: '/wp/v2/users' }, /must start with \/wc\/v3\//],
    ['api_get', { path: '/wc/v3/products', query: { _method: 'DELETE' } }, /_method is not allowed/],
    ['api_request', { method: 'POST', path: '/wc-analytics/reports/import' }, /read-only/],
    ['api_request', { method: 'POST', path: '/wc/v3/webhooks', json: { topic: 'order.created', delivery_url: 'https://elsewhere.example' } }, /Webhooks/],
    ['api_request', { method: 'PUT', path: '/wc/v3/payment_gateways/paypal', json: { settings: { email: 'x@example.com' } } }, /Payment gateway/],
    ['api_request', { method: 'PUT', path: '/wc/v3/system_status/tools/clear_transients' }, /System status tools/],
  ]) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, pattern);
  }
  assert.equal(fetch.calls.length, 4);

  const broken = setup(() => jsonResponse(500, {}));
  const unknown = await callTool(broken.module, 'api_request', { method: 'DELETE', path: '/wc/v3/products/101', query: { force: true } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('log lines carry no credentials and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(201, fixture(import.meta.url, 'note-created.json')));
  await callTool(module, 'add_order_note', { id: 5521, note: 'Private note about Ada' }, ctx);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.doesNotMatch(line, /ck_|cs_|Ada|Basic|5521/);
    assert.match(line, /^woocommerce add_order_note POST 201 \d+ms$/);
  }
});
