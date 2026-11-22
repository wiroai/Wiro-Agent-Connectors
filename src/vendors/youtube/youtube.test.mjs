import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

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
  assert.equal(fetch.calls[0].query.id, `${V2},zzzzzzzzzzz`);
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

test('upload_video downloads the file, opens a resumable session and sends the bytes once', async () => {
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

  const start = fetch.calls[2];
  assert.equal(start.url, `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false`);
  assert.equal(start.headers['x-upload-content-type'], 'video/mp4');
  assert.equal(start.headers['x-upload-content-length'], String(MP4.length));
  assert.deepEqual(start.json, {
    snippet: { title: 'Launch film', description: 'Our new model in 60 seconds.', tags: ['launch', 'ai video'], categoryId: '28', defaultLanguage: 'en' },
    status: { privacyStatus: 'private', publishAt: '2036-10-20T07:00:00Z', embeddable: true, publicStatsViewable: true, license: 'youtube', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  });

  const send = fetch.calls[3];
  assert.equal(send.url, UPLOAD_URL);
  assert.equal(send.headers['content-type'], 'video/mp4');
  assert.equal(send.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual([...send.body], [...MP4]);

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

test('an upload whose bytes get no clear answer is reported as unknown, never sent twice', async () => {
  const { module, fetch, ctx } = setup(youtube({ [`PUT ${API}/upload/youtube/v3/videos`]: () => jsonResponse(503, { error: { code: 503, message: 'Backend Error' } }) }), null);
  const { payload } = await callTool(module, 'upload_video', { video_url: 'https://media.example.com/launch.mp4', title: 'X', privacy_status: 'unlisted', contains_synthetic_media: false }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'list_videos');
  assert.equal(fetch.calls.filter((call) => call.method === 'PUT').length, 1);
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
  const foreign = await callTool(module, 'api_get', { path: '/youtube/v3/search', query: { part: 'snippet', channelId: OTHER } }, ctx);
  assert.match(foreign.payload.error, new RegExp(`The channel ${OTHER} is not among the channels chosen`));
  const owner = await callTool(module, 'api_get', { path: '/youtube/v3/videos', query: { id: V1, onBehalfOfContentOwner: 'x' } }, ctx);
  assert.match(owner.payload.error, /on behalf of a content owner are not available/);
  const upload = await callTool(module, 'api_request', { method: 'POST', path: '/upload/youtube/v3/videos' }, ctx);
  assert.match(upload.payload.error, /start with \/youtube\/v3\//);
  const report = await callTool(module, 'api_get', { origin: ANALYTICS, path: '/v2/reports', query: { ids: `channel==${OTHER}`, startDate: '2026-01-01', endDate: '2026-01-31', metrics: 'views' } }, ctx);
  assert.match(report.payload.error, new RegExp(`The channel ${OTHER} is not among`));
  assert.deepEqual(pathsOf(fetch), ['GET /youtube/v3/commentThreads']);

  const deleted = await callTool(module, 'api_request', { method: 'DELETE', path: '/youtube/v3/videos', query: { id: V3 } }, ctx);
  assert.equal(deleted.isError, false, deleted.payload.error);
  assert.deepEqual(pathsOf(fetch).slice(1), ['GET /youtube/v3/channels', 'DELETE /youtube/v3/videos'], 'a write checks the connected channel first');

  const broken = setup(youtube({ [`POST ${API}/youtube/v3/comments`]: () => jsonResponse(500, { error: { message: 'Backend Error' } }) }), null);
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: '/youtube/v3/comments', query: { part: 'snippet' }, json: { snippet: { parentId: 'abc', textOriginal: 'Thanks!' } } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
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
