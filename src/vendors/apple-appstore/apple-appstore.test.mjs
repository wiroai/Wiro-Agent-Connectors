import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

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
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, accounts, fetch });
  return { module, fetch, ctx, logs };
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
    { id: '1234567890', name: 'Acme Photo', bundleId: 'com.example.photo', sku: 'ACME-PHOTO-1', primaryLocale: 'en-US' },
    { id: '1234567891', name: 'Acme Video', bundleId: 'com.example.video', sku: 'ACME-VIDEO-1', primaryLocale: 'tr' },
  ]);

  await callTool(module, 'list_apps', { limit: 2, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.cursor, 'Mg.AJUmP2s');
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

test('list_subscriptions reads each group with its introductory offers and says whether there is a free trial', async () => {
  const { module, fetch, ctx } = setup(routes({
    [`GET /v1/apps/${APP}/subscriptionGroups`]: () => jsonResponse(200, fixture(import.meta.url, 'subscription-groups.json')),
    'GET /v1/subscriptionGroups/21000001/subscriptions': () => jsonResponse(200, fixture(import.meta.url, 'subscriptions.json')),
  }));
  const { payload } = await callTool(module, 'list_subscriptions', { app_id: APP }, ctx);
  assert.equal(fetch.calls[1].query.include, 'introductoryOffers');
  assert.equal(payload.hasFreeTrial, true);
  assert.deepEqual(payload.groups[0].subscriptions[0], {
    id: '6400000001',
    name: 'Pro Weekly',
    productId: 'com.example.photo.pro.weekly',
    period: 'ONE_WEEK',
    state: 'APPROVED',
    groupLevel: 2,
    familySharable: false,
    introductoryOffers: [
      { offerMode: 'FREE_TRIAL', duration: 'THREE_DAYS', numberOfPeriods: 1, territories: 2 },
      { offerMode: 'PAY_AS_YOU_GO', duration: 'ONE_WEEK', numberOfPeriods: 1, territories: 1 },
    ],
  });
  assert.deepEqual(payload.groups[0].subscriptions[1].introductoryOffers, []);
});

test('list_in_app_purchases trims each purchase', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'in-app-purchases.json')));
  const { payload } = await callTool(module, 'list_in_app_purchases', { app_id: APP, type: 'CONSUMABLE' }, ctx);
  assert.equal(fetch.calls[0].query['filter[inAppPurchaseType]'], 'CONSUMABLE');
  assert.deepEqual(payload.inAppPurchases, [{ id: '6500000001', name: '50 Credits', productId: 'com.example.photo.credits50', type: 'CONSUMABLE', state: 'APPROVED', familySharable: false }]);
});

test('api_get and api_request sign their requests and keep to the chosen apps', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: [] }));
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
