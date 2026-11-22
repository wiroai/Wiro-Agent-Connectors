import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes, textResponse } from '../../../tests/helpers.mjs';

// The key is made here, for this run: no key is ever stored in the repository.
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const credentials = { keyid: 'ABC123DEFG', issuerid: '57246542-96fe-1a63-e053-0824d011072a', privatekey: PEM };
const APP = '1234567890';
const API = 'https://api.appstoreconnect.apple.com';
const REVIEW_1 = '00000043-a7b1-4c2d-9e3f-000000000001';
const REVIEW_2 = '00000043-a7b1-4c2d-9e3f-000000000002';
const RESPONSE_2 = '6f1c7a52-0000-4000-8000-000000000002';
const EVENT_1 = '6a1d2b3c-1111-4aaa-8bbb-000000000001';
const LOCALIZATION_1 = '7b2e3c4d-2222-4ccc-8ddd-000000000001';

/** A fake fetch that answers by "METHOD /path"; anything else is a 404 the test would notice. */
function routes(table) {
  return (request) => {
    const handler = table[`${request.method} ${request.path}`];
    if (!handler) return jsonResponse(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'not routed', detail: request.path }] });
    return typeof handler === 'function' ? handler(request) : handler();
  };
}

function setup(handler, { accounts = { apps: [APP] }, creds = credentials } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, accounts, fetch });
  return { module, context, fetch, ctx, logs };
}

function decodeJwt(header) {
  const [scheme, token] = header.split(' ');
  assert.equal(scheme, 'Bearer');
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    valid: verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')),
  };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

test('list_apps signs an ES256 token from the key, reads the apps and trims them', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')));
  const { payload, isError } = await callTool(module, 'list_apps', { limit: 2 }, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.origin, API);
  assert.equal(request.path, '/v1/apps');
  assert.deepEqual(request.query, { 'fields[apps]': 'name,bundleId,sku,primaryLocale', sort: 'name', limit: '2' });
  const jwt = decodeJwt(request.headers.authorization);
  assert.equal(jwt.valid, true);
  assert.deepEqual(jwt.header, { alg: 'ES256', typ: 'JWT', kid: 'ABC123DEFG' });
  assert.equal(jwt.payload.iss, credentials.issuerid);
  assert.equal(jwt.payload.aud, 'appstoreconnect-v1');
  assert.equal(jwt.payload.exp - jwt.payload.iat, 1200);
  assert.deepEqual(payload.apps, [
    { id: '1234567890', name: 'Acme Photo', bundleId: 'com.example.photo', sku: 'ACME-PHOTO-1', primaryLocale: 'en-US', selected: true },
    { id: '1234567891', name: 'Acme Video', bundleId: 'com.example.video', sku: 'ACME-VIDEO-1', primaryLocale: 'tr' },
  ]);
  assert.equal(payload.note, undefined);

  await callTool(module, 'list_apps', { limit: 2, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.cursor, 'Mg.AJUmP2s');
});

test('list_apps marks the chosen apps only under a lock, and says when none is chosen', async () => {
  const open = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), { accounts: null });
  const all = await callTool(open.module, 'list_apps', {}, open.ctx);
  assert.ok(all.payload.apps.every((app) => !('selected' in app)), 'no lock, no marks');
  assert.equal(all.payload.note, undefined);

  const none = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), { accounts: {} });
  const unchosen = await callTool(none.module, 'list_apps', {}, none.ctx);
  assert.equal(unchosen.isError, false);
  assert.ok(unchosen.payload.apps.every((app) => !('selected' in app)));
  assert.match(unchosen.payload.note, /^No app is chosen for this connection yet, so every tool that names an app is refused/);
});

test('the apps picker: list_apps with no arguments gives the id and the name of each app', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), { accounts: null });
  const [picker] = module.accountPickers;
  assert.deepEqual({ ...picker }, {
    key: 'apps',
    label: 'App Store apps',
    description: 'The apps the agent may read and manage in App Store Connect.',
    multiple: true,
    tool: 'list_apps',
    idField: 'id',
    nameField: 'name',
    legacyField: 'apps',
  });
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.deepEqual(payload.apps.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [['1234567890', 'Acme Photo'], ['1234567891', 'Acme Video']]);
});

test('a key kept as base64 of the .p8 text works, and a broken key is refused before anything is sent', async () => {
  const base64 = { ...credentials, privatekey: Buffer.from(PEM).toString('base64') };
  const ok = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), { creds: base64 });
  await callTool(ok.module, 'list_apps', {}, ok.ctx);
  assert.equal(decodeJwt(ok.fetch.calls[0].headers.authorization).valid, true);

  const der = { ...credentials, privatekey: ec.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
  const bare = setup(() => jsonResponse(200, fixture(import.meta.url, 'apps.json')), { creds: der });
  await callTool(bare.module, 'list_apps', {}, bare.ctx);
  assert.equal(decodeJwt(bare.fetch.calls[0].headers.authorization).valid, true);

  const broken = setup(() => jsonResponse(200, {}), { creds: { ...credentials, privatekey: 'not-a-key' } });
  const refused = await callTool(broken.module, 'list_apps', {}, broken.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /^The App Store Connect private key could not be read/);
  assert.equal(broken.fetch.calls.length, 0);

  const missing = setup(() => jsonResponse(200, {}), { creds: { keyid: 'ABC123DEFG' } });
  const notConnected = await callTool(missing.module, 'list_apps', {}, missing.ctx);
  assert.match(notConnected.payload.error, /^App Store Connect is not connected: the App Store Connect issuer ID and App Store Connect private key are missing\.$/);
});

test('list_reviews sends the filters, trims each review with its response, and continues with the cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'reviews.json')));
  const { payload } = await callTool(module, 'list_reviews', { app_id: APP, ratings: [1, 2], territory: 'USA', has_published_response: false, limit: 2 }, ctx);
  const [request] = fetch.calls;
  assert.equal(request.path, `/v1/apps/${APP}/customerReviews`);
  assert.equal(request.query.sort, '-createdDate');
  assert.equal(request.query.include, 'response');
  assert.equal(request.query['filter[rating]'], '1,2');
  assert.equal(request.query['filter[territory]'], 'USA');
  assert.equal(request.query['exists[publishedResponse]'], 'false');
  assert.equal(payload.appId, APP);
  assert.deepEqual(payload.reviews[0], {
    id: REVIEW_1,
    rating: 2,
    title: 'Crashes on export',
    body: 'The app closes every time I export a video longer than a minute.',
    reviewer: 'sam_k',
    territory: 'USA',
    createdDate: '2026-11-20T08:14:03-08:00',
    responded: false,
  });
  assert.deepEqual(payload.reviews[1].response, { id: RESPONSE_2, body: 'Thanks, Dana! More film looks are on the way.', state: 'PUBLISHED', lastModifiedDate: '2026-11-20T09:00:00-08:00' });
  await callTool(module, 'list_reviews', { app_id: APP, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.cursor, 'Ag.bK3dQ');
});

test('a page over 32 KB is cut and continues after the last review returned', async () => {
  const many = { data: Array.from({ length: 60 }, (_, index) => ({ type: 'customerReviews', id: `r-${index}`, attributes: { rating: 3, body: 'x'.repeat(1200), createdDate: '2026-11-01T00:00:00Z' } })), links: {} };
  const { module, fetch, ctx } = setup(() => jsonResponse(200, many));
  const first = await callTool(module, 'list_reviews', { app_id: APP, limit: 60 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.reviews.length;
  const second = await callTool(module, 'list_reviews', { app_id: APP, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.cursor, undefined, 'the same Apple page again');
  assert.equal(second.payload.reviews[0].id, `r-${shown}`);
});

test('an app outside the chosen apps is refused before any request, and no lock (null) lets any app through', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'reviews.json')));
  const refused = await callTool(module, 'list_reviews', { app_id: '999' }, ctx);
  assert.match(refused.payload.error, /^The app 999 is not among the apps chosen for this connection\. Use one of: 1234567890\. Nothing was sent\.$/);
  const nothingChosen = setup(() => jsonResponse(200, {}), { accounts: {} });
  const none = await callTool(nothingChosen.module, 'list_app_events', { app_id: APP }, nothingChosen.ctx);
  assert.match(none.payload.error, /No app is chosen for it yet/);
  assert.equal(fetch.calls.length + nothingChosen.fetch.calls.length, 0);

  const open = setup(() => jsonResponse(200, fixture(import.meta.url, 'reviews.json')), { accounts: null });
  assert.equal((await callTool(open.module, 'list_reviews', { app_id: '999' }, open.ctx)).isError, false);
});

test('respond_to_review finds the review among the app\'s reviews, then posts the response once', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/customerReviews`]: () => jsonResponse(200, fixture(import.meta.url, 'reviews.json')),
    'POST /v1/customerReviewResponses': () => jsonResponse(201, fixture(import.meta.url, 'review-response.json')),
  }));
  const body = 'Sorry about the crash, Sam. Version 4.2 fixes long exports: please update and let us know.';
  const { payload, isError } = await callTool(module, 'respond_to_review', { app_id: APP, review_id: REVIEW_1, response_body: body }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [`GET /v1/apps/${APP}/customerReviews`, 'POST /v1/customerReviewResponses']);
  assert.equal(fetch.calls[0].query.limit, '200');
  assert.deepEqual(fetch.calls[1].json, {
    data: {
      type: 'customerReviewResponses',
      attributes: { responseBody: body },
      relationships: { review: { data: { type: 'customerReviews', id: REVIEW_1 } } },
    },
  });
  assert.deepEqual(payload, {
    reviewId: REVIEW_1,
    id: '6f1c7a52-0000-4000-8000-000000000009',
    body,
    state: 'PENDING_PUBLISH',
    lastModifiedDate: '2026-11-21T10:02:11-08:00',
  });
});

test('respond_to_review refuses a review the app does not have, after looking through its newest reviews', async () => {
  let pages = 0;
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/customerReviews`]: () => {
      pages += 1;
      return jsonResponse(200, { data: [{ type: 'customerReviews', id: `other-${pages}` }], links: { next: `${API}/v1/apps/${APP}/customerReviews?cursor=p${pages}` } });
    },
  }));
  const { payload } = await callTool(module, 'respond_to_review', { app_id: APP, review_id: 'someone-elses', response_body: 'Hi' }, ctx);
  assert.match(payload.error, /^The review someone-elses is not among the newest 1000 reviews of app 1234567890\. .*Nothing was sent\.$/);
  assert.equal(fetch.calls.length, 5);
  assert.ok(fetch.calls.every((call) => call.method === 'GET'));
  assert.equal(fetch.calls[1].query.cursor, 'p1');

  const open = setup(() => jsonResponse(201, fixture(import.meta.url, 'review-response.json')), { accounts: null });
  await callTool(open.module, 'respond_to_review', { app_id: APP, review_id: 'any', response_body: 'Hi' }, open.ctx);
  assert.deepEqual(open.fetch.calls.map((call) => call.method), ['POST'], 'without a lock nothing is looked up');
});

test('an unclear review response outcome is reported as unknown, with exactly one POST', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(503, { errors: [{ status: '503', title: 'Service Unavailable' }] }), { accounts: null });
  const { payload } = await callTool(module, 'respond_to_review', { app_id: APP, review_id: REVIEW_1, response_body: 'Thanks!' }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'list_reviews');
  assert.equal(fetch.calls.length, 1);
});

test('delete_review_response checks which review the response answers, then deletes it', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/customerReviewResponses/${RESPONSE_2}`]: () => jsonResponse(200, fixture(import.meta.url, 'review-response-detail.json')),
    [`GET /v1/apps/${APP}/customerReviews`]: () => jsonResponse(200, fixture(import.meta.url, 'reviews.json')),
    [`DELETE /v1/customerReviewResponses/${RESPONSE_2}`]: () => new Response(null, { status: 204 }),
  }));
  const { payload } = await callTool(module, 'delete_review_response', { app_id: APP, response_id: RESPONSE_2 }, ctx);
  assert.deepEqual(payload, { deleted: true, id: RESPONSE_2 });
  assert.equal(fetch.calls[0].query.include, 'review');
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'GET', 'DELETE']);
});

test('list_app_events returns events with their localizations and counts by state', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'events.json')));
  const { payload } = await callTool(module, 'list_app_events', { app_id: APP, states: ['DRAFT', 'PAST'] }, ctx);
  const [request] = fetch.calls;
  assert.equal(request.path, `/v1/apps/${APP}/appEvents`);
  assert.equal(request.query.include, 'localizations');
  assert.equal(request.query['filter[eventState]'], 'DRAFT,PAST');
  assert.equal(request.query['limit[localizations]'], '50');
  assert.deepEqual(payload.countsOnThisPage, { DRAFT: 1, PAST: 1 });
  assert.deepEqual(payload.events[0], {
    id: EVENT_1,
    referenceName: 'lunar-new-year-2027',
    badge: 'SPECIAL_EVENT',
    state: 'DRAFT',
    priority: 'HIGH',
    purpose: 'APPROPRIATE_FOR_ALL_USERS',
    purchaseRequirement: 'NO_COST_ASSOCIATED',
    deepLink: 'https://example.com/events/lunar',
    primaryLocale: 'en-US',
    territorySchedules: [{ territories: ['CHN', 'TWN', 'HKG'], publishStart: '2027-01-30T00:00:00Z', eventStart: '2027-02-06T00:00:00Z', eventEnd: '2027-02-13T00:00:00Z' }],
    localizations: [
      { id: LOCALIZATION_1, locale: 'en-US', name: 'Lunar New Year Looks', shortDescription: 'Unlock festive filters and frames', longDescription: 'Celebrate with red lantern filters, gold frames and a new fireworks effect, free for one week.' },
      { id: '7b2e3c4d-2222-4ccc-8ddd-000000000002', locale: 'zh-Hans' },
    ],
  });
  assert.deepEqual(payload.events[1].localizations, []);
});

const NEW_EVENT = {
  app_id: APP,
  reference_name: 'spring-challenge-2027',
  badge: 'CHALLENGE',
  purchase_requirement: 'NO_COST_ASSOCIATED',
  priority: 'NORMAL',
  purpose: 'ATTRACT_NEW_USERS',
  deep_link: 'myapp://events/spring',
  primary_locale: 'en-US',
  territory_schedules: [{ territories: ['USA', 'GBR', 'DEU'], publish_start: '2027-03-01T00:00:00Z', event_start: '2027-03-08T00:00:00Z', event_end: '2027-03-15T00:00:00Z' }],
};

test('create_app_event posts a draft event for the app with Apple\'s attribute names', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, fixture(import.meta.url, 'event-created.json')));
  const { payload, isError } = await callTool(module, 'create_app_event', NEW_EVENT, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].path, '/v1/appEvents');
  assert.deepEqual(fetch.calls[0].json, {
    data: {
      type: 'appEvents',
      attributes: {
        referenceName: 'spring-challenge-2027',
        badge: 'CHALLENGE',
        purchaseRequirement: 'NO_COST_ASSOCIATED',
        priority: 'NORMAL',
        purpose: 'ATTRACT_NEW_USERS',
        deepLink: 'myapp://events/spring',
        primaryLocale: 'en-US',
        territorySchedules: [{ territories: ['USA', 'GBR', 'DEU'], publishStart: '2027-03-01T00:00:00Z', eventStart: '2027-03-08T00:00:00Z', eventEnd: '2027-03-15T00:00:00Z' }],
      },
      relationships: { app: { data: { type: 'apps', id: APP } } },
    },
  });
  assert.equal(payload.event.id, '6a1d2b3c-1111-4aaa-8bbb-000000000003');
  assert.equal(payload.event.state, 'DRAFT');
  assert.equal('archivedTerritorySchedules' in payload.event, false);
});

test('schedules that break Apple\'s rules are refused before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, {}));
  const schedule = NEW_EVENT.territory_schedules[0];
  const cases = [
    [{ ...schedule, publish_start: '2027-02-01T00:00:00Z' }, /within 14 days of event_start/],
    [{ ...schedule, event_end: '2027-03-08T00:10:00Z' }, /at least 15 minutes after event_start/],
    [{ ...schedule, event_end: '2027-04-20T00:00:00Z' }, /within 31 days of event_start/],
    [{ ...schedule, publish_start: '2027-03-09T00:00:00Z' }, /publish_start must not be after event_start/],
  ];
  for (const [bad, message] of cases) {
    const { payload } = await callTool(module, 'create_app_event', { ...NEW_EVENT, territory_schedules: [bad] }, ctx);
    assert.match(payload.error, message);
    assert.match(payload.error, /Nothing was changed\.$/);
  }
  const badTerritory = await callTool(module, 'create_app_event', { ...NEW_EVENT, territory_schedules: [{ ...schedule, territories: ['US'] }] }, ctx);
  assert.match(badTerritory.payload.error, /does not have the expected format/);
  assert.equal(fetch.calls.length, 0);
});

test('a refused event keeps the status, and an unclear create is unknown with one POST', async () => {
  const conflict = setup(() => jsonResponse(409, fixture(import.meta.url, 'error-409.json')));
  const refused = await callTool(conflict.module, 'create_app_event', NEW_EVENT, conflict.ctx);
  assert.equal(refused.payload.status, 409);
  assert.match(refused.payload.error, /^App Store Connect refused the event: a value is invalid, the reference name is already used, or the event can no longer be changed in its state \(HTTP 409\)\. Nothing was changed\./);

  const broken = setup(() => { throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' }); });
  const unknown = await callTool(broken.module, 'create_app_event', NEW_EVENT, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_app_events');
  assert.equal(broken.fetch.calls.length, 1);
});

test('update_app_event checks the event is the app\'s, then sends only the fields given', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1 }] }),
    [`PATCH /v1/appEvents/${EVENT_1}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-created.json')),
  }));
  await callTool(module, 'update_app_event', { app_id: APP, event_id: EVENT_1, priority: 'HIGH' }, ctx);
  assert.equal(fetch.calls[0].query['filter[id]'], EVENT_1);
  assert.deepEqual(fetch.calls[1].json, { data: { type: 'appEvents', id: EVENT_1, attributes: { priority: 'HIGH' } } });

  const elsewhere = setup(routes({ [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [] }) }));
  const refused = await callTool(elsewhere.module, 'update_app_event', { app_id: APP, event_id: 'not-ours', priority: 'HIGH' }, elsewhere.ctx);
  assert.match(refused.payload.error, /^App 1234567890 has no in-app event not-ours\. .*Nothing was sent\.$/);
  assert.deepEqual(elsewhere.fetch.calls.map((call) => call.method), ['GET']);

  const empty = await callTool(module, 'update_app_event', { app_id: APP, event_id: EVENT_1 }, ctx);
  assert.match(empty.payload.error, /^Nothing to change/);
  assert.equal(fetch.calls.length, 2);
});

test('delete_app_event deletes after the check', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1 }] }),
    [`DELETE /v1/appEvents/${EVENT_1}`]: () => new Response(null, { status: 204 }),
  }));
  const { payload } = await callTool(module, 'delete_app_event', { app_id: APP, event_id: EVENT_1 }, ctx);
  assert.deepEqual(payload, { deleted: true, appId: APP, eventId: EVENT_1 });
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'DELETE']);
});

test('create_app_event_localization and update_app_event_localization send the texts for the right event', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1 }] }),
    'POST /v1/appEventLocalizations': () => jsonResponse(201, fixture(import.meta.url, 'event-localization.json')),
    [`GET /v1/appEventLocalizations/${LOCALIZATION_1}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-localization-detail.json')),
    [`PATCH /v1/appEventLocalizations/${LOCALIZATION_1}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-localization.json')),
  }));
  const created = await callTool(module, 'create_app_event_localization', {
    app_id: APP,
    event_id: EVENT_1,
    locale: 'de-DE',
    name: 'Frühlings-Challenge',
    short_description: 'Neue Filter jeden Tag',
    long_description: 'Eine Woche lang jeden Tag ein neuer Frühlingsfilter.',
  }, ctx);
  assert.deepEqual(fetch.calls[1].json, {
    data: {
      type: 'appEventLocalizations',
      attributes: { locale: 'de-DE', name: 'Frühlings-Challenge', shortDescription: 'Neue Filter jeden Tag', longDescription: 'Eine Woche lang jeden Tag ein neuer Frühlingsfilter.' },
      relationships: { appEvent: { data: { type: 'appEvents', id: EVENT_1 } } },
    },
  });
  assert.equal(created.payload.localization.locale, 'de-DE');

  const tooLong = await callTool(module, 'create_app_event_localization', { app_id: APP, event_id: EVENT_1, locale: 'en-US', name: 'x'.repeat(31), short_description: 'a', long_description: 'b' }, ctx);
  assert.match(tooLong.payload.error, /`name` must be at most 30 characters/);

  await callTool(module, 'update_app_event_localization', { app_id: APP, localization_id: LOCALIZATION_1, short_description: 'New text' }, ctx);
  assert.deepEqual(fetch.calls.slice(2).map((call) => `${call.method} ${call.path}`), [
    `GET /v1/appEventLocalizations/${LOCALIZATION_1}`,
    `GET /v1/apps/${APP}/appEvents`,
    `PATCH /v1/appEventLocalizations/${LOCALIZATION_1}`,
  ]);
  assert.equal(fetch.calls[2].query.include, 'appEvent');
  assert.deepEqual(fetch.calls[4].json, { data: { type: 'appEventLocalizations', id: LOCALIZATION_1, attributes: { shortDescription: 'New text' } } });
});

test('get_app_metadata joins the record, app info, live version texts and the public listing, which gets no credentials', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}`]: () => jsonResponse(200, fixture(import.meta.url, 'app.json')),
    [`GET /v1/apps/${APP}/appInfos`]: () => jsonResponse(200, fixture(import.meta.url, 'app-infos.json')),
    [`GET /v1/apps/${APP}/appStoreVersions`]: () => jsonResponse(200, fixture(import.meta.url, 'versions.json')),
    'GET /v1/appStoreVersions/ver-4-2/appStoreVersionLocalizations': () => jsonResponse(200, fixture(import.meta.url, 'version-localizations.json')),
    'GET /lookup': () => textResponse(200, `\n\n\n${JSON.stringify(fixture(import.meta.url, 'lookup.json'))}`, { 'content-type': 'text/javascript; charset=utf-8' }),
  }));
  const { payload, isError } = await callTool(module, 'get_app_metadata', { app_id: APP }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 5);
  const lookup = fetch.calls[4];
  assert.equal(lookup.url, 'https://itunes.apple.com/lookup?id=1234567890&country=us');
  assert.equal(lookup.headers.authorization, undefined, 'the public lookup gets no token');
  assert.equal(fetch.calls[3].query['filter[locale]'], 'en-US', 'the primary locale by default');
  assert.deepEqual(payload.app, {
    id: APP,
    name: 'Acme Photo',
    bundleId: 'com.example.photo',
    sku: 'ACME-PHOTO-1',
    primaryLocale: 'en-US',
    contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
    madeForKids: false,
  });
  assert.deepEqual(payload.appInfos[0], {
    id: 'a1b2c3d4-0000-4000-8000-00000000live',
    state: 'READY_FOR_DISTRIBUTION',
    ageRating: 'FOUR_PLUS',
    primaryCategory: 'PHOTO_AND_VIDEO',
    locale: 'en-US',
    name: 'Acme Photo',
    subtitle: 'Film filters and frames',
    privacyPolicyUrl: 'https://example.com/privacy',
    locales: ['en-US', 'tr'],
  });
  assert.equal(payload.versions.length, 2);
  assert.equal(payload.versionLocalization.versionString, '4.2', 'the live version, not the draft');
  assert.equal(payload.versionLocalization.keywords, 'film,filters,photo editor,frames');
  assert.equal(payload.storeListing.formattedPrice, 'Free');
  assert.equal(payload.storeListing.primaryGenre, 'Photo & Video');
  assert.equal(payload.storeListing.userRatingCount, 18234);
  assert.equal('screenshotUrls' in payload.storeListing, false);
});

test('get_app_metadata says when the app is not on the App Store in the country, and can skip the listing', async () => {
  const table = {
    [`GET /v1/apps/${APP}`]: () => jsonResponse(200, fixture(import.meta.url, 'app.json')),
    [`GET /v1/apps/${APP}/appInfos`]: () => jsonResponse(200, { data: [] }),
    [`GET /v1/apps/${APP}/appStoreVersions`]: () => jsonResponse(200, { data: [] }),
    'GET /lookup': () => jsonResponse(200, { resultCount: 0, results: [] }),
  };
  const { module, fetch, ctx } = setup(routes(table));
  const { payload } = await callTool(module, 'get_app_metadata', { app_id: APP, country: 'tr', locale: 'tr' }, ctx);
  assert.deepEqual(payload.storeListing, { country: 'tr', available: false, note: 'The app is not on the App Store in this country (TR), or not released yet.' });
  assert.equal(fetch.calls.length, 4);
  const skip = setup(routes(table));
  const skipped = await callTool(skip.module, 'get_app_metadata', { app_id: APP, include_store_listing: false }, skip.ctx);
  assert.equal(skipped.payload.storeListing, undefined);
  assert.equal(skip.fetch.calls.length, 3);
});

test('list_subscriptions lists each subscription with its group, introductory offers and current price, and says whether there is a free trial', async () => {
  const table = {
    [`GET /v1/apps/${APP}/subscriptionGroups`]: () => jsonResponse(200, fixture(import.meta.url, 'subscription-groups.json')),
    'GET /v1/subscriptionGroups/21000001/subscriptions': () => jsonResponse(200, fixture(import.meta.url, 'subscriptions.json')),
    'GET /v1/subscriptions/6400000001/prices': () => jsonResponse(200, fixture(import.meta.url, 'subscription-prices.json')),
    'GET /v1/subscriptions/6400000002/prices': () => jsonResponse(404, { errors: [{ status: '404', code: 'NOT_FOUND' }] }),
  };
  const { module, fetch, ctx } = setup(routes(table));
  const { payload, isError } = await callTool(module, 'list_subscriptions', { app_id: APP }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[1].query.include, 'introductoryOffers');
  assert.equal(fetch.calls[1].query.limit, '50');
  assert.equal(fetch.calls[2].query['filter[territory]'], 'USA');
  assert.equal(fetch.calls[2].query.include, 'subscriptionPricePoint,territory');
  assert.equal(fetch.calls.length, 4);
  assert.equal(payload.hasFreeTrial, true);
  assert.equal(payload.priceTerritory, 'USA');
  assert.deepEqual(payload.groups, [{ id: '21000001', referenceName: 'Acme Pro' }]);
  assert.deepEqual(payload.subscriptions[0], {
    groupId: '21000001',
    id: '6400000001',
    name: 'Pro Weekly',
    productId: 'com.example.photo.pro.weekly',
    period: 'ONE_WEEK',
    state: 'APPROVED',
    groupLevel: 2,
    familySharable: false,
    price: {
      customerPrice: '8.99',
      proceeds: '7.64',
      currency: 'USD',
      territory: 'USA',
      scheduled: [{ customerPrice: '9.99', proceeds: '8.49', currency: 'USD', territory: 'USA', startDate: '2099-01-01' }],
    },
    introductoryOffers: [
      { offerMode: 'FREE_TRIAL', duration: 'THREE_DAYS', numberOfPeriods: 1, territories: 2 },
      { offerMode: 'PAY_AS_YOU_GO', duration: 'ONE_WEEK', numberOfPeriods: 1, territories: 1 },
    ],
  });
  assert.deepEqual(payload.subscriptions[1].introductoryOffers, []);
  assert.equal(payload.subscriptions[1].price, undefined, 'no price schedule (404) is no price, not an error');
  assert.equal(payload.nextCursor, undefined);

  const noPrices = setup(routes(table));
  await callTool(noPrices.module, 'list_subscriptions', { app_id: APP, include_prices: false }, noPrices.ctx);
  assert.equal(noPrices.fetch.calls.length, 2);
});

test('list_subscriptions continues with a cursor across Apple pages and groups, and takes one group', async () => {
  const sub = (id) => ({ type: 'subscriptions', id, attributes: { name: `Plan ${id}`, productId: `com.example.${id}`, state: 'APPROVED' }, relationships: { introductoryOffers: { data: [] } } });
  const table = {
    [`GET /v1/apps/${APP}/subscriptionGroups`]: () => jsonResponse(200, { data: [
      { type: 'subscriptionGroups', id: 'g1', attributes: { referenceName: 'First' } },
      { type: 'subscriptionGroups', id: 'g2', attributes: { referenceName: 'Second' } },
    ] }),
    'GET /v1/subscriptionGroups/g1/subscriptions': (request) => (request.query.cursor === 'P2'
      ? jsonResponse(200, { data: [sub('s3')] })
      : jsonResponse(200, { data: [sub('s1'), sub('s2')], links: { next: `${API}/v1/subscriptionGroups/g1/subscriptions?cursor=P2&limit=50` } })),
    'GET /v1/subscriptionGroups/g2/subscriptions': () => jsonResponse(200, { data: [sub('s4'), sub('s5')] }),
  };
  const { module, fetch, ctx } = setup(routes(table));
  const ids = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const { payload } = await callTool(module, 'list_subscriptions', { app_id: APP, include_prices: false, limit: 2, ...(cursor ? { cursor } : {}) }, ctx);
    ids.push(...payload.subscriptions.map((item) => `${item.groupId}/${item.id}`));
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(ids, ['g1/s1', 'g1/s2', 'g1/s3', 'g2/s4', 'g2/s5']);
  assert.ok(fetch.calls.some((call) => call.query.cursor === 'P2'), 'Apple\'s cursor is followed inside a group');

  const one = setup(routes(table));
  const { payload } = await callTool(one.module, 'list_subscriptions', { app_id: APP, group_id: 'g2', include_prices: false }, one.ctx);
  assert.deepEqual(payload.subscriptions.map((item) => item.id), ['s4', 's5']);
  assert.deepEqual(payload.groups, [{ id: 'g2', referenceName: 'Second' }]);
  const missing = await callTool(one.module, 'list_subscriptions', { app_id: APP, group_id: 'g9' }, one.ctx);
  assert.match(missing.payload.error, /^App 1234567890 has no subscription group g9\./);
  assert.ok(!one.fetch.calls.some((call) => call.path.includes('/g9/')), 'a group the app does not have is never read');
});

test('list_in_app_purchases trims each purchase and adds its price, falling back to the automatic (equalized) prices', async () => {
  const purchases = {
    data: [
      fixture(import.meta.url, 'in-app-purchases.json').data[0],
      { type: 'inAppPurchases', id: '6500000002', attributes: { name: 'Remove Ads', productId: 'com.example.photo.noads', inAppPurchaseType: 'NON_CONSUMABLE', state: 'APPROVED', familySharable: true } },
    ],
  };
  const table = {
    [`GET /v1/apps/${APP}/inAppPurchasesV2`]: () => jsonResponse(200, purchases),
    'GET /v1/inAppPurchasePriceSchedules/6500000001/manualPrices': () => jsonResponse(200, fixture(import.meta.url, 'iap-manual-prices.json')),
    'GET /v1/inAppPurchasePriceSchedules/6500000002/manualPrices': () => jsonResponse(200, { data: [] }),
    'GET /v1/inAppPurchasePriceSchedules/6500000002/automaticPrices': () => jsonResponse(200, fixture(import.meta.url, 'iap-automatic-prices.json')),
  };
  const { module, fetch, ctx } = setup(routes(table));
  const { payload } = await callTool(module, 'list_in_app_purchases', { app_id: APP, type: 'CONSUMABLE' }, ctx);
  assert.equal(fetch.calls[0].query['filter[inAppPurchaseType]'], 'CONSUMABLE');
  assert.equal(fetch.calls[0].query.limit, '20', 'with prices, at most 20 a page');
  assert.equal(fetch.calls[1].query['filter[territory]'], 'USA');
  assert.equal(fetch.calls[1].query.include, 'inAppPurchasePricePoint,territory');
  assert.equal(fetch.calls[1].query['fields[inAppPurchasePricePoints]'], 'customerPrice,proceeds');
  assert.deepEqual(fetch.calls.map((call) => call.path), [
    `/v1/apps/${APP}/inAppPurchasesV2`,
    '/v1/inAppPurchasePriceSchedules/6500000001/manualPrices',
    '/v1/inAppPurchasePriceSchedules/6500000002/manualPrices',
    '/v1/inAppPurchasePriceSchedules/6500000002/automaticPrices',
  ]);
  assert.equal(payload.priceTerritory, 'USA');
  assert.deepEqual(payload.inAppPurchases[0], {
    id: '6500000001',
    name: '50 Credits',
    productId: 'com.example.photo.credits50',
    type: 'CONSUMABLE',
    state: 'APPROVED',
    familySharable: false,
    price: {
      customerPrice: '1.99',
      proceeds: '1.69',
      currency: 'USD',
      territory: 'USA',
      endDate: '2099-01-01',
      scheduled: [{ customerPrice: '2.99', proceeds: '2.54', currency: 'USD', territory: 'USA', startDate: '2099-01-01' }],
    },
  });
  assert.deepEqual(payload.inAppPurchases[1].price, { customerPrice: '79.99', proceeds: '56.61', currency: 'TRY', territory: 'TUR', startDate: '2026-01-01', automatic: true });

  const plain = setup(routes(table));
  const without = await callTool(plain.module, 'list_in_app_purchases', { app_id: APP, include_prices: false, limit: 150 }, plain.ctx);
  assert.equal(plain.fetch.calls.length, 1);
  assert.equal(plain.fetch.calls[0].query.limit, '150');
  assert.equal(without.payload.inAppPurchases[0].price, undefined);
  assert.equal(without.payload.priceTerritory, undefined);
});

const IMAGE_ID = '8c3f4d5e-3333-4eee-8fff-000000000002';
const UPLOAD_HOST = 'https://store-030.blobstore.apple.com';

/** A PNG file of the given size: its signature and IHDR chunk, then a few bytes, 40 in all. */
function png(width, height) {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A JPEG file of the given size: SOI, an APP0 segment, then a baseline frame header. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

function imageRoutes(extra = {}, image = png(1080, 1920)) {
  return routes({
    [`GET /v1/appEventLocalizations/${LOCALIZATION_1}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-localization-media.json')),
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1 }] }),
    'GET /images/details.png': () => new Response(image, { status: 200, headers: { 'content-type': 'image/png' } }),
    'POST /v1/appEventScreenshots': () => jsonResponse(201, fixture(import.meta.url, 'event-image-reserved.json')),
    'PUT /assets-example-030001/PurpleSource%2Fv4%2Fpart1': () => new Response(null, { status: 200 }),
    'PUT /assets-example-030001/PurpleSource%2Fv4%2Fpart2': () => new Response(null, { status: 200 }),
    [`PATCH /v1/appEventScreenshots/${IMAGE_ID}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-image-reserved.json')),
    [`GET /v1/appEventScreenshots/${IMAGE_ID}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-image-complete.json')),
    [`DELETE /v1/appEventScreenshots/${IMAGE_ID}`]: () => new Response(null, { status: 204 }),
    ...extra,
  });
}

const UPLOAD_ARGS = { app_id: APP, localization_id: LOCALIZATION_1, asset_type: 'EVENT_DETAILS_PAGE', image_url: 'https://cdn.example.com/images/details.png' };

test('list_app_event_images shows a localization\'s images, videos and placements after checking its event is the app\'s', async () => {
  const { module, fetch, ctx } = setup(imageRoutes());
  const { payload, isError } = await callTool(module, 'list_app_event_images', { app_id: APP, localization_id: LOCALIZATION_1 }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].query.include, 'appEvent,appEventScreenshots,appEventVideoClips,placements');
  assert.equal(fetch.calls[1].query['filter[id]'], EVENT_1);
  assert.deepEqual(payload, {
    appId: APP,
    eventId: EVENT_1,
    localizationId: LOCALIZATION_1,
    locale: 'en-US',
    images: [{
      id: '8c3f4d5e-3333-4eee-8fff-000000000001',
      assetType: 'EVENT_CARD',
      fileName: 'event-card.png',
      fileSize: 2483112,
      state: 'COMPLETE',
      width: 1920,
      height: 1080,
      templateUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/aa/bb/cc/event-card.png/{w}x{h}bb.{f}',
    }],
    placements: [{ id: '2e000005-e036-8f0b-8f25-6dbc2baa784a', placementType: 'EVENT_DETAILS_PAGE_ASSET', mediaType: 'IMAGE', state: 'PARENT_PREPARE_FOR_SUBMISSION' }],
  });

  const elsewhere = setup(imageRoutes({ [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [] }) }));
  const refused = await callTool(elsewhere.module, 'list_app_event_images', { app_id: APP, localization_id: LOCALIZATION_1 }, elsewhere.ctx);
  assert.match(refused.payload.error, /^App 1234567890 has no in-app event /);
});

test('upload_app_event_image checks the image, reserves it, uploads each part to Apple\'s upload address, commits it and waits for processing', async () => {
  const { module, fetch, ctx, logs } = setup(imageRoutes());
  const { payload, isError } = await callTool(module, 'upload_app_event_image', UPLOAD_ARGS, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.origin}`), [
    `GET ${API}`,
    `GET ${API}`,
    'GET https://cdn.example.com',
    `POST ${API}`,
    `PUT ${UPLOAD_HOST}`,
    `PUT ${UPLOAD_HOST}`,
    `PATCH ${API}`,
    `GET ${API}`,
  ]);
  const download = fetch.calls[2];
  assert.equal(download.headers.authorization, undefined, 'the image download gets no token');
  assert.deepEqual(fetch.calls[3].json, {
    data: {
      type: 'appEventScreenshots',
      attributes: { fileName: 'event-details-page.png', fileSize: 40, appEventAssetType: 'EVENT_DETAILS_PAGE' },
      relationships: { appEventLocalization: { data: { type: 'appEventLocalizations', id: LOCALIZATION_1 } } },
    },
  });
  const [part1, part2] = [fetch.calls[4], fetch.calls[5]];
  assert.equal(part1.headers['content-type'], 'image/png');
  assert.equal(part1.headers.authorization, undefined, 'the upload address gets no token');
  assert.deepEqual([...part1.body], [...png(1080, 1920).subarray(0, 24)]);
  assert.deepEqual([...part2.body], [...png(1080, 1920).subarray(24, 40)]);
  assert.deepEqual(fetch.calls[6].json, { data: { type: 'appEventScreenshots', id: IMAGE_ID, attributes: { uploaded: true } } }, 'committed with uploaded alone, no checksum');
  assert.deepEqual(payload, {
    appId: APP,
    eventId: EVENT_1,
    localizationId: LOCALIZATION_1,
    image: {
      id: IMAGE_ID,
      assetType: 'EVENT_DETAILS_PAGE',
      fileName: 'event-details-page.png',
      fileSize: 40,
      state: 'COMPLETE',
      width: 1080,
      height: 1920,
      templateUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/00/11/22/event-details-page.png/{w}x{h}bb.{f}',
    },
  });
  assert.ok(logs.includes(logs.find((line) => /^apple-appstore upload_app_event_image PUT 200 \d+ms$/.test(line))));
  for (const line of logs) assert.equal(line.includes('Signature'), false, 'the signed upload address is never logged');
});

test('upload_app_event_image refuses a wrong image, or a kind the localization already has, before anything is written', async () => {
  const cases = [
    [png(1920, 1080), /^The image is 1920x1080 pixels\. The event details page image must be a portrait JPEG or PNG with a 9:16 aspect ratio, from 1080x1920 to 2160x3840 pixels, such as 1080x1920/],
    [png(1000, 1778), /^The image is 1000x1778 pixels/],
    [jpeg(1080, 1921), /^The image is 1080x1921 pixels/],
    [Buffer.from('GIF89a this is not a png or a jpeg'), /^The file at image_url is not a JPEG or PNG image\./],
  ];
  for (const [image, message] of cases) {
    const { module, fetch, ctx } = setup(imageRoutes({}, image));
    const { payload } = await callTool(module, 'upload_app_event_image', UPLOAD_ARGS, ctx);
    assert.match(payload.error, message);
    assert.match(payload.error, /Nothing was changed\.$/);
    assert.ok(fetch.calls.every((call) => call.method === 'GET'), 'nothing but reads');
  }
  const big = setup(imageRoutes({}, jpeg(1080, 1920)));
  const ok = await callTool(big.module, 'upload_app_event_image', UPLOAD_ARGS, big.ctx);
  assert.equal(ok.isError, false, 'a JPEG of the right size is taken');
  assert.equal(big.fetch.calls[3].json.data.attributes.fileName, 'event-details-page.jpg');

  const card = setup(imageRoutes());
  const existing = await callTool(card.module, 'upload_app_event_image', { ...UPLOAD_ARGS, asset_type: 'EVENT_CARD' }, card.ctx);
  assert.match(existing.payload.error, /^The localization already has an EVENT_CARD image \(8c3f4d5e-3333-4eee-8fff-000000000001, state COMPLETE\)\. Delete it with delete_app_event_image first/);
  assert.equal(card.fetch.calls.length, 2, 'no download and no reservation');
});

test('upload_app_event_image removes the reservation when the host refuses the upload address, or Apple\'s upload server fails', async () => {
  const refused = setup(imageRoutes({
    'PUT /assets-example-030001/PurpleSource%2Fv4%2Fpart1': () => { throw refusal('only GET and HEAD go to an address that is not one of this connector\'s'); },
  }));
  const { payload, isError } = await callTool(refused.module, 'upload_app_event_image', UPLOAD_ARGS, refused.ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, undefined, 'a clear failure, not an unknown outcome');
  assert.match(payload.error, /^The host running this connector does not allow uploads to App Store Connect's upload server .* The reserved image 8c3f4d5e-3333-4eee-8fff-000000000002 was removed again, so nothing was left behind\. Add the image in App Store Connect instead \(Apps > the app > In-App Events > the event, in its locale: its event card or event details page media\); submit_app_event_for_review sends the event once it has both images\.$/);
  assert.deepEqual(refused.fetch.calls.slice(3).map((call) => call.method), ['POST', 'PUT', 'DELETE']);

  const failing = setup(imageRoutes({
    'PUT /assets-example-030001/PurpleSource%2Fv4%2Fpart2': () => new Response('denied', { status: 403 }),
    [`DELETE /v1/appEventScreenshots/${IMAGE_ID}`]: () => jsonResponse(500, { errors: [{ status: '500' }] }),
  }));
  const failed = await callTool(failing.module, 'upload_app_event_image', UPLOAD_ARGS, failing.ctx);
  assert.match(failed.payload.error, /^App Store Connect's upload server answered HTTP 403 for part 2 of 2\. The reserved image .* could not be removed: delete it with delete_app_event_image before trying again\. Or add the image in App Store Connect \(Apps > the app > In-App Events > the event, in its locale\)\.$/);

  const offsite = setup(imageRoutes({
    'POST /v1/appEventScreenshots': () => {
      const reserved = fixture(import.meta.url, 'event-image-reserved.json');
      reserved.data.attributes.uploadOperations[0].url = 'https://uploads.example.com/part1';
      return jsonResponse(201, reserved);
    },
  }));
  const elsewhere = await callTool(offsite.module, 'upload_app_event_image', UPLOAD_ARGS, offsite.ctx);
  assert.match(elsewhere.payload.error, /^App Store Connect returned an upload address for part 1 of 2 that is not an https address on apple\.com\./);
  assert.ok(!offsite.fetch.calls.some((call) => call.method === 'PUT'), 'nothing is uploaded anywhere else');
  assert.equal(offsite.fetch.calls.at(-1).method, 'DELETE');
});

test('on this package\'s own CLI host the upload to Apple\'s upload server is refused before it is sent, and the reservation is removed', async () => {
  // The CLI's guarded fetch keeps to the module contract: only downloads may
  // go to an address outside a connector's origins. Its API fetch, DNS and
  // download transport are replaced, so nothing touches the network.
  const { createGuardedFetch } = createRequire(import.meta.url)('../../../dist/host/index.js');
  const { module } = loadModuleFor(import.meta.url);
  const api = fakeFetch(imageRoutes());
  const outside = [];
  const fetch = createGuardedFetch({
    origins: module.origins,
    apiFetch: api,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async ({ url, method }) => {
      outside.push(`${method} ${url.origin}`);
      const body = png(1080, 1920);
      return { status: 200, headers: { 'content-type': 'image/png' }, body: (async function* chunks() { yield body; })(), destroy() {} };
    },
  });
  const { ctx } = makeContext({ credentials, accounts: { apps: [APP] }, fetch });
  const { payload, isError } = await callTool(module, 'upload_app_event_image', UPLOAD_ARGS, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, undefined, 'a clear failure: nothing is left behind');
  assert.deepEqual(outside, ['GET https://cdn.example.com'], 'only the image download went to an address outside the API');
  assert.deepEqual(api.calls.map((call) => `${call.method} ${call.path}`), [
    `GET /v1/appEventLocalizations/${LOCALIZATION_1}`,
    `GET /v1/apps/${APP}/appEvents`,
    'POST /v1/appEventScreenshots',
    `DELETE /v1/appEventScreenshots/${IMAGE_ID}`,
  ]);
  assert.match(payload.error, /^The host running this connector does not allow uploads to App Store Connect's upload server .* was removed again, so nothing was left behind\. Add the image in App Store Connect instead/);
});

test('the image and review tools say where event images go when the host refuses the upload', () => {
  const { module } = loadModuleFor(import.meta.url);
  const tool = (name) => module.tools.find((candidate) => candidate.name === name);
  assert.match(tool('upload_app_event_image').description, /A host that lets connectors send only downloads outside the API refuses that upload: the reservation is then removed, nothing is added, and the images are added in App Store Connect instead \(Apps > the app > In-App Events > the event\) before submit_app_event_for_review\.$/);
  assert.match(tool('submit_app_event_for_review').description, /both images first \(list_app_event_images shows them; add them in App Store Connect when upload_app_event_image cannot\)/);
  for (const name of ['upload_app_event_image', 'submit_app_event_for_review', 'list_apps']) assert.ok(tool(name).description.length <= 1024, name);
});

test('upload_app_event_image: an unclear reservation is an unknown outcome with one POST, and a failed processing is reported and removed', async () => {
  const broken = setup(imageRoutes({ 'POST /v1/appEventScreenshots': () => jsonResponse(503, { errors: [{ status: '503' }] }) }));
  const unknown = await callTool(broken.module, 'upload_app_event_image', UPLOAD_ARGS, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_app_event_images');
  assert.equal(broken.fetch.calls.filter((call) => call.method === 'POST').length, 1);

  const failedProcessing = setup(imageRoutes({
    [`GET /v1/appEventScreenshots/${IMAGE_ID}`]: () => {
      const image = fixture(import.meta.url, 'event-image-complete.json');
      image.data.attributes.assetDeliveryState = { state: 'FAILED', errors: [{ code: 'IMAGE_INCORRECT_DIMENSIONS', description: 'The dimensions of the image are not correct.' }] };
      return jsonResponse(200, image);
    },
  }));
  const failed = await callTool(failedProcessing.module, 'upload_app_event_image', UPLOAD_ARGS, failedProcessing.ctx);
  assert.match(failed.payload.error, /^App Store Connect could not process the image: IMAGE_INCORRECT_DIMENSIONS: The dimensions of the image are not correct\. The reserved image .* was removed again/);
  assert.equal(failedProcessing.fetch.calls.at(-1).method, 'DELETE');
});

test('upload_app_event_image returns while Apple is still processing, without waiting past its limit', async () => {
  let advance;
  const { module, context, fetch, ctx } = setup(imageRoutes({
    [`GET /v1/appEventScreenshots/${IMAGE_ID}`]: () => {
      advance(60_000); // the module's clock passes its waiting limit while Apple processes
      const image = fixture(import.meta.url, 'event-image-complete.json');
      image.data.attributes.assetDeliveryState = { state: 'UPLOAD_COMPLETE', errors: [] };
      return jsonResponse(200, image);
    },
  }));
  advance = controlClock(context);
  const { payload, isError } = await callTool(module, 'upload_app_event_image', UPLOAD_ARGS, ctx);
  assert.equal(isError, false);
  assert.equal(payload.image.state, 'UPLOAD_COMPLETE');
  assert.match(payload.note, /still processing the image/);
  assert.equal(fetch.calls.filter((call) => call.method === 'GET' && call.path === `/v1/appEventScreenshots/${IMAGE_ID}`).length, 1);
});

test('upload_app_event_image stops waiting when the call is cancelled, and says the image was uploaded', async () => {
  const controller = new AbortController();
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(imageRoutes({
    [`GET /v1/appEventScreenshots/${IMAGE_ID}`]: () => {
      controller.abort();
      const image = fixture(import.meta.url, 'event-image-complete.json');
      image.data.attributes.assetDeliveryState = { state: 'UPLOAD_COMPLETE', errors: [] };
      return jsonResponse(200, image);
    },
  }));
  const { ctx } = makeContext({ credentials, accounts: { apps: [APP] }, fetch, signal: controller.signal });
  const started = Date.now();
  const { payload, isError } = await callTool(module, 'upload_app_event_image', UPLOAD_ARGS, ctx);
  assert.ok(Date.now() - started < 2000, 'no wait after the cancel');
  assert.equal(isError, false);
  assert.match(payload.note, /^The image was uploaded, but its processing could not be followed \(The call was cancelled while waiting for App Store Connect\)\. Check it with list_app_event_images\.$/);
});

test('delete_app_event_image checks which event the image belongs to, then deletes it', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/appEventScreenshots/${IMAGE_ID}`]: () => jsonResponse(200, { data: { type: 'appEventScreenshots', id: IMAGE_ID, relationships: { appEventLocalization: { data: { type: 'appEventLocalizations', id: LOCALIZATION_1 } } } } }),
    [`GET /v1/appEventLocalizations/${LOCALIZATION_1}`]: () => jsonResponse(200, fixture(import.meta.url, 'event-localization-detail.json')),
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1 }] }),
    [`DELETE /v1/appEventScreenshots/${IMAGE_ID}`]: () => new Response(null, { status: 204 }),
  }));
  const { payload } = await callTool(module, 'delete_app_event_image', { app_id: APP, image_id: IMAGE_ID }, ctx);
  assert.deepEqual(payload, { deleted: true, appId: APP, imageId: IMAGE_ID });
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'DELETE']);
  assert.equal(fetch.calls[0].query.include, 'appEventLocalization');

  const open = setup(() => new Response(null, { status: 204 }), { accounts: null });
  await callTool(open.module, 'delete_app_event_image', { app_id: APP, image_id: IMAGE_ID }, open.ctx);
  assert.deepEqual(open.fetch.calls.map((call) => call.method), ['DELETE'], 'without a lock nothing is looked up');
});

const SUBMISSION_OPEN = '9d4a5b6c-4444-4aaa-8bbb-000000000001';
const SUBMISSION_NEW = '9d4a5b6c-4444-4aaa-8bbb-000000000002';

function reviewRoutes(extra = {}) {
  return routes({
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1, attributes: { referenceName: 'lunar-new-year-2027', eventState: 'DRAFT' } }] }),
    'GET /v1/reviewSubmissions': () => jsonResponse(200, { data: [] }),
    'POST /v1/reviewSubmissions': () => jsonResponse(201, fixture(import.meta.url, 'review-submission-created.json')),
    'POST /v1/reviewSubmissionItems': () => jsonResponse(201, { data: { type: 'reviewSubmissionItems', id: 'SUBMISSION_ITEM_EVENT_1', attributes: { state: 'READY_FOR_REVIEW' } } }),
    [`PATCH /v1/reviewSubmissions/${SUBMISSION_NEW}`]: () => jsonResponse(200, fixture(import.meta.url, 'review-submission-sent.json')),
    ...extra,
  });
}

test('submit_app_event_for_review starts a submission for the app, adds the event and sends it', async () => {
  const { module, fetch, ctx } = setup(reviewRoutes());
  const { payload, isError } = await callTool(module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    `GET /v1/apps/${APP}/appEvents`,
    'GET /v1/reviewSubmissions',
    'POST /v1/reviewSubmissions',
    'POST /v1/reviewSubmissionItems',
    `PATCH /v1/reviewSubmissions/${SUBMISSION_NEW}`,
  ]);
  assert.equal(fetch.calls[0].query['fields[appEvents]'], 'referenceName,eventState');
  assert.deepEqual(fetch.calls[1].query, {
    'filter[app]': APP,
    'filter[platform]': 'IOS',
    'filter[state]': 'READY_FOR_REVIEW,UNRESOLVED_ISSUES',
    'fields[reviewSubmissions]': 'platform,state',
    limit: '10',
  });
  assert.deepEqual(fetch.calls[2].json, { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP } } } } });
  assert.deepEqual(fetch.calls[3].json, {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: SUBMISSION_NEW } },
        appEvent: { data: { type: 'appEvents', id: EVENT_1 } },
      },
    },
  });
  assert.deepEqual(fetch.calls[4].json, { data: { type: 'reviewSubmissions', id: SUBMISSION_NEW, attributes: { submitted: true } } });
  assert.deepEqual(payload.submission, { id: SUBMISSION_NEW, platform: 'IOS', state: 'WAITING_FOR_REVIEW', submittedDate: '2026-11-22T03:10:00-08:00' });
  assert.equal(payload.referenceName, 'lunar-new-year-2027');
  assert.equal(payload.reusedSubmission, undefined);
});

test('submit_app_event_for_review reuses an open submission that holds only the event, and leaves one with other items alone', async () => {
  const holdsEvent = setup(reviewRoutes({
    'GET /v1/reviewSubmissions': () => jsonResponse(200, fixture(import.meta.url, 'review-submissions.json')),
    [`GET /v1/reviewSubmissions/${SUBMISSION_OPEN}/items`]: () => jsonResponse(200, { data: [{ type: 'reviewSubmissionItems', id: 'SUBMISSION_ITEM_EVENT_1', attributes: { state: 'READY_FOR_REVIEW' }, relationships: { appEvent: { data: { type: 'appEvents', id: EVENT_1 } } } }] }),
    [`PATCH /v1/reviewSubmissions/${SUBMISSION_OPEN}`]: () => jsonResponse(200, fixture(import.meta.url, 'review-submission-sent.json')),
  }));
  const resent = await callTool(holdsEvent.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, holdsEvent.ctx);
  assert.equal(resent.isError, false, JSON.stringify(resent.payload));
  assert.deepEqual(holdsEvent.fetch.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'PATCH'], 'the event is in it already: no new submission, no new item');
  assert.equal(holdsEvent.fetch.calls[2].query.include, 'appEvent,appStoreVersion');
  assert.equal(resent.payload.reusedSubmission, true);

  const empty = setup(reviewRoutes({
    'GET /v1/reviewSubmissions': () => jsonResponse(200, fixture(import.meta.url, 'review-submissions.json')),
    [`GET /v1/reviewSubmissions/${SUBMISSION_OPEN}/items`]: () => jsonResponse(200, { data: [] }),
    [`PATCH /v1/reviewSubmissions/${SUBMISSION_OPEN}`]: () => jsonResponse(200, fixture(import.meta.url, 'review-submission-sent.json')),
  }));
  await callTool(empty.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, empty.ctx);
  assert.deepEqual(empty.fetch.calls.map((call) => `${call.method} ${call.path}`).slice(3), ['POST /v1/reviewSubmissionItems', `PATCH /v1/reviewSubmissions/${SUBMISSION_OPEN}`]);
  assert.equal(empty.fetch.calls[3].json.data.relationships.reviewSubmission.data.id, SUBMISSION_OPEN);

  const busy = setup(reviewRoutes({
    'GET /v1/reviewSubmissions': () => jsonResponse(200, fixture(import.meta.url, 'review-submissions.json')),
    [`GET /v1/reviewSubmissions/${SUBMISSION_OPEN}/items`]: () => jsonResponse(200, fixture(import.meta.url, 'review-submission-items-version.json')),
  }));
  const refused = await callTool(busy.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, busy.ctx);
  assert.match(refused.payload.error, /^App 1234567890 has an open review submission \(9d4a5b6c-4444-4aaa-8bbb-000000000001\) that also holds app version 4\.3: sending it would send those to App Review too\. .*Nothing was sent\.$/);
  assert.ok(busy.fetch.calls.every((call) => call.method === 'GET'), 'nothing is written');
});

test('submit_app_event_for_review refuses an event that is not the app\'s or already in review, and reports a refused step accurately', async () => {
  const inReview = setup(reviewRoutes({
    [`GET /v1/apps/${APP}/appEvents`]: () => jsonResponse(200, { data: [{ type: 'appEvents', id: EVENT_1, attributes: { eventState: 'WAITING_FOR_REVIEW' } }] }),
  }));
  const waiting = await callTool(inReview.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, inReview.ctx);
  assert.match(waiting.payload.error, /^The in-app event .* is WAITING_FOR_REVIEW: only a draft, a rejected event or one ready for review can be sent to App Review\. Nothing was sent\.$/);
  assert.equal(inReview.fetch.calls.length, 1);

  const otherApp = setup(reviewRoutes());
  const outside = await callTool(otherApp.module, 'submit_app_event_for_review', { app_id: '999', event_id: EVENT_1 }, otherApp.ctx);
  assert.match(outside.payload.error, /The app 999 is not among the apps chosen/);
  assert.equal(otherApp.fetch.calls.length, 0);

  const incomplete = setup(reviewRoutes({ 'POST /v1/reviewSubmissionItems': () => jsonResponse(409, { errors: [{ status: '409', code: 'STATE_ERROR' }] }) }));
  const notAdded = await callTool(incomplete.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, incomplete.ctx);
  assert.match(notAdded.payload.error, /^App Store Connect refused to add the event: .*\(HTTP 409\)\. The review submission 9d4a5b6c-4444-4aaa-8bbb-000000000002 started for it stays open and empty; the next call reuses it\.$/);
  assert.equal(notAdded.payload.status, 409);
  assert.equal(incomplete.fetch.calls.filter((call) => call.method === 'PATCH').length, 0);

  const unsent = setup(reviewRoutes({ [`PATCH /v1/reviewSubmissions/${SUBMISSION_NEW}`]: () => jsonResponse(409, { errors: [{ status: '409' }] }) }));
  const notSent = await callTool(unsent.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, unsent.ctx);
  assert.match(notSent.payload.error, /\(HTTP 409\)\. The event is in review submission 9d4a5b6c-4444-4aaa-8bbb-000000000002, which was not sent: .*submit_app_event_for_review again/);
  assert.doesNotMatch(notSent.payload.error, /Nothing was changed/);

  const broken = setup(reviewRoutes({ [`PATCH /v1/reviewSubmissions/${SUBMISSION_NEW}`]: () => jsonResponse(502, { errors: [{ status: '502' }] }) }));
  const unknown = await callTool(broken.module, 'submit_app_event_for_review', { app_id: APP, event_id: EVENT_1 }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_app_events');
  assert.equal(broken.fetch.calls.filter((call) => call.method === 'PATCH').length, 1, 'never sent twice');
});

test('api_get and api_request sign their requests and keep to the chosen apps', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: [] }));
  const description = module.tools.find((tool) => tool.name === 'api_get').description;
  assert.match(description, /a resource read or changed by its own id, such as \/v1\/appStoreVersions\/<id>, is refused then/);
  for (const tool of module.tools) assert.doesNotMatch(tool.description, /api_get \/v1\/(inAppPurchasePriceSchedules|subscriptions)\//, `${tool.name} sends nothing to an unreachable path`);
  const read = await callTool(module, 'api_get', { path: `/v1/apps/${APP}/appStoreVersions`, query: { limit: 1 } }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { data: [] } });
  assert.equal(decodeJwt(fetch.calls[0].headers.authorization).valid, true);

  const filtered = await callTool(module, 'api_get', { path: '/v1/reviewSubmissions', query: { 'filter[app]': APP } }, ctx);
  assert.equal(filtered.isError, false);
  const post = await callTool(module, 'api_request', {
    method: 'POST',
    path: '/v1/reviewSubmissions',
    json: { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP } } } } },
  }, ctx);
  assert.equal(post.isError, false);
  assert.equal(fetch.calls.length, 3);

  const otherApp = await callTool(module, 'api_get', { path: '/v1/apps/999/appEvents' }, ctx);
  assert.match(otherApp.payload.error, /The app 999 is not among the apps chosen/);
  const noApp = await callTool(module, 'api_request', { method: 'PATCH', path: `/v1/appEvents/${EVENT_1}`, json: { data: { relationships: { app: { data: { id: APP } } } } } }, ctx);
  assert.match(noApp.payload.error, /names none of the apps chosen for this connection/);
  const smuggled = await callTool(module, 'api_request', {
    method: 'POST',
    path: '/v1/customerReviewResponses',
    json: { data: { type: 'customerReviewResponses', attributes: { responseBody: 'x' }, relationships: { app: { data: { type: 'apps', id: APP } }, review: { data: { type: 'customerReviews', id: 'elsewhere' } } } } },
  }, ctx);
  assert.match(smuggled.payload.error, /names none of the apps chosen for this connection/, 'a body may name only the app');
  const outside = await callTool(module, 'api_get', { path: '/admin/users' }, setup(() => jsonResponse(200, {}), { accounts: null }).ctx);
  assert.match(outside.payload.error, /must start with \/v1\/, \/v2\/ or \/v3\//);
  assert.equal(fetch.calls.length, 3);

  const broken = setup(() => jsonResponse(502, { errors: [{ status: '502' }] }), { accounts: null });
  const unknown = await callTool(broken.module, 'api_request', { method: 'DELETE', path: '/v1/appEvents/x' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('a rate limit carries retryAfter, and a rejected key says which credentials to check', async () => {
  const limited = setup(() => jsonResponse(429, { errors: [{ status: '429', code: 'RATE_LIMIT_EXCEEDED' }] }, { 'retry-after': '30' }));
  const rate = await callTool(limited.module, 'list_apps', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);
  assert.equal(rate.payload.status, 429);

  const rejected = setup(() => jsonResponse(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED' }] }));
  const unauthorized = await callTool(rejected.module, 'list_apps', {}, rejected.ctx);
  assert.match(unauthorized.payload.error, /Check that the App Store Connect key ID, App Store Connect issuer ID and App Store Connect private key are correct and still active/);
});

test('log lines carry no credentials and no arguments', async () => {
  const { module, ctx, logs } = setup(routes({
    [`GET /v1/apps/${APP}/customerReviews`]: () => jsonResponse(200, fixture(import.meta.url, 'reviews.json')),
    'POST /v1/customerReviewResponses': () => jsonResponse(201, fixture(import.meta.url, 'review-response.json')),
  }));
  await callTool(module, 'respond_to_review', { app_id: APP, review_id: REVIEW_1, response_body: 'secret reply text' }, ctx);
  assert.ok(logs.length >= 2);
  for (const line of logs) {
    assert.match(line, /^apple-appstore respond_to_review (GET|POST) \d+ \d+ms$/);
    for (const secret of ['ABC123DEFG', credentials.issuerid, 'PRIVATE KEY', 'secret reply text', REVIEW_1]) assert.equal(line.includes(secret), false);
  }
});
