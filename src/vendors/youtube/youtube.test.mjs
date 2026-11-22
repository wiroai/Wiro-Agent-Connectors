import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.a0AfB_byCexampleYouTubeToken0123456789';
const credentials = { access_token: TOKEN };
const API = 'https://www.googleapis.com';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com';
const CH = 'UCabcdefghijklmnopqrstuv';
const OTHER = 'UCzyxwvutsrqponmlkjihgfe';
const UP = 'UUabcdefghijklmnopqrstuv';
const [V1, V2, V3] = ['vid0000001a', 'vid0000002b', 'vid0000003c'];
const LOCKED = { channels: [CH] };
const UPLOAD_URL = `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&upload_id=ADPycdExampleUploadId`;
const fx = (name) => fixture(import.meta.url, name);

// The first bytes of an MP4 file and of a JPEG image: all the module reads to tell them apart.
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function setup(handler, accounts = LOCKED) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

/** A fake YouTube: routes by method and origin plus path; channels answers by its query. */
function youtube(overrides = {}) {
  const routes = {
    [`GET ${API}/youtube/v3/channels`]: (request) => {
      if (request.query.part === 'id') return jsonResponse(200, fx('channel-id.json'));
      if (request.query.mine === 'true') return jsonResponse(200, fx('channels-mine.json'));
      if (request.query.id === CH) return jsonResponse(200, fx('channel-full.json'));
      return jsonResponse(200, { items: [] });
    },
    [`GET ${API}/youtube/v3/playlistItems`]: (request) => jsonResponse(200, request.query.playlistId === UP ? fx('uploads-page.json') : fx('playlist-items.json')),
    [`GET ${API}/youtube/v3/videos`]: (request) => {
      const ids = request.query.id.split(',');
      return jsonResponse(200, { items: fx('videos.json').items.filter((video) => ids.includes(video.id)) });
    },
    [`GET ${API}/youtube/v3/search`]: () => jsonResponse(200, fx('search.json')),
    [`PUT ${API}/youtube/v3/videos`]: () => jsonResponse(200, fx('video-updated.json')),
    [`POST ${API}/upload/youtube/v3/videos`]: () => new Response(null, { status: 200, headers: { location: UPLOAD_URL } }),
    [`PUT ${API}/upload/youtube/v3/videos`]: () => jsonResponse(201, fx('video-uploaded.json')),
    [`POST ${API}/upload/youtube/v3/thumbnails/set`]: () => jsonResponse(200, fx('thumbnails.json')),
    [`GET ${API}/youtube/v3/playlists`]: () => jsonResponse(200, fx('playlists.json')),
    [`POST ${API}/youtube/v3/playlists`]: () => jsonResponse(200, fx('playlist-created.json')),
    [`POST ${API}/youtube/v3/playlistItems`]: () => jsonResponse(200, fx('playlist-item-created.json')),
    [`GET ${ANALYTICS}/v2/reports`]: (request) => jsonResponse(200, request.query.filters?.startsWith('video==') && request.query.metrics === 'views,averageViewPercentage' ? fx('analytics-screen.json') : fx('analytics-top.json')),
    'GET https://media.example.com/launch.mp4': () => bytesResponse(200, MP4, { 'content-type': 'application/octet-stream' }),
    'GET https://media.example.com/page.html': () => bytesResponse(200, new TextEncoder().encode('<html>not a video</html>'), { 'content-type': 'video/mp4' }),
    'GET https://media.example.com/thumb.jpg': () => bytesResponse(200, JPEG, { 'content-type': 'image/jpeg' }),
    ...overrides,
  };
  return (request) => {
    const route = routes[`${request.method} ${request.origin}${request.path}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.url}`);
    return route(request);
  };
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);
const pathsOf = (fetch) => fetch.calls.map((call) => `${call.method} ${call.path}`);

test('list_channels lists the account\'s channels and is the channels picker', async () => {
  const { module, fetch, ctx } = setup(youtube(), null);
  const [picker] = module.accountPickers;
  assert.deepEqual({ ...picker }, {
    key: 'channels',
    label: 'YouTube channels',
    description: 'The channels the agent may work on.',
    multiple: true,
    tool: 'list_channels',
    idField: 'id',
    nameField: 'title',
    legacyField: 'channelid',
  });
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `${API}/youtube/v3/channels?part=snippet%2Cstatistics%2CcontentDetails&mine=true&maxResults=50`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.channels, [{
    id: CH,
    title: 'Example Studio',
    handle: '@examplestudio',
    subscribers: 8900,
    views: 1234567,
    videos: 142,
    uploads_playlist_id: UP,
    url: `https://www.youtube.com/channel/${CH}`,
  }]);
  assert.deepEqual(payload.channels.map((item) => [field(item, picker.idField), field(item, picker.nameField)]), [[CH, 'Example Studio']]);

  const other = setup(youtube(), { channels: [OTHER] });
  const chosen = await callTool(other.module, 'list_channels', {}, other.ctx);
  assert.deepEqual(chosen.payload.channels, []);
});

test('get_channel uses the chosen channel, or the connected one without a choice', async () => {
  const locked = setup(youtube());
  const { payload } = await callTool(locked.module, 'get_channel', {}, locked.ctx);
  assert.deepEqual(pathsOf(locked.fetch), ['GET /youtube/v3/channels']);
  assert.equal(locked.fetch.calls[0].query.id, CH);
  assert.equal(locked.fetch.calls[0].query.part, 'snippet,statistics,contentDetails,brandingSettings,status');
  assert.equal(payload.keywords, 'films "how to" animation');
  assert.equal(payload.long_uploads, 'allowed');
  assert.equal(payload.made_for_kids, false);

  const open = setup(youtube(), null);
  await callTool(open.module, 'get_channel', {}, open.ctx);
  assert.deepEqual(open.fetch.calls.map((call) => call.query.part), ['id', 'snippet,statistics,contentDetails,brandingSettings,status']);
  assert.equal(open.fetch.calls[0].query.mine, 'true');

  const refused = await callTool(locked.module, 'get_channel', { channel_id: OTHER }, locked.ctx);
  assert.match(refused.payload.error, new RegExp(`The channel ${OTHER} is not among the channels chosen for this connection`));
  const none = setup(youtube(), {});
  const nothing = await callTool(none.module, 'get_channel', {}, none.ctx);
  assert.match(nothing.payload.error, /No YouTube channel is chosen/);
  assert.equal(none.fetch.calls.length, 0);
});

test('list_videos reads the uploads list, then the videos, and pages on without reading the channel again', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload, isError } = await callTool(module, 'list_videos', { page_size: 3 }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels', 'GET /youtube/v3/playlistItems', 'GET /youtube/v3/videos']);
  assert.equal(fetch.calls[1].query.playlistId, UP);
  assert.equal(fetch.calls[1].query.maxResults, '3');
  assert.equal(fetch.calls[2].query.id, `${V1},${V2},${V3}`);
  assert.equal(fetch.calls[2].query.part, 'snippet,statistics,contentDetails,status');
  assert.equal(fetch.calls[2].query.maxResults, undefined, 'videos.list takes no maxResults with id');
  assert.deepEqual(payload.videos[0], {
    id: V1,
    title: 'How we edit a short film',
    published_at: '2026-11-20T09:00:00Z',
    privacy_status: 'public',
    duration: 'PT2M30S',
    duration_seconds: 150,
    views: 15400,
    likes: 770,
    comments: 154,
    made_for_kids: false,
    url: `https://youtu.be/${V1}`,
  });
  assert.equal(payload.videos[1].publish_at, '2026-12-01T07:00:00Z');
  assert.ok(payload.nextCursor);

  await callTool(module, 'list_videos', { cursor: payload.nextCursor }, ctx);
  assert.deepEqual(pathsOf(fetch).slice(3), ['GET /youtube/v3/playlistItems', 'GET /youtube/v3/videos']);
  assert.equal(fetch.calls[3].query.pageToken, 'EAAaBlBUOkNESQ');
});

test('get_videos gives the full details and names the ids it could not find', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload } = await callTool(module, 'get_videos', { video_ids: [V2, 'zzzzzzzzzzz'] }, ctx);
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels', 'GET /youtube/v3/videos'], 'the connected channel is checked against the choice first');
  assert.equal(fetch.calls[1].query.id, `${V2},zzzzzzzzzzz`);
  assert.equal(fetch.calls[1].query.maxResults, undefined);
  assert.deepEqual(payload.not_found, ['zzzzzzzzzzz']);
  const [video] = payload.videos;
  assert.equal(video.description, 'About Winter teaser.');
  assert.deepEqual(video.tags, ['demo', 'how to']);
  assert.equal(video.contains_synthetic_media, true);
  assert.equal(video.caption, false);
  assert.equal(video.channel_id, CH);
  assert.equal(video.studio_url, `https://studio.youtube.com/video/${V2}/edit`);
});

test('search_videos searches the chosen channel', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload } = await callTool(module, 'search_videos', { query: 'editing', order: 'viewCount', published_after: '2026-01-01T00:00:00+03:00' }, ctx);
  const query = fetch.calls[0].query;
  assert.deepEqual([query.part, query.type, query.channelId, query.q, query.order, query.publishedAfter], ['snippet', 'video', CH, 'editing', 'viewCount', '2025-12-31T21:00:00Z']);
  assert.deepEqual(payload.videos[0], { id: V1, title: 'How we edit a short film', description: 'About editing.', published_at: '2026-11-20T09:00:00Z', url: `https://youtu.be/${V1}` });
  assert.equal(payload.total_results, 31);
});

test('update_video sends back every field it did not change, since YouTube resets what an update leaves out', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload, isError } = await callTool(module, 'update_video', { video_id: V2, title: 'Winter teaser (final)' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/videos', 'PUT /youtube/v3/videos']);
  assert.equal(fetch.calls[0].query.part, 'snippet,status');
  assert.equal(fetch.calls[1].query.part, 'snippet');
  assert.deepEqual(fetch.calls[1].json, {
    id: V2,
    snippet: { title: 'Winter teaser (final)', categoryId: '28', description: 'About Winter teaser.', tags: ['demo', 'how to'], defaultLanguage: 'tr', defaultAudioLanguage: 'tr' },
  });
  assert.equal(payload.title, 'Winter teaser (final)');
});

test('update_video publishes with the whole status kept, or schedules a private video', async () => {
  const { module, fetch, ctx } = setup(youtube());
  await callTool(module, 'update_video', { video_id: V2, privacy_status: 'public' }, ctx);
  assert.equal(fetch.calls[1].query.part, 'status');
  assert.deepEqual(fetch.calls[1].json.status, {
    privacyStatus: 'public',
    embeddable: true,
    publicStatsViewable: true,
    license: 'youtube',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
  });

  await callTool(module, 'update_video', { video_id: V2, privacy_status: 'private', publish_at: '2036-12-01T10:00:00+03:00' }, ctx);
  assert.equal(fetch.calls[3].json.status.privacyStatus, 'private');
  assert.equal(fetch.calls[3].json.status.publishAt, '2036-12-01T07:00:00Z');

  // Another field on a scheduled video keeps the schedule.
  await callTool(module, 'update_video', { video_id: V2, embeddable: false }, ctx);
  assert.equal(fetch.calls[5].json.status.publishAt, '2026-12-01T07:00:00Z');
  assert.equal(fetch.calls[5].json.status.embeddable, false);

  const refused = await callTool(module, 'update_video', { video_id: V2, privacy_status: 'public', publish_at: '2036-12-01T10:00:00Z' }, ctx);
  assert.match(refused.payload.error, /publish_at needs privacy_status private/);
  const past = await callTool(module, 'update_video', { video_id: V2, publish_at: '2020-01-01T00:00:00Z' }, ctx);
  assert.match(past.payload.error, /publish_at must be in the future/);
  const angle = await callTool(module, 'update_video', { video_id: V2, title: 'A <b>bold</b> title' }, ctx);
  assert.match(angle.payload.error, /may not contain < or >/);
  const nothing = await callTool(module, 'update_video', { video_id: V2 }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 7, 'the refused calls sent nothing, the publish_at mix read the video once');
});

test('update_video refuses a video of a channel outside the choice, and warns when YouTube keeps it private', async () => {
  const foreign = { ...fx('videos.json').items[0], snippet: { ...fx('videos.json').items[0].snippet, channelId: OTHER } };
  const { module, fetch, ctx } = setup(youtube({ [`GET ${API}/youtube/v3/videos`]: () => jsonResponse(200, { items: [foreign] }) }));
  const refused = await callTool(module, 'update_video', { video_id: V1, title: 'New' }, ctx);
  assert.match(refused.payload.error, new RegExp(`The channel ${OTHER} is not among the channels chosen`));
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/videos']);

  const locked = setup(youtube({ [`PUT ${API}/youtube/v3/videos`]: () => jsonResponse(200, fx('videos.json').items[1]) }));
  const kept = await callTool(locked.module, 'update_video', { video_id: V2, privacy_status: 'public' }, locked.ctx);
  assert.match(kept.payload.warning, /YouTube kept the video private although public was asked: videos uploaded through a Google Cloud project that has not passed the YouTube API audit/);
});

test('upload_video reads the file by byte range, opens a resumable session and sends a small video in one part', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload, isError } = await callTool(module, 'upload_video', {
    video_url: 'https://media.example.com/launch.mp4',
    title: 'Launch film',
    description: 'Our new model in 60 seconds.',
    tags: ['launch', 'ai video'],
    category_id: '28',
    privacy_status: 'private',
    publish_at: '2036-10-20T07:00:00Z',
    contains_synthetic_media: true,
    default_language: 'en',
    notify_subscribers: false,
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels', 'GET /launch.mp4', 'POST /upload/youtube/v3/videos', 'PUT /upload/youtube/v3/videos']);
  assert.equal(fetch.calls[0].query.mine, 'true', 'the connected channel is checked against the choice first');
  assert.equal(fetch.calls[1].headers.authorization, undefined, 'no token goes with the download');
  assert.equal(fetch.calls[1].headers.range, 'bytes=0-8388607', 'the first 8 MiB part is asked for by byte range');

  const start = fetch.calls[2];
  assert.equal(start.url, `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false`);
  assert.equal(start.headers['x-upload-content-type'], 'video/mp4');
  assert.equal(start.headers['x-upload-content-length'], String(MP4.length));
  assert.deepEqual(start.json, {
    snippet: { title: 'Launch film', description: 'Our new model in 60 seconds.', tags: ['launch', 'ai video'], categoryId: '28', defaultLanguage: 'en' },
    status: { privacyStatus: 'private', publishAt: '2036-10-20T07:00:00Z', embeddable: true, publicStatsViewable: true, license: 'youtube', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  });

  // This server ignored the range and sent the whole file: it is small enough to go as the one and last part.
  const send = fetch.calls[3];
  assert.equal(send.url, UPLOAD_URL);
  assert.equal(send.headers['content-type'], 'video/mp4');
  assert.equal(send.headers['content-range'], `bytes 0-${MP4.length - 1}/${MP4.length}`);
  assert.equal(send.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual([...send.body], [...MP4]);

  assert.equal(payload.done, true);
  assert.equal(payload.id, 'vid0000009z');
  assert.equal(payload.url, 'https://youtu.be/vid0000009z');
  assert.equal(payload.upload_status, 'uploaded');
  assert.equal(payload.bytes, MP4.length);
  assert.match(payload.note, /becomes a Short/);
});

test('upload_video refuses what is not a video, a schedule that is not private, and a foreign upload address', async () => {
  const { module, fetch, ctx } = setup(youtube(), null);
  const page = await callTool(module, 'upload_video', { video_url: 'https://media.example.com/page.html', title: 'X', privacy_status: 'public', contains_synthetic_media: false }, ctx);
  assert.match(page.payload.error, /did not return a video file YouTube takes/);
  assert.deepEqual(pathsOf(fetch), ['GET /page.html'], 'no session was opened');

  const schedule = await callTool(module, 'upload_video', { video_url: 'https://media.example.com/launch.mp4', title: 'X', privacy_status: 'public', publish_at: '2036-01-01T00:00:00Z', contains_synthetic_media: false }, ctx);
  assert.match(schedule.payload.error, /publish_at needs privacy_status private/);
  assert.equal(fetch.calls.length, 1);

  const elsewhere = setup(youtube({ [`POST ${API}/upload/youtube/v3/videos`]: () => new Response(null, { status: 200, headers: { location: 'https://uploads.example.net/put?upload_id=1' } }) }), null);
  const odd = await callTool(elsewhere.module, 'upload_video', { video_url: 'https://media.example.com/launch.mp4', title: 'X', privacy_status: 'public', contains_synthetic_media: false }, elsewhere.ctx);
  assert.match(odd.payload.error, /opened no upload address/);
  assert.equal(elsewhere.fetch.calls.some((call) => call.method === 'PUT'), false);
});

test('an upload whose last part gets no clear answer, and no answer to the question after it, is unknown: the part is never sent twice', async () => {
  const { module, fetch, ctx } = setup(youtube({ [`PUT ${API}/upload/youtube/v3/videos`]: () => jsonResponse(503, { error: { code: 503, message: 'Backend Error' } }) }), null);
  const { payload } = await callTool(module, 'upload_video', { video_url: 'https://media.example.com/launch.mp4', title: 'X', privacy_status: 'unlisted', contains_synthetic_media: false }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'list_videos');
  assert.match(payload.error, /YouTube did not answer the last part of the upload \(HTTP 503: Backend Error\), so it is not known whether the video was made/);
  assert.match(payload.error, /Calling upload_video again with the same arguments and cursor "[A-Za-z0-9_-]+" is safe: it asks YouTube first/);
  const puts = fetch.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(puts.map((call) => call.headers['content-range']), [`bytes 0-${MP4.length - 1}/${MP4.length}`, `bytes */${MP4.length}`], 'the part once, then one question without bytes');
  assert.equal(puts[1].body.length, 0);
});

// ─── Large videos: parts by byte range, across calls ────────────

const MIB = 1024 * 1024;
const BIG = 'https://media.example.com/big.mp4';
const BIG_ARGS = { video_url: BIG, title: 'Big film', privacy_status: 'unlisted', contains_synthetic_media: false, part_mb: 1 };

/** A video file: an MP4 header, then bytes that tell every part apart. */
function videoFile(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + (i >> 16)) & 0xff;
  bytes.set(MP4.subarray(0, 16));
  return bytes;
}

const sameBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** A file server that answers a Range request with 206 and the part; `whole` answers 200 with the file, as through a host that drops Range. */
function fileServer(file, { etag = '"v1"', whole = false } = {}) {
  const server = { reads: [], etag };
  server.handler = (request) => {
    server.reads.push(request.headers.range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (whole || !match) return bytesResponse(200, file, { 'content-type': 'video/mp4', 'content-length': String(file.length), etag: server.etag });
    const first = Number(match[1]);
    if (first >= file.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.length}` } });
    const last = Math.min(Number(match[2]), file.length - 1);
    return bytesResponse(206, file.slice(first, last + 1), {
      'content-type': 'video/mp4',
      'content-length': String(last - first + 1),
      'content-range': `bytes ${first}-${last}/${file.length}`,
      etag: server.etag,
    });
  };
  return server;
}

/**
 * Downloads under a host's guarded fetch rules: of the module's headers only
 * Accept and User-Agent go on, and Range as well when `passRange`; a reply
 * over `cap` bytes is refused as too large, by its Content-Length before it
 * is read, else while it is read.
 */
function hostDownloads(download, { cap, passRange }) {
  const tooLarge = () => Object.assign(new Error(`the file is larger than ${cap} bytes`), { code: 'TOO_LARGE' });
  return async (request) => {
    const headers = {};
    for (const name of ['accept', 'user-agent', ...(passRange ? ['range'] : [])]) {
      if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    }
    const response = await download({ ...request, headers });
    if (Number(response.headers.get('content-length')) > cap) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > cap) throw tooLarge();
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
}

const resumeIncomplete = (received) => new Response(null, { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });

/**
 * A YouTube upload address that keeps the bytes it gets. Each part must start
 * at the first byte it lacks. `take(first, last)` says up to where it keeps a
 * part (all of it by default); `onPart` runs before it answers, `answer`
 * replaces its answer to a part.
 */
function uploadSession(file, { take, onPart, answer } = {}) {
  const session = { received: 0, parts: [], asks: 0 };
  session.handler = (request) => {
    const range = request.headers['content-range'];
    if (/^bytes \*\/\d+$/.test(range)) {
      session.asks += 1;
      assert.equal(range, `bytes */${file.length}`);
      assert.equal(request.body.length, 0, 'a question carries no bytes');
      return session.received >= file.length ? jsonResponse(201, fx('video-uploaded.json')) : resumeIncomplete(session.received);
    }
    const [first, last, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range).slice(1).map(Number);
    assert.equal(total, file.length);
    assert.equal(first, session.received, 'a part starts at the first byte YouTube lacks');
    assert.ok(sameBytes(request.body, file.subarray(first, last + 1)), `the bytes of ${first}-${last}`);
    session.parts.push([first, last]);
    onPart?.(first, last);
    session.received = take ? take(first, last) : last + 1;
    const replaced = answer?.(first, last);
    if (replaced) return replaced;
    return session.received >= file.length ? jsonResponse(201, fx('video-uploaded.json')) : resumeIncomplete(session.received);
  };
  return session;
}

function bigUpload(file, { server = fileServer(file), session = uploadSession(file), accounts = LOCKED, clock = false, host } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const advance = clock ? controlClock(context) : undefined;
  // Through to the current handlers, so a test can hold one back. `host` puts a host's download rules in between.
  const download = (request) => server.handler(request);
  const fetch = fakeFetch(youtube({
    [`GET ${BIG}`]: host ? hostDownloads(download, host) : download,
    [`PUT ${API}/upload/youtube/v3/videos`]: (request) => session.handler(request),
  }));
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs, server, session, advance };
}

const partPuts = (fetch) => fetch.calls.filter((call) => call.method === 'PUT' && !call.headers['content-range'].startsWith('bytes */'));

test('upload_video reads a large video part by part by byte range, and sends each part once', async () => {
  const file = videoFile(2.5 * MIB);
  const { module, fetch, ctx, server, session } = bigUpload(file);
  const { payload, isError } = await callTool(module, 'upload_video', BIG_ARGS, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(pathsOf(fetch), [
    'GET /youtube/v3/channels',
    'GET /big.mp4', 'POST /upload/youtube/v3/videos', 'PUT /upload/youtube/v3/videos',
    'GET /big.mp4', 'PUT /upload/youtube/v3/videos',
    'GET /big.mp4', 'PUT /upload/youtube/v3/videos',
  ], 'one part in memory at a time: read, send, read, send');
  assert.deepEqual(server.reads, ['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-2621439']);
  assert.deepEqual(session.parts, [[0, 1048575], [1048576, 2097151], [2097152, 2621439]]);
  assert.equal(session.asks, 0, 'a fresh upload asks nothing');
  assert.equal(fetch.calls[2].headers['x-upload-content-length'], String(file.length), 'YouTube is told the size from the first part\'s Content-Range');
  for (const call of fetch.calls.filter((item) => item.path === '/big.mp4')) {
    assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'range', 'user-agent'], 'a download carries no token');
  }
  for (const call of partPuts(fetch)) {
    assert.equal(call.url, UPLOAD_URL);
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['content-type'], 'video/mp4');
  }
  assert.equal(payload.done, true);
  assert.equal(payload.id, 'vid0000009z');
  assert.equal(payload.bytes, file.length);
  assert.equal(payload.nextCursor, undefined);
});

test('a call stops starting parts before its time runs out, and the next call goes on where YouTube stopped', async () => {
  const file = videoFile(3.5 * MIB);
  let advance;
  const session = uploadSession(file, { onPart: () => advance(9_000) });
  const upload = bigUpload(file, { session, clock: true });
  advance = upload.advance;
  const { module, fetch, ctx } = upload;

  // Each part takes 9 s: a third one still fits 35 s (18 s + 1.5 x 9 s), a fourth would not (27 s + 13.5 s).
  const first = await callTool(module, 'upload_video', BIG_ARGS, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(first.payload.done, false);
  assert.equal(first.payload.bytes_uploaded, 3 * MIB);
  assert.equal(first.payload.bytes_total, file.length);
  assert.equal(first.payload.stopped, undefined, 'it stopped for time, not for a problem');
  assert.match(first.payload.next, /^To go on, call upload_video again with the same arguments and cursor set to nextCursor, until done is true\. Each call asks YouTube how far it got and sends only the rest/);
  assert.match(first.payload.nextCursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(session.parts, [[0, 1048575], [1048576, 2097151], [2097152, 3145727]]);

  const sent = fetch.calls.length;
  const second = await callTool(module, 'upload_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.isError, false, second.payload.error);
  assert.deepEqual(pathsOf(fetch).slice(sent), ['PUT /upload/youtube/v3/videos', 'GET /big.mp4', 'PUT /upload/youtube/v3/videos'], 'it asks YouTube first, then reads and sends the rest');
  assert.equal(fetch.calls[sent].headers['content-range'], `bytes */${file.length}`);
  assert.equal(fetch.calls[sent + 1].headers.range, 'bytes=3145728-3670015');
  assert.deepEqual(session.parts.at(-1), [3145728, 3670015]);
  assert.equal(session.parts.length, 4, 'no part went twice');
  assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 1, 'one upload, opened once');
  assert.equal(second.payload.done, true);
  assert.equal(second.payload.id, 'vid0000009z');

  // A cursor of a finished upload only reads the video back.
  const again = await callTool(module, 'upload_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, ctx);
  assert.equal(again.payload.done, true);
  assert.equal(again.payload.id, 'vid0000009z');
  assert.equal(session.parts.length, 4);
});

test('when YouTube keeps only part of a part, the next part starts at the first byte it lacks', async () => {
  const file = videoFile(2 * MIB);
  const session = uploadSession(file, { take: (first, last) => (first === 0 ? 512 * 1024 : last + 1) });
  const { module, ctx, server } = bigUpload(file, { session });
  const { payload } = await callTool(module, 'upload_video', BIG_ARGS, ctx);
  assert.equal(payload.done, true, payload.error);
  assert.deepEqual(server.reads, ['bytes=0-1048575', 'bytes=524288-1572863', 'bytes=1572864-2097151']);
  assert.deepEqual(session.parts, [[0, 1048575], [524288, 1572863], [1572864, 2097151]]);
});

test('through a host that drops the Range header, the parts come from the whole file, across calls too', async () => {
  const file = videoFile(2.5 * MIB);
  const server = fileServer(file, { whole: true });
  const quick = bigUpload(file, { server });
  const { payload } = await callTool(quick.module, 'upload_video', BIG_ARGS, quick.ctx);
  assert.equal(payload.done, true, payload.error);
  assert.equal(server.reads.length, 1, 'the whole file was read once, for every part');
  assert.deepEqual(quick.session.parts, [[0, 1048575], [1048576, 2097151], [2097152, 2621439]]);

  // A part that takes 30 s leaves no time for another: each call reads the whole file and sends one part.
  let advance;
  const session = uploadSession(file, { onPart: () => advance(30_000) });
  const slow = bigUpload(file, { server: fileServer(file, { whole: true }), session, clock: true });
  advance = slow.advance;
  const first = await callTool(slow.module, 'upload_video', BIG_ARGS, slow.ctx);
  assert.equal(first.payload.bytes_uploaded, MIB);
  const second = await callTool(slow.module, 'upload_video', { ...BIG_ARGS, cursor: first.payload.nextCursor }, slow.ctx);
  assert.equal(second.payload.bytes_uploaded, 2 * MIB);
  const third = await callTool(slow.module, 'upload_video', { ...BIG_ARGS, cursor: second.payload.nextCursor }, slow.ctx);
  assert.equal(third.payload.done, true, third.payload.error);
  assert.deepEqual(session.parts, [[0, 1048575], [1048576, 2097151], [2097152, 2621439]]);
  assert.equal(second.payload.nextCursor, first.payload.nextCursor, 'the cursor stays the same: how far the upload got is asked of YouTube');
});

test('a video over the host\'s download limit, with no byte ranges, is refused before anything reaches YouTube', async () => {
  const { module, fetch, ctx } = setup(youtube({
    [`GET ${BIG}`]: () => {
      throw Object.assign(new Error('the file is larger than 26214400 bytes'), { code: 'TOO_LARGE' });
    },
  }));
  const { payload, isError } = await callTool(module, 'upload_video', BIG_ARGS, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /^The host refused the download as too large for it: .*does not pass byte-range requests \(the Range header\) on.*Use a smaller video, a host that passes byte ranges on, or a smaller part_mb\. Nothing was changed\.$/);
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels', 'GET /big.mp4'], 'no upload was opened');
});

test('a video over the host\'s download limit goes up part by part when the host passes Range on, and is refused untouched when it drops it', async () => {
  const cap = 50 * MIB;
  const file = videoFile(60 * MIB + 123);
  const args = { ...BIG_ARGS, part_mb: 24 };

  // Range dropped: the whole file comes back, over the limit, and YouTube is not reached.
  const dropping = bigUpload(file, { host: { cap, passRange: false } });
  const refused = await callTool(dropping.module, 'upload_video', args, dropping.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /^The host refused the download as too large for it: .* Nothing was changed\.$/);
  assert.deepEqual(dropping.server.reads, [undefined], 'the file server got no Range header');
  assert.deepEqual(pathsOf(dropping.fetch), ['GET /youtube/v3/channels', 'GET /big.mp4'], 'no upload was opened');

  // Range passed on: every download is one part within the limit, never the whole file, across calls.
  let advance;
  const session = uploadSession(file, { onPart: () => advance(12_000) });
  const passing = bigUpload(file, { session, clock: true, host: { cap, passRange: true } });
  advance = passing.advance;
  // Each part takes 12 s: a second one fits 35 s (12 s + 1.5 x 12 s), a third does not (24 s + 18 s).
  const first = await callTool(passing.module, 'upload_video', args, passing.ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.deepEqual([first.payload.done, first.payload.bytes_uploaded, first.payload.bytes_total], [false, 48 * MIB, file.length]);
  const second = await callTool(passing.module, 'upload_video', { ...args, cursor: first.payload.nextCursor }, passing.ctx);
  assert.equal(second.isError, false, second.payload.error);
  assert.equal(second.payload.done, true);
  assert.equal(second.payload.id, 'vid0000009z');
  assert.equal(second.payload.bytes, file.length);
  assert.deepEqual(passing.server.reads, ['bytes=0-25165823', 'bytes=25165824-50331647', 'bytes=50331648-62914682']);
  assert.deepEqual(session.parts, [[0, 25165823], [25165824, 50331647], [50331648, 62914682]]);
  assert.equal(session.asks, 1, 'the second call asked YouTube how far the upload got');
  assert.equal(passing.fetch.calls.filter((call) => call.method === 'POST').length, 1, 'one upload, opened once');
});

test('a last part without a clear answer: YouTube is asked once, and the video comes back if it was made', async () => {
  const file = videoFile(1.5 * MIB);
  const failLast = (first, last) => (last === file.length - 1 ? jsonResponse(503, { error: { code: 503, message: 'Backend Error' } }) : undefined);

  // YouTube got every byte and made the video: the question answers with it.
  const made = bigUpload(file, { session: uploadSession(file, { answer: failLast }) });
  const done = await callTool(made.module, 'upload_video', BIG_ARGS, made.ctx);
  assert.equal(done.payload.done, true, done.payload.error);
  assert.equal(done.payload.id, 'vid0000009z');
  assert.equal(made.session.asks, 1);
  assert.equal(partPuts(made.fetch).length, 2);

  // YouTube kept only the first part: nothing was made, and the cursor goes on.
  const kept = bigUpload(file, { session: uploadSession(file, { answer: failLast, take: (first, last) => (last === file.length - 1 ? first : last + 1) }) });
  const partial = await callTool(kept.module, 'upload_video', BIG_ARGS, kept.ctx);
  assert.equal(partial.isError, false, partial.payload.error);
  assert.equal(partial.payload.done, false);
  assert.equal(partial.payload.bytes_uploaded, MIB);
  assert.match(partial.payload.stopped, /^YouTube did not answer the last part clearly \(HTTP 503: Backend Error\); it has 1,048,576 of the 1,572,864 bytes\.$/);
  assert.ok(partial.payload.nextCursor);
  assert.equal(partPuts(kept.fetch).length, 2, 'the part was not sent again in the same call');
});

test('a cursor goes on only with its own video_url and an upload YouTube still has', async () => {
  const file = videoFile(2 * MIB);
  let advance;
  const session = uploadSession(file, { onPart: () => advance(30_000) });
  const upload = bigUpload(file, { session, clock: true });
  advance = upload.advance;
  const { module, fetch, ctx } = upload;
  const { payload } = await callTool(module, 'upload_video', BIG_ARGS, ctx);
  const cursor = payload.nextCursor;
  assert.ok(cursor);
  const sent = fetch.calls.length;

  const other = await callTool(module, 'upload_video', { ...BIG_ARGS, video_url: 'https://media.example.com/other.mp4', cursor }, ctx);
  assert.match(other.payload.error, /The cursor belongs to an upload of another video_url/);
  const foreign = Buffer.from(JSON.stringify({ t: 'upload_video', s: 'https://uploads.example.net/put?upload_id=1', n: file.length, p: MIB, y: 'video/mp4', u: '0123456789abcdef' })).toString('base64url');
  const crafted = await callTool(module, 'upload_video', { ...BIG_ARGS, cursor: foreign }, ctx);
  assert.match(crafted.payload.error, /The cursor holds no upload/);
  const listCursor = await callTool(module, 'upload_video', { ...BIG_ARGS, cursor: Buffer.from(JSON.stringify({ t: 'list_videos', o: 0 })).toString('base64url') }, ctx);
  assert.match(listCursor.payload.error, /The cursor is not valid for this tool/);
  assert.equal(fetch.calls.length, sent, 'nothing was sent for a cursor that does not fit');

  // YouTube dropped the upload: start again.
  const gone = setup(youtube({ [`PUT ${API}/upload/youtube/v3/videos`]: () => jsonResponse(404, { error: { code: 404, message: 'Not Found' } }) }));
  const expired = await callTool(gone.module, 'upload_video', { ...BIG_ARGS, cursor }, gone.ctx);
  assert.match(expired.payload.error, /^YouTube no longer has this upload: .*If list_videos does not show the video, start the upload again without cursor\.$/);
  assert.equal(partPuts(gone.fetch).length, 0);
});

test('a file that changed since the upload started is not sent on', async () => {
  const file = videoFile(2 * MIB);
  let advance;
  const server = fileServer(file);
  const session = uploadSession(file, { onPart: () => advance(30_000) });
  const upload = bigUpload(file, { server, session, clock: true });
  advance = upload.advance;
  const { payload } = await callTool(upload.module, 'upload_video', BIG_ARGS, upload.ctx);

  server.etag = '"v2"';
  const changed = await callTool(upload.module, 'upload_video', { ...BIG_ARGS, cursor: payload.nextCursor }, upload.ctx);
  assert.match(changed.payload.error, /^The file at video_url changed since the upload started \(its ETag is different\)\. The rest cannot be sent: upload the file again without cursor/);

  const longer = bigUpload(videoFile(3 * MIB), { session: uploadSession(file, { onPart: () => {} }) });
  const resized = await callTool(longer.module, 'upload_video', { ...BIG_ARGS, cursor: payload.nextCursor }, longer.ctx);
  assert.match(resized.payload.error, /^The file at video_url is 3,145,728 bytes now, not the 2,097,152 it had when the upload started\./);
  assert.equal(partPuts(longer.fetch).length, 0);
  assert.equal(session.parts.length, 1);
});

test('going on with an upload needs the connected channel chosen, like starting one', async () => {
  const file = videoFile(2 * MIB);
  let advance;
  const session = uploadSession(file, { onPart: () => advance(30_000) });
  const upload = bigUpload(file, { session, clock: true });
  advance = upload.advance;
  const { payload } = await callTool(upload.module, 'upload_video', BIG_ARGS, upload.ctx);

  const elsewhere = bigUpload(file, { accounts: { channels: [OTHER] } });
  const refused = await callTool(elsewhere.module, 'upload_video', { ...BIG_ARGS, cursor: payload.nextCursor }, elsewhere.ctx);
  assert.match(refused.payload.error, new RegExp(`The channel ${CH} is not among the channels chosen for this connection`));
  assert.deepEqual(pathsOf(elsewhere.fetch), ['GET /youtube/v3/channels']);
});

test('a problem in the middle of an upload stops the call with the cursor, and nothing is sent twice', async () => {
  const file = videoFile(3 * MIB);

  const server = fileServer(file);
  const reading = bigUpload(file, { server: { ...server, handler: (request) => (request.headers.range === 'bytes=1048576-2097151' ? jsonResponse(403, { message: 'Forbidden' }) : server.handler(request)) } });
  const unread = await callTool(reading.module, 'upload_video', BIG_ARGS, reading.ctx);
  assert.equal(unread.isError, false, unread.payload.error);
  assert.deepEqual([unread.payload.done, unread.payload.bytes_uploaded], [false, MIB]);
  assert.equal(unread.payload.stopped, 'Reading the next part of the video failed. The video URL answered HTTP 403.');
  assert.match(unread.payload.next, /^Deal with what stopped says first, then call upload_video again/);
  assert.ok(unread.payload.nextCursor);

  const limited = bigUpload(file, { session: uploadSession(file, { answer: (first) => (first === MIB ? jsonResponse(429, { error: { code: 429, message: 'Too Many Requests' } }, { 'retry-after': '30' }) : undefined), take: (first, last) => (first === MIB ? first : last + 1) }) });
  const rate = await callTool(limited.module, 'upload_video', BIG_ARGS, limited.ctx);
  assert.deepEqual([rate.payload.done, rate.payload.bytes_uploaded, rate.payload.retryAfter], [false, MIB, 30]);
  assert.match(rate.payload.stopped, /^YouTube rate limit reached \(HTTP 429\)\. Retry after 30 seconds\.$/);
  assert.match(rate.payload.next, /^Deal with what stopped says first \(wait 30 seconds\), then call upload_video again with the same arguments and cursor set to nextCursor/);
  assert.equal(partPuts(limited.fetch).length, 2);

  const stuck = bigUpload(file, { session: uploadSession(file, { take: () => 0 }) });
  const none = await callTool(stuck.module, 'upload_video', BIG_ARGS, stuck.ctx);
  assert.deepEqual([none.payload.done, none.payload.bytes_uploaded], [false, 0]);
  assert.match(none.payload.stopped, /YouTube took none of the last part/);
  assert.equal(partPuts(stuck.fetch).length, 1, 'the same part is not sent again in a loop');
});

test('a reply with another byte range than the one asked for, or no file size, is not sent on', async () => {
  const file = videoFile(2 * MIB);
  const server = fileServer(file);
  const sizeless = bigUpload(file, { server: { handler: () => bytesResponse(206, file.slice(0, MIB), { 'content-range': `bytes 0-${MIB - 1}/*` }) } });
  const unsized = await callTool(sizeless.module, 'upload_video', BIG_ARGS, sizeless.ctx);
  assert.equal(unsized.payload.error, 'The video URL did not say how large the file is, which YouTube needs to know. Nothing was changed.');
  assert.deepEqual(pathsOf(sizeless.fetch), ['GET /youtube/v3/channels', 'GET /big.mp4']);

  // The second part comes back as the first one: it is not sent as the second.
  const shifted = bigUpload(file, { server: { handler: (request) => (request.headers.range === 'bytes=0-1048575' ? server.handler(request) : bytesResponse(206, file.slice(0, MIB), { 'content-range': `bytes 0-${MIB - 1}/${file.length}` })) } });
  const wrong = await callTool(shifted.module, 'upload_video', BIG_ARGS, shifted.ctx);
  assert.deepEqual([wrong.payload.done, wrong.payload.bytes_uploaded], [false, MIB]);
  assert.equal(wrong.payload.stopped, 'Reading the next part of the video failed. The video URL answered with another part of the file than the one asked for.');
  assert.deepEqual(shifted.session.parts, [[0, MIB - 1]]);

  // A shorter part than asked for, before the end of the file, would make a part YouTube does not take.
  const half = MIB + MIB / 2;
  const short = bigUpload(file, { server: { handler: (request) => (request.headers.range === 'bytes=0-1048575' ? server.handler(request) : bytesResponse(206, file.slice(MIB, half), { 'content-range': `bytes ${MIB}-${half - 1}/${file.length}` })) } });
  const cut = await callTool(short.module, 'upload_video', BIG_ARGS, short.ctx);
  assert.equal(cut.payload.stopped, 'Reading the next part of the video failed. The video URL answered with another part of the file than the one asked for.');
  assert.deepEqual(short.session.parts, [[0, MIB - 1]]);
});

test('two calls never send the same upload at once', async () => {
  const file = videoFile(2 * MIB);
  let advance;
  const session = uploadSession(file, { onPart: () => advance(30_000) });
  const upload = bigUpload(file, { session, clock: true });
  advance = upload.advance;
  const { payload } = await callTool(upload.module, 'upload_video', BIG_ARGS, upload.ctx);
  assert.equal(payload.done, false);

  // The first call waits at its question to YouTube while the second one comes in with the same cursor.
  const answer = session.handler;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  session.handler = async (request) => {
    await gate;
    return answer(request);
  };
  const args = { ...BIG_ARGS, cursor: payload.nextCursor };
  const going = callTool(upload.module, 'upload_video', args, upload.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sent = upload.fetch.calls.length;
  const second = await callTool(upload.module, 'upload_video', args, upload.ctx);
  assert.equal(second.payload.error, 'Another call is sending this upload right now: wait for its result, then go on with the cursor. Nothing was sent.');
  assert.equal(upload.fetch.calls.length, sent, 'the second call sent nothing');
  release();
  const first = await going;
  assert.equal(first.payload.done, true, first.payload.error);
  assert.deepEqual(session.parts, [[0, MIB - 1], [MIB, 2 * MIB - 1]]);

  // Once the first call is over, the upload is free again.
  const after = await callTool(upload.module, 'upload_video', args, upload.ctx);
  assert.equal(after.payload.done, true, after.payload.error);
});

test('upload log lines carry no token, no URL and no arguments', async () => {
  const file = videoFile(1.5 * MIB);
  const { module, ctx, logs } = bigUpload(file);
  const { payload } = await callTool(module, 'upload_video', { ...BIG_ARGS, title: 'Secret title' }, ctx);
  assert.equal(payload.done, true, payload.error);
  assert.deepEqual(logs.map((line) => line.replace(/ \d+ms$/, '')), [
    'youtube upload_video GET 200',
    'youtube upload_video media GET 206',
    'youtube upload_video POST 200',
    'youtube upload_video PUT 308',
    'youtube upload_video media GET 206',
    'youtube upload_video PUT 201',
  ]);
  for (const line of logs) assert.equal(/ya29|Secret|media\.example|upload_id/.test(line), false, line);
});

test('set_thumbnail uploads a JPEG; a 403 explains the verified-channel rule', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload } = await callTool(module, 'set_thumbnail', { video_id: V1, image_url: 'https://media.example.com/thumb.jpg' }, ctx);
  const set = fetch.calls.find((call) => call.path === '/upload/youtube/v3/thumbnails/set');
  assert.equal(set.query.videoId, V1);
  assert.equal(set.headers['content-type'], 'image/jpeg');
  assert.deepEqual([...set.body], [...JPEG]);
  assert.equal(payload.thumbnails.maxres, `https://i.ytimg.com/vi/${V1}/maxresdefault.jpg`);

  const unverified = setup(youtube({ [`POST ${API}/upload/youtube/v3/thumbnails/set`]: () => jsonResponse(403, { error: { code: 403, message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails." } }) }));
  const refused = await callTool(unverified.module, 'set_thumbnail', { video_id: V1, image_url: 'https://media.example.com/thumb.jpg' }, unverified.ctx);
  assert.match(refused.payload.error, /custom thumbnails need a verified channel .*\(HTTP 403\)/);
});

test('playlists: list (private ones too for the connected channel), create, add a video, list its items', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const listed = await callTool(module, 'list_playlists', {}, ctx);
  const read = fetch.calls.find((call) => call.path === '/youtube/v3/playlists');
  assert.equal(read.query.mine, 'true');
  assert.equal(read.query.channelId, undefined);
  assert.deepEqual(listed.payload.playlists[1], { id: 'PLexamplePlaylistTwo0000', title: 'Drafts', privacy_status: 'private', item_count: 3, published_at: '2026-02-10T10:00:00Z', url: 'https://www.youtube.com/playlist?list=PLexamplePlaylistTwo0000' });

  const created = await callTool(module, 'create_playlist', { title: 'Ad series 2026', description: 'Videos for the winter campaign.' }, ctx);
  const insert = fetch.calls.find((call) => call.method === 'POST' && call.path === '/youtube/v3/playlists');
  assert.equal(insert.query.part, 'snippet,status');
  assert.deepEqual(insert.json, { snippet: { title: 'Ad series 2026', description: 'Videos for the winter campaign.' }, status: { privacyStatus: 'private' } });
  assert.equal(created.payload.id, 'PLnewPlaylist00000000000');

  const added = await callTool(module, 'add_to_playlist', { playlist_id: 'PLnewPlaylist00000000000', video_id: V1, position: 0 }, ctx);
  const item = fetch.calls.find((call) => call.method === 'POST' && call.path === '/youtube/v3/playlistItems');
  assert.deepEqual(item.json, { snippet: { playlistId: 'PLnewPlaylist00000000000', resourceId: { kind: 'youtube#video', videoId: V1 }, position: 0 } });
  assert.deepEqual(added.payload, { item_id: 'UExuZXdQbGF5bGlzdDAwMDAwMDAwMDAwMDA1', playlist_id: 'PLnewPlaylist00000000000', video_id: V1, position: 0 });

  const items = await callTool(module, 'list_playlist_items', { playlist_id: 'PLexamplePlaylistOne0000' }, ctx);
  assert.deepEqual(items.payload.items[0], { item_id: 'UExleGFtcGxlUGxheWxpc3RPbmUwMDAw1', video_id: V1, title: 'How we edit a short film', position: 0, published_at: '2026-11-20T09:00:00Z', privacy_status: 'public', owner_channel_id: CH });
  const own = fetch.calls.filter((call) => call.query.part === 'id');
  assert.equal(own.length, 1, 'the connected channel is read once and kept');
});

test('writes refuse a connected channel that is not chosen, before anything is changed', async () => {
  const { module, fetch, ctx } = setup(youtube(), { channels: [OTHER] });
  for (const [tool, args] of [
    ['create_playlist', { title: 'X' }],
    ['add_to_playlist', { playlist_id: 'PLnewPlaylist00000000000', video_id: V1 }],
    ['set_thumbnail', { video_id: V1, image_url: 'https://media.example.com/thumb.jpg' }],
    ['upload_video', { video_url: 'https://media.example.com/launch.mp4', title: 'X', privacy_status: 'private', contains_synthetic_media: false }],
  ]) {
    const { payload } = await callTool(module, tool, args, ctx);
    assert.match(payload.error, new RegExp(`The channel ${CH} is not among the channels chosen for this connection\\. Use one of: ${OTHER}`), tool);
  }
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels'], 'only the connected channel was read');
});

test('get_analytics_report runs a ready report, adds video titles and pages by start index', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload, isError } = await callTool(module, 'get_analytics_report', { report: 'top_videos', start_date: '2026-03-01', end_date: '2026-04-01', max_results: 2 }, ctx);
  assert.equal(isError, false, payload.error);
  const report = fetch.calls[0];
  assert.equal(report.origin, ANALYTICS);
  assert.deepEqual(report.query, {
    ids: `channel==${CH}`,
    startDate: '2026-03-01',
    endDate: '2026-04-01',
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
    dimensions: 'video',
    sort: '-views',
    maxResults: '2',
    startIndex: '1',
  });
  assert.deepEqual(payload.columns, ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage']);
  assert.deepEqual(payload.rows[0], { video: V1, views: 9200, estimatedMinutesWatched: 15600, averageViewDuration: 102, averageViewPercentage: 68.1, title: 'How we edit a short film' });
  assert.ok(payload.nextCursor);
  await callTool(module, 'get_analytics_report', { report: 'top_videos', start_date: '2026-03-01', end_date: '2026-04-01', max_results: 2, cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[2].query.startIndex, '3');

  const retention = await callTool(module, 'get_analytics_report', { report: 'retention', start_date: '2026-03-01', end_date: '2026-04-01' }, ctx);
  assert.match(retention.payload.error, /The retention report needs video_id/);
  const both = await callTool(module, 'get_analytics_report', { report: 'daily', metrics: ['views'], start_date: '2026-03-01', end_date: '2026-04-01' }, ctx);
  assert.match(both.payload.error, /Give either report or your own metrics/);
  const sent = fetch.calls.length;

  // Neither report nor metrics: the daily channel overview.
  await callTool(module, 'get_analytics_report', { start_date: '2026-03-01', end_date: '2026-04-01' }, ctx);
  const daily = fetch.calls[sent].query;
  assert.equal(daily.metrics, 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares');
  assert.deepEqual([daily.dimensions, daily.sort, daily.maxResults, daily.startIndex], ['day', 'day', undefined, undefined]);

  await callTool(module, 'get_analytics_report', { start_date: '2026-03-01', end_date: '2026-04-01', metrics: ['views'], dimensions: ['country'], filters: 'country==US', video_id: V1, sort: '-views' }, ctx);
  const custom = fetch.calls.find((call, index) => index > sent && call.origin === ANALYTICS && call.query.metrics === 'views');
  assert.equal(custom.query.filters, `country==US;video==${V1}`);
  assert.equal(custom.query.dimensions, 'country');
});

test('screen_videos_for_ads checks each upload against the ad format and the view percentage', async () => {
  const { module, fetch, ctx } = setup(youtube());
  const { payload, isError } = await callTool(module, 'screen_videos_for_ads', { ad_format: 'bumper', min_views: 1000 }, ctx);
  assert.equal(isError, false, payload.error);
  const analytics = fetch.calls.find((call) => call.origin === ANALYTICS);
  assert.equal(analytics.query.filters, `video==${V1},${V2},${V3}`);
  assert.equal(analytics.query.metrics, 'views,averageViewPercentage');
  const [first, second, third] = payload.videos;
  assert.equal(first.eligible, false);
  assert.deepEqual(first.reasons, ['150 s long; bumper needs at most 6 seconds', 'average view percentage 31.2, below 40']);
  assert.deepEqual(second.reasons, ['it is private', '0 views, fewer than 1,000', '14 s long; bumper needs at most 6 seconds']);
  assert.deepEqual(third.reasons, ['it is made for kids']);
  assert.equal(third.average_view_percentage, 81.5);
  assert.deepEqual(payload.criteria, { ad_format: 'bumper', length: 'at most 6 seconds', min_views: 1000, min_view_percentage: 40 });

  const noAnalytics = setup(youtube({ [`GET ${ANALYTICS}/v2/reports`]: () => jsonResponse(403, { error: { code: 403, message: 'Insufficient permission.' } }) }));
  const partial = await callTool(noAnalytics.module, 'screen_videos_for_ads', {}, noAnalytics.ctx);
  assert.equal(partial.isError, false);
  assert.match(partial.payload.note, /could not be read from YouTube Analytics/);
  assert.equal(partial.payload.videos[0].eligible, true);
});

test('errors: the quota message without its markup, a rate limit, an expired token', async () => {
  const quota = setup(() => jsonResponse(403, fx('error-quota.json')));
  const exceeded = await callTool(quota.module, 'list_videos', {}, quota.ctx);
  assert.match(exceeded.payload.error, /YouTube refused the request \(HTTP 403\): The request cannot be completed because you have exceeded your quota\./);
  assert.doesNotMatch(exceeded.payload.error, /<a|<\/a>/);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'Too Many Requests' } }, { 'retry-after': '60' }));
  const rate = await callTool(limited.module, 'list_channels', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 60);

  const expired = setup(() => jsonResponse(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } }));
  const denied = await callTool(expired.module, 'list_channels', {}, expired.ctx);
  assert.match(denied.payload.error, /Check that the YouTube access token is correct and still active/);
});

test('api_get and api_request keep to the YouTube paths and the channel choice', async () => {
  const { module, fetch, ctx } = setup(youtube({
    [`GET ${API}/youtube/v3/commentThreads`]: () => jsonResponse(200, { items: [] }),
    [`DELETE ${API}/youtube/v3/videos`]: () => new Response(null, { status: 204 }),
  }));
  const comments = await callTool(module, 'api_get', { path: '/youtube/v3/commentThreads', query: { part: 'snippet', videoId: V1 } }, ctx);
  assert.equal(comments.isError, false, comments.payload.error);
  assert.equal(fetch.calls[0].query.part, 'id', 'the connected channel is checked against the choice first');
  const foreign = await callTool(module, 'api_get', { path: '/youtube/v3/search', query: { part: 'snippet', channelId: OTHER } }, ctx);
  assert.match(foreign.payload.error, new RegExp(`The channel ${OTHER} is not among the channels chosen`));
  const owner = await callTool(module, 'api_get', { path: '/youtube/v3/videos', query: { id: V1, onBehalfOfContentOwner: 'x' } }, ctx);
  assert.match(owner.payload.error, /on behalf of a content owner are not available/);
  const upload = await callTool(module, 'api_request', { method: 'POST', path: '/upload/youtube/v3/videos' }, ctx);
  assert.match(upload.payload.error, /start with \/youtube\/v3\//);
  const report = await callTool(module, 'api_get', { origin: ANALYTICS, path: '/v2/reports', query: { ids: `channel==${OTHER}`, startDate: '2026-01-01', endDate: '2026-01-31', metrics: 'views' } }, ctx);
  assert.match(report.payload.error, new RegExp(`The channel ${OTHER} is not among`));
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels', 'GET /youtube/v3/commentThreads']);

  const deleted = await callTool(module, 'api_request', { method: 'DELETE', path: '/youtube/v3/videos', query: { id: V3 } }, ctx);
  assert.equal(deleted.isError, false, deleted.payload.error);
  assert.deepEqual(pathsOf(fetch).slice(2), ['DELETE /youtube/v3/videos'], 'the connected channel was checked once and kept');

  const broken = setup(youtube({ [`POST ${API}/youtube/v3/comments`]: () => jsonResponse(500, { error: { message: 'Backend Error' } }) }), null);
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: '/youtube/v3/comments', query: { part: 'snippet' }, json: { snippet: { parentId: 'abc', textOriginal: 'Thanks!' } } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('without the connected channel chosen, nothing it alone can see is read', async () => {
  // A fresh connection with nothing chosen, and a choice left from another channel's sign-in.
  for (const accounts of [{}, { channels: [OTHER] }]) {
    const { module, fetch, ctx } = setup(youtube({ [`GET ${API}/youtube/v3/commentThreads`]: () => jsonResponse(200, { items: [] }) }), accounts);
    for (const [tool, args] of [
      ['get_videos', { video_ids: [V2] }],
      ['list_playlist_items', { playlist_id: 'PLexamplePlaylistTwo0000' }],
      ['api_get', { path: '/youtube/v3/videos', query: { part: 'snippet,status', id: V2 } }],
      ['api_get', { path: '/youtube/v3/playlistItems', query: { part: 'snippet', playlistId: UP } }],
      ['api_get', { path: '/youtube/v3/commentThreads', query: { part: 'snippet', videoId: V2 } }],
      ['api_get', { path: '/youtube/v3/channels', query: { part: 'snippet', forHandle: '@examplestudio' } }],
    ]) {
      const { payload } = await callTool(module, tool, args, ctx);
      assert.match(payload.error, new RegExp(`The channel ${CH} is not among the channels chosen for this connection`), `${tool} ${JSON.stringify(accounts)}`);
    }
    assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/channels'], 'only the connected channel was read');
    assert.equal(fetch.calls[0].query.part, 'id');
  }
});

test('a cursor cannot point list_videos at another channel\'s uploads', async () => {
  const OTHER_UP = 'UUzyxwvutsrqponmlkjihgfe';
  const { module, fetch, ctx } = setup(youtube({
    [`GET ${API}/youtube/v3/channels`]: (request) => jsonResponse(200, request.query.id === OTHER
      ? { items: [{ id: OTHER, contentDetails: { relatedPlaylists: { uploads: OTHER_UP } } }] }
      : fx('channel-id.json')),
    [`GET ${API}/youtube/v3/playlistItems`]: () => jsonResponse(200, { items: [] }),
  }), { channels: [OTHER] });
  // The connected channel's uploads list (with its private videos), labelled as the chosen channel's.
  const crafted = Buffer.from(JSON.stringify({ t: 'list_videos', u: UP, p: 'EAAaBlBUOkNESQ', o: 0, n: 500 })).toString('base64url');
  const { payload, isError } = await callTool(module, 'list_videos', { cursor: crafted }, ctx);
  assert.equal(isError, false, payload.error);
  const read = fetch.calls.find((call) => call.path === '/youtube/v3/playlistItems');
  assert.equal(read.query.playlistId, OTHER_UP, 'the uploads list was read again for the chosen channel');
  assert.equal(read.query.pageToken, undefined, 'the page of another list is not used');
  assert.equal(read.query.maxResults, '25', 'the page size stays within 1 to 50');
  assert.equal(fetch.calls.some((call) => call.query.playlistId === UP), false);
});

test('get_analytics_report takes no currency: revenue metrics need a scope this connection does not ask for', async () => {
  const { module, ctx } = setup(youtube());
  const report = module.tools.find((tool) => tool.name === 'get_analytics_report');
  assert.equal(report.inputSchema.properties.currency, undefined);
  const { payload } = await callTool(module, 'get_analytics_report', { start_date: '2026-03-01', end_date: '2026-04-01', currency: 'USD' }, ctx);
  assert.match(payload.error, /Invalid arguments/);
  const generic = module.tools.find((tool) => tool.name === 'api_get');
  assert.doesNotMatch(generic.description, /commentThreads with/);
  assert.match(generic.description, /youtube\.force-ssl/);
});

test('log lines carry no token and no arguments', async () => {
  const { module, ctx, logs } = setup(youtube());
  await callTool(module, 'update_video', { video_id: V2, title: 'Secret title', description: 'Private words' }, ctx);
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.match(line, /^youtube update_video (GET|PUT) 200 \d+ms$/);
    assert.equal(line.includes(TOKEN), false);
    assert.equal(/Secret|Private/.test(line), false);
  }
});
