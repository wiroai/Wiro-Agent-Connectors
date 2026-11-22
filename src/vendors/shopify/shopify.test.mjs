import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'shpca_' + '0123456789abcdef'.repeat(2);
const credentials = { shopdomain: 'example-shop.myshopify.com', access_token: TOKEN };
const ENDPOINT = 'https://example-shop.myshopify.com/admin/api/2026-07/graphql.json';

function setup(handler, overrides = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: { ...credentials, ...overrides }, fetch });
  return { module, fetch, ctx, logs };
}

/** A handler answering each GraphQL request by the first word after query/mutation in its document. */
function byOperation(answers) {
  return (request) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(request.json?.query ?? '')?.[1];
    const answer = answers[name];
    if (!answer) throw new Error(`no answer for ${name}`);
    return typeof answer === 'function' ? answer(request) : jsonResponse(200, answer);
  };
}

const load = (name) => fixture(import.meta.url, name);

test('get_shop posts one query to the pinned Admin API version with the access token header', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('shop.json')));
  const { payload, isError } = await callTool(module, 'get_shop', {}, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.headers['x-shopify-access-token'], TOKEN);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, undefined);
  assert.match(request.json.query, /^query ShopIdentity/);
  assert.deepEqual(request.json.variables, {});
  assert.deepEqual(payload, {
    id: 'gid://shopify/Shop/72000000001',
    name: 'Example Coffee Co',
    myshopifyDomain: 'example-shop.myshopify.com',
    primaryDomain: 'https://shop.example.com',
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    weightUnit: 'KILOGRAMS',
    plan: 'Basic',
    accessScopes: ['read_products', 'write_products', 'read_orders', 'read_inventory', 'write_inventory'],
    apiVersion: '2026-07',
  });

  const other = setup(() => jsonResponse(200, load('shop.json')), { shopdomain: 'https://second-shop.myshopify.com/admin' });
  const mismatch = await callTool(other.module, 'get_shop', {}, other.ctx);
  assert.equal(other.fetch.calls[0].url, 'https://second-shop.myshopify.com/admin/api/2026-07/graphql.json');
  assert.match(mismatch.payload.warning, /belongs to example-shop\.myshopify\.com, not to second-shop\.myshopify\.com/);
});

test('only a <shop>.myshopify.com address is used; anything else is refused before a request', async () => {
  for (const shopdomain of ['shop.example.com', 'example-shop', 'admin.shopify.com', 'https://example-shop.myshopify.com:8443', 'a.b.myshopify.com']) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, load('shop.json')), { shopdomain });
    const { payload, isError } = await callTool(module, 'list_products', {}, ctx);
    assert.equal(isError, true, shopdomain);
    assert.match(payload.error, /must be the store's own <shop>\.myshopify\.com address/);
    assert.equal(fetch.calls.length, 0);
  }
  const insecure = setup(() => jsonResponse(200, {}), { shopdomain: 'http://example-shop.myshopify.com' });
  const refused = await callTool(insecure.module, 'get_shop', {}, insecure.ctx);
  assert.match(refused.payload.error, /Shopify is not connected correctly: the Shopify shop domain must be an https address/);
  assert.equal(insecure.fetch.calls.length, 0);
  const missing = setup(() => jsonResponse(200, {}), { access_token: '' });
  const notConnected = await callTool(missing.module, 'get_shop', {}, missing.ctx);
  assert.match(notConnected.payload.error, /Shopify is not connected: the Shopify access token is missing/);
});

test('list_products trims products, and the cursor continues the same search', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('products.json')));
  const first = await callTool(module, 'list_products', { query: 'status:active vendor:"Example Coffee Co"', first: 2 }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { first: 2, after: null, query: 'status:active vendor:"Example Coffee Co"', sortKey: 'UPDATED_AT', reverse: true });
  assert.deepEqual(first.payload.products[0], {
    id: 'gid://shopify/Product/8800000001',
    title: 'Ceramic Pour-Over Dripper',
    handle: 'ceramic-pour-over-dripper',
    status: 'ACTIVE',
    vendor: 'Example Coffee Co',
    productType: 'Brewing',
    tags: ['brewing', 'ceramic'],
    price: '24.0',
    currency: 'EUR',
    variants: 1,
    totalInventory: 18,
    onlineStoreUrl: 'https://shop.example.com/products/ceramic-pour-over-dripper',
    image: 'https://cdn.shopify.example/s/files/dripper.jpg',
    updatedAt: '2026-11-19T10:02:31Z',
    publishedAt: '2026-10-01T08:00:00Z',
  });
  assert.equal(first.payload.products[1].price, '20.0–22.0');
  assert.equal(first.payload.products[1].totalInventory, undefined, 'no stock count when not tracked');
  await callTool(module, 'list_products', { cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].json.variables, { first: 2, after: 'eyJsYXN0X2lkIjo4ODAwMDAwMDAyfQ==', query: 'status:active vendor:"Example Coffee Co"', sortKey: 'UPDATED_AT', reverse: true });
});

test('a page over 32 KB is cut and continues after the last product returned', async () => {
  const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `gid://shopify/Product/${index}`, title: `Product ${index} `.padEnd(290, 'x'), handle: `p-${index}-${'h'.repeat(80)}` }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: { products: { nodes, pageInfo: { hasNextPage: false, endCursor: 'c' } } } }));
  const first = await callTool(module, 'list_products', { first: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.products.length;
  const second = await callTool(module, 'list_products', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.variables.after, null);
  assert.equal(second.payload.products[0].id, `gid://shopify/Product/${shown}`);
});

test('get_product by id or handle returns its variants with what the write tools need', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('product.json')));
  const { payload } = await callTool(module, 'get_product', { id: '8800000002' }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { id: 'gid://shopify/Product/8800000002', variantsAfter: null });
  assert.equal(payload.descriptionHtml, '<p>Soft cotton tee.</p>');
  assert.deepEqual(payload.options, [{ name: 'Size', values: ['S', 'M'] }]);
  assert.equal(payload.variantCount, 2);
  assert.deepEqual(payload.variants[1], {
    id: 'gid://shopify/ProductVariant/5500000002',
    title: 'M',
    sku: 'TEE-M',
    barcode: '4006381333931',
    price: '22.00',
    compareAtPrice: '25.00',
    options: 'Size: M',
    inventoryQuantity: 15,
    inventoryPolicy: 'DENY',
    availableForSale: true,
    taxable: true,
    inventoryItemId: 'gid://shopify/InventoryItem/6600000002',
    tracked: true,
    requiresShipping: true,
  });
  assert.ok(payload.nextCursor);
  assert.deepEqual(payload.collections, [{ id: 'gid://shopify/Collection/4400000001', title: 'Merch', handle: 'merch' }]);

  await callTool(module, 'get_product', { handle: 'logo-t-shirt', cursor: payload.nextCursor }, ctx);
  assert.match(fetch.calls[1].json.query, /productByIdentifier\(identifier: \{ handle: \$handle \}\)/);
  assert.deepEqual(fetch.calls[1].json.variables, { handle: 'logo-t-shirt', variantsAfter: 'eyJ2YXJpYW50cyI6Mn0=' });

  const none = setup(() => jsonResponse(200, { data: { product: null } }));
  const missing = await callTool(none.module, 'get_product', { id: 'gid://shopify/Product/1' }, none.ctx);
  assert.match(missing.payload.error, /found no product with that id/);
  const both = await callTool(module, 'get_product', { id: '1', handle: 'x' }, ctx);
  assert.match(both.payload.error, /Give id or handle/);
  assert.equal(fetch.calls.length, 2);
});

test('get_product cuts a long variant list to fit and continues where it stopped', async () => {
  const product = load('product.json');
  const many = Array.from({ length: 100 }, (_, index) => ({
    ...product.data.product.variants.nodes[0],
    id: `gid://shopify/ProductVariant/${7000000000 + index}`,
    title: `Size ${index} / Color ${'x'.repeat(40)}`,
    sku: `SKU-${index}-${'y'.repeat(30)}`,
    inventoryItem: { id: `gid://shopify/InventoryItem/${8000000000 + index}`, tracked: true, requiresShipping: true },
  }));
  const body = { data: { product: { ...product.data.product, variants: { nodes: many, pageInfo: { hasNextPage: false, endCursor: 'end' } } } } };
  const { module, fetch, ctx } = setup(() => jsonResponse(200, body));
  const first = await callTool(module, 'get_product', { id: '8800000002' }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  assert.equal(first.payload.title, 'Logo T-Shirt', 'the product fields stay');
  const shown = first.payload.variants.length;
  const second = await callTool(module, 'get_product', { id: '8800000002', cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.variables.variantsAfter, null);
  assert.equal(second.payload.variants[0].id, `gid://shopify/ProductVariant/${7000000000 + shown}`);
});

test('create_product checks the handle and SKUs, then creates the product with its options, variants, stock and images in one productSet', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Duplicates: load('duplicates-none.json'), CreateProduct: load('product-set.json') }));
  const { payload, isError } = await callTool(module, 'create_product', {
    title: 'Hoodie',
    handle: 'hoodie',
    description_html: '<p>Warm.</p>',
    tags: ['apparel'],
    options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [
      { option_values: { Size: 'S' }, price: '45.00', sku: 'HOOD-S', inventory_quantities: [{ location_id: '7700000001', quantity: 5 }] },
      { option_values: { Size: 'M' }, price: '45.00', sku: 'HOOD-M', compare_at_price: '55.00' },
    ],
    images: [{ url: 'https://cdn.example.net/hoodie.jpg', alt: 'Grey hoodie' }],
  }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[0].json.variables, { handle: 'hoodie', hasHandle: true, skuQuery: 'sku:HOOD-S OR sku:HOOD-M', hasSkus: true });
  const { input } = fetch.calls[1].json.variables;
  assert.match(fetch.calls[1].json.query, /productSet\(input: \$input, synchronous: true\)/);
  assert.deepEqual(input, {
    title: 'Hoodie',
    descriptionHtml: '<p>Warm.</p>',
    tags: ['apparel'],
    handle: 'hoodie',
    status: 'DRAFT',
    productOptions: [{ name: 'Size', values: [{ name: 'S' }, { name: 'M' }] }],
    variants: [
      {
        optionValues: [{ optionName: 'Size', name: 'S' }],
        price: '45.00',
        sku: 'HOOD-S',
        inventoryItem: { tracked: true },
        inventoryQuantities: [{ locationId: 'gid://shopify/Location/7700000001', name: 'available', quantity: 5 }],
      },
      { optionValues: [{ optionName: 'Size', name: 'M' }], price: '45.00', compareAtPrice: '55.00', sku: 'HOOD-M' },
    ],
    files: [{ originalSource: 'https://cdn.example.net/hoodie.jpg', alt: 'Grey hoodie', contentType: 'IMAGE' }],
  });
  assert.equal(payload.id, 'gid://shopify/Product/8800000010');
  assert.equal(payload.status, 'DRAFT');
  assert.equal(payload.variants.length, 2);
  assert.match(payload.note, /A draft/);
});

test('create_product without options makes one default variant, and refuses duplicates and broken options before writing', async () => {
  const { module, fetch, ctx } = setup(byOperation({ CreateProduct: load('product-set.json'), Duplicates: load('duplicates-found.json') }));
  await callTool(module, 'create_product', { title: 'Mug', status: 'ACTIVE', variants: [{ price: '12.00' }], allow_duplicates: true }, ctx);
  assert.equal(fetch.calls.length, 1, 'no duplicate check with allow_duplicates');
  assert.deepEqual(fetch.calls[0].json.variables.input.productOptions, [{ name: 'Title', values: [{ name: 'Default Title' }] }]);
  assert.deepEqual(fetch.calls[0].json.variables.input.variants, [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], price: '12.00' }]);

  const duplicate = await callTool(module, 'create_product', { title: 'Hoodie', handle: 'hoodie', options: [{ name: 'Size', values: ['S'] }], variants: [{ option_values: { Size: 'S' }, sku: 'HOOD-S' }] }, ctx);
  assert.match(duplicate.payload.error, /the handle hoodie is taken by gid:\/\/shopify\/Product\/8800000009.*the SKU HOOD-S is on gid:\/\/shopify\/Product\/8800000009.*Nothing was changed/);
  assert.doesNotMatch(duplicate.payload.error, /OTHER/);
  assert.equal(fetch.calls.length, 2, 'only the check');

  for (const [args, pattern] of [
    [{ title: 'X', variants: [{ price: '1' }, { price: '2' }] }, /Several variants need options/],
    [{ title: 'X', options: [{ name: 'Size', values: ['S', 'M'] }], variants: [{ option_values: { Size: 'XL' } }] }, /needs a value for Size, one of: S, M/],
    [{ title: 'X', options: [{ name: 'Size', values: ['S'] }], variants: [{ option_values: { Size: 'S', Color: 'Red' } }] }, /names Color, which is not one of the options/],
    [{ title: 'X', options: [{ name: 'Size', values: ['S'] }], variants: [{ option_values: { Size: 'S' } }, { option_values: { Size: 'S' } }] }, /repeats the option values/],
  ]) {
    const { payload } = await callTool(module, 'create_product', args, ctx);
    assert.match(payload.error, pattern);
  }
  assert.equal(fetch.calls.length, 2);

  const refused = setup(byOperation({ CreateProduct: load('product-set-errors.json') }));
  const errors = await callTool(refused.module, 'create_product', { title: 'X', allow_duplicates: true, variants: [{ price: '1' }] }, refused.ctx);
  assert.match(errors.payload.error, /Shopify did not create the product: input\.variants\.0\.price: Price must be greater than or equal to 0\. Nothing was changed\./);
  assert.equal(errors.payload.vendorCode, 'INVALID_VARIANT');
});

test('update_product sends only the given fields, redirects a changed handle and adds images', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('product-update.json')));
  const { payload } = await callTool(module, 'update_product', {
    id: '8800000002',
    title: 'Logo Tee',
    handle: 'logo-tee',
    status: 'ACTIVE',
    tags: ['apparel', 'new'],
    seo_title: 'Logo Tee',
    collections_to_join: ['4400000002'],
    add_images: [{ url: 'https://cdn.example.net/tee-back.jpg', alt: 'Back' }],
  }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, {
    product: {
      id: 'gid://shopify/Product/8800000002',
      title: 'Logo Tee',
      tags: ['apparel', 'new'],
      handle: 'logo-tee',
      redirectNewHandle: true,
      status: 'ACTIVE',
      seo: { title: 'Logo Tee' },
      collectionsToJoin: ['gid://shopify/Collection/4400000002'],
    },
    media: [{ originalSource: 'https://cdn.example.net/tee-back.jpg', alt: 'Back', mediaContentType: 'IMAGE' }],
  });
  assert.equal(payload.title, 'Logo Tee');
  assert.equal(payload.imagesAdded, 1);
  const nothing = await callTool(module, 'update_product', { id: '1' }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  const badId = await callTool(module, 'update_product', { id: 'gid://shopify/Order/1', title: 'x' }, ctx);
  assert.match(badId.payload.error, /does not have the expected format/);
  assert.equal(fetch.calls.length, 1);
});

test('update_variants changes prices and SKUs in one call; "" removes a compare-at price', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('variants-update.json')));
  const { payload } = await callTool(module, 'update_variants', { product_id: '8800000002', variants: [{ id: '5500000002', price: '19.00', compare_at_price: '', sku: 'TEE-M2' }] }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, {
    productId: 'gid://shopify/Product/8800000002',
    variants: [{ id: 'gid://shopify/ProductVariant/5500000002', price: '19.00', inventoryItem: { sku: 'TEE-M2' }, compareAtPrice: null }],
  });
  assert.equal(payload.variants[0].price, '19.00');
  const empty = await callTool(module, 'update_variants', { product_id: '1', variants: [{ id: '2' }] }, ctx);
  assert.match(empty.payload.error, /changes nothing/);
});

test('list_publications and publish_product', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Publications: load('publications.json'), ProductPublications: load('product-publications.json'), Publish: load('publish.json') }));
  const channels = await callTool(module, 'list_publications', {}, ctx);
  assert.deepEqual(channels.payload.publications, [
    { id: 'gid://shopify/Publication/1100000001', name: 'Online Store', futurePublishing: true },
    { id: 'gid://shopify/Publication/1100000002', name: 'Point of Sale' },
  ]);
  const state = await callTool(module, 'list_publications', { product_id: '8800000002' }, ctx);
  assert.deepEqual(state.payload.publications, [{ id: 'gid://shopify/Publication/1100000001', name: 'Online Store', published: false }]);
  const published = await callTool(module, 'publish_product', { product_id: '8800000002', publication_ids: ['1100000001'] }, ctx);
  assert.match(fetch.calls[2].json.query, /publishablePublish\(id: \$id, input: \$input\)/);
  assert.deepEqual(fetch.calls[2].json.variables, { id: 'gid://shopify/Product/8800000002', input: [{ publicationId: 'gid://shopify/Publication/1100000001' }] });
  assert.match(published.payload.note, /status is DRAFT/);
});

test('collections, locations and stock levels', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Collections: load('collections.json'), Locations: load('locations.json'), VariantStock: load('inventory-variant.json') }));
  const collections = await callTool(module, 'list_collections', {}, ctx);
  assert.equal(collections.payload.collections[0].kind, 'manual');
  assert.equal(collections.payload.collections[1].rules, 'TAG EQUALS sale OR IS_PRICE_REDUCED IS_SET');
  const locations = await callTool(module, 'list_locations', {}, ctx);
  assert.deepEqual(locations.payload.locations, [{ id: 'gid://shopify/Location/7700000001', name: 'Berlin warehouse', active: true, fulfillsOnlineOrders: true, city: 'Berlin', country: 'DE' }]);
  assert.equal(fetch.calls[1].json.variables.includeInactive, false);
  const stock = await callTool(module, 'get_inventory', { variant_id: '5500000001' }, ctx);
  assert.deepEqual(stock.payload, {
    inventoryItemId: 'gid://shopify/InventoryItem/6600000001',
    sku: 'TEE-S',
    tracked: true,
    variant: { id: 'gid://shopify/ProductVariant/5500000001', title: 'S', product: 'Logo T-Shirt', productId: 'gid://shopify/Product/8800000002' },
    levels: [{ locationId: 'gid://shopify/Location/7700000001', location: 'Berlin warehouse', available: 10, on_hand: 12, committed: 2, incoming: 0, reserved: 0, updatedAt: '2026-11-21T07:40:00Z' }],
  });
});

test('set_inventory_quantity reads the current stock, sends it as changeFromQuantity with an idempotency key, and the same call gets the same key', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Stock: load('stock-level.json'), SetQuantity: load('set-quantities.json') }));
  const { payload, isError } = await callTool(module, 'set_inventory_quantity', { variant_id: '5500000001', location_id: '7700000001', quantity: 15 }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[0].json.variables, { id: 'gid://shopify/ProductVariant/5500000001', locationId: 'gid://shopify/Location/7700000001', name: 'available' });
  const mutation = fetch.calls[1].json;
  assert.match(mutation.query, /inventorySetQuantities\(input: \$input\) @idempotent\(key: \$key\)/);
  assert.deepEqual(mutation.variables.input, {
    name: 'available',
    reason: 'correction',
    quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/6600000001', locationId: 'gid://shopify/Location/7700000001', quantity: 15, changeFromQuantity: 10 }],
  });
  assert.match(mutation.variables.key, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(payload.previousQuantity, 10);
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.changes[0], { name: 'available', delta: 5, quantityAfterChange: 15, location: 'Berlin warehouse' });

  await callTool(module, 'set_inventory_quantity', { inventory_item_id: '6600000001', location_id: '7700000001', quantity: 15, expected_quantity: 10 }, ctx);
  assert.equal(fetch.calls.length, 3, 'with expected_quantity and the item id, no read');
  assert.equal(fetch.calls[2].json.variables.key, mutation.variables.key, 'the same change gets the same key');

  await callTool(module, 'set_inventory_quantity', { inventory_item_id: '6600000001', location_id: '7700000001', quantity: 15, skip_quantity_check: true, reason: 'received' }, ctx);
  assert.equal(fetch.calls[3].json.variables.input.quantities[0].changeFromQuantity, null);
  assert.equal(fetch.calls[3].json.variables.input.reason, 'received');
  const both = await callTool(module, 'set_inventory_quantity', { inventory_item_id: '1', location_id: '2', quantity: 1, expected_quantity: 0, skip_quantity_check: true }, ctx);
  assert.match(both.payload.error, /not both/);
  assert.equal(fetch.calls.length, 4);
});

test('set_inventory_quantity reports a stale quantity and an item not stocked at the location', async () => {
  const stale = setup(byOperation({ SetQuantity: load('set-stale.json') }));
  const moved = await callTool(stale.module, 'set_inventory_quantity', { inventory_item_id: '6600000001', location_id: '7700000001', quantity: 3, expected_quantity: 10 }, stale.ctx);
  assert.equal(moved.payload.vendorCode, 'CHANGE_FROM_QUANTITY_STALE');
  assert.match(moved.payload.error, /The stock is no longer 10: it changed since it was read\. Read it again with get_inventory/);

  const absent = setup(byOperation({ Stock: load('stock-not-stocked.json') }));
  const notStocked = await callTool(absent.module, 'set_inventory_quantity', { inventory_item_id: '6600000001', location_id: '7700000009', quantity: 3 }, absent.ctx);
  assert.match(notStocked.payload.error, /not stocked at that location/);
  assert.equal(absent.fetch.calls.length, 1, 'no mutation');
});

test('orders: the list has no customer details; get_order by name keeps protected fields Shopify withheld as warnings', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Orders: load('orders.json'), OrderByName: load('order.json') }));
  const list = await callTool(module, 'list_orders', { query: 'financial_status:paid' }, ctx);
  assert.deepEqual(list.payload.orders[1], {
    id: 'gid://shopify/Order/9900000002',
    name: '#1002',
    createdAt: '2026-11-22T08:00:00Z',
    financialStatus: 'PARTIALLY_REFUNDED',
    fulfillmentStatus: 'FULFILLED',
    total: '19.0',
    currency: 'EUR',
    refunded: '5.0',
    items: 1,
    returnStatus: 'RETURN_REQUESTED',
    closed: true,
    test: true,
    tags: ['gift'],
  });
  assert.equal(list.payload.orders[0].refunded, undefined);
  assert.doesNotMatch(fetch.calls[0].json.query, /customer|email|Address/);

  const { payload } = await callTool(module, 'get_order', { name: '#1001', include_customer_details: true }, ctx);
  assert.deepEqual(fetch.calls[1].json.variables, { query: 'name:#1001', contact: true });
  assert.equal(payload.name, '#1001');
  assert.equal(payload.note, 'Gift wrap please');
  assert.deepEqual(payload.fulfillmentOrders[0], {
    id: 'gid://shopify/FulfillmentOrder/1300000001',
    status: 'OPEN',
    requestStatus: 'UNSUBMITTED',
    location: 'Berlin warehouse',
    locationId: 'gid://shopify/Location/7700000001',
    lineItems: [{ id: 'gid://shopify/FulfillmentOrderLineItem/1400000001', name: 'Ceramic Pour-Over Dripper', remainingQuantity: 2, totalQuantity: 2 }],
  });
  assert.equal(payload.tax, '8.6');
  assert.equal(payload.discounts, undefined);
  assert.match(payload.warnings[0], /not approved to access the Customer object/);

  const missing = await callTool(module, 'get_order', { name: '1009' }, ctx);
  assert.match(missing.payload.error, /found no order with that name/);
});

test('fulfill_order ships what is left of a fulfillment order with tracking', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('fulfillment.json')));
  const { payload } = await callTool(module, 'fulfill_order', { fulfillment_order_id: '1300000001', tracking_company: 'DHL Express', tracking_number: 'JD0000000001', notify_customer: true }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, {
    fulfillment: {
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1300000001' }],
      trackingInfo: { company: 'DHL Express', number: 'JD0000000001' },
      notifyCustomer: true,
    },
  });
  assert.equal(payload.status, 'SUCCESS');
  assert.deepEqual(payload.items, [{ name: 'Ceramic Pour-Over Dripper', sku: 'DRIP-01', quantity: 2 }]);
  await callTool(module, 'fulfill_order', { fulfillment_order_id: '1300000001', line_items: [{ id: '1400000001', quantity: 1 }] }, ctx);
  assert.deepEqual(fetch.calls[1].json.variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems, [{ id: 'gid://shopify/FulfillmentOrderLineItem/1400000001', quantity: 1 }]);
});

test('customers and discounts', async () => {
  const { module, fetch, ctx } = setup(byOperation({ Customers: load('customers.json'), Discounts: load('discounts.json'), DiscountByCode: load('discount-by-code.json') }));
  const customers = await callTool(module, 'list_customers', { query: 'email:ada@example.com', include_contact: true }, ctx);
  assert.equal(fetch.calls[0].json.variables.contact, true);
  assert.deepEqual(customers.payload.customers[0], {
    id: 'gid://shopify/Customer/1600000001',
    firstName: 'Ada',
    lastName: 'Example',
    email: 'ada@example.com',
    state: 'ENABLED',
    numberOfOrders: '4',
    amountSpent: '180.5',
    currency: 'EUR',
    tags: ['vip'],
    createdAt: '2026-03-01T10:00:00Z',
    updatedAt: '2026-11-21T18:04:11Z',
  });
  const discounts = await callTool(module, 'list_discounts', { query: 'status:active' }, ctx);
  assert.deepEqual(discounts.payload.discounts[0], {
    id: 'gid://shopify/DiscountCodeNode/1700000001',
    kind: 'CodeBasic',
    title: 'Welcome 10',
    status: 'ACTIVE',
    summary: '10% off entire order • One use per customer',
    codes: ['WELCOME10'],
    startsAt: '2026-10-01T00:00:00Z',
    usageLimit: 500,
    used: 41,
    oncePerCustomer: true,
  });
  assert.equal(discounts.payload.discounts[1].kind, 'AutomaticFreeShipping');
  const byCode = await callTool(module, 'list_discounts', { code: 'WELCOME10' }, ctx);
  assert.deepEqual(fetch.calls[2].json.variables, { code: 'WELCOME10' });
  assert.equal(byCode.payload.discounts[0].codes[0], 'WELCOME10');
});

test('create_discount_code builds the discount input, and Shopify\'s refusal of a taken code changes nothing', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('discount-created.json')));
  const { payload } = await callTool(module, 'create_discount_code', {
    code: 'WINTER15',
    percentage: 15,
    starts_at: '2026-12-01T00:00:00Z',
    ends_at: '2027-01-31T23:59:59Z',
    usage_limit: 200,
    once_per_customer: true,
    minimum_subtotal: '30.00',
    collection_ids: ['4400000001'],
    combines_with_shipping_discounts: true,
  }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables.basicCodeDiscount, {
    title: 'WINTER15',
    code: 'WINTER15',
    startsAt: '2026-12-01T00:00:00Z',
    endsAt: '2027-01-31T23:59:59Z',
    usageLimit: 200,
    appliesOncePerCustomer: true,
    context: { all: 'ALL' },
    customerGets: { value: { percentage: 0.15 }, items: { collections: { add: ['gid://shopify/Collection/4400000001'] } } },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '30.00' } },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  });
  assert.equal(payload.id, 'gid://shopify/DiscountCodeNode/1700000003');
  assert.deepEqual(payload.codes, ['WINTER15']);

  await callTool(module, 'create_discount_code', { code: 'FIVE', amount: '5.00', product_ids: ['8800000001'], minimum_quantity: 2 }, ctx);
  const fixed = fetch.calls[1].json.variables.basicCodeDiscount;
  assert.deepEqual(fixed.customerGets, { value: { discountAmount: { amount: '5.00', appliesOnEachItem: false } }, items: { products: { productsToAdd: ['gid://shopify/Product/8800000001'] } } });
  assert.deepEqual(fixed.minimumRequirement, { quantity: { greaterThanOrEqualToQuantity: '2' } });
  assert.ok(!Number.isNaN(Date.parse(fixed.startsAt)), 'starts now by default');

  for (const [args, pattern] of [
    [{ code: 'X' }, /Give percentage or amount/],
    [{ code: 'X', percentage: 10, amount: '1' }, /Give percentage or amount/],
    [{ code: 'X', percentage: 10, product_ids: ['1'], collection_ids: ['2'] }, /not both/],
    [{ code: 'X', percentage: 10, minimum_subtotal: '1', minimum_quantity: 1 }, /not both/],
    [{ code: 'X', percentage: 10, ends_at: 'soon' }, /ends_at is not a date/],
  ]) {
    const refused = await callTool(module, 'create_discount_code', args, ctx);
    assert.match(refused.payload.error, pattern);
  }
  assert.equal(fetch.calls.length, 2);

  const taken = setup(() => jsonResponse(200, load('discount-duplicate.json')));
  const duplicate = await callTool(taken.module, 'create_discount_code', { code: 'WELCOME10', percentage: 10 }, taken.ctx);
  assert.match(duplicate.payload.error, /Shopify did not create the discount: basicCodeDiscount\.code: Code must be unique\. Please try a different code\. Nothing was changed\./);
});

test('graphql_query runs queries only, and returns data with the query cost', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, load('shop.json')));
  const query = '# shop name\nquery Q($n: Int = 1) { shop { name } ...F }\nfragment F on QueryRoot { products(first: $n, query: "title:\\"mutation\\"") { nodes { id } } }';
  const { payload } = await callTool(module, 'graphql_query', { query, variables: { n: 2 } }, ctx);
  assert.equal(fetch.calls[0].json.query, query);
  assert.deepEqual(fetch.calls[0].json.variables, { n: 2 });
  assert.equal(payload.data.shop.name, 'Example Coffee Co');
  assert.deepEqual(payload.cost, { requested: 2, actual: 2, available: 1998, restoreRate: 100 });

  for (const [document, pattern] of [
    ['mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId } }', /runs queries only/],
    ['query A { shop { name } }\nmutation B { tagsAdd(id: "x", tags: ["y"]) { node { id } } }', /runs queries only/],
    ['{ shop { name } }\nsubscription S { x }', /runs queries only/],
    ['query { shop { name "unterminated } }', /could not be read: a string is not closed/],
    ['type Shop { name: String }', /only query, mutation and fragment definitions/],
    ['query { shop { name }', /a "\{" is not closed/],
  ]) {
    const refused = await callTool(module, 'graphql_query', { query: document }, ctx);
    assert.equal(refused.isError, true, document);
    assert.match(refused.payload.error, pattern);
  }
  assert.equal(fetch.calls.length, 1);
});

test('graphql_mutation: refusals before sending, userErrors, partial success and an unclear outcome', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: { tagsAdd: { node: { id: 'gid://shopify/Product/1' }, userErrors: [] } } }));
  const sent = await callTool(module, 'graphql_mutation', { query: 'mutation T($id: ID!) { tagsAdd(id: $id, tags: ["sale"]) { node { id } userErrors { field message } } }', variables: { id: 'gid://shopify/Product/1' } }, ctx);
  assert.equal(sent.isError, false);
  assert.equal(sent.payload.data.tagsAdd.node.id, 'gid://shopify/Product/1');

  for (const [document, pattern] of [
    ['query { shop { name } }', /holds no mutation/],
    ['mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { callbackUrl: "https://elsewhere.example" }) { userErrors { message } } }', /webhookSubscriptionCreate cannot be sent/],
    ['mutation { ...M }\nfragment M on Mutation { storefrontAccessTokenCreate(input: { title: "x" }) { storefrontAccessToken { accessToken } } }', /storefrontAccessTokenCreate cannot be sent/],
    ['mutation A($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { message } } }', /inventoryAdjustQuantities needs @idempotent/],
  ]) {
    const refused = await callTool(module, 'graphql_mutation', { query: document }, ctx);
    assert.equal(refused.isError, true, document);
    assert.match(refused.payload.error, pattern);
    assert.match(refused.payload.error, /Nothing was sent/);
  }
  assert.equal(fetch.calls.length, 1);
  await callTool(module, 'graphql_mutation', { query: 'mutation A($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) @idempotent(key: "k-1") { userErrors { message } } }', variables: { input: {} } }, ctx);
  assert.equal(fetch.calls.length, 2, 'with the directive it is sent');

  const refusedAll = setup(() => jsonResponse(200, { data: { customerCreate: { customer: null, userErrors: [{ field: ['input', 'email'], message: 'Email has already been taken' }] } } }));
  const failed = await callTool(refusedAll.module, 'graphql_mutation', { query: 'mutation { customerCreate(input: { email: "ada@example.com" }) { customer { id } userErrors { field message } } }' }, refusedAll.ctx);
  assert.match(failed.payload.error, /Shopify did not make the change: customerCreate: input\.email Email has already been taken\. Nothing was changed\./);

  const partial = setup(() => jsonResponse(200, { data: { a: { node: { id: '1' }, userErrors: [] }, b: { node: null, userErrors: [{ field: ['tags'], message: 'Invalid' }] } } }));
  const half = await callTool(partial.module, 'graphql_mutation', { query: 'mutation { a: tagsAdd(id: "1", tags: ["x"]) { node { id } userErrors { field message } } b: tagsAdd(id: "2", tags: [""]) { node { id } userErrors { field message } } }' }, partial.ctx);
  assert.equal(half.isError, false);
  assert.match(half.payload.userErrors, /Shopify refused b; the rest was done/);

  const internal = setup(() => jsonResponse(200, load('internal-error.json')));
  const unknown = await callTool(internal.module, 'graphql_mutation', { query: 'mutation { tagsAdd(id: "1", tags: ["x"]) { node { id } } }' }, internal.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'graphql_query');
  assert.equal(internal.fetch.calls.length, 1);
});

test('GraphQL errors: throttling carries retryAfter, access denied and validation errors say why, nothing changed', async () => {
  const throttled = setup(() => jsonResponse(200, load('throttled.json')));
  const rate = await callTool(throttled.module, 'list_products', {}, throttled.ctx);
  assert.equal(rate.payload.vendorCode, 'THROTTLED');
  assert.equal(rate.payload.retryAfter, 2);
  assert.match(rate.payload.error, /Shopify rate limit reached.*Retry after 2 seconds/);

  const denied = setup(() => jsonResponse(200, load('access-denied.json')));
  const scope = await callTool(denied.module, 'list_customers', {}, denied.ctx);
  assert.equal(scope.payload.vendorCode, 'ACCESS_DENIED');
  assert.match(scope.payload.error, /Access denied for customers field\. Required access: `read_customers` access scope\. The app may lack an access scope/);

  const invalid = setup(() => jsonResponse(200, load('validation-error.json')));
  const wrong = await callTool(invalid.module, 'update_variants', { product_id: '1', variants: [{ id: '2', price: '1.00' }] }, invalid.ctx);
  assert.match(wrong.payload.error, /Shopify did not run the request: Field 'prise' doesn't exist on type 'ProductVariant'\. Nothing was changed\./);
  assert.equal(wrong.payload.outcome, undefined);

  const revoked = setup(() => jsonResponse(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' }));
  const unauthorized = await callTool(revoked.module, 'get_shop', {}, revoked.ctx);
  assert.equal(unauthorized.payload.status, 401);
  assert.match(unauthorized.payload.error, /Shopify rejected the credentials \(HTTP 401\)\. Check that the Shopify shop domain and Shopify access token are correct/);

  const scopes = setup(() => jsonResponse(403, { errors: 'This action requires merchant approval for write_products scope.' }));
  const forbidden = await callTool(scopes.module, 'update_product', { id: '1', title: 'x' }, scopes.ctx);
  assert.match(forbidden.payload.error, /the app lacks an access scope, or the staff permission, for it \(HTTP 403\)\. Nothing was changed\./);

  const down = setup(() => jsonResponse(503, {}));
  const unknown = await callTool(down.module, 'fulfill_order', { fulfillment_order_id: '1' }, down.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_order');
  assert.equal(down.fetch.calls.length, 1);
});

test('log lines carry no credentials and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, load('product-update.json')));
  await callTool(module, 'update_product', { id: '8800000002', title: 'Secret launch name' }, ctx);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.doesNotMatch(line, /shpca_|Secret launch|8800000002/);
    assert.match(line, /^shopify update_product POST 200 \d+ms$/);
  }
});
