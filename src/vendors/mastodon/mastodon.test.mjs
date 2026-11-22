import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bytesResponse,
  callTool,
  controlClock,
  fakeFetch,
  fixture,
  jsonResponse,
  loadModuleFor,
  makeContext,
  refusal,
  textBytes,
} from '../../../tests/helpers.mjs';

const TOKEN = 'mastodon-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const credentials = { instanceurl: 'https://social.example/@alice', token: TOKEN };
const ORIGIN = 'https://social.example';
const plain = (value) => JSON.parse(JSON.stringify(value));

// A 2 x 3 PNG: the signature and an IHDR chunk are all the module reads.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
// The start of an MP4 file: a ftyp box with the isom brand.
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);

/** A fake Mastodon server: routes by method and path; `overrides` replaces any route. */
function routes(overrides = {}) {
  const table = {
    'GET /api/v2/instance': () => jsonResponse(200, fixture(import.meta.url, 'instance-v2.json')),
    'GET /api/v1/accounts/verify_credentials': () => jsonResponse(200, fixture(import.meta.url, 'verify-credentials.json')),
    'GET /api/v1/accounts/109000000000000001/statuses': () => jsonResponse(200, fixture(import.meta.url, 'statuses.json')),
    'POST /api/v1/statuses': () => jsonResponse(200, fixture(import.meta.url, 'status-created.json')),
    'POST /api/v2/media': () => jsonResponse(200, fixture(import.meta.url, 'image-ready.json')),
    ...overrides,
  };
  return (request) => {
    if (request.origin !== ORIGIN) {
      const media = table.media;
      if (!media) throw new Error(`unexpected media request ${request.url}`);
      return media(request);
    }
    const route = table[`${request.method} ${request.path}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return route(request);
  };
}

function setup(overrides, options = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(routes(overrides));
  const { ctx, logs } = makeContext({ credentials: options.credentials ?? credentials, fetch, ...(options.signal ? { signal: options.signal } : {}) });
  return { module, context, fetch, ctx, logs };
}

const callsTo = (fetch, method, path) => fetch.calls.filter((call) => call.method === method && call.path === path);
const bodyText = (call) => new TextDecoder().decode(call.body);

test('the module reaches only the server the address names, with the token as a bearer', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), []);
  assert.deepEqual(plain(module.originFields), ['instanceurl']);
  assert.deepEqual(plain(module.credentials), ['instanceurl', 'token']);
  assert.deepEqual(plain(module.requiredCredentials), [['instanceurl', 'token']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('get_account reads the account on the server of the address given, even a profile link', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [read] = fetch.calls;
  assert.equal(read.url, 'https://social.example/api/v1/accounts/verify_credentials');
  assert.equal(read.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    id: '109000000000000001',
    acct: 'alice',
    username: 'alice',
    display_name: 'Alice',
    url: 'https://social.example/@alice',
    locked: false,
    bot: false,
    followers_count: 320,
    following_count: 150,
    statuses_count: 812,
    default_visibility: 'public',
    default_language: 'en',
    server: 'social.example',
  });
});

test('an address that is not https, or missing, is refused before anything is sent', async () => {
  for (const [instanceurl, message] of [
    ['http://social.example', /Mastodon is not connected correctly: the Mastodon server address must be an https address, not http:\/\/\. Nothing was sent to Mastodon\./],
    ['https://user:pass@social.example', /must not contain a user name or password/],
  ]) {
    const { module, fetch, ctx } = setup(undefined, { credentials: { instanceurl, token: TOKEN } });
    const { payload, isError } = await callTool(module, 'get_account', {}, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
    assert.equal(fetch.calls.length, 0);
  }
  const missing = setup(undefined, { credentials: { token: TOKEN } });
  const result = await callTool(missing.module, 'get_account', {}, missing.ctx);
  assert.equal(result.payload.error, 'Mastodon is not connected: the Mastodon server address is missing.');
});

test('get_instance_limits reads the server\'s own limits, and falls back to the older instance API', async () => {
  const { module, ctx } = setup();
  const { payload } = await callTool(module, 'get_instance_limits', {}, ctx);
  assert.equal(payload.server, 'social.example');
  assert.equal(payload.maxCharacters, 500);
  assert.equal(payload.charactersPerUrl, 23);
  assert.equal(payload.maxMedia, 4);
  assert.equal(payload.altTextLimit, 1500);
  assert.equal(payload.pollOptions, 4);
  assert.ok(payload.mimeTypes.includes('video/mp4'));
  assert.deepEqual(payload.defaults, []);

  const old = setup({
    'GET /api/v2/instance': () => jsonResponse(404, { error: 'Record not found' }),
    'GET /api/v1/instance': () => jsonResponse(200, { uri: 'old.example', version: '3.5.3', max_toot_chars: 1000, configuration: { statuses: { max_characters: 1000 } } }),
  });
  const fallback = await callTool(old.module, 'get_instance_limits', {}, old.ctx);
  assert.equal(fallback.isError, false, fallback.payload.error);
  assert.equal(fallback.payload.server, 'old.example');
  assert.equal(fallback.payload.maxCharacters, 1000);
  assert.equal(fallback.payload.maxMedia, 4);
  assert.ok(fallback.payload.defaults.includes('maxMedia'));
  assert.ok(fallback.payload.defaults.includes('charactersPerUrl'));
});

test('list_my_posts lists the account\'s own posts without boosts, as plain text with their numbers', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'list_my_posts', { limit: 3, exclude_replies: false, tagged: '#ReleaseDay' }, ctx);
  assert.equal(isError, false, payload.error);
  const [, read] = fetch.calls;
  assert.equal(read.path, '/api/v1/accounts/109000000000000001/statuses');
  assert.deepEqual(read.query, { limit: '3', exclude_reblogs: 'true', exclude_replies: 'false', tagged: 'ReleaseDay' });
  assert.equal(payload.posts.length, 2, 'the boost is left out');
  assert.deepEqual(payload.posts[0], {
    id: '113500000000000003',
    created_at: '2026-11-21T09:00:00.000Z',
    url: 'https://social.example/@alice/113500000000000003',
    visibility: 'public',
    kind: 'post',
    text: "Shipping a new release today & it's fast example.com/release #ReleaseDay",
    language: 'en',
    favourites_count: 31,
    reblogs_count: 5,
    replies_count: 2,
    quotes_count: 1,
    media: 1,
  });
  assert.equal(payload.posts[1].kind, 'reply');
  assert.equal(payload.posts[1].content_warning, 'Spoilers');
  assert.deepEqual(payload.posts[1].poll.options, [{ title: 'A', votes_count: 6 }, { title: 'B', votes_count: 4 }]);

  await callTool(module, 'list_my_posts', { cursor: payload.nextCursor }, ctx);
  assert.equal(callsTo(fetch, 'GET', '/api/v1/accounts/verify_credentials').length, 1, 'the account id travels in the cursor');
  const next = callsTo(fetch, 'GET', '/api/v1/accounts/109000000000000001/statuses')[1];
  assert.deepEqual(next.query, { limit: '3', exclude_reblogs: 'true', exclude_replies: 'false', tagged: 'ReleaseDay', max_id: '113500000000000001' });
});

test('get_post takes an id or a link on the account\'s own server, and lists the replies when asked', async () => {
  const { module, fetch, ctx } = setup({
    'GET /api/v1/statuses/113500000000000003': () => jsonResponse(200, fixture(import.meta.url, 'statuses.json')[0]),
    'GET /api/v1/statuses/113500000000000003/context': () => jsonResponse(200, fixture(import.meta.url, 'context.json')),
  });
  const { payload, isError } = await callTool(module, 'get_post', { post: 'https://social.example/@alice/113500000000000003', include_replies: true }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(payload.post.id, '113500000000000003');
  assert.equal(payload.post.account, 'alice');
  assert.deepEqual(payload.replies, [{
    id: '113500000000000020',
    created_at: '2026-11-21T10:00:00.000Z',
    url: 'https://social.example/@bob@other.example/113500000000000020',
    account: 'bob@other.example',
    visibility: 'public',
    kind: 'reply',
    in_reply_to_id: '113500000000000003',
    text: 'Congrats!',
    favourites_count: 1,
    reblogs_count: 0,
    replies_count: 0,
  }]);
  const byId = await callTool(module, 'get_post', { post: '113500000000000003' }, ctx);
  assert.equal(byId.payload.id, '113500000000000003');

  const elsewhere = await callTool(module, 'get_post', { post: 'https://other.example/@bob/113400000000000005' }, ctx);
  assert.match(elsewhere.payload.error, /post is a link on other\.example, not on social\.example: open the post on your own server/);
  const notPost = await callTool(module, 'get_post', { post: 'https://social.example/about' }, ctx);
  assert.match(notPost.payload.error, /is not a post link/);
  assert.equal(fetch.calls.length, 3);
});

test('create_post checks the post against the server\'s limits, then posts it once with an Idempotency-Key', async () => {
  const { module, fetch, ctx } = setup();
  const args = { text: 'Hello from the connector https://example.com/a-very-long-path/that-counts-as-twenty-three-only', visibility: 'unlisted', language: 'en', spoiler_text: 'CW' };
  const { payload, isError } = await callTool(module, 'create_post', args, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/v2/instance', 'POST /api/v1/statuses']);
  const [, post] = fetch.calls;
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(post.json, { status: args.text, visibility: 'unlisted', spoiler_text: 'CW', language: 'en' });
  assert.match(post.headers['idempotency-key'], /^[0-9a-f]{64}$/);
  assert.equal(payload.url, 'https://social.example/@alice/113500000000000010');
  assert.equal(payload.characters, 2 + 'Hello from the connector '.length + 23);
  assert.equal(payload.character_limit, 500);
  assert.equal(payload.idempotency_key, post.headers['idempotency-key']);

  await callTool(module, 'create_post', args, ctx);
  await callTool(module, 'create_post', { ...args, text: 'Something else' }, ctx);
  const keys = callsTo(fetch, 'POST', '/api/v1/statuses').map((call) => call.headers['idempotency-key']);
  assert.equal(keys[1], keys[0], 'the same post gets the same key');
  assert.notEqual(keys[2], keys[0]);
  await callTool(module, 'create_post', { text: 'Mine', idempotency_key: 'my-key-1' }, ctx);
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses')[3].headers['idempotency-key'], 'my-key-1');
});

test('Mastodon counts a link as 23 and @name@server as @name; a post over the limit is not sent', async () => {
  const { module, fetch, ctx } = setup();
  const fits = `@bob@a-very-long-server-name.example ${'x'.repeat(470)} https://example.com/${'p'.repeat(100)}`;
  const ok = await callTool(module, 'create_post', { text: fits }, ctx);
  assert.equal(ok.isError, false, ok.payload.error);
  assert.equal(ok.payload.characters, 4 + 1 + 470 + 1 + 23);

  const long = await callTool(module, 'create_post', { text: 'y'.repeat(480), spoiler_text: 'z'.repeat(21) }, ctx);
  assert.equal(long.isError, true);
  assert.match(long.payload.error, /Not posted: the post is 501 characters as the server counts them \(content warning, text, 23 per link\); the server allows 500\. Nothing was sent\./);
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses').length, 1);
});

test('polls, media and scheduling are checked before anything is posted', async () => {
  const { module, fetch, ctx } = setup();
  const cases = [
    [{ text: 'x', poll: { options: ['a', 'b'], expires_in: 3600 }, media: [{ url: 'https://images.example.com/a.png', alt: 'a' }] }, /media or a poll, not both/],
    [{ poll: { options: ['a', 'b'], expires_in: 3600 }, media: [{ url: 'https://images.example.com/a.png', alt: 'a' }] }, /media or a poll, not both/],
    [{ text: 'x', poll: { options: ['a', 'a'], expires_in: 3600 } }, /Two poll options are the same/],
    [{ text: 'Pick', poll: { options: ['a', 'b', 'c', 'd', 'e'], expires_in: 3600 } }, /the poll has 5 options; the server allows 4/],
    [{ text: 'Pick', poll: { options: ['a', 'b'], expires_in: 60 } }, /poll expires_in is 60; the server takes 300 to 2629746 seconds/],
    [{ text: 'Pick', poll: { options: ['a', 'b'.repeat(51)], expires_in: 3600 } }, /is longer than 50 characters/],
    [{ text: 'x', media: Array.from({ length: 5 }, () => ({ url: 'https://images.example.com/a.png', alt: 'a' })) }, /5 media; the server allows 4 per post/],
    [{ text: 'x', scheduled_at: new Date(Date.now() + 60_000).toISOString() }, /scheduled_at must be more than 5 minutes from now/],
    [{ text: 'x', scheduled_at: 'next friday' }, /scheduled_at must be a time with its zone/],
    [{ text: '' }, /The post needs text or media/],
  ];
  for (const [args, message] of cases) {
    const { payload, isError } = await callTool(module, 'create_post', args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, message);
  }
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses').length, 0);
  assert.equal(callsTo(fetch, 'POST', '/api/v2/media').length, 0);
});

test('a poll and a scheduled post go out with their fields; a scheduled post answers with its id', async () => {
  const { module, fetch, ctx } = setup({ 'POST /api/v1/statuses': (request) => jsonResponse(200, request.json.scheduled_at ? fixture(import.meta.url, 'scheduled-created.json') : fixture(import.meta.url, 'status-created.json')) });
  await callTool(module, 'create_post', { text: 'Pick one', poll: { options: ['A', 'B'], expires_in: 86400, multiple: true } }, ctx);
  assert.deepEqual(callsTo(fetch, 'POST', '/api/v1/statuses')[0].json, { status: 'Pick one', poll: { options: ['A', 'B'], expires_in: 86400, multiple: true } });

  const at = new Date(Date.now() + 3 * 86400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const { payload } = await callTool(module, 'create_post', { text: 'Scheduled hello', scheduled_at: at }, ctx);
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses')[1].json.scheduled_at, new Date(at).toISOString());
  assert.equal(payload.scheduled, true);
  assert.equal(payload.scheduled_id, '3221');
  assert.equal(payload.scheduled_at, '2026-12-01T18:00:00.000Z');
});

test('media are downloaded without the token, checked, uploaded with their alt text, and waited for until processed', async () => {
  let reads = 0;
  const { module, fetch, ctx } = setup({
    media: (request) => bytesResponse(200, request.url.endsWith('.png') ? PNG : MP4, { 'content-type': 'application/octet-stream' }),
    'POST /api/v2/media': (request) => (bodyText(request).includes('video/mp4')
      ? jsonResponse(202, fixture(import.meta.url, 'media-processing.json'))
      : jsonResponse(200, fixture(import.meta.url, 'image-ready.json'))),
    'GET /api/v1/media/22348641': () => (++reads < 2 ? jsonResponse(206, fixture(import.meta.url, 'media-processing.json')) : jsonResponse(200, fixture(import.meta.url, 'media-ready.json'))),
  });
  const media = [{ url: 'https://images.example.com/photo.png', alt: 'A tiny test image' }, { url: 'https://videos.example.com/clip.mp4', alt: 'A short clip' }];
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Photo and clip', media, sensitive: true }, ctx);
  assert.equal(isError, false, payload.error);

  const downloads = fetch.calls.filter((call) => call.origin !== ORIGIN);
  assert.deepEqual(downloads.map((call) => call.url), media.map((item) => item.url));
  for (const download of downloads) assert.equal(download.headers.authorization, undefined);
  const uploads = callsTo(fetch, 'POST', '/api/v2/media');
  assert.equal(uploads.length, 2);
  assert.match(uploads[0].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(bodyText(uploads[0]), /name="file"; filename="upload\.png"\r\nContent-Type: image\/png/);
  assert.match(bodyText(uploads[0]), /name="description"\r\n\r\nA tiny test image\r\n/);
  assert.match(bodyText(uploads[1]), /filename="upload\.mp4"\r\nContent-Type: video\/mp4/);
  assert.equal(reads, 2, 'the processing video was read until it was ready');
  assert.deepEqual(callsTo(fetch, 'POST', '/api/v1/statuses')[0].json, { status: 'Photo and clip', sensitive: true, media_ids: ['22348650', '22348641'] });
  assert.equal(payload.media, 2);
});

test('a media file the server does not take, or one too large, stops the post before it is sent', async () => {
  const instance = fixture(import.meta.url, 'instance-v2.json');
  const strict = { ...instance, configuration: { ...instance.configuration, media_attachments: { ...instance.configuration.media_attachments, supported_mime_types: ['image/jpeg'], image_size_limit: 20 } } };
  const cases = [
    [() => bytesResponse(200, PNG), strict, /The media is image\/png, which this server does not take \(it takes image\/jpeg\)/],
    [() => bytesResponse(200, new TextEncoder().encode('<html>no</html>')), instance, /did not return an image, video or audio file/],
    [() => bytesResponse(200, new Uint8Array([0xff, 0xd8, 0xff, ...new Array(30).fill(0)])), strict, /The media has 33 bytes; this server takes image files up to 20/],
    [() => { throw refusal('images.example.com is not a public internet address'); }, instance, /The media URL was refused/],
  ];
  for (const [download, limits, message] of cases) {
    const { module, fetch, ctx } = setup({ media: download, 'GET /api/v2/instance': () => jsonResponse(200, limits) });
    const { payload, isError } = await callTool(module, 'create_post', { text: 'x', media: [{ url: 'https://images.example.com/a.png', alt: 'a' }] }, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
    assert.equal(callsTo(fetch, 'POST', '/api/v2/media').length, 0);
    assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses').length, 0);
  }
});

test('media still processing after the wait stops the post, which is never sent', async () => {
  const { module, context, fetch, ctx } = setup({
    media: () => bytesResponse(200, MP4),
    'POST /api/v2/media': () => jsonResponse(202, fixture(import.meta.url, 'media-processing.json')),
    'GET /api/v1/media/22348641': () => {
      advance(120_000);
      return jsonResponse(206, fixture(import.meta.url, 'media-processing.json'));
    },
  });
  const advance = controlClock(context);
  const { payload, isError } = await callTool(module, 'create_post', { text: 'x', media: [{ url: 'https://videos.example.com/clip.mp4', alt: 'clip' }] }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, undefined);
  assert.match(payload.error, /still processing the media after 90 seconds\. Nothing was posted/);
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses').length, 0);
});

test('a cancelled call stops waiting for media at once', async () => {
  const controller = new AbortController();
  const { module, fetch, ctx } = setup({
    media: () => bytesResponse(200, MP4),
    'POST /api/v2/media': () => {
      controller.abort();
      return jsonResponse(202, fixture(import.meta.url, 'media-processing.json'));
    },
  }, { signal: controller.signal });
  const { payload } = await callTool(module, 'create_post', { text: 'x', media: [{ url: 'https://videos.example.com/clip.mp4', alt: 'clip' }] }, ctx);
  assert.match(payload.error, /The call was cancelled while the server was processing the media\. Nothing was posted\./);
  assert.equal(callsTo(fetch, 'GET', '/api/v1/media/22348641').length, 0);
});

test('reply_to sets in_reply_to_id from a link on the account\'s own server', async () => {
  const { module, fetch, ctx } = setup();
  await callTool(module, 'create_post', { text: '@bob@other.example Thanks!', reply_to: 'https://social.example/@bob@other.example/113400000000000005' }, ctx);
  assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses')[0].json.in_reply_to_id, '113400000000000005');
  const remote = await callTool(module, 'create_post', { text: 'x', reply_to: 'https://other.example/@bob/113400000000000005' }, ctx);
  assert.match(remote.payload.error, /reply_to is a link on other\.example, not on social\.example/);
});

test('an unclear post is unknown, sent once, and names the key that keeps a resend from posting twice', async () => {
  for (const respond of [() => jsonResponse(502, { error: 'Bad gateway' }), () => { throw new TypeError('fetch failed'); }]) {
    const { module, fetch, ctx } = setup({ 'POST /api/v1/statuses': respond });
    const { payload, isError } = await callTool(module, 'create_post', { text: 'hello' }, ctx);
    assert.equal(isError, true);
    assert.equal(payload.outcome, 'unknown');
    assert.equal(payload.check, 'list_my_posts');
    assert.match(payload.error, /Sending the same post again within an hour, with idempotency_key "[0-9a-f]{64}", cannot post it twice\./);
    assert.doesNotMatch(payload.error, /list_scheduled_posts/);
    assert.equal(callsTo(fetch, 'POST', '/api/v1/statuses').length, 1);
  }
  // A scheduled post is not in the account's posts yet: the result says where it shows.
  const { module, ctx } = setup({ 'POST /api/v1/statuses': () => jsonResponse(503, { error: 'Unavailable' }) });
  const at = new Date(Date.now() + 86400_000).toISOString();
  const scheduled = await callTool(module, 'create_post', { text: 'Later', scheduled_at: at }, ctx);
  assert.equal(scheduled.payload.outcome, 'unknown');
  assert.match(scheduled.payload.error, /cannot post it twice\. A scheduled post shows in list_scheduled_posts, not in list_my_posts\. Call list_my_posts/);
});

test('Mastodon\'s refusals keep its words: a 422, a revoked token, a missing scope, a rate limit', async () => {
  const cases = [
    ['POST /api/v1/statuses', () => jsonResponse(422, fixture(import.meta.url, 'error-422.json')), 'create_post', { text: 'x' }, /The server did not accept the post \(HTTP 422\)\. Mastodon said: "Validation failed: Text character limit of 500 exceeded"\. Nothing was changed\./],
    ['GET /api/v1/accounts/verify_credentials', () => jsonResponse(401, fixture(import.meta.url, 'error-401.json')), 'get_account', {}, /Mastodon rejected the credentials \(HTTP 401\): The access token is invalid\. Check that the Mastodon server address and Mastodon access token are correct and still active\./],
    ['GET /api/v1/accounts/verify_credentials', () => jsonResponse(403, { error: 'This action is outside the authorized scopes' }), 'get_account', {}, /the access token may lack a scope\. It needs read:accounts, read:statuses, write:media and write:statuses/],
    ['GET /api/v2/instance', () => jsonResponse(429, { error: 'Too many requests' }, { 'retry-after': '30' }), 'get_instance_limits', {}, /Mastodon rate limit reached \(HTTP 429\)\. Retry after 30 seconds\./],
  ];
  for (const [route, respond, tool, args, message] of cases) {
    const { module, ctx } = setup({ [route]: respond });
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
});

test('scheduled posts: list, move and cancel', async () => {
  const later = new Date(Date.now() + 7 * 86400_000).toISOString();
  const { module, fetch, ctx } = setup({
    'GET /api/v1/scheduled_statuses': () => jsonResponse(200, fixture(import.meta.url, 'scheduled-list.json')),
    'PUT /api/v1/scheduled_statuses/3221': (request) => jsonResponse(200, { ...fixture(import.meta.url, 'scheduled-created.json'), scheduled_at: request.json.scheduled_at }),
    'DELETE /api/v1/scheduled_statuses/3220': () => jsonResponse(200, {}),
  });
  const list = await callTool(module, 'list_scheduled_posts', {}, ctx);
  assert.deepEqual(list.payload.scheduled[1], { id: '3220', scheduled_at: '2026-12-02T09:00:00.000Z', visibility: 'unlisted', text: 'Poll time', poll: true });
  assert.equal(fetch.calls[0].url, 'https://social.example/api/v1/scheduled_statuses?limit=40');

  const moved = await callTool(module, 'reschedule_post', { scheduled_id: '3221', scheduled_at: later }, ctx);
  assert.equal(moved.isError, false, moved.payload.error);
  assert.deepEqual(callsTo(fetch, 'PUT', '/api/v1/scheduled_statuses/3221')[0].json, { scheduled_at: later });
  assert.equal(moved.payload.scheduled_at, later);
  const soon = await callTool(module, 'reschedule_post', { scheduled_id: '3221', scheduled_at: new Date(Date.now() + 1000).toISOString() }, ctx);
  assert.match(soon.payload.error, /more than 5 minutes from now/);

  const cancelled = await callTool(module, 'cancel_scheduled_post', { scheduled_id: '3220' }, ctx);
  assert.deepEqual(cancelled.payload, { cancelled: true, scheduled_id: '3220' });
});

test('delete_post deletes the account\'s own post with its media, and says plainly when it is not one', async () => {
  const { module, fetch, ctx } = setup({
    'DELETE /api/v1/statuses/113500000000000003': () => jsonResponse(200, fixture(import.meta.url, 'deleted.json')),
    'DELETE /api/v1/statuses/113400000000000005': () => jsonResponse(404, { error: 'Record not found' }),
  });
  const { payload, isError } = await callTool(module, 'delete_post', { post: 'https://social.example/@alice/113500000000000003' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://social.example/api/v1/statuses/113500000000000003?delete_media=true');
  assert.deepEqual(payload, {
    deleted: true,
    id: '113500000000000003',
    url: 'https://social.example/@alice/113500000000000003',
    text: "Shipping a new release today & it's fast https://example.com/release #ReleaseDay",
  });
  const other = await callTool(module, 'delete_post', { post: '113400000000000005' }, ctx);
  assert.match(other.payload.error, /Mastodon found no post of this account with that id \(only the account's own posts can be deleted\) \(HTTP 404\)/);

  const broken = setup({ 'DELETE /api/v1/statuses/1': () => jsonResponse(503, { error: 'unavailable' }) });
  const unknown = await callTool(broken.module, 'delete_post', { post: '1' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_my_posts');
});

test('api_get and api_request reach the rest of the API on the same server, under /api/ only', async () => {
  const { module, fetch, ctx } = setup({
    'GET /api/v1/notifications': () => jsonResponse(200, [{ id: '1', type: 'favourite' }], { link: '<https://social.example/api/v1/notifications?max_id=1>; rel="next"' }),
    'POST /api/v1/statuses/113500000000000003/favourite': () => jsonResponse(200, { id: '113500000000000003', favourited: true }),
  });
  const read = await callTool(module, 'api_get', { path: '/api/v1/notifications', query: { limit: 5 } }, ctx);
  assert.deepEqual(read.payload, { status: 200, headers: { link: '<https://social.example/api/v1/notifications?max_id=1>; rel="next"' }, data: [{ id: '1', type: 'favourite' }] });
  assert.equal(fetch.calls[0].url, 'https://social.example/api/v1/notifications?limit=5');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const write = await callTool(module, 'api_request', { method: 'POST', path: '/api/v1/statuses/113500000000000003/favourite' }, ctx);
  assert.equal(write.payload.data.favourited, true);
  const outside = await callTool(module, 'api_get', { path: '/oauth/token' }, ctx);
  assert.equal(outside.payload.error, 'The path must start with /api/. Nothing was sent.');
  assert.equal(fetch.calls.length, 2);
});

test('a long list is cut under 32 KB and continues after the last post returned', async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    ...fixture(import.meta.url, 'statuses.json')[0],
    id: String(113500000000001000 - index),
    content: `<p>${index} ${'長い文章です。'.repeat(80)}</p>`,
  }));
  const { module, ctx } = setup({ 'GET /api/v1/accounts/109000000000000001/statuses': () => jsonResponse(200, many) });
  const first = await callTool(module, 'list_my_posts', { limit: 40 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.posts.length;
  const second = await callTool(module, 'list_my_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.posts[0].id, many[shown].id);
});

test('logs carry no token, address or text', async () => {
  const { module, ctx, logs } = setup();
  await callTool(module, 'create_post', { text: 'secret plans #launch' }, ctx);
  const all = logs.join('\n');
  for (const secret of [TOKEN, 'secret plans', 'social.example']) assert.equal(all.includes(secret), false, secret);
  assert.ok(logs.every((line) => /^mastodon create_post (POST|GET) \d{3} \d+ms$/.test(line)), all);
});
