import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'eXampleXUserAccessToken123';
const credentials = { access_token: TOKEN, xusername: '@acme' };
const me = fixture(import.meta.url, 'users-me.json');
const posts = fixture(import.meta.url, 'user-posts.json');
const init = fixture(import.meta.url, 'media-initialize.json');
const finalizeImage = fixture(import.meta.url, 'media-finalize-image.json');
const finalizeVideo = fixture(import.meta.url, 'media-finalize-video.json');
const progress = fixture(import.meta.url, 'media-status-progress.json');
const succeeded = fixture(import.meta.url, 'media-status-succeeded.json');
const created = fixture(import.meta.url, 'create-post.json');
const MEDIA_ID = '1880028106020515840';
const MB = 1024 * 1024;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

function mp4(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

function setup(handler, { creds = credentials, signal } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  // Waits run at once in tests, and the module's clock moves on by the time each wait asked for.
  const advance = controlClock(context);
  context.setTimeout = (callback, ms) => {
    advance(ms ?? 0);
    return setTimeout(callback, 0);
  };
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, fetch, signal });
  return { module, fetch, ctx, logs, advance };
}

/** An X that answers by path; `statuses` are the STATUS replies in turn, the last one repeating. */
function x({ files = {}, finalize = finalizeImage, statuses = [succeeded], overrides = {} } = {}) {
  let statusIndex = 0;
  let nextPost = 0;
  return (request) => {
    const key = `${request.method} ${request.origin}${request.path}`;
    if (overrides[key]) return overrides[key](request);
    if (key === 'GET https://api.x.com/2/users/me') return jsonResponse(200, me);
    if (key === 'POST https://api.x.com/2/media/upload/initialize') return jsonResponse(200, init);
    if (key === `POST https://api.x.com/2/media/upload/${MEDIA_ID}/append`) return new Response(null, { status: 204 });
    if (key === `POST https://api.x.com/2/media/upload/${MEDIA_ID}/finalize`) return jsonResponse(200, finalize);
    if (key === 'GET https://api.x.com/2/media/upload') {
      const reply = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex++;
      return jsonResponse(200, reply);
    }
    if (key === 'POST https://api.x.com/2/media/metadata') return jsonResponse(200, { data: { id: MEDIA_ID, associated_metadata: {} } });
    if (key === 'POST https://api.x.com/2/tweets') {
      nextPost++;
      return jsonResponse(201, { data: { ...created.data, id: `18900000000000001${String(nextPost).padStart(2, '0')}` } });
    }
    if (request.origin === 'https://media.example.com' && files[request.path]) return bytesResponse(200, files[request.path], { 'content-type': 'application/octet-stream' });
    throw new Error(`unexpected request ${key}`);
  };
}

test('get_me reads the connected account with the token and trims it', async () => {
  const { module, fetch, ctx } = setup(x());
  const { payload, isError } = await callTool(module, 'get_me', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.match(fetch.calls[0].query['user.fields'], /subscription_type/);
  assert.deepEqual(payload, {
    id: '1500000000000000001',
    username: 'acme',
    name: 'Acme',
    url: 'https://x.com/acme',
    description: 'We make boxes.',
    followers: 1200,
    following: 80,
    posts: 456,
    listed: 7,
    verified: false,
    verifiedType: 'none',
    subscriptionType: 'None',
    protected: false,
    createdAt: '2022-03-01T12:00:00.000Z',
    profileImageUrl: me.data.profile_image_url,
  });
});

test('list_my_posts finds the account, reads its posts with their media, and the cursor goes on without asking again', async () => {
  const { module, fetch, ctx } = setup(x({ overrides: { 'GET https://api.x.com/2/users/1500000000000000001/tweets': () => jsonResponse(200, posts) } }));
  const first = await callTool(module, 'list_my_posts', { max_results: 5, exclude: ['retweets'] }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.deepEqual(fetch.calls.map((call) => call.path), ['/2/users/me', '/2/users/1500000000000000001/tweets']);
  assert.equal(fetch.calls[1].query.max_results, '5');
  assert.equal(fetch.calls[1].query.exclude, 'retweets');
  assert.equal(fetch.calls[1].query.expansions, 'attachments.media_keys');
  assert.deepEqual(first.payload.posts[0], {
    id: '1890000000000000002',
    url: 'https://x.com/i/web/status/1890000000000000002',
    text: 'Launch day! https://t.co/example',
    createdAt: '2026-11-20T15:00:00.000Z',
    likes: 31,
    reposts: 4,
    replies: 2,
    quotes: 1,
    bookmarks: 3,
    impressions: 2400,
    mediaCount: 1,
    media: [{ mediaKey: '3_1890000000000000100', type: 'photo', url: 'https://pbs.twimg.com/media/Gexample.jpg', altText: 'The new box' }],
  });
  assert.equal(first.payload.posts[1].replyTo, '1889999999999999999');
  assert.equal(first.payload.posts[1].conversationId, '1889999999999999999');

  await callTool(module, 'list_my_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls.length, 3, 'the cursor carries the account id');
  assert.equal(fetch.calls[2].query.pagination_token, posts.meta.next_token);
  assert.equal(fetch.calls[2].query.exclude, 'retweets');
});

test('get_post reads one post with its media', async () => {
  const { module, fetch, ctx } = setup(x({ overrides: { 'GET https://api.x.com/2/tweets/1890000000000000002': () => jsonResponse(200, fixture(import.meta.url, 'post.json')) } }));
  const { payload } = await callTool(module, 'get_post', { post_id: '1890000000000000002' }, ctx);
  assert.match(fetch.calls[0].query['media.fields'], /alt_text/);
  assert.equal(payload.media[0].width, 1200);
  assert.equal(payload.likes, 31);

  const missing = setup(() => jsonResponse(200, { errors: [{ detail: 'Could not find tweet with id: [1].', title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found' }] }));
  const none = await callTool(missing.module, 'get_post', { post_id: '1' }, missing.ctx);
  assert.match(none.payload.error, /X found no post with that id: Could not find tweet with id: \[1\]\./);
});

test('create_post with text alone is one request', async () => {
  const { module, fetch, ctx } = setup(x());
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Launch day!' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.x.com/2/tweets');
  assert.deepEqual(fetch.calls[0].json, { text: 'Launch day!' });
  assert.deepEqual(payload, { id: '1890000000000000101', url: 'https://x.com/i/web/status/1890000000000000101', account: 'acme' });
});

test('create_post with an image uploads it in chunks, adds its alt text, then posts with its media id', async () => {
  const { module, fetch, ctx } = setup(x({ files: { '/cover.png': PNG } }));
  const { payload, isError } = await callTool(module, 'create_post', {
    text: 'Launch day!',
    media_urls: ['https://media.example.com/cover.png'],
    media_alt_texts: ['The new box'],
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    'GET /cover.png',
    'POST /2/media/upload/initialize',
    `POST /2/media/upload/${MEDIA_ID}/append`,
    `POST /2/media/upload/${MEDIA_ID}/finalize`,
    'POST /2/media/metadata',
    'POST /2/tweets',
  ]);
  const [download, initialize, append, finalize, metadata, post] = fetch.calls;
  assert.equal(download.headers.authorization, undefined);
  assert.deepEqual(initialize.json, { media_type: 'image/png', total_bytes: PNG.length, media_category: 'tweet_image' });
  assert.deepEqual(append.json, { media: Buffer.from(PNG).toString('base64'), segment_index: 0 });
  assert.equal(finalize.body, undefined);
  assert.deepEqual(metadata.json, { id: MEDIA_ID, metadata: { alt_text: { text: 'The new box' } } });
  assert.deepEqual(post.json, { text: 'Launch day!', media: { media_ids: [MEDIA_ID] } });
  assert.deepEqual(payload.media, [{ mediaId: MEDIA_ID, type: 'image/png' }]);
});

test('upload_media sends a video in 4 MB segments and follows its processing until it is ready', async () => {
  const video = mp4(5 * MB);
  const { module, fetch, ctx } = setup(x({ files: { '/clip.mp4': video }, finalize: finalizeVideo, statuses: [progress, succeeded] }));
  const { payload, isError } = await callTool(module, 'upload_media', { url: 'https://media.example.com/clip.mp4', alt_text: 'A demo' }, ctx);
  assert.equal(isError, false, payload.error);
  const appends = fetch.calls.filter((call) => call.path.endsWith('/append'));
  assert.deepEqual(appends.map((call) => call.json.segment_index), [0, 1]);
  assert.deepEqual(appends.map((call) => Buffer.from(call.json.media, 'base64').length), [4 * MB, MB]);
  assert.deepEqual(fetch.calls.find((call) => call.path === '/2/media/upload/initialize').json, { media_type: 'video/mp4', total_bytes: 5 * MB, media_category: 'tweet_video' });
  const statuses = fetch.calls.filter((call) => call.path === '/2/media/upload');
  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses[0].query, { command: 'STATUS', media_id: MEDIA_ID });
  assert.equal(fetch.calls.at(-1).path, '/2/media/metadata', 'alt text once processing is done');
  assert.deepEqual(payload, { mediaId: MEDIA_ID, mediaKey: '7_1880028106020515840', type: 'video/mp4', category: 'tweet_video', bytes: 5 * MB, state: 'succeeded', ready: true });
});

test('media X cannot process, or that is still processing, posts nothing', async () => {
  const broken = setup(x({ files: { '/clip.mp4': mp4(1000) }, finalize: finalizeVideo, statuses: [fixture(import.meta.url, 'media-status-failed.json')] }));
  const failed = await callTool(broken.module, 'create_post', { text: 'Demo', media_urls: ['https://media.example.com/clip.mp4'] }, broken.ctx);
  assert.equal(failed.payload.error, 'X could not process the media: Invalid or Unsupported media, Reason: UnsupportedMedia. Nothing was posted.');
  assert.equal(broken.fetch.calls.some((call) => call.path === '/2/tweets'), false);

  const slow = setup(x({ files: { '/clip.mp4': mp4(1000) }, finalize: finalizeVideo, statuses: [progress] }));
  const pending = await callTool(slow.module, 'create_post', { text: 'Demo', media_urls: ['https://media.example.com/clip.mp4'], wait_seconds: 0 }, slow.ctx);
  assert.match(pending.payload.error, /The media is still being processed by X \(media_id 1880028106020515840\)\. Nothing was posted: check it with get_media_status/);
  assert.equal(slow.fetch.calls.some((call) => call.path === '/2/tweets'), false);

  const status = await callTool(slow.module, 'get_media_status', { media_id: MEDIA_ID }, slow.ctx);
  assert.deepEqual(status.payload, { mediaId: MEDIA_ID, mediaKey: '7_1880028106020515840', state: 'in_progress', ready: false, progressPercent: 40, checkAfterSecs: 2 });
});

test('waits for processing end 35 seconds into the call, and the media_id comes back to post with later', async () => {
  // The download takes 30 seconds; X asks to check every 2 seconds: reads at 32 and 34 seconds, then the wait ends.
  const slow = setup(x({
    finalize: finalizeVideo,
    statuses: [progress],
    overrides: {
      'GET https://media.example.com/clip.mp4': () => {
        slow.advance(30_000);
        return bytesResponse(200, mp4(1000), { 'content-type': 'video/mp4' });
      },
    },
  }));
  const uploaded = await callTool(slow.module, 'upload_media', { url: 'https://media.example.com/clip.mp4', alt_text: 'A demo', wait_seconds: 30 }, slow.ctx);
  assert.equal(uploaded.isError, false, uploaded.payload.error);
  assert.equal(slow.fetch.calls.filter((call) => call.path === '/2/media/upload').length, 2);
  assert.equal(uploaded.payload.ready, false);
  assert.equal(uploaded.payload.mediaId, MEDIA_ID);
  assert.match(uploaded.payload.note, /check get_media_status with media_id 1880028106020515840 until it is ready, then post it with media_ids\. Its alt text was not added yet/);
  assert.equal(slow.fetch.calls.some((call) => call.path === '/2/media/metadata'), false);

  const tooLong = await callTool(slow.module, 'upload_media', { url: 'https://media.example.com/clip.mp4', wait_seconds: 31 }, slow.ctx);
  assert.match(tooLong.payload.error, /wait_seconds/, 'waits are capped at 30 seconds');
});

test('media uploaded before a failure is named, so it can be posted with media_ids', async () => {
  const { module, fetch, ctx } = setup(x({ files: { '/a.png': PNG }, overrides: { 'GET https://media.example.com/gone.png': () => new Response(null, { status: 404 }) } }));
  const thread = await callTool(module, 'create_thread', {
    posts: [{ text: '1', media_urls: ['https://media.example.com/a.png'] }, { text: '2', media_urls: ['https://media.example.com/a.png', 'https://media.example.com/gone.png'] }],
  }, ctx);
  assert.equal(thread.isError, true);
  assert.match(thread.payload.error, /^The post 2 media 2 URL answered HTTP 404\. Nothing was posted\. Already uploaded, usable with media_ids for a day: post 1 media \(media_id 1880028106020515840\), post 2 media 1 \(media_id 1880028106020515840\)\.$/);
  assert.equal(fetch.calls.some((call) => call.path === '/2/tweets'), false);

  // A refused post keeps its uploads too, in a thread (the posts not sent yet) and on its own.
  let count = 0;
  const refusing = setup(x({ files: { '/a.png': PNG }, overrides: { 'POST https://api.x.com/2/tweets': () => (++count === 2 ? jsonResponse(403, fixture(import.meta.url, 'error-403-duplicate.json')) : jsonResponse(201, created)) } }));
  const broken = await callTool(refusing.module, 'create_thread', { posts: [{ text: '1', media_urls: ['https://media.example.com/a.png'] }, { text: '2', media_urls: ['https://media.example.com/a.png'] }] }, refusing.ctx);
  assert.match(broken.payload.error, /Post 2 was not: X refused the request \(HTTP 403\).* The rest were not sent\. Already uploaded, usable with media_ids for a day: post 2 media \(media_id 1880028106020515840\)\.$/);
  const duplicate = setup(x({ files: { '/a.png': PNG }, overrides: { 'POST https://api.x.com/2/tweets': () => jsonResponse(403, fixture(import.meta.url, 'error-403-duplicate.json')) } }));
  const single = await callTool(duplicate.module, 'create_post', { text: 'x', media_urls: ['https://media.example.com/a.png'] }, duplicate.ctx);
  assert.match(single.payload.error, /^X refused the request \(HTTP 403\): You are not allowed to create a Tweet with duplicate content\. Nothing was posted\. Already uploaded, usable with media_ids for a day: media \(media_id 1880028106020515840\)\.$/);
});

test('a thread starts no post after 45 seconds into the call, and says how to go on', async () => {
  // Uploading took 46 seconds: nothing is posted, and the uploads can be reused.
  const late = setup(x({
    files: { '/a.png': PNG },
    overrides: {
      [`POST https://api.x.com/2/media/upload/${MEDIA_ID}/finalize`]: () => {
        late.advance(46_000);
        return jsonResponse(200, finalizeImage);
      },
    },
  }));
  const none = await callTool(late.module, 'create_thread', { posts: [{ text: '1', media_urls: ['https://media.example.com/a.png'] }, { text: '2' }] }, late.ctx);
  assert.equal(none.isError, true);
  assert.equal(none.payload.error, 'Uploading the media took most of the call, so nothing was posted. Call create_thread again with media_ids. Already uploaded, usable with media_ids for a day: post 1 media (media_id 1880028106020515840).');
  assert.equal(late.fetch.calls.some((call) => call.path === '/2/tweets'), false);

  // The first post took until 46 seconds: the thread stops there and names what to do next.
  const cut = setup(x({
    overrides: {
      'POST https://api.x.com/2/tweets': () => {
        cut.advance(46_000);
        return jsonResponse(201, created);
      },
    },
  }));
  const partial = await callTool(cut.module, 'create_thread', { posts: [{ text: '1' }, { text: '2' }, { text: '3' }] }, cut.ctx);
  assert.equal(partial.isError, true);
  assert.equal(partial.payload.error, 'Posts 1 to 1 of 3 were published (1890000000000000009). The call ran short of time, so post 2 and the rest were not sent: publish them with create_thread and reply_to_post_id 1890000000000000009.');
  assert.equal(cut.fetch.calls.length, 1);
});

test('files X does not take are refused before any upload', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 not media');
  const big = new Uint8Array(5 * MB + 1);
  big.set(PNG);
  const { module, fetch, ctx } = setup(x({ files: { '/doc.pdf': pdf, '/big.png': big } }));
  const wrongType = await callTool(module, 'upload_media', { url: 'https://media.example.com/doc.pdf' }, ctx);
  assert.match(wrongType.payload.error, /did not return a JPEG, PNG, WebP or GIF image, or an MP4 or MOV video/);
  const tooBig = await callTool(module, 'create_post', { text: 'x', media_urls: ['https://media.example.com/big.png'] }, ctx);
  assert.match(tooBig.payload.error, /The media has 5,242,881 bytes; X takes up to 5,242,880 for a image\/png file\. Nothing was posted\./);
  assert.equal(fetch.calls.some((call) => call.origin === 'https://api.x.com'), false);
});

test('create_post checks what it was given, and sends replies, quotes, polls and labels as X names them', async () => {
  const { module, fetch, ctx } = setup(x());
  const empty = await callTool(module, 'create_post', {}, ctx);
  assert.match(empty.payload.error, /Give text, media, or both/);
  const pollAndMedia = await callTool(module, 'create_post', { text: 'x', media_ids: [MEDIA_ID], poll: { options: ['a', 'b'], duration_minutes: 60 } }, ctx);
  assert.match(pollAndMedia.payload.error, /a poll or media, not both/);
  const both = await callTool(module, 'create_post', { text: 'x', media_ids: [MEDIA_ID], media_urls: ['https://media.example.com/a.png'] }, ctx);
  assert.match(both.payload.error, /Give media_urls or media_ids, not both/);
  assert.equal(fetch.calls.length, 0);

  await callTool(module, 'create_post', {
    text: 'Which box?',
    reply_to_post_id: '1890000000000000002',
    quote_post_id: '1890000000000000001',
    poll: { options: ['Red', 'Blue'], duration_minutes: 1440 },
    reply_settings: 'following',
    made_with_ai: true,
    paid_partnership: false,
  }, ctx);
  assert.deepEqual(fetch.calls[0].json, {
    text: 'Which box?',
    reply: { in_reply_to_tweet_id: '1890000000000000002' },
    quote_tweet_id: '1890000000000000001',
    poll: { options: ['Red', 'Blue'], duration_minutes: 1440 },
    reply_settings: 'following',
    made_with_ai: true,
    paid_partnership: false,
  });

  await callTool(module, 'create_post', { media_ids: [MEDIA_ID] }, ctx);
  assert.deepEqual(fetch.calls[1].json, { media: { media_ids: [MEDIA_ID] } });
});

test('create_thread uploads every file first, then posts each reply to the one before', async () => {
  const { module, fetch, ctx } = setup(x({ files: { '/a.png': PNG } }));
  const { payload, isError } = await callTool(module, 'create_thread', {
    posts: [{ text: 'A thread 1/3' }, { text: '2/3', media_urls: ['https://media.example.com/a.png'] }, { text: '3/3' }],
    reply_to_post_id: '1890000000000000002',
  }, ctx);
  assert.equal(isError, false, payload.error);
  const tweets = fetch.calls.filter((call) => call.path === '/2/tweets');
  assert.equal(fetch.calls.findIndex((call) => call.path === '/2/tweets') > fetch.calls.findIndex((call) => call.path.endsWith('/finalize')), true, 'media before posts');
  assert.deepEqual(tweets.map((call) => call.json), [
    { text: 'A thread 1/3', reply: { in_reply_to_tweet_id: '1890000000000000002' } },
    { text: '2/3', media: { media_ids: [MEDIA_ID] }, reply: { in_reply_to_tweet_id: '1890000000000000101' } },
    { text: '3/3', reply: { in_reply_to_tweet_id: '1890000000000000102' } },
  ]);
  assert.deepEqual(payload, {
    posts: [
      { id: '1890000000000000101', url: 'https://x.com/i/web/status/1890000000000000101' },
      { id: '1890000000000000102', url: 'https://x.com/i/web/status/1890000000000000102' },
      { id: '1890000000000000103', url: 'https://x.com/i/web/status/1890000000000000103' },
    ],
    url: 'https://x.com/i/web/status/1890000000000000101',
    count: 3,
    replyTo: '1890000000000000002',
  });

  const empty = await callTool(module, 'create_thread', { posts: [{ text: 'a' }, {}] }, ctx);
  assert.match(empty.payload.error, /Post 2 has no text and no media\. Nothing was posted\./);
});

test('a thread that breaks off names the posts already published, and is never retried', async () => {
  let count = 0;
  const duplicate = setup(x({ overrides: { 'POST https://api.x.com/2/tweets': () => (++count === 2 ? jsonResponse(403, fixture(import.meta.url, 'error-403-duplicate.json')) : jsonResponse(201, created)) } }));
  const refused = await callTool(duplicate.module, 'create_thread', { posts: [{ text: '1' }, { text: '2' }, { text: '3' }] }, duplicate.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /^Posts 1 to 1 of 3 were published \(1890000000000000009\)\. Post 2 was not: X refused the request \(HTTP 403\): You are not allowed to create a Tweet with duplicate content\. The rest were not sent\.$/);
  assert.equal(duplicate.fetch.calls.length, 2);

  let calls = 0;
  const lost = setup(x({ overrides: { 'POST https://api.x.com/2/tweets': () => (++calls === 3 ? jsonResponse(503, { title: 'Service Unavailable' }) : jsonResponse(201, created)) } }));
  const unknown = await callTool(lost.module, 'create_thread', { posts: [{ text: '1' }, { text: '2' }, { text: '3' }] }, lost.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_my_posts');
  assert.match(unknown.payload.error, /^Posts 1 to 2 of 3 were published \(1890000000000000009, 1890000000000000009\)\. For post 3: X answered HTTP 503/);
  assert.equal(lost.fetch.calls.length, 3);
});

test('delete_post deletes one post; an unclear post or delete is unknown, sent once', async () => {
  const { module, fetch, ctx } = setup(x({ overrides: { 'DELETE https://api.x.com/2/tweets/1890000000000000009': () => jsonResponse(200, fixture(import.meta.url, 'delete-post.json')) } }));
  const deleted = await callTool(module, 'delete_post', { post_id: '1890000000000000009' }, ctx);
  assert.deepEqual(deleted.payload, { deleted: true, id: '1890000000000000009' });
  assert.equal(fetch.calls[0].method, 'DELETE');

  for (const respond of [() => { throw new TypeError('fetch failed'); }, () => jsonResponse(502, { title: 'Bad Gateway' })]) {
    for (const [tool, args, check] of [['create_post', { text: 'x' }, 'list_my_posts'], ['delete_post', { post_id: '1' }, 'get_post']]) {
      const broken = setup(respond);
      const result = await callTool(broken.module, tool, args, broken.ctx);
      assert.equal(result.payload.outcome, 'unknown', `${tool}: ${result.payload.error}`);
      assert.equal(result.payload.check, check);
      assert.equal(broken.fetch.calls.length, 1);
    }
  }

  const noId = setup(() => jsonResponse(201, { data: {} }));
  const unclear = await callTool(noId.module, 'create_post', { text: 'x' }, noId.ctx);
  assert.equal(unclear.payload.outcome, 'unknown');
});

test('X\'s refusals keep its words: a missing media permission, a bad token, a rate limit', async () => {
  const scope = setup(x({ files: { '/a.png': PNG }, overrides: { 'POST https://api.x.com/2/media/upload/initialize': () => jsonResponse(403, fixture(import.meta.url, 'error-403-scope.json')) } }));
  const refused = await callTool(scope.module, 'create_post', { text: 'x', media_urls: ['https://media.example.com/a.png'] }, scope.ctx);
  assert.match(refused.payload.error, /X refused the media upload: the connection needs the media\.write permission/);
  assert.equal(scope.fetch.calls.some((call) => call.path === '/2/tweets'), false);

  const bad = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const auth = await callTool(bad.module, 'get_me', {}, bad.ctx);
  assert.match(auth.payload.error, /X rejected the credentials \(HTTP 401\): Unauthorized\. Check that the X access token is correct and still active\./);

  const limited = setup(() => textResponse(429, 'Too Many Requests', { 'retry-after': '900' }));
  const rate = await callTool(limited.module, 'create_post', { text: 'x' }, limited.ctx);
  assert.equal(rate.payload.retryAfter, 900);
  assert.equal(rate.payload.outcome, undefined, 'a 429 is a clear no');
});

test('api_get and api_request stay under /2/', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: [] }));
  const search = await callTool(module, 'api_get', { path: '/2/tweets/search/recent', query: { query: 'from:acme', max_results: 10 } }, ctx);
  assert.equal(search.isError, false, search.payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.x.com/2/tweets/search/recent?query=from%3Aacme&max_results=10');
  const outside = await callTool(module, 'api_request', { method: 'POST', path: '/oauth2/token', json: {} }, ctx);
  assert.match(outside.payload.error, /The path must start with \/2\//);
  assert.equal(fetch.calls.length, 1);
});

test('log lines carry no token, text or URL', async () => {
  const { module, ctx, logs } = setup(x({ files: { '/a.png': PNG } }));
  await callTool(module, 'create_post', { text: 'Secret plan', media_urls: ['https://media.example.com/a.png'] }, ctx);
  assert.ok(logs.length >= 5);
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /Secret|media\.example/);
    assert.match(line, /^twitter create_post (media )?(GET|POST) \d+ \d+ms$/);
  }
});
