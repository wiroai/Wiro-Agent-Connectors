import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const TOKEN = 'THAAThreadsToken123';
const USER = '25000000000000001';
const CONTAINER = '18100000000000001';

const f = (name) => fixture(import.meta.url, name);

function router(routes) {
  return (request) => {
    const respond = routes[`${request.method} ${request.path}`];
    if (!respond) throw new Error(`unexpected ${request.method} ${request.url}`);
    return typeof respond === 'function' ? respond(request) : jsonResponse(200, respond);
  };
}

function formOf(request) {
  return Object.fromEntries(new URLSearchParams(Buffer.from(request.body).toString('utf8')));
}

function setup(handler, credentials = { access_token: TOKEN, threadsuserid: USER, threadsusername: 'example.bakery' }) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts: null, fetch });
  return { module, context, fetch, ctx, logs };
}

function fastWaits(context) {
  const advance = controlClock(context);
  context.setTimeout = (fn, ms) => {
    advance(ms);
    return setTimeout(fn, 0);
  };
}

const PUBLISHED = {
  [`GET /v1.0/${CONTAINER}`]: f('container-finished.json'),
  [`POST /v1.0/${USER}/threads_publish`]: f('publish.json'),
  'GET /v1.0/18200000000000001': f('post-details.json'),
};

test('publish_post sends a text post with its options in the Authorization header, waits, publishes once and returns the permalink', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v1.0/${USER}/threads`]: f('container-create.json'), ...PUBLISHED }));
  const { payload, isError } = await callTool(module, 'publish_post', {
    text: 'New loaf day 🍞 https://bakery.example.com',
    reply_control: 'accounts_you_follow',
    topic_tag: 'Baking',
    link_attachment: 'https://bakery.example.com',
    allowlisted_country_codes: ['US', 'CA'],
  }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    `POST /v1.0/${USER}/threads`,
    `GET /v1.0/${CONTAINER}`,
    `POST /v1.0/${USER}/threads_publish`,
    'GET /v1.0/18200000000000001',
  ]);
  for (const call of fetch.calls) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fetch.calls.some((call) => call.url.includes(TOKEN)), false, 'the token never goes in a URL');
  assert.deepEqual(formOf(fetch.calls[0]), {
    media_type: 'TEXT',
    text: 'New loaf day 🍞 https://bakery.example.com',
    reply_control: 'accounts_you_follow',
    topic_tag: 'Baking',
    allowlisted_country_codes: 'US,CA',
    link_attachment: 'https://bakery.example.com',
  });
  assert.deepEqual(formOf(fetch.calls[2]), { creation_id: CONTAINER });
  assert.deepEqual(payload, {
    username: 'example.bakery',
    container_id: CONTAINER,
    media_id: '18200000000000001',
    permalink: 'https://www.threads.com/@example.bakery/post/DAbCdEfGhIj',
    shortcode: 'DAbCdEfGhIj',
    timestamp: '2026-11-21T18:00:00+0000',
    media_type: 'TEXT_POST',
  });
});

test('text over 500 as Threads counts it (emojis by their bytes) is refused before anything is sent', async () => {
  const { module, fetch, ctx } = setup(router({}));
  const emojis = '🍞'.repeat(126); // 126 x 4 = 504
  const { payload, isError } = await callTool(module, 'publish_post', { text: emojis }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /counts 504 characters as Threads counts them/);
  const fits = await callTool(module, 'publish_post', { text: 'a'.repeat(501) }, ctx);
  assert.match(fits.payload.error, /counts 501/);
  const attachment = await callTool(module, 'publish_post', { media: [{ url: 'https://cdn.example.com/a.jpg' }], link_attachment: 'https://a.example' }, ctx);
  assert.match(attachment.payload.error, /link_attachment and text_attachment work on text-only posts/);
  const empty = await callTool(module, 'publish_post', {}, ctx);
  assert.match(empty.payload.error, /A text-only post needs text/);
  assert.equal(fetch.calls.length, 0);
});

test('an image post carries its alt text; a video still processing is left as a container for publish_container', async () => {
  const image = setup(router({ [`POST /v1.0/${USER}/threads`]: f('container-create.json'), ...PUBLISHED }));
  await callTool(image.module, 'publish_post', { text: 'Fresh', media: [{ url: 'https://cdn.example.com/loaf.png', alt_text: 'A loaf' }], is_made_with_ai: false }, image.ctx);
  assert.deepEqual(formOf(image.fetch.calls[0]), { media_type: 'IMAGE', image_url: 'https://cdn.example.com/loaf.png', alt_text: 'A loaf', text: 'Fresh', is_made_with_ai: 'false' });

  let ready = false;
  const video = setup(router({
    [`POST /v1.0/${USER}/threads`]: f('container-create.json'),
    [`GET /v1.0/${CONTAINER}`]: () => jsonResponse(200, ready ? f('container-finished.json') : f('container-in-progress.json')),
    [`POST /v1.0/${USER}/threads_publish`]: f('publish.json'),
    'GET /v1.0/18200000000000001': f('post-details.json'),
  }));
  fastWaits(video.context);
  const waiting = await callTool(video.module, 'publish_post', { media: [{ url: 'https://cdn.example.com/clip.mov' }], wait_seconds: 9 }, video.ctx);
  assert.equal(waiting.payload.status, 'IN_PROGRESS');
  assert.equal(waiting.payload.container_id, CONTAINER);
  assert.equal(formOf(video.fetch.calls[0]).media_type, 'VIDEO');
  assert.equal(video.fetch.calls.some((call) => call.path.endsWith('/threads_publish')), false);

  ready = true;
  const done = await callTool(video.module, 'publish_container', { container_id: CONTAINER }, video.ctx);
  assert.equal(done.payload.media_id, '18200000000000001');
  assert.equal(video.fetch.calls.filter((call) => call.path.endsWith('/threads_publish')).length, 1);
});

test('a container Threads could not process is explained and never published', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v1.0/${USER}/threads`]: f('container-create.json'), [`GET /v1.0/${CONTAINER}`]: f('container-error.json') }));
  const { payload, isError } = await callTool(module, 'publish_post', { media: [{ url: 'https://cdn.example.com/clip.mp4' }] }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /Threads could not process the media: the video could not be processed\..*Nothing was published\./);
  assert.equal(fetch.calls.some((call) => call.path.endsWith('/threads_publish')), false);
});

test('a carousel creates its items without text, then one carousel container with the text and options', async () => {
  let next = 0;
  const { module, fetch, ctx } = setup(router({
    [`POST /v1.0/${USER}/threads`]: (request) => jsonResponse(200, { id: formOf(request).media_type === 'CAROUSEL' ? CONTAINER : `1810000000000010${++next}` }),
    'GET /v1.0/18100000000000101': f('container-finished.json'),
    'GET /v1.0/18100000000000102': f('container-finished.json'),
    ...PUBLISHED,
  }));
  const { payload } = await callTool(module, 'publish_post', {
    text: 'Two loaves',
    media: [{ url: 'https://cdn.example.com/a.jpg', alt_text: 'First' }, { url: 'https://cdn.example.com/b.mp4' }],
    reply_control: 'everyone',
  }, ctx);
  assert.deepEqual(formOf(fetch.calls[0]), { media_type: 'IMAGE', image_url: 'https://cdn.example.com/a.jpg', alt_text: 'First', is_carousel_item: 'true' });
  assert.deepEqual(formOf(fetch.calls[1]), { media_type: 'VIDEO', video_url: 'https://cdn.example.com/b.mp4', is_carousel_item: 'true' });
  const carousel = fetch.calls.find((call) => call.method === 'POST' && formOf(call).media_type === 'CAROUSEL');
  assert.deepEqual(formOf(carousel), { media_type: 'CAROUSEL', children: '18100000000000101,18100000000000102', text: 'Two loaves', reply_control: 'everyone' });
  assert.equal(payload.items, 2);
  assert.equal(payload.media_id, '18200000000000001');
});

test('without the stored profile id, the profile is read from /me once and kept', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET /v1.0/me': f('me.json'),
    [`GET /v1.0/${USER}/threads`]: f('threads-list.json'),
  }), { access_token: TOKEN });
  const first = await callTool(module, 'list_posts', { limit: 2 }, ctx);
  assert.equal(fetch.calls[0].query.fields, 'id,username');
  assert.deepEqual(first.payload.posts[1], {
    id: '18200000000000003',
    text: 'Which loaf next week?',
    media_type: 'TEXT_POST',
    permalink: 'https://www.threads.com/@example.bakery/post/DAbCdEfGhIl',
    timestamp: '2026-11-18T08:00:00+0000',
    shortcode: 'DAbCdEfGhIl',
  });
  await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls.filter((call) => call.path === '/v1.0/me').length, 1);
  assert.equal(fetch.calls[2].query.after, 'QVFIUmg');
  assert.equal(fetch.calls[2].query.limit, '2');
});

test('replies: list the conversation, hide one, and delete a post', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET /v1.0/18200000000000003/conversation': f('replies.json'),
    'POST /v1.0/18300000000000001/manage_reply': { success: true },
    'DELETE /v1.0/18200000000000003': { success: true, deleted_id: '18200000000000003' },
  }));
  const list = await callTool(module, 'list_replies', { media_id: '18200000000000003', all: true }, ctx);
  assert.equal(fetch.calls[0].query.reverse, 'false');
  assert.equal(list.payload.replies[0].hide_status, 'NOT_HUSHED');
  const hide = await callTool(module, 'hide_reply', { reply_id: '18300000000000001', hide: true }, ctx);
  assert.deepEqual(formOf(fetch.calls[1]), { hide: 'true' });
  assert.deepEqual(hide.payload, { reply_id: '18300000000000001', hidden: true, success: true });
  const removed = await callTool(module, 'delete_post', { media_id: '18200000000000003' }, ctx);
  assert.deepEqual(removed.payload, { media_id: '18200000000000003', deleted: true, deleted_id: '18200000000000003' });
});

test('a reply in one of the profile\'s threads goes through a container with reply_to_id', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v1.0/${USER}/threads`]: f('container-create.json'), ...PUBLISHED }));
  await callTool(module, 'publish_post', { text: 'Thanks!', reply_to_id: '18300000000000001' }, ctx);
  assert.deepEqual(formOf(fetch.calls[0]), { media_type: 'TEXT', text: 'Thanks!', reply_to_id: '18300000000000001' });
});

test('insights: posts carry their metrics and errors; the profile adds up its views and reads the followers', async () => {
  const posts = setup(router({
    'GET /v1.0/18200000000000002/insights': f('post-insights.json'),
    'GET /v1.0/18200000000000009/insights': () => jsonResponse(400, { error: { message: 'Insights are not available for reposts', code: 100 } }),
  }));
  const read = await callTool(posts.module, 'get_post_insights', { media_ids: ['18200000000000002', '18200000000000009'] }, posts.ctx);
  assert.deepEqual(read.payload.posts[0].metrics, { views: 920, likes: 41, replies: 6, reposts: 2, quotes: 1, shares: null });
  assert.match(read.payload.posts[1].error, /not available for reposts/);

  const profile = setup(router({
    [`GET /v1.0/${USER}/threads_insights`]: (request) => jsonResponse(200, request.query.metric === 'followers_count' ? f('followers.json') : f('profile-insights.json')),
  }));
  const totals = await callTool(profile.module, 'get_profile_insights', { since: '2026-10-01', until: '2026-10-02' }, profile.ctx);
  assert.equal(profile.fetch.calls[0].query.since, String(Date.parse('2026-10-01T00:00:00Z') / 1000));
  assert.equal(profile.fetch.calls[0].query.until, String(Date.parse('2026-10-03T00:00:00Z') / 1000));
  assert.deepEqual(totals.payload.totals, { views: 200, likes: 310, replies: 44, reposts: 12, quotes: 3, followers_count: 2480 });
  assert.deepEqual(totals.payload.link_clicks, [{ link: 'https://bakery.example.com/menu', clicks: 17 }]);
  const early = await callTool(profile.module, 'get_profile_insights', { since: '2024-01-01', until: '2024-02-01' }, profile.ctx);
  assert.match(early.payload.error, /no profile insights before 2024-04-13/);
});

test('get_publishing_limit reads the three quotas', async () => {
  const { module, ctx } = setup(router({ [`GET /v1.0/${USER}/threads_publishing_limit`]: f('publishing-limit.json') }));
  const { payload } = await callTool(module, 'get_publishing_limit', {}, ctx);
  assert.deepEqual(payload, {
    posts: { used: 4, total: 250, window_seconds: 86400 },
    replies: { used: 10, total: 1000, window_seconds: 86400 },
    deletions: { used: 0, total: 100, window_seconds: 86400 },
  });
});

test('errors: an unclear publish names its check tool after one publish request, and a 429 carries retryAfter', async () => {
  const broken = setup(router({
    [`POST /v1.0/${USER}/threads`]: f('container-create.json'),
    [`GET /v1.0/${CONTAINER}`]: f('container-finished.json'),
    [`POST /v1.0/${USER}/threads_publish`]: () => {
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    },
  }));
  const unknown = await callTool(broken.module, 'publish_post', { text: 'Hello' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_posts');
  assert.equal(broken.fetch.calls.filter((call) => call.path.endsWith('/threads_publish')).length, 1);

  const limited = setup(router({ 'GET /v1.0/me': () => jsonResponse(429, { error: { message: 'Too many calls' } }, { 'retry-after': '120' }) }));
  const rate = await callTool(limited.module, 'get_profile', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 120);
  const missing = setup(router({}), {});
  const notConnected = await callTool(missing.module, 'get_profile', {}, missing.ctx);
  assert.match(notConnected.payload.error, /Threads is not connected: the Threads access token is missing\./);
});

test('api_get and api_request keep to /v1.0/ with the token in the header', async () => {
  const { module, fetch, ctx } = setup(router({ 'GET /v1.0/me/replies': { data: [] } }));
  const read = await callTool(module, 'api_get', { path: '/v1.0/me/replies', query: { fields: 'id,text' } }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { data: [] } });
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const outside = await callTool(module, 'api_get', { path: '/oauth/access_token' }, ctx);
  assert.match(outside.payload.error, /The path must start with \/v1\.0\//);
});

test('log lines carry no token or arguments', async () => {
  const { module, ctx, logs } = setup(router({ [`POST /v1.0/${USER}/threads`]: f('container-create.json'), ...PUBLISHED }));
  await callTool(module, 'publish_post', { text: 'Unannounced menu' }, ctx);
  assert.ok(logs.length >= 4);
  for (const line of logs) {
    assert.match(line, /^threads publish_post (GET|POST) \d{3} \d+ms$/);
    assert.equal(line.includes(TOKEN) || line.includes('Unannounced'), false);
  }
});
