import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'tumblr-access-token-AbCdEfGhIjKlMnOpQrStUvWxYz';
const credentials = { access_token: TOKEN };
const ACME = 't:0aY0xL2Fi1OFJg4YxpmegQ';
const TEAM = 't:Hq3sdGeR5FWtBc9Kmv2rXw';
const plain = (value) => JSON.parse(JSON.stringify(value));

// A 2 x 3 PNG: the signature and an IHDR chunk are all the module reads.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** A fake Tumblr: routes by method and path; `overrides` replaces any route. */
function routes(overrides = {}) {
  const table = {
    'GET /v2/user/info': () => jsonResponse(200, fixture(import.meta.url, 'user-info.json')),
    [`GET /v2/blog/${ACME}/posts`]: () => jsonResponse(200, fixture(import.meta.url, 'posts.json')),
    [`POST /v2/blog/${ACME}/posts`]: () => jsonResponse(201, fixture(import.meta.url, 'created.json')),
    ...overrides,
  };
  return (request) => {
    if (request.origin !== 'https://api.tumblr.com') {
      const media = table.media;
      if (!media) throw new Error(`unexpected media request ${request.url}`);
      return media(request);
    }
    const route = table[`${request.method} ${decodeURIComponent(request.path)}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return route(request);
  };
}

function setup(overrides, accounts = { blogs: [ACME] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(routes(overrides));
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const callsTo = (fetch, method, path) => fetch.calls.filter((call) => call.method === method && decodeURIComponent(call.path) === path);

test('the blogs picker lists every blog the account can post to, by the id the old setup kept', async () => {
  const { module, fetch, ctx } = setup(undefined, null);
  const [picker] = module.accountPickers;
  assert.deepEqual(plain(picker), {
    key: 'blogs', label: 'Tumblr blogs', description: 'The blogs the agent may post to and read, group blogs included.', multiple: true, tool: 'list_blogs', idField: 'id', nameField: 'name', legacyField: 'blogid',
  });
  assert.deepEqual(plain(module.credentials), ['access_token']);
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.tumblr.com/v2/user/info');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.blogs.map((blog) => [blog[picker.idField], blog[picker.nameField]]), [[ACME, 'acme'], [TEAM, 'acme-team'], ['oldblog', 'oldblog']]);
  assert.deepEqual(payload.blogs[0], { id: ACME, name: 'acme', title: 'Acme Prints', url: 'https://acme.tumblr.com/', primary: true, type: 'public', followers: 1200 });
});

test('list_posts reads the chosen blog\'s published posts by bearer token alone, with note counts and an offset cursor', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'list_posts', { limit: 2 }, ctx);
  assert.equal(isError, false, payload.error);
  const [read] = fetch.calls;
  assert.equal(read.url, `https://api.tumblr.com/v2/blog/${ACME}/posts?npf=true&limit=2`, 'the only chosen blog is used, its colon kept');
  assert.equal(read.query.api_key, undefined, 'no app key is sent');
  assert.equal(payload.total_posts, 45);
  assert.deepEqual(payload.posts[0], {
    id: '1234567891234567',
    state: 'published',
    date: '2026-11-20 09:00:00 GMT',
    post_url: 'https://www.tumblr.com/acme/1234567891234567/new-print-series',
    note_count: 42,
    tags: ['prints', 'illustration'],
    summary: 'New print series is out.',
    type: 'blocks',
  });
  assert.equal(payload.posts[1].summary, 'Studio day.', 'a post without a summary is summed up from its text');
  await callTool(module, 'list_posts', { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, `https://api.tumblr.com/v2/blog/${ACME}/posts?npf=true&limit=2&offset=2`);
});

test('drafts page with before_id and the queue shows each post\'s time', async () => {
  const { module, fetch, ctx } = setup({
    [`GET /v2/blog/${ACME}/posts/draft`]: () => jsonResponse(200, fixture(import.meta.url, 'drafts.json')),
    [`GET /v2/blog/${ACME}/posts/queue`]: () => jsonResponse(200, fixture(import.meta.url, 'queue.json')),
  });
  const drafts = await callTool(module, 'list_posts', { state: 'draft' }, ctx);
  assert.equal(drafts.payload.posts[0].state, 'draft');
  await callTool(module, 'list_posts', { cursor: drafts.payload.nextCursor }, ctx);
  assert.deepEqual(callsTo(fetch, 'GET', `/v2/blog/${ACME}/posts/draft`).map((call) => call.query), [{ npf: 'true' }, { npf: 'true', before_id: '1234567891234999' }]);
  const queue = await callTool(module, 'list_posts', { state: 'queue' }, ctx);
  assert.equal(queue.payload.posts[0].scheduled_for, '2026-12-01T10:00:00.000Z');
  assert.equal(queue.payload.posts[0].state, 'queued');
  const tagged = await callTool(module, 'list_posts', { state: 'draft', tag: 'x' }, ctx);
  assert.match(tagged.payload.error, /tag works with published posts only/);
});

test('the blog lock: a blog outside the chosen ones is refused before sending, and a chosen blog\'s name is found by its id', async () => {
  const { module, fetch, ctx } = setup();
  const outside = await callTool(module, 'list_posts', { blog_id: TEAM }, ctx);
  assert.match(outside.payload.error, new RegExp(`The blog ${TEAM} is not among the blogs chosen for this connection\\. Use one of: ${ACME}\\. Nothing was sent\\.`));
  assert.equal(fetch.calls.length, 0);

  const byName = await callTool(module, 'list_posts', { blog_id: 'acme' }, ctx);
  assert.equal(byName.isError, false, byName.payload.error);
  assert.deepEqual(fetch.calls.map((call) => decodeURIComponent(call.path)), ['/v2/user/info', `/v2/blog/${ACME}/posts`]);

  const team = await callTool(module, 'list_posts', { blog_id: 'acme-team.tumblr.com' }, ctx);
  assert.match(team.payload.error, /The blog acme-team\.tumblr\.com is not among the blogs chosen/);

  const several = setup(undefined, { blogs: [ACME, TEAM] });
  const missing = await callTool(several.module, 'list_posts', {}, several.ctx);
  assert.match(missing.payload.error, new RegExp(`blog_id is required: this connection has several blogs \\(${ACME}, ${TEAM}\\)`));
  const none = setup(undefined, null);
  const unlocked = await callTool(none.module, 'list_posts', {}, none.ctx);
  assert.match(unlocked.payload.error, /blog_id is required: list_blogs shows the blogs/);
});

test('create_post saves a draft by default, from text paragraphs, images with alt text, a link and tags', async () => {
  const { module, fetch, ctx } = setup();
  const { payload, isError } = await callTool(module, 'create_post', {
    text: 'New print series is out.\n\nThree prints, signed.',
    images: [{ url: 'https://cdn.example.com/prints/cover.jpg', alt_text: 'Three framed prints on a white wall' }],
    link_url: 'https://example.com/prints',
    tags: ['prints', 'illustration'],
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1, 'Tumblr fetches the image by URL');
  const [sent] = fetch.calls;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(sent.json, {
    content: [
      { type: 'text', text: 'New print series is out.' },
      { type: 'text', text: 'Three prints, signed.' },
      { type: 'image', media: [{ url: 'https://cdn.example.com/prints/cover.jpg', type: 'image/jpeg' }], alt_text: 'Three framed prints on a white wall' },
      { type: 'link', url: 'https://example.com/prints' },
    ],
    state: 'draft',
    tags: 'prints,illustration',
  });
  assert.deepEqual(payload, { id: '1234567891234567', blog: ACME, state: 'draft' });
});

test('a published post reads back its link; a draft on a blog named by name gets the drafts page', async () => {
  const { module, fetch, ctx } = setup();
  const published = await callTool(module, 'create_post', { text: 'Live now', state: 'published' }, ctx);
  assert.equal(published.payload.post_url, 'https://www.tumblr.com/acme/1234567891234567/new-print-series');
  assert.equal(callsTo(fetch, 'GET', `/v2/blog/${ACME}/posts`)[0].query.id, '1234567891234567');

  const named = setup({ 'POST /v2/blog/oldblog/posts': () => jsonResponse(201, fixture(import.meta.url, 'created.json')) }, null);
  const draft = await callTool(named.module, 'create_post', { blog_id: 'oldblog', text: 'Draft' }, named.ctx);
  assert.equal(draft.payload.manage_url, 'https://www.tumblr.com/blog/oldblog/drafts');

  const unreadable = setup({ [`GET /v2/blog/${ACME}/posts`]: () => jsonResponse(503, { meta: { status: 503 } }) });
  const created = await callTool(unreadable.module, 'create_post', { text: 'Live now', state: 'published' }, unreadable.ctx);
  assert.equal(created.isError, false, 'the post exists even when its link cannot be read');
  assert.match(created.payload.note, /could not be read/);
});

test('queue with publish_on schedules the post; publish_on needs the queue and a future time', async () => {
  const { module, fetch, ctx } = setup();
  const at = new Date(Date.now() + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { payload } = await callTool(module, 'create_post', { text: 'Friday drop', state: 'queue', publish_on: at }, ctx);
  assert.equal(fetch.calls[0].json.state, 'queue');
  assert.equal(fetch.calls[0].json.publish_on, at);
  assert.equal(payload.publish_on, at);
  const notQueued = await callTool(module, 'create_post', { text: 'x', publish_on: at }, ctx);
  assert.match(notQueued.payload.error, /publish_on goes with state queue/);
  const past = await callTool(module, 'create_post', { text: 'x', state: 'queue', publish_on: '2020-01-01T00:00:00Z' }, ctx);
  assert.match(past.payload.error, /publish_on must be in the future/);
  assert.equal(fetch.calls.length, 1);
});

test('upload_images downloads each image and sends it with the post\'s JSON in one multipart request', async () => {
  const { module, fetch, ctx } = setup({ media: () => bytesResponse(200, PNG, { 'content-type': 'application/octet-stream' }) });
  const { isError, payload } = await callTool(module, 'create_post', {
    text: 'Uploaded',
    images: [{ url: 'https://cdn.example.com/a', alt_text: 'First' }, { url: 'https://cdn.example.com/b', alt_text: 'Second', caption: 'Caption' }],
    upload_images: true,
  }, ctx);
  assert.equal(isError, false, payload.error);
  const downloads = fetch.calls.filter((call) => call.origin !== 'https://api.tumblr.com');
  assert.equal(downloads.length, 2);
  for (const download of downloads) assert.equal(download.headers.authorization, undefined);
  const [post] = callsTo(fetch, 'POST', `/v2/blog/${ACME}/posts`);
  assert.match(post.headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = new TextDecoder().decode(post.body);
  const json = JSON.parse(/name="json"\r\nContent-Type: application\/json\r\n\r\n(.*)\r\n/.exec(form)[1]);
  assert.deepEqual(json.content.slice(1), [
    { type: 'image', media: [{ type: 'image/png', identifier: 'image1', width: 2, height: 3 }], alt_text: 'First' },
    { type: 'image', media: [{ type: 'image/png', identifier: 'image2', width: 2, height: 3 }], alt_text: 'Second', caption: 'Caption' },
  ]);
  assert.match(form, /name="image1"; filename="image1\.png"\r\nContent-Type: image\/png/);
  assert.match(form, /name="image2"; filename="image2\.png"\r\nContent-Type: image\/png/);

  const bad = setup({ media: () => bytesResponse(200, new TextEncoder().encode('<html>')) });
  const refused = await callTool(bad.module, 'create_post', { images: [{ url: 'https://cdn.example.com/a', alt_text: 'A' }], upload_images: true }, bad.ctx);
  assert.match(refused.payload.error, /did not return a JPEG, PNG, GIF or WebP image/);
  assert.equal(callsTo(bad.fetch, 'POST', `/v2/blog/${ACME}/posts`).length, 0);
});

test('Neue Post Format content goes as given, after checks for alt text and Tumblr\'s limits', async () => {
  const { module, fetch, ctx } = setup();
  const content = [{ type: 'text', text: 'Heading', subtype: 'heading1' }, { type: 'text', text: 'Body', formatting: [{ start: 0, end: 4, type: 'bold' }] }];
  await callTool(module, 'create_post', { content, layout: [{ type: 'rows', display: [{ blocks: [0, 1] }] }] }, ctx);
  assert.deepEqual(fetch.calls[0].json.content, content);
  assert.deepEqual(fetch.calls[0].json.layout, [{ type: 'rows', display: [{ blocks: [0, 1] }] }]);
  const cases = [
    [{ content: [{ type: 'image', media: [{ url: 'https://cdn.example.com/a.png' }] }] }, /content\[0\] is an image without alt_text/],
    [{ content: [{ type: 'text', text: 'x'.repeat(4097) }] }, /content\[0\] has 4,097 characters; Tumblr allows 4,096 per text block/],
    [{ content: [{ text: 'no type' }] }, /content\[0\] has no type/],
    [{ content, text: 'both' }, /Give content, or text, images and link_url, not both/],
    [{ text: 'x'.repeat(4097) }, /Paragraph 1 has 4,097 characters/],
    [{ text: '   ' }, /The post has no content/],
    [{ tags: ['a,b'], text: 'x' }, /`tags\[0\]` does not have the expected format/],
  ];
  for (const [args, message] of cases) {
    const { payload, isError } = await callTool(module, 'create_post', args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 1);
});

test('update_post reads the post, keeps what is not given, and sends it back whole with the new state', async () => {
  const path = `/v2/blog/${ACME}/posts/1234567891234999`;
  const { module, fetch, ctx } = setup({
    [`GET ${path}`]: () => jsonResponse(200, fixture(import.meta.url, 'post-npf.json')),
    [`PUT ${path}`]: () => jsonResponse(200, fixture(import.meta.url, 'edited.json')),
  });
  const { payload, isError } = await callTool(module, 'update_post', { post_id: '1234567891234999', state: 'published' }, ctx);
  assert.equal(isError, false, payload.error);
  const [read, put] = fetch.calls;
  assert.deepEqual(read.query, { post_format: 'npf' });
  const draft = fixture(import.meta.url, 'post-npf.json').response;
  assert.deepEqual(put.json, { content: draft.content, layout: draft.layout, state: 'published', tags: 'prints,winter' });
  assert.deepEqual(payload, { id: '1234567891234999', blog: ACME, state: 'published', tags: ['prints', 'winter'], content_blocks: 2 });

  await callTool(module, 'update_post', { post_id: '1234567891234999', text: 'New words', tags: ['new'] }, ctx);
  assert.deepEqual(callsTo(fetch, 'PUT', path)[1].json, { content: [{ type: 'text', text: 'New words' }], layout: [], state: 'draft', tags: 'new' });

  const nothing = await callTool(module, 'update_post', { post_id: '1234567891234999' }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
});

test('update_post keeps a queued post\'s time, never guesses a missing state, and leaves older posts to Tumblr', async () => {
  const path = `/v2/blog/${ACME}/posts/5`;
  let post = { state: 'queued', publish_on: '2026-12-05T10:00:00Z', tags: [], content: [{ type: 'text', text: 'Q' }], layout: [] };
  const { module, fetch, ctx } = setup({
    [`GET ${path}`]: () => jsonResponse(200, { meta: { status: 200 }, response: post }),
    [`PUT ${path}`]: () => jsonResponse(200, { meta: { status: 200 }, response: { id: '5' } }),
  });
  await callTool(module, 'update_post', { post_id: '5', tags: ['friday'] }, ctx);
  assert.deepEqual(callsTo(fetch, 'PUT', path)[0].json, { content: [{ type: 'text', text: 'Q' }], layout: [], state: 'queue', publish_on: '2026-12-05T10:00:00Z', tags: 'friday' });

  post = { content: [{ type: 'text', text: 'x' }] };
  const unknown = await callTool(module, 'update_post', { post_id: '5', tags: ['x'] }, ctx);
  assert.match(unknown.payload.error, /Tumblr did not say which state the post is in: give state/);
  const withState = await callTool(module, 'update_post', { post_id: '5', state: 'draft' }, ctx);
  assert.equal(withState.isError, false, withState.payload.error);
  assert.equal('tags' in callsTo(fetch, 'PUT', path)[1].json, false, 'tags Tumblr did not send are not cleared');

  post = { state: 'published', body: '<p>legacy</p>' };
  const legacy = await callTool(module, 'update_post', { post_id: '5', state: 'draft' }, ctx);
  assert.match(legacy.payload.error, /not in the Neue Post Format/);
  assert.equal(callsTo(fetch, 'PUT', path).length, 2);
});

test('get_post returns the blocks to edit; delete_post deletes once with a form body', async () => {
  const { module, fetch, ctx } = setup({
    [`GET /v2/blog/${ACME}/posts/1234567891234999`]: () => jsonResponse(200, fixture(import.meta.url, 'post-npf.json')),
    [`POST /v2/blog/${ACME}/post/delete`]: () => jsonResponse(200, { meta: { status: 200, msg: 'OK' }, response: { id: 1234567891234999 } }),
  });
  const read = await callTool(module, 'get_post', { post_id: '1234567891234999' }, ctx);
  assert.equal(read.payload.state, 'draft');
  assert.equal(read.payload.slug, 'winter-series');
  assert.deepEqual(read.payload.tags, ['prints', 'winter']);
  assert.equal(read.payload.content.length, 2);
  assert.equal(read.payload.layout.length, 1);

  const deleted = await callTool(module, 'delete_post', { post_id: '1234567891234999' }, ctx);
  assert.deepEqual(deleted.payload, { deleted: true, id: '1234567891234999', blog: ACME });
  const [sent] = callsTo(fetch, 'POST', `/v2/blog/${ACME}/post/delete`);
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new TextDecoder().decode(sent.body), 'id=1234567891234999');
});

test('writes without a clear answer are unknown and sent once; Tumblr\'s refusals get plain sentences', async () => {
  for (const [tool, args, route] of [
    ['create_post', { text: 'x' }, `POST /v2/blog/${ACME}/posts`],
    ['delete_post', { post_id: '9' }, `POST /v2/blog/${ACME}/post/delete`],
  ]) {
    const { module, fetch, ctx } = setup({ [route]: () => jsonResponse(503, { meta: { status: 503, msg: 'Service Unavailable' } }) });
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, 'unknown');
    assert.equal(payload.check, 'list_posts');
    assert.equal(fetch.calls.length, 1);
  }
  const denied = setup({ 'GET /v2/user/info': () => jsonResponse(401, fixture(import.meta.url, 'error-401.json')) }, null);
  const auth = await callTool(denied.module, 'list_blogs', {}, denied.ctx);
  assert.match(auth.payload.error, /Tumblr rejected the credentials \(HTTP 401\)\. Check that the Tumblr access token is correct and still active\./);
  const forbidden = setup({ [`POST /v2/blog/${ACME}/posts`]: () => jsonResponse(403, { meta: { status: 403, msg: 'Forbidden' } }) });
  const refused = await callTool(forbidden.module, 'create_post', { text: 'x' }, forbidden.ctx);
  assert.match(refused.payload.error, /this account may not post to this blog .*\(HTTP 403\)\. Nothing was changed\./);
  const limited = setup({ [`GET /v2/blog/${ACME}/posts`]: () => jsonResponse(429, { meta: { status: 429, msg: 'Limit Exceeded' } }, { 'retry-after': '120' }) });
  const rate = await callTool(limited.module, 'list_posts', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 120);
});

test('api_get and api_request keep to /v2/ and, under the lock, to the chosen blogs named by id', async () => {
  const { module, fetch, ctx } = setup({
    [`GET /v2/blog/${ACME}/notes`]: () => jsonResponse(200, { meta: { status: 200 }, response: { notes: [], total_notes: 0 } }),
    [`POST /v2/blog/${ACME}/posts/queue/shuffle`]: () => jsonResponse(200, { meta: { status: 200 }, response: [] }),
  });
  const notes = await callTool(module, 'api_get', { path: `/v2/blog/${ACME}/notes`, query: { id: '1234567891234567' } }, ctx);
  assert.equal(notes.payload.status, 200);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const shuffle = await callTool(module, 'api_request', { method: 'POST', path: `/v2/blog/${ACME}/posts/queue/shuffle` }, ctx);
  assert.equal(shuffle.payload.status, 200);
  const other = await callTool(module, 'api_get', { path: `/v2/blog/${TEAM}/info` }, ctx);
  assert.match(other.payload.error, new RegExp(`The blog ${TEAM} is not among the blogs chosen`));
  const user = await callTool(module, 'api_get', { path: '/v2/user/likes' }, ctx);
  assert.match(user.payload.error, /names none of the blogs chosen for this connection/);
  const oauth = await callTool(setup(undefined, null).module, 'api_request', { method: 'POST', path: '/v2/oauth2/token' }, setup(undefined, null).ctx);
  assert.match(oauth.payload.error, /OAuth endpoints are not available here/);
  assert.equal(fetch.calls.length, 2);
});

test('a long list is cut under 32 KB and continues after the last post returned', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ ...fixture(import.meta.url, 'posts.json').response.posts[0], id_string: String(1234567891200000 + index), summary: '投稿の要約'.repeat(60), tags: Array.from({ length: 30 }, (_, tag) => `tag-number-${tag}-${'x'.repeat(40)}`) }));
  const { module, ctx } = setup({ [`GET /v2/blog/${ACME}/posts`]: () => jsonResponse(200, { meta: { status: 200 }, response: { posts: many, total_posts: 100 } }) });
  const first = await callTool(module, 'list_posts', {}, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.posts.length;
  const second = await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.posts[0].id, many[shown].id_string);
});

test('logs carry no token and no content', async () => {
  const { module, ctx, logs } = setup();
  await callTool(module, 'create_post', { text: 'Secret launch' }, ctx);
  const all = logs.join('\n');
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes('Secret launch'), false);
  assert.ok(logs.every((line) => /^tumblr create_post POST \d{3} \d+ms$/.test(line)), all);
});
