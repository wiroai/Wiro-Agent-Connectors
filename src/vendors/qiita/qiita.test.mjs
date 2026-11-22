import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef01234567';
const ITEM = 'c686397e4a0f4f11683d';
const RATE = { 'rate-limit': '1000', 'rate-remaining': '987', 'rate-reset': '1795400000' };

function setup(handler, credentials = { token: TOKEN }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

const answer = (name, status = 200, headers = RATE) => () => jsonResponse(status, fixture(import.meta.url, name), headers);

test('get_my_account sends the Bearer token and reports the hourly allowance left', async () => {
  const { module, fetch, ctx } = setup(answer('authenticated-user.json'), { token: `Bearer ${TOKEN}` });
  const { payload, isError } = await callTool(module, 'get_my_account', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://qiita.com/api/v2/authenticated_user');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    id: 'alice_example',
    name: 'Alice Example',
    articles: 27,
    followers: 340,
    following: 12,
    team_only: false,
    image_uploads_left_bytes: 99614720,
    image_upload_limit_bytes: 104857600,
    rate_limit: { remaining: 987, resets_at: '2026-11-23T02:13:20.000Z' },
  });
});

test('list_my_articles lists the account\'s articles newest first, limited share included, and pages', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'items.json'), { ...RATE, 'total-count': '27' }));
  const first = await callTool(module, 'list_my_articles', { per_page: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].url, 'https://qiita.com/api/v2/authenticated_user/items?page=1&per_page=2');
  assert.equal(first.payload.total_count, 27);
  assert.deepEqual(first.payload.articles[0], {
    id: ITEM,
    title: 'Python 3.12でpandasのCSV読み込みを速くする',
    url: 'https://qiita.com/alice_example/private/c686397e4a0f4f11683d',
    status: 'limited_share',
    author: 'alice_example',
    created_at: '2026-11-20T10:00:00+09:00',
    updated_at: '2026-11-20T10:00:00+09:00',
    likes: 0,
    stocks: 0,
    comments: 0,
    tags: [{ name: 'Python', versions: ['3.12'] }, { name: 'pandas', versions: [] }],
    body_length: 11,
  });
  assert.equal(first.payload.articles[1].status, 'public');
  assert.equal(first.payload.articles[1].organization, 'acme');
  assert.equal('rendered_body' in first.payload.articles[0], false);

  await callTool(module, 'list_my_articles', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, 'https://qiita.com/api/v2/authenticated_user/items?page=2&per_page=2');
});

test('sort ranks every article of the account, reading 100 per request', async () => {
  const article = (index) => ({ id: index.toString(16).padStart(20, '0'), title: `Article ${index}`, private: false, likes_count: index % 7, stocks_count: index, comments_count: 0, tags: [], user: { id: 'alice_example' } });
  const pages = [Array.from({ length: 100 }, (_, index) => article(index)), Array.from({ length: 30 }, (_, index) => article(100 + index))];
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, pages[Number(request.query.page) - 1] ?? [], { ...RATE, 'total-count': '130' }));
  const first = await callTool(module, 'list_my_articles', { sort: 'stocks', per_page: 3 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.deepEqual(fetch.calls.map((call) => call.query.page), ['1', '2']);
  assert.ok(fetch.calls.every((call) => call.query.per_page === '100'));
  assert.equal(first.payload.sorted_by, 'stocks');
  assert.equal(first.payload.ranked, 130);
  assert.deepEqual(first.payload.articles.map((item) => item.stocks), [129, 128, 127]);

  const second = await callTool(module, 'list_my_articles', { sort: 'stocks', cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(second.payload.articles.map((item) => item.stocks), [126, 125, 124]);
});

test('get_article takes a link, gives page views, and returns the body in windows when asked', async () => {
  const { module, fetch, ctx } = setup(answer('item.json'));
  const { payload } = await callTool(module, 'get_article', { item_id: `https://qiita.com/alice_example/private/${ITEM}` }, ctx);
  assert.equal(fetch.calls[0].url, `https://qiita.com/api/v2/items/${ITEM}`);
  assert.equal(payload.page_views, 57);
  assert.equal(payload.body, undefined);

  const withBody = await callTool(module, 'get_article', { item_id: ITEM, include_body: true }, ctx);
  assert.equal(withBody.payload.body, fixture(import.meta.url, 'item.json').body);

  const long = setup(() => jsonResponse(200, { ...fixture(import.meta.url, 'item.json'), body: Array.from({ length: 2000 }, (_, i) => `行 ${i}: 日本語のテキスト "quoted"`).join('\n') }));
  let joined = '';
  let cursor;
  let steps = 0;
  do {
    const step = await callTool(long.module, 'get_article', { item_id: ITEM, include_body: true, ...(cursor ? { cursor } : {}) }, long.ctx);
    assert.ok(textBytes(step.result) <= 32 * 1024);
    joined += step.payload.body;
    cursor = step.payload.nextCursor;
    steps += 1;
  } while (cursor && steps < 20);
  assert.ok(steps > 1);
  assert.equal(joined.length, Array.from({ length: 2000 }, (_, i) => `行 ${i}: 日本語のテキスト "quoted"`).join('\n').length);

  const bad = await callTool(module, 'get_article', { item_id: 'https://qiita.com/alice_example/items/not-an-id-at-all' }, ctx);
  assert.match(bad.payload.error, /item_id is not a Qiita article ID/);
  assert.equal(fetch.calls.length, 2);
});

test('search_articles sends Qiita\'s search terms and names each author', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'search.json'), { ...RATE, 'total-count': '1' }));
  const { payload } = await callTool(module, 'search_articles', { query: 'tag:Python title:pandas stocks:>50' }, ctx);
  assert.equal(fetch.calls[0].path, '/api/v2/items');
  assert.equal(fetch.calls[0].query.query, 'tag:Python title:pandas stocks:>50');
  assert.equal(payload.articles[0].author, 'bob_example');
  assert.equal(payload.articles[0].likes, 310);
  assert.equal('status' in payload.articles[0], false);
  assert.equal(payload.nextCursor, undefined);
});

test('get_tag encodes names such as C#, and list_tags lists the most used', async () => {
  const { module, fetch, ctx } = setup(answer('tag.json'));
  const { payload } = await callTool(module, 'get_tag', { name: 'C#' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://qiita.com/api/v2/tags/C%23');
  assert.deepEqual(payload, { name: 'Python', articles: 150000, followers: 210000, icon_url: 'https://images.example.com/tags/python.png' });

  const list = setup(answer('tags.json'));
  const tags = await callTool(list.module, 'list_tags', { per_page: 2 }, list.ctx);
  assert.equal(list.fetch.calls[0].url, 'https://qiita.com/api/v2/tags?page=1&per_page=2&sort=count');
  assert.deepEqual(tags.payload.tags, [{ name: 'Python', articles: 150000, followers: 210000 }, { name: 'JavaScript', articles: 120000, followers: 180000 }]);
  assert.ok(tags.payload.nextCursor);
});

test('create_article saves a limited-share article by default, and nothing that only public articles take', async () => {
  const { module, fetch, ctx } = setup(answer('created.json', 201));
  const args = { title: 'Python 3.12でpandasのCSV読み込みを速くする', body: '## はじめに\n\n本文', tags: [{ name: 'Python', versions: ['3.12'] }] };
  const { payload, isError } = await callTool(module, 'create_article', args, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://qiita.com/api/v2/items');
  assert.deepEqual(fetch.calls[0].json, { title: args.title, body: args.body, tags: [{ name: 'Python', versions: ['3.12'] }], private: true });
  assert.equal(payload.status, 'limited_share');
  assert.match(payload.note, /limited-share article/);

  const refused = await callTool(module, 'create_article', { ...args, organization_url_name: 'acme' }, ctx);
  assert.match(refused.payload.error, /A limited-share article cannot be linked to an Organization or posted on X/);
  const noTweet = await callTool(module, 'create_article', { ...args, tweet: true }, ctx);
  assert.match(noTweet.payload.error, /posted on X/);
  assert.equal(fetch.calls.length, 1);

  const tooMany = await callTool(module, 'create_article', { ...args, tags: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}` })) }, ctx);
  assert.match(tooMany.payload.error, /`tags` must have at most 5 items/);
});

test('create_article with public: true may link an Organization and post on X', async () => {
  const { module, fetch, ctx } = setup(answer('public.json', 201));
  const { payload } = await callTool(module, 'create_article', { title: 'T', body: 'B', tags: [{ name: 'Python' }], public: true, organization_url_name: 'acme', tweet: true }, ctx);
  assert.deepEqual(fetch.calls[0].json, { title: 'T', body: 'B', tags: [{ name: 'Python', versions: [] }], private: false, organization_url_name: 'acme', tweet: true });
  assert.equal(payload.status, 'public');
  assert.match(payload.note, /cannot turn it back/);
});

function readThenWrite(written) {
  return (request) => (request.method === 'GET'
    ? jsonResponse(200, fixture(import.meta.url, 'item.json'), RATE)
    : jsonResponse(200, fixture(import.meta.url, written), RATE));
}

test('update_article reads the article, keeps what is not given and never sends private', async () => {
  const { module, fetch, ctx } = setup(readThenWrite('item.json'));
  const { payload, isError } = await callTool(module, 'update_article', { item_id: ITEM, title: '新しいタイトル' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'PATCH']);
  assert.equal(fetch.calls[1].url, `https://qiita.com/api/v2/items/${ITEM}`);
  const current = fixture(import.meta.url, 'item.json');
  assert.deepEqual(fetch.calls[1].json, { title: '新しいタイトル', body: current.body, tags: [{ name: 'Python', versions: ['3.12'] }, { name: 'pandas', versions: [] }] });
  assert.equal('private' in fetch.calls[1].json, false);
  assert.equal(payload.updated, true);

  const nothing = await callTool(module, 'update_article', { item_id: ITEM }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  const org = await callTool(module, 'update_article', { item_id: ITEM, organization_url_name: 'acme' }, ctx);
  assert.match(org.payload.error, /A limited-share article cannot be linked to an Organization/);
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'PATCH', 'GET'], 'refused after the read, before any write');
});

test('make_article_public sends the article back with private: false, and does nothing for a public one', async () => {
  const { module, fetch, ctx } = setup(readThenWrite('public.json'));
  const { payload } = await callTool(module, 'make_article_public', { item_id: ITEM, organization_url_name: 'acme' }, ctx);
  const current = fixture(import.meta.url, 'item.json');
  assert.deepEqual(fetch.calls[1].json, { title: current.title, body: current.body, tags: [{ name: 'Python', versions: ['3.12'] }, { name: 'pandas', versions: [] }], private: false, organization_url_name: 'acme' });
  assert.equal(payload.status, 'public');
  assert.match(payload.note, /edit history/);

  const already = setup(answer('public.json'));
  const same = await callTool(already.module, 'make_article_public', { item_id: ITEM }, already.ctx);
  assert.equal(same.payload.already_public, true);
  assert.deepEqual(already.fetch.calls.map((call) => call.method), ['GET']);
});

test('delete_article sends one DELETE', async () => {
  const { module, fetch, ctx } = setup(() => new Response(null, { status: 204, headers: RATE }));
  const { payload } = await callTool(module, 'delete_article', { item_id: ITEM }, ctx);
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].url, `https://qiita.com/api/v2/items/${ITEM}`);
  assert.deepEqual(payload, { deleted: true, id: ITEM, rate_limit: { remaining: 987, resets_at: '2026-11-23T02:13:20.000Z' } });
});

test('writes without a clear answer are unknown, and the write is sent once', async () => {
  const fail = () => jsonResponse(502, { message: 'Bad gateway', type: 'bad_gateway' });
  const cases = [
    ['create_article', { title: 'T', body: 'B', tags: [{ name: 'Python' }] }, fail, 'list_my_articles', 1],
    ['update_article', { item_id: ITEM, title: 'x' }, (request) => (request.method === 'GET' ? answer('item.json')() : fail()), 'get_article', 2],
    ['make_article_public', { item_id: ITEM }, (request) => (request.method === 'GET' ? answer('item.json')() : fail()), 'get_article', 2],
    ['delete_article', { item_id: ITEM }, fail, 'get_article', 1],
  ];
  for (const [tool, args, handler, check, requests] of cases) {
    const { module, fetch, ctx } = setup(handler);
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
    assert.equal(payload.check, check);
    assert.equal(fetch.calls.length, requests);
  }
});

test('Qiita\'s errors: a bad token, a missing scope, a missing article and the hourly limit', async () => {
  const denied = setup(answer('error-401.json', 401));
  assert.match((await callTool(denied.module, 'get_my_account', {}, denied.ctx)).payload.error, /Qiita rejected the credentials \(HTTP 401\): Unauthorized\. Check that the Qiita access token is correct/);
  const scope = setup(answer('error-403.json', 403));
  assert.match((await callTool(scope.module, 'delete_article', { item_id: ITEM }, scope.ctx)).payload.error, /the token may lack the write_qiita scope/);
  const gone = setup(answer('error-404.json', 404));
  assert.match((await callTool(gone.module, 'get_article', { item_id: ITEM }, gone.ctx)).payload.error, /Qiita found no article with that ID/);
  const limited = setup(answer('error-429.json', 429, { 'retry-after': '600' }));
  const rate = await callTool(limited.module, 'list_my_articles', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 600);
  assert.match(rate.payload.error, /Qiita rate limit reached \(HTTP 429\)/);
});

test('api_get passes Qiita\'s paging and rate headers back', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, [{ id: 'cmt1', body: 'Nice' }], { ...RATE, 'total-count': '1', link: '<https://qiita.com/api/v2/items/x/comments?page=1>; rel="first"' }));
  const { payload } = await callTool(module, 'api_get', { path: `/api/v2/items/${ITEM}/comments` }, ctx);
  assert.equal(fetch.calls[0].url, `https://qiita.com/api/v2/items/${ITEM}/comments`);
  assert.deepEqual(payload.headers, { link: '<https://qiita.com/api/v2/items/x/comments?page=1>; rel="first"', 'total-count': '1', 'rate-remaining': '987', 'rate-reset': '1795400000' });
  const outside = await callTool(module, 'api_get', { path: '/alice_example' }, ctx);
  assert.match(outside.payload.error, /must start with \/api\/v2\//);
  assert.equal(fetch.calls.length, 1);
});

test('logs carry neither the token nor the article', async () => {
  const { module, ctx, logs } = setup(answer('created.json', 201));
  await callTool(module, 'create_article', { title: '秘密のタイトル', body: 'secret body text', tags: [{ name: 'Python' }] }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['qiita create_article POST 201 Nms']);
  for (const secret of [TOKEN, '秘密のタイトル', 'secret body text']) assert.equal(logs.join('\n').includes(secret), false);
});
