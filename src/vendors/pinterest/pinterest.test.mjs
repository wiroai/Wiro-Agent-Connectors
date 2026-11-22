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
  textBytes,
  textResponse,
} from '../../../tests/helpers.mjs';

const TOKEN = 'pina_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const credentials = { access_token: TOKEN };
const API = 'https://api.pinterest.com';
const UPLOAD = 'https://pinterest-media-upload.s3-accelerate.amazonaws.com';
const plain = (value) => JSON.parse(JSON.stringify(value));
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00]);

/** A fake Pinterest: routes by method and path; `overrides` replaces any route. */
function routes(overrides = {}) {
  const table = {
    'GET /v5/user_account': () => jsonResponse(200, fixture(import.meta.url, 'user-account.json')),
    'GET /v5/boards': () => jsonResponse(200, fixture(import.meta.url, 'boards.json')),
    'GET /v5/pins': () => jsonResponse(200, fixture(import.meta.url, 'pins.json')),
    'POST /v5/pins': () => jsonResponse(201, fixture(import.meta.url, 'pin-created.json')),
    ...overrides,
  };
  return (request) => {
    if (request.origin !== API && request.origin !== UPLOAD) {
      const media = table.media;
      if (!media) throw new Error(`unexpected media request ${request.url}`);
      return media(request);
    }
    const route = table[`${request.origin === UPLOAD ? 'UPLOAD ' : ''}${request.method} ${request.path}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.url}`);
    return route(request);
  };
}

function setup(overrides, options = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(routes(overrides));
  const { ctx, logs } = makeContext({ credentials, fetch, ...(options.signal ? { signal: options.signal } : {}) });
  return { module, context, fetch, ctx, logs };
}

const callsTo = (fetch, method, path) => fetch.calls.filter((call) => call.method === method && call.path === path);
const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test('the module calls the API and its upload storage only, with the OAuth access token', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.origins), [API, UPLOAD]);
  assert.deepEqual(plain(module.credentials), ['access_token']);
  assert.deepEqual(plain(module.requiredCredentials), [['access_token']]);
  assert.deepEqual(plain(module.accountPickers), [], 'boards are chosen per Pin, not as accounts');
});

test('get_account reads the account with the bearer token', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.pinterest.com/v5/user_account');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    id: '2783136121146311751',
    username: 'acmestudio',
    profile_url: 'https://www.pinterest.com/acmestudio/',
    account_type: 'BUSINESS',
    business_name: 'Acme Studio',
    board_count: 3,
    pin_count: 42,
    follower_count: 120,
    following_count: 15,
    monthly_views: 5400,
    website_url: 'https://www.example.com',
  });
});

test('list_boards pages with Pinterest\'s bookmark', async () => {
  const { module, fetch, ctx } = setup();
  const first = await callTool(module, 'list_boards', { page_size: 2 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.pinterest.com/v5/boards?page_size=2');
  assert.deepEqual(first.payload.boards[0], {
    id: '549755885175', name: 'Recipes', description: 'Summer recipes', privacy: 'PUBLIC', pin_count: 30, follower_count: 12, created_at: '2025-03-01T10:00:00', owner: 'acmestudio',
  });
  await callTool(module, 'list_boards', { cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].query, { page_size: '2', bookmark: 'Ym9va21hcmstYm9hcmRzLTI=' });
});

test('list_board_sections lists a board\'s sections; list_pins reads a board, a section, or every Pin', async () => {
  const { module, fetch, ctx } = setup({
    'GET /v5/boards/549755885175/sections': () => jsonResponse(200, fixture(import.meta.url, 'sections.json')),
    'GET /v5/boards/549755885175/pins': () => jsonResponse(200, fixture(import.meta.url, 'pins.json')),
    'GET /v5/boards/549755885175/sections/5027629787972154693/pins': () => jsonResponse(200, fixture(import.meta.url, 'pins.json')),
  });
  const sections = await callTool(module, 'list_board_sections', { board_id: '549755885175' }, ctx);
  assert.deepEqual(sections.payload, { board_id: '549755885175', sections: [{ id: '5027629787972154693', name: 'Salads' }, { id: '5027629787972154694', name: 'Desserts' }] });

  const board = await callTool(module, 'list_pins', { board_id: '549755885175', include_metrics: true }, ctx);
  assert.equal(callsTo(fetch, 'GET', '/v5/boards/549755885175/pins')[0].url, 'https://api.pinterest.com/v5/boards/549755885175/pins?page_size=25&pin_metrics=true');
  assert.deepEqual(board.payload.pins[0], {
    id: '813744226420795884',
    url: 'https://www.pinterest.com/pin/813744226420795884/',
    created_at: '2026-11-20T09:00:00',
    title: 'Sunset print',
    description: 'A warm sunset print for the living room.',
    link: 'https://www.example.com/prints/sunset',
    alt_text: 'An orange sunset over the sea, framed',
    board_id: '549755885175',
    media_type: 'image',
    image: 'https://i.pinimg.com/600x/aa/sunset.jpg',
    is_owner: true,
    metrics: { '90d': { pin_click: 7, impression: 200, clickthrough: 3 }, lifetime_metrics: { pin_click: 7, impression: 200, clickthrough: 3, reaction: 10, comment: 2 } },
  });
  assert.equal(board.payload.pins[1].image, 'https://i.pinimg.com/videos/thumbnails/originals/aa/clip.jpg');

  await callTool(module, 'list_pins', { board_id: '549755885175', board_section_id: '5027629787972154693', include_metrics: true }, ctx);
  assert.equal(callsTo(fetch, 'GET', '/v5/boards/549755885175/sections/5027629787972154693/pins')[0].query.pin_metrics, undefined, 'sections take no metrics');
  await callTool(module, 'list_pins', {}, ctx);
  assert.equal(callsTo(fetch, 'GET', '/v5/pins')[0].url, 'https://api.pinterest.com/v5/pins?page_size=25');
  const noBoard = await callTool(module, 'list_pins', { board_section_id: '5027629787972154693' }, ctx);
  assert.match(noBoard.payload.error, /board_section_id needs its board_id/);
});

test('create_pin creates an image Pin once, with only the fields given, and returns its link', async () => {
  const { module, fetch, ctx } = setup();
  const args = {
    board_id: '549755885175',
    board_section_id: '5027629787972154693',
    image_url: 'https://cdn.example.com/sunset.png',
    title: 'Sunset print',
    description: 'A warm sunset print.',
    link: 'https://www.example.com/prints/sunset',
    alt_text: 'An orange sunset over the sea',
    ai_disclosures: ['AI_MODIFIED'],
  };
  const { payload, isError } = await callTool(module, 'create_pin', args, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1, 'Pinterest fetches the image itself');
  const [sent] = fetch.calls;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.pinterest.com/v5/pins');
  assert.deepEqual(sent.json, {
    board_id: '549755885175',
    board_section_id: '5027629787972154693',
    title: 'Sunset print',
    description: 'A warm sunset print.',
    link: 'https://www.example.com/prints/sunset',
    alt_text: 'An orange sunset over the sea',
    ai_disclosures: { values: ['AI_MODIFIED'] },
    media_source: { source_type: 'image_url', url: 'https://cdn.example.com/sunset.png' },
  });
  assert.equal(payload.id, '813744226420795900');
  assert.equal(payload.url, 'https://www.pinterest.com/pin/813744226420795900/');

  const long = await callTool(module, 'create_pin', { ...args, title: 't'.repeat(101) }, ctx);
  assert.match(long.payload.error, /`title` must be at most 100 characters/);
  const http = await callTool(module, 'create_pin', { ...args, image_url: 'http://cdn.example.com/a.png' }, ctx);
  assert.match(http.payload.error, /`image_url` does not have the expected format/);
  assert.equal(fetch.calls.length, 1);
});

test('a Trial app\'s refusal says how to get Standard access; a revoked token says so', async () => {
  const trial = setup({ 'POST /v5/pins': () => jsonResponse(403, fixture(import.meta.url, 'error-trial.json')) });
  const refused = await callTool(trial.module, 'create_pin', { board_id: '1', image_url: 'https://cdn.example.com/a.png' }, trial.ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.outcome, undefined);
  assert.match(refused.payload.error, /Pinterest refused the request \(HTTP 403\): .*Trial access.*Nothing was changed\. The Pinterest app has Trial access, which reads the account but cannot create Pins or boards on it: upgrade the app to Standard access/);

  const personal = setup({ 'GET /v5/boards': () => jsonResponse(403, { code: 403, message: 'PINNER_DATA_ACCESS_DENIED: this app may read business accounts only.' }) });
  const denied = await callTool(personal.module, 'list_boards', {}, personal.ctx);
  assert.match(denied.payload.error, /convert the Pinterest account to a free business account/);

  const revoked = setup({ 'GET /v5/user_account': () => jsonResponse(401, fixture(import.meta.url, 'error-auth.json')) });
  const auth = await callTool(revoked.module, 'get_account', {}, revoked.ctx);
  assert.match(auth.payload.error, /Pinterest rejected the credentials \(HTTP 401\): Authentication failed\. Check that the Pinterest access token is correct and still active\./);

  const limited = setup({ 'GET /v5/pins': () => textResponse(429, 'Too many requests', { 'retry-after': '60' }) });
  const rate = await callTool(limited.module, 'list_pins', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 60);
});

test('an unclear Pin creation is unknown and sent once; a Pin delete likewise', async () => {
  for (const respond of [() => jsonResponse(500, { code: 1, message: 'Internal error' }), () => { throw new TypeError('fetch failed'); }]) {
    const { module, fetch, ctx } = setup({ 'POST /v5/pins': respond });
    const { payload } = await callTool(module, 'create_pin', { board_id: '1', image_url: 'https://cdn.example.com/a.png' }, ctx);
    assert.equal(payload.outcome, 'unknown');
    assert.equal(payload.check, 'list_pins');
    assert.equal(callsTo(fetch, 'POST', '/v5/pins').length, 1);
  }
  const { module, fetch, ctx } = setup({ 'DELETE /v5/pins/813744226420795884': () => jsonResponse(502, { message: 'Bad gateway' }) });
  const deleted = await callTool(module, 'delete_pin', { pin_id: '813744226420795884' }, ctx);
  assert.equal(deleted.payload.outcome, 'unknown');
  assert.equal(deleted.payload.check, 'get_pin');
  assert.equal(fetch.calls.length, 1);
});

test('create_video_pin downloads the video, uploads it to the storage with every parameter, waits, then creates the Pin', async () => {
  let reads = 0;
  const { module, fetch, ctx } = setup({
    media: () => bytesResponse(200, MP4, { 'content-type': 'application/octet-stream' }),
    'POST /v5/media': () => jsonResponse(201, fixture(import.meta.url, 'media-registered.json')),
    'UPLOAD POST /': () => new Response(null, { status: 204 }),
    'GET /v5/media/12345': () => jsonResponse(200, { media_id: '12345', media_type: 'video', status: ++reads < 2 ? 'processing' : 'succeeded' }),
  });
  const { payload, isError } = await callTool(module, 'create_video_pin', {
    board_id: '549755885175', video_url: 'https://videos.example.com/clip.mp4', cover_image_key_frame_time: 2, title: 'Clip', link: 'https://www.example.com/clip',
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.url}`), [
    'GET https://videos.example.com/clip.mp4',
    'POST https://api.pinterest.com/v5/media',
    `POST ${UPLOAD}/`,
    'GET https://api.pinterest.com/v5/media/12345',
    'GET https://api.pinterest.com/v5/media/12345',
    'POST https://api.pinterest.com/v5/pins',
  ]);
  const [download, register, upload] = fetch.calls;
  assert.equal(download.headers.authorization, undefined);
  assert.deepEqual(register.json, { media_type: 'video' });
  assert.equal(upload.headers.authorization, undefined, 'the token never goes to the storage');
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = new TextDecoder().decode(upload.body);
  for (const [name, value] of Object.entries(fixture(import.meta.url, 'media-registered.json').upload_parameters)) {
    assert.ok(form.includes(`name="${name}"\r\n\r\n${value}\r\n`), name);
  }
  assert.match(form, /name="file"; filename="video\.mp4"\r\nContent-Type: video\/mp4\r\n\r\n/);
  assert.ok(form.indexOf('name="file"') > form.indexOf('name="policy"'), 'the file goes last');
  assert.deepEqual(callsTo(fetch, 'POST', '/v5/pins')[0].json, {
    board_id: '549755885175', title: 'Clip', link: 'https://www.example.com/clip', media_source: { source_type: 'video_id', media_id: '12345', cover_image_key_frame_time: 2 },
  });
  assert.equal(payload.media_id, '12345');
  assert.equal(payload.url, 'https://www.pinterest.com/pin/813744226420795900/');
});

test('a video still processing hands back its media_id, and a later call with it creates the Pin without uploading again', async () => {
  let status = 'processing';
  const { module, context, fetch, ctx } = setup({
    media: () => bytesResponse(200, MP4),
    'POST /v5/media': () => jsonResponse(201, fixture(import.meta.url, 'media-registered.json')),
    'UPLOAD POST /': () => new Response(null, { status: 204 }),
    'GET /v5/media/12345': () => {
      advance(200_000);
      return jsonResponse(200, { media_id: '12345', status });
    },
  });
  const advance = controlClock(context);
  const first = await callTool(module, 'create_video_pin', { board_id: '1', video_url: 'https://videos.example.com/clip.mp4', cover_image_url: 'https://cdn.example.com/cover.jpg' }, ctx);
  assert.equal(first.isError, true);
  assert.equal(first.payload.outcome, undefined);
  assert.match(first.payload.error, /Pinterest is still processing the video \(media_id 12345\)\. No Pin was created yet: call create_video_pin again in a minute or two with media_id "12345"/);
  assert.equal(callsTo(fetch, 'POST', '/v5/pins').length, 0);

  status = 'succeeded';
  const second = await callTool(module, 'create_video_pin', { board_id: '1', media_id: '12345', cover_image_url: 'https://cdn.example.com/cover.jpg' }, ctx);
  assert.equal(second.isError, false, second.payload.error);
  assert.equal(callsTo(fetch, 'POST', '/v5/media').length, 1, 'uploaded once');
  assert.deepEqual(callsTo(fetch, 'POST', '/v5/pins')[0].json.media_source, { source_type: 'video_id', media_id: '12345', cover_image_url: 'https://cdn.example.com/cover.jpg' });
});

test('create_video_pin refuses a bad video, a failed processing, and missing or doubled arguments', async () => {
  const notVideo = setup({ media: () => bytesResponse(200, new TextEncoder().encode('<html></html>')) });
  const bad = await callTool(notVideo.module, 'create_video_pin', { board_id: '1', video_url: 'https://videos.example.com/x', cover_image_key_frame_time: 0 }, notVideo.ctx);
  assert.match(bad.payload.error, /did not return an MP4 or MOV video/);
  assert.equal(callsTo(notVideo.fetch, 'POST', '/v5/media').length, 0);

  const failed = setup({ 'GET /v5/media/9': () => jsonResponse(200, { media_id: '9', status: 'failed' }) });
  const result = await callTool(failed.module, 'create_video_pin', { board_id: '1', media_id: '9', cover_image_key_frame_time: 0 }, failed.ctx);
  assert.match(result.payload.error, /Pinterest could not process the video \(media_id 9\)\. No Pin was created/);

  const { module, fetch, ctx } = setup();
  const both = await callTool(module, 'create_video_pin', { board_id: '1', media_id: '9', video_url: 'https://videos.example.com/x', cover_image_key_frame_time: 0 }, ctx);
  assert.match(both.payload.error, /Give video_url for a new video, or media_id/);
  const noCover = await callTool(module, 'create_video_pin', { board_id: '1', media_id: '9' }, ctx);
  assert.match(noCover.payload.error, /A video Pin needs a cover/);
  assert.equal(fetch.calls.length, 0);

  const elsewhere = setup({
    media: () => bytesResponse(200, MP4),
    'POST /v5/media': () => jsonResponse(201, { ...fixture(import.meta.url, 'media-registered.json'), upload_url: 'https://uploads.example.net/' }),
  });
  const refused = await callTool(elsewhere.module, 'create_video_pin', { board_id: '1', video_url: 'https://videos.example.com/x.mp4', cover_image_key_frame_time: 0 }, elsewhere.ctx);
  assert.match(refused.payload.error, /an upload address this connector does not send files to/);
});

test('a cancelled call stops waiting for the video at once', async () => {
  const controller = new AbortController();
  const { module, fetch, ctx } = setup({
    'GET /v5/media/9': () => {
      controller.abort();
      return jsonResponse(200, { media_id: '9', status: 'processing' });
    },
  }, { signal: controller.signal });
  const { payload } = await callTool(module, 'create_video_pin', { board_id: '1', media_id: '9', cover_image_key_frame_time: 0 }, ctx);
  assert.match(payload.error, /cancelled while Pinterest was processing the video \(media_id 9\)\. No Pin was created\./);
  assert.equal(callsTo(fetch, 'GET', '/v5/media/9').length, 1);
});

test('create_board makes a public board; create_board_section adds a section; delete_pin deletes a Pin', async () => {
  const { module, fetch, ctx } = setup({
    'POST /v5/boards': () => jsonResponse(201, fixture(import.meta.url, 'board-created.json')),
    'POST /v5/boards/549755885199/sections': (request) => jsonResponse(201, { id: '5027629787972159999', name: request.json.name }),
    'DELETE /v5/pins/813744226420795884': () => new Response(null, { status: 204 }),
  });
  const board = await callTool(module, 'create_board', { name: 'Winter collection', description: 'Prints for the cold months' }, ctx);
  assert.deepEqual(callsTo(fetch, 'POST', '/v5/boards')[0].json, { name: 'Winter collection', description: 'Prints for the cold months', privacy: 'PUBLIC' });
  assert.equal(board.payload.id, '549755885199');
  const section = await callTool(module, 'create_board_section', { board_id: '549755885199', name: 'Scarves' }, ctx);
  assert.deepEqual(section.payload, { id: '5027629787972159999', name: 'Scarves', board_id: '549755885199' });
  const deleted = await callTool(module, 'delete_pin', { pin_id: '813744226420795884' }, ctx);
  assert.deepEqual(deleted.payload, { deleted: true, pin_id: '813744226420795884' });
});

test('get_pin_analytics reads the default range and metrics, with totals, lifetime numbers and day status', async () => {
  const { module, fetch, ctx } = setup({ 'GET /v5/pins/813744226420795884/analytics': () => jsonResponse(200, fixture(import.meta.url, 'pin-analytics.json')) });
  const { payload, isError } = await callTool(module, 'get_pin_analytics', { pin_id: '813744226420795884' }, ctx);
  assert.equal(isError, false, payload.error);
  const [read] = fetch.calls;
  assert.deepEqual(read.query, { start_date: isoDay(-30), end_date: isoDay(-1), metric_types: 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,SAVE_RATE' });
  assert.deepEqual(payload, {
    pin_id: '813744226420795884',
    range: { start_date: isoDay(-30), end_date: isoDay(-1) },
    metric_types: ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK', 'SAVE_RATE'],
    totals: { IMPRESSION: 200, SAVE: 16, PIN_CLICK: 32, OUTBOUND_CLICK: 13, SAVE_RATE: 0.08 },
    lifetime: { TOTAL_COMMENTS: 2, TOTAL_REACTIONS: 10 },
    days: { final: 2, processing: 1, without_data: 0 },
    note: 'A metric left out has no data yet: it is not zero. The newest days can still change. Dates are UTC.',
  });

  const daily = await callTool(module, 'get_pin_analytics', { pin_id: '813744226420795884', start_date: isoDay(-10), end_date: isoDay(-2), metric_types: ['IMPRESSION'], include_daily: true }, ctx);
  assert.equal(fetch.calls[1].query.metric_types, 'IMPRESSION');
  assert.deepEqual(daily.payload.daily[0], { date: '2026-11-19', status: 'READY', metrics: { IMPRESSION: 120, SAVE: 10, PIN_CLICK: 20, OUTBOUND_CLICK: 9, SAVE_RATE: 0.08 } });
  assert.deepEqual(daily.payload.daily[2], { date: '2026-11-21', status: 'PROCESSING' });
});

test('analytics ranges stay within Pinterest\'s 90 days, checked before anything is sent', async () => {
  const { module, fetch, ctx } = setup();
  const cases = [
    [{ start_date: isoDay(-120) }, /start_date can be at most 90 days back/],
    [{ start_date: isoDay(-5), end_date: isoDay(-10) }, /end_date is before start_date/],
    [{ end_date: isoDay(3) }, /end_date is in the future/],
    [{ start_date: '2026-02-30x' }, /`start_date` does not have the expected format/],
  ];
  for (const [range, message] of cases) {
    const { payload, isError } = await callTool(module, 'get_account_analytics', range, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 0);
});

test('get_account_analytics reads the account totals and counts days without data', async () => {
  const { module, fetch, ctx } = setup({ 'GET /v5/user_account/analytics': () => jsonResponse(200, fixture(import.meta.url, 'account-analytics.json')) });
  const { payload } = await callTool(module, 'get_account_analytics', { metric_types: ['IMPRESSION', 'ENGAGEMENT'] }, ctx);
  assert.equal(fetch.calls[0].query.metric_types, 'IMPRESSION,ENGAGEMENT');
  assert.deepEqual(payload.totals, { IMPRESSION: 1500, SAVE: 40, PIN_CLICK: 90, OUTBOUND_CLICK: 30, ENGAGEMENT: 160 });
  assert.deepEqual(payload.days, { final: 1, processing: 0, without_data: 1 });
  assert.equal(payload.lifetime, undefined);
});

test('api_get and api_request reach the rest of the API under /v5/, never ads, catalogs or OAuth', async () => {
  const { module, fetch, ctx } = setup({
    'GET /v5/user_account/analytics/top_pins': () => jsonResponse(200, { pins: [], date_availability: {} }),
    'PATCH /v5/pins/813744226420795884': (request) => jsonResponse(200, { id: '813744226420795884', ...request.json }),
  });
  const read = await callTool(module, 'api_get', { path: '/v5/user_account/analytics/top_pins', query: { start_date: '2026-11-01', end_date: '2026-11-20', sort_by: 'IMPRESSION' } }, ctx);
  assert.equal(read.payload.status, 200);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const patch = await callTool(module, 'api_request', { method: 'PATCH', path: '/v5/pins/813744226420795884', json: { title: 'New title' } }, ctx);
  assert.equal(patch.payload.data.title, 'New title');
  for (const path of ['/v5/ad_accounts', '/v5/catalogs/items', '/v5/oauth/token']) {
    const refused = await callTool(module, 'api_get', { path }, ctx);
    assert.match(refused.payload.error, /organic Pins and boards only/);
  }
  const put = await callTool(module, 'api_request', { method: 'PUT', path: '/v5/pins/1', json: {} }, ctx);
  assert.match(put.payload.error, /`method` must be one of "POST", "PATCH", "DELETE"/);
  assert.equal(fetch.calls.length, 2);
});

test('a long Pin list is cut under 32 KB and continues after the last Pin returned', async () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ ...fixture(import.meta.url, 'pins.json').items[0], id: String(813744226420700000 + index), description: 'd'.repeat(290) }));
  const { module, fetch, ctx } = setup({ 'GET /v5/pins': () => jsonResponse(200, { items: many, bookmark: 'next' }) });
  const first = await callTool(module, 'list_pins', { page_size: 120, include_metrics: true }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.pins.length;
  const second = await callTool(module, 'list_pins', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.bookmark, undefined, 'the same Pinterest page again');
  assert.equal(fetch.calls[1].query.pin_metrics, 'true', 'the metrics come along on the next part');
  assert.equal(second.payload.pins[0].id, many[shown].id);
});

test('a list_pins cursor pages the board and section it came from, and refuses another board', async () => {
  const { module, fetch, ctx } = setup({
    'GET /v5/boards/549755885175/pins': () => jsonResponse(200, { ...fixture(import.meta.url, 'pins.json'), bookmark: 'bookmark-board-2' }),
    'GET /v5/boards/549755885175/sections/5027629787972154693/pins': () => jsonResponse(200, { ...fixture(import.meta.url, 'pins.json'), bookmark: 'bookmark-section-2' }),
    'GET /v5/boards/549755885175/sections': () => jsonResponse(200, { ...fixture(import.meta.url, 'sections.json'), bookmark: 'bookmark-sections-2' }),
  });
  const board = await callTool(module, 'list_pins', { board_id: '549755885175', include_metrics: true }, ctx);
  const alone = await callTool(module, 'list_pins', { cursor: board.payload.nextCursor }, ctx);
  assert.equal(alone.isError, false, alone.payload.error);
  assert.deepEqual(fetch.calls[1].query, { page_size: '25', bookmark: 'bookmark-board-2', pin_metrics: 'true' });
  assert.equal(fetch.calls[1].path, '/v5/boards/549755885175/pins', 'the board\'s next page, not every Pin');
  assert.equal(alone.payload.board_id, '549755885175');

  const section = await callTool(module, 'list_pins', { board_id: '549755885175', board_section_id: '5027629787972154693' }, ctx);
  await callTool(module, 'list_pins', { board_id: '549755885175', cursor: section.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[3].path, '/v5/boards/549755885175/sections/5027629787972154693/pins');
  assert.equal(fetch.calls[3].query.bookmark, 'bookmark-section-2');

  const before = fetch.calls.length;
  const other = await callTool(module, 'list_pins', { board_id: '1111', cursor: board.payload.nextCursor }, ctx);
  assert.match(other.payload.error, /The cursor belongs to another list \(another board_id\)/);
  const sections = await callTool(module, 'list_board_sections', { board_id: '549755885175' }, ctx);
  const otherSections = await callTool(module, 'list_board_sections', { board_id: '1111', cursor: sections.payload.nextCursor }, ctx);
  assert.match(otherSections.payload.error, /The cursor belongs to another list \(another board_id\)/);
  assert.equal(fetch.calls.length, before + 1, 'only the first sections page was sent');
});

test('logs carry no token and no content', async () => {
  const { module, ctx, logs } = setup();
  await callTool(module, 'create_pin', { board_id: '1', image_url: 'https://cdn.example.com/a.png', title: 'Secret launch' }, ctx);
  const all = logs.join('\n');
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes('Secret launch'), false);
  assert.ok(logs.every((line) => /^pinterest create_pin POST \d{3} \d+ms$/.test(line)), all);
});
