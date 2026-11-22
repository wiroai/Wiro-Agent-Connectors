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

/** TikTok's status of a FILE_UPLOAD that has `bytes` of the video so far. */
function uploading(bytes) {
  const reply = fixture(import.meta.url, 'status-uploading.json');
  reply.data.uploaded_bytes = bytes;
  return reply;
}

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
    status: [uploading(0)],
    overrides: {
      'PUT https://open-upload.tiktokapis.com/video/': (request) => (request.headers['content-range'].startsWith('bytes 0-') ? jsonResponse(500, {}) : new Response(null, { status: 201 })),
    },
  }));
  const stoppedEarly = await callTool(middle.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, middle.ctx);
  assert.equal(stoppedEarly.isError, false, stoppedEarly.payload.error);
  assert.equal(stoppedEarly.payload.outcome, undefined);
  assert.equal(stoppedEarly.payload.done, false);
  assert.match(stoppedEarly.payload.stopped, /^TikTok did not answer the last chunk sent clearly \(HTTP 500\), and does not have it: the next call sends it again\.$/);
  assert.equal(middle.fetch.calls.filter((call) => call.method === 'PUT').length, 1);

  // The last chunk is what posts a FILE_UPLOAD: when TikTok's status cannot settle its unclear answer, the outcome is unknown.
  const last = setup(tiktok({
    status: [() => jsonResponse(500, { error: { code: 'internal_error', message: 'busy' } })],
    overrides: { 'PUT https://open-upload.tiktokapis.com/video/': () => jsonResponse(503, {}) },
  }));
  const lastUnknown = await callTool(last.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, last.ctx);
  assert.equal(lastUnknown.payload.outcome, 'unknown');
  assert.equal(lastUnknown.payload.check, 'get_post_status');
  assert.match(lastUnknown.payload.error, /^TikTok did not answer the last chunk of the video clearly \(HTTP 503\), so it is not known whether the post was started\. Calling post_video again with the same video_url and cursor "[A-Za-z0-9_-]+" is safe: it asks TikTok first, follows the post if TikTok has the whole video, and sends only what TikTok lacks; the cursor belongs to this one post, so it never makes a second one\. Call get_post_status to see whether it was, before trying again\.$/);
  assert.equal(last.fetch.calls.filter((call) => call.method === 'PUT').length, 1, 'the last chunk went once');
  assert.equal(last.fetch.calls.filter((call) => call.path === '/v2/post/publish/status/fetch/').length, 1, 'one status read to settle it');
});

test('an upload address on an unknown host, or a file that is not a video, posts nothing', async () => {
  const elsewhere = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(200, { data: { publish_id: 'x1', upload_url: 'https://uploads.example.net/video/?id=1' }, error: { code: 'ok' } }) } }));
  const host = await callTool(elsewhere.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, elsewhere.ctx);
  assert.match(host.payload.error, /uploaded to uploads\.example\.net, an address this connector does not send files to\. Nothing was posted\./);
  assert.equal(elsewhere.fetch.calls.some((call) => call.method === 'PUT'), false);

  // Origins are exact: another tiktokapis.com host is refused too, and the US upload host TikTok documents is taken.
  const sibling = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(200, { data: { publish_id: 'x2', upload_url: 'https://open-upload-eu.tiktokapis.com/video/?upload_id=2' }, error: { code: 'ok' } }) } }));
  const other = await callTool(sibling.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, sibling.ctx);
  assert.match(other.payload.error, /uploaded to open-upload-eu\.tiktokapis\.com, an address this connector does not send files to\. Nothing was posted\./);
  assert.equal(sibling.fetch.calls.some((call) => call.method === 'PUT'), false);
  const us = setup(tiktok({
    overrides: {
      'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(200, { data: { publish_id: 'x3', upload_url: 'https://upload.us.tiktokapis.com/video/?upload_id=3&upload_token=example' }, error: { code: 'ok' } }),
      'PUT https://upload.us.tiktokapis.com/video/': () => new Response(null, { status: 201 }),
    },
  }));
  const usPosted = await callTool(us.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, us.ctx);
  assert.equal(usPosted.isError, false, usPosted.payload.error);
  assert.equal(us.fetch.calls.find((call) => call.method === 'PUT').url, 'https://upload.us.tiktokapis.com/video/?upload_id=3&upload_token=example');

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

const UNVERIFIED = () => jsonResponse(403, fixture(import.meta.url, 'error-403-url-unverified.json'));
const TIKTOK_SAID = 'TikTok said: "Please review our URL ownership verification rules at https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide". Nothing was changed.';

test('a photo post refused for photo URLs on an unverified host says how to post them, and sends nothing more', async () => {
  const images = ['https://media.example.com/a.jpg', 'https://media.example.com/b.jpg'];
  const { module, fetch, ctx } = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/content/init/': UNVERIFIED } }));
  const { payload, isError } = await callTool(module, 'post_photos', { image_urls: images, privacy_level: 'SELF_ONLY' }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.status, 403);
  assert.equal(payload.outcome, undefined, 'a 403 is a clear no');
  assert.ok(payload.error.startsWith(
    'TikTok refused the photo post (TikTok downloads photos itself, only from a domain or URL prefix verified in the TikTok app\'s URL '
      + 'properties: use photo URLs on such a host, such as the creator\'s own website, or make a video of the photos and post it with '
      + 'post_video, whose FILE_UPLOAD needs no verification; other causes: an app TikTok has not audited may post only with privacy_level '
      + 'SELF_ONLY to a private account;',
  ), payload.error);
  assert.ok(payload.error.endsWith(`the inbox takes at most 5 pending drafts a day) (HTTP 403). ${TIKTOK_SAID}`), payload.error);
  assert.deepEqual(fetch.calls.map((call) => call.path), ['/v2/post/publish/creator_info/query/', '/v2/post/publish/content/init/']);

  // The inbox takes photos by URL too, with the same rule.
  const inbox = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/content/init/': UNVERIFIED } }));
  const draft = await callTool(inbox.module, 'post_photos', { image_urls: images, post_mode: 'MEDIA_UPLOAD' }, inbox.ctx);
  assert.match(draft.payload.error, /^TikTok refused the photo post \(TikTok downloads photos itself, only from a domain or URL prefix verified/);
  assert.equal(inbox.fetch.calls.length, 1);
});

test('a video TikTok would pull from an unverified host is refused with the way around it; a file upload\'s refusal does not blame the URL', async () => {
  const pull = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': UNVERIFIED } }));
  const refused = await callTool(pull.module, 'post_video', { video_url: VIDEO_URL, source: 'PULL_FROM_URL', privacy_level: 'SELF_ONLY' }, pull.ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.outcome, undefined);
  assert.ok(refused.payload.error.startsWith(
    'TikTok refused the post (with PULL_FROM_URL, TikTok downloads the video itself, only from a domain or URL prefix verified in the '
      + 'TikTok app\'s URL properties: use a URL on such a host, or source FILE_UPLOAD, which needs no verification; other causes: an app '
      + 'TikTok has not audited may post only with privacy_level SELF_ONLY to a private account;',
  ), refused.payload.error);
  assert.ok(refused.payload.error.endsWith(`(HTTP 403). ${TIKTOK_SAID}`), refused.payload.error);
  assert.equal(pull.fetch.calls.filter((call) => call.path.endsWith('/init/')).length, 1);

  const file = setup(tiktok({ overrides: { 'POST https://open.tiktokapis.com/v2/post/publish/video/init/': () => jsonResponse(403, fixture(import.meta.url, 'error-403-unaudited.json')) } }));
  const unaudited = await callTool(file.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'PUBLIC_TO_EVERYONE' }, file.ctx);
  assert.match(unaudited.payload.error, /^TikTok refused the post \(an app TikTok has not audited may post only with privacy_level SELF_ONLY to a private account;/);
  assert.doesNotMatch(unaudited.payload.error, /URL prefix|PULL_FROM_URL/, 'TikTok downloads nothing in a file upload');
  assert.equal(file.fetch.calls.some((call) => call.method === 'PUT'), false);
});

test('a whole file over the host\'s download limit (no byte ranges) is refused with the way around it, before the post is started', async () => {
  const TOO_LARGE = 'The host refused the download as too large for it: it downloads at most a set size (often 25 to 50 MB), and either it does '
    + 'not pass byte-range requests (the Range header) on or the server ignored them, so the whole file came instead of one chunk. Use a '
    + 'smaller video, a host that passes byte ranges on, or source PULL_FROM_URL from a domain or URL prefix verified in the TikTok app\'s '
    + 'URL properties, where TikTok downloads up to 4 GB itself. Nothing was posted.';
  const overLimit = () => Object.assign(new Error('the file is larger than 52428800 bytes'), { code: 'TOO_LARGE' });

  // A host that knows the size up front refuses the download itself.
  const declared = setup(tiktok({ overrides: {} }));
  declared.ctx.fetch = fakeFetch(withJson((request) => {
    if (request.url === VIDEO_URL) throw overLimit();
    return tiktok()(request);
  }));
  const refused = await callTool(declared.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, declared.ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.error, TOO_LARGE);
  assert.deepEqual(declared.ctx.fetch.calls.map((call) => call.path), ['/v2/post/publish/creator_info/query/', '/clip.mp4']);

  // A host that counts the bytes as they come stops the body part way.
  const streamed = setup(tiktok({ overrides: {} }));
  streamed.ctx.fetch = fakeFetch(withJson((request) => {
    if (request.url !== VIDEO_URL) return tiktok()(request);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(mp4(64 * 1024));
        controller.error(overLimit());
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } });
  }));
  const stopped = await callTool(streamed.module, 'post_video', { video_url: VIDEO_URL, post_mode: 'MEDIA_UPLOAD' }, streamed.ctx);
  assert.equal(stopped.payload.error, TOO_LARGE);
  assert.deepEqual(streamed.ctx.fetch.calls.map((call) => call.path), ['/clip.mp4'], 'an inbox upload checks no creator, and nothing reached TikTok');

  // Any other download failure keeps its own words.
  const broken = setup(tiktok({ overrides: {} }));
  broken.ctx.fetch = fakeFetch(withJson((request) => {
    if (request.url === VIDEO_URL) throw new TypeError('fetch failed');
    return tiktok()(request);
  }));
  const failed = await callTool(broken.module, 'post_video', { video_url: VIDEO_URL, privacy_level: 'SELF_ONLY' }, broken.ctx);
  assert.equal(failed.payload.error, 'The video could not be downloaded (fetch failed). Nothing was posted.');
});

test('the posting tools say what TikTok downloads itself, what must be verified, and how a file upload goes on across calls', () => {
  const { module } = loadModuleFor(import.meta.url);
  const tool = (name) => module.tools.find((candidate) => candidate.name === name);
  const video = tool('post_video');
  assert.match(video.description, /FILE_UPLOAD \(default\) sends it to TikTok in 10 MB chunks, each read from the URL by byte range just before it goes, for about 35 seconds a call: while done is false, call again with the same video_url and cursor set to nextCursor, until done is true, within an hour of the first call\./);
  assert.match(video.description, /A host that does not pass byte ranges on gets the whole file, which must then fit its download limit\. PULL_FROM_URL lets TikTok download it itself, only from a domain or URL prefix verified in the TikTok app's URL properties\./);
  assert.match(video.inputSchema.properties.source.description, /sent in chunks, across calls with cursor.*only from a domain or URL prefix verified for the TikTok app/);
  assert.match(video.inputSchema.properties.cursor.description, /^nextCursor from the previous result, while done is false/);
  assert.equal(video.annotations.readOnlyHint, false);
  assert.equal(video.annotations.idempotentHint, false, 'a post without cursor makes a new post');
  const photos = tool('post_photos');
  assert.match(photos.description, /TikTok has no upload for photos: it downloads them itself, only from a domain or URL prefix verified in the TikTok app's URL properties, and refuses photo URLs on any other host\./);
  assert.match(photos.description, /without one, make a video of the photos and post it with post_video, whose FILE_UPLOAD needs no verification\./);
  assert.match(photos.inputSchema.properties.image_urls.description, /on a domain or URL prefix verified for the TikTok app/);
  for (const described of [video, photos]) assert.ok(described.description.length <= 1024);
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

// ─── Large videos: chunks by byte range, across calls ───────────

const BIG = 'https://media.example.com/big.mp4';
const BIG_ARGS = { video_url: BIG, privacy_level: 'SELF_ONLY' };
const PUT_KEY = 'PUT https://open-upload.tiktokapis.com/video/';
const STATUS_KEY = 'POST https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const PUBLISH_ID = fileInit.data.publish_id;

/** A video file: an MP4 header, then a different byte in each MiB, so every chunk is told apart. */
function videoFile(size) {
  const bytes = new Uint8Array(size);
  for (let at = 0, block = 1; at < size; at += MB, block++) bytes.fill(block & 0xff, at, Math.min(size, at + MB));
  bytes.set(mp4(12));
  return bytes;
}

const sameBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const pathsOf = (fetch) => fetch.calls.map((call) => `${call.method} ${call.path}`);
const putRanges = (fetch) => fetch.calls.filter((call) => call.method === 'PUT').map((call) => call.headers['content-range']);

/** A file server that answers a Range request with 206 and the part; `whole` answers 200 with the file, as through a host that drops Range. */
function fileServer(file, { etag = '"v1"', whole = false } = {}) {
  const server = { reads: [], etag };
  server.handler = (request) => {
    server.reads.push(request.headers.range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (whole || !match) return bytesResponse(200, file, { 'content-type': 'video/mp4', etag: server.etag });
    const first = Number(match[1]);
    if (first >= file.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.length}` } });
    const last = Math.min(Number(match[2]), file.length - 1);
    return bytesResponse(206, file.slice(first, last + 1), { 'content-type': 'video/mp4', 'content-range': `bytes ${first}-${last}/${file.length}`, etag: server.etag });
  };
  return server;
}

/**
 * A TikTok upload address that keeps the chunks it gets, in order: a chunk
 * that does not start at the first byte it lacks gets 416. `keep(first, last)`
 * says whether it keeps a chunk (default yes), `onChunk` runs before it
 * answers, and `answer` replaces its answer.
 */
function uploadTarget(file, { keep, onChunk, answer } = {}) {
  const target = { received: 0, chunks: [] };
  target.handler = (request) => {
    const [first, last, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range']).slice(1).map(Number);
    assert.equal(total, file.length);
    assert.equal(request.headers.authorization, undefined, 'the upload address carries its own token');
    assert.equal(request.headers['content-type'], 'video/mp4');
    assert.equal(request.body.length, last - first + 1);
    if (first !== target.received) return new Response(null, { status: 416 });
    assert.ok(sameBytes(request.body, file.subarray(first, last + 1)), `the bytes of ${first}-${last}`);
    target.chunks.push([first, last]);
    onChunk?.(first, last);
    if (!keep || keep(first, last)) target.received = last + 1;
    const replaced = answer?.(first, last);
    if (replaced) return replaced;
    return new Response(null, {
      status: target.received >= file.length ? 201 : 206,
      headers: target.received ? { 'content-range': `bytes 0-${target.received - 1}/${file.length}` } : {},
    });
  };
  return target;
}

/** TikTok's status of the post `target` receives: uploading until every byte is in, then published (or sent to the inbox). */
function statusOf(file, target, done = 'PUBLISH_COMPLETE') {
  if (target.received < file.length) return uploading(target.received);
  return { data: { status: done, publicaly_available_post_id: done === 'PUBLISH_COMPLETE' ? ['7300000000000000099'] : [], uploaded_bytes: file.length }, error: { code: 'ok' } };
}

function bigPost(file, { server = fileServer(file), target = uploadTarget(file), status } = {}) {
  const harness = setup(tiktok({
    overrides: {
      [`GET ${BIG}`]: (request) => server.handler(request),
      [PUT_KEY]: (request) => target.handler(request),
      [STATUS_KEY]: (request) => (status ? status(request) : jsonResponse(200, statusOf(file, target))),
    },
  }));
  return { ...harness, server, target };
}

/** A big post whose chunks each take `ms` on the module's clock. */
function timedPost(file, ms, options = {}) {
  let advance;
  const target = uploadTarget(file, { onChunk: () => advance(ms) });
  const post = bigPost(file, { ...options, target });
  advance = post.advance;
  return post;
}

/** An upload address that loses the chunk starting at `at` the first time, answering 503: TikTok neither took it nor said so. */
function loseOnce(file, at) {
  let lose = true;
  return uploadTarget(file, {
    keep: (first) => !(first === at && lose),
    answer: (first) => {
      if (first !== at || !lose) return undefined;
      lose = false;
      return jsonResponse(503, {});
    },
  });
}

test('post_video FILE_UPLOAD reads a large video chunk by chunk by byte range, holding one chunk at a time', async () => {
  const file = videoFile(25 * MB + 123);
  const { module, fetch, ctx, server, target } = bigPost(file);
  const { payload, isError } = await callTool(module, 'post_video', BIG_ARGS, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(pathsOf(fetch), [
    'POST /v2/post/publish/creator_info/query/',
    'GET /big.mp4', 'POST /v2/post/publish/video/init/', 'PUT /video/',
    'GET /big.mp4', 'PUT /video/',
    'POST /v2/post/publish/status/fetch/',
  ], 'read, start the post, send; read, send; then follow the post');
  assert.deepEqual(server.reads, ['bytes=0-10485759', `bytes=10485760-${file.length - 1}`]);
  assert.deepEqual(target.chunks, [[0, 10 * MB - 1], [10 * MB, file.length - 1]]);
  for (const call of fetch.calls.filter((item) => item.path === '/big.mp4')) {
    assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'range', 'user-agent'], 'a download carries no token');
  }
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/video/init/');
  assert.deepEqual(init.json.source_info, { source: 'FILE_UPLOAD', video_size: file.length, chunk_size: 10 * MB, total_chunk_count: 2 }, 'TikTok is told the size from the first read\'s Content-Range');
  assert.equal(payload.done, true);
  assert.equal(payload.published, true);
  assert.deepEqual(payload.postIds, ['7300000000000000099']);
  assert.equal(payload.bytes, file.length);
  assert.equal(payload.nextCursor, undefined);
});

test('a video of 10 to 20 MB goes as one chunk: the start the first read holds is kept, and only the rest is read', async () => {
  const file = videoFile(15 * MB);
  const { module, fetch, ctx, server, target } = bigPost(file);
  const { payload } = await callTool(module, 'post_video', BIG_ARGS, ctx);
  assert.equal(payload.done, true, payload.error);
  assert.deepEqual(server.reads, ['bytes=0-10485759', `bytes=10485760-${15 * MB - 1}`]);
  assert.deepEqual(target.chunks, [[0, 15 * MB - 1]]);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/video/init/');
  assert.deepEqual(init.json.source_info, { source: 'FILE_UPLOAD', video_size: 15 * MB, chunk_size: 10 * MB, total_chunk_count: 1 });
});

test('a call sends chunks only while it has time, and the next call asks TikTok first, then sends the rest', async () => {
  const file = videoFile(40 * MB + 123);
  const post = timedPost(file, 9_000);
  const { module, fetch, ctx, target } = post;

  // Each chunk takes 9 s: a third one still fits 35 s (18 s + 1.5 x 9 s), a fourth would not (27 s + 13.5 s).
  const first = await callTool(module, 'post_video', BIG_ARGS, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(first.payload.done, false);
  assert.equal(first.payload.publishId, PUBLISH_ID);
  assert.equal(first.payload.uploadedBytes, 30 * MB);
  assert.equal(first.payload.totalBytes, file.length);
  assert.equal(first.payload.stopped, undefined, 'it stopped for time, not for a problem');
  assert.equal(first.payload.next, 'To go on, call post_video again with the same video_url and cursor set to nextCursor, until done is true. Each call sends the next chunks: no chunk goes twice, and the cursor belongs to this one post, so no second post is made. Go on soon: the upload must be finished by uploadExpiresAt, an hour after the post was started (TikTok\'s limit).');
  assert.match(first.payload.nextCursor, /^[A-Za-z0-9_-]+$/);
  const expires = Date.parse(first.payload.uploadExpiresAt);
  assert.ok(Math.abs(expires - (Date.now() + 3_600_000)) < 60_000, 'an hour after the post was started');
  assert.equal(first.payload.mode, 'DIRECT_POST');
  assert.equal(first.payload.privacyLevel, 'SELF_ONLY');
  assert.deepEqual(target.chunks, [[0, 10 * MB - 1], [10 * MB, 20 * MB - 1], [20 * MB, 30 * MB - 1]]);
  assert.deepEqual(post.server.reads, ['bytes=0-10485759', 'bytes=10485760-20971519', 'bytes=20971520-31457279']);
  const init = fetch.calls.find((call) => call.path === '/v2/post/publish/video/init/');
  assert.deepEqual(init.json.source_info, { source: 'FILE_UPLOAD', video_size: file.length, chunk_size: 10 * MB, total_chunk_count: 4 });
  assert.equal(fetch.calls.some((call) => call.path === '/v2/post/publish/status/fetch/'), false, 'a call that is not done reads no status');

  const sent = fetch.calls.length;
  const second = await callTool(module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.isError, false, second.payload.error);
  assert.deepEqual(pathsOf(fetch).slice(sent), [
    'POST /v2/post/publish/status/fetch/', 'GET /big.mp4', 'PUT /video/', 'POST /v2/post/publish/status/fetch/',
  ], 'it asks TikTok first, then reads and sends the rest, then follows the post');
  assert.deepEqual(fetch.calls[sent].json, { publish_id: PUBLISH_ID });
  assert.equal(fetch.calls[sent + 1].headers.range, `bytes=${30 * MB}-${file.length - 1}`);
  assert.deepEqual(target.chunks.at(-1), [30 * MB, file.length - 1]);
  assert.equal(target.chunks.length, 4, 'no chunk went twice');
  assert.equal(fetch.calls.filter((call) => call.path.endsWith('/init/')).length, 1, 'one post, started once');
  assert.equal(fetch.calls.filter((call) => call.path === '/v2/post/publish/creator_info/query/').length, 1, 'the creator is checked when the post starts');
  assert.equal(second.payload.done, true);
  assert.equal(second.payload.published, true);
  assert.deepEqual(second.payload.postIds, ['7300000000000000099']);
  assert.equal(second.payload.bytes, file.length);
  assert.equal(second.payload.mode, 'DIRECT_POST');
  assert.equal(second.payload.nextCursor, undefined);

  // A cursor of a finished upload only follows the post.
  const before = fetch.calls.length;
  const again = await callTool(module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, ctx);
  assert.equal(again.payload.done, true, again.payload.error);
  assert.equal(again.payload.published, true);
  assert.deepEqual(pathsOf(fetch).slice(before), ['POST /v2/post/publish/status/fetch/'], 'one status read: the post was done');
  assert.equal(target.chunks.length, 4);
});

test('through a host that drops the Range header, the chunks come from the whole file, across calls too', async () => {
  const file = videoFile(40 * MB + 123);
  const quick = bigPost(file, { server: fileServer(file, { whole: true }) });
  const { payload } = await callTool(quick.module, 'post_video', BIG_ARGS, quick.ctx);
  assert.equal(payload.done, true, payload.error);
  assert.equal(quick.server.reads.length, 1, 'the whole file was read once, for every chunk');
  assert.equal(quick.target.chunks.length, 4);

  // A chunk that takes 30 s leaves no time for another: each call reads the whole file and sends one chunk.
  const slow = timedPost(file, 30_000, { server: fileServer(file, { whole: true }) });
  const first = await callTool(slow.module, 'post_video', BIG_ARGS, slow.ctx);
  assert.equal(first.payload.uploadedBytes, 10 * MB, first.payload.error);
  const second = await callTool(slow.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, slow.ctx);
  assert.equal(second.payload.uploadedBytes, 20 * MB, second.payload.error);
  assert.notEqual(second.payload.nextCursor, first.payload.nextCursor, 'the cursor carries the next byte');
  const third = await callTool(slow.module, 'post_video', { ...BIG_ARGS, cursor: second.payload.nextCursor }, slow.ctx);
  const fourth = await callTool(slow.module, 'post_video', { ...BIG_ARGS, cursor: third.payload.nextCursor }, slow.ctx);
  assert.equal(fourth.payload.done, true, fourth.payload.error);
  assert.deepEqual(slow.target.chunks, [[0, 10 * MB - 1], [10 * MB, 20 * MB - 1], [20 * MB, 30 * MB - 1], [30 * MB, file.length - 1]]);
  assert.equal(slow.server.reads.length, 4, 'one whole read a call');
});

test('a cursor goes on only with its own video_url, as a FILE_UPLOAD, from this tool', async () => {
  const file = videoFile(20 * MB);
  const post = timedPost(file, 30_000);
  const { payload } = await callTool(post.module, 'post_video', BIG_ARGS, post.ctx);
  const cursor = payload.nextCursor;
  assert.ok(cursor, payload.error);
  const sent = post.fetch.calls.length;

  const other = await callTool(post.module, 'post_video', { ...BIG_ARGS, video_url: 'https://media.example.com/other.mp4', cursor }, post.ctx);
  assert.equal(other.payload.error, 'The cursor belongs to a post of another video_url: give the video_url it started with, or leave cursor out to start a new post. Nothing was changed.');
  const pull = await callTool(post.module, 'post_video', { ...BIG_ARGS, source: 'PULL_FROM_URL', cursor }, post.ctx);
  assert.equal(pull.payload.error, 'A cursor goes on with a FILE_UPLOAD: leave source out, or set it to FILE_UPLOAD, when you pass cursor. Nothing was changed.');

  const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  assert.equal(state.o, 10 * MB, 'the cursor holds the next byte');
  const forged = (change) => Buffer.from(JSON.stringify({ ...state, ...change })).toString('base64url');
  for (const change of [
    { s: 'https://uploads.example.net/video/?upload_id=1' },
    { s: 'https://user:pass@open-upload.tiktokapis.com/video/?upload_id=1' },
    { o: 123 },
    { o: 20 * MB },
    { c: 5 * MB },
    { n: 0 },
    { i: 'bad id!' },
    { y: 'text/html' },
    { m: 'x' },
    { e: 'W/"weak"' },
  ]) {
    const crafted = await callTool(post.module, 'post_video', { ...BIG_ARGS, cursor: forged(change) }, post.ctx);
    assert.equal(crafted.payload.error, 'The cursor holds no upload: pass nextCursor unchanged, or leave cursor out to start a new post. Nothing was changed.', JSON.stringify(change));
  }
  const listCursor = await callTool(post.module, 'post_video', { ...BIG_ARGS, cursor: Buffer.from(JSON.stringify({ t: 'list_videos', o: 0 })).toString('base64url') }, post.ctx);
  assert.match(listCursor.payload.error, /The cursor is not valid for this tool/);
  assert.equal(post.fetch.calls.length, sent, 'nothing was sent for a cursor that does not fit');
});

test('going on asks TikTok first: an older cursor goes on from where TikTok is, and no chunk goes twice', async () => {
  const file = videoFile(30 * MB);
  const post = timedPost(file, 30_000);
  const first = await callTool(post.module, 'post_video', BIG_ARGS, post.ctx);
  const second = await callTool(post.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, post.ctx);
  assert.equal(second.payload.uploadedBytes, 20 * MB, second.payload.error);

  // The first cursor again: TikTok's status says it has 20 MB, so the call sends the last chunk only.
  const replay = await callTool(post.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, post.ctx);
  assert.equal(replay.payload.done, true, replay.payload.error);
  assert.deepEqual(post.target.chunks, [[0, 10 * MB - 1], [10 * MB, 20 * MB - 1], [20 * MB, 30 * MB - 1]]);
  assert.equal(putRanges(post.fetch).length, 3);
});

test('a chunk without a clear answer: TikTok\'s status says whether it is in, and it never goes twice in a call', async () => {
  const file = videoFile(30 * MB);
  const unclearFirst = (first) => (first === 0 ? jsonResponse(503, { error: { code: 'internal_error', message: 'busy' } }) : undefined);

  // TikTok took it: the call goes on with the next chunk.
  const kept = bigPost(file, { target: uploadTarget(file, { answer: unclearFirst }) });
  const done = await callTool(kept.module, 'post_video', BIG_ARGS, kept.ctx);
  assert.equal(done.payload.done, true, done.payload.error);
  assert.equal(kept.target.chunks.length, 3, 'no chunk went twice');
  assert.deepEqual(pathsOf(kept.fetch).slice(3, 5), ['PUT /video/', 'POST /v2/post/publish/status/fetch/'], 'the status is read right after the unclear answer');

  // TikTok does not have it: the call stops, and the next call sends it again.
  const target = loseOnce(file, 0);
  const lost = bigPost(file, { target });
  const stopped = await callTool(lost.module, 'post_video', BIG_ARGS, lost.ctx);
  assert.equal(stopped.isError, false, stopped.payload.error);
  assert.deepEqual([stopped.payload.done, stopped.payload.uploadedBytes], [false, 0]);
  assert.equal(stopped.payload.stopped, 'TikTok did not answer the last chunk sent clearly (HTTP 503), and does not have it: the next call sends it again.');
  assert.match(stopped.payload.next, /^Deal with what stopped says first, then call post_video again with the same video_url and cursor set to nextCursor/);
  assert.equal(putRanges(lost.fetch).length, 1, 'not sent again in the same call');
  const resumed = await callTool(lost.module, 'post_video', { ...BIG_ARGS, cursor: stopped.payload.nextCursor }, lost.ctx);
  assert.equal(resumed.payload.done, true, resumed.payload.error);
  assert.deepEqual(target.chunks, [[0, 10 * MB - 1], [0, 10 * MB - 1], [10 * MB, 20 * MB - 1], [20 * MB, 30 * MB - 1]], 'the lost chunk went again in the next call');

  // TikTok's status cannot be read either: the call stops, and the next call asks again before it sends anything.
  const blind = bigPost(file, { target: uploadTarget(file, { answer: unclearFirst }), status: () => jsonResponse(500, { error: { code: 'internal_error', message: 'busy' } }) });
  const unsure = await callTool(blind.module, 'post_video', BIG_ARGS, blind.ctx);
  assert.equal(unsure.isError, false, unsure.payload.error);
  assert.deepEqual([unsure.payload.done, unsure.payload.uploadedBytes], [false, 0]);
  assert.match(unsure.payload.stopped, /could not say how far the upload got: the next call asks again before it sends anything\.$/);
});

test('the last chunk without a clear answer: TikTok\'s status settles it, else the outcome is unknown with a cursor that is safe to go on with', async () => {
  const file = videoFile(20 * MB);
  const unclearLast = (first) => (first === 10 * MB ? jsonResponse(503, {}) : undefined);

  // TikTok has the whole video: the post is followed, not reported unknown.
  const made = bigPost(file, { target: uploadTarget(file, { answer: unclearLast }) });
  const done = await callTool(made.module, 'post_video', BIG_ARGS, made.ctx);
  assert.equal(done.isError, false, done.payload.error);
  assert.equal(done.payload.done, true);
  assert.equal(done.payload.published, true);
  assert.equal(putRanges(made.fetch).length, 2);

  // TikTok lacks the last chunk: nothing was posted, and the cursor sends it again.
  const lost = bigPost(file, { target: loseOnce(file, 10 * MB) });
  const stopped = await callTool(lost.module, 'post_video', BIG_ARGS, lost.ctx);
  assert.deepEqual([stopped.payload.done, stopped.payload.uploadedBytes], [false, 10 * MB], stopped.payload.error);
  const resumed = await callTool(lost.module, 'post_video', { ...BIG_ARGS, cursor: stopped.payload.nextCursor }, lost.ctx);
  assert.equal(resumed.payload.done, true, resumed.payload.error);

  // The status cannot be read: unknown, with the cursor; going on later with it only follows the post TikTok made.
  let statusUp = false;
  const blind = bigPost(file, {
    target: uploadTarget(file, { answer: unclearLast }),
    status: () => (statusUp ? jsonResponse(200, statusOf(file, blind.target)) : jsonResponse(500, { error: { code: 'internal_error', message: 'busy' } })),
  });
  const unknown = await callTool(blind.module, 'post_video', BIG_ARGS, blind.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_post_status');
  const cursor = /cursor "([A-Za-z0-9_-]+)"/.exec(unknown.payload.error)?.[1];
  assert.ok(cursor, unknown.payload.error);
  statusUp = true;
  const before = putRanges(blind.fetch).length;
  const followed = await callTool(blind.module, 'post_video', { ...BIG_ARGS, cursor }, blind.ctx);
  assert.equal(followed.payload.done, true, followed.payload.error);
  assert.equal(followed.payload.published, true);
  assert.equal(putRanges(blind.fetch).length, before, 'nothing was sent again');
});

test('a 416 makes the call ask TikTok where its upload is, once; without an answer the upload stops with what to do', async () => {
  const file = videoFile(30 * MB);
  const post = timedPost(file, 30_000);
  const first = await callTool(post.module, 'post_video', BIG_ARGS, post.ctx);
  assert.equal(first.payload.uploadedBytes, 10 * MB, first.payload.error);

  // TikTok got the second chunk some other way, and its first status read still says 10 MB.
  post.target.received = 20 * MB;
  let reads = 0;
  const lagging = bigPost(file, { target: post.target, status: () => jsonResponse(200, reads++ === 0 ? uploading(10 * MB) : statusOf(file, post.target)) });
  const resynced = await callTool(lagging.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, lagging.ctx);
  assert.equal(resynced.payload.done, true, resynced.payload.error);
  assert.deepEqual(putRanges(lagging.fetch), [`bytes ${10 * MB}-${20 * MB - 1}/${file.length}`, `bytes ${20 * MB}-${30 * MB - 1}/${file.length}`], 'the refused chunk, then the one TikTok asked for');

  // A status without uploaded_bytes: the upload stops.
  const silent = { data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } };
  const stuckTarget = uploadTarget(file);
  stuckTarget.received = 20 * MB;
  const stuck = bigPost(file, { target: stuckTarget, status: () => jsonResponse(200, silent) });
  const refused = await callTool(stuck.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, stuck.ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.status, 416);
  assert.equal(refused.payload.error, 'TikTok refused the chunk of bytes 10,485,760 to 20,971,519 (HTTP 416): its upload of this video is not at that point, and its status did not say where it is. The rest cannot be sent, and nothing was posted: post the video again without cursor.');

  // The last chunk refused so: TikTok may already have the whole video.
  const lastPost = timedPost(file, 30_000, { status: () => jsonResponse(200, silent) });
  lastPost.target.received = 10 * MB;
  const second = await callTool(lastPost.module, 'post_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, lastPost.ctx);
  assert.equal(second.payload.uploadedBytes, 20 * MB, second.payload.error);
  lastPost.target.received = 0;
  const last = await callTool(lastPost.module, 'post_video', { ...BIG_ARGS, cursor: second.payload.nextCursor }, lastPost.ctx);
  assert.match(last.payload.error, /^TikTok refused the chunk of bytes 20,971,520 to 31,457,279 \(HTTP 416\): .* TikTok may already have the whole video: if get_post_status with publish_id v_pub_file~v2-1\.7300000000000000000 does not show the post, post the video again without cursor\.$/);
});

test('an expired or dropped upload address ends the upload; a rate limit stops the call until later', async () => {
  const file = videoFile(30 * MB);
  const second = (status, headers = {}) => uploadTarget(file, { keep: (first) => first !== 10 * MB, answer: (first) => (first === 10 * MB ? new Response(null, { status, headers }) : undefined) });

  const expired = bigPost(file, { target: second(403) });
  const gone = await callTool(expired.module, 'post_video', BIG_ARGS, expired.ctx);
  assert.equal(gone.isError, true);
  assert.equal(gone.payload.status, 403);
  assert.equal(gone.payload.outcome, undefined);
  assert.equal(gone.payload.error, 'TikTok refused the chunk because the post\'s upload address expired (HTTP 403): it works for an hour after the post was started. The rest cannot be sent, and nothing was posted: post the video again without cursor.');

  const dropped = bigPost(file, { target: second(404) });
  const missing = await callTool(dropped.module, 'post_video', BIG_ARGS, dropped.ctx);
  assert.match(missing.payload.error, /^TikTok has no upload for this post any more \(HTTP 404\): .*If get_post_status does not show the post, post the video again without cursor\.$/);

  const limited = bigPost(file, { target: second(429, { 'retry-after': '30' }) });
  const rate = await callTool(limited.module, 'post_video', BIG_ARGS, limited.ctx);
  assert.equal(rate.isError, false, rate.payload.error);
  assert.deepEqual([rate.payload.done, rate.payload.uploadedBytes, rate.payload.retryAfter], [false, 10 * MB, 30]);
  assert.equal(rate.payload.stopped, 'TikTok rate limit reached (HTTP 429). Retry after 30 seconds.');
  assert.match(rate.payload.next, /^Deal with what stopped says first \(wait 30 seconds\), then call post_video again with the same video_url and cursor set to nextCursor/);
  assert.equal(putRanges(limited.fetch).length, 2);
});

test('a file that changed since the upload started is not sent on', async () => {
  const file = videoFile(20 * MB);
  const post = timedPost(file, 30_000);
  const { payload } = await callTool(post.module, 'post_video', BIG_ARGS, post.ctx);
  assert.ok(payload.nextCursor, payload.error);

  post.server.etag = '"v2"';
  const changed = await callTool(post.module, 'post_video', { ...BIG_ARGS, cursor: payload.nextCursor }, post.ctx);
  assert.equal(changed.payload.error, 'The file at video_url changed since the upload started (its ETag is different). The rest cannot be sent, and nothing was posted: post the video again without cursor.');

  const longer = bigPost(videoFile(30 * MB));
  longer.target.received = 10 * MB;
  const resized = await callTool(longer.module, 'post_video', { ...BIG_ARGS, cursor: payload.nextCursor }, longer.ctx);
  assert.match(resized.payload.error, /^The file at video_url is 31,457,280 bytes now, not the 20,971,520 it had when the upload started\./);
  assert.equal(putRanges(longer.fetch).length, 0);
  assert.equal(post.target.chunks.length, 1);
});

test('two calls never send the same video at once', async () => {
  const file = videoFile(20 * MB);
  let status = (request) => jsonResponse(200, statusOf(file, post.target));
  const post = timedPost(file, 30_000, { status: (request) => status(request) });
  const { payload } = await callTool(post.module, 'post_video', BIG_ARGS, post.ctx);
  assert.equal(payload.done, false, payload.error);

  // The first call waits at its status read while the second one comes in with the same cursor.
  const answer = status;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  status = async (request) => {
    await gate;
    return answer(request);
  };
  const args = { ...BIG_ARGS, cursor: payload.nextCursor };
  const going = callTool(post.module, 'post_video', args, post.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sent = post.fetch.calls.length;
  const second = await callTool(post.module, 'post_video', args, post.ctx);
  assert.equal(second.payload.error, 'Another call is sending this video right now: wait for its result, then go on with its nextCursor. Nothing was sent.');
  assert.equal(post.fetch.calls.length, sent, 'the second call sent nothing');
  release();
  const first = await going;
  assert.equal(first.payload.done, true, first.payload.error);
  status = answer;
  const after = await callTool(post.module, 'post_video', args, post.ctx);
  assert.equal(after.payload.done, true, after.payload.error);
  assert.equal(post.target.chunks.length, 2);
});

test('a chunk that cannot be read stops the call with the cursor; a source without a size or over 4 GB starts no post', async () => {
  const file = videoFile(30 * MB);
  const server = fileServer(file);
  const reading = bigPost(file, { server: { ...server, handler: (request) => (request.headers.range === 'bytes=10485760-20971519' ? jsonResponse(403, { message: 'Forbidden' }) : server.handler(request)) } });
  const unread = await callTool(reading.module, 'post_video', BIG_ARGS, reading.ctx);
  assert.equal(unread.isError, false, unread.payload.error);
  assert.deepEqual([unread.payload.done, unread.payload.uploadedBytes], [false, 10 * MB]);
  assert.equal(unread.payload.stopped, 'Reading the next chunk of the video failed. The video URL answered HTTP 403.');
  assert.ok(unread.payload.nextCursor);

  const sizeless = bigPost(file, { server: { handler: () => bytesResponse(206, file.slice(0, 10 * MB), { 'content-range': 'bytes 0-10485759/*' }) } });
  const unsized = await callTool(sizeless.module, 'post_video', BIG_ARGS, sizeless.ctx);
  assert.equal(unsized.payload.error, 'The video URL did not say how large the file is, which TikTok needs to know before the upload starts. Nothing was posted.');
  assert.deepEqual(pathsOf(sizeless.fetch), ['POST /v2/post/publish/creator_info/query/', 'GET /big.mp4']);

  const huge = bigPost(file, { server: { handler: () => bytesResponse(206, file.slice(0, 10 * MB), { 'content-range': 'bytes 0-10485759/5000000000' }) } });
  const tooBig = await callTool(huge.module, 'post_video', BIG_ARGS, huge.ctx);
  assert.equal(tooBig.payload.error, 'The video is 5,000,000,000 bytes; TikTok takes files up to 4 GB (4,294,967,296 bytes). Nothing was posted.');
  assert.equal(huge.fetch.calls.some((call) => call.path.endsWith('/init/')), false);
});

test('an inbox draft goes in chunks across calls too', async () => {
  const file = videoFile(20 * MB);
  let post;
  post = timedPost(file, 30_000, { status: () => jsonResponse(200, statusOf(file, post.target, 'SEND_TO_USER_INBOX')) });
  const first = await callTool(post.module, 'post_video', { video_url: BIG, post_mode: 'MEDIA_UPLOAD' }, post.ctx);
  assert.equal(first.payload.done, false, first.payload.error);
  assert.equal(first.payload.mode, 'MEDIA_UPLOAD');
  assert.equal(post.fetch.calls.some((call) => call.path === '/v2/post/publish/creator_info/query/'), false);
  const init = post.fetch.calls.find((call) => call.path === '/v2/post/publish/inbox/video/init/');
  assert.deepEqual(init.json, { source_info: { source: 'FILE_UPLOAD', video_size: file.length, chunk_size: 10 * MB, total_chunk_count: 2 } });
  const second = await callTool(post.module, 'post_video', { video_url: BIG, cursor: first.payload.nextCursor }, post.ctx);
  assert.equal(second.payload.done, true, second.payload.error);
  assert.equal(second.payload.mode, 'MEDIA_UPLOAD');
  assert.equal(second.payload.sentToInbox, true);
  assert.equal(second.payload.published, false);
});

test('upload log lines carry no token, no URL and no arguments', async () => {
  const file = videoFile(25 * MB + 123);
  const { module, ctx, logs } = bigPost(file);
  const { payload } = await callTool(module, 'post_video', { ...BIG_ARGS, caption: 'Secret caption' }, ctx);
  assert.equal(payload.done, true, payload.error);
  assert.deepEqual(logs.map((line) => line.replace(/ \d+ms$/, '')), [
    'tiktok post_video POST 200',
    'tiktok post_video media GET 206',
    'tiktok post_video POST 200',
    'tiktok post_video PUT 206',
    'tiktok post_video media GET 206',
    'tiktok post_video PUT 201',
    'tiktok post_video POST 200',
  ]);
  for (const line of logs) assert.equal(/act\.|Secret|media\.example|upload_token|upload_id/.test(line), false, line);
});
