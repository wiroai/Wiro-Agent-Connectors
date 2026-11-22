import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.a0AfB_byCexampleBloggerToken0123456789';
const credentials = { access_token: TOKEN };
const BLOG = '4967929378133675647';
const OTHER_BLOG = '1234567890123456789';
const POST = '7706273476706534553';
const BASE = `https://www.googleapis.com/blogger/v3/blogs/${BLOG}`;

function setup(handler, accounts = { blogs: [BLOG] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

const fx = (name) => fixture(import.meta.url, name);

test('list_blogs reads the account\'s blogs with the bearer token, and is the blogs picker', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('blogs.json')), null);
  const [picker] = module.accountPickers;
  assert.deepEqual({ ...picker }, {
    key: 'blogs',
    label: 'Blogger blogs',
    description: 'The blogs the agent may write for.',
    multiple: true,
    tool: 'list_blogs',
    idField: 'id',
    nameField: 'name',
    legacyField: 'blogid',
  });
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/blogger/v3/users/self/blogs');
  assert.equal(request.query.fields, 'items(id,name,description,url,published,updated,posts/totalItems,pages/totalItems)');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload.blogs[0], {
    id: BLOG,
    name: 'Travel Notes',
    url: 'http://travelnotes.example.blogspot.com/',
    description: 'Short trips and long walks.',
    posts: 42,
    pages: 3,
    updated: '2026-11-20T08:41:17-08:00',
  });
  assert.deepEqual(payload.blogs.map((blog) => [blog[picker.idField], blog[picker.nameField]]), [[BLOG, 'Travel Notes'], [OTHER_BLOG, 'Kitchen Diary']]);
});

test('with a blog choice, list_blogs shows only the chosen blogs', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, fx('blogs.json')));
  const { payload } = await callTool(module, 'list_blogs', {}, ctx);
  assert.deepEqual(payload.blogs.map((blog) => blog.id), [BLOG]);
  const none = setup(() => jsonResponse(200, fx('blogs.json')), {});
  const empty = await callTool(none.module, 'list_blogs', {}, none.ctx);
  assert.deepEqual(empty.payload.blogs, []);
  assert.match(empty.payload.note, /No blog is chosen/);
});

test('list_posts asks for every status as admin, trims the posts and pages on with the cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('posts.json')));
  const { payload, isError } = await callTool(module, 'list_posts', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, `/blogger/v3/blogs/${BLOG}/posts`);
  const params = new URL(request.url).searchParams;
  assert.deepEqual(params.getAll('status'), ['DRAFT', 'SCHEDULED', 'LIVE']);
  assert.equal(params.get('view'), 'ADMIN');
  assert.equal(params.get('fetchBodies'), 'false');
  assert.equal(params.get('maxResults'), '20');
  assert.equal(params.get('orderBy'), 'PUBLISHED');
  assert.equal(params.get('sortOption'), 'DESCENDING');
  assert.match(params.get('fields'), /^nextPageToken,items\(id,title,status,labels/);

  assert.equal(payload.blog_id, BLOG);
  assert.deepEqual(payload.posts[0], {
    id: POST,
    title: 'Three days in Lisbon',
    status: 'draft',
    labels: ['travel', 'lisbon'],
    published: '2026-11-20T09:00:00-08:00',
    updated: '2026-11-21T10:30:00-08:00',
    url: 'http://travelnotes.example.blogspot.com/2026/11/three-days-in-lisbon.html',
    comments: 0,
    author: 'Alice Example',
    edit_url: `https://www.blogger.com/blog/post/edit/${BLOG}/${POST}`,
  });
  assert.equal(payload.posts[1].status, 'scheduled');
  assert.equal(payload.posts[2].comments, 5);
  assert.ok(payload.nextCursor);

  await callTool(module, 'list_posts', { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.pageToken, 'CgkIChjA7aGGsDMQ0r2NmIa8wokw');
});

test('list_posts filters: statuses, labels, order, time range in UTC, author view', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { items: [] }));
  await callTool(module, 'list_posts', {
    status: ['scheduled'],
    labels: ['travel', 'lisbon'],
    order_by: 'updated',
    ascending: true,
    start_date: '2026-11-01T09:00:00+03:00',
    end_date: '2026-12-01T00:00:00Z',
    max_results: 5,
    view: 'author',
  }, ctx);
  const params = new URL(fetch.calls[0].url).searchParams;
  assert.deepEqual(params.getAll('status'), ['SCHEDULED']);
  assert.equal(params.get('labels'), 'travel,lisbon');
  assert.equal(params.get('orderBy'), 'UPDATED');
  assert.equal(params.get('sortOption'), 'ASCENDING');
  assert.equal(params.get('startDate'), '2026-11-01T06:00:00Z');
  assert.equal(params.get('endDate'), '2026-12-01T00:00:00Z');
  assert.equal(params.get('maxResults'), '5');
  assert.equal(params.get('view'), 'AUTHOR');
});

test('a blog outside the choice is refused before any request; several chosen blogs need blog_id', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('posts.json')));
  const refused = await callTool(module, 'list_posts', { blog_id: OTHER_BLOG }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, new RegExp(`The blog ${OTHER_BLOG} is not among the blogs chosen for this connection\\. Use one of: ${BLOG}\\. Nothing was sent\\.`));
  const write = await callTool(module, 'create_draft_post', { blog_id: OTHER_BLOG, title: 'T', content: '<p>x</p>' }, ctx);
  assert.equal(write.isError, true);
  assert.equal(fetch.calls.length, 0);

  const two = setup(() => jsonResponse(200, fx('posts.json')), { blogs: [BLOG, OTHER_BLOG] });
  const ambiguous = await callTool(two.module, 'list_posts', {}, two.ctx);
  assert.match(ambiguous.payload.error, /Several blogs are chosen for this connection .*give blog_id/);
  assert.equal(two.fetch.calls.length, 0);

  const none = setup(() => jsonResponse(200, fx('posts.json')), {});
  const nothing = await callTool(none.module, 'list_posts', {}, none.ctx);
  assert.match(nothing.payload.error, /No Blogger blog is chosen for this connection yet/);
});

test('without an account lock, a single-blog account needs no blog_id; a several-blog one does', async () => {
  const single = { items: [fx('blogs.json').items[0]] };
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/users/self/blogs') ? jsonResponse(200, single) : jsonResponse(200, fx('posts.json'))), null);
  const { payload } = await callTool(module, 'list_posts', {}, ctx);
  assert.equal(payload.blog_id, BLOG);
  assert.equal(fetch.calls[1].path, `/blogger/v3/blogs/${BLOG}/posts`);

  const several = setup(() => jsonResponse(200, fx('blogs.json')), null);
  const ambiguous = await callTool(several.module, 'list_posts', {}, several.ctx);
  assert.match(ambiguous.payload.error, /has 2 blogs: give blog_id/);
});

test('get_post returns the body, in parts when it is long', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('post.json')));
  const { payload } = await callTool(module, 'get_post', { post_id: '3342298867103948312' }, ctx);
  const params = new URL(fetch.calls[0].url).searchParams;
  assert.equal(fetch.calls[0].path, `/blogger/v3/blogs/${BLOG}/posts/3342298867103948312`);
  assert.equal(params.get('view'), 'ADMIN');
  assert.equal(params.get('fetchBody'), 'true');
  assert.equal(payload.status, 'live');
  assert.deepEqual(payload.images, ['https://images.example.com/sintra.jpg']);
  assert.equal(payload.content, fx('post.json').content);
  assert.equal(payload.next_content_offset, undefined);

  // A body of 60,000 characters with a two-byte letter in it comes back in parts that join up exactly.
  const long = `<p>${'ş'.repeat(10_000)}${'a'.repeat(50_000)}</p>`;
  const big = setup(() => jsonResponse(200, { ...fx('post.json'), content: long }));
  const parts = [];
  let offset = 0;
  for (let round = 0; round < 10; round++) {
    const { payload: part, result } = await callTool(big.module, 'get_post', { post_id: '3342298867103948312', content_offset: offset }, big.ctx);
    assert.ok(textBytes(result) <= 32 * 1024);
    assert.equal(part.content_length, long.length);
    parts.push(part.content);
    if (part.next_content_offset === undefined) break;
    offset = part.next_content_offset;
  }
  assert.ok(parts.length > 2);
  assert.equal(parts.join(''), long);
});

test('search_posts and list_labels', async () => {
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/search')
    ? jsonResponse(200, { items: fx('posts.json').items.slice(2) })
    : jsonResponse(200, fx('labels.json'))));
  const found = await callTool(module, 'search_posts', { query: 'sintra fog', order_by: 'published' }, ctx);
  assert.equal(fetch.calls[0].path, `/blogger/v3/blogs/${BLOG}/posts/search`);
  assert.equal(fetch.calls[0].query.q, 'sintra fog');
  assert.equal(fetch.calls[0].query.orderBy, 'PUBLISHED');
  assert.equal(found.payload.posts[0].title, 'A morning in Sintra');

  const labels = await callTool(module, 'list_labels', {}, ctx);
  assert.equal(fetch.calls[1].query.maxResults, '200');
  assert.equal(fetch.calls[1].query.fields, 'items(labels)');
  assert.deepEqual(labels.payload.labels, [{ label: 'travel', posts: 3 }, { label: 'lisbon', posts: 2 }, { label: 'food', posts: 1 }, { label: 'porto', posts: 1 }]);
  assert.equal(labels.payload.posts_scanned, 5);
});

test('create_draft_post saves a draft and returns its editor link', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('draft.json')));
  const { payload, isError } = await callTool(module, 'create_draft_post', {
    title: 'Three days in Lisbon',
    content: "<p>Day one.</p><img src='https://images.example.com/lisbon.jpg' alt='Tram 28'>",
    labels: ['travel', 'lisbon'],
  }, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/blogger/v3/blogs/${BLOG}/posts`);
  assert.equal(request.query.isDraft, 'true');
  assert.equal(request.query.fetchBody, 'false');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.json, {
    kind: 'blogger#post',
    title: 'Three days in Lisbon',
    content: "<p>Day one.</p><img src='https://images.example.com/lisbon.jpg' alt='Tram 28'>",
    labels: ['travel', 'lisbon'],
  });
  assert.equal(payload.id, POST);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.edit_url, `https://www.blogger.com/blog/post/edit/${BLOG}/${POST}`);
});

test('update_post sends only the fields given, and refuses an empty change', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fx('draft.json')));
  await callTool(module, 'update_post', { post_id: POST, labels: ['travel', 'portugal'] }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, `${BASE}/posts/${POST}?fetchBody=false&fetchImages=false`);
  assert.deepEqual(fetch.calls[0].json, { labels: ['travel', 'portugal'] });

  const empty = await callTool(module, 'update_post', { post_id: POST }, ctx);
  assert.equal(empty.isError, true);
  assert.match(empty.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 1);
});

test('publish_post publishes now with an empty POST, or schedules at a time in UTC', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.query.publishDate ? fx('scheduled.json') : fx('published.json')));
  const now = await callTool(module, 'publish_post', { post_id: POST }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${BASE}/posts/${POST}/publish`);
  assert.equal(fetch.calls[0].body, undefined);
  assert.equal(now.payload.status, 'live');
  assert.equal(now.payload.url, 'http://travelnotes.example.blogspot.com/2026/11/three-days-in-lisbon.html');

  const later = await callTool(module, 'publish_post', { post_id: POST, publish_at: '2036-12-01T12:00:00+03:00' }, ctx);
  assert.equal(fetch.calls[1].query.publishDate, '2036-12-01T09:00:00Z');
  assert.equal(later.payload.status, 'scheduled');
  assert.match(later.payload.note, /Scheduled: Blogger publishes it at 2036-12-01T09:00:00Z/);

  const bad = await callTool(module, 'publish_post', { post_id: POST, publish_at: '2026-13-45T99:00:00Z' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.payload.error, /publish_at is not a valid time/);
  assert.equal(fetch.calls.length, 2);
});

test('revert_post and delete_post', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(200, fx('draft.json'))));
  const reverted = await callTool(module, 'revert_post', { post_id: POST }, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/posts/${POST}/revert`);
  assert.equal(reverted.payload.status, 'draft');

  const deleted = await callTool(module, 'delete_post', { post_id: POST }, ctx);
  assert.equal(fetch.calls[1].method, 'DELETE');
  assert.equal(fetch.calls[1].url, `${BASE}/posts/${POST}?useTrash=true`);
  assert.deepEqual(deleted.payload, { deleted: true, blog_id: BLOG, post_id: POST });
});

test('pages: list, draft without labels, publish', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET' ? jsonResponse(200, fx('pages.json')) : jsonResponse(200, { ...fx('pages.json').items[1], status: request.path.endsWith('/publish') ? 'LIVE' : 'DRAFT' })));
  const listed = await callTool(module, 'list_pages', {}, ctx);
  assert.deepEqual(new URL(fetch.calls[0].url).searchParams.getAll('status'), ['DRAFT', 'LIVE']);
  assert.equal(fetch.calls[0].query.fields, 'nextPageToken,items(id,title,status,published,updated,url,author/displayName)');
  assert.deepEqual(listed.payload.pages[1], {
    id: '5512345678901234568',
    title: 'Contact',
    status: 'draft',
    updated: '2026-11-21T09:00:00-08:00',
    url: 'http://travelnotes.example.blogspot.com/p/contact.html',
    author: 'Alice Example',
    edit_url: `https://www.blogger.com/blog/page/edit/${BLOG}/5512345678901234568`,
  });

  const draft = await callTool(module, 'create_draft_page', { title: 'Contact', content: '<p>Write to us.</p>' }, ctx);
  assert.equal(fetch.calls[1].url, `${BASE}/pages?isDraft=true`);
  assert.deepEqual(fetch.calls[1].json, { kind: 'blogger#page', title: 'Contact', content: '<p>Write to us.</p>' });
  assert.equal(draft.payload.status, 'draft');

  const page = module.tools.find((tool) => tool.name === 'create_draft_page');
  assert.equal('labels' in page.inputSchema.properties, false);
  const published = await callTool(module, 'publish_page', { page_id: '5512345678901234568' }, ctx);
  assert.equal(fetch.calls[2].url, `${BASE}/pages/5512345678901234568/publish`);
  assert.equal(published.payload.status, 'live');
  assert.equal('publish_at' in module.tools.find((tool) => tool.name === 'publish_page').inputSchema.properties, false);
});

test('errors: a 403 explains the author view, a 404 names the post, a 429 carries retryAfter', async () => {
  const forbidden = setup(() => jsonResponse(403, fx('error-403.json')));
  const denied = await callTool(forbidden.module, 'list_posts', {}, forbidden.ctx);
  assert.equal(denied.payload.status, 403);
  assert.match(denied.payload.error, /only an author on this blog must use view "author".*\(HTTP 403\)\. Blogger said: "We're sorry, but you don't have permission to access this resource\."/);

  const missing = setup(() => jsonResponse(404, fx('error-404.json')));
  const gone = await callTool(missing.module, 'get_post', { post_id: '42' }, missing.ctx);
  assert.match(gone.payload.error, /Blogger found no post 42 on this blog \(HTTP 404\)/);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'Rate Limit Exceeded' } }, { 'retry-after': '30' }));
  const rate = await callTool(limited.module, 'list_posts', {}, limited.ctx);
  assert.equal(rate.payload.status, 429);
  assert.equal(rate.payload.retryAfter, 30);
});

test('Google\'s markup in an error is dropped, its words kept', async () => {
  const { module, ctx } = setup(() => jsonResponse(400, { error: { code: 400, message: 'Invalid value. See <a href="https://developers.google.com/blogger">the guide</a>.' } }));
  const { payload } = await callTool(module, 'update_post', { post_id: POST, title: 'x' }, ctx);
  assert.match(payload.error, /Blogger said|Invalid value/);
  assert.doesNotMatch(payload.error, /<a |<\/a>/);
  assert.match(payload.error, /See the guide/);
});

test('a write without a clear answer is sent once and reported as unknown, with the check tool', async () => {
  for (const [tool, args, check] of [
    ['create_draft_post', { title: 'T', content: '<p>x</p>' }, 'list_posts'],
    ['publish_post', { post_id: POST }, 'get_post'],
    ['delete_page', { page_id: '5512345678901234568' }, 'get_page'],
  ]) {
    const { module, fetch, ctx } = setup(() => jsonResponse(503, { error: { code: 503, message: 'Backend Error' } }));
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, 'unknown', tool);
    assert.equal(payload.check, check);
    assert.equal(fetch.calls.length, 1, `${tool} was sent once`);
  }
  const { module, fetch, ctx } = setup(() => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  });
  const timeout = await callTool(module, 'update_post', { post_id: POST, title: 'New' }, ctx);
  assert.equal(timeout.payload.outcome, 'unknown');
  assert.equal(fetch.calls.length, 1);
});

test('api_get and api_request stay under /blogger/v3/ and inside the blog choice', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { kind: 'blogger#pageviews', counts: [{ timeRange: '30DAYS', count: '1200' }] }));
  const read = await callTool(module, 'api_get', { path: `/blogger/v3/blogs/${BLOG}/pageviews`, query: { range: '30DAYS' } }, ctx);
  assert.equal(read.isError, false, read.payload.error);
  assert.equal(fetch.calls[0].url, `${BASE}/pageviews?range=30DAYS`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(read.payload.data.counts[0].count, '1200');

  const other = await callTool(module, 'api_request', { method: 'POST', path: `/blogger/v3/blogs/${OTHER_BLOG}/posts/1/comments/2/approve` }, ctx);
  assert.match(other.payload.error, new RegExp(`${OTHER_BLOG} is not among the blogs chosen`));
  const none = await callTool(module, 'api_get', { path: '/blogger/v3/users/self/blogs' }, ctx);
  assert.match(none.payload.error, /names none of the blogs chosen for this connection/);
  const outside = await callTool(module, 'api_get', { path: '/drive/v3/files' }, ctx);
  assert.match(outside.payload.error, /The path must start with \/blogger\/v3\//);
  assert.equal(fetch.calls.length, 1);

  const broken = setup(() => jsonResponse(502, { error: { message: 'Bad Gateway' } }));
  const unknown = await callTool(broken.module, 'api_request', { method: 'DELETE', path: `/blogger/v3/blogs/${BLOG}/posts/${POST}/comments/9` }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('log lines carry no token and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, fx('draft.json')));
  await callTool(module, 'create_draft_post', { title: 'Secret plans', content: '<p>private words</p>', labels: ['hidden-label'] }, ctx);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.match(line, /^blogger create_draft_post POST 200 \d+ms$/);
    assert.equal(line.includes(TOKEN), false);
    assert.equal(/Secret|private|hidden/.test(line), false);
  }
});
