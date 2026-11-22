import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const credentials = { url: 'https://example.com/blog', user: 'agent-editor', apppassword: 'abcd EFGH 1234 ijkl MNOP 5678' };
const BASIC = `Basic ${Buffer.from('agent-editor:abcd EFGH 1234 ijkl MNOP 5678').toString('base64')}`;
const API = 'https://example.com/blog/wp-json';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0xb0, 0, 0, 2, 0x76]);

function setup(handler, overrides = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: { ...credentials, ...overrides }, fetch });
  return { module, fetch, ctx, logs };
}

const listHeaders = (total, pages) => ({ 'x-wp-total': String(total), 'x-wp-totalpages': String(pages) });

test('get_site reads the user and the site with Basic auth, under the install path', async () => {
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/users/me') ? jsonResponse(200, fixture(import.meta.url, 'users-me.json')) : jsonResponse(200, fixture(import.meta.url, 'index.json'))));
  const { payload, isError } = await callTool(module, 'get_site', {}, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/users/me?context=edit&_fields=id%2Cusername%2Cname%2Cslug%2Croles%2Ccapabilities`);
  assert.equal(fetch.calls[0].headers.authorization, BASIC);
  assert.equal(fetch.calls[1].path, '/blog/wp-json/');
  assert.equal(fetch.calls[1].query._fields, 'name,description,url,home,gmt_offset,timezone_string,namespaces');
  assert.deepEqual(payload, {
    site: { name: 'Example Coffee – Notes', tagline: 'Brewing guides & reviews', url: 'https://example.com/blog', timezone: 'Europe/Istanbul' },
    rest_url: 'https://example.com/blog/wp-json/',
    user: {
      id: 7,
      username: 'agent-editor',
      name: 'Agent Editor',
      roles: ['editor'],
      can: { publish_posts: true, edit_others_posts: true, publish_pages: true, upload_files: true, manage_categories: true },
    },
    rank_math: true,
  });
});

test('an admin, REST or login path pasted with the site URL is dropped; the origin comes from the URL as given', async () => {
  for (const url of ['https://example.com/blog/wp-admin/', 'example.com/blog/wp-json/wp/v2', 'https://example.com/blog/wp-login.php']) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, []), { url });
    await callTool(module, 'list_posts', {}, ctx);
    assert.equal(fetch.calls[0].origin, 'https://example.com');
    assert.equal(fetch.calls[0].path, '/blog/wp-json/wp/v2/posts', url);
  }
  const root = setup(() => jsonResponse(200, []), { url: 'https://example.com' });
  await callTool(root.module, 'list_posts', {}, root.ctx);
  assert.equal(root.fetch.calls[0].path, '/wp-json/wp/v2/posts');
});

test('an http or credential-bearing site URL is refused before anything is sent', async () => {
  for (const url of ['http://example.com', 'https://user:secret@example.com']) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, []), { url });
    const { payload, isError } = await callTool(module, 'list_posts', {}, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, /WordPress is not connected correctly: the WordPress URL/);
    assert.equal(fetch.calls.length, 0);
  }
});

test('list_posts trims each post, adds the editor link, and pages with a cursor that keeps the filters', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'posts.json'), listHeaders(3, 2)));
  const first = await callTool(module, 'list_posts', { status: 'any', search: 'coffee', categories: [3], per_page: 2 }, ctx);
  assert.equal(first.isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/blog/wp-json/wp/v2/posts');
  assert.deepEqual(
    { ...request.query, _fields: undefined },
    { context: 'view', _fields: undefined, status: 'any', search: 'coffee', categories: '3', orderby: 'date', order: 'desc', per_page: '2', page: '1' },
  );
  assert.deepEqual(first.payload.posts[0], {
    id: 412,
    type: 'post',
    status: 'publish',
    title: 'Pour-over ratios that actually work',
    date: '2026-11-18T09:00:00',
    modified: '2026-11-18T09:12:44',
    slug: 'pour-over-ratios',
    link: 'https://example.com/blog/pour-over-ratios/',
    edit_link: 'https://example.com/blog/wp-admin/post.php?post=412&action=edit',
    excerpt: 'The 1:16 rule, and when to break it …',
    author: 7,
    categories: [3],
    tags: [11, 12],
    featured_media: 388,
  });
  assert.equal(first.payload.posts[1].status, 'draft');
  assert.equal(first.payload.total, 3);
  assert.ok(first.payload.nextCursor);

  // Only the cursor: page 2 of the same list.
  await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '2');
  assert.equal(fetch.calls[1].query.search, 'coffee');
  assert.equal(fetch.calls[1].query.categories, '3');
});

test('a forged cursor cannot carry parameters the tool does not take', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, []));
  const forged = Buffer.from(JSON.stringify({ t: 'list_posts', p: 1, o: 0, f: JSON.stringify({ _method: 'DELETE' }) })).toString('base64url');
  const { payload, isError } = await callTool(module, 'list_posts', { cursor: forged }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /The cursor is not valid for this tool/);
  assert.equal(fetch.calls.length, 0);
});

test('a page over 32 KB is cut and continues after the last post returned', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    id: 1000 + index,
    status: 'publish',
    type: 'post',
    title: { rendered: `Post ${index} `.padEnd(290, 'x') },
    excerpt: { rendered: `<p>${'word '.repeat(60)}</p>` },
    link: `https://example.com/blog/post-${index}/`,
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, many, listHeaders(100, 1)));
  const first = await callTool(module, 'list_posts', { per_page: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.posts.length;
  const second = await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '1');
  assert.equal(second.payload.posts[0].id, 1000 + shown);
});

test('get_post returns the raw content in parts that fit the result, and falls back to the published version without edit rights', async () => {
  const post = fixture(import.meta.url, 'post-edit.json');
  const content = `<p class="intro">${'é'.repeat(12_000)}</p>\n${'<p>"quoted" text</p>'.repeat(1500)}`;
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { ...post, content: { raw: content } }));
  const parts = [];
  let offset = 0;
  for (let round = 0; round < 10; round++) {
    const { result, payload } = await callTool(module, 'get_post', { id: 412, content_offset: offset }, ctx);
    assert.ok(textBytes(result) <= 32 * 1024);
    assert.equal(payload.truncated, undefined, 'never cut by the size limit');
    assert.equal(payload.content_length, Array.from(content).length);
    parts.push(payload.content);
    if (payload.next_content_offset === undefined) break;
    offset = payload.next_content_offset;
  }
  assert.ok(parts.length > 2);
  assert.equal(parts.join(''), content);
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/posts/412?context=edit`);

  const short = setup(() => jsonResponse(200, post));
  const whole = await callTool(short.module, 'get_post', { id: 412 }, short.ctx);
  assert.equal(whole.payload.title, 'Pour-over ratios that actually work');
  assert.equal(whole.payload.content, '<h2>Start with 1:16</h2>\n<p>Weigh the coffee, then the water.</p>');
  assert.equal(whole.payload.next_content_offset, undefined);
  assert.equal(whole.payload.comment_status, 'open');

  let calls = 0;
  const viewer = setup(() => (calls++ === 0 ? jsonResponse(403, fixture(import.meta.url, 'error-forbidden-context.json')) : jsonResponse(200, { ...post, content: { rendered: '<p>Hi</p>' } })));
  const fallback = await callTool(viewer.module, 'get_post', { id: 412, type: 'page' }, viewer.ctx);
  assert.equal(fallback.isError, false);
  assert.equal(viewer.fetch.calls[1].url, `${API}/wp/v2/pages/412?context=view`);
  assert.equal(fallback.payload.content, '<p>Hi</p>');
});

test('create_post saves a draft by default with the given fields and returns its editor link', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, fixture(import.meta.url, 'post-created.json')));
  const { payload, isError } = await callTool(module, 'create_post', {
    title: 'Cold brew at home',
    content: '<p>Steep for 16 hours.</p>',
    categories: [3],
    tags: [12],
    featured_media: 456,
    slug: 'cold-brew-at-home',
  }, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${API}/wp/v2/posts`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.json, {
    title: 'Cold brew at home',
    content: '<p>Steep for 16 hours.</p>',
    slug: 'cold-brew-at-home',
    status: 'draft',
    categories: [3],
    tags: [12],
    featured_media: 456,
  });
  assert.equal(payload.id, 431);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.edit_link, 'https://example.com/blog/wp-admin/post.php?post=431&action=edit');
  assert.match(payload.note, /Not public yet/);
  assert.equal('content' in payload, false);
});

test('dates: an offset is a fixed moment (date_gmt), no offset is the site\'s local time (date)', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, fixture(import.meta.url, 'post-created.json')));
  await callTool(module, 'create_post', { title: 'A', status: 'future', date: '2026-12-01T09:00:00+03:00' }, ctx);
  assert.equal(fetch.calls[0].json.date_gmt, '2026-12-01T06:00:00');
  assert.equal(fetch.calls[0].json.status, 'future');
  await callTool(module, 'create_post', { title: 'A', status: 'future', date: '2026-12-01 09:30' }, ctx);
  assert.equal(fetch.calls[1].json.date, '2026-12-01T09:30:00');
  assert.equal('date_gmt' in fetch.calls[1].json, false);
});

test('wrong combinations are refused before anything is sent', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, {}));
  const future = await callTool(module, 'create_post', { title: 'A', status: 'future' }, ctx);
  assert.match(future.payload.error, /status future needs date/);
  const pageTags = await callTool(module, 'create_post', { type: 'page', title: 'A', tags: [1] }, ctx);
  assert.match(pageTags.payload.error, /for posts only/);
  const postParent = await callTool(module, 'update_post', { id: 1, parent: 2 }, ctx);
  assert.match(postParent.payload.error, /for pages only/);
  const badDate = await callTool(module, 'create_post', { title: 'A', date: 'next tuesday' }, ctx);
  assert.match(badDate.payload.error, /date must look like/);
  const nothing = await callTool(module, 'update_post', { id: 1 }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 0);
});

test('update_post sends only the given fields; publishing is a status change', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { ...fixture(import.meta.url, 'post-created.json'), status: 'publish', link: 'https://example.com/blog/cold-brew/' }));
  const { payload } = await callTool(module, 'update_post', { id: 431, status: 'publish', featured_media: 0 }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/posts/431`);
  assert.deepEqual(fetch.calls[0].json, { status: 'publish', featured_media: 0 });
  assert.equal(payload.status, 'publish');
  assert.equal(payload.note, undefined);
});

test('a WordPress refusal keeps its words and adds what to check', async () => {
  const wrong = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-incorrect-password.json')));
  const denied = await callTool(wrong.module, 'list_posts', {}, wrong.ctx);
  assert.equal(denied.payload.status, 401);
  assert.equal(denied.payload.vendorCode, 'incorrect_password');
  assert.match(denied.payload.error, /The provided password is an invalid application password/);
  assert.match(denied.payload.error, /it is not the account password/);

  const author = setup(() => jsonResponse(403, fixture(import.meta.url, 'error-cannot-publish.json')));
  const refused = await callTool(author.module, 'update_post', { id: 431, status: 'publish' }, author.ctx);
  assert.match(refused.payload.error, /Sorry, you are not allowed to publish posts in this post type.*Nothing was changed\. The WordPress user may not publish/);

  const html = setup(() => textResponse(404, '<html><body>Not found</body></html>', { 'content-type': 'text/html' }));
  const missing = await callTool(html.module, 'list_posts', {}, html.ctx);
  assert.match(missing.payload.error, /found nothing there \(HTTP 404\)\. Check that the WordPress URL is the site's address/);

  const limited = setup(() => jsonResponse(429, { code: 'too_many', message: 'Slow down' }, { 'retry-after': '30' }));
  const rate = await callTool(limited.module, 'list_posts', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);
});

test('a write with no clear answer is reported as unknown, sent once', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(503, { code: 'unavailable', message: 'Service unavailable' }));
  const created = await callTool(module, 'create_post', { title: 'A' }, ctx);
  assert.equal(created.payload.outcome, 'unknown');
  assert.equal(created.payload.check, 'list_posts');
  assert.equal(fetch.calls.length, 1);

  const timeout = setup(() => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  });
  const updated = await callTool(timeout.module, 'update_post', { id: 1, title: 'B' }, timeout.ctx);
  assert.equal(updated.payload.outcome, 'unknown');
  assert.equal(updated.payload.check, 'get_post');
  assert.equal(timeout.fetch.calls.length, 1);
});

test('upload_media downloads the file, names it by its bytes and uploads it with its alt text in one request', async () => {
  const { module, fetch, ctx } = setup((request) => (request.origin === 'https://cdn.example.net'
    ? bytesResponse(200, PNG, { 'content-type': 'application/octet-stream' })
    : jsonResponse(201, fixture(import.meta.url, 'media-created.json'))));
  const { payload, isError } = await callTool(module, 'upload_media', {
    url: 'https://cdn.example.net/renders/Cover%20Image.jpeg?sig=1',
    alt_text: 'A glass jar of cold brew coffee',
    title: 'Cold brew jar',
    post_id: 431,
  }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 2);
  const [download, upload] = fetch.calls;
  assert.equal(download.method, 'GET');
  assert.equal(download.headers.authorization, undefined, 'no credentials go with a media download');
  assert.equal(upload.method, 'POST');
  assert.equal(upload.path, '/blog/wp-json/wp/v2/media');
  assert.deepEqual(upload.query, { alt_text: 'A glass jar of cold brew coffee', title: 'Cold brew jar', post: '431' });
  assert.equal(upload.headers['content-type'], 'image/png');
  assert.equal(upload.headers['content-disposition'], 'attachment; filename="Cover-Image.png"');
  assert.equal(upload.headers.authorization, BASIC);
  assert.deepEqual([...upload.body], [...PNG]);
  assert.deepEqual(payload, {
    id: 456,
    date: '2026-11-22T10:14:40',
    title: 'Cold brew jar',
    source_url: 'https://example.com/blog/wp-content/uploads/2026/11/cover-image.png',
    mime_type: 'image/png',
    media_type: 'image',
    alt_text: 'A glass jar of cold brew coffee',
    width: 1200,
    height: 630,
    filesize: 48211,
    link: 'https://example.com/blog/cover-image/',
  });
});

test('upload_media refuses a file type it cannot tell, and reports a too-large refusal and an unclear upload', async () => {
  const text = setup(() => bytesResponse(200, new TextEncoder().encode('just text'), { 'content-type': 'image/png' }));
  const refused = await callTool(text.module, 'upload_media', { url: 'https://cdn.example.net/a.png' }, text.ctx);
  assert.match(refused.payload.error, /not a type the media library takes/);
  assert.equal(text.fetch.calls.length, 1, 'only the download');

  const big = setup((request) => (request.origin === 'https://cdn.example.net' ? bytesResponse(200, PNG) : jsonResponse(413, { code: 'too_big', message: 'Request Entity Too Large' })));
  const tooLarge = await callTool(big.module, 'upload_media', { url: 'https://cdn.example.net/a.png' }, big.ctx);
  assert.match(tooLarge.payload.error, /The site refused the file as larger than its upload limit \(HTTP 413\)/);

  const broken = setup((request) => (request.origin === 'https://cdn.example.net' ? bytesResponse(200, PNG) : jsonResponse(502, {})));
  const unknown = await callTool(broken.module, 'upload_media', { url: 'https://cdn.example.net/a.png' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_media');
  assert.equal(broken.fetch.calls.length, 2);
});

test('update_media and list_media', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET' ? jsonResponse(200, fixture(import.meta.url, 'media-list.json'), listHeaders(1, 1)) : jsonResponse(200, fixture(import.meta.url, 'media-created.json'))));
  await callTool(module, 'update_media', { id: 456, alt_text: 'New alt', post_id: 0 }, ctx);
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/media/456`);
  assert.deepEqual(fetch.calls[0].json, { alt_text: 'New alt', post: 0 });

  const { payload } = await callTool(module, 'list_media', { media_type: 'image', search: 'jar' }, ctx);
  assert.equal(fetch.calls[1].query._fields, 'id,date,title,source_url,mime_type,media_type,alt_text,post,link,media_details.width,media_details.height,media_details.filesize');
  assert.equal(fetch.calls[1].query.media_type, 'image');
  assert.deepEqual(payload.media[0], {
    id: 456,
    date: '2026-11-22T10:14:40',
    title: 'Cold brew jar',
    source_url: 'https://example.com/blog/wp-content/uploads/2026/11/cover-image.png',
    mime_type: 'image/png',
    media_type: 'image',
    alt_text: 'A glass jar of cold brew coffee',
    width: 1200,
    height: 630,
    filesize: 48211,
    attached_to: 431,
    link: 'https://example.com/blog/cover-image/',
  });
  assert.equal(payload.nextCursor, undefined);
});

test('list_terms lists categories; create_term returns an existing term instead of a second one', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'POST'
    ? jsonResponse(400, fixture(import.meta.url, 'term-exists.json'))
    : jsonResponse(200, fixture(import.meta.url, 'categories.json'), listHeaders(2, 1))));
  const list = await callTool(module, 'list_terms', { search: 'brew' }, ctx);
  assert.equal(fetch.calls[0].path, '/blog/wp-json/wp/v2/categories');
  assert.equal(fetch.calls[0].query.search, 'brew');
  assert.deepEqual(list.payload.categories[0], { id: 3, name: 'Brewing & Gear', slug: 'brewing-gear', count: 14, link: 'https://example.com/blog/category/brewing-gear/' });

  const created = await callTool(module, 'create_term', { taxonomy: 'categories', name: 'Brewing & Gear' }, ctx);
  assert.equal(created.isError, false);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.deepEqual(fetch.calls[1].json, { name: 'Brewing & Gear' });
  assert.equal(fetch.calls[2].query.search, 'Brewing');
  assert.equal(fetch.calls[2].query.parent, '0');
  assert.deepEqual(created.payload, { id: 3, name: 'Brewing & Gear', slug: 'brewing-gear', count: 14, link: 'https://example.com/blog/category/brewing-gear/', existing: true });
});

test('set_seo_meta writes through Rank Math\'s own endpoint, and skips quietly when the site has no Rank Math', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET' ? jsonResponse(200, fixture(import.meta.url, 'rankmath-namespace.json')) : jsonResponse(200, fixture(import.meta.url, 'rankmath-updated.json'))));
  const { payload, isError } = await callTool(module, 'set_seo_meta', { post_id: 431, focus_keyword: 'cold brew,cold brew ratio', seo_title: 'Cold Brew at Home: The Easy Way', meta_description: 'How to make cold brew coffee at home.' }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].url, `${API}/rankmath/v1?_fields=namespace`);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.equal(fetch.calls[1].url, `${API}/rankmath/v1/updateMeta`);
  assert.deepEqual(fetch.calls[1].json, {
    objectType: 'post',
    objectID: 431,
    meta: { rank_math_focus_keyword: 'cold brew,cold brew ratio', rank_math_title: 'Cold Brew at Home: The Easy Way', rank_math_description: 'How to make cold brew coffee at home.' },
  });
  assert.deepEqual(payload, { applied: true, post_id: 431, fields: ['rank_math_focus_keyword', 'rank_math_title', 'rank_math_description'] });

  const none = setup(() => jsonResponse(404, fixture(import.meta.url, 'error-no-route.json')));
  const skipped = await callTool(none.module, 'set_seo_meta', { post_id: 431, focus_keyword: 'cold brew' }, none.ctx);
  assert.equal(skipped.isError, false);
  assert.equal(skipped.payload.applied, false);
  assert.match(skipped.payload.reason, /does not run the Rank Math SEO plugin/);
  assert.equal(none.fetch.calls.length, 1);

  const old = setup((request) => (request.method === 'GET' ? jsonResponse(200, fixture(import.meta.url, 'rankmath-namespace.json')) : jsonResponse(404, fixture(import.meta.url, 'error-no-route.json'))));
  const oldVersion = await callTool(old.module, 'set_seo_meta', { post_id: 431, seo_title: 'T' }, old.ctx);
  assert.equal(oldVersion.payload.applied, false);
  assert.match(oldVersion.payload.reason, /no API for saving SEO fields/);

  const nothing = await callTool(module, 'set_seo_meta', { post_id: 431 }, ctx);
  assert.match(nothing.payload.error, /Nothing to set/);
});

test('api_get and api_request reach REST routes under the install path, and refuse what the connector keeps out', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, [{ id: 9, content: { rendered: '<p>Nice</p>' } }], listHeaders(1, 1)));
  const read = await callTool(module, 'api_get', { path: '/wp/v2/comments', query: { post: 412, _fields: 'id,content' } }, ctx);
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/comments?post=412&_fields=id%2Ccontent`);
  assert.equal(fetch.calls[0].headers.authorization, BASIC);
  assert.deepEqual(read.payload.headers, { 'x-wp-total': '1', 'x-wp-totalpages': '1' });
  assert.equal(read.payload.data[0].id, 9);

  await callTool(module, 'api_request', { method: 'DELETE', path: '/wp/v2/posts/415', query: { force: true } }, ctx);
  assert.equal(fetch.calls[1].method, 'DELETE');
  assert.equal(fetch.calls[1].url, `${API}/wp/v2/posts/415?force=true`);
  await callTool(module, 'api_get', { path: '/wp/v2/plugins' }, ctx);
  assert.equal(fetch.calls[2].url, `${API}/wp/v2/plugins`);
  await callTool(module, 'api_request', { method: 'PATCH', path: '/wp/v2/comments/9', json: { status: 'approved' }, content_type: 'application/merge-patch+json' }, ctx);
  assert.equal(fetch.calls[3].headers['content-type'], 'application/merge-patch+json', 'a JSON body with another JSON type is sent');
  assert.deepEqual(JSON.parse(Buffer.from(fetch.calls[3].body).toString('utf8')), { status: 'approved' });

  const refusals = [
    ['api_get', { path: '/wp/v2/posts', query: { _method: 'DELETE' } }, /"_method" is not allowed/],
    ['api_get', { path: '/', query: { rest_route: '/wp/v2/plugins' } }, /"rest_route" is not allowed/],
    ['api_get', { path: '/wp/v2/users/me/application-passwords' }, /Application passwords/],
    ['api_request', { method: 'POST', path: '/wp/v2/plugins', json: { slug: 'x', status: 'active' } }, /Plugins and themes/],
    ['api_request', { method: 'POST', path: '/wp/v2/settings', json: { email: 'a@example.com' } }, /Site settings/],
    ['api_request', { method: 'POST', path: '/wp/v2/users', json: { username: 'x', roles: ['administrator'] } }, /Users cannot be created/],
    ['api_request', { method: 'DELETE', path: '/wp/v2/users/3' }, /Users cannot be created/],
  ];
  for (const [tool, args, pattern] of refusals) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, pattern);
    assert.match(payload.error, /Nothing was sent/);
  }
  assert.equal(fetch.calls.length, 4);

  const broken = setup(() => jsonResponse(500, {}));
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: '/wp/v2/comments', json: { post: 1, content: 'Hi' } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('the generic tools refuse what WordPress would read as another method, route or user, before sending', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const refusals = [
    // Query names PHP turns into _method or rest_route: a leading space, ".", "[", a NUL, an array field.
    ['api_get', { path: '/wp/v2/users/2', query: { ' _method': 'DELETE', reassign: 1, force: true } }, /" _method" is not allowed/],
    ['api_get', { path: '/wp/v2/posts/1', query: { '.method': 'DELETE' } }, /"\.method" is not allowed/],
    ['api_get', { path: '/wp/v2/posts', query: { 'rest.route': '/wp/v2/users/me/application-passwords' } }, /"rest\.route" is not allowed/],
    ['api_get', { path: '/wp/v2/posts', query: { 'rest[route': '/wp/v2/settings' } }, /"rest\[route" is not allowed/],
    ['api_get', { path: '/wp/v2/posts', query: { '_method\u0000x': 'DELETE' } }, /is not allowed/],
    ['api_request', { method: 'POST', path: '/wp/v2/posts', query: { 'rest_route[a]': '/wp/v2/users' }, json: {} }, /is not allowed/],
    ['api_get', { path: '/wp/v2/posts', query: { _METHOD: 'DELETE' } }, /is not allowed/],
    // A form body: PHP reads it into $_POST, where WordPress takes rest_route from.
    ['api_request', { method: 'POST', path: '/wp/v2/posts', body: 'rest_route=/wp/v2/users/me/application-passwords&name=x', content_type: 'application/x-www-form-urlencoded' }, /The body must be JSON/],
    ['api_request', { method: 'POST', path: '/wp/v2/posts', json: { x: '&rest_route=/wp/v2/users&' }, content_type: 'Application/X-WWW-Form-Urlencoded; charset=utf-8' }, /The body must be JSON/],
    ['api_request', { method: 'POST', path: '/wp/v2/posts', body: '--b\r\nContent-Disposition: form-data; name="rest_route"\r\n\r\n/wp/v2/users\r\n--b--', content_type: 'multipart/form-data; boundary=b' }, /The body must be JSON/],
    ['api_request', { method: 'POST', path: '/wp/v2/posts', body: 'title=x', content_type: 'text/plain' }, /The body must be JSON/],
    // Batches run sub-requests on any route.
    ['api_request', { method: 'POST', path: '/batch/v1', json: { requests: [{ method: 'POST', path: '/wp/v2/users', body: { username: 'x', roles: ['administrator'] } }] } }, /Batch requests/],
    // An encoded slash or backslash becomes a separator when WordPress decodes the route.
    ['api_request', { method: 'POST', path: '/wp/v2%2Fsettings', json: { title: 'x' } }, /encoded slash/],
    ['api_get', { path: '/wp/v2/users%2Fme%2Fapplication-passwords' }, /encoded slash/],
    ['api_request', { method: 'POST', path: '/wp/v2/posts%5C1', json: {} }, /encoded slash/],
    // The connected user cannot be changed either: a new password or email would take the account over.
    ['api_request', { method: 'POST', path: '/wp/v2/users/me', json: { password: 'chosen-by-the-agent', email: 'elsewhere@example.net' } }, /Users cannot be created, changed or deleted/],
    ['api_request', { method: 'POST', path: '/wp/v2/users/me', json: { description: 'Writes about coffee' } }, /Users cannot be created, changed or deleted/],
  ];
  for (const [tool, args, pattern] of refusals) {
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(payload.error, pattern, JSON.stringify(args));
    assert.match(payload.error, /Nothing was sent/);
  }
  assert.equal(fetch.calls.length, 0);

  // Reading the connected user stays open.
  await callTool(module, 'api_get', { path: '/wp/v2/users/me', query: { context: 'edit' } }, ctx);
  assert.equal(fetch.calls[0].url, `${API}/wp/v2/users/me?context=edit`);
});

test('create_term finds an existing category under the parent it was to have, by a search WordPress can match', async () => {
  const siblings = [
    { id: 30, name: 'Tools &amp; Kits', slug: 'tools-kits-2', count: 1, parent: 12 },
    { id: 31, name: 'Tools &amp; Kits', slug: 'tools-kits', count: 4, parent: 0 },
  ];
  const { module, fetch, ctx } = setup((request) => (request.method === 'POST'
    ? jsonResponse(400, fixture(import.meta.url, 'term-exists.json'))
    : jsonResponse(200, siblings.filter((term) => term.parent === Number(request.query.parent)), listHeaders(1, 1))));
  const top = await callTool(module, 'create_term', { taxonomy: 'categories', name: 'Tools & Kits' }, ctx);
  assert.equal(fetch.calls[1].query.search, 'Tools', 'WordPress stores & as &amp;, so the search leaves it out');
  assert.equal(fetch.calls[1].query.parent, '0');
  assert.equal(top.payload.id, 31);
  assert.equal(top.payload.existing, true);

  const child = await callTool(module, 'create_term', { taxonomy: 'categories', name: 'tools  &  kits', parent: 12 }, ctx);
  assert.equal(fetch.calls[3].query.parent, '12');
  assert.equal(child.payload.id, 30);

  const tags = setup((request) => (request.method === 'POST'
    ? jsonResponse(400, fixture(import.meta.url, 'term-exists.json'))
    : jsonResponse(200, [{ id: 44, name: 'cold brew', slug: 'cold-brew', count: 3 }], listHeaders(1, 1))));
  const tag = await callTool(tags.module, 'create_term', { taxonomy: 'tags', name: 'Cold Brew' }, tags.ctx);
  assert.equal(tags.fetch.calls[1].query.parent, undefined, 'tags have no parent');
  assert.equal(tag.payload.id, 44);

  const elsewhere = setup((request) => (request.method === 'POST'
    ? jsonResponse(400, fixture(import.meta.url, 'term-exists.json'))
    : jsonResponse(200, [siblings[0]], listHeaders(1, 1))));
  const notFound = await callTool(elsewhere.module, 'create_term', { taxonomy: 'categories', name: 'Tools & Kits' }, elsewhere.ctx);
  assert.equal(notFound.isError, true, 'a same-named category under another parent is not the one WordPress meant');
  assert.match(notFound.payload.error, /already exists, but it was not found by name/);
});

test('log lines carry no credentials and no arguments', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(201, fixture(import.meta.url, 'post-created.json')));
  await callTool(module, 'create_post', { title: 'Secret plans for Tuesday', content: '<p>hidden</p>' }, ctx);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.doesNotMatch(line, /abcd|EFGH|agent-editor|Secret plans|hidden|Basic/);
    assert.match(line, /^wordpress create_post POST 201 \d+ms$/);
  }
});
