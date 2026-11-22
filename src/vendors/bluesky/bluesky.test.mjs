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
} from '../../../tests/helpers.mjs';

const PASSWORD = 'abcd-efgh-ijkl-mnop';
const credentials = { handle: '@Alice.bsky.social ', apppassword: PASSWORD };
const session = fixture(import.meta.url, 'session.json');
const DID = session.did;
const BEARER = `Bearer ${session.accessJwt}`;

// A 2 x 3 PNG: the signature and an IHDR chunk are all the module reads.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** A fake Bluesky: routes by XRPC method; `overrides` replaces any route. */
function blueskyRoutes(overrides = {}) {
  const routes = {
    'com.atproto.server.createSession': () => jsonResponse(200, session),
    'app.bsky.actor.getProfile': () => jsonResponse(200, fixture(import.meta.url, 'profile.json')),
    'app.bsky.feed.getAuthorFeed': () => jsonResponse(200, fixture(import.meta.url, 'author-feed.json')),
    'com.atproto.identity.resolveHandle': (request) => (request.query.handle === 'bob.bsky.social'
      ? jsonResponse(200, fixture(import.meta.url, 'resolve-handle.json'))
      : jsonResponse(400, { error: 'InvalidRequest', message: 'Unable to resolve handle' })),
    'com.atproto.repo.uploadBlob': () => jsonResponse(200, fixture(import.meta.url, 'upload-blob.json')),
    'com.atproto.repo.createRecord': () => jsonResponse(200, fixture(import.meta.url, 'create-record.json')),
    ...overrides,
  };
  return (request) => {
    if (request.origin !== 'https://bsky.social') {
      const media = routes.media;
      if (!media) throw new Error(`unexpected media request ${request.url}`);
      return media(request);
    }
    const route = routes[request.path.replace('/xrpc/', '')];
    if (!route) throw new Error(`unexpected request ${request.path}`);
    return route(request);
  };
}

function setup(overrides) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(blueskyRoutes(overrides));
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, context, fetch, ctx, logs };
}

const sessionCalls = (fetch) => fetch.calls.filter((call) => call.path.endsWith('createSession'));
const callsTo = (fetch, method) => fetch.calls.filter((call) => call.path === `/xrpc/${method}`);

test('get_profile signs in with the normalized handle, then reads the profile with the session token', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'get_profile', {}, ctx);
  assert.equal(isError, false);

  const [signIn, read] = fetch.calls;
  assert.equal(signIn.method, 'POST');
  assert.equal(signIn.url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
  assert.deepEqual(signIn.json, { identifier: 'alice.bsky.social', password: PASSWORD });
  assert.equal(signIn.headers.authorization, undefined);

  assert.equal(read.method, 'GET');
  assert.equal(read.url, `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(DID)}`);
  assert.equal(read.headers.authorization, BEARER);

  assert.deepEqual(payload, {
    did: DID,
    handle: 'alice.bsky.social',
    displayName: 'Alice',
    description: 'Writes about open protocols.',
    avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreiexample@jpeg',
    followersCount: 1203,
    followsCount: 87,
    postsCount: 342,
    createdAt: '2023-04-12T08:30:00.000Z',
    url: 'https://bsky.app/profile/alice.bsky.social',
  });
});

test('another actor is looked up by handle or DID', async () => {
  const { module, fetch, ctx } = setup();
  await callTool(module, 'get_profile', { actor: '@bob.bsky.social' }, ctx);
  assert.equal(callsTo(fetch, 'app.bsky.actor.getProfile')[0].query.actor, 'bob.bsky.social');
});

test('a session is reused within its short TTL, shared by parallel calls, and renewed after it', async () => {
  const { module, context, fetch, ctx } = setup();
  const advance = controlClock(context);
  await Promise.all([
    callTool(module, 'get_profile', {}, ctx),
    callTool(module, 'list_my_posts', {}, ctx),
    callTool(module, 'get_profile', { actor: 'bob.bsky.social' }, ctx),
  ]);
  assert.equal(sessionCalls(fetch).length, 1, 'parallel calls share one sign-in');
  await callTool(module, 'get_profile', {}, ctx);
  assert.equal(sessionCalls(fetch).length, 1, 'reused within the TTL');
  advance(11 * 60 * 1000);
  await callTool(module, 'get_profile', {}, ctx);
  assert.equal(sessionCalls(fetch).length, 2, 'renewed after the TTL');
});

test('different credentials get different sessions', async () => {
  const { module, fetch } = setup();
  const one = makeContext({ credentials, fetch });
  const two = makeContext({ credentials: { handle: 'carol.bsky.social', apppassword: 'wxyz-wxyz-wxyz-wxyz' }, fetch });
  await callTool(module, 'get_profile', {}, one.ctx);
  await callTool(module, 'get_profile', {}, two.ctx);
  await callTool(module, 'get_profile', {}, one.ctx);
  assert.equal(sessionCalls(fetch).length, 2);
});

test('sign-ins stop at 30 per 5 minutes before Bluesky refuses them', async () => {
  const { module, context, fetch, ctx } = setup({ 'com.atproto.server.createSession': () => jsonResponse(401, fixture(import.meta.url, 'error-auth.json')) });
  const advance = controlClock(context);
  for (let attempt = 0; attempt < 30; attempt++) {
    const { payload } = await callTool(module, 'get_profile', {}, ctx);
    assert.match(payload.error, /Bluesky refused the handle or app password/);
  }
  assert.equal(sessionCalls(fetch).length, 30);
  const limited = await callTool(module, 'get_profile', {}, ctx);
  assert.match(limited.payload.error, /Bluesky allows 30 sign-ins per 5 minutes for one account, and this connection has used them\. Nothing was sent to Bluesky\. Retry after \d+ seconds\./);
  assert.ok(limited.payload.retryAfter > 0 && limited.payload.retryAfter <= 300);
  assert.equal(sessionCalls(fetch).length, 30, 'the 31st sign-in was not sent');
  advance(5 * 60 * 1000 + 1000);
  await callTool(module, 'get_profile', {}, ctx);
  assert.equal(sessionCalls(fetch).length, 31, 'allowed again after the window');
});

test('Bluesky sign-in refusals get their own messages', async () => {
  const cases = [
    [() => jsonResponse(401, { error: 'AuthFactorTokenRequired', message: 'A sign in code has been sent to your email address' }), /asked for an email sign-in code/],
    [() => jsonResponse(400, { error: 'AccountTakedown', message: 'Account has been taken down' }), /taken down or suspended/],
    [() => jsonResponse(429, fixture(import.meta.url, 'error-rate-limit.json'), { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }), /sign-in limit for this account was reached \(30 per 5 minutes, 300 per day\)\. Retry after 1[12]\d seconds\./],
  ];
  for (const [respond, message] of cases) {
    const { module, ctx } = setup({ 'com.atproto.server.createSession': respond });
    const { payload, isError } = await callTool(module, 'get_profile', {}, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
});

test('list_my_posts reads the author feed with replies, keeps only the account\'s own posts, and shows views', async () => {
  const { module, fetch, ctx } = setup();
  const { payload } = await callTool(module, 'list_my_posts', {}, ctx);
  const [read] = callsTo(fetch, 'app.bsky.feed.getAuthorFeed');
  assert.deepEqual(read.query, { actor: DID, limit: '25', filter: 'posts_with_replies' }, 'replies are in by default, as in Bluesky');
  assert.equal(read.headers.authorization, BEARER);
  assert.equal(payload.handle, 'alice.bsky.social');
  assert.equal(payload.posts.length, 3, 'the repost of another account is left out');
  assert.deepEqual(payload.posts[0], {
    uri: `at://${DID}/app.bsky.feed.post/3lbk2nuxa7c2x`,
    cid: 'bafyreiaaa',
    url: 'https://bsky.app/profile/alice.bsky.social/post/3lbk2nuxa7c2x',
    text: 'Shipping a new release today https://example.com/release',
    createdAt: '2026-11-20T09:00:00.000Z',
    likeCount: 31,
    repostCount: 5,
    replyCount: 2,
    quoteCount: 1,
    viewCount: 1840,
    embed: 'external',
  });
  assert.equal(payload.posts[1].embed, 'images');
  assert.equal(payload.posts[1].viewCount, undefined, 'Bluesky leaves out views under 100');
  assert.equal(payload.posts[2].isReply, true);

  await callTool(module, 'list_my_posts', { include_replies: false, cursor: payload.nextCursor }, ctx);
  const next = callsTo(fetch, 'app.bsky.feed.getAuthorFeed')[1];
  assert.equal(next.query.cursor, '2026-11-18T10:00:00.000Z');
  assert.equal(next.query.filter, 'posts_no_replies', 'include_replies: false leaves replies out');
  await callTool(module, 'list_my_posts', { include_replies: true }, ctx);
  assert.equal(callsTo(fetch, 'app.bsky.feed.getAuthorFeed')[2].query.filter, 'posts_with_replies');
});

test('an expired session is renewed once for a read', async () => {
  let reads = 0;
  const { module, fetch, ctx } = setup({
    'app.bsky.actor.getProfile': () => (++reads === 1
      ? jsonResponse(400, fixture(import.meta.url, 'error-expired.json'))
      : jsonResponse(200, fixture(import.meta.url, 'profile.json'))),
  });
  const { payload, isError } = await callTool(module, 'get_profile', {}, ctx);
  assert.equal(isError, false);
  assert.equal(payload.handle, 'alice.bsky.social');
  assert.equal(sessionCalls(fetch).length, 2);
  assert.equal(reads, 2);
});

test('create_post makes links, mentions and hashtags clickable at the right UTF-8 byte offsets', async () => {
  const { module, fetch, ctx } = setup();
  const text = 'Çok güzel 🎉 see https://example.com/a?b=1. Thanks @bob.bsky.social and @nobody.example! #release #2026';
  const { payload, isError } = await callTool(module, 'create_post', { text, langs: ['en', 'tr'] }, ctx);
  assert.equal(isError, false, payload.error);

  const resolves = callsTo(fetch, 'com.atproto.identity.resolveHandle').map((call) => call.query.handle);
  assert.deepEqual(resolves, ['bob.bsky.social', 'nobody.example']);

  const [create] = callsTo(fetch, 'com.atproto.repo.createRecord');
  assert.equal(create.method, 'POST');
  assert.equal(create.headers.authorization, BEARER);
  assert.equal(create.json.repo, DID);
  assert.equal(create.json.collection, 'app.bsky.feed.post');
  const record = create.json.record;
  assert.equal(record.$type, 'app.bsky.feed.post');
  assert.equal(record.text, text);
  assert.deepEqual(record.langs, ['en', 'tr']);
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));

  const bytes = new TextEncoder().encode(text);
  const slice = (facet) => new TextDecoder().decode(bytes.slice(facet.index.byteStart, facet.index.byteEnd));
  const [link, mention, tag] = record.facets;
  assert.equal(record.facets.length, 3, 'the unresolved mention and the number-only tag stay plain text');
  assert.equal(slice(link), 'https://example.com/a?b=1');
  assert.deepEqual(link.features, [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a?b=1' }]);
  assert.equal(slice(mention), '@bob.bsky.social');
  assert.deepEqual(mention.features, [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:bobbobbobbobbobbobbobbob' }]);
  assert.equal(slice(tag), '#release');
  assert.deepEqual(tag.features, [{ $type: 'app.bsky.richtext.facet#tag', tag: 'release' }]);

  assert.equal(payload.uri, `at://${DID}/app.bsky.feed.post/3lbmnew2post2`);
  assert.equal(payload.url, 'https://bsky.app/profile/alice.bsky.social/post/3lbmnew2post2');
  assert.equal(payload.links, 1);
  assert.equal(payload.mentions, 1);
  assert.equal(payload.hashtags, 1);
  assert.deepEqual(payload.unresolvedMentions, ['nobody.example']);
});

test('create_post with an image downloads it without credentials, uploads it, and embeds it with alt text', async () => {
  const { module, fetch, ctx } = setup({ media: () => bytesResponse(200, PNG, { 'content-type': 'application/octet-stream' }) });
  const { payload, isError } = await callTool(module, 'create_post', {
    text: 'A tiny image',
    image_url: 'https://images.example.com/tiny.png',
    image_alt: 'A two by three pixel test image',
  }, ctx);
  assert.equal(isError, false, payload.error);

  const [media] = fetch.calls;
  assert.equal(media.url, 'https://images.example.com/tiny.png', 'the image is fetched before signing in');
  assert.equal(media.method, 'GET');
  assert.equal(media.headers.authorization, undefined);
  assert.equal(Object.keys(media.headers).some((name) => /key|password|token/i.test(name)), false);

  const [upload] = callsTo(fetch, 'com.atproto.repo.uploadBlob');
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers['content-type'], 'image/png', 'the type comes from the bytes, not the server');
  assert.equal(upload.headers.authorization, BEARER);
  assert.deepEqual(Array.from(upload.body), Array.from(PNG));

  const record = callsTo(fetch, 'com.atproto.repo.createRecord')[0].json.record;
  assert.deepEqual(record.embed, {
    $type: 'app.bsky.embed.images',
    images: [{
      alt: 'A two by three pixel test image',
      image: fixture(import.meta.url, 'upload-blob.json').blob,
      aspectRatio: { width: 2, height: 3 },
    }],
  });
  assert.deepEqual(payload.images, [{ type: 'image/png', bytes: PNG.length, width: 2, height: 3 }]);
});

test('a bad image is refused before signing in', async () => {
  const cases = [
    [{ media: () => bytesResponse(200, new Uint8Array(10), { 'content-length': '2000001' }) }, /larger than 2,000,000 bytes/],
    [{ media: () => bytesResponse(200, new TextEncoder().encode('<html>not an image</html>'), { 'content-type': 'image/png' }) }, /did not return a JPEG, PNG or WebP image/],
    [{ media: () => bytesResponse(404, new Uint8Array(0)) }, /The image URL answered HTTP 404/],
    [{ media: () => { throw refusal('images.example.com is not a public internet address'); } }, /The image URL was refused \(images\.example\.com is not a public internet address\)/],
  ];
  for (const [overrides, message] of cases) {
    const { module, fetch, ctx } = setup(overrides);
    const { payload, isError } = await callTool(module, 'create_post', { text: 'x', image_url: 'https://images.example.com/a.png', image_alt: 'a' }, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
    assert.match(payload.error, /Nothing was changed\./);
    assert.equal(sessionCalls(fetch).length, 0);
  }
});

test('create_post checks the text and the image arguments before any request', async () => {
  const { module, fetch, ctx } = setup();
  const long = await callTool(module, 'create_post', { text: 'a'.repeat(301) }, ctx);
  assert.match(long.payload.error, /The text has 301 characters; Bluesky allows 300/);
  const noAlt = await callTool(module, 'create_post', { text: 'x', image_url: 'https://images.example.com/a.png' }, ctx);
  assert.match(noAlt.payload.error, /image_alt is required with image_url/);
  const http = await callTool(module, 'create_post', { text: 'x', image_url: 'http://images.example.com/a.png', image_alt: 'a' }, ctx);
  assert.match(http.payload.error, /`image_url` does not have the expected format/);
  assert.equal(fetch.calls.length, 0);
});

test('Bluesky counts graphemes: 300 emoji with skin tones fit', async () => {
  const { module, fetch, ctx } = setup();
  const { isError, payload } = await callTool(module, 'create_post', { text: '👍🏽'.repeat(300) }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(callsTo(fetch, 'com.atproto.repo.createRecord').length, 1);
});

test('a post without a clear answer is unknown, sent once, with list_my_posts to check', async () => {
  for (const respond of [() => jsonResponse(500, { error: 'InternalServerError' }), () => { throw new TypeError('fetch failed'); }]) {
    const { module, fetch, ctx } = setup({ 'com.atproto.repo.createRecord': respond });
    const { payload, isError } = await callTool(module, 'create_post', { text: 'hello' }, ctx);
    assert.equal(isError, true);
    assert.equal(payload.outcome, 'unknown');
    assert.equal(payload.check, 'list_my_posts');
    assert.equal(callsTo(fetch, 'com.atproto.repo.createRecord').length, 1);
  }
});

test('an unclear reply is checked with list_my_posts as told, which shows replies', async () => {
  const { module, fetch, ctx } = setup({
    'app.bsky.feed.getPosts': () => jsonResponse(200, fixture(import.meta.url, 'get-posts.json')),
    'com.atproto.repo.createRecord': () => { throw new TypeError('fetch failed'); },
  });
  const { payload } = await callTool(module, 'create_post', { text: 'Part 2 of the thread', reply_to: 'https://bsky.app/profile/bob.bsky.social/post/3lbreply1' }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'list_my_posts');
  assert.equal(callsTo(fetch, 'com.atproto.repo.createRecord').length, 1);
  // The check, called the way the result says, asks Bluesky for replies too.
  const check = await callTool(module, payload.check, {}, ctx);
  assert.equal(check.isError, false, check.payload.error);
  assert.equal(callsTo(fetch, 'app.bsky.feed.getAuthorFeed')[0].query.filter, 'posts_with_replies');
  assert.ok(check.payload.posts.some((post) => post.isReply), 'replies are listed');
});

test('an expired session on a post is never retried, and says nothing was posted', async () => {
  const { module, fetch, ctx } = setup({ 'com.atproto.repo.createRecord': () => jsonResponse(400, fixture(import.meta.url, 'error-expired.json')) });
  const { payload, isError } = await callTool(module, 'create_post', { text: 'hello' }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, undefined);
  assert.match(payload.error, /session expired before the request was accepted, so nothing was changed/);
  assert.equal(callsTo(fetch, 'com.atproto.repo.createRecord').length, 1);
  assert.equal(sessionCalls(fetch).length, 1);
});

test('logs carry no handle, password, token or text', async () => {
  const { module, ctx, logs } = setup();
  await callTool(module, 'create_post', { text: 'secret plans #launch' }, ctx);
  const all = logs.join('\n');
  for (const secret of [PASSWORD, session.accessJwt, 'alice', 'secret plans']) assert.equal(all.includes(secret), false, secret);
  assert.ok(logs.every((line) => /^bluesky create_post (POST|GET) \d{3} \d+ms$/.test(line)), logs.join('\n'));
});

test('api_get calls any XRPC query with the session token, signing in once', async () => {
  const timeline = { feed: [{ post: { uri: `at://${DID}/app.bsky.feed.post/1` } }], cursor: 'c2' };
  const { module, fetch, ctx } = setup({ 'app.bsky.feed.getTimeline': () => jsonResponse(200, timeline) });
  const { payload, isError } = await callTool(module, 'api_get', { path: '/xrpc/app.bsky.feed.getTimeline', query: { limit: 5 } }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(payload, { status: 200, data: timeline });
  const [read] = callsTo(fetch, 'app.bsky.feed.getTimeline');
  assert.equal(read.method, 'GET');
  assert.equal(read.url, 'https://bsky.social/xrpc/app.bsky.feed.getTimeline?limit=5');
  assert.equal(read.headers.authorization, BEARER);
  await callTool(module, 'api_get', { path: '/xrpc/app.bsky.feed.getTimeline' }, ctx);
  assert.equal(sessionCalls(fetch).length, 1, 'the session is shared with the other tools');
});

test('api_request posts a procedure once, and never runs it again after an expired session', async () => {
  const deleted = { commit: { cid: 'bafyreiccc', rev: '3lbm' } };
  const { module, fetch, ctx } = setup({ 'com.atproto.repo.deleteRecord': () => jsonResponse(200, deleted) });
  const args = { method: 'POST', path: '/xrpc/com.atproto.repo.deleteRecord', json: { repo: DID, collection: 'app.bsky.feed.post', rkey: '3lbk2nuxa7c2x' } };
  const { payload } = await callTool(module, 'api_request', args, ctx);
  assert.deepEqual(payload, { status: 200, data: deleted });
  const [sent] = callsTo(fetch, 'com.atproto.repo.deleteRecord');
  assert.equal(sent.headers.authorization, BEARER);
  assert.deepEqual(sent.json, args.json);

  const expired = setup({ 'com.atproto.repo.deleteRecord': () => jsonResponse(400, fixture(import.meta.url, 'error-expired.json')) });
  const refused = await callTool(expired.module, 'api_request', args, expired.ctx);
  assert.match(refused.payload.error, /session expired before the request was accepted, so nothing was changed/);
  assert.equal(callsTo(expired.fetch, 'com.atproto.repo.deleteRecord').length, 1);

  const broken = setup({ 'com.atproto.repo.deleteRecord': () => jsonResponse(500, { error: 'InternalServerError' }) });
  const unknown = await callTool(broken.module, 'api_request', args, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(callsTo(broken.fetch, 'com.atproto.repo.deleteRecord').length, 1);
});

test('account, session and identity methods stay out of the generic tools, before any sign-in', async () => {
  const { module, fetch, ctx } = setup();
  const cases = [
    ['api_request', { method: 'POST', path: '/xrpc/com.atproto.server.createAppPassword', json: { name: 'x' } }],
    ['api_request', { method: 'POST', path: '/xrpc/com.atproto.server.deleteSession' }],
    ['api_request', { method: 'POST', path: '/xrpc/com.atproto.identity.updateHandle', json: { handle: 'x.example' } }],
    ['api_get', { path: '/xrpc/com.atproto.server.getServiceAuth', query: { aud: 'did:web:example.com' } }],
  ];
  for (const [tool, args] of cases) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, /account, session and identity methods .* are not available here: manage the account in the Bluesky app\. Nothing was sent\./);
  }
  const put = await callTool(module, 'api_request', { method: 'PUT', path: '/xrpc/com.atproto.repo.putRecord', json: {} }, ctx);
  assert.match(put.payload.error, /`method` must be one of "POST"/);
  assert.equal(fetch.calls.length, 0, 'not even a sign-in was sent');
});

const plain = (value) => JSON.parse(JSON.stringify(value));
// A 4 x 2 JPEG header: SOI, then a start-of-frame segment carrying the size.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x04, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);

test('the connection takes the handle and the app password under their own names', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.credentials), ['handle', 'apppassword']);
  assert.deepEqual(plain(module.requiredCredentials), [['handle', 'apppassword']]);
  assert.deepEqual(plain(module.accountPickers), []);
  assert.deepEqual(plain(module.tools.map((tool) => tool.name)), ['get_profile', 'list_my_posts', 'get_posts', 'create_post', 'delete_post', 'api_get', 'api_request']);
});

test('list_my_posts takes Bluesky\'s feed filters and keeps the filter in its cursor', async () => {
  const { module, fetch, ctx } = setup();
  const first = await callTool(module, 'list_my_posts', { filter: 'posts_with_media', limit: 10 }, ctx);
  const [read] = callsTo(fetch, 'app.bsky.feed.getAuthorFeed');
  assert.deepEqual(read.query, { actor: DID, limit: '10', filter: 'posts_with_media' });
  await callTool(module, 'list_my_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(callsTo(fetch, 'app.bsky.feed.getAuthorFeed')[1].query.filter, 'posts_with_media');
  const bad = await callTool(module, 'list_my_posts', { filter: 'everything' }, ctx);
  assert.match(bad.payload.error, /`filter` must be one of/);
});

test('create_post uploads up to four images in order, each with its alt text and aspect ratio', async () => {
  let blob = 0;
  const { module, fetch, ctx } = setup({
    media: (request) => bytesResponse(200, request.url.endsWith('.png') ? PNG : JPEG),
    'com.atproto.repo.uploadBlob': () => jsonResponse(200, { blob: { $type: 'blob', ref: { $link: `bafkrei${++blob}` }, mimeType: 'image/x', size: 10 } }),
  });
  const images = [
    { url: 'https://images.example.com/one.png', alt: 'First' },
    { url: 'https://images.example.com/two.jpg', alt: 'Second' },
    { url: 'https://images.example.com/three.png', alt: 'Third' },
  ];
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Three pictures', images }, ctx);
  assert.equal(isError, false, payload.error);
  const uploads = callsTo(fetch, 'com.atproto.repo.uploadBlob');
  assert.deepEqual(uploads.map((call) => call.headers['content-type']), ['image/png', 'image/jpeg', 'image/png']);
  const record = callsTo(fetch, 'com.atproto.repo.createRecord')[0].json.record;
  assert.deepEqual(record.embed.images.map((image) => [image.alt, image.image.ref.$link, image.aspectRatio]), [
    ['First', 'bafkrei1', { width: 2, height: 3 }],
    ['Second', 'bafkrei2', { width: 4, height: 2 }],
    ['Third', 'bafkrei3', { width: 2, height: 3 }],
  ]);
  assert.equal(payload.images.length, 3);

  const five = await callTool(module, 'create_post', { text: 'x', images: [...images, ...images].slice(0, 5) }, ctx);
  assert.match(five.payload.error, /`images` must have at most 4 items/);
  const both = await callTool(module, 'create_post', { text: 'x', images, link_card: { url: 'https://example.com' } }, ctx);
  assert.match(both.payload.error, /images or a link card, not both/);
  const nothing = await callTool(module, 'create_post', { text: '  ' }, ctx);
  assert.match(nothing.payload.error, /needs text, images or a link card/);
});

test('a link card takes its title, description and picture from the page, and uploads the picture', async () => {
  const page = '<html><head><meta charset="utf-8"><title>Fallback title</title>'
    + '<meta property="og:title" content="Release 2.0 &amp; more">'
    + '<meta name="description" content="Plain description">'
    + '<meta property="og:description" content="What is new in 2.0">'
    + '<meta property="og:image" content="/img/card.png"></head><body>Hello</body></html>';
  const { module, fetch, ctx } = setup({
    media: (request) => (request.url === 'https://example.com/release'
      ? bytesResponse(200, new TextEncoder().encode(page), { 'content-type': 'text/html' })
      : bytesResponse(200, PNG)),
  });
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Out now https://example.com/release', link_card: { url: 'https://example.com/release' } }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.slice(0, 2).map((call) => call.url), ['https://example.com/release', 'https://example.com/img/card.png'], 'the page and its picture are read before signing in');
  assert.equal(fetch.calls[0].headers.authorization, undefined);
  const record = callsTo(fetch, 'com.atproto.repo.createRecord')[0].json.record;
  assert.equal(record.embed.$type, 'app.bsky.embed.external');
  assert.deepEqual({ ...record.embed.external, thumb: undefined }, { uri: 'https://example.com/release', title: 'Release 2.0 & more', description: 'What is new in 2.0', thumb: undefined });
  assert.deepEqual(record.embed.external.thumb, fixture(import.meta.url, 'upload-blob.json').blob);
  assert.deepEqual(payload.linkCard, { url: 'https://example.com/release', title: 'Release 2.0 & more', picture: true });
});

test('a link card with its own title reads no page; a page that cannot be read stops the post', async () => {
  const given = setup();
  const { payload, isError } = await callTool(given.module, 'create_post', { text: 'See this', link_card: { url: 'http://example.com/a', title: 'A', description: 'B' } }, given.ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(given.fetch.calls.some((call) => call.origin === 'http://example.com'), false);
  assert.deepEqual(callsTo(given.fetch, 'com.atproto.repo.createRecord')[0].json.record.embed.external, { uri: 'http://example.com/a', title: 'A', description: 'B' });

  const broken = setup({ media: () => bytesResponse(404, new Uint8Array(0)) });
  const failed = await callTool(broken.module, 'create_post', { text: 'See this', link_card: { url: 'https://example.com/gone' } }, broken.ctx);
  assert.equal(failed.isError, true);
  assert.match(failed.payload.error, /The link card page URL answered HTTP 404\. Give link_card\.title and link_card\.description, or leave link_card out/);
  assert.equal(sessionCalls(broken.fetch).length, 0, 'nothing was sent to Bluesky');

  const noPicture = setup({
    media: (request) => (request.url.endsWith('/page')
      ? bytesResponse(200, new TextEncoder().encode('<head><meta property="og:title" content="T"><meta property="og:image" content="https://cdn.example.com/huge.png"></head>'))
      : bytesResponse(200, new Uint8Array(10), { 'content-length': '1000001' })),
  });
  const without = await callTool(noPicture.module, 'create_post', { text: 'x', link_card: { url: 'https://example.com/page' } }, noPicture.ctx);
  assert.equal(without.isError, false, without.payload.error);
  assert.match(without.payload.linkCard.note, /picture could not be used/);
  assert.equal(callsTo(noPicture.fetch, 'com.atproto.repo.createRecord')[0].json.record.embed.external.thumb, undefined);
});

test('reply_to makes a reply: the parent is read, and the thread root comes from it', async () => {
  const { module, fetch, ctx } = setup({ 'app.bsky.feed.getPosts': () => jsonResponse(200, fixture(import.meta.url, 'get-posts.json')) });
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Thanks!', reply_to: 'https://bsky.app/profile/bob.bsky.social/post/3lbreply1' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(callsTo(fetch, 'com.atproto.identity.resolveHandle').map((call) => call.query.handle), ['bob.bsky.social']);
  const [read] = callsTo(fetch, 'app.bsky.feed.getPosts');
  assert.equal(read.query.uris, 'at://did:plc:bobbobbobbobbobbobbobbob/app.bsky.feed.post/3lbreply1');
  assert.equal(read.headers.authorization, BEARER);
  const record = callsTo(fetch, 'com.atproto.repo.createRecord')[0].json.record;
  assert.deepEqual(record.reply, {
    root: { uri: `at://${DID}/app.bsky.feed.post/3lbk2nuxa7c2x`, cid: 'bafyreiaaa' },
    parent: { uri: 'at://did:plc:bobbobbobbobbobbobbobbob/app.bsky.feed.post/3lbreply1', cid: 'bafyreireplyparent' },
  });
  assert.equal(payload.replyTo, 'at://did:plc:bobbobbobbobbobbobbobbob/app.bsky.feed.post/3lbreply1');

  const own = setup({ 'app.bsky.feed.getPosts': () => jsonResponse(200, { posts: [{ uri: `at://${DID}/app.bsky.feed.post/3lbroot`, cid: 'bafyreiroot', record: { text: 'root' } }] }) });
  await callTool(own.module, 'create_post', { text: 'Part 2', reply_to: `at://${DID}/app.bsky.feed.post/3lbroot` }, own.ctx);
  assert.equal(callsTo(own.fetch, 'com.atproto.identity.resolveHandle').length, 0, 'a DID needs no lookup');
  assert.deepEqual(callsTo(own.fetch, 'com.atproto.repo.createRecord')[0].json.record.reply, {
    root: { uri: `at://${DID}/app.bsky.feed.post/3lbroot`, cid: 'bafyreiroot' },
    parent: { uri: `at://${DID}/app.bsky.feed.post/3lbroot`, cid: 'bafyreiroot' },
  });

  const gone = setup({ 'app.bsky.feed.getPosts': () => jsonResponse(200, { posts: [] }) });
  const missing = await callTool(gone.module, 'create_post', { text: 'x', reply_to: `at://${DID}/app.bsky.feed.post/3lbgone` }, gone.ctx);
  assert.match(missing.payload.error, /found no post at reply_to/);
  assert.equal(callsTo(gone.fetch, 'com.atproto.repo.createRecord').length, 0);
  const notPost = await callTool(gone.module, 'create_post', { text: 'x', reply_to: 'https://example.com/post/1' }, gone.ctx);
  assert.match(notPost.payload.error, /reply_to is not a Bluesky post/);
});

test('get_posts reads posts by link or URI with the session, resolving each handle once', async () => {
  const { module, fetch, ctx } = setup({ 'app.bsky.feed.getPosts': () => jsonResponse(200, fixture(import.meta.url, 'get-posts.json')) });
  const { payload, isError } = await callTool(module, 'get_posts', {
    posts: ['https://bsky.app/profile/bob.bsky.social/post/3lbreply1', 'at://bob.bsky.social/app.bsky.feed.post/3lbother', `at://${DID}/app.bsky.feed.post/3lbk2nuxa7c2x`],
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(callsTo(fetch, 'com.atproto.identity.resolveHandle').length, 1);
  const [read] = callsTo(fetch, 'app.bsky.feed.getPosts');
  assert.equal(new URL(read.url).searchParams.getAll('uris').length, 3);
  assert.deepEqual(payload.posts[0], {
    uri: 'at://did:plc:bobbobbobbobbobbobbobbob/app.bsky.feed.post/3lbreply1',
    cid: 'bafyreireplyparent',
    url: 'https://bsky.app/profile/bob.bsky.social/post/3lbreply1',
    author: 'bob.bsky.social',
    text: 'Replying to the launch thread',
    createdAt: '2026-11-21T08:00:00.000Z',
    likeCount: 4,
    repostCount: 0,
    replyCount: 0,
    quoteCount: 0,
    isReply: true,
  });
  assert.equal(payload.notFound.length, 2);
});

test('delete_post deletes the account\'s own post once, and refuses another account\'s before sending anything', async () => {
  const { module, fetch, ctx } = setup({ 'com.atproto.repo.deleteRecord': () => jsonResponse(200, fixture(import.meta.url, 'delete-record.json')) });
  const { payload, isError } = await callTool(module, 'delete_post', { post: 'https://bsky.app/profile/alice.bsky.social/post/3lbk2nuxa7c2x' }, ctx);
  assert.equal(isError, false, payload.error);
  const [sent] = callsTo(fetch, 'com.atproto.repo.deleteRecord');
  assert.deepEqual(sent.json, { repo: DID, collection: 'app.bsky.feed.post', rkey: '3lbk2nuxa7c2x' });
  assert.equal(sent.headers.authorization, BEARER);
  assert.deepEqual(payload, { deleted: true, uri: `at://${DID}/app.bsky.feed.post/3lbk2nuxa7c2x` });
  assert.equal(callsTo(fetch, 'com.atproto.identity.resolveHandle').length, 0, 'the account\'s own handle needs no lookup');

  const other = await callTool(module, 'delete_post', { post: 'https://bsky.app/profile/bob.bsky.social/post/3lbreply1' }, ctx);
  assert.equal(other.isError, true);
  assert.match(other.payload.error, /Only the connected account's own posts can be deleted, and this post belongs to bob\.bsky\.social\. Nothing was sent\./);
  assert.equal(callsTo(fetch, 'com.atproto.repo.deleteRecord').length, 1);

  const broken = setup({ 'com.atproto.repo.deleteRecord': () => jsonResponse(502, { error: 'BadGateway' }) });
  const unknown = await callTool(broken.module, 'delete_post', { post: `at://${DID}/app.bsky.feed.post/3lbk2nuxa7c2x` }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_posts', 'the deleted post itself is looked up, a reply as well as a post');
  assert.match(unknown.payload.error, /Once it is deleted, get_posts with the same link lists it under notFound\. Call get_posts to see whether it was, before trying again\./);
  assert.equal(callsTo(broken.fetch, 'com.atproto.repo.deleteRecord').length, 1);
});
