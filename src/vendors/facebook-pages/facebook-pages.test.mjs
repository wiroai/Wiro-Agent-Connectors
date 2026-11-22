import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const USER_TOKEN = 'EAAUserTokenFromSignIn123';
const PROOF = 'a'.repeat(64);
const SYSTEM_TOKEN = 'EAASystemUserToken456';
const PAGE_TOKEN = 'EAAPageTokenForBakery0001';

const f = (name) => fixture(import.meta.url, name);

/** Answers by "METHOD /path"; anything else fails the test loudly. */
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

function setup(handler, { credentials = { systemusertoken: SYSTEM_TOKEN }, accounts = { pages: ['1001'] } } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, context, fetch, ctx, logs };
}

/** Waits in the module return at once, moving its clock instead. */
function fastWaits(context) {
  const advance = controlClock(context);
  context.setTimeout = (fn, ms) => {
    advance(ms);
    return setTimeout(fn, 0);
  };
}

const PAGE_ROUTES = { 'GET /v26.0/1001': f('page-token.json') };

test('list_pages lists the Pages with the sign-in token and its proof, and never returns a Page token', async () => {
  const { module, fetch, ctx } = setup(router({ 'GET /v26.0/me/accounts': f('me-accounts.json') }), {
    credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF },
    accounts: null,
  });
  const { payload, isError, text } = await callTool(module, 'list_pages', {}, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(request.query.appsecret_proof, PROOF);
  assert.equal(request.query.fields, 'id,name,category,tasks,access_token');
  assert.equal(request.query.limit, '50');
  assert.deepEqual(payload.pages[0], {
    id: '1001',
    name: 'Example Bakery',
    category: 'Bakery',
    tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'],
  });
  assert.doesNotMatch(text, /EAAPageToken/);
  assert.ok(payload.nextCursor, 'Facebook has a next page');

  await callTool(module, 'list_pages', { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.after, 'QVFIUnh5ejQ1Ng');
});

test('the pages picker: hosts call list_pages with no arguments and read id and name; with a lock only chosen Pages are listed', async () => {
  const open = setup(router({ 'GET /v26.0/me/accounts': f('me-accounts.json') }), { accounts: null });
  const [picker] = open.module.accountPickers;
  assert.deepEqual(JSON.parse(JSON.stringify(picker)), {
    key: 'pages',
    label: 'Facebook Pages',
    description: 'The Pages the agent may post to, comment on and read insights of.',
    multiple: true,
    tool: 'list_pages',
    idField: 'id',
    nameField: 'name',
    legacyField: 'pageid',
  });
  const all = await callTool(open.module, picker.tool, {}, open.ctx);
  assert.deepEqual(all.payload.pages.map((page) => [page[picker.idField], page[picker.nameField]]), [['1001', 'Example Bakery'], ['1002', 'Example Cafe']]);
  assert.equal(open.fetch.calls[0].headers.authorization, `Bearer ${SYSTEM_TOKEN}`);
  assert.equal(open.fetch.calls[0].query.appsecret_proof, undefined, 'no proof with a system user token');

  const locked = setup(router({ 'GET /v26.0/me/accounts': f('me-accounts.json') }), { accounts: { pages: ['1002'] } });
  const chosen = await callTool(locked.module, 'list_pages', {}, locked.ctx);
  assert.deepEqual(chosen.payload.pages.map((page) => page.id), ['1002']);
});

test('create_post gets the Page token once, posts with it as a form, and returns the permalink', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/feed': f('feed-create.json'),
    'GET /v26.0/1001_3003': f('permalink.json'),
  }));
  const { payload, isError } = await callTool(module, 'create_post', { message: 'Line one\nLine two', link: 'https://bakery.example.com/menu' }, ctx);
  assert.equal(isError, false);
  assert.deepEqual(payload, { post_id: '1001_3003', page_id: '1001', permalink: 'https://www.facebook.com/1001/posts/3003' });

  const [lookup, post, permalink] = fetch.calls;
  assert.equal(lookup.url, 'https://graph.facebook.com/v26.0/1001?fields=access_token');
  assert.equal(lookup.headers.authorization, `Bearer ${SYSTEM_TOKEN}`);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.authorization, `Bearer ${PAGE_TOKEN}`);
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(formOf(post), { message: 'Line one\nLine two', link: 'https://bakery.example.com/menu' });
  assert.equal(permalink.query.fields, 'permalink_url');

  // The Page token is kept: the next post needs no lookup.
  await callTool(module, 'create_post', { message: 'Again' }, ctx);
  assert.deepEqual(fetch.calls.slice(3).map((call) => `${call.method} ${call.path}`), ['POST /v26.0/1001/feed', 'GET /v26.0/1001_3003']);
});

test('with a sign-in token, the proof goes with the Page lookup only, never with the Page token', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': f('feed-create.json'), 'GET /v26.0/1001_3003': f('permalink.json') }), {
    credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF },
  });
  await callTool(module, 'create_post', { message: 'Hello' }, ctx);
  assert.equal(fetch.calls[0].query.appsecret_proof, PROOF);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(fetch.calls[1].query.appsecret_proof, undefined);
  assert.equal(fetch.calls[2].query.appsecret_proof, undefined);
});

test('the account lock: a Page outside the chosen ones is refused before any request, and page_id defaults to the only chosen Page', async () => {
  const refused = setup(router({}));
  const outside = await callTool(refused.module, 'create_post', { page_id: '1002', message: 'x' }, refused.ctx);
  assert.equal(outside.isError, true);
  assert.match(outside.payload.error, /The Page 1002 is not among the Pages chosen for this connection\. Use one of: 1001\. Nothing was sent\./);

  const none = setup(router({}), { accounts: {} });
  const empty = await callTool(none.module, 'create_post', { message: 'x' }, none.ctx);
  assert.match(empty.payload.error, /No Page is chosen for this connection yet/);

  const two = setup(router({}), { accounts: { pages: ['1001', '1002'] } });
  const ambiguous = await callTool(two.module, 'create_post', { message: 'x' }, two.ctx);
  assert.match(ambiguous.payload.error, /page_id is required: one of 1001, 1002\. Nothing was sent\./);
  assert.equal(refused.fetch.calls.length + none.fetch.calls.length + two.fetch.calls.length, 0);

  const missing = setup(router({}), { credentials: {} });
  const notConnected = await callTool(missing.module, 'list_pages', {}, missing.ctx);
  assert.match(notConnected.payload.error, /Facebook is not connected: it needs the Facebook access token, the Facebook system user token, or the Facebook Page token list from an older setup\./);
});

const LEGACY_BAKERY = 'EAALegacyPageTokenBakery01';
const LEGACY_CAFE = 'EAALegacyPageTokenCafe0002';
const LEGACY_EXPIRED = 'EAALegacyPageTokenExpired3';

/** /me answers for each token of an older setup: the Page it belongs to, or an expired token. */
function legacyMe(request) {
  const token = request.headers.authorization;
  if (token === `Bearer ${LEGACY_BAKERY}`) return jsonResponse(200, f('me-page-1001.json'));
  if (token === `Bearer ${LEGACY_CAFE}`) return jsonResponse(200, f('me-page-1002.json'));
  return jsonResponse(400, f('error-expired.json'));
}

test('an older setup\'s Page tokens: list_pages finds each token\'s Page once and never returns a token', async () => {
  const { module, fetch, ctx } = setup(router({ 'GET /v26.0/me': legacyMe }), {
    credentials: { accesstoken: JSON.stringify([LEGACY_BAKERY, LEGACY_CAFE]) },
    accounts: null,
  });
  const { payload, isError, text } = await callTool(module, 'list_pages', {}, ctx);
  assert.equal(isError, false);
  assert.deepEqual(payload, { pages: [{ id: '1001', name: 'Example Bakery', category: 'Bakery' }, { id: '1002', name: 'Example Cafe', category: 'Cafe' }] });
  assert.deepEqual(fetch.calls.map((call) => [call.path, call.query.fields, call.headers.authorization]), [
    ['/v26.0/me', 'id,name,category', `Bearer ${LEGACY_BAKERY}`],
    ['/v26.0/me', 'id,name,category', `Bearer ${LEGACY_CAFE}`],
  ]);
  assert.doesNotMatch(text, /EAALegacy/);

  // Each token's Page is kept: the picker's next read and a post need no lookup.
  const picker = module.accountPickers[0];
  const again = await callTool(module, picker.tool, {}, ctx);
  assert.deepEqual(again.payload.pages.map((page) => [page[picker.idField], page[picker.nameField]]), [['1001', 'Example Bakery'], ['1002', 'Example Cafe']]);
  assert.equal(fetch.calls.length, 2);

  const locked = setup(router({ 'GET /v26.0/me': legacyMe }), { credentials: { accesstoken: JSON.stringify([LEGACY_BAKERY, LEGACY_CAFE]) }, accounts: { pages: ['1002'] } });
  const chosen = await callTool(locked.module, 'list_pages', {}, locked.ctx);
  assert.deepEqual(chosen.payload.pages.map((page) => page.id), ['1002']);
});

test('an older setup\'s Page tokens: a post goes out with the chosen Page\'s own token, and a refused token says to sign in again', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET /v26.0/me': legacyMe,
    'POST /v26.0/1002/feed': { id: '1002_3003' },
    'GET /v26.0/1002_3003': { permalink_url: 'https://www.facebook.com/1002/posts/3003' },
  }), { credentials: { accesstoken: JSON.stringify([LEGACY_EXPIRED, LEGACY_BAKERY, LEGACY_CAFE]) }, accounts: { pages: ['1001', '1002'] } });
  const { payload, isError } = await callTool(module, 'create_post', { page_id: '1002', message: 'Hello from the cafe' }, ctx);
  assert.equal(isError, false);
  assert.equal(payload.post_id, '1002_3003');
  const post = fetch.calls.find((call) => call.method === 'POST');
  assert.equal(post.headers.authorization, `Bearer ${LEGACY_CAFE}`);
  assert.equal(post.query.appsecret_proof, undefined);
  assert.equal(fetch.calls.some((call) => call.path === '/v26.0/me/accounts' || call.path === '/v26.0/1002'), false, 'no user token lookup');

  // A list with a refused token still lists the others, and says so.
  const listed = await callTool(module, 'list_pages', {}, ctx);
  assert.deepEqual(listed.payload.pages.map((page) => page.id), ['1001', '1002']);
  assert.match(listed.payload.note, /Facebook refused 1 of the Page tokens this connection kept from an older setup: sign in to Facebook again/);

  // A Page whose token Facebook refused cannot be reached, and nothing is posted.
  const expired = setup(router({ 'GET /v26.0/me': legacyMe }), { credentials: { accesstoken: JSON.stringify([LEGACY_EXPIRED]) }, accounts: { pages: ['1003'] } });
  const refused = await callTool(expired.module, 'create_post', { message: 'x' }, expired.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /Session has expired.*sign in to Facebook again to renew it\./);
  assert.equal(expired.fetch.calls.some((call) => call.method === 'POST'), false);

  const other = setup(router({ 'GET /v26.0/me': legacyMe }), { credentials: { accesstoken: JSON.stringify([LEGACY_BAKERY]) }, accounts: { pages: ['1002'] } });
  const missing = await callTool(other.module, 'create_post', { message: 'x' }, other.ctx);
  assert.match(missing.payload.error, /This connection has no token for the Page 1002: its older setup kept tokens for other Pages\. Sign in to Facebook again to add it\./);

  const broken = setup(router({}), { credentials: { accesstoken: '[not json' } });
  const unreadable = await callTool(broken.module, 'list_pages', {}, broken.ctx);
  assert.match(unreadable.payload.error, /the Page token list from an older setup could not be read/);
  assert.equal(broken.fetch.calls.length, 0);
});

test('a sign-in or system user token comes first: an older setup\'s Page tokens are then not used', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': f('feed-create.json'), 'GET /v26.0/1001_3003': f('permalink.json') }), {
    credentials: { systemusertoken: SYSTEM_TOKEN, accesstoken: JSON.stringify([LEGACY_BAKERY]) },
  });
  await callTool(module, 'create_post', { message: 'Hello' }, ctx);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${SYSTEM_TOKEN}`);
  assert.equal(fetch.calls[1].headers.authorization, `Bearer ${PAGE_TOKEN}`);
});

test('a system user token comes first: a sign-in token passed next to it, and its proof, are never sent', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET /v26.0/me/accounts': f('me-accounts.json'),
    'POST /v26.0/1001/feed': f('feed-create.json'),
    'GET /v26.0/1001_3003': f('permalink.json'),
  }), { credentials: { systemusertoken: SYSTEM_TOKEN, access_token: USER_TOKEN, appsecret_proof: PROOF } });
  const listed = await callTool(module, 'list_pages', {}, ctx);
  assert.deepEqual(listed.payload.pages.map((page) => page.id), ['1001']);
  const posted = await callTool(module, 'create_post', { message: 'Hello' }, ctx);
  assert.equal(posted.payload.post_id, '1001_3003');
  // The Page token came with the system user's Page list, so the post needs no lookup.
  assert.deepEqual(fetch.calls.map((call) => [call.method, call.path, call.headers.authorization]), [
    ['GET', '/v26.0/me/accounts', `Bearer ${SYSTEM_TOKEN}`],
    ['POST', '/v26.0/1001/feed', `Bearer ${PAGE_TOKEN}`],
    ['GET', '/v26.0/1001_3003', `Bearer ${PAGE_TOKEN}`],
  ]);
  assert.equal(fetch.calls.some((call) => 'appsecret_proof' in call.query), false);
});

test('two Pages\' tokens kept from an older setup, both Pages chosen: a post names its Page and goes out with that Page\'s own token', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET /v26.0/me': legacyMe,
    'POST /v26.0/1001/feed': { id: '1001_3003' },
    'POST /v26.0/1002/feed': { id: '1002_3004' },
    'GET /v26.0/1001_3003': { permalink_url: 'https://www.facebook.com/1001/posts/3003' },
    'GET /v26.0/1002_3004': { permalink_url: 'https://www.facebook.com/1002/posts/3004' },
  }), { credentials: { accesstoken: JSON.stringify([LEGACY_BAKERY, LEGACY_CAFE]) }, accounts: { pages: ['1001', '1002'] } });
  const unnamed = await callTool(module, 'create_post', { message: 'Hello' }, ctx);
  assert.match(unnamed.payload.error, /page_id is required: one of 1001, 1002\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 0);

  const bakery = await callTool(module, 'create_post', { page_id: '1001', message: 'Hello from the bakery' }, ctx);
  const cafe = await callTool(module, 'create_post', { page_id: '1002', message: 'Hello from the cafe' }, ctx);
  assert.deepEqual([bakery.payload.post_id, cafe.payload.post_id], ['1001_3003', '1002_3004']);
  assert.deepEqual(fetch.calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.headers.authorization]), [
    ['/v26.0/1001/feed', `Bearer ${LEGACY_BAKERY}`],
    ['/v26.0/1002/feed', `Bearer ${LEGACY_CAFE}`],
  ]);
  // Each token's Page is read once; no sign-in or system user lookup is made.
  assert.equal(fetch.calls.filter((call) => call.path === '/v26.0/me').length, 2);
  assert.equal(fetch.calls.some((call) => call.path === '/v26.0/me/accounts' || 'appsecret_proof' in call.query), false);
});

test('a scheduled post is sent unpublished with its time and gets no permalink; a time too soon is refused', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': f('feed-create.json') }));
  const when = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  when.setUTCMilliseconds(0);
  const { payload } = await callTool(module, 'create_post', { message: 'Later', scheduled_time: when.toISOString() }, ctx);
  assert.deepEqual(formOf(fetch.calls[1]), { message: 'Later', published: 'false', scheduled_publish_time: String(when.getTime() / 1000) });
  assert.equal(payload.scheduled_time, when.toISOString());
  assert.equal(payload.permalink, undefined);
  assert.equal(fetch.calls.length, 2);

  const soon = await callTool(module, 'create_post', { message: 'Soon', scheduled_time: new Date(Date.now() + 60_000).toISOString() }, ctx);
  assert.match(soon.payload.error, /at least 10 minutes from now/);
  assert.equal(fetch.calls.length, 2);
});

test('post_photos posts one photo directly, and several as unpublished uploads attached to one post', async () => {
  const single = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/photos': f('photo-create.json'), 'GET /v26.0/1001_3004': { permalink_url: 'https://www.facebook.com/1001/posts/3004' } }));
  const one = await callTool(single.module, 'post_photos', { image_urls: ['https://cdn.example.com/a.jpg'], caption: 'Our bread' }, single.ctx);
  assert.deepEqual(formOf(single.fetch.calls[1]), { url: 'https://cdn.example.com/a.jpg', caption: 'Our bread' });
  assert.deepEqual(one.payload, { post_id: '1001_3004', photo_id: '2001', page_id: '1001', permalink: 'https://www.facebook.com/1001/posts/3004' });

  let photo = 0;
  const multi = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/photos': () => jsonResponse(200, { id: `20${++photo}` }),
    'POST /v26.0/1001/feed': f('feed-create.json'),
    'GET /v26.0/1001_3003': f('permalink.json'),
  }));
  const many = await callTool(multi.module, 'post_photos', { image_urls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.png'], caption: 'Two' }, multi.ctx);
  assert.deepEqual(formOf(multi.fetch.calls[1]), { url: 'https://cdn.example.com/a.jpg', published: 'false' });
  assert.deepEqual(formOf(multi.fetch.calls[3]), {
    message: 'Two',
    'attached_media[0]': '{"media_fbid":"201"}',
    'attached_media[1]': '{"media_fbid":"202"}',
  });
  assert.deepEqual(many.payload.photo_ids, ['201', '202']);
  assert.equal(many.payload.permalink, 'https://www.facebook.com/1001/posts/3003');
});

test('post_photos stops at a failed upload and says nothing was posted', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/photos': () => jsonResponse(400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } }),
  }));
  const { payload, isError } = await callTool(module, 'post_photos', { image_urls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'] }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /^Image 1 of 2 could not be uploaded: Facebook rejected the request \(HTTP 400\): Invalid parameter\..* Nothing was posted\.$/);
  assert.equal(fetch.calls.filter((call) => call.path === '/v26.0/1001/feed').length, 0);
});

test('post_video sends the file URL and returns the video link', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/videos': f('video-create.json'), 'GET /v26.0/4001': f('video-details.json') }));
  const { payload } = await callTool(module, 'post_video', { video_url: 'https://cdn.example.com/clip.mp4', description: 'Behind the scenes', title: 'Baking' }, ctx);
  assert.deepEqual(formOf(fetch.calls[1]), { file_url: 'https://cdn.example.com/clip.mp4', description: 'Behind the scenes', title: 'Baking' });
  assert.deepEqual(payload, { video_id: '4001', page_id: '1001', status: 'processing', url: 'https://www.facebook.com/1001/videos/4001/' });
});

test('post_reel starts an upload, lets Facebook fetch the file, waits for it, then publishes once', async () => {
  let reads = 0;
  const { module, context, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/video_reels': (request) => jsonResponse(200, formOf(request).upload_phase === 'start' ? f('reel-start.json') : f('reel-finish.json')),
    'POST /video-upload/v26.0/5001': f('rupload.json'),
    'GET /v26.0/5001': () => jsonResponse(200, ++reads === 1 ? f('video-status-uploading.json') : f('video-status-complete.json')),
  }));
  fastWaits(context);
  const { payload, isError } = await callTool(module, 'post_reel', { video_url: 'https://cdn.example.com/reel.mp4', description: 'New loaf #bread', is_ai_generated: false }, ctx);
  assert.equal(isError, false);
  const upload = fetch.calls.find((call) => call.path === '/video-upload/v26.0/5001');
  assert.equal(upload.origin, 'https://rupload.facebook.com');
  assert.equal(upload.headers.authorization, `OAuth ${PAGE_TOKEN}`);
  assert.equal(upload.headers.file_url, 'https://cdn.example.com/reel.mp4');
  const finish = fetch.calls.filter((call) => call.path === '/v26.0/1001/video_reels')[1];
  assert.deepEqual(formOf(finish), { upload_phase: 'finish', video_id: '5001', video_state: 'PUBLISHED', description: 'New loaf #bread', is_ai_generated: 'false' });
  assert.equal(reads, 2);
  assert.equal(payload.video_id, '5001');
  assert.equal(payload.post_id, '1001_3005');
  assert.equal(payload.url, 'https://www.facebook.com/reel/5001');
});

test('post_reel reports a file Facebook could not take and never publishes', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/video_reels': f('reel-start.json'),
    'POST /video-upload/v26.0/5001': f('rupload.json'),
    'GET /v26.0/5001': f('video-status-error.json'),
  }));
  const { payload, isError } = await callTool(module, 'post_reel', { video_url: 'https://cdn.example.com/reel.avi' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /Facebook could not take the video: The video file you tried to upload is in a format we don't support\..*Nothing was published\./);
  assert.equal(fetch.calls.filter((call) => call.path === '/v26.0/1001/video_reels').length, 1, 'only the start');
});

test('post_story posts an image as an unpublished photo then a story, and a video through an upload', async () => {
  const image = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/photos': { id: '2009' }, 'POST /v26.0/1001/photo_stories': f('story-finish.json') }));
  const photo = await callTool(image.module, 'post_story', { image_url: 'https://cdn.example.com/story.jpg' }, image.ctx);
  assert.deepEqual(formOf(image.fetch.calls[1]), { url: 'https://cdn.example.com/story.jpg', published: 'false' });
  assert.deepEqual(formOf(image.fetch.calls[2]), { photo_id: '2009' });
  assert.deepEqual(photo.payload, { post_id: '3006', page_id: '1001', media: 'image' });

  const video = setup(router({
    ...PAGE_ROUTES,
    'POST /v26.0/1001/video_stories': (request) => jsonResponse(200, formOf(request).upload_phase === 'start' ? f('reel-start.json') : f('story-finish.json')),
    'POST /video-upload/v26.0/5001': f('rupload.json'),
    'GET /v26.0/5001': f('video-status-complete.json'),
  }));
  const clip = await callTool(video.module, 'post_story', { video_url: 'https://cdn.example.com/story.mp4' }, video.ctx);
  assert.deepEqual(clip.payload, { post_id: '3006', video_id: '5001', page_id: '1001', media: 'video' });

  const both = await callTool(video.module, 'post_story', { image_url: 'https://cdn.example.com/a.jpg', video_url: 'https://cdn.example.com/b.mp4' }, video.ctx);
  assert.match(both.payload.error, /Give exactly one of image_url or video_url/);
});

test('add_comment attaches an image, shares a GIF, and puts any other sample in the text', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001_3002/comments': f('comment-create.json') }));
  const image = await callTool(module, 'add_comment', { object_id: '1001_3002', message: 'Sample 1', media_url: 'https://cdn.example.com/s1.webp?x=1' }, ctx);
  assert.deepEqual(formOf(fetch.calls[1]), { message: 'Sample 1', attachment_url: 'https://cdn.example.com/s1.webp?x=1' });
  assert.deepEqual(image.payload, { comment_id: '3002_7002', object_id: '1001_3002', page_id: '1001', media: 'image' });

  await callTool(module, 'add_comment', { object_id: '1001_3002', media_url: 'https://cdn.example.com/s2.gif' }, ctx);
  assert.deepEqual(formOf(fetch.calls[2]), { attachment_share_url: 'https://cdn.example.com/s2.gif' });

  await callTool(module, 'add_comment', { object_id: '1001_3002', message: 'Listen', media_url: 'https://cdn.example.com/s3.mp3' }, ctx);
  assert.deepEqual(formOf(fetch.calls[3]), { message: 'Listen\n\nhttps://cdn.example.com/s3.mp3' });

  const empty = await callTool(module, 'add_comment', { object_id: '1001_3002' }, ctx);
  assert.match(empty.payload.error, /Give message, media_url or both/);
});

test('list_comments trims each comment and pages with the cursor', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'GET /v26.0/1001_3002/comments': f('comments.json') }));
  const { payload } = await callTool(module, 'list_comments', { object_id: '1001_3002', limit: 5 }, ctx);
  assert.equal(fetch.calls[1].query.filter, 'toplevel');
  assert.equal(fetch.calls[1].query.order, 'reverse_chronological');
  assert.equal(fetch.calls[1].headers.authorization, `Bearer ${PAGE_TOKEN}`);
  assert.deepEqual(payload.comments[0], {
    id: '3002_7001',
    message: 'Do you have gluten-free bread?',
    from: 'Sam Rivera',
    from_id: '8001',
    created_time: '2026-11-20T10:02:00+0000',
    like_count: 2,
    reply_count: 1,
    is_hidden: false,
    permalink: 'https://www.facebook.com/1001/posts/3002?comment_id=7001',
    attachment: { type: 'photo', url: 'https://www.facebook.com/photo.php?fbid=9001' },
  });
  assert.equal(payload.nextCursor, undefined, 'no next link: the last page');
});

test('get_post_insights reads the metrics in one request and marks missing ones as null', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES, 'GET /v26.0/1001/published_posts': f('post-insights.json') }));
  const { payload } = await callTool(module, 'get_post_insights', { limit: 5 }, ctx);
  assert.equal(fetch.calls[1].query.fields, 'id,created_time,permalink_url,message,insights.metric(post_media_view,post_total_media_view_unique,post_reactions_by_type_total,post_activity_by_action_type,post_clicks)');
  assert.equal(fetch.calls[1].query.limit, '5');
  assert.deepEqual(payload.posts[0].metrics, {
    post_media_view: 1520,
    post_total_media_view_unique: 980,
    post_reactions_by_type_total: { like: 41, love: 7 },
    post_activity_by_action_type: { comment: 5, share: 3 },
    post_clicks: null,
  });

  const ids = setup(router({ ...PAGE_ROUTES, 'GET /v26.0/': { '1001_3002': f('post-insights.json').data[0] } }));
  const byId = await callTool(ids.module, 'get_post_insights', { post_ids: ['1001_3002'], metrics: ['post_media_view'] }, ids.ctx);
  assert.equal(ids.fetch.calls[1].query.ids, '1001_3002');
  assert.deepEqual(byId.payload.posts[0].metrics, { post_media_view: 1520 });

  const other = await callTool(ids.module, 'get_post_insights', { post_ids: ['1002_1'] }, ids.ctx);
  assert.match(other.payload.error, /1002_1 is not a post of the Page 1001\. Nothing was sent\./);
});

test('get_page_insights adds up the days, reports the follower change, and defaults to the 28 days ending yesterday', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'GET /v26.0/1001/insights': (request) => jsonResponse(200, request.query.period === 'days_28' ? f('page-insights-unique.json') : f('page-insights-day.json')),
  }));
  const { payload } = await callTool(module, 'get_page_insights', {}, ctx);
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  assert.equal(fetch.calls[1].query.metric, 'page_media_view,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique,page_follows');
  assert.equal(fetch.calls[1].query.since, day(-28));
  assert.equal(fetch.calls[1].query.until, day(0));
  assert.equal(payload.since, day(-28));
  assert.equal(payload.until, day(-1));
  assert.deepEqual(payload.totals, {
    views: 1000,
    engagements: 75,
    new_follows: 10,
    unfollows: 1,
    followers_first_day: 1200,
    followers_last_day: 1209,
    followers_change: 9,
    unique_viewers_28_days: 3100,
  });

  const long = await callTool(module, 'get_page_insights', { since: '2026-01-01', until: '2026-06-30' }, ctx);
  assert.match(long.payload.error, /one call covers at most 90/);
});

test('Facebook errors keep their own words, its throttling reads as a rate limit, and an unclear post names its check tool after one write', async () => {
  const expired = setup(router({ 'GET /v26.0/me/accounts': () => jsonResponse(400, f('error-expired.json')) }));
  const old = await callTool(expired.module, 'list_pages', {}, expired.ctx);
  assert.match(old.payload.error, /Facebook rejected the request \(HTTP 400\): Error validating access token: Session has expired/);

  // Facebook throttles with HTTP 400 and a rate limit code, and says how long in a usage header.
  const usage = { 'x-business-use-case-usage': JSON.stringify({ 1001: [{ type: 'pages', call_count: 100, total_cputime: 12, total_time: 15, estimated_time_to_regain_access: 12 }] }) };
  const throttled = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': () => jsonResponse(400, f('error-rate-limit.json'), usage) }));
  const limit = await callTool(throttled.module, 'create_post', { message: 'Hello' }, throttled.ctx);
  assert.equal(limit.isError, true);
  assert.equal(limit.payload.status, 400);
  assert.match(limit.payload.error, /^Facebook rate limit reached \(HTTP 400\): \(#80001\) There have been too many calls to this Page account\..* Nothing was changed\. Wait a while before trying again/);
  assert.equal(throttled.fetch.calls.filter((call) => call.method === 'POST').length, 1, 'never retried');
  const pageLimit = setup(router({ 'GET /v26.0/me/accounts': () => jsonResponse(400, { error: { message: '(#32) Page request limit reached', type: 'OAuthException', code: 32 } }) }));
  const read = await callTool(pageLimit.module, 'list_pages', {}, pageLimit.ctx);
  assert.match(read.payload.error, /^Facebook rate limit reached \(HTTP 400\): \(#32\) Page request limit reached\. Wait a while/);
  const lookup = setup(router({ 'GET /v26.0/1001': () => jsonResponse(403, { error: { message: '(#4) Application request limit reached', code: 4 } }) }));
  const custom = await callTool(lookup.module, 'list_posts', {}, lookup.ctx);
  assert.match(custom.payload.error, /^Facebook rate limit reached \(HTTP 403\): \(#4\) Application request limit reached\. Wait a while/);

  // A plain HTTP 429 keeps the core's retryAfter.
  const limited = setup(router({ 'GET /v26.0/me/accounts': () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '30' } }) }));
  const rate = await callTool(limited.module, 'list_pages', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);

  const broken = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': () => jsonResponse(500, { error: { message: 'An unexpected error has occurred.', code: 2 } }) }));
  const unknown = await callTool(broken.module, 'create_post', { message: 'Hello' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_posts');
  assert.equal(broken.fetch.calls.filter((call) => call.method === 'POST').length, 1);
});

test('list_posts reads the kind asked for and continues at the next Facebook page', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'GET /v26.0/1001/published_posts': f('published-posts.json'),
    'GET /v26.0/1001/scheduled_posts': { data: [{ id: '1001_3010', message: 'Soon', created_time: '2026-11-21T10:00:00+0000', scheduled_publish_time: 1796000000 }] },
  }));
  const first = await callTool(module, 'list_posts', { limit: 2, since: '2026-11-01' }, ctx);
  assert.equal(fetch.calls[1].query.since, '2026-11-01');
  assert.deepEqual(first.payload.posts[1], {
    id: '1001_3001',
    created_time: '2026-11-18T09:00:00+0000',
    message: 'We are open on Sunday.',
    permalink: 'https://www.facebook.com/1001/posts/3001',
    status_type: 'mobile_status_update',
  });
  await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[2].query.after, 'QVFIUmFmdGVy');
  assert.equal(fetch.calls[2].query.limit, '2');

  const scheduled = await callTool(module, 'list_posts', { kind: 'scheduled' }, ctx);
  assert.equal(scheduled.payload.posts[0].scheduled_publish_time, new Date(1796000000 * 1000).toISOString());
});

test('a long page of posts is cut under 32 KB and continues after the last one shown', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `1001_${5000 + index}`, message: 'm'.repeat(290), created_time: '2026-11-01T00:00:00+0000', permalink_url: `https://www.facebook.com/1001/posts/${5000 + index}` }));
  const { module, ctx } = setup(router({ ...PAGE_ROUTES, 'GET /v26.0/1001/published_posts': { data: many } }));
  const first = await callTool(module, 'list_posts', { limit: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.posts.length;
  const second = await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.posts[0].id, `1001_${5000 + shown}`);
});

test('api_get and api_request act as the chosen Page, keep to /v26.0/, and never reach tokens', async () => {
  const { module, fetch, ctx } = setup(router({
    ...PAGE_ROUTES,
    'GET /v26.0/1001_3002/reactions': { data: [{ id: '8001', type: 'LIKE' }] },
    'POST /v26.0/3002_7001': { success: true },
  }));
  const read = await callTool(module, 'api_get', { path: '/v26.0/1001_3002/reactions', query: { summary: 'total_count' } }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { data: [{ id: '8001', type: 'LIKE' }] } });
  assert.equal(fetch.calls[1].headers.authorization, `Bearer ${PAGE_TOKEN}`);

  const hide = await callTool(module, 'api_request', { method: 'POST', path: '/v26.0/3002_7001', json: { is_hidden: true } }, ctx);
  assert.equal(hide.payload.status, 200);
  assert.deepEqual(fetch.calls[2].json, { is_hidden: true });

  const token = await callTool(module, 'api_get', { path: '/v26.0/1001', query: { fields: 'name,access_token' } }, ctx);
  assert.match(token.payload.error, /Tokens and app secrets are not available/);
  const outside = await callTool(module, 'api_get', { path: '/v25.0/1001' }, ctx);
  assert.match(outside.payload.error, /The path must start with \/v26\.0\//);
  const other = await callTool(module, 'api_get', { page_id: '1002', path: '/v26.0/1002' }, ctx);
  assert.match(other.payload.error, /The Page 1002 is not among the Pages chosen/);
  assert.equal(fetch.calls.length, 3);

  const broken = setup(router({ ...PAGE_ROUTES, 'DELETE /v26.0/1001_3002': () => jsonResponse(502, { error: { message: 'Bad gateway' } }) }));
  const unknown = await callTool(broken.module, 'api_request', { method: 'DELETE', path: '/v26.0/1001_3002' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
});

test('the generic tools refuse a batch, a method override and a token asked for in a body, before even the Page token is fetched', async () => {
  const { module, fetch, ctx } = setup(router({ ...PAGE_ROUTES }));
  const batch = '[{"method":"GET","relative_url":"v26.0/1001?fields=access_token"}]';
  const attempts = [
    // A batch in a form body, in the query (with an encoded field name) and in a JSON body.
    { method: 'POST', path: '/v26.0/1001', content_type: 'application/x-www-form-urlencoded', body: `batch=${encodeURIComponent(batch)}` },
    { method: 'POST', path: '/v26.0/1001', query: { batch: '[{"method":"GET","relative_url":"v26.0/1001?fields=access%5Ftoken"}]' } },
    { method: 'POST', path: '/v26.0/1001', json: { batch: [{ method: 'GET', relative_url: 'v26.0/1001' }] } },
    // Graph's method override, which would turn a read into a change or the other way round.
    { method: 'POST', path: '/v26.0/1001_3002', query: { method: 'delete' } },
    // A token asked for after a write, in JSON, encoded, or in a JSON body sent as text.
    { method: 'POST', path: '/v26.0/1001', json: { about: 'Fresh bread', fields: 'access_token' } },
    { method: 'POST', path: '/v26.0/1001', content_type: 'application/x-www-form-urlencoded', body: 'about=Fresh&fields=access%255Ftoken' },
    { method: 'POST', path: '/v26.0/1001', content_type: 'application/json', body: '{"fields":"access_token"}' },
  ];
  for (const args of attempts) {
    const { payload, isError } = await callTool(module, 'api_request', args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, /(not available through the generic Facebook tools).* Nothing was sent\.$/, JSON.stringify(args));
  }
  const read = await callTool(module, 'api_get', { path: '/v26.0/1001', query: { method: 'post', about: 'x' } }, ctx);
  assert.match(read.payload.error, /The method parameter is not available/);
  const multipart = await callTool(module, 'api_request', { method: 'POST', path: '/v26.0/1001/photos', content_type: 'multipart/form-data; boundary=x', body: '--x--' }, ctx);
  assert.match(multipart.payload.error, /send parameters as a JSON object \(json\) or as a form/);
  assert.equal(fetch.calls.length, 0, 'nothing was sent, not even the Page token lookup');
});

test('a generic reply never carries a token or an app secret proof back', async () => {
  const leaky = {
    id: '1001',
    access_token: 'EAAPageTokenForBakery0001',
    pages: [{ id: '1001', ACCESS_TOKEN: 'EAAOther' }],
    batch: [{ code: 200, body: '{"access_token":"EAAPageTokenForBakery0001","id":"1001"}' }],
    paging: { next: 'https://graph.facebook.com/v26.0/1001/feed?access_token=EAAPageTokenForBakery0001&appsecret_proof=abc&after=QVFI' },
  };
  const { module, ctx } = setup(router({ ...PAGE_ROUTES, 'GET /v26.0/1001/feed': leaky }));
  const { payload, text } = await callTool(module, 'api_get', { path: '/v26.0/1001/feed' }, ctx);
  assert.doesNotMatch(text, /EAAPageToken|EAAOther|appsecret_proof=abc/);
  assert.deepEqual(payload.data.pages, [{ id: '1001' }]);
  assert.equal(payload.data.batch[0].body, '{"access_token":"hidden","id":"1001"}');
  assert.equal(payload.data.paging.next, 'https://graph.facebook.com/v26.0/1001/feed?access_token=hidden&appsecret_proof=hidden&after=QVFI');
});

test('log lines carry no tokens, proofs or arguments', async () => {
  const { module, ctx, logs } = setup(router({ ...PAGE_ROUTES, 'POST /v26.0/1001/feed': f('feed-create.json'), 'GET /v26.0/1001_3003': f('permalink.json') }), {
    credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF },
  });
  await callTool(module, 'create_post', { message: 'Secret launch details' }, ctx);
  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.match(line, /^facebook-pages create_post (GET|POST) \d{3} \d+ms$/);
    for (const secret of [USER_TOKEN, PROOF, PAGE_TOKEN, 'Secret launch']) assert.equal(line.includes(secret), false);
  }
});
