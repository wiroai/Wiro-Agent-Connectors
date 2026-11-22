import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

// Keepa keys are 64 letters and digits.
const KEY = 'k3epa0test0key0'.padEnd(64, 'x');
const credentials = { apikey: KEY };
const product = fixture(import.meta.url, 'product.json');

/** A value from the module's sandbox, as plain JSON of this realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(typeof handler === 'function' ? handler : () => jsonResponse(200, handler));
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

/** The query of a request without the key, which every test checks once. */
function queryOf(request) {
  const { key, ...rest } = request.query;
  assert.equal(key, KEY, 'the key goes in the key parameter');
  return rest;
}

test('the module reads apikey, reaches only api.keepa.com, and every tool only reads', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.origins), ['https://api.keepa.com']);
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.accountPickers), []);
  assert.deepEqual(plain(module.tools.map((tool) => tool.name)), [
    'get_token_status', 'get_products', 'get_price_history', 'search_products', 'get_best_sellers',
    'search_categories', 'get_categories', 'find_products', 'api_get',
  ]);
  for (const tool of module.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
});

test('get_token_status reads the free token status with the key as a query parameter', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'token.json'));
  const { payload, isError } = await callTool(module, 'get_token_status', {}, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].path, '/token');
  assert.equal(fetch.calls[0].origin, 'https://api.keepa.com');
  assert.deepEqual(queryOf(fetch.calls[0]), {});
  assert.equal(fetch.calls[0].headers.authorization, undefined, 'the key goes nowhere else');
  assert.deepEqual(payload, { tokens: { used: 0, left: 297, refillRate: 5, refillInSeconds: 42 } });
});

test('a balance below 1 says when the next call can run; no plan says so too', async () => {
  const out = setup(fixture(import.meta.url, 'token-out.json'));
  const { payload } = await callTool(out.module, 'get_token_status', {}, out.ctx);
  // 21 s to the next refill, then two more refills of 5 to climb from -12 above zero.
  assert.deepEqual(payload.tokens, {
    used: 0,
    left: -12,
    refillRate: 5,
    refillInSeconds: 21,
    nextCallInSeconds: 141,
    nextCallAround: '2026-11-21T12:02Z',
    note: 'Out of tokens: the next call can run in about 3 min (around 2026-11-21T12:02Z). Do not call again before then.',
  });

  const none = setup({ timestamp: 1795262400000, tokensLeft: 0, refillIn: 0, refillRate: 0, tokensConsumed: 0 });
  const plan = await callTool(none.module, 'get_token_status', {}, none.ctx);
  assert.equal(plan.payload.tokens.note, 'No tokens and no refill rate: the key has no active Keepa API plan.');

  const reduced = setup({ timestamp: 1795262400000, tokensLeft: 40, refillIn: 5000, refillRate: 20, tokensConsumed: 0, tokenFlowReduction: 2.5 });
  const flow = await callTool(reduced.module, 'get_token_status', {}, reduced.ctx);
  assert.equal(flow.payload.tokens.tokenFlowReduction, 2.5);
  assert.equal(flow.payload.tokens.note, 'Keepa tracking lowers the refill rate by 2.5.');
});

const SUMMARY = {
  asin: 'B0EXAMPLE1',
  title: 'Example Bluetooth Speaker, waterproof, 24 h battery, black',
  marketplace: 'amazon.de',
  currency: 'EUR',
  range: { days: 90, from: '2026-08-23', to: '2026-11-21' },
  lastUpdate: '2026-11-21T11:00Z',
  brand: 'Example Audio',
  category: 'Electronics & Photo > Audio & HiFi > Portable Speakers',
  salesRankIn: 'Electronics & Photo',
  boughtPastMonth: '1000+',
  trackingSince: '2015-03-02',
  stats: [
    { series: 'AMAZON', label: 'Amazon', now: 34.99, avg30: 35.7, avg90: 38.25, lowestInRange: { value: 34.99, date: '2026-11-05' }, highestInRange: { value: 42.99, date: '2026-08-23' }, lowestEver: { value: 32.99, date: '2026-01-10' } },
    { series: 'BUY_BOX_SHIPPING', label: 'Buy Box incl. shipping', now: 37.48, avg30: 'no offer', avg90: 'no offer', lowestInRange: { value: 37.48, date: '2026-11-05' }, highestInRange: { value: 39.99, date: '2026-10-01' } },
    { series: 'NEW', label: 'New, lowest (any seller, Amazon too)', now: 34.99, avg30: 35.4, avg90: 37.9, lowestInRange: { value: 34.49, date: '2026-11-18' }, highestInRange: { value: 41.99, date: '2026-08-24' }, lowestEver: { value: 31.99, date: '2026-01-10' } },
    { series: 'LISTPRICE', label: 'List price', now: 49.99, avg30: 49.99, avg90: 49.99 },
    { series: 'SALES', label: 'Sales rank (lower is better)', now: 2350, avg30: 2600, avg90: 4100, lowestInRange: { value: 2100, date: '2026-11-18' }, highestInRange: { value: 8100, date: '2026-08-23' }, lowestEver: { value: 950, date: '2026-01-10' } },
    { series: 'COUNT_NEW', label: 'New offers', now: 15, avg30: 14, avg90: 13, lowestInRange: { value: 12, date: '2026-08-23' }, highestInRange: { value: 15, date: '2026-11-05' }, lowestEver: { value: 4, date: '2024-11-27' } },
  ],
  salesRankDrops: { days30: 18, days90: 47 },
  amazonOutOfStockPercent90: 12,
  offersNow: 16,
  buyBox: { price: 34.49, shipping: 2.99, sellerId: 'A1EXAMPLESELLER', isFBA: true },
};

test('get_products asks for stats without the history arrays and decodes each product into a summary', async () => {
  const { module, fetch, ctx } = setup(product);
  const { payload, isError } = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['b0example1'] }, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.equal(fetch.calls[0].path, '/product');
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '3', asin: 'B0EXAMPLE1', stats: '90', history: '0' });
  assert.equal(payload.marketplace, 'amazon.de');
  assert.equal(payload.currency, 'EUR');
  assert.deepEqual(payload.tokens, { used: 1, left: 296, refillRate: 5, refillInSeconds: 41 });
  assert.deepEqual(payload.products, [SUMMARY]);
  // Raw history, descriptions and images stay out.
  assert.ok(!JSON.stringify(payload).includes('waterproof speaker with'));
  assert.equal(payload.nextCursor, undefined);
});

test('get_products sends the paid options only when asked, codes with code_limit, and a date range', async () => {
  const { module, fetch, ctx } = setup(product);
  await callTool(module, 'get_products', {
    marketplace: 'amazon.com', asins: ['B0EXAMPLE1', 'B0EXAMPLE2'], offers: 20, buybox: true, stock: true, rating: true,
    historical_variations: true, update_hours: 0, stats_days: 30,
  }, ctx);
  assert.deepEqual(queryOf(fetch.calls[0]), {
    domain: '1', asin: 'B0EXAMPLE1,B0EXAMPLE2', stats: '30', history: '0', update: '0', offers: '20', buybox: '1', stock: '1', rating: '1', 'historical-variations': '1',
  });

  await callTool(module, 'get_products', { marketplace: 'amazon.co.uk', codes: ['4000000000017'], code_limit: 2, stats_from: '2026-08-01', stats_to: '2026-10-31' }, ctx);
  assert.deepEqual(queryOf(fetch.calls[1]), { domain: '2', code: '4000000000017', stats: '2026-08-01,2026-10-31', history: '0', 'code-limit': '2' });
  const ranged = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], stats_from: '2026-08-01', stats_to: '2026-10-31' }, ctx);
  assert.deepEqual(ranged.payload.products[0].range, { from: '2026-08-01', to: '2026-10-31' });

  const refusals = [
    [{ marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], codes: ['4000000000017'] }, /Give asins or codes, not both\. Nothing was sent to Keepa\./],
    [{ marketplace: 'amazon.de' }, /Give asins \(up to 100\) or codes/],
    [{ marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], code_limit: 2 }, /code_limit only goes with codes/],
    [{ marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], stats_from: '2026-08-01' }, /Give stats_from and stats_to together/],
    [{ marketplace: 'amazon.com.tr', asins: ['B0EXAMPLE1'] }, /`marketplace` must be one of "amazon\.com", "amazon\.co\.uk"/],
    [{ marketplace: 'amazon.de', asins: ['TOO-SHORT'] }, /`asins\[0\]` does not have the expected format/],
    [{ marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], offers: 10 }, /`offers` must be at least 20/],
  ];
  for (const [args, message] of refusals) {
    const { payload, isError } = await callTool(module, 'get_products', args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 3, 'refused calls send nothing');
});

test('get_products with brief gives one short row per product; parents and missing stats are said', async () => {
  const [base] = product.products;
  const parent = { ...base, asin: 'B0PARENT01', productType: 5, stats: null, csv: null, variations: [{ asin: 'B0CHILD001' }, { asin: 'B0CHILD002' }] };
  const noStats = { ...base, asin: 'B0NOSTATS1', stats: null };
  const { module, ctx } = setup({ ...product, products: [base, parent, noStats] });
  const brief = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1', 'B0PARENT01', 'B0NOSTATS1'], brief: true }, ctx);
  assert.deepEqual(brief.payload.products, [
    { asin: 'B0EXAMPLE1', title: 'Example Bluetooth Speaker, waterproof, 24 h battery, black', brand: 'Example Audio', newNow: 34.99, amazonNow: 34.99, salesRank: 2350, boughtPastMonth: '1000+' },
    { asin: 'B0PARENT01', title: 'Example Bluetooth Speaker, waterproof, 24 h battery, black', brand: 'Example Audio', boughtPastMonth: '1000+', note: 'parent ASIN: prices belong to its variations' },
    // Without stats the value now is the last point of each history.
    { asin: 'B0NOSTATS1', title: 'Example Bluetooth Speaker, waterproof, 24 h battery, black', brand: 'Example Audio', newNow: 34.99, amazonNow: 34.99, salesRank: 2350, boughtPastMonth: '1000+' },
  ]);

  const full = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1', 'B0PARENT01', 'B0NOSTATS1'] }, ctx);
  const [, parentSummary, noStatsSummary] = full.payload.products;
  assert.deepEqual(parentSummary.variations, ['B0CHILD001', 'B0CHILD002']);
  assert.equal(parentSummary.note, 'This is a parent ASIN: prices belong to its variations (see variations). No price or rank history in this reply.');
  assert.equal(noStatsSummary.stats, undefined);
  assert.match(noStatsSummary.note, /No stats in this reply: these are the last known values/);
  assert.deepEqual(noStatsSummary.lastKnown.slice(0, 3), [
    { series: 'AMAZON', label: 'Amazon', value: 34.99, since: '2026-11-05T09:00Z' },
    { series: 'BUY_BOX_SHIPPING', label: 'Buy Box incl. shipping', value: 37.48, since: '2026-11-05T09:00Z' },
    { series: 'NEW', label: 'New, lowest (any seller, Amazon too)', value: 34.99, since: '2026-11-21T11:00Z' },
  ]);
});

// What offers=20, stock and historical_variations add to a product.
const OFFER_ROWS = [
  { sellerId: 'A1EXAMPLESELLER', condition: 'New', price: 18.49, shipping: 0, isFBA: true, isPrime: true, stock: 7 },
  { sellerId: 'ATVPDKIKX0DER', condition: 'New', price: 19.99, shipping: 0, isAmazon: true, isFBA: true, isPrime: true, stock: 10 },
  { sellerId: 'A3EXAMPLEUSED', condition: 'Used - Very Good', price: 12.99, shipping: 5.99, stock: 2 },
];
const STOCK = { amazon: 10, buyBox: 7, updated: '2026-11-21T10:55Z' };
const HISTORICAL = { count: 3, asins: ['B0OLDVAR01', 'B0OLDVAR02', 'B0OLDVAR03'] };

test('get_products lists what the paid options load: the live offers in Amazon\'s order, stock levels, the variations no longer listed', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'product-offers.json'));
  const args = { marketplace: 'amazon.com', asins: ['B0OFFERS01'], offers: 20, stock: true, historical_variations: true };
  const { payload, isError } = await callTool(module, 'get_products', args, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '1', asin: 'B0OFFERS01', stats: '90', history: '0', offers: '20', stock: '1', 'historical-variations': '1' });
  assert.equal(payload.tokens.used, 15);
  const [summary] = payload.products;
  // The live offers only, in liveOffersOrder: the offer Keepa saw last in August is gone from the page.
  assert.deepEqual(summary.liveOffers, { count: 3, list: OFFER_ROWS });
  assert.ok(!JSON.stringify(summary).includes('A2GONEEXAMPLE'));
  assert.deepEqual(summary.stock, STOCK);
  assert.deepEqual(summary.historicalVariations, HISTORICAL);
  assert.deepEqual(summary.buyBox, { price: 18.49, shipping: 0, sellerId: 'A1EXAMPLESELLER', isFBA: true });
  assert.equal(summary.offersNow, 4);
  // offers also fills the FBA series.
  assert.deepEqual(summary.stats.find((row) => row.series === 'NEW_FBA'), { series: 'NEW_FBA', label: 'New, lowest FBA', now: 18.49, avg30: 18.99, avg90: 19.5 });

  const brief = await callTool(module, 'get_products', { ...args, brief: true }, ctx);
  assert.deepEqual(brief.payload.products, [{
    asin: 'B0OFFERS01',
    title: 'Example Travel Mug, 16 oz, stainless steel, blue',
    brand: 'Example Home',
    newNow: 18.49,
    amazonNow: 19.99,
    salesRank: 5400,
    boughtPastMonth: '300+',
    stock: STOCK,
    historicalVariations: HISTORICAL,
    liveOffers: { count: 3, list: OFFER_ROWS },
  }]);

  // Without the paid options none of it appears (the product.json summary test checks every field).
  const plainSetup = setup(product);
  const plainResult = await callTool(plainSetup.module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], brief: true }, plainSetup.ctx);
  for (const key of ['liveOffers', 'stock', 'historicalVariations']) assert.equal(key in plainResult.payload.products[0], false, key);
});

test('live offers and historical variations are capped per product: the offers asked for in full, 5 and 10 in a brief row, 10 in a history', async () => {
  const [base] = fixture(import.meta.url, 'product-offers.json').products;
  const offers = Array.from({ length: 30 }, (_, index) => ({ ...base.offers[2], offerId: index + 1, sellerId: `A${String(index).padStart(2, '0')}EXAMPLESELLER`, offerCSV: [8350000, 1800 + index, 0] }));
  const wide = {
    ...base,
    offers,
    liveOffersOrder: offers.map((_, index) => index),
    historicalVariations: Array.from({ length: 25 }, (_, index) => `B0OLDVAR${String(index).padStart(2, '0')}`),
  };
  const { module, ctx } = setup({ ...fixture(import.meta.url, 'product-offers.json'), products: [wide] });

  const full = await callTool(module, 'get_products', { marketplace: 'amazon.com', asins: ['B0OFFERS01'], offers: 20 }, ctx);
  const [summary] = full.payload.products;
  assert.equal(summary.liveOffers.count, 30);
  assert.equal(summary.liveOffers.list.length, 20);
  assert.deepEqual(summary.liveOffers.list[19], { sellerId: 'A19EXAMPLESELLER', condition: 'New', price: 18.19, shipping: 0, isFBA: true, isPrime: true, stock: 7 });
  assert.equal(summary.historicalVariations.count, 25);
  assert.equal(summary.historicalVariations.asins.length, 20);

  const brief = await callTool(module, 'get_products', { marketplace: 'amazon.com', asins: ['B0OFFERS01'], offers: 20, brief: true }, ctx);
  assert.equal(brief.payload.products[0].liveOffers.list.length, 5);
  assert.equal(brief.payload.products[0].historicalVariations.asins.length, 10);

  const history = await callTool(module, 'get_price_history', { marketplace: 'amazon.com', asin: 'B0OFFERS01', series: ['NEW_FBA'], offers: 20 }, ctx);
  assert.equal(history.payload.product.liveOffers.list.length, 10);
  assert.equal(history.payload.product.liveOffers.count, 30);

  // When Keepa could not load fresh offers, the summary says so.
  const failed = setup({ ...fixture(import.meta.url, 'product-offers.json'), products: [{ ...base, offers: [], liveOffersOrder: null, offersSuccessful: false }] });
  const stale = await callTool(failed.module, 'get_products', { marketplace: 'amazon.com', asins: ['B0OFFERS01'], offers: 20 }, failed.ctx);
  assert.deepEqual(stale.payload.products[0].liveOffers, {
    count: 0,
    list: [],
    note: 'Keepa could not load fresh offers this time (it charged 1 token), so the offer data is the last it had.',
  });
});

test('a get_products result over 32 KB is cut, and the cursor asks for the products left out', async () => {
  const [base] = product.products;
  const many = Array.from({ length: 40 }, (_, index) => ({ ...base, asin: `B0MANY${String(index).padStart(4, '0')}` }));
  const { module, fetch, ctx } = setup({ ...product, products: many });
  const first = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: many.map((item) => item.asin) }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024, `result is ${textBytes(first.result)} bytes`);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.products.length;
  assert.ok(shown > 5 && shown < 40, `${shown} shown`);

  // The products left out, as many as fit one result: each one is charged again.
  await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1'], cursor: first.payload.nextCursor }, ctx);
  assert.equal(queryOf(fetch.calls[1]).asin, many.slice(shown, shown * 2).map((item) => item.asin).join(','));
});

test('a code lookup that matched more than 100 products goes on with at most 100 ASINs per request', async () => {
  const [base] = product.products;
  for (const [count, brief] of [[150, false], [400, true]]) {
    const many = Array.from({ length: count }, (_, index) => ({ ...base, asin: `B0CODE${String(index).padStart(4, '0')}` }));
    const byAsin = new Map(many.map((item) => [item.asin, item]));
    const { module, fetch, ctx } = setup((request) => jsonResponse(200, {
      ...product,
      products: request.query.code ? many : request.query.asin.split(',').map((asin) => byAsin.get(asin)),
    }));
    const args = { marketplace: 'amazon.de', codes: ['4000000000017'], code_limit: 100, ...(brief ? { brief } : {}) };
    const seen = [];
    const rounds = [];
    let cursor;
    for (let round = 0; round < 30; round += 1) {
      const { payload, isError } = await callTool(module, 'get_products', { ...args, ...(cursor ? { cursor } : {}) }, ctx);
      assert.equal(isError, false, JSON.stringify(payload).slice(0, 300));
      seen.push(...payload.products.map((item) => item.asin));
      rounds.push({ shown: payload.products.length, cut: payload.truncated === true });
      cursor = payload.nextCursor;
      if (!cursor) break;
    }
    // Every product once, in Keepa's order; the first request by code, the rest by ASIN.
    assert.deepEqual(seen, many.map((item) => item.asin), `${count} products`);
    assert.deepEqual(queryOf(fetch.calls[0]), { domain: '3', code: '4000000000017', stats: '90', history: '0', 'code-limit': '100' });
    const asked = fetch.calls.map((request) => queryOf(request).asin?.split(',') ?? []);
    assert.ok(asked.length >= 3, `${asked.length} requests`);
    // A request after a cut result asks for as many as fit it; after a whole result, as many as that one asked
    // for; never more than 100, the most one request may name.
    for (let index = 1; index < asked.length; index += 1) {
      const before = rounds[index - 1];
      const left = count - rounds.slice(0, index).reduce((sum, round) => sum + round.shown, 0);
      assert.equal(asked[index].length, Math.min(before.cut ? before.shown : asked[index - 1].length, 100, left), `request ${index}`);
      assert.equal(queryOf(fetch.calls[index])['code-limit'], undefined);
    }
    if (brief) assert.ok(asked.filter((list) => list.length === 100).length >= 2, 'short rows go on 100 at a time');
    else assert.ok(asked.slice(1).every((list) => list.length < 30), 'full summaries go on a page\'s worth at a time');
  }
});

test('get_price_history: a daily table of the last 30 days, the value carried over days without a change', async () => {
  const { module, fetch, ctx } = setup(product);
  const { payload, isError } = await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['NEW'], days: 30 }, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '3', asin: 'B0EXAMPLE1', days: '30', stats: '30' });
  assert.equal(payload.product.asin, 'B0EXAMPLE1');
  assert.deepEqual(payload.product.range, { days: 30, from: '2026-10-22', to: '2026-11-21' });
  const [table] = payload.history;
  assert.equal(table.series, 'NEW');
  assert.equal(table.about, 'lowest New price from any seller, Amazon too');
  assert.equal(table.currency, 'EUR');
  assert.equal(table.step, 'day');
  assert.equal(table.from, '2026-10-23');
  assert.equal(table.to, '2026-11-21');
  assert.equal(table.rows.length, 30);
  assert.deepEqual(table.rows[0], { date: '2026-10-23', low: 36.99, high: 36.99, last: 36.99 });
  assert.deepEqual(table.rows.find((row) => row.date === '2026-11-18'), { date: '2026-11-18', low: 34.49, high: 36.99, last: 34.49 });
  assert.deepEqual(table.rows.find((row) => row.date === '2026-11-19'), { date: '2026-11-19', low: 34.49, high: 34.49, last: 34.49 });
  assert.deepEqual(table.rows[29], { date: '2026-11-21', low: 34.49, high: 34.99, last: 34.99 });
  assert.deepEqual(table.changesInRange, { count: 2, lowest: { value: 34.49, at: '2026-11-18T15:00Z' }, highest: { value: 34.99, at: '2026-11-21T11:00Z' } });
  assert.equal(table.note, undefined);
});

test('get_price_history: weekly rows by default for 90 days, ranks as best and worst, gaps marked', async () => {
  const { module, ctx } = setup(product);
  const { payload } = await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['SALES', 'AMAZON', 'BUY_BOX_SHIPPING'] }, ctx);
  const [sales, amazon, buyBox] = payload.history;

  assert.equal(sales.step, '7 days');
  assert.equal(sales.currency, undefined, 'a rank has no currency');
  assert.equal(sales.rows.length, 13);
  assert.deepEqual(sales.rows[0], { date: '2026-08-24/2026-08-30', best: 8100, worst: 8100, last: 8100 });
  assert.deepEqual(sales.rows[3], { date: '2026-09-14/2026-09-20', best: 5400, worst: 8100, last: 5400 });
  assert.deepEqual(sales.rows[8], { date: '2026-10-19/2026-10-25', best: 3100, worst: 5400, last: 3100 });
  assert.deepEqual(sales.rows[12], { date: '2026-11-16/2026-11-21', best: 2100, worst: 3100, last: 2350 });
  assert.deepEqual(sales.changesInRange, { count: 4, best: { value: 2100, at: '2026-11-18T15:00Z' }, worst: { value: 5400, at: '2026-09-15T18:30Z' } });

  // Amazon was out of stock from 2026-09-15 to 2026-10-01.
  assert.deepEqual(amazon.rows[3], { date: '2026-09-14/2026-09-20', low: 42.99, high: 42.99, last: 'no offer', noOffer: true });
  assert.deepEqual(amazon.rows[4], { date: '2026-09-21/2026-09-27', low: 'no offer', high: 'no offer', last: 'no offer', noOffer: true });
  assert.deepEqual(amazon.rows[5], { date: '2026-09-28/2026-10-04', low: 39.99, high: 39.99, last: 39.99, noOffer: true });
  assert.deepEqual(amazon.rows[10], { date: '2026-11-02/2026-11-08', low: 34.99, high: 39.99, last: 34.99 });
  assert.deepEqual(amazon.changesInRange, { count: 2, lowest: { value: 34.99, at: '2026-11-05T09:00Z' }, highest: { value: 39.99, at: '2026-10-01T08:00Z' } });

  // A shipping series adds the shipping to the price; it starts where Keepa's data starts.
  assert.equal(buyBox.from, '2026-10-01');
  assert.equal(buyBox.rows.length, 8);
  assert.deepEqual(buyBox.rows[2], { date: '2026-10-15/2026-10-21', low: 39.99, high: 39.99, last: 'no offer', noOffer: true });
  assert.deepEqual(buyBox.rows[5], { date: '2026-11-05/2026-11-11', low: 37.48, high: 37.48, last: 37.48, noOffer: true });
  assert.deepEqual(buyBox.changesInRange, { count: 2, lowest: { value: 37.48, at: '2026-11-05T09:00Z' }, highest: { value: 39.99, at: '2026-10-01T08:00Z' } });
});

test('get_price_history says what a missing series needs, leaves out points after now, and notes the 2026-02-23 change', async () => {
  const { module, fetch, ctx } = setup(product);
  const { payload } = await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['RATING', 'LIGHTNING_DEAL', 'NEW'], days: 365, step: 30 }, ctx);
  const [rating, deal, longNew] = payload.history;
  assert.deepEqual(rating, {
    series: 'RATING',
    about: 'rating in stars',
    note: 'Keepa has no RATING history for this product in this reply. RATING and COUNT_REVIEWS need rating (or offers).',
  });
  // The deal's only point lies in the future.
  assert.equal(deal.rows, undefined);
  assert.equal(deal.empty, 'Keepa has no LIGHTNING_DEAL data in this range.');
  assert.equal(longNew.note, 'Until 2026-02-22 this series is the lowest listing price; from 2026-02-23 Keepa records the lowest price with shipping.');
  assert.equal(longNew.rows.length, 13);
  assert.deepEqual(longNew.rows[0], { date: '2025-11-22/2025-12-21', low: 49.99, high: 49.99, last: 49.99 });

  await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['BUY_BOX_SHIPPING', 'RATING'], buybox: true, rating: true, offers: 20, update_hours: 2 }, ctx);
  assert.deepEqual(queryOf(fetch.calls[1]), { domain: '3', asin: 'B0EXAMPLE1', days: '90', stats: '90', update: '2', offers: '20', buybox: '1', rating: '1' });
});

test('get_price_history refuses a table too long to return, before spending a token', async () => {
  const { module, fetch, ctx } = setup(product);
  const daily = await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['NEW'], days: 365, step: 1 }, ctx);
  assert.match(daily.payload.error, /That makes up to 365 rows \(365 per series\), and the most is 250\. Use a larger step/);
  const many = await callTool(module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0EXAMPLE1', series: ['NEW', 'SALES', 'AMAZON'], days: 3650 }, ctx);
  assert.match(many.payload.error, /That makes up to 366 rows \(122 per series\)/);
  assert.equal(fetch.calls.length, 0);

  const none = setup({ ...product, products: [] });
  const missing = await callTool(none.module, 'get_price_history', { marketplace: 'amazon.de', asin: 'B0NOTHING1' }, none.ctx);
  assert.equal(missing.isError, false);
  assert.equal(missing.payload.note, 'Keepa returned no product for this ASIN on this marketplace.');
  assert.equal(missing.payload.tokens.used, 1);
});

test('search_products sends the term with 30-day stats and no history, and lists short rows', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'search-products.json'));
  const { payload } = await callTool(module, 'search_products', { marketplace: 'amazon.com', term: 'bluetooth speaker' }, ctx);
  assert.equal(fetch.calls[0].path, '/search');
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '1', type: 'product', term: 'bluetooth speaker', stats: '30', history: '0' });
  assert.equal(payload.term, 'bluetooth speaker');
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.tokens.used, 10);
  assert.deepEqual(payload.products, [
    { asin: 'B0SEARCH01', title: 'Example Portable Speaker | 20 W\nwith strap', brand: 'Example Audio', newNow: 27.99, amazonNow: 29.99, salesRank: 412, boughtPastMonth: '3000+' },
    { asin: 'B0SEARCH02', title: 'Sample Mini Speaker', brand: 'Sample', newNow: 15.99, amazonNow: 'no offer', salesRank: 15800 },
  ]);

  const asins = setup({ ...fixture(import.meta.url, 'token.json'), asinList: ['B0SEARCH01', 'B0SEARCH02'] });
  const onlyAsins = await callTool(asins.module, 'search_products', { marketplace: 'amazon.de', term: 'lautsprecher', asins_only: true }, asins.ctx);
  assert.deepEqual(queryOf(asins.fetch.calls[0]), { domain: '3', type: 'product', term: 'lautsprecher', 'asins-only': '1' });
  assert.deepEqual(onlyAsins.payload.asins, ['B0SEARCH01', 'B0SEARCH02']);
  assert.equal(onlyAsins.payload.linkTemplate, 'https://www.amazon.de/dp/{asin}');
});

test('get_best_sellers returns a slice of the ranked list with its size and update time', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'bestsellers.json'));
  const first = await callTool(module, 'get_best_sellers', { marketplace: 'amazon.com', category: '172282', top: 5 }, ctx);
  assert.equal(fetch.calls[0].path, '/bestsellers');
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '1', category: '172282' });
  assert.deepEqual(first.payload, {
    marketplace: 'amazon.com',
    category: 172282,
    listUpdated: '2026-11-21T11:00Z',
    total: 25,
    offset: 0,
    tokens: { used: 50, left: 246, refillRate: 5, refillInSeconds: 41 },
    asins: ['B0BEST0001', 'B0BEST0002', 'B0BEST0003', 'B0BEST0004', 'B0BEST0005'],
    linkTemplate: 'https://www.amazon.com/dp/{asin}',
    nextOffset: 5,
  });

  const rest = await callTool(module, 'get_best_sellers', { marketplace: 'amazon.com', category: 'Beauty', offset: 20, top: 10, range: 90, variations: true }, ctx);
  assert.deepEqual(queryOf(fetch.calls[1]), { domain: '1', category: 'Beauty', range: '90', variations: '1' });
  assert.deepEqual(rest.payload.asins, ['B0BEST0021', 'B0BEST0022', 'B0BEST0023', 'B0BEST0024', 'B0BEST0025']);
  assert.equal(rest.payload.nextOffset, undefined);

  await callTool(module, 'get_best_sellers', { marketplace: 'amazon.com', category: '172282', month: 6, year: 2026 }, ctx);
  assert.deepEqual(queryOf(fetch.calls[2]), { domain: '1', category: '172282', month: '6', year: '2026' });
  await callTool(module, 'get_best_sellers', { marketplace: 'amazon.com', category: '13299291', sublist: true, variations: true }, ctx);
  assert.deepEqual(queryOf(fetch.calls[3]), { domain: '1', category: '13299291', variations: '1', sublist: '1' });

  for (const [args, message] of [
    [{ marketplace: 'amazon.com', category: '172282', month: 6 }, /Give month and year together/],
    [{ marketplace: 'amazon.com', category: '172282', month: 6, year: 2026, range: 30 }, /Give range or a month, not both/],
    [{ marketplace: 'amazon.com', category: '172282', range: 60 }, /`range` must be one of 30, 90, 180/],
    // Keepa takes sublist with none of range, month and year.
    [{ marketplace: 'amazon.com', category: '172282', sublist: true, range: 90 }, /^Keepa takes sublist without range, month and year: .*Nothing was sent to Keepa\.$/],
    [{ marketplace: 'amazon.com', category: '172282', sublist: true, month: 6, year: 2026 }, /^Keepa takes sublist without range, month and year/],
  ]) {
    assert.match((await callTool(module, 'get_best_sellers', args, ctx)).payload.error, message);
  }
  assert.equal(fetch.calls.length, 4);
});

test('get_best_sellers says whether Keepa has no list (free) or an empty one (charged)', async () => {
  const missing = setup({ ...fixture(import.meta.url, 'token.json') });
  const none = await callTool(missing.module, 'get_best_sellers', { marketplace: 'amazon.it', category: '999' }, missing.ctx);
  assert.deepEqual(none.payload.asins, []);
  assert.equal(none.payload.tokens.used, 0);
  assert.equal(none.payload.note, 'Keepa has no best sellers list for that category on this marketplace (no tokens were used for it).');

  const emptyList = { domainId: 8, lastUpdate: 8356920, categoryId: 999, asinList: [] };
  const empty = setup({ ...fixture(import.meta.url, 'token.json'), tokensConsumed: 50, bestSellersList: emptyList });
  const charged = await callTool(empty.module, 'get_best_sellers', { marketplace: 'amazon.it', category: '999' }, empty.ctx);
  assert.deepEqual(charged.payload.asins, []);
  assert.equal(charged.payload.tokens.used, 50);
  assert.equal(charged.payload.note, 'Keepa\'s best sellers list for that category on this marketplace is empty; the call still used its 50 tokens.');
  assert.ok(!/no tokens/.test(charged.payload.note));
});

test('get_best_sellers reads a root category list of hundreds of thousands of ASINs, over 4 MiB, up to 8 MiB', async () => {
  // A root category or product group list holds up to 500,000 ASINs: 13 bytes each in the JSON.
  const asinList = Array.from({ length: 400_000 }, (_, index) => `B0${String(index).padStart(8, '0')}`);
  const reply = JSON.stringify({ ...fixture(import.meta.url, 'token.json'), tokensConsumed: 50, bestSellersList: { domainId: 1, lastUpdate: 8356920, categoryId: 172282, asinList } });
  assert.ok(reply.length > 4 * 1024 * 1024, `the reply is ${reply.length} bytes`);
  const { module, ctx } = setup(() => textResponse(200, reply, { 'content-type': 'application/json' }));
  const { payload, isError } = await callTool(module, 'get_best_sellers', { marketplace: 'amazon.com', category: '172282', offset: 399_990, top: 20 }, ctx);
  assert.equal(isError, false, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.total, 400_000);
  assert.deepEqual(payload.asins, asinList.slice(399_990));
  assert.equal(payload.nextOffset, undefined);

  // Past 8 MiB the reply is not read, and the error says why.
  const huge = `{"bestSellersList":{"asinList":[${'"B000000000",'.repeat(650_000)}"B000000001"]}}`;
  const over = setup(() => textResponse(200, huge, { 'content-type': 'application/json' }));
  const tooLarge = await callTool(over.module, 'get_best_sellers', { marketplace: 'amazon.com', category: '172282' }, over.ctx);
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.payload.error, /^Keepa answered HTTP 200, but the reply could not be read \(the reply is larger than 8,388,608 bytes\)\./);
});

test('search_categories and get_categories list categories largest first, with their paths', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'categories-search.json'));
  const found = await callTool(module, 'search_categories', { marketplace: 'amazon.de', term: ' bluetooth speakers ' }, ctx);
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '3', type: 'category', term: 'bluetooth speakers', parents: '1' });
  assert.equal(found.payload.currency, 'EUR');
  assert.deepEqual(found.payload.categories, [
    { id: 15428436031, name: 'Portable Speakers', path: 'Electronics & Photo > Audio & HiFi > Portable Speakers', parent: 1384526031, productCount: 41250, subcategories: 0, avgBuyBox: 45.9 },
    { id: 15428437031, name: 'Speaker Accessories', path: 'Electronics & Photo > Audio & HiFi > Speaker Accessories', parent: 1384526031, productCount: 9800, subcategories: 2 },
  ]);
  const short = await callTool(module, 'search_categories', { marketplace: 'amazon.de', term: 'tv stands' }, ctx);
  assert.match(short.payload.error, /Every word of term needs 3 letters or more/);
  assert.equal(fetch.calls.length, 1);

  const roots = setup(fixture(import.meta.url, 'categories-root.json'));
  const listed = await callTool(roots.module, 'get_categories', { marketplace: 'amazon.com', category_ids: [0], include_path: false }, roots.ctx);
  assert.equal(roots.fetch.calls[0].path, '/category');
  assert.deepEqual(queryOf(roots.fetch.calls[0]), { domain: '1', category: '0' });
  assert.deepEqual(listed.payload.categories.map((category) => [category.id, category.name, category.path, category.parent, category.subcategories, category.avgBuyBox]), [
    [172282, 'Electronics', 'Electronics', 0, 3, 74.5],
    [3760911, 'Beauty & Personal Care', 'Beauty & Personal Care', 0, 2, 18.99],
  ]);
  await callTool(roots.module, 'get_categories', { marketplace: 'amazon.com', category_ids: [172282, 3760911] }, roots.ctx);
  assert.deepEqual(queryOf(roots.fetch.calls[1]), { domain: '1', category: '172282,3760911', parents: '1' });
});

test('find_products sends the filters as selection JSON and returns the ASINs with the total', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'finder.json'));
  const selection = { rootCategory: [172282], current_SALES_lte: 5000, current_NEW_lte: 2500, sort: [['current_SALES', 'asc']] };
  const { payload } = await callTool(module, 'find_products', { marketplace: 'amazon.com', selection, page: 2, per_page: 100 }, ctx);
  assert.equal(fetch.calls[0].path, '/query');
  const query = queryOf(fetch.calls[0]);
  assert.equal(query.domain, '1');
  assert.deepEqual(JSON.parse(query.selection), { ...selection, page: 2, perPage: 100 });
  assert.deepEqual(payload, {
    marketplace: 'amazon.com',
    totalResults: 1234,
    page: 2,
    tokens: { used: 11, left: 285, refillRate: 5, refillInSeconds: 41 },
    asins: ['B0FIND0001', 'B0FIND0002', 'B0FIND0003'],
    linkTemplate: 'https://www.amazon.com/dp/{asin}',
  });

  await callTool(module, 'find_products', { marketplace: 'amazon.com', selection: { title: 'speaker' } }, ctx);
  assert.deepEqual(JSON.parse(queryOf(fetch.calls[1]).selection), { title: 'speaker' }, 'Keepa\'s own page size unless per_page is given');
  const empty = await callTool(module, 'find_products', { marketplace: 'amazon.com', selection: { perPage: 50 } }, ctx);
  assert.match(empty.payload.error, /selection needs at least one filter/);
  assert.equal(fetch.calls.length, 2);
});

test('find_products keeps a page within one result and within the first 10,000 results, before spending tokens', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'finder.json'));
  const filters = { rootCategory: [172282] };
  for (const [args, message] of [
    // perPage inside selection counts like per_page.
    [{ selection: { ...filters, perPage: 5000 } }, /^A page of more than 2,000 ASINs does not fit in one result: use per_page up to 2,000 and page for the next ones\. Nothing was sent to Keepa\.$/],
    [{ selection: { ...filters, perPage: '100' } }, /^perPage must be a whole number from 50 to 2,000\. Nothing was sent to Keepa\.$/],
    [{ selection: { ...filters, perPage: 20 } }, /^perPage must be a whole number from 50 to 2,000/],
    [{ selection: filters, page: 5, per_page: 2000 }, /^Keepa's product finder reaches only the first 10,000 results, and page 5 with 2000 per page goes past them\. .*Nothing was sent to Keepa\.$/],
    [{ selection: { ...filters, page: 200 } }, /reaches only the first 10,000 results, and page 200 with 50 per page goes past them/],
    [{ selection: { ...filters, page: -1 } }, /^page must be a whole number from 0\. Nothing was sent to Keepa\.$/],
    [{ selection: filters, page: 200 }, /`page` must be at most 199/],
  ]) {
    const { payload, isError } = await callTool(module, 'find_products', { marketplace: 'amazon.com', ...args }, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 0);

  // The last pages within 10,000 results go out.
  await callTool(module, 'find_products', { marketplace: 'amazon.com', selection: { ...filters, perPage: 2000, page: 4 } }, ctx);
  assert.deepEqual(JSON.parse(queryOf(fetch.calls[0]).selection), { ...filters, perPage: 2000, page: 4 });
  await callTool(module, 'find_products', { marketplace: 'amazon.com', selection: filters, page: 199 }, ctx);
  assert.deepEqual(JSON.parse(queryOf(fetch.calls[1]).selection), { ...filters, page: 199 });
});

test('api_get reaches the rest of the API with the key, but never /tracking', async () => {
  const seller = { ...fixture(import.meta.url, 'token.json'), sellers: { A1EXAMPLESELLER: { sellerName: 'Example Seller', currentRating: 96 } } };
  const { module, fetch, ctx } = setup(seller);
  const { payload } = await callTool(module, 'api_get', { path: '/seller', query: { domain: 1, seller: 'A1EXAMPLESELLER', key: 'someone-else' } }, ctx);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].path, '/seller');
  // The connection's key replaces any key in the arguments.
  assert.deepEqual(queryOf(fetch.calls[0]), { domain: '1', seller: 'A1EXAMPLESELLER' });
  assert.equal(payload.status, 200);
  assert.equal(payload.data.sellers.A1EXAMPLESELLER.sellerName, 'Example Seller');

  for (const path of ['/tracking', '/Tracking', '/tracking/', '/x/../tracking']) {
    const refused = await callTool(module, 'api_get', { path, query: { type: 'remove', asin: 'B0EXAMPLE1' } }, ctx);
    assert.equal(refused.isError, true, path);
    assert.match(refused.payload.error, /api_get does not reach \/tracking/);
  }
  assert.equal(fetch.calls.length, 1);
});

test('Keepa errors become clear tool errors: a refused parameter, no plan, and used-up tokens with the refill time', async () => {
  const badParameter = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-key.json')));
  const bad = await callTool(badParameter.module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1'] }, badParameter.ctx);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /^Keepa refused a parameter of this call \(HTTP 400\)\. Keepa said: "You used an invalid parameter for this API call/);

  const noPlan = setup(() => jsonResponse(402, fixture(import.meta.url, 'error-plan.json')));
  const plan = await callTool(noPlan.module, 'get_token_status', {}, noPlan.ctx);
  assert.equal(plan.payload.status, 402);
  assert.match(plan.payload.error, /^Keepa does not accept this API key: it is unknown or has no active API plan\. Check the key and the plan on keepa\.com\/api \(HTTP 402\)\. Keepa said: "Operation unauthorized\. No active API plan found\."/);

  // A 429 is followed by the free token status, once, to say when the next call can run.
  const limited = setup((request) => (request.path === '/token' ? jsonResponse(200, fixture(import.meta.url, 'token-out.json')) : jsonResponse(429, fixture(import.meta.url, 'error-tokens.json'))));
  const tokens = await callTool(limited.module, 'get_best_sellers', { marketplace: 'amazon.com', category: '172282' }, limited.ctx);
  assert.equal(tokens.payload.status, 429);
  assert.equal(tokens.payload.retryAfter, 141);
  assert.equal(tokens.payload.error, 'Keepa tokens are used up (HTTP 429): the next call can run in about 3 minutes (around 2026-11-21T12:02Z). Do not call Keepa again before then.');
  assert.deepEqual(limited.fetch.calls.map((request) => request.path), ['/bestsellers', '/token']);

  const blind = setup(() => jsonResponse(429, fixture(import.meta.url, 'error-tokens.json')));
  const unknown = await callTool(blind.module, 'search_products', { marketplace: 'amazon.com', term: 'x' }, blind.ctx);
  assert.equal(unknown.payload.status, 429);
  assert.match(unknown.payload.error, /Keepa tokens are used up \(HTTP 429\)\. Wait for the plan's tokens to refill/);
  assert.equal(blind.fetch.calls.length, 2);

  const refilled = setup((request) => (request.path === '/token' ? jsonResponse(200, fixture(import.meta.url, 'token.json')) : jsonResponse(429, {})));
  const again = await callTool(refilled.module, 'find_products', { marketplace: 'amazon.com', selection: { title: 'x' } }, refilled.ctx);
  assert.equal(again.payload.error, 'Keepa tokens were used up for this call (HTTP 429); 297 tokens are available again now.');

  for (const [respond, status, message] of [
    [() => textResponse(404, ''), 404, /Keepa has no such API path \(HTTP 404\)/],
    [() => jsonResponse(405, { error: { type: 'invalidParameter', message: 'offers out of range' } }), 405, /Keepa refused a parameter value outside its allowed range \(HTTP 405\)\. Keepa said: "offers out of range"/],
    [() => jsonResponse(500, {}), 500, /Keepa had a server error \(HTTP 500\)\. Try again later\./],
  ]) {
    const { module, ctx } = setup(respond);
    const { payload } = await callTool(module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1'] }, ctx);
    assert.equal(payload.status, status);
    assert.match(payload.error, message);
  }
});

test('a 200 that refused part of a batch carries the warning; a reply that is not JSON is an error', async () => {
  const partial = setup({ ...product, error: { type: 'invalidParameter', message: 'Some ASINs are invalid', details: ['B0BROKEN01'] } });
  const { payload } = await callTool(partial.module, 'get_products', { marketplace: 'amazon.de', asins: ['B0EXAMPLE1', 'B0BROKEN01'] }, partial.ctx);
  assert.equal(payload.warning, 'Keepa: invalidParameter: Some ASINs are invalid (["B0BROKEN01"])');
  assert.equal(payload.products.length, 1);

  const garbled = setup(() => textResponse(200, '\u001f\u008b\u0008 not json'));
  const broken = await callTool(garbled.module, 'get_token_status', {}, garbled.ctx);
  assert.equal(broken.isError, true);
  assert.match(broken.payload.error, /Keepa sent a reply that is not JSON/);
});

test('a key that is not 64 letters and digits is refused before anything is sent', async () => {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  for (const apikey of ['short', `${KEY}x`, `${KEY.slice(0, 63)}-`]) {
    const { ctx } = makeContext({ credentials: { apikey }, fetch });
    for (const [tool, args] of [['get_token_status', {}], ['api_get', { path: '/token' }]]) {
      const { payload, isError } = await callTool(module, tool, args, ctx);
      assert.equal(isError, true);
      assert.match(payload.error, /The Keepa API key must be the 64 letters and digits shown on the Keepa API page.*Nothing was sent to Keepa\./);
    }
  }
  const missing = await callTool(module, 'get_token_status', {}, makeContext({ credentials: {}, fetch }).ctx);
  assert.equal(missing.payload.error, 'Keepa is not connected: the Keepa API key is missing.');
  assert.equal(fetch.calls.length, 0);
});

test('log lines name the vendor, tool, method, status and duration, never the key or arguments', async () => {
  const { module, ctx, logs } = setup(fixture(import.meta.url, 'search-products.json'));
  await callTool(module, 'search_products', { marketplace: 'amazon.com', term: 'very private term' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^keepa search_products GET 200 \d+ms$/);
  assert.equal(logs.some((line) => line.includes(KEY) || line.includes('private')), false);
});
