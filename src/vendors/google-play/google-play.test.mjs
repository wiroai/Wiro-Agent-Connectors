import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

// The key is made here, for this run: no key is ever stored in the repository.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-0123456789',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'play-agent@example-project.iam.gserviceaccount.com',
};
const KEY_BASE64 = Buffer.from(JSON.stringify(KEY)).toString('base64');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN = 'ya29.play-test-token';
const PKG = 'com.example.app';
const APP = `/androidpublisher/v3/applications/${PKG}`;
const EDIT = `${APP}/edits/01234567890123456789`;
const REVIEW = 'gp:AOqpTOExampleReviewOne000000000000000000000000000000';
const credentials = { serviceaccountjson: KEY_BASE64 };
const decoder = new TextDecoder();

function setup(routes, { accounts = { apps: [PKG] } } = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch((request) => {
    if (request.url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    const route = routes[`${request.method} ${request.origin}${request.path}`] ?? routes[`${request.method} ${request.path}`];
    if (!route) return jsonResponse(500, { error: { code: 500, message: `unexpected ${request.method} ${request.url}` } });
    // A route's Response is cloned, so it can answer more than once.
    return typeof route === 'function' ? route(request) : route.clone();
  });
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  const apiCalls = () => fetch.calls.filter((call) => call.url !== TOKEN_URL);
  return { module, fetch, ctx, logs, apiCalls };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

test('the apps picker: list_apps with no lock lists the apps the key can see, through the Reporting API', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ 'GET https://playdeveloperreporting.googleapis.com/v1beta1/apps:search': jsonResponse(200, fixture(import.meta.url, 'apps-search.json')) }, { accounts: null });
  const [picker] = module.accountPickers;
  assert.deepEqual(JSON.parse(JSON.stringify(picker)), {
    key: 'apps',
    label: 'Google Play apps',
    description: 'The Android apps the agent works on: their reviews, store listings and products.',
    multiple: true,
    tool: 'list_apps',
    idField: 'packageName',
    nameField: 'displayName',
    legacyField: 'apps',
  });
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  const exchange = fetch.calls.find((call) => call.url === TOKEN_URL);
  const assertion = new URLSearchParams(decoder.decode(exchange.body)).get('assertion');
  assert.equal(JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8')).scope, 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting');
  assert.equal(apiCalls()[0].query.pageSize, '100');
  assert.equal(apiCalls()[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(payload.apps.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [[PKG, 'Example App'], ['com.example.pro', 'Example Pro']]);
});

test('with a lock, list_apps lists the chosen apps, named when the Reporting API answers and by package name when it does not', async () => {
  const named = setup({ 'GET /v1beta1/apps:search': jsonResponse(200, fixture(import.meta.url, 'apps-search.json')) }, { accounts: { apps: [PKG, 'com.example.legacy'] } });
  const chosen = await callTool(named.module, 'list_apps', {}, named.ctx);
  assert.deepEqual(chosen.payload, { chosen: true, apps: [{ packageName: PKG, displayName: 'Example App' }, { packageName: 'com.example.legacy', displayName: 'com.example.legacy' }] });

  const disabled = setup({ 'GET /v1beta1/apps:search': jsonResponse(403, fixture(import.meta.url, 'error-reporting-disabled.json')) });
  const fallback = await callTool(disabled.module, 'list_apps', {}, disabled.ctx);
  assert.equal(fallback.isError, false);
  assert.deepEqual(fallback.payload.apps, [{ packageName: PKG, displayName: PKG }]);
  assert.match(fallback.payload.note, /^The app names could not be read: Google Play did not list the apps: enable the Google Play Developer Reporting API/);

  const open = setup({ 'GET /v1beta1/apps:search': jsonResponse(403, fixture(import.meta.url, 'error-reporting-disabled.json')) }, { accounts: null });
  const refused = await callTool(open.module, 'list_apps', {}, open.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /has not been used in project 123456789012 before or it is disabled/);
});

test('list_reviews reads the last week\'s reviews, trims them, and filters to unanswered ones', async () => {
  const { module, ctx, apiCalls } = setup({ [`GET ${APP}/reviews`]: jsonResponse(200, fixture(import.meta.url, 'reviews.json')) });
  const { payload, isError } = await callTool(module, 'list_reviews', { max_results: 20, translation_language: 'en' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(apiCalls()[0].query, { maxResults: '20', translationLanguage: 'en' });
  assert.equal(payload.packageName, PKG);
  assert.deepEqual(payload.reviews[0], {
    reviewId: REVIEW,
    author: 'Jane S.',
    rating: 5,
    text: 'Love this app! Very useful for making videos.',
    language: 'en',
    modifiedAt: '2024-02-18T22:00:00.000Z',
    appVersion: '2.1.0',
    appVersionCode: 42,
    device: 'sailfish (Pixel)',
    androidOsVersion: 34,
    thumbsUp: 3,
    thumbsDown: 0,
    replied: false,
  });
  assert.deepEqual(payload.reviews[1].reply, { text: 'Sorry about that! Please update to 2.1.0, which fixes the crash.', modifiedAt: '2024-02-17T23:00:00.000Z' });

  const unanswered = await callTool(module, 'list_reviews', { unanswered_only: true }, ctx);
  assert.deepEqual(unanswered.payload.reviews.map((review) => review.reviewId), [REVIEW]);
  await callTool(module, 'list_reviews', { cursor: unanswered.payload.nextCursor }, ctx);
  assert.equal(apiCalls()[2].query.token, 'CmQKFgoUZXhhbXBsZS1uZXh0LXBhZ2U');
});

test('package_name defaults to the only chosen app, must be a chosen app, and is needed with several', async () => {
  const one = setup({ [`GET ${APP}/reviews`]: jsonResponse(200, { reviews: [] }) });
  assert.equal((await callTool(one.module, 'list_reviews', {}, one.ctx)).isError, false);
  const other = await callTool(one.module, 'list_reviews', { package_name: 'com.other.app' }, one.ctx);
  assert.equal(other.payload.error, `The app com.other.app is not among the apps chosen for this connection. Use one of: ${PKG}. Nothing was sent.`);

  const two = setup({}, { accounts: { apps: [PKG, 'com.example.pro'] } });
  assert.equal((await callTool(two.module, 'list_reviews', {}, two.ctx)).payload.error, `Give package_name: one of ${PKG}, com.example.pro. Nothing was sent.`);
  const none = setup({}, { accounts: {} });
  assert.equal((await callTool(none.module, 'list_reviews', {}, none.ctx)).payload.error, 'No app is chosen for this Google Play connection yet. Nothing was sent.');
  assert.equal(two.fetch.calls.length + none.fetch.calls.length, 0);
});

test('reply_to_review posts one reply with the review id as Play writes it, and checks the length first', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ [`POST ${APP}/reviews/${REVIEW}:reply`]: jsonResponse(200, fixture(import.meta.url, 'reply.json')) });
  const { payload, isError } = await callTool(module, 'reply_to_review', { review_id: REVIEW, reply_text: "Thank you so much, Jane! We're thrilled you enjoy it." }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(apiCalls()[0].url, `https://androidpublisher.googleapis.com${APP}/reviews/${REVIEW}:reply`);
  assert.deepEqual(apiCalls()[0].json, { replyText: "Thank you so much, Jane! We're thrilled you enjoy it." });
  assert.deepEqual(payload, { packageName: PKG, reviewId: REVIEW, replyText: "Thank you so much, Jane! We're thrilled you enjoy it.", lastEdited: '2024-02-19T22:00:00.000Z' });

  const before = fetch.calls.length;
  const long = await callTool(module, 'reply_to_review', { review_id: REVIEW, reply_text: 'x'.repeat(351) }, ctx);
  assert.match(long.payload.error, /reply_text` must be at most 350 characters/);
  assert.equal(fetch.calls.length, before);
});

test('a review id is one path segment: "." and ".." are refused before anything is sent', async () => {
  const { module, fetch, ctx } = setup({});
  for (const [tool, args] of [
    ['get_review', { review_id: '..' }],
    ['get_review', { review_id: '.' }],
    ['reply_to_review', { review_id: '..', reply_text: 'Thanks!' }],
  ]) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, /`review_id` does not have the expected format/);
  }
  assert.equal(fetch.calls.length, 0);
});

test('an unclear reply outcome is unknown with get_review to check, and is sent once', async () => {
  const { module, ctx, apiCalls } = setup({ [`POST ${APP}/reviews/${REVIEW}:reply`]: jsonResponse(500, { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }) });
  const { payload } = await callTool(module, 'reply_to_review', { review_id: REVIEW, reply_text: 'Thanks!' }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'get_review');
  assert.equal(apiCalls().length, 1);
});

test('get_store_listing reads the live listing from the public store page: one GET, no edit, no credentials', async () => {
  const page = fs.readFileSync(new URL('./fixtures/store-page.html', import.meta.url), 'utf8');
  const { module, fetch, ctx } = setup({ 'GET https://play.google.com/store/apps/details': textResponse(200, page, { 'content-type': 'text/html; charset=utf-8' }) });
  const { payload, isError } = await callTool(module, 'get_store_listing', { language: 'tr-TR', region: 'TR' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1, 'no token exchange and no edit');
  const [read] = fetch.calls;
  assert.equal(read.method, 'GET');
  assert.deepEqual(read.query, { id: PKG, hl: 'tr-TR', gl: 'TR' });
  assert.equal(read.headers.authorization, undefined);
  assert.equal(read.headers.accept, 'text/html');
  assert.deepEqual(payload, {
    packageName: PKG,
    language: 'tr-TR',
    region: 'TR',
    url: `https://play.google.com/store/apps/details?id=${PKG}`,
    title: 'Example App',
    shortDescription: 'Videos and photos from a sentence',
    fullDescription: 'Make short videos from text, edit photos and add music.\n\nFeatures:\n• Text to video\n• Photo editing & filters\n• Music for every clip\n\nQuestions? Write to us. We\'re happy to help.',
    category: 'VIDEO_PLAYERS',
    contentRating: 'Everyone',
    developer: 'Example Studio',
    developerWebsite: 'https://www.example.com',
    rating: 4.46,
    ratingCount: 18230,
    price: 'free',
    icon: 'https://play-lh.googleusercontent.com/exampleIconId0123456789',
  });
});

test('get_store_listing says so when an app has no store page, or the page has no app details', async () => {
  // A fresh reply per request: the module cancels a refused page's body, and a cloned body would wait for its twin.
  const missing = setup({ 'GET https://play.google.com/store/apps/details': () => textResponse(404, '<html>Not Found</html>', { 'content-type': 'text/html' }) });
  const none = await callTool(missing.module, 'get_store_listing', {}, missing.ctx);
  // No public page is the answer for an unpublished app, not a failure to retry.
  assert.equal(none.isError, false);
  assert.deepEqual(none.payload, {
    packageName: PKG,
    language: 'en-US',
    region: 'US',
    available: false,
    note: `Google Play has no public store page for ${PKG} in the country US (HTTP 404): the app is not published yet, or not offered there.`,
  });
  assert.deepEqual(missing.fetch.calls[0].query, { id: PKG, hl: 'en-US', gl: 'US' });

  const empty = setup({ 'GET https://play.google.com/store/apps/details': textResponse(200, '<html><body>Something else</body></html>', { 'content-type': 'text/html' }) });
  const unread = await callTool(empty.module, 'get_store_listing', {}, empty.ctx);
  assert.equal(unread.payload.error, `Google Play's store page for ${PKG} could not be read: it carries no app details.`);

  const other = await callTool(empty.module, 'get_store_listing', { package_name: 'com.other.app' }, empty.ctx);
  assert.match(other.payload.error, /The app com\.other\.app is not among the apps chosen for this connection/);
  assert.equal(empty.fetch.calls.length, 1);
});

test('update_store_listing saves the listing in an edit and commits it once', async () => {
  const { module, ctx, apiCalls } = setup({
    [`POST ${APP}/edits`]: jsonResponse(200, fixture(import.meta.url, 'edit.json')),
    [`PATCH ${EDIT}/listings/en-US`]: (request) => jsonResponse(200, { language: 'en-US', title: 'Example App', ...request.json }),
    [`POST ${EDIT}:commit`]: jsonResponse(200, { id: '01234567890123456789' }),
  });
  const { payload, isError } = await callTool(module, 'update_store_listing', { language: 'en-US', short_description: 'Videos from one sentence' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(apiCalls()[1].json, { shortDescription: 'Videos from one sentence' });
  assert.equal(apiCalls()[2].query.changesNotSentForReview, undefined);
  assert.deepEqual(payload, { packageName: PKG, committed: true, sentForReview: true, listing: { language: 'en-US', title: 'Example App', shortDescription: 'Videos from one sentence' } });
});

test('a refused commit drops the edit and says nothing changed; an unclear commit is unknown and keeps it', async () => {
  const refused = setup({
    [`POST ${APP}/edits`]: jsonResponse(200, fixture(import.meta.url, 'edit.json')),
    [`PATCH ${EDIT}/listings/en-US`]: jsonResponse(200, { language: 'en-US', title: 'New name' }),
    [`POST ${EDIT}:commit`]: jsonResponse(400, fixture(import.meta.url, 'error-commit-review.json')),
    [`DELETE ${EDIT}`]: new Response(null, { status: 204 }),
  });
  const rejected = await callTool(refused.module, 'update_store_listing', { language: 'en-US', title: 'New name' }, refused.ctx);
  assert.match(rejected.payload.error, /changesNotSentForReview to true/);
  assert.match(rejected.payload.error, /Nothing was changed\.$/);
  assert.equal(refused.apiCalls().at(-1).method, 'DELETE');

  const unclear = setup({
    [`POST ${APP}/edits`]: jsonResponse(200, fixture(import.meta.url, 'edit.json')),
    [`PATCH ${EDIT}/listings/en-US`]: jsonResponse(200, { language: 'en-US', title: 'New name' }),
    [`POST ${EDIT}:commit`]: jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.' } }),
  });
  const unknown = await callTool(unclear.module, 'update_store_listing', { language: 'en-US', title: 'New name', changes_not_sent_for_review: true }, unclear.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_store_listing');
  assert.match(unknown.payload.error, /Play Console -> Publishing overview lists a change waiting for review; the store page shows it once the review has passed\. Call get_store_listing/);
  assert.equal(unclear.apiCalls().find((call) => call.path.endsWith(':commit')).query.changesNotSentForReview, 'true');
  assert.equal(unclear.apiCalls().filter((call) => call.method === 'DELETE').length, 0);

  const empty = await callTool(unclear.module, 'update_store_listing', { language: 'en-US' }, unclear.ctx);
  assert.equal(empty.payload.error, 'Give at least one field to change. Nothing was changed.');
});

test('list_subscriptions shows base plans with the price in a region, offers, and whether an active offer starts free', async () => {
  const { module, ctx, apiCalls } = setup({
    [`GET ${APP}/subscriptions`]: jsonResponse(200, fixture(import.meta.url, 'subscriptions.json')),
    [`GET ${APP}/subscriptions/-/basePlans/-/offers`]: jsonResponse(200, fixture(import.meta.url, 'offers.json')),
  });
  const { payload, isError } = await callTool(module, 'list_subscriptions', { region: 'TR' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(apiCalls()[1].query.pageSize, '1000');
  const [subscription] = payload.subscriptions;
  assert.equal(subscription.productId, 'pro_subscription');
  assert.equal(subscription.hasFreeTrial, true);
  assert.deepEqual(subscription.listings, [{ language: 'en-US', title: 'Pro', description: 'Everything in Example App, unlimited.', benefits: ['Unlimited videos', 'No watermark'] }]);
  assert.deepEqual(subscription.basePlans[0], {
    basePlanId: 'weekly',
    state: 'ACTIVE',
    type: 'auto_renewing',
    billingPeriod: 'P1W',
    gracePeriod: 'P3D',
    offerTags: ['weekly'],
    price: { region: 'TR', amount: '199.99', currency: 'TRY' },
    regions: 2,
    offers: [{ offerId: 'free-trial-3d', state: 'ACTIVE', offerTags: ['trial'], phases: [{ duration: 'P3D', recurrenceCount: 1, free: true }], freeTrial: 'P3D' }],
  });
  assert.deepEqual(subscription.basePlans[1].price, { region: 'US', amount: '49.99', currency: 'USD' }, 'the first region when the asked one has no price');
  assert.deepEqual(subscription.basePlans[1].offers[0].phases, [{ duration: 'P1Y', recurrenceCount: 1, price: { amount: '24.99', currency: 'USD' } }]);
});

test('list_subscriptions still lists the subscriptions when the offers cannot be read', async () => {
  const { module, ctx } = setup({
    [`GET ${APP}/subscriptions`]: jsonResponse(200, fixture(import.meta.url, 'subscriptions.json')),
    [`GET ${APP}/subscriptions/-/basePlans/-/offers`]: jsonResponse(403, fixture(import.meta.url, 'error-403.json')),
  });
  const { payload } = await callTool(module, 'list_subscriptions', {}, ctx);
  assert.equal(payload.subscriptions.length, 1);
  assert.equal(payload.subscriptions[0].hasFreeTrial, undefined);
  assert.match(payload.note, /^The offers could not be read: Google Play refused the request: invite the service account play-agent@example-project\.iam\.gserviceaccount\.com/);
});

test('list_in_app_products reads the one-time products by default, or the legacy in-app products, with prices', async () => {
  const { module, ctx, apiCalls } = setup({
    [`GET ${APP}/inappproducts`]: jsonResponse(200, fixture(import.meta.url, 'inappproducts.json')),
    [`GET ${APP}/oneTimeProducts`]: jsonResponse(200, fixture(import.meta.url, 'onetimeproducts.json')),
  });
  const byDefault = await callTool(module, 'list_in_app_products', {}, ctx);
  assert.equal(byDefault.isError, false);
  assert.equal(apiCalls()[0].path, `${APP}/oneTimeProducts`);
  assert.equal(byDefault.payload.catalog, 'one_time_products');
  assert.equal(byDefault.payload.products[0].productId, 'lifetime_pro');

  const legacy = await callTool(module, 'list_in_app_products', { catalog: 'in_app_products', region: 'TR' }, ctx);
  assert.deepEqual(legacy.payload.products[0], {
    sku: 'credits_50',
    status: 'active',
    purchaseType: 'managedUser',
    title: '50 credits',
    description: '50 credits for video renders.',
    defaultLanguage: 'en-US',
    languages: 2,
    price: { amount: '1.99', currency: 'USD' },
    regionPrice: { region: 'TR', amount: '49.99', currency: 'TRY' },
  });
  assert.equal(apiCalls()[1].path, `${APP}/inappproducts`);
  await callTool(module, 'list_in_app_products', { catalog: 'in_app_products', cursor: legacy.payload.nextCursor }, ctx);
  assert.equal(apiCalls()[2].query.token, 'next-iap-page');

  const modern = await callTool(module, 'list_in_app_products', { catalog: 'one_time_products' }, ctx);
  assert.deepEqual(modern.payload.products[0], {
    productId: 'lifetime_pro',
    title: 'Lifetime Pro',
    description: 'Pro, once, forever.',
    languages: 1,
    offerTags: ['lifetime'],
    purchaseOptions: [{ purchaseOptionId: 'buy', state: 'ACTIVE', type: 'buy', price: { region: 'US', amount: '99.99', currency: 'USD' } }],
  });
  assert.equal(apiCalls()[3].query.pageSize, '100');
});

test('the legacy in-app products API refused for an app that moved on says to read the one-time products, not to invite anyone', async () => {
  // Google Play's answer, recorded: HTTP 403 PERMISSION_DENIED, though no permission is missing.
  const migrate = () => jsonResponse(403, { error: { code: 403, message: 'Please migrate to the new publishing API.', status: 'PERMISSION_DENIED' } });
  const { module, ctx, apiCalls } = setup({ [`GET ${APP}/inappproducts`]: migrate });
  const legacy = await callTool(module, 'list_in_app_products', { catalog: 'in_app_products' }, ctx);
  assert.equal(legacy.isError, true);
  assert.equal(legacy.payload.status, 403);
  assert.equal(
    legacy.payload.error,
    'Google Play no longer answers this legacy publishing API call for the app (HTTP 403): it said "Please migrate to the new publishing API." '
      + 'The app\'s one-time products are read with list_in_app_products (catalog one_time_products), which calls .../oneTimeProducts.',
  );
  const raw = await callTool(module, 'api_get', { path: `${APP}/inappproducts` }, ctx);
  assert.equal(raw.isError, true);
  assert.match(raw.payload.error, /^Google Play no longer answers this legacy publishing API call for the app \(HTTP 403\)/);
  assert.doesNotMatch(raw.payload.error, /invite/);
  assert.equal(apiCalls().length, 2);
});

test('a permission refusal says whom to invite in Play Console; a 429 carries retryAfter', async () => {
  const refused = setup({ [`GET ${APP}/reviews/${REVIEW}`]: jsonResponse(403, fixture(import.meta.url, 'error-403.json')) });
  const forbidden = await callTool(refused.module, 'get_review', { review_id: REVIEW }, refused.ctx);
  assert.equal(forbidden.payload.status, 403);
  assert.match(forbidden.payload.error, /^Google Play refused the request: invite the service account play-agent@example-project\.iam\.gserviceaccount\.com in Play Console -> Users and permissions/);
  assert.match(forbidden.payload.error, /Google Play said: "The caller does not have permission"\.$/);

  const limited = setup({ [`GET ${APP}/reviews`]: jsonResponse(429, { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '120' }) });
  const rate = await callTool(limited.module, 'list_reviews', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 120);
});

test('api_get and api_request reach the rest of the API for chosen apps only, and never user management', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    [`GET ${APP}/edits/123/tracks`]: jsonResponse(200, { tracks: [] }),
    [`POST ${APP}/subscriptions/pro_subscription/basePlans/weekly:deactivate`]: jsonResponse(200, { basePlanId: 'weekly', state: 'INACTIVE' }),
  });
  const tracks = await callTool(module, 'api_get', { path: `${APP}/edits/123/tracks` }, ctx);
  assert.equal(tracks.payload.status, 200);
  assert.equal(apiCalls()[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  const deactivate = await callTool(module, 'api_request', { method: 'POST', path: `${APP}/subscriptions/pro_subscription/basePlans/weekly:deactivate`, json: {} }, ctx);
  assert.equal(deactivate.payload.data.state, 'INACTIVE');
  const described = module.tools.find((tool) => tool.name === 'api_request').description;
  assert.match(described, /\.\.\.\/subscriptions\/\{productId\}\/basePlans:batchUpdateStates/);
  assert.doesNotMatch(described, /monetization/);

  const before = fetch.calls.length;
  const other = await callTool(module, 'api_get', { path: '/androidpublisher/v3/applications/com.other.app/reviews' }, ctx);
  assert.match(other.payload.error, /The app com\.other\.app is not among the apps chosen for this connection/);
  const users = await callTool(module, 'api_get', { path: '/androidpublisher/v3/developers/123/users' }, ctx);
  assert.match(users.payload.error, /names none of the apps chosen/);
  const open = setup({}, { accounts: null });
  const grants = await callTool(open.module, 'api_request', { method: 'POST', path: '/androidpublisher/v3/developers/123/users', json: {} }, open.ctx);
  assert.match(grants.payload.error, /user and permission management .* is not available here/);
  assert.equal(fetch.calls.length + open.fetch.calls.length, before);
});

test('log lines carry no key, token or review text', async () => {
  const { module, ctx, logs } = setup({ [`POST ${APP}/reviews/${REVIEW}:reply`]: jsonResponse(200, fixture(import.meta.url, 'reply.json')) });
  await callTool(module, 'reply_to_review', { review_id: REVIEW, reply_text: 'A private thank-you' }, ctx);
  const all = logs.join('\n');
  for (const secret of [ACCESS_TOKEN, 'PRIVATE KEY', KEY_BASE64.slice(0, 40), 'private thank-you', REVIEW]) assert.equal(all.includes(secret), false, secret);
  for (const line of logs) assert.match(line, /^google-play reply_to_review (POST|GET) \d{3} \d+ms$/);
});
