import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'act.exampleTikTokToken123';
const credentials = { access_token: TOKEN, tiktokusername: 'Acme', openid: '-000exampleOpenId0000000000000000000' };
const creator = fixture(import.meta.url, 'creator-info.json');
const fileInit = fixture(import.meta.url, 'video-init-file.json');
const pullInit = fixture(import.meta.url, 'video-init-pull.json');
const contentInit = fixture(import.meta.url, 'content-init.json');
const processing = fixture(import.meta.url, 'status-processing.json');
const complete = fixture(import.meta.url, 'status-complete.json');
const failed = fixture(import.meta.url, 'status-failed.json');
const MB = 1024 * 1024;
const VIDEO_URL = 'https://media.example.com/clip.mp4';

/** A fake MP4 of `size` bytes: an ftyp box, then zeros. */
function mp4(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  return bytes;
}

/** TikTok's JSON bodies go as UTF-8 bytes (with "charset=UTF-8"): read them back for the assertions. */
function withJson(handler) {
  return (request) => {
    if (request.json === undefined && ArrayBuffer.isView(request.body) && /json/.test(request.headers['content-type'] ?? '')) {
      request.json = JSON.parse(new TextDecoder().decode(request.body));
    }
    return handler(request);
  };
}

function setup(handler, { creds = credentials, signal } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  // Polling waits run at once in tests, and the module's clock moves on by the time each wait asked for.
  const advance = controlClock(context);
  context.setTimeout = (callback, ms) => {
    advance(ms ?? 0);
    return setTimeout(callback, 0);
  };
  const fetch = fakeFetch(withJson(handler));
  const { ctx, logs } = makeContext({ credentials: creds, fetch, signal });
  return { module, fetch, ctx, logs, advance };
}

/** A TikTok that answers by path; `status` is a list of status replies, the last one repeating. */
function tiktok({ video, status = [complete], overrides = {} } = {}) {
  let statusIndex = 0;
  return (request) => {
    const key = `${request.method} ${request.origin}${request.path}`;
    if (overrides[key]) return overrides[key](request);
    if (key === 'POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/') return jsonResponse(200, creator);
    if (key === 'POST https://open.tiktokapis.com/v2/post/publish/video/init/') return jsonResponse(200, request.json.source_info.source === 'FILE_UPLOAD' ? fileInit : pullInit);
    if (key === 'POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/') return jsonResponse(200, request.json.source_info.source === 'FILE_UPLOAD' ? fileInit : pullInit);
    if (key === 'POST https://open.tiktokapis.com/v2/post/publish/content/init/') return jsonResponse(200, contentInit);
    if (key === 'PUT https://open-upload.tiktokapis.com/video/') {
      const [, last, total] = /bytes \d+-(\d+)\/(\d+)/.exec(request.headers['content-range']);
      return new Response(null, { status: Number(last) + 1 === Number(total) ? 201 : 206 });
    }
    if (key === 'POST https://open.tiktokapis.com/v2/post/publish/status/fetch/') {
      const reply = status[Math.min(statusIndex, status.length - 1)];
      statusIndex++;
      return typeof reply === 'function' ? reply(request) : jsonResponse(200, reply);
    }
    if (key === 'GET https://open.tiktokapis.com/v2/user/info/') return jsonResponse(200, fixture(import.meta.url, 'user-info.json'));
    if (request.url === VIDEO_URL) return bytesResponse(200, video ?? mp4(MB), { 'content-type': 'video/mp4' });
    throw new Error(`unexpected request ${key}`);
  };
}

test('get_creator_info asks TikTok for the creator\'s posting options with the token', async () => {
  const { module, fetch, ctx } = setup(tiktok());
  const { payload, isError } = await callTool(module, 'get_creator_info', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers['content-type'], 'application/json; charset=UTF-8');
  assert.deepEqual(payload, {
    username: 'acme.official',
    nickname: 'Acme',
    avatarUrl: creator.data.creator_avatar_url,
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: true,
    maxVideoPostDurationSec: 300,
    account: 'acme.official',
  });
});

test('an error TikTok sends with HTTP 200 is a failure with its code', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'creator-info-capped.json')));
  const { payload, isError } = await callTool(module, 'get_creator_info', {}, ctx);
  assert.equal(isError, true);
  assert.equal(payload.vendorCode, 'spam_risk_too_many_posts');
  assert.equal(payload.error, 'TikTok refused the request (spam_risk_too_many_posts): The user has reached the maximum number of posts allowed in a day.');

  const posting = setup(() => jsonResponse(200, fixture(import.meta.url, 'creator-info-capped.json')));
  const refused = await callTool(posting.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, posting.ctx);
  assert.match(refused.payload.error, /Nothing was changed\.$/);
  assert.equal(posting.fetch.calls.length, 1, 'nothing after the creator check');
});

test('post_video FILE_UPLOAD checks the creator, downloads the video, uploads it in one chunk and waits for the post', async () => {
  const video = mp4(MB);
  const { module, fetch, ctx } = setup(tiktok({ video }));
  const { payload, isError } = await callTool(module, 'post_video', {
    video_url: VIDEO_URL,
    caption: 'Behind the scenes #studio @acme',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_stitch: false,
    is_aigc: true,
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.origin}${call.path}`), [
    'POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
    'GET https://media.example.com/clip.mp4',
    'POST https://open.tiktokapis.com/v2/post/publish/video/init/',
    'PUT https://open-upload.tiktokapis.com/video/',
    'POST https://open.tiktokapis.com/v2/post/publish/status/fetch/',
  ]);
  const [, download, init, upload, status] = fetch.calls;
  assert.equal(download.headers.authorization, undefined);
  assert.deepEqual(init.json, {
    post_info: {
      title: 'Behind the scenes #studio @acme',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_stitch: true,
      is_aigc: true,
    },
    source_info: { source: 'FILE_UPLOAD', video_size: MB, chunk_size: MB, total_chunk_count: 1 },
  });
  assert.equal(upload.url, fileInit.data.upload_url);
  assert.equal(upload.headers.authorization, undefined, 'the upload address carries its own token');
  assert.equal(upload.headers['content-range'], `bytes 0-${MB - 1}/${MB}`);
  assert.equal(upload.headers['content-type'], 'video/mp4');
  assert.equal(upload.body.length, MB);
  assert.deepEqual(status.json, { publish_id: fileInit.data.publish_id });
  assert.equal(payload.publishId, fileInit.data.publish_id);
  assert.equal(payload.status, 'PUBLISH_COMPLETE');
  assert.equal(payload.published, true);
  assert.equal(payload.account, 'acme.official');
  assert.equal(payload.privacyLevel, 'PUBLIC_TO_EVERYONE');
  assert.equal(payload.postIds, undefined, 'a post id beyond 2^53 is never passed on rounded');
  assert.match(payload.note, /stitches turned off for every post/);
  assert.match(payload.note, /post id is too long to pass on exactly/);
});

test('a larger video goes in 10 MB chunks, the last one holding the rest', async () => {
  const size = 25 * MB + 123;
  const { module, fetch, ctx } = setup(tiktok({ video: mp4(size) }));
  const { payload, isError } = await callTool(module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, ctx);
  assert.equal(isError, false, payload.error);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/video/init/');
  assert.deepEqual(init.json.source_info, { source: 'FILE_UPLOAD', video_size: size, chunk_size: 10 * MB, total_chunk_count: 2 });
  const puts = fetch.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(puts.map((call) => call.headers['content-range']), [`bytes 0-${10 * MB - 1}/${size}`, `bytes ${10 * MB}-${size - 1}/${size}`]);
  assert.deepEqual(puts.map((call) => call.body.length), [10 * MB, size - 10 * MB]);
});

test('post_video PULL_FROM_URL lets TikTok download the video and follows the status until it is done', async () => {
  const { module, fetch, ctx } = setup(tiktok({ status: [processing, processing, complete] }));
  const { payload, isError } = await callTool(module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY', wait_seconds: 30 }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.some((call) => call.url === VIDEO_URL), false, 'TikTok downloads it, not the connector');
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/video/init/');
  assert.deepEqual(init.json.source_info, { source: 'PULL_FROM_URL', video_url: VIDEO_URL });
  assert.equal(fetch.calls.filter((call) => call.path === '/v2/post/publish/status/fetch/').length, 3);
  assert.equal(payload.status, 'PUBLISH_COMPLETE');
});

test('a post still processing when the wait ends says to check later, never to post again', async () => {
  const quick = setup(tiktok({ status: [processing] }));
  const now = await callTool(quick.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY', wait_seconds: 0 }, quick.ctx);
  assert.equal(now.isError, false);
  assert.equal(now.payload.status, 'PROCESSING_DOWNLOAD');
  assert.equal(now.payload.published, false);
  assert.match(now.payload.note, /TikTok is still processing it, which often takes a minute or more\. Call get_post_status with publish_id v_pub_url~v2-1\.7300000000000000001 \(it can wait up to 30 seconds\) to follow it; do not post it again\./);
  assert.equal(quick.fetch.calls.filter((call) => call.path === '/v2/post/publish/status/fetch/').length, 1);

  const controller = new AbortController();
  const cancelled = setup(tiktok({ status: [() => { controller.abort(); return jsonResponse(200, processing); }] }), { signal: controller.signal });
  const stopped = await callTool(cancelled.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY', wait_seconds: 30 }, cancelled.ctx);
  assert.match(stopped.payload.note, /Stopped waiting because the call was cancelled\./);
  assert.equal(cancelled.fetch.calls.filter((call) => call.path === '/v2/post/publish/status/fetch/').length, 1);

  const unreadable = setup(tiktok({ status: [() => jsonResponse(500, { error: { code: 'internal_error', message: 'busy' } })] }));
  const sent = await callTool(unreadable.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY' }, unreadable.ctx);
  assert.equal(sent.isError, false, 'the post went out: a failed status read is no reason to post again');
  assert.equal(sent.payload.status, 'UNKNOWN');
  assert.match(sent.payload.note, /The post was sent, but its status could not be read/);
  assert.match(sent.payload.note, /Call get_post_status with publish_id v_pub_url~v2-1\.7300000000000000001 to see whether TikTok published it; do not post it again\./);

  const tooLong = await callTool(quick.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY', wait_seconds: 31 }, quick.ctx);
  assert.match(tooLong.payload.error, /wait_seconds/, 'waits are capped at 30 seconds');
});

test('a post waits only until 35 seconds into the call, so its publish_id reaches the host before the call ends', async () => {
  // The upload takes 21 seconds: status reads at 21, 26 and 31 seconds; the next one would start after 35.
  const slow = setup(tiktok({
    status: [processing],
    overrides: {
      'PUT https://open-upload.tiktokapis.com/video/': () => {
        slow.advance(21_000);
        return new Response(null, { status: 201 });
      },
    },
  }));
  const posted = await callTool(slow.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY', wait_seconds: 30 }, slow.ctx);
  assert.equal(posted.isError, false, posted.payload.error);
  assert.equal(slow.fetch.calls.filter((call) => call.path === '/v2/post/publish/status/fetch/').length, 3);
  assert.equal(posted.payload.publishId, fileInit.data.publish_id);
  assert.equal(posted.payload.status, 'PROCESSING_DOWNLOAD');
  assert.match(posted.payload.note, /Call get_post_status with publish_id v_pub_file~v2-1\.7300000000000000000/);

  // An upload that took 36 seconds returns at once with the publish_id, without a status read.
  const slower = setup(tiktok({
    overrides: {
      'PUT https://open-upload.tiktokapis.com/video/': () => {
        slower.advance(36_000);
        return new Response(null, { status: 201 });
      },
    },
  }));
  const late = await callTool(slower.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, slower.ctx);
  assert.equal(late.isError, false, late.payload.error);
  assert.equal(slower.fetch.calls.some((call) => call.path === '/v2/post/publish/status/fetch/'), false);
  assert.equal(late.payload.status, 'UNKNOWN');
  assert.match(late.payload.note, /^Sending it took most of the call, so its status was not read\. Call get_post_status with publish_id v_pub_file~v2-1\.7300000000000000000 to see whether TikTok published it; do not post it again\.$/);
});

test('get_post_status follows a post for as long as asked, and on its own reads once', async () => {
  const { module, fetch, ctx } = setup(tiktok({ status: [processing, processing, complete] }));
  const once = await callTool(module, 'get_post_status', { publish_id: 'v_pub_url~v2-1.7300000000000000001' }, ctx);
  assert.equal(once.payload.status, 'PROCESSING_DOWNLOAD');
  assert.match(once.payload.note, /still processing it: check again in a little while; do not post it again/);
  assert.equal(fetch.calls.length, 1);
  const waited = await callTool(module, 'get_post_status', { publish_id: 'v_pub_url~v2-1.7300000000000000001', wait_seconds: 30 }, ctx);
  assert.equal(waited.payload.status, 'PUBLISH_COMPLETE');
  assert.equal(waited.payload.published, true);
  assert.equal(fetch.calls.length, 3, 'one more processing read, then the finished one');
});

test('a failed post says why, with TikTok\'s reason', async () => {
  const { module, ctx } = setup(tiktok({ status: [failed] }));
  const { payload, isError } = await callTool(module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.vendorCode, 'frame_rate_check_failed');
  assert.match(payload.error, /TikTok did not publish it: the frame rate is not supported \(23 to 60 FPS\) \(publish_id v_pub_file~v2-1\.7300000000000000000\)\. Nothing was posted\./);
});

test('the privacy level must be one the creator may use, and branded content cannot be private', async () => {
  const { module, fetch, ctx } = setup(tiktok());
  const notAllowed = await callTool(module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'FOLLOWER_OF_CREATOR' }, ctx);
  assert.match(notAllowed.payload.error, /cannot post with privacy_level FOLLOWER_OF_CREATOR: choose one of PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY/);
  const missing = await callTool(module, 'post_photos', { image_urls: ['https://media.example.com/a.jpg'] }, ctx);
  assert.match(missing.payload.error, /privacy_level is required for a direct post/);
  const branded = await callTool(module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY', brand_content_toggle: true }, ctx);
  assert.match(branded.payload.error, /Branded content \(brand_content_toggle\) cannot be private/);
  assert.equal(fetch.calls.every((call) => call.path === '/v2/post/publish/creator_info/query/'), true, 'only the creator checks were sent');
});

test('MEDIA_UPLOAD sends the video to the creator\'s inbox without the direct-post settings', async () => {
  const { module, fetch, ctx } = setup(tiktok({ status: [{ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } }] }));
  const { payload, isError } = await callTool(module, 'post_video', { video_url: VIDEO_URL, post_mode: 'MEDIA_UPLOAD' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.some((call) => call.path === '/v2/post/publish/creator_info/query/'), false);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/inbox/video/init/');
  assert.deepEqual(Object.keys(init.json), ['source_info']);
  assert.equal(payload.sentToInbox, true);
  assert.equal(payload.published, false);
});

test('MEDIA_UPLOAD refuses a caption or post settings it could not send, before anything is sent', async () => {
  const { module, fetch, ctx } = setup(tiktok());
  const video = await callTool(module, 'post_video', { video_url: VIDEO_URL, post_mode: 'MEDIA_UPLOAD', caption: 'Hello', is_aigc: true }, ctx);
  assert.equal(video.isError, true);
  assert.equal(video.payload.error, 'TikTok\'s inbox upload (MEDIA_UPLOAD) takes no caption, is_aigc: the creator sets the caption and every post setting in the TikTok app when they post the draft. Leave them out, or use DIRECT_POST. Nothing was posted.');
  const photos = await callTool(module, 'post_photos', { image_urls: ['https://media.example.com/a.jpg'], post_mode: 'MEDIA_UPLOAD', privacy_level: 'SELF_ONLY', auto_add_music: false }, ctx);
  assert.match(photos.payload.error, /takes no privacy_level, auto_add_music: the creator sets privacy, comments, music and the branded-content labels in the TikTok app/);
  assert.equal(fetch.calls.length, 0);

  const draft = await callTool(module, 'post_photos', { image_urls: ['https://media.example.com/a.jpg'], post_mode: 'MEDIA_UPLOAD', title: 'Draft', description: 'For the app' }, ctx);
  assert.equal(draft.isError, false, draft.payload.error);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/content/init/');
  assert.deepEqual(init.json.post_info, { title: 'Draft', description: 'For the app' }, 'title and description go to the inbox too');
  assert.equal(init.json.post_mode, 'MEDIA_UPLOAD');

  const noScope = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/': () => jsonResponse(401, fixture(import.meta.url, 'error-401-scope.json')) } }));
  const refused = await callTool(noScope.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', post_mode: 'MEDIA_UPLOAD' }, noScope.ctx);
  assert.match(refused.payload.error, /^TikTok refused the inbox upload: MEDIA_UPLOAD needs the video\.upload permission.*\(HTTP 401\)\. TikTok said: "The user did not authorize the scope required for completing this request\."\. Nothing was changed\.$/);
});

test('post_photos posts the photo URLs for TikTok to download, with the cover and music settings', async () => {
  const { module, fetch, ctx } = setup(tiktok());
  const images = ['https://media.example.com/a.jpg', 'https://media.example.com/b.jpg'];
  const { payload, isError } = await callTool(module, 'post_photos', {
    image_urls: images,
    title: 'Launch day',
    description: 'Two looks at the new box #unboxing',
    privacy_level: 'MUTUAL_FOLLOW_FRIENDS',
    cover_index: 1,
    is_aigc: false,
  }, ctx);
  assert.equal(isError, false, payload.error);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/content/init/');
  assert.deepEqual(init.json, {
    media_type: 'PHOTO',
    post_mode: 'DIRECT_POST',
    post_info: { title: 'Launch day', description: 'Two looks at the new box #unboxing', privacy_level: 'MUTUAL_FOLLOW_FRIENDS', auto_add_music: true },
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 1, photo_images: images },
    is_aigc: false,
  });
  assert.equal(payload.publishId, contentInit.data.publish_id);
  assert.equal(payload.photos, 2);

  const past = await callTool(module, 'post_photos', { image_urls: images, privacy_level: 'SELF_ONLY', cover_index: 2 }, ctx);
  assert.match(past.payload.error, /cover_index 2 points past the last photo/);
});

test('a write without a clear answer is unknown only once the post may have started', async () => {
  // PULL_FROM_URL starts the post at init: an unclear init is unknown, sent once, with no publish_id to follow.
  const pull = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(502, { error: { code: 'internal_error' } }) } }));
  const unknown = await callTool(pull.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY' }, pull.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_post_status');
  assert.match(unknown.payload.error, /TikTok sent back no publish_id, so get_post_status has nothing to look up: before posting again, look for the post on the creator's TikTok profile in the TikTok app/);
  assert.equal(pull.fetch.calls.filter((call) => call.path.endsWith('/init/')).length, 1);

  const photos = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/content/init/': () => { throw new TypeError('fetch failed'); } } }));
  const photoUnknown = await callTool(photos.module, 'post_photos', { image_urls: ['https://media.example.com/a.jpg'], privacy_level: 'SELF_ONLY' }, photos.ctx);
  assert.equal(photoUnknown.payload.outcome, 'unknown');
  assert.match(photoUnknown.payload.error, /no publish_id.*on the creator's TikTok profile/);
  assert.equal(photos.fetch.calls.filter((call) => call.path.endsWith('/init/')).length, 1);

  const inbox = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/': () => jsonResponse(504, {}) } }));
  const inboxUnknown = await callTool(inbox.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', post_mode: 'MEDIA_UPLOAD' }, inbox.ctx);
  assert.match(inboxUnknown.payload.error, /look for the post among the drafts TikTok sends to the creator's inbox in the TikTok app/);

  // A FILE_UPLOAD posts after its last chunk: a failed init or middle chunk posts nothing.
  const init = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(503, {}) } }));
  const notStarted = await callTool(init.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, init.ctx);
  assert.equal(notStarted.payload.outcome, undefined);
  assert.match(notStarted.payload.error, /Nothing was changed\./);

  const middle = setup(tiktok({
    video: mp4(25 * MB),
    overrides: {
      'PUT https://open-upload.tiktokapis.com/video/': (request) => (request.headers['content-range'].startsWith('bytes 0-') ? jsonResponse(500, {}) : new Response(null, { status: 201 })),
    },
  }));
  const stoppedEarly = await callTool(middle.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, middle.ctx);
  assert.equal(stoppedEarly.payload.outcome, undefined);
  assert.equal(middle.fetch.calls.filter((call) => call.method === 'PUT').length, 1);

  // The last chunk is what posts a FILE_UPLOAD: its unclear answer names the publish_id to check with.
  const last = setup(tiktok({ overrides: { 'PUT https://open-upload.tiktokapis.com/video/': () => jsonResponse(503, {}) } }));
  const lastUnknown = await callTool(last.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, last.ctx);
  assert.equal(lastUnknown.payload.outcome, 'unknown');
  assert.equal(lastUnknown.payload.check, 'get_post_status');
  assert.equal(lastUnknown.payload.error, 'TikTok answered HTTP 503, so it is not known whether the change was made. The post\'s publish_id is v_pub_file~v2-1.7300000000000000000. Call get_post_status to see whether it was, before trying again.');
  assert.equal(last.fetch.calls.filter((call) => call.method === 'PUT').length, 1);
  assert.equal(last.fetch.calls.some((call) => call.path === '/v2/post/publish/status/fetch/'), false);
});

test('an upload address on an unknown host, or a file that is not a video, posts nothing', async () => {
  const elsewhere = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(200, { data: { publish_id: 'x1', upload_url: 'https://uploads.example.net/video/?id=1' }, error: { code: 'ok' } }) } }));
  const host = await callTool(elsewhere.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, elsewhere.ctx);
  assert.match(host.payload.error, /uploaded to uploads\.example\.net, an address this connector does not send files to\. Nothing was posted\./);
  assert.equal(elsewhere.fetch.calls.some((call) => call.method === 'PUT'), false);

  const notVideo = setup(tiktok({ video: new TextEncoder().encode('<html>not a video</html>') }));
  const refused = await callTool(notVideo.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, notVideo.ctx);
  assert.match(refused.payload.error, /did not return an MP4, MOV or WebM video\. Nothing was posted\./);
  assert.equal(notVideo.fetch.calls.some((call) => call.path.endsWith('/init/')), false);

  const blocked = setup(tiktok({ overrides: {} }));
  blocked.ctx.fetch = fakeFetch(withJson((request) => (request.url === VIDEO_URL ? (() => { throw refusal(); })() : tiktok()(request))));
  const refusedUrl = await callTool(blocked.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, blocked.ctx);
  assert.match(refusedUrl.payload.error, /The video URL was refused/);
});

test('TikTok\'s refusals keep its words: an unaudited app, a bad token, a rate limit', async () => {
  const unaudited = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(403, fixture(import.meta.url, 'error-403-unaudited.json')) } }));
  const refused = await callTool(unaudited.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'PUBLIC_TO_EVERYONE' }, unaudited.ctx);
  assert.equal(refused.payload.status, 403);
  assert.match(refused.payload.error, /an app TikTok has not audited may post only with privacy_level SELF_ONLY/);
  assert.equal(refused.payload.outcome, undefined, 'a 403 is a clear no');

  const invalid = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const auth = await callTool(invalid.module, 'get_creator_info', {}, invalid.ctx);
  assert.match(auth.payload.error, /TikTok rejected the credentials \(HTTP 401\): The access token is invalid or not found in the request\. Check that the TikTok access token is correct/);

  const limited = setup(() => textResponse(429, 'rate limited', { 'retry-after': '60' }));
  const rate = await callTool(limited.module, 'get_post_status', { publish_id: 'v_pub_url~v2-1.1' }, limited.ctx);
  assert.equal(rate.payload.retryAfter, 60);
});

test('get_post_status and get_profile read what they say', async () => {
  const { module, fetch, ctx } = setup(tiktok({ status: [{ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000099'] }, error: { code: 'ok' } }] }));
  const status = await callTool(module, 'get_post_status', { publish_id: 'v_pub_url~v2-1.7300000000000000001' }, ctx);
  assert.deepEqual(status.payload, { publishId: 'v_pub_url~v2-1.7300000000000000001', status: 'PUBLISH_COMPLETE', postIds: ['7300000000000000099'], published: true });

  const profile = await callTool(module, 'get_profile', {}, ctx);
  assert.equal(fetch.calls[1].url, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id%2Cunion_id%2Cavatar_url%2Cdisplay_name');
  assert.deepEqual(profile.payload, {
    openId: '-000exampleOpenId0000000000000000000',
    unionId: 'c9c60f44-a68e-4f5d-84dd-example',
    avatarUrl: 'https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/example~c5_168x168.jpeg',
    displayName: 'Acme',
  });
  await callTool(module, 'get_profile', { fields: ['display_name', 'follower_count'] }, ctx);
  assert.equal(fetch.calls[2].query.fields, 'display_name,follower_count');
});

test('list_videos reads the creator\'s public videos by POST, trims them and pages on with TikTok\'s cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'video-list.json')));
  const first = await callTool(module, 'list_videos', { max_count: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://open.tiktokapis.com/v2/video/list/?fields=id%2Ctitle%2Cvideo_description%2Ccreate_time%2Cshare_url%2Cduration%2Cview_count%2Clike_count%2Ccomment_count%2Cshare_count');
  assert.deepEqual(request.json, { max_count: 2 });
  assert.deepEqual(first.payload.videos[0], {
    id: '7300000000000000099',
    title: 'Behind the scenes',
    videoDescription: 'Behind the scenes #studio',
    createdAt: new Date(1795300000 * 1000).toISOString(),
    shareUrl: 'https://www.tiktok.com/@acme.official/video/7300000000000000099',
    duration: 21,
    viewCount: 1520,
    likeCount: 98,
    commentCount: 7,
    shareCount: 3,
  });
  assert.equal(first.payload.videos[1].title, undefined, 'an empty title is left out');

  await callTool(module, 'list_videos', { cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].json, { max_count: 2, cursor: 1795200000000 });
  assert.equal(fetch.calls[1].query.fields, request.query.fields);

  const chosen = await callTool(module, 'list_videos', { fields: ['view_count'] }, ctx);
  assert.equal(fetch.calls[2].query.fields, 'id,view_count', 'the id always comes along');
  assert.deepEqual(chosen.payload.videos[0], { id: '7300000000000000099', viewCount: 1520 });
});

test('get_videos reads videos by id and names the ones TikTok did not return', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'video-query.json')));
  const { payload, isError } = await callTool(module, 'get_videos', { video_ids: ['7300000000000000099', '7300000000000000777'], fields: ['title', 'view_count', 'like_count'] }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://open.tiktokapis.com/v2/video/query/?fields=id%2Ctitle%2Cview_count%2Clike_count');
  assert.deepEqual(fetch.calls[0].json, { filters: { video_ids: ['7300000000000000099', '7300000000000000777'] } });
  assert.deepEqual(payload, { videos: [{ id: '7300000000000000099', title: 'Behind the scenes', viewCount: 1520, likeCount: 98 }], missing: ['7300000000000000777'] });

  const noScope = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401-scope.json')));
  const refused = await callTool(noScope.module, 'list_videos', {}, noScope.ctx);
  assert.match(refused.payload.error, /^TikTok refused to read videos: the connection needs the video\.list permission, or its token is no longer valid \(HTTP 401\)/);
  assert.doesNotMatch(refused.payload.error, /Nothing was changed/, 'a read changes nothing anyway');
});

test('api_get and api_request stay under /v2/', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: {}, error: { code: 'ok' } }));
  const list = await callTool(module, 'api_request', { method: 'POST', path: '/v2/post/publish/inbox/video/init/', json: { source_info: { source: 'PULL_FROM_URL', video_url: VIDEO_URL } } }, ctx);
  assert.equal(list.isError, false, list.payload.error);
  assert.equal(fetch.calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
  const outside = await callTool(module, 'api_get', { path: '/oauth/token/' }, ctx);
  assert.match(outside.payload.error, /The path must start with \/v2\//);
  assert.equal(fetch.calls.length, 1);
});

test('log lines carry no token, caption or URL', async () => {
  const { module, ctx, logs } = setup(tiktok());
  await callTool(module, 'post_video', { video_url: VIDEO_URL, caption: 'Secret caption', privacy_level: 'SELF_ONLY' }, ctx);
  assert.ok(logs.length >= 5);
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /Secret|media\.example|upload_token/);
    assert.match(line, /^tiktok post_video (media )?(GET|POST|PUT) \d+ \d+ms$/);
  }
});
