import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'AbCdEfGhJkLmNpQrStUvWxYz';
const credentials = { apikey: KEY };
const list = fixture(import.meta.url, 'list.json');
const created = fixture(import.meta.url, 'create.json');
const updated = fixture(import.meta.url, 'update.json');

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

const DRAFT = {
  title: 'How we cut CI time in half',
  body_markdown: '## Why\n\nBecause.',
  tags: ['devops', 'ci'],
  description: 'A short summary',
  canonical_url: 'https://blog.example.com/ci',
  cover_image_url: 'https://images.example.com/cover.png',
  series: 'CI notes',
  ai_disclosure_level: 'fully_autonomous',
};

test('list_my_articles reads the account articles with the api-key header and trims them', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, list));
  const { payload, isError } = await callTool(module, 'list_my_articles', {}, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://dev.to/api/articles/me/all?page=1&per_page=30');
  assert.equal(request.headers['api-key'], KEY);
  assert.equal(request.headers.accept, 'application/vnd.forem.api-v1+json');
  assert.ok(request.headers['user-agent'], 'dev.to refuses an empty User-Agent');

  assert.equal(payload.status, 'all');
  assert.deepEqual(payload.articles[0], {
    id: 101,
    title: 'Draft | one',
    published: false,
    url: 'https://dev.to/alice/draft-one-temp-slug-123',
    edit_url: 'https://dev.to/alice/draft-one-temp-slug-123/edit',
    tags: ['ai', 'webdev'],
    description: 'd',
    page_views_count: 0,
    public_reactions_count: 0,
    comments_count: 0,
    reading_time_minutes: 1,
    canonical_url: 'https://dev.to/alice/draft-one-temp-slug-123',
  });
  assert.equal(payload.articles[1].organization, 'acme');
  assert.equal(payload.articles[1].page_views_count, 456);
  assert.equal(payload.articles[1].edit_url, 'https://dev.to/alice/published-one-abc/edit');
  assert.equal('body_markdown' in payload.articles[0], false, 'the body is not listed');
  assert.equal('user' in payload.articles[0], false);
  assert.equal(payload.nextCursor, undefined, '3 articles on a page of 30: no more');
});

test('status picks the endpoint, and a full page gives a cursor to the next one', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, list.slice(0, 2)));
  const first = await callTool(module, 'list_my_articles', { status: 'unpublished', per_page: 2 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/articles/me/unpublished?page=1&per_page=2');
  await callTool(module, 'list_my_articles', { status: 'unpublished', cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, 'https://dev.to/api/articles/me/unpublished?page=2&per_page=2');
  // The cursor keeps the list it came from: passed back alone, it still pages the drafts.
  const alone = await callTool(module, 'list_my_articles', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[2].url, 'https://dev.to/api/articles/me/unpublished?page=2&per_page=2');
  assert.equal(alone.payload.status, 'unpublished');
});

test('a page over 32 KB is cut and continues after the last article returned', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    id: 1000 + index,
    title: `Article ${index} `.padEnd(280, 'x'),
    description: 'd'.repeat(290),
    published: true,
    published_at: '2026-11-01T10:00:00.000Z',
    url: `https://dev.to/alice/article-${index}`,
    tag_list: ['a', 'b', 'c', 'd'],
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, many));
  const first = await callTool(module, 'list_my_articles', { per_page: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.articles.length;
  assert.ok(shown > 0 && shown < 100);
  const second = await callTool(module, 'list_my_articles', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, 'https://dev.to/api/articles/me/all?page=1&per_page=100');
  assert.equal(second.payload.articles[0].id, 1000 + shown);
});

test('create_draft_article posts an unpublished article and returns its links', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, created));
  const { payload, isError } = await callTool(module, 'create_draft_article', DRAFT, ctx);
  assert.equal(isError, false);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://dev.to/api/articles');
  assert.equal(request.headers['api-key'], KEY);
  assert.deepEqual(request.json, {
    article: {
      title: DRAFT.title,
      body_markdown: DRAFT.body_markdown,
      tags: ['devops', 'ci'],
      description: 'A short summary',
      canonical_url: 'https://blog.example.com/ci',
      main_image: 'https://images.example.com/cover.png',
      series: 'CI notes',
      ai_disclosure_level: 'fully_autonomous',
      published: false,
    },
  });
  assert.equal(payload.id, 2211234);
  assert.equal(payload.published, false);
  assert.equal(payload.url, 'https://dev.to/alice/how-we-cut-ci-time-in-half-temp-slug-4417810');
  assert.equal(payload.edit_url, 'https://dev.to/alice/how-we-cut-ci-time-in-half-temp-slug-4417810/edit');
  assert.equal(payload.ai_disclosure_level, 'fully_autonomous');
  assert.equal('body_markdown' in payload, false);
  assert.equal('body_html' in payload, false);
});

test('an organization dev.to dropped is reported as a warning', async () => {
  const { module, ctx } = setup(() => jsonResponse(201, created));
  const { payload } = await callTool(module, 'create_draft_article', { ...DRAFT, organization_id: 77 }, ctx);
  assert.match(payload.warnings[0], /not organization 77/);
});

test('front matter and a missing AI disclosure are refused before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, created));
  const front = await callTool(module, 'create_draft_article', { ...DRAFT, body_markdown: '---\ntitle: x\npublished: true\n---\nBody' }, ctx);
  assert.equal(front.isError, true);
  assert.match(front.payload.error, /front matter/);
  const { ai_disclosure_level: _omitted, ...withoutDisclosure } = DRAFT;
  const missing = await callTool(module, 'create_draft_article', withoutDisclosure, ctx);
  assert.match(missing.payload.error, /`ai_disclosure_level` is required/);
  const badTag = await callTool(module, 'create_draft_article', { ...DRAFT, tags: ['dev-ops'] }, ctx);
  assert.match(badTag.payload.error, /`tags\[0\]` does not have the expected format/);
  const tooMany = await callTool(module, 'create_draft_article', { ...DRAFT, tags: ['a', 'b', 'c', 'd', 'e'] }, ctx);
  assert.match(tooMany.payload.error, /`tags` must have at most 4 items/);
  assert.equal(fetch.calls.length, 0);
});

test('a reused title keeps dev.to\'s words and points at the drafts', async () => {
  const { module, ctx } = setup(() => jsonResponse(422, fixture(import.meta.url, 'error-422.json')));
  const { payload, isError } = await callTool(module, 'create_draft_article', DRAFT, ctx);
  assert.equal(isError, true);
  assert.equal(payload.status, 422);
  assert.match(payload.error, /dev\.to did not accept the article \(HTTP 422\)\. dev\.to said: "Title has already been used in the last five minutes"\. Nothing was changed\./);
  assert.match(payload.error, /check list_my_articles \(status unpublished\)/);
});

test('dev.to\'s 429 is passed back with retryAfter, and a bad key with a clear 401', async () => {
  const limited = setup(() => textResponse(429, 'Retry later\n', { 'retry-after': '3' }));
  const rate = await callTool(limited.module, 'create_draft_article', DRAFT, limited.ctx);
  assert.equal(rate.payload.retryAfter, 3);
  assert.match(rate.payload.error, /dev\.to rate limit reached \(HTTP 429\)\. Nothing was changed\. Retry after 3 seconds\./);

  const denied = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const auth = await callTool(denied.module, 'list_my_articles', {}, denied.ctx);
  assert.match(auth.payload.error, /dev\.to rejected the credentials \(HTTP 401\): unauthorized\. Check that the dev\.to API key is correct/);
});

test('update_article publishes with PUT and only the fields given', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, updated));
  const { payload, isError } = await callTool(module, 'update_article', { id: 2211234, published: true }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/articles/2211234');
  assert.deepEqual(fetch.calls[0].json, { article: { published: true } });
  assert.equal(payload.published, true);
  assert.equal(payload.url, 'https://dev.to/acme/how-we-cut-ci-time-in-half-3k2p');
  assert.equal(payload.organization, 'acme');
  assert.match(payload.warnings[0], /ai_disclosure_level=not_disclosed/);
});

test('update_article needs something to change, and reports a missing article', async () => {
  const empty = setup(() => jsonResponse(200, updated));
  const nothing = await callTool(empty.module, 'update_article', { id: 5 }, empty.ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(empty.fetch.calls.length, 0);

  const gone = setup(() => jsonResponse(404, { error: 'not found', status: 404 }));
  const missing = await callTool(gone.module, 'update_article', { id: 5, title: 'New' }, gone.ctx);
  assert.match(missing.payload.error, /found no article with that id that this API key may edit \(HTTP 404\)/);
});

test('a write without a clear answer is reported as unknown, once, with the read tool to check', async () => {
  const outcomes = [
    () => {
      throw new TypeError('fetch failed');
    },
    () => {
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    },
    () => jsonResponse(502, { error: 'Bad gateway' }),
  ];
  for (const respond of outcomes) {
    for (const [tool, args] of [['create_draft_article', DRAFT], ['update_article', { id: 1, published: true }]]) {
      const { module, fetch, ctx } = setup(respond);
      const { payload, isError } = await callTool(module, tool, args, ctx);
      assert.equal(isError, true);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, 'list_my_articles');
      assert.match(payload.error, /Call list_my_articles to see whether it was, before trying again\./);
      assert.equal(fetch.calls.length, 1, 'never retried');
    }
  }
});

test('a read failure is a plain error, and a refused URL says nothing was sent', async () => {
  const down = setup(() => jsonResponse(502, { error: 'Bad gateway' }));
  const read = await callTool(down.module, 'list_my_articles', {}, down.ctx);
  assert.equal(read.payload.outcome, undefined);
  assert.match(read.payload.error, /dev\.to had a server error \(HTTP 502\): Bad gateway\. Try again later\./);

  const blocked = setup(() => {
    throw refusal('dev.to is not allowed here');
  });
  const write = await callTool(blocked.module, 'create_draft_article', DRAFT, blocked.ctx);
  assert.equal(write.payload.outcome, undefined);
  assert.match(write.payload.error, /blocked before it was sent/);
  assert.match(write.payload.error, /Nothing was changed\./);
});

test('logs never carry the key or the article', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(201, created));
  await callTool(module, 'create_draft_article', DRAFT, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['devto create_draft_article POST 201 Nms']);
  assert.equal(logs.join('\n').includes(KEY), false);
});

test('api_get reaches the rest of the Forem API with the key, under /api/ only', async () => {
  const followers = [{ type_of: 'user_follower', id: 7, name: 'Bob', username: 'bob' }];
  const { module, fetch, ctx } = setup(() => jsonResponse(200, followers));
  const { payload, isError } = await callTool(module, 'api_get', { path: '/api/followers/users', query: { page: 2, per_page: 10 } }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(payload, { status: 200, data: followers });
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://dev.to/api/followers/users?page=2&per_page=10');
  assert.equal(request.headers['api-key'], KEY);
  assert.equal(request.headers.accept, 'application/vnd.forem.api-v1+json');

  const site = await callTool(module, 'api_get', { path: '/alice/some-post' }, ctx);
  assert.equal(site.payload.error, 'The path must start with /api/. Nothing was sent.');
  assert.equal(fetch.calls.length, 1);
});

test('api_request sends POST, PUT or DELETE once, and an unclear outcome is unknown', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { result: 'create', category: 'like', id: 99 }));
  const { payload } = await callTool(module, 'api_request', { method: 'POST', path: '/api/reactions/toggle', query: { category: 'like', reactable_id: 2211234, reactable_type: 'Article' } }, ctx);
  assert.deepEqual(payload, { status: 200, data: { result: 'create', category: 'like', id: 99 } });
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/reactions/toggle?category=like&reactable_id=2211234&reactable_type=Article');
  assert.equal(fetch.calls[0].headers['api-key'], KEY);

  const patch = await callTool(module, 'api_request', { method: 'PATCH', path: '/api/articles/1', json: {} }, ctx);
  assert.match(patch.payload.error, /`method` must be one of "POST", "PUT", "DELETE"/);
  assert.equal(fetch.calls.length, 1);

  const down = setup(() => jsonResponse(502, { error: 'Bad gateway' }));
  const unknown = await callTool(down.module, 'api_request', { method: 'PUT', path: '/api/articles/5', json: { article: { title: 'New' } } }, down.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(down.fetch.calls.length, 1);
});

test('the connection needs the apikey credential, and says so before sending anything', async () => {
  const { module } = loadModuleFor(import.meta.url);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.accountPickers), []);
  const fetch = fakeFetch(() => jsonResponse(200, []));
  const { ctx } = makeContext({ credentials: {}, fetch });
  const { payload, isError } = await callTool(module, 'list_my_articles', {}, ctx);
  assert.equal(isError, true);
  assert.equal(payload.error, 'dev.to is not connected: the dev.to API key is missing.');
  assert.equal(fetch.calls.length, 0);
});

test('get_article returns a published article with its Markdown body', async () => {
  const article = fixture(import.meta.url, 'article.json');
  const { module, fetch, ctx } = setup(() => jsonResponse(200, article));
  const { payload, isError } = await callTool(module, 'get_article', { id: 100 }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/articles/100');
  assert.equal(fetch.calls[0].headers['api-key'], KEY);
  assert.equal(payload.id, 100);
  assert.equal(payload.published, true);
  assert.equal(payload.author, 'alice');
  assert.equal(payload.edit_url, 'https://dev.to/alice/published-one-abc/edit');
  assert.equal(payload.ai_disclosure_level, 'some_ai');
  assert.equal(payload.body_markdown, '## Why\n\nBecause.');
  assert.deepEqual(payload.body_part, { start: 0, end: 16, length: 16 });
  assert.equal(payload.nextCursor, undefined);
  assert.equal('body_html' in payload, false);
});

test('get_article finds a draft among the account\'s unpublished articles when dev.to has no published one', async () => {
  const drafts = Array.from({ length: 100 }, (_, index) => ({ id: 500 + index, title: `Draft ${index}`, published: false, body_markdown: `Body ${index}` }));
  const { module, fetch, ctx } = setup((request) => {
    if (request.path === '/api/articles/777') return jsonResponse(404, { error: 'not found', status: 404 });
    if (request.query.page === '1') return jsonResponse(200, drafts);
    return jsonResponse(200, [{ id: 777, title: 'The draft', published: false, url: 'https://dev.to/alice/the-draft-temp-slug-1', body_markdown: 'Draft body' }]);
  });
  const { payload, isError } = await callTool(module, 'get_article', { id: 777 }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => call.url), [
    'https://dev.to/api/articles/777',
    'https://dev.to/api/articles/me/unpublished?page=1&per_page=100',
    'https://dev.to/api/articles/me/unpublished?page=2&per_page=100',
  ]);
  assert.equal(payload.published, false);
  assert.equal(payload.body_markdown, 'Draft body');

  const none = setup((request) => (request.path === '/api/articles/9' ? jsonResponse(404, { error: 'not found', status: 404 }) : jsonResponse(200, [])));
  const missing = await callTool(none.module, 'get_article', { id: 9 }, none.ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.payload.error, /dev\.to has no published article 9, and it is not among the account's drafts/);
});

test('a long body comes in parts under 32 KB, and the cursor continues where the part ended', async () => {
  const body = Array.from({ length: 3000 }, (_, index) => `Line ${index} with "quotes" and a tab\tin it`).join('\n');
  const article = { ...fixture(import.meta.url, 'article.json'), body_markdown: body };
  const { module, ctx } = setup(() => jsonResponse(200, article));
  let cursor;
  let text = '';
  let parts = 0;
  do {
    const { result, payload, isError } = await callTool(module, 'get_article', { id: 100, ...(cursor ? { cursor } : {}) }, ctx);
    assert.equal(isError, false, payload.error);
    assert.ok(textBytes(result) <= 32 * 1024);
    assert.equal(payload.body_part.start, text.length);
    text += payload.body_markdown;
    cursor = payload.nextCursor;
    parts++;
  } while (cursor && parts < 20);
  assert.ok(parts > 1, 'the body needed more than one part');
  assert.equal(text, body);

  const other = await callTool(module, 'get_article', { id: 101, cursor: (await callTool(module, 'get_article', { id: 100 }, ctx)).payload.nextCursor }, ctx);
  assert.match(other.payload.error, /The cursor belongs to another article/);
});

test('get_analytics adds up the days of a range and lists them in date order', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'analytics-historical.json')));
  const { payload, isError } = await callTool(module, 'get_analytics', { start: '2026-11-18', end: '2026-11-19', article_id: 100 }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/analytics/historical?start=2026-11-18&end=2026-11-19&article_id=100');
  assert.deepEqual(payload.scope, { article_id: 100 });
  assert.deepEqual(payload.range, { start: '2026-11-18', end: '2026-11-19' });
  assert.deepEqual(payload.totals, { page_views: 160, reactions: 5, comments: 1, follows: 2, average_read_time_seconds: 86 });
  assert.deepEqual(payload.days, [
    { date: '2026-11-18', page_views: 40, reactions: 1, comments: 0, follows: 2, average_read_time_seconds: 60 },
    { date: '2026-11-19', page_views: 120, reactions: 4, comments: 1, follows: 0, average_read_time_seconds: 95 },
  ]);
});

test('get_analytics without start reads the lifetime totals; a range needs its start; 404 says analytics are not available', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'analytics-totals.json')));
  const { payload } = await callTool(module, 'get_analytics', { organization_id: 7 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://dev.to/api/analytics/totals?organization_id=7');
  assert.deepEqual(payload, {
    scope: { organization_id: 7 },
    period: 'lifetime',
    totals: { page_views: 900, reactions: 20, comments: 4, follows: 2, average_read_time_seconds: 80 },
  });

  const noStart = await callTool(module, 'get_analytics', { end: '2026-11-19' }, ctx);
  assert.match(noStart.payload.error, /end needs start/);
  const both = await callTool(module, 'get_analytics', { start: '2026-11-01', article_id: 1, organization_id: 2 }, ctx);
  assert.match(both.payload.error, /article_id or organization_id, not both/);
  const badDate = await callTool(module, 'get_analytics', { start: '1 Nov 2026' }, ctx);
  assert.match(badDate.payload.error, /`start` does not have the expected format/);
  assert.equal(fetch.calls.length, 1);

  const unavailable = setup(() => jsonResponse(404, { error: 'not found', status: 404 }));
  const missing = await callTool(unavailable.module, 'get_analytics', { start: '2026-11-01' }, unavailable.ctx);
  assert.match(missing.payload.error, /dev\.to's analytics are not available here/);
  assert.equal(missing.payload.status, 404);
});

test('a long range is cut under 32 KB and the cursor carries the range to the next page', async () => {
  const days = {};
  for (let day = 0; day < 400; day++) {
    const date = new Date(Date.UTC(2025, 0, 1) + day * 86400000).toISOString().slice(0, 10);
    days[date] = { comments: { total: day % 3 }, follows: { total: 0 }, reactions: { total: 1 }, page_views: { total: 10, average_read_time_in_seconds: 30, total_read_time_in_seconds: 300 } };
  }
  const { module, fetch, ctx } = setup(() => jsonResponse(200, days));
  const first = await callTool(module, 'get_analytics', { start: '2025-01-01', end: '2026-02-04' }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  assert.equal(first.payload.days_count, 400);
  assert.equal(first.payload.totals.page_views, 4000);
  const shown = first.payload.days.length;
  const second = await callTool(module, 'get_analytics', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, 'https://dev.to/api/analytics/historical?start=2025-01-01&end=2026-02-04');
  assert.equal(second.payload.days[0].date, new Date(Date.UTC(2025, 0, 1) + shown * 86400000).toISOString().slice(0, 10));
});
