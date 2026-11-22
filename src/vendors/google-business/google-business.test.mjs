import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.a0AfB_byCexampleBusinessToken0123456789';
const credentials = { access_token: TOKEN };
const REVIEWS = 'https://mybusiness.googleapis.com';
const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com';
const INFO = 'https://mybusinessbusinessinformation.googleapis.com';
const LOCKED = { accounts: ['111'], locations: ['9001'] };
const REVIEW = 'AbFvOqm4xReviewOne';
const fx = (name) => fixture(import.meta.url, name);

function setup(handler, accounts = LOCKED) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

/** A fake Business Profile: routes by origin, method and path. */
function business(overrides = {}) {
  const routes = {
    [`GET ${ACCOUNTS}/v1/accounts`]: () => jsonResponse(200, fx('accounts.json')),
    [`GET ${INFO}/v1/accounts/111/locations`]: () => jsonResponse(200, fx('locations-111.json')),
    [`GET ${INFO}/v1/accounts/222/locations`]: () => jsonResponse(200, {}),
    [`GET ${INFO}/v1/accounts/333/locations`]: () => jsonResponse(200, fx('locations-333.json')),
    [`GET ${REVIEWS}/v4/accounts/111/locations/9001/reviews`]: () => jsonResponse(200, fx('reviews.json')),
    [`GET ${REVIEWS}/v4/accounts/111/locations/9001/reviews/${REVIEW}`]: () => jsonResponse(200, fx('reviews.json').reviews[0]),
    [`PUT ${REVIEWS}/v4/accounts/111/locations/9001/reviews/${REVIEW}/reply`]: () => jsonResponse(200, fx('reply.json')),
    [`DELETE ${REVIEWS}/v4/accounts/111/locations/9001/reviews/${REVIEW}/reply`]: () => jsonResponse(200, {}),
    ...overrides,
  };
  return (request) => {
    const route = routes[`${request.method} ${request.origin}${request.path}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.url}`);
    return route(request);
  };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

test('list_accounts lists the Business Profile accounts and is the accounts picker', async () => {
  const { module, fetch, ctx } = setup(business(), null);
  const picker = module.accountPickers.find((item) => item.key === 'accounts');
  assert.deepEqual({ ...picker }, {
    key: 'accounts',
    label: 'Business Profile accounts',
    description: 'The Business Profile accounts (your own, or a business group) the agent may read. It works only on the locations you choose.',
    multiple: true,
    tool: 'list_accounts',
    idField: 'id',
    nameField: 'name',
    legacyField: 'accountid',
  });
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `${ACCOUNTS}/v1/accounts?pageSize=20`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.accounts[0], { id: '111', name: 'Ayşe Example', type: 'personal', role: 'primary_owner', verification_state: 'unverified', vetted_state: 'not_vetted' });
  assert.deepEqual(payload.accounts.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [['111', 'Ayşe Example'], ['222', 'Coffee Stops Group'], ['333', 'Bakery Group']]);

  const locked = setup(business());
  const chosen = await callTool(locked.module, 'list_accounts', {}, locked.ctx);
  assert.deepEqual(chosen.payload.accounts.map((item) => item.id), ['111']);
});

test('list_locations goes through every account page by page, skipping accounts without locations, and is the locations picker', async () => {
  const { module, fetch, ctx } = setup(business(), null);
  const picker = module.accountPickers.find((item) => item.key === 'locations');
  assert.equal(picker.tool, 'list_locations');
  assert.equal(picker.legacyField, 'locationmappings');

  const first = await callTool(module, picker.tool, {}, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].url, `${ACCOUNTS}/v1/accounts?pageSize=20`);
  const read = new URL(fetch.calls[1].url);
  assert.equal(read.origin + read.pathname, `${INFO}/v1/accounts/111/locations`);
  assert.equal(read.searchParams.get('readMask'), 'name,title,storeCode,storefrontAddress,phoneNumbers,websiteUri,categories,openInfo,metadata');
  assert.equal(read.searchParams.get('pageSize'), '100');
  assert.deepEqual(first.payload.locations[0], {
    id: '9001',
    title: 'Coffee Stop Moda',
    account_id: '111',
    store_code: 'MODA-1',
    address: 'Moda Cd. No: 1, Kadıköy, İstanbul, 34710, TR',
    phone: '+90 216 000 00 00',
    website: 'https://coffee.example.com/moda',
    category: 'Coffee shop',
    status: 'open',
    maps_url: 'https://maps.google.com/maps?cid=1234567890',
    review_url: 'https://search.google.com/local/writereview?placeid=ChIJexample1',
    place_id: 'ChIJexample1',
  });
  assert.deepEqual(first.payload.locations.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [['9001', 'Coffee Stop Moda'], ['9002', 'Coffee Stop Kadıköy']]);
  assert.ok(first.payload.nextCursor);

  const second = await callTool(module, picker.tool, { cursor: first.payload.nextCursor }, ctx);
  const paths = fetch.calls.slice(2).map((call) => `${call.origin}${call.path}`);
  assert.deepEqual(paths, [`${ACCOUNTS}/v1/accounts`, `${INFO}/v1/accounts/222/locations`, `${INFO}/v1/accounts/333/locations`]);
  assert.deepEqual(second.payload.locations.map((item) => [item.id, item.account_id]), [['9101', '333']]);
  assert.equal(second.payload.nextCursor, undefined);
});

test('with a choice, list_locations shows only the chosen locations and stops once it has shown them all', async () => {
  const { module, fetch, ctx } = setup(business());
  const { payload } = await callTool(module, 'list_locations', {}, ctx);
  assert.deepEqual(fetch.calls.map((call) => call.path), ['/v1/accounts', '/v1/accounts/111/locations']);
  assert.deepEqual(payload.locations.map((item) => [item.id, item.account_id]), [['9001', '111']]);
  assert.equal(payload.nextCursor, undefined, 'every chosen location was shown');

  // One account, chosen or not: still only the chosen locations.
  const other = await callTool(module, 'list_locations', { account_id: '333' }, ctx);
  assert.equal(other.isError, false, other.payload.error);
  assert.deepEqual(other.payload.locations, []);

  const none = setup(business(), {});
  const empty = await callTool(none.module, 'list_locations', {}, none.ctx);
  assert.deepEqual(empty.payload.locations, []);
  assert.match(empty.payload.note, /No location is chosen/);
  assert.equal(none.fetch.calls.length, 0);
});

test('locations chosen without their accounts are found in every account and work with the review tools', async () => {
  // Locations only, or a location in a business group that was not chosen: the location choice is the lock.
  for (const accounts of [{ locations: ['9101'] }, { accounts: ['111'], locations: ['9001', '9101'] }]) {
    const { module, fetch, ctx } = setup(business({
      [`GET ${REVIEWS}/v4/accounts/333/locations/9101/reviews`]: () => jsonResponse(200, fx('reviews.json')),
    }), accounts);
    let cursor;
    const found = [];
    for (let round = 0; round < 5; round++) {
      const { payload, isError } = await callTool(module, 'list_locations', cursor ? { cursor } : {}, ctx);
      assert.equal(isError, false, payload.error);
      found.push(...payload.locations.map((item) => [item.id, item.account_id]));
      cursor = payload.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(found.filter(([id]) => id === '9101'), [['9101', '333']]);
    assert.ok(found.every(([id]) => accounts.locations.includes(id)));

    const reviews = await callTool(module, 'list_reviews', { location_id: '9101', account_id: '333' }, ctx);
    assert.equal(reviews.isError, false, reviews.payload.error);
    assert.equal(fetch.calls.at(-1).path, '/v4/accounts/333/locations/9101/reviews');
  }
  const only = setup(business(), { locations: ['9001'] });
  const missing = await callTool(only.module, 'get_review', { location_id: '9001', review_id: REVIEW }, only.ctx);
  assert.match(missing.payload.error, /Give account_id: the location's account id, from list_locations/);
  const given = await callTool(only.module, 'get_review', { location_id: '9001', account_id: '111', review_id: REVIEW }, only.ctx);
  assert.equal(given.isError, false, given.payload.error);
});

test('list_reviews reads newest edits first and trims each review, translation and reply state included', async () => {
  const { module, fetch, ctx } = setup(business());
  const { payload, isError } = await callTool(module, 'list_reviews', { location_id: '9001' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `${REVIEWS}/v4/accounts/111/locations/9001/reviews?pageSize=50&orderBy=updateTime+desc`);
  assert.equal(payload.location_id, '9001');
  assert.equal(payload.account_id, '111');
  assert.equal(payload.average_rating, 4.4);
  assert.equal(payload.total_review_count, 87);
  assert.equal(payload.newest, '2026-10-17T08:51:00Z');
  assert.deepEqual(payload.reviews[0], {
    id: REVIEW,
    rating: 2,
    reviewer: 'Mehmet Y.',
    anonymous: false,
    comment: 'Kahve soğuktu, 20 dakika bekledik.',
    translated: 'The coffee was cold, we waited 20 minutes.',
    created: '2026-10-17T08:51:00Z',
    updated: '2026-10-17T08:51:00Z',
    answered: false,
  });
  assert.deepEqual(payload.reviews[1], {
    id: 'AbFvOqm4xReviewTwo',
    rating: 5,
    anonymous: true,
    created: '2026-10-15T10:00:00Z',
    updated: '2026-10-16T09:30:00Z',
    answered: true,
    reply: { comment: 'Thank you!', updated: '2026-10-16T12:00:00Z', state: 'APPROVED' },
  });
  assert.equal(payload.reviews[2].media, 1);
  assert.ok(payload.nextCursor);

  await callTool(module, 'list_reviews', { location_id: '9001', cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.pageToken, 'ACc6IdExampleNextPage');
});

test('since keeps newer reviews and stops paging at it; only_unanswered drops answered ones', async () => {
  const { module, fetch, ctx } = setup(business());
  const newer = await callTool(module, 'list_reviews', { location_id: '9001', since: '2026-10-16T00:00:00Z', only_unanswered: true }, ctx);
  assert.deepEqual(newer.payload.reviews.map((review) => review.id), [REVIEW]);
  assert.equal(newer.payload.nextCursor, undefined, 'the page reached reviews older than since');
  const unanswered = await callTool(module, 'list_reviews', { location_id: '9001', only_unanswered: true }, ctx);
  assert.deepEqual(unanswered.payload.reviews.map((review) => review.id), [REVIEW, 'AbFvOqm4xReviewThree']);
  assert.ok(unanswered.payload.nextCursor);
  const bad = await callTool(module, 'list_reviews', { location_id: '9001', since: '2026-99-99T00:00:00Z' }, ctx);
  assert.match(bad.payload.error, /since is not a valid time/);
  assert.equal(fetch.calls.length, 2);
});

test('a location outside the choice is refused before any request; the account must be known', async () => {
  const { module, fetch, ctx } = setup(business());
  const location = await callTool(module, 'list_reviews', { location_id: '9002' }, ctx);
  assert.match(location.payload.error, /The location 9002 is not among the locations chosen for this connection\. Use one of: 9001\. Nothing was sent\./);
  const elsewhere = await callTool(module, 'reply_to_review', { location_id: '9002', account_id: '111', review_id: REVIEW, comment: 'Thanks' }, ctx);
  assert.match(elsewhere.payload.error, /The location 9002 is not among the locations chosen/);
  assert.equal(fetch.calls.length, 0);

  const open = setup(business(), null);
  const unknownAccount = await callTool(open.module, 'list_reviews', { location_id: '9001' }, open.ctx);
  assert.match(unknownAccount.payload.error, /Give account_id/);
  const given = await callTool(open.module, 'list_reviews', { location_id: '9001', account_id: '111' }, open.ctx);
  assert.equal(given.isError, false);

  const two = setup(business(), { accounts: ['111', '222'], locations: ['9001'] });
  const ambiguous = await callTool(two.module, 'get_review', { location_id: '9001', review_id: REVIEW }, two.ctx);
  assert.match(ambiguous.payload.error, /Give account_id/);
  assert.equal(two.fetch.calls.length, 0);
});

test('get_review, reply_to_review and delete_review_reply', async () => {
  const { module, fetch, ctx } = setup(business());
  const review = await callTool(module, 'get_review', { location_id: '9001', review_id: REVIEW }, ctx);
  assert.equal(fetch.calls[0].url, `${REVIEWS}/v4/accounts/111/locations/9001/reviews/${REVIEW}`);
  assert.equal(review.payload.comment, 'Kahve soğuktu, 20 dakika bekledik.');

  const reply = await callTool(module, 'reply_to_review', { location_id: '9001', review_id: REVIEW, comment: '  Mehmet, soğuk kahve için kusura bakma.  ' }, ctx);
  assert.equal(fetch.calls[1].method, 'PUT');
  assert.equal(fetch.calls[1].url, `${REVIEWS}/v4/accounts/111/locations/9001/reviews/${REVIEW}/reply`);
  assert.deepEqual(fetch.calls[1].json, { comment: 'Mehmet, soğuk kahve için kusura bakma.' });
  assert.deepEqual(reply.payload, {
    posted: true,
    location_id: '9001',
    account_id: '111',
    review_id: REVIEW,
    bytes: Buffer.byteLength('Mehmet, soğuk kahve için kusura bakma.'),
    state: 'PENDING',
    updated: '2026-10-17T09:14:03Z',
  });

  const deleted = await callTool(module, 'delete_review_reply', { location_id: '9001', review_id: REVIEW }, ctx);
  assert.equal(fetch.calls[2].method, 'DELETE');
  assert.deepEqual(deleted.payload, { deleted: true, location_id: '9001', account_id: '111', review_id: REVIEW });
});

test('a reply over 4,096 bytes is refused before sending, counting two-byte letters', async () => {
  const { module, fetch, ctx } = setup(business());
  const { payload } = await callTool(module, 'reply_to_review', { location_id: '9001', review_id: REVIEW, comment: 'ç'.repeat(2049) }, ctx);
  assert.match(payload.error, /The reply is 4098 bytes; Google allows 4096/);
  assert.equal(fetch.calls.length, 0);
});

test('errors: a project Google has not approved, a disabled API, a missing review', async () => {
  const quota = setup(() => jsonResponse(429, fx('error-429-quota.json')), null);
  const notApproved = await callTool(quota.module, 'list_accounts', {}, quota.ctx);
  assert.equal(notApproved.payload.status, 429);
  assert.match(notApproved.payload.error, /rate limit reached \(HTTP 429\).*has not yet approved the Business Profile APIs/);

  const disabled = setup(() => jsonResponse(403, fx('error-403-disabled.json')), null);
  const off = await callTool(disabled.module, 'list_locations', { account_id: '111' }, disabled.ctx);
  assert.match(off.payload.error, /refused the request \(HTTP 403\): My Business Business Information API has not been used in project/);

  const missing = setup(() => jsonResponse(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }));
  const gone = await callTool(missing.module, 'get_review', { location_id: '9001', review_id: REVIEW }, missing.ctx);
  assert.match(gone.payload.error, /found no such review/);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'Too many requests' } }, { 'retry-after': '15' }));
  const rate = await callTool(limited.module, 'list_reviews', { location_id: '9001' }, limited.ctx);
  assert.equal(rate.payload.retryAfter, 15);
});

test('a reply or a deletion without a clear answer is sent once and reported as unknown', async () => {
  const broken = setup(() => jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.' } }));
  const reply = await callTool(broken.module, 'reply_to_review', { location_id: '9001', review_id: REVIEW, comment: 'Thanks!' }, broken.ctx);
  assert.equal(reply.payload.outcome, 'unknown');
  assert.equal(reply.payload.check, 'get_review');
  assert.equal(broken.fetch.calls.length, 1);

  const lost = setup(() => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  });
  const deletion = await callTool(lost.module, 'delete_review_reply', { location_id: '9001', review_id: REVIEW }, lost.ctx);
  assert.equal(deletion.payload.outcome, 'unknown');
  assert.equal(lost.fetch.calls.length, 1);
});

test('api_get and api_request reach the other APIs, only for chosen accounts and locations', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { name: 'locations/9001', title: 'Coffee Stop Moda' }));
  const location = await callTool(module, 'api_get', { origin: INFO, path: '/v1/locations/9001', query: { readMask: 'name,title' } }, ctx);
  assert.equal(location.isError, false, location.payload.error);
  assert.equal(fetch.calls[0].url, `${INFO}/v1/locations/9001?readMask=name%2Ctitle`);
  const metrics = await callTool(module, 'api_get', { origin: 'https://businessprofileperformance.googleapis.com', path: '/v1/locations/9001:fetchMultiDailyMetricsTimeSeries', query: { dailyMetrics: ['CALL_CLICKS', 'WEBSITE_CLICKS'] } }, ctx);
  assert.equal(metrics.isError, false, metrics.payload.error);
  const posts = await callTool(module, 'api_get', { path: '/v4/accounts/111/locations/9001/localPosts' }, ctx);
  assert.equal(posts.isError, false);
  assert.equal(fetch.calls[2].origin, REVIEWS);
  const categories = await callTool(module, 'api_get', { origin: INFO, path: '/v1/categories', query: { regionCode: 'TR', languageCode: 'tr', view: 'BASIC' } }, ctx);
  assert.equal(categories.isError, false, 'reference data needs no account');
  const account = await callTool(module, 'api_get', { origin: ACCOUNTS, path: '/v1/accounts/111' }, ctx);
  assert.equal(account.isError, false, 'an account-wide read of a chosen account');
  assert.equal(fetch.calls.length, 5);

  const otherLocation = await callTool(module, 'api_request', { method: 'PATCH', origin: INFO, path: '/v1/locations/9002', query: { updateMask: 'title' }, json: { title: 'x' } }, ctx);
  assert.match(otherLocation.payload.error, /The location 9002 is not among the locations chosen/);
  const nothing = await callTool(module, 'api_get', { origin: ACCOUNTS, path: '/v1/accounts' }, ctx);
  assert.match(nothing.payload.error, /names none of the accounts or locations chosen/);
  const otherAccount = await callTool(module, 'api_get', { origin: ACCOUNTS, path: '/v1/accounts/222' }, ctx);
  assert.match(otherAccount.payload.error, /The account 222 is not among the accounts chosen/);
  const allLocations = await callTool(module, 'api_get', { origin: INFO, path: '/v1/accounts/111/locations' }, ctx);
  assert.match(allLocations.payload.error, /listed with list_locations/);
  const accountWrite = await callTool(module, 'api_request', { method: 'POST', origin: INFO, path: '/v1/accounts/111/locations', json: { title: 'New place' } }, ctx);
  assert.match(accountWrite.payload.error, /a change must name a chosen location/);
  const wildcard = await callTool(module, 'api_get', { path: '/v4/accounts/111/locations/-/reviews' }, ctx);
  assert.match(wildcard.payload.error, /numeric ids/);
  const wrongBase = await callTool(module, 'api_get', { origin: INFO, path: '/v4/accounts/111' }, ctx);
  assert.match(wrongBase.payload.error, /start with \/v1\//);
  assert.equal(fetch.calls.length, 5);

  const broken = setup(() => jsonResponse(500, { error: { message: 'internal' } }));
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: '/v4/accounts/111/locations/9001/localPosts', json: { summary: 'Open late on Friday' } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('locationNames in a body are checked however they are sent: as json, as text, or under their field name', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { locationReviews: [] }));
  const path = '/v4/accounts/111/locations:batchGetReviews';
  const other = ['accounts/111/locations/9002'];
  for (const args of [
    { path, json: { locationNames: other } },
    { path, json: { location_names: other } },
    { path, json: { locationNames: ['accounts/111/locations/9001'], location_names: other } },
    { path, json: { locationNames: other }, content_type: 'application/json' },
    // As text, on a path that names a chosen location: the body is read before it is sent.
    { path: '/v4/accounts/111/locations/9001/localPosts', body: JSON.stringify({ locationNames: other }), content_type: 'application/json' },
    { path: '/v4/accounts/111/locations/9001/localPosts', body: JSON.stringify({ location_names: other }), content_type: 'application/json; charset=utf-8' },
  ]) {
    const { payload } = await callTool(module, 'api_request', { method: 'POST', ...args }, ctx);
    assert.match(payload.error, /The location 9002 is not among the locations chosen/, JSON.stringify(args));
  }
  // As text on the account path, the request names no chosen location the guard can see: refused as well.
  for (const key of ['locationNames', 'location_names']) {
    const { payload } = await callTool(module, 'api_request', { method: 'POST', path, body: JSON.stringify({ [key]: other }), content_type: 'application/json' }, ctx);
    assert.match(payload.error, /Nothing was sent\./);
  }
  const malformed = await callTool(module, 'api_request', { method: 'POST', path, json: { locationNames: ['locations/9002'] } }, ctx);
  assert.match(malformed.payload.error, /must list names such as accounts\/111\/locations\/9001/);
  const notAList = await callTool(module, 'api_request', { method: 'POST', path, json: { location_names: 'accounts/111/locations/9002' } }, ctx);
  assert.match(notAList.payload.error, /must be a list of names/);
  const notJson = await callTool(module, 'api_request', { method: 'POST', path: '/v4/accounts/111/locations/9001/localPosts', body: 'summary=hello', content_type: 'application/x-www-form-urlencoded' }, ctx);
  assert.match(notJson.payload.error, /take a JSON body/);
  // A raw body naming a chosen location on a location path: what is sent is the JSON that was read.
  const raw = await callTool(module, 'api_request', { method: 'POST', path: '/v4/accounts/111/locations/9001/localPosts', body: '{"summary": "Open late",\n "summary": "Open late on Friday"}', content_type: 'application/json' }, ctx);
  assert.equal(raw.isError, false, raw.payload.error);
  assert.equal(fetch.calls.length, 1);
  assert.equal(new TextDecoder().decode(fetch.calls[0].body), '{"summary":"Open late on Friday"}');
  const chosen = await callTool(module, 'api_request', { method: 'POST', path, json: { locationNames: ['accounts/111/locations/9001'] } }, ctx);
  assert.equal(chosen.isError, false, chosen.payload.error);
  assert.equal(fetch.calls.length, 2);
});

test('admins, invitations, transfers and notification settings are never changed, with or without a choice', async () => {
  for (const accounts of [LOCKED, null]) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, {}), accounts);
    for (const args of [
      { method: 'POST', origin: ACCOUNTS, path: '/v1/accounts/111/admins', json: { admin: 'someone@example.com', role: 'OWNER' } },
      { method: 'POST', origin: ACCOUNTS, path: '/v1/locations/9001/admins', json: { admin: 'someone@example.com', role: 'OWNER' } },
      { method: 'PATCH', path: '/v4/accounts/111/admins/abc', json: { role: 'MANAGER' } },
      { method: 'DELETE', path: '/v4/accounts/111/locations/9001/admins/abc' },
      { method: 'POST', origin: ACCOUNTS, path: '/v1/locations/9001:transfer', json: { destinationAccount: 'accounts/999' } },
      { method: 'POST', path: '/v4/accounts/111/locations/9001:transfer', json: { toAccount: 'accounts/999' } },
      { method: 'POST', origin: ACCOUNTS, path: '/v1/accounts/111/invitations/xyz:accept' },
      { method: 'PUT', path: '/v4/accounts/111/notifications', json: { topicName: 'projects/p/topics/t' } },
    ]) {
      const { payload } = await callTool(module, 'api_request', args, ctx);
      assert.match(payload.error, /are not made here: make them in Business Profile Manager\. Nothing was sent\./, `${args.method} ${args.path}`);
    }
    const admins = await callTool(module, 'api_get', { origin: ACCOUNTS, path: '/v1/accounts/111/admins' }, ctx);
    assert.equal(admins.isError, false, 'reading the admins changes nothing');
    assert.equal(fetch.calls.length, 1);
  }
});

test('log lines carry no token and no review text', async () => {
  const { module, ctx, logs } = setup(business());
  await callTool(module, 'reply_to_review', { location_id: '9001', review_id: REVIEW, comment: 'A very private reply' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^google-business reply_to_review PUT 200 \d+ms$/);
  assert.equal(logs[0].includes(TOKEN), false);
});
