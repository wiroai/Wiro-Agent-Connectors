import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'AbCdEfGhJkLmNpQrStUvWxYz';
const credentials = { api_key: KEY };
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
