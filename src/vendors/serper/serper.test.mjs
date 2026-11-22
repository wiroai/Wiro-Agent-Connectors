import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'serper-test-key-0123456789';
const credentials = { api_key: KEY };
const search = fixture(import.meta.url, 'search.json');

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

test('web_search posts the query to Serper with the key header and returns trimmed results', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const { payload, isError } = await callTool(module, 'web_search', { q: 'model context protocol', num: 3, gl: 'us', hl: 'en', tbs: 'qdr:w' }, ctx);

  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  const [request] = fetch.calls;
  assert.equal(request.url, 'https://google.serper.dev/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], KEY);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.json, { q: 'model context protocol', num: 3, page: 1, gl: 'us', hl: 'en', tbs: 'qdr:w' });

  assert.equal(payload.query, 'model context protocol');
  assert.deepEqual(payload.results[0], {
    position: 1,
    title: 'Introduction - Model Context Protocol',
    link: 'https://modelcontextprotocol.io/introduction',
    snippet: 'MCP is an open protocol that standardizes how applications provide context to LLMs.',
  });
  assert.equal(payload.results[1].date, 'Jun 18, 2025');
  assert.equal(payload.results.length, 3);
  assert.equal(payload.answerBox.title, 'What is the Model Context Protocol?');
  assert.equal(payload.knowledgeGraph.attributes.License, 'MIT');
  assert.equal(payload.peopleAlsoAsk[0].question, 'What is MCP used for?');
  assert.deepEqual(payload.relatedSearches, ['model context protocol server', 'mcp specification']);
  // Fields an agent does not need are left out.
  assert.equal('sitelinks' in payload.results[0], false);
  assert.equal('credits' in payload, false);
  // A full page means there may be more: the cursor asks for page 2.
  assert.equal(typeof payload.nextCursor, 'string');
});

test('the cursor fetches the next page, without the first page extras', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const first = await callTool(module, 'web_search', { q: 'model context protocol', num: 3 }, ctx);
  const second = await callTool(module, 'web_search', { q: 'model context protocol', num: 3, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 2);
  assert.equal(second.payload.page, 2);
  assert.equal(second.payload.answerBox, undefined);
  assert.equal(second.payload.relatedSearches, undefined);
});

test('a short page has no cursor', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, { organic: search.organic.slice(0, 1) }));
  const { payload } = await callTool(module, 'web_search', { q: 'x' }, ctx);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.nextCursor, undefined);
});

test('a result over 32 KB is cut, and the cursor continues on the same page after the last result returned', async () => {
  const organic = Array.from({ length: 20 }, (_, index) => ({
    position: index + 1,
    title: `Result ${index + 1} `.padEnd(300, 't'),
    link: `https://example.com/${index + 1}/`.padEnd(1900, 'l'),
    snippet: 's'.repeat(600),
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { organic }));
  const first = await callTool(module, 'web_search', { q: 'long', num: 20 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024, `result is ${textBytes(first.result)} bytes`);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.results.length;
  assert.ok(shown > 0 && shown < 20);

  const second = await callTool(module, 'web_search', { q: 'long', num: 20, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 1, 'same Serper page');
  assert.equal(second.payload.results[0].position, shown + 1);
});

test('Serper errors become clear tool errors; a 429 carries retryAfter', async () => {
  const cases = [
    [() => jsonResponse(401, { message: 'Unauthorized.' }), 401, /Serper rejected the credentials \(HTTP 401\): Unauthorized\. Check that the Serper API key/],
    [() => jsonResponse(403, { message: 'Not enough credits' }), 403, /Serper refused the API key: it may be wrong, disabled, or out of credits \(HTTP 403\)\. Serper said: "Not enough credits"/],
    [() => jsonResponse(400, { message: 'Query is required' }), 400, /could not run this search/],
    [() => textResponse(429, 'Too many requests', { 'retry-after': '30' }), 429, /Serper rate limit reached \(HTTP 429\)\. Retry after 30 seconds\./],
    [() => jsonResponse(503, { message: 'Service unavailable' }), 503, /Serper had a server error \(HTTP 503\)/],
  ];
  for (const [respond, status, message] of cases) {
    const { module, ctx } = setup(respond);
    const { payload, isError } = await callTool(module, 'web_search', { q: 'x' }, ctx);
    assert.equal(isError, true, String(status));
    assert.equal(payload.status, status);
    assert.match(payload.error, message);
    if (status === 429) assert.equal(payload.retryAfter, 30);
  }
});

test('a network failure says Serper could not be reached', async () => {
  const { module, ctx } = setup(() => {
    throw new TypeError('fetch failed');
  });
  const { payload, isError } = await callTool(module, 'web_search', { q: 'x' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /Serper could not be reached \(fetch failed\)/);
});

test('bad arguments and a missing key are refused before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const missing = await callTool(module, 'web_search', {}, ctx);
  assert.match(missing.payload.error, /`q` is required\. Nothing was sent to Serper\./);
  const unknown = await callTool(module, 'web_search', { query: 'x' }, ctx);
  assert.match(unknown.payload.error, /unknown argument "query" \(expected: q, num, gl, hl, tbs, autocorrect, cursor\)/);
  const range = await callTool(module, 'web_search', { q: 'x', num: 50 }, ctx);
  assert.match(range.payload.error, /`num` must be at most 20/);
  const badCursor = await callTool(module, 'web_search', { q: 'x', cursor: 'not-a-cursor' }, ctx);
  assert.match(badCursor.payload.error, /cursor is not valid/);

  const noKey = makeContext({ credentials: {}, fetch });
  const unconnected = await callTool(module, 'web_search', { q: 'x' }, noKey.ctx);
  assert.equal(unconnected.payload.error, 'Serper is not connected: the Serper API key is missing.');
  assert.equal(fetch.calls.length, 0);
});

test('log lines name the vendor, tool, status and duration, never the key or the query', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, search));
  await callTool(module, 'web_search', { q: 'very private query' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^serper web_search POST 200 \d+ms$/);
  assert.equal(logs.some((line) => line.includes(KEY) || line.includes('private')), false);
});
