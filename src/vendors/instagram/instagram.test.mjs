import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const SYSTEM_TOKEN = 'EAASystemUserToken456';
const LOGIN_TOKEN = 'IGAALoginToken789';
const PAGE_TOKEN = 'EAAPageTokenForBakery0001';
const IG = '17841400000000001';
const LOGIN_IG = '17841400000000009';
const CONTAINER = '18000000000000001';

const f = (name) => fixture(import.meta.url, name);

function router(routes) {
  return (request) => {
    const respond = routes[`${request.method} ${request.origin}${request.path}`] ?? routes[`${request.method} ${request.path}`];
    if (!respond) throw new Error(`unexpected ${request.method} ${request.url}`);
    return typeof respond === 'function' ? respond(request) : jsonResponse(200, respond);
  };
}

function formOf(request) {
  return Object.fromEntries(new URLSearchParams(Buffer.from(request.body).toString('utf8')));
}

function setup(handler, { credentials = { systemusertoken: SYSTEM_TOKEN }, accounts = { accounts: [IG] } } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, context, fetch, ctx, logs };
}

function fastWaits(context) {
  const advance = controlClock(context);
  context.setTimeout = (fn, ms) => {
    advance(ms);
    return setTimeout(fn, 0);
  };
}

const LINKED = { 'GET https://graph.facebook.com/v26.0/me/accounts': f('me-accounts.json') };
const PUBLISHED = {
  [`GET /v26.0/${CONTAINER}`]: f('container-finished.json'),
  [`POST /v26.0/${IG}/media_publish`]: f('media-publish.json'),
  'GET /v26.0/17900000000000001': f('media-details.json'),
};

test('list_accounts finds the accounts linked to the system user\'s Pages, and never returns a Page token', async () => {
  const { module, fetch, ctx } = setup(router(LINKED), { accounts: null });
  const { payload, text } = await callTool(module, 'list_accounts', {}, ctx);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${SYSTEM_TOKEN}`);
  assert.equal(fetch.calls[0].query.fields, 'id,name,tasks,access_token,instagram_business_account{id,username,name}');
  assert.deepEqual(payload.accounts, [
    { id: IG, username: 'example.bakery', name: 'Example Bakery', page_id: '1001', page_name: 'Example Bakery', can_publish: true },
    { id: '17841400000000003', username: 'example.studio', name: 'Example Studio', page_id: '1003', page_name: 'Example Studio', can_publish: false },
  ]);
  assert.doesNotMatch(text, /EAAPageToken/);
  assert.ok(payload.nextCursor);

  const [picker] = module.accountPickers;
  assert.deepEqual(JSON.parse(JSON.stringify(picker)), {
    key: 'accounts',
    label: 'Instagram accounts',
    description: 'The Instagram professional accounts the agent may publish to and read.',
    multiple: true,
    tool: 'list_accounts',
    idField: 'id',
    nameField: 'username',
    legacyField: 'accountid',
  });
  assert.deepEqual(payload.accounts.map((item) => [item[picker.idField], item[picker.nameField]])[0], [IG, 'example.bakery']);

  const locked = setup(router(LINKED), { accounts: { accounts: ['17841400000000003'] } });
  const chosen = await callTool(locked.module, 'list_accounts', {}, locked.ctx);
  assert.deepEqual(chosen.payload.accounts.map((item) => item.id), ['17841400000000003']);
});

test('with Instagram Login, list_accounts returns the account that signed in, read on graph.instagram.com', async () => {
  const { module, fetch, ctx } = setup(router({ 'GET https://graph.instagram.com/v26.0/me': f('me-login.json') }), {
    credentials: { access_token: LOGIN_TOKEN },
    accounts: null,
  });
  const { payload } = await callTool(module, 'list_accounts', {}, ctx);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${LOGIN_TOKEN}`);
  assert.equal(fetch.calls[0].query.fields, 'user_id,username,name,account_type,profile_picture_url');
  assert.deepEqual(payload, { accounts: [{ id: LOGIN_IG, username: 'example.shop', name: 'Example Shop', account_type: 'BUSINESS' }] });
});

test('publish_image creates a container with the linked Page token, waits for it, and publishes it once', async () => {
  const { module, fetch, ctx } = setup(router({ ...LINKED, [`POST /v26.0/${IG}/media`]: f('container-create.json'), ...PUBLISHED }));
  const { payload, isError } = await callTool(module, 'publish_image', {
    image_url: 'https://cdn.example.com/loaf.jpg',
    caption: 'Fresh today\n#bakery',
    alt_text: 'A loaf of bread',
    user_tags: [{ username: 'alex.reader', x: 0.5, y: 0.4 }],
    collaborators: ['example.cafe'],
  }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.origin}${call.path}`), [
    'GET https://graph.facebook.com/v26.0/me/accounts',
    `POST https://graph.facebook.com/v26.0/${IG}/media`,
    `GET https://graph.facebook.com/v26.0/${CONTAINER}`,
    `POST https://graph.facebook.com/v26.0/${IG}/media_publish`,
    'GET https://graph.facebook.com/v26.0/17900000000000001',
  ]);
  assert.equal(fetch.calls[1].headers.authorization, `Bearer ${PAGE_TOKEN}`);
  assert.deepEqual(formOf(fetch.calls[1]), {
    image_url: 'https://cdn.example.com/loaf.jpg',
    caption: 'Fresh today\n#bakery',
    alt_text: 'A loaf of bread',
    user_tags: '[{"username":"alex.reader","x":0.5,"y":0.4}]',
    collaborators: '["example.cafe"]',
  });
  assert.deepEqual(formOf(fetch.calls[3]), { creation_id: CONTAINER });
  assert.deepEqual(payload, {
    account_id: IG,
    container_id: CONTAINER,
    media_id: '17900000000000001',
    permalink: 'https://www.instagram.com/p/DAbCdEfGhIj/',
    timestamp: '2026-11-21T18:00:00+0000',
    media_type: 'IMAGE',
    media_product_type: 'FEED',
  });

  // The Page token is kept for the next call.
  await callTool(module, 'publish_image', { image_url: 'https://cdn.example.com/loaf.jpg' }, ctx);
  assert.equal(fetch.calls.filter((call) => call.path === '/v26.0/me/accounts').length, 1);
});

test('with Instagram Login, calls go to graph.instagram.com for the account that signed in', async () => {
  const routes = {
    [`POST https://graph.instagram.com/v26.0/${LOGIN_IG}/media`]: f('container-create.json'),
    [`GET https://graph.instagram.com/v26.0/${CONTAINER}`]: f('container-finished.json'),
    [`POST https://graph.instagram.com/v26.0/${LOGIN_IG}/media_publish`]: f('media-publish.json'),
    'GET https://graph.instagram.com/v26.0/17900000000000001': f('media-details.json'),
  };
  const { module, fetch, ctx } = setup(router(routes), {
    credentials: { access_token: LOGIN_TOKEN, accountid: LOGIN_IG, igusername: 'example.shop' },
    accounts: null,
  });
  const { payload } = await callTool(module, 'publish_image', { image_url: 'https://cdn.example.com/loaf.jpg' }, ctx);
  assert.equal(payload.account_id, LOGIN_IG);
  for (const call of fetch.calls) {
    assert.equal(call.origin, 'https://graph.instagram.com');
    assert.equal(call.headers.authorization, `Bearer ${LOGIN_TOKEN}`);
  }

  const locked = setup(router(routes), { credentials: { access_token: LOGIN_TOKEN, accountid: LOGIN_IG }, accounts: { accounts: [LOGIN_IG] } });
  const ok = await callTool(locked.module, 'publish_image', { image_url: 'https://cdn.example.com/loaf.jpg' }, locked.ctx);
  assert.equal(ok.isError, false);
});

test('a Reel still processing at the end of the wait is left as a container, then publish_container publishes it once', async () => {
  let ready = false;
  const routes = {
    ...LINKED,
    [`POST /v26.0/${IG}/media`]: f('container-create.json'),
    [`GET /v26.0/${CONTAINER}`]: () => jsonResponse(200, ready ? f('container-finished.json') : f('container-in-progress.json')),
    [`POST /v26.0/${IG}/media_publish`]: f('media-publish.json'),
    'GET /v26.0/17900000000000001': f('media-details.json'),
  };
  const { module, context, fetch, ctx } = setup(router(routes));
  fastWaits(context);
  const first = await callTool(module, 'publish_reel', { video_url: 'https://cdn.example.com/reel.mp4', caption: 'Shaping a baguette', thumb_offset: 1500, wait_seconds: 10 }, ctx);
  assert.equal(first.isError, false);
  assert.equal(first.payload.status, 'IN_PROGRESS');
  assert.equal(first.payload.container_id, CONTAINER);
  assert.match(first.payload.next, /publish_container/);
  assert.deepEqual(formOf(fetch.calls[1]), { media_type: 'REELS', video_url: 'https://cdn.example.com/reel.mp4', caption: 'Shaping a baguette', share_to_feed: 'true', thumb_offset: '1500' });
  const polls = fetch.calls.filter((call) => call.path === `/v26.0/${CONTAINER}`).length;
  assert.ok(polls >= 3 && polls <= 5, `polled every 3 seconds within 10: ${polls}`);
  assert.equal(fetch.calls.some((call) => call.path.endsWith('/media_publish')), false);

  ready = true;
  const second = await callTool(module, 'publish_container', { container_id: CONTAINER }, ctx);
  assert.equal(second.payload.media_id, '17900000000000001');
  assert.equal(fetch.calls.filter((call) => call.path.endsWith('/media_publish')).length, 1);
});

test('a container Instagram could not process is reported and never published; a published one is not published again', async () => {
  const failed = setup(router({ ...LINKED, [`POST /v26.0/${IG}/media`]: f('container-create.json'), [`GET /v26.0/${CONTAINER}`]: f('container-error.json') }));
  const error = await callTool(failed.module, 'publish_story', { video_url: 'https://cdn.example.com/story.webm' }, failed.ctx);
  assert.equal(error.isError, true);
  assert.match(error.payload.error, /Instagram could not process the media \(Error: 2207026: The video format is not supported.*\)\..*Nothing was published\./);
  assert.deepEqual(formOf(failed.fetch.calls[1]), { media_type: 'STORIES', video_url: 'https://cdn.example.com/story.webm' });
  assert.equal(failed.fetch.calls.some((call) => call.path.endsWith('/media_publish')), false);

  const done = setup(router({ ...LINKED, [`GET /v26.0/${CONTAINER}`]: { status_code: 'PUBLISHED', id: CONTAINER } }));
  const again = await callTool(done.module, 'publish_container', { container_id: CONTAINER }, done.ctx);
  assert.equal(again.payload.status, 'PUBLISHED');
  assert.equal(done.fetch.calls.some((call) => call.path.endsWith('/media_publish')), false);
});

test('publish_carousel creates the slides, leaves out a refused one, and publishes the carousel', async () => {
  let next = 0;
  const routes = {
    ...LINKED,
    [`POST /v26.0/${IG}/media`]: (request) => {
      const body = formOf(request);
      if (body.media_type === 'CAROUSEL') return jsonResponse(200, { id: '18000000000000099' });
      if (body.image_url === 'https://cdn.example.com/broken.jpg') return jsonResponse(400, { error: { message: 'Only photo or video can be accepted as media type.', code: 9004 } });
      return jsonResponse(200, { id: `1800000000000001${++next}` });
    },
    'GET /v26.0/18000000000000011': f('container-finished.json'),
    'GET /v26.0/18000000000000012': f('container-finished.json'),
    'GET /v26.0/18000000000000099': f('container-finished.json'),
    [`POST /v26.0/${IG}/media_publish`]: f('media-publish.json'),
    'GET /v26.0/17900000000000001': f('media-details.json'),
  };
  const { module, fetch, ctx } = setup(router(routes));
  const { payload, isError } = await callTool(module, 'publish_carousel', {
    items: [
      { url: 'https://cdn.example.com/a.jpg', alt_text: 'First' },
      { url: 'https://cdn.example.com/broken.jpg' },
      { url: 'https://cdn.example.com/b.mp4' },
    ],
    caption: 'Three steps',
  }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(formOf(fetch.calls[1]), { image_url: 'https://cdn.example.com/a.jpg', alt_text: 'First', is_carousel_item: 'true' });
  assert.deepEqual(formOf(fetch.calls[3]), { media_type: 'VIDEO', video_url: 'https://cdn.example.com/b.mp4', is_carousel_item: 'true' });
  const carousel = fetch.calls.find((call) => call.method === 'POST' && formOf(call).media_type === 'CAROUSEL');
  assert.deepEqual(formOf(carousel), { media_type: 'CAROUSEL', children: '18000000000000011,18000000000000012', caption: 'Three steps' });
  assert.equal(payload.slides, 2);
  assert.equal(payload.skipped[0].item, 2);
  assert.match(payload.skipped[0].error, /Only photo or video can be accepted/);
  assert.equal(payload.media_id, '17900000000000001');
});

test('publish_carousel hands back the slide containers when they are still processing, and finishes from them later', async () => {
  let ready = false;
  const routes = {
    ...LINKED,
    'GET /v26.0/18000000000000011': f('container-finished.json'),
    'GET /v26.0/18000000000000012': () => jsonResponse(200, ready ? f('container-finished.json') : f('container-in-progress.json')),
    [`POST /v26.0/${IG}/media`]: { id: '18000000000000099' },
    'GET /v26.0/18000000000000099': f('container-finished.json'),
    [`POST /v26.0/${IG}/media_publish`]: f('media-publish.json'),
    'GET /v26.0/17900000000000001': f('media-details.json'),
  };
  const { module, context, fetch, ctx } = setup(router(routes));
  fastWaits(context);
  const children = ['18000000000000011', '18000000000000012'];
  const waiting = await callTool(module, 'publish_carousel', { child_container_ids: children, caption: 'Later', wait_seconds: 6 }, ctx);
  assert.equal(waiting.payload.status, 'IN_PROGRESS');
  assert.deepEqual(waiting.payload.child_container_ids, children);
  assert.equal(fetch.calls.some((call) => call.method === 'POST'), false);

  ready = true;
  const done = await callTool(module, 'publish_carousel', { child_container_ids: children, caption: 'Later' }, ctx);
  assert.equal(done.payload.media_id, '17900000000000001');

  const both = await callTool(module, 'publish_carousel', { child_container_ids: children, items: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }] }, ctx);
  assert.match(both.payload.error, /Give items or child_container_ids, not both/);
});

test('the account lock and the linked Page are checked before anything is published', async () => {
  const outside = setup(router(LINKED));
  const refused = await callTool(outside.module, 'publish_image', { account_id: '17841400000000003', image_url: 'https://cdn.example.com/a.jpg' }, outside.ctx);
  assert.match(refused.payload.error, /The Instagram account 17841400000000003 is not among the Instagram accounts chosen for this connection/);
  assert.equal(outside.fetch.calls.length, 0);

  const unlinked = setup(router(LINKED), { accounts: { accounts: ['17841400000000777'] } });
  const missing = await callTool(unlinked.module, 'publish_image', { image_url: 'https://cdn.example.com/a.jpg' }, unlinked.ctx);
  assert.match(missing.payload.error, /None of the Facebook Pages assigned to this system user is linked to the Instagram account 17841400000000777/);
  assert.equal(unlinked.fetch.calls.some((call) => call.method === 'POST'), false);

  const tags = setup(router(LINKED));
  const many = await callTool(tags.module, 'publish_image', { image_url: 'https://cdn.example.com/a.jpg', caption: Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(' ') }, tags.ctx);
  assert.match(many.payload.error, /31 hashtags; Instagram allows 30/);
  assert.equal(tags.fetch.calls.length, 0);
});

test('get_media_insights reads each post, keeps an item\'s error, and marks missing metrics as null', async () => {
  const { module, fetch, ctx } = setup(router({
    ...LINKED,
    [`GET /v26.0/${IG}/media`]: f('media-list.json'),
    'GET /v26.0/17900000000000002/insights': f('media-insights.json'),
    'GET /v26.0/17900000000000003/insights': () => jsonResponse(400, { error: { message: '(#100) Incompatible metric for this media', code: 100 } }),
  }));
  const { payload } = await callTool(module, 'get_media_insights', { limit: 2 }, ctx);
  assert.equal(fetch.calls[2].query.metric, 'reach,views,saved,shares,comments,likes,total_interactions');
  assert.deepEqual(payload.media[0].metrics, { reach: 2100, views: 3400, saved: 15, shares: null, comments: null, likes: 120, total_interactions: 150 });
  assert.equal(payload.media[0].permalink, 'https://www.instagram.com/p/DAbCdEfGhIk/');
  assert.match(payload.media[1].error, /Incompatible metric/);
});

test('get_account_insights totals the range, splits follows from unfollows, and adds the follower count', async () => {
  const { module, fetch, ctx } = setup(router({
    ...LINKED,
    [`GET /v26.0/${IG}/insights`]: (request) => jsonResponse(200, request.query.metric === 'follows_and_unfollows' ? f('follows-insights.json') : f('account-insights.json')),
    [`GET /v26.0/${IG}`]: { followers_count: 5120, media_count: 230, id: IG },
  }));
  const { payload } = await callTool(module, 'get_account_insights', { since: '2026-10-01', until: '2026-10-28' }, ctx);
  const [, totals, follows] = fetch.calls;
  assert.equal(totals.query.metric, 'reach,views,total_interactions,accounts_engaged');
  assert.equal(totals.query.metric_type, 'total_value');
  assert.equal(totals.query.since, String(Date.parse('2026-10-01T00:00:00Z') / 1000));
  assert.equal(totals.query.until, String(Date.parse('2026-10-29T00:00:00Z') / 1000));
  assert.equal(follows.query.breakdown, 'follow_type');
  assert.deepEqual(payload.totals, {
    reach: 8200,
    views: 21000,
    total_interactions: 950,
    accounts_engaged: 610,
    followed: 74,
    unfollowed: 12,
    net_follower_change: 62,
    followers_count: 5120,
    media_count: 230,
  });
});

test('comments: list, reply, hide and delete send what Instagram expects', async () => {
  const { module, fetch, ctx } = setup(router({
    ...LINKED,
    'GET /v26.0/17900000000000002/comments': f('comments.json'),
    'POST /v26.0/17850000000000001/replies': { id: '17850000000000002' },
    'POST /v26.0/17850000000000001': { success: true },
    'DELETE /v26.0/17850000000000001': { success: true },
  }));
  const list = await callTool(module, 'list_comments', { media_id: '17900000000000002' }, ctx);
  assert.deepEqual(list.payload.comments, [{ id: '17850000000000001', text: 'Do you ship to Leeds?', username: 'alex.reader', timestamp: '2026-11-20T09:30:00+0000', like_count: 1, hidden: false }]);

  const reply = await callTool(module, 'add_comment', { comment_id: '17850000000000001', message: 'Yes, we do!' }, ctx);
  assert.deepEqual(formOf(fetch.calls[2]), { message: 'Yes, we do!' });
  assert.deepEqual(reply.payload, { comment_id: '17850000000000002', account_id: IG, reply_to: '17850000000000001' });

  const hide = await callTool(module, 'hide_comment', { comment_id: '17850000000000001', hide: true }, ctx);
  assert.deepEqual(formOf(fetch.calls[3]), { hide: 'true' });
  assert.deepEqual(hide.payload, { comment_id: '17850000000000001', hidden: true, success: true });

  const removed = await callTool(module, 'delete_comment', { comment_id: '17850000000000001' }, ctx);
  assert.equal(fetch.calls[4].method, 'DELETE');
  assert.deepEqual(removed.payload, { comment_id: '17850000000000001', deleted: true });

  const neither = await callTool(module, 'add_comment', { message: 'Hi' }, ctx);
  assert.match(neither.payload.error, /Give media_id or comment_id/);
});

test('get_publishing_limit and list_media read what an agent needs', async () => {
  const { module, fetch, ctx } = setup(router({
    ...LINKED,
    [`GET /v26.0/${IG}/content_publishing_limit`]: f('publishing-limit.json'),
    [`GET /v26.0/${IG}/media`]: f('media-list.json'),
  }));
  const limit = await callTool(module, 'get_publishing_limit', {}, ctx);
  assert.deepEqual(limit.payload, { account_id: IG, quota_usage: 3, quota_total: 100, quota_duration_seconds: 86400 });
  const media = await callTool(module, 'list_media', { limit: 2 }, ctx);
  assert.equal(media.payload.media[1].media_product_type, 'REELS');
  await callTool(module, 'list_media', { cursor: media.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[3].query.after, 'QVFIUmQ');
});

test('errors: an unclear publish names its check tool after one publish request, and a 429 carries retryAfter', async () => {
  const broken = setup(router({
    ...LINKED,
    [`POST /v26.0/${IG}/media`]: f('container-create.json'),
    [`GET /v26.0/${CONTAINER}`]: f('container-finished.json'),
    [`POST /v26.0/${IG}/media_publish`]: () => jsonResponse(503, { error: { message: 'Service temporarily unavailable', code: 2 } }),
  }));
  const unknown = await callTool(broken.module, 'publish_image', { image_url: 'https://cdn.example.com/a.jpg' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_media');
  assert.equal(broken.fetch.calls.filter((call) => call.path.endsWith('/media_publish')).length, 1);

  const limited = setup(router({ 'GET /v26.0/me/accounts': () => jsonResponse(429, { error: { message: 'Too many calls' } }, { 'retry-after': '60' }) }), { accounts: null });
  const rate = await callTool(limited.module, 'list_accounts', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 60);
});

test('api_get and api_request use the chosen account\'s token and host, and never reach tokens', async () => {
  const { module, fetch, ctx } = setup(router({ ...LINKED, [`GET /v26.0/${IG}/tags`]: { data: [] } }));
  const read = await callTool(module, 'api_get', { path: `/v26.0/${IG}/tags` }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { data: [] } });
  assert.equal(fetch.calls[1].origin, 'https://graph.facebook.com');
  assert.equal(fetch.calls[1].headers.authorization, `Bearer ${PAGE_TOKEN}`);
  const token = await callTool(module, 'api_get', { path: '/v26.0/me/accounts', query: { fields: 'access_token' } }, ctx);
  assert.match(token.payload.error, /Tokens and app secrets are not available/);

  const login = setup(router({ [`POST https://graph.instagram.com/v26.0/17900000000000002`]: { success: true } }), {
    credentials: { access_token: LOGIN_TOKEN, accountid: LOGIN_IG },
    accounts: { accounts: [LOGIN_IG] },
  });
  const write = await callTool(login.module, 'api_request', { method: 'POST', path: '/v26.0/17900000000000002', json: { comment_enabled: false } }, login.ctx);
  assert.equal(write.payload.status, 200);
  assert.equal(login.fetch.calls[0].origin, 'https://graph.instagram.com');
  assert.equal(login.fetch.calls[0].headers.authorization, `Bearer ${LOGIN_TOKEN}`);
});

test('log lines carry no tokens or arguments', async () => {
  const { module, ctx, logs } = setup(router({ ...LINKED, [`POST /v26.0/${IG}/media`]: f('container-create.json'), ...PUBLISHED }));
  await callTool(module, 'publish_image', { image_url: 'https://cdn.example.com/a.jpg', caption: 'Private launch caption' }, ctx);
  assert.ok(logs.length >= 4);
  for (const line of logs) {
    assert.match(line, /^instagram publish_image (GET|POST) \d{3} \d+ms$/);
    for (const secret of [SYSTEM_TOKEN, PAGE_TOKEN, 'Private launch', 'cdn.example.com']) assert.equal(line.includes(secret), false);
  }
});
