import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, fakeFetch, jsonResponse, makeContext, textBytes, textResponse } from './helpers.mjs';

// api_get and api_request, the generic tools a connector adds for the rest of
// its vendor's API.

const require = createRequire(import.meta.url);
const { apiTools, defineConnector, OUTPUT_LIMIT_BYTES, ToolFailure } = require('../build/core.js');

const DESCRIPTION = 'The Acme API v2 at https://api.acme.test/v2, with the connected API key: paths start with /v2/, such as /v2/pages/p1/posts.';

function acme(options = {}, definition = {}) {
  return defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://api.acme.test'],
    credentials: ['api_key'],
    authHeaders: (credentials) => ({ authorization: `Bearer ${credentials.api_key}` }),
    tools: apiTools({ label: 'Acme', description: DESCRIPTION, basePath: '/v2/', ...options }),
    ...definition,
  });
}

function setup(handler, { options, definition, accounts = null, credentials = { api_key: 'key-1' } } = {}) {
  const module = acme(options, definition);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

test('api_get reads and api_request writes, with true annotations and the vendor\'s own description', () => {
  const module = acme();
  const [get, request] = module.tools;
  assert.equal(get.name, 'api_get');
  assert.equal(get.title, 'Call the Acme API (GET)');
  assert.deepEqual(get.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(Object.keys(get.inputSchema.properties), ['path', 'query']);
  assert.ok(get.description.startsWith(DESCRIPTION));

  assert.equal(request.name, 'api_request');
  assert.equal(request.title, 'Send a request to the Acme API');
  // It may add, change or delete, so it claims neither safety nor idempotence.
  assert.deepEqual(request.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(request.inputSchema.properties.method.enum, ['POST', 'PUT', 'PATCH', 'DELETE']);
  assert.deepEqual(request.inputSchema.required, ['method', 'path']);
  assert.match(request.description, /never retried: when the outcome is unclear, check with api_get/);

  const posts = acme({ methods: ['POST'], originArgument: 'The API host.' });
  assert.deepEqual(posts.tools[1].inputSchema.properties.method.enum, ['POST']);
  assert.equal(posts.tools[0].inputSchema.properties.origin.description, 'The API host.');
});

test('api_get sends one GET with the auth header, the path and the query, and returns the status and the reply', async () => {
  const { module, fetch, ctx, logs } = setup(() => jsonResponse(200, { data: [{ id: 'p1' }] }, { link: '<https://api.acme.test/v2/pages?page=2>; rel="next"', 'x-secret': 'left out' }));
  const { payload, isError } = await callTool(module, 'api_get', { path: '/v2/pages', query: { page: 1, fields: 'id,name', ids: [1, 'b'], draft: false, skip: null } }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1);
  const [sent] = fetch.calls;
  assert.equal(sent.method, 'GET');
  assert.equal(sent.url, 'https://api.acme.test/v2/pages?page=1&fields=id%2Cname&ids=1&ids=b&draft=false');
  assert.equal(sent.headers.authorization, 'Bearer key-1');
  assert.deepEqual(payload, {
    status: 200,
    headers: { link: '<https://api.acme.test/v2/pages?page=2>; rel="next"' },
    data: { data: [{ id: 'p1' }] },
  });
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['acme api_get GET 200 Nms']);
});

test('a path stays on the origin and under the base path, after dot segments are resolved', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const refused = [
    ['/v2/../admin', 'The path must start with /v2/. Nothing was sent.'],
    ['/v2x/pages', 'The path must start with /v2/. Nothing was sent.'],
    ['/v2%2f..%2fadmin', 'The path must start with /v2/. Nothing was sent.'],
    ['/v2/%zz', 'The path has a broken percent-escape (a % not followed by two hex digits). Nothing was sent.'],
  ];
  for (const [path, error] of refused) {
    const { payload } = await callTool(module, 'api_get', { path }, ctx);
    assert.equal(payload.error, error, path);
  }
  for (const path of ['//evil.test/v2/x', 'v2/pages', '/v2/pages?page=2', '/v2//pages', 'https://evil.test/v2/x']) {
    const { payload } = await callTool(module, 'api_get', { path }, ctx);
    assert.match(payload.error, /Invalid arguments for api_get: `path` does not have the expected format/, path);
  }
  const { payload } = await callTool(module, 'api_get', { path: '/v2/pages', query: { filter: { a: 1 } } }, ctx);
  assert.equal(payload.error, 'query.filter must be text, a number, true or false, or a list of them. Nothing was sent.');
  assert.equal(fetch.calls.length, 0);

  await callTool(module, 'api_get', { path: '/v2/./pages/../pages/' }, ctx);
  await callTool(module, 'api_get', { path: '/v2' }, ctx);
  assert.deepEqual(fetch.calls.map((call) => call.path), ['/v2/pages/', '/v2']);
});

test('api_request sends a JSON or a raw body, once, and marks it as the change', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, { id: 'n1' }, { location: 'https://api.acme.test/v2/posts/n1' }));
  const created = await callTool(module, 'api_request', { method: 'POST', path: '/v2/pages/p1/posts', json: { title: 'Hi' } }, ctx);
  assert.deepEqual(created.payload, { status: 201, headers: { location: 'https://api.acme.test/v2/posts/n1' }, data: { id: 'n1' } });
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(fetch.calls[0].json, { title: 'Hi' });
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer key-1');

  await callTool(module, 'api_request', { method: 'PUT', path: '/v2/pages/p1', body: 'name=New+name', content_type: 'application/x-www-form-urlencoded' }, ctx);
  assert.equal(fetch.calls[1].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new TextDecoder().decode(fetch.calls[1].body), 'name=New+name');

  await callTool(module, 'api_request', { method: 'PATCH', path: '/v2/pages/p1', json: { name: null }, content_type: 'application/merge-patch+json' }, ctx);
  assert.equal(fetch.calls[2].headers['content-type'], 'application/merge-patch+json');
  assert.equal(new TextDecoder().decode(fetch.calls[2].body), '{"name":null}');

  await callTool(module, 'api_request', { method: 'DELETE', path: '/v2/posts/n1' }, ctx);
  assert.equal(fetch.calls[3].method, 'DELETE');
  assert.equal(fetch.calls[3].body, undefined);

  const before = fetch.calls.length;
  const both = await callTool(module, 'api_request', { method: 'POST', path: '/v2/x', json: {}, body: 'x', content_type: 'text/plain' }, ctx);
  assert.equal(both.payload.error, 'Give json or body, not both. Nothing was sent.');
  const untyped = await callTool(module, 'api_request', { method: 'POST', path: '/v2/x', body: 'x' }, ctx);
  assert.equal(untyped.payload.error, 'content_type is required with body, e.g. "application/x-www-form-urlencoded". Nothing was sent.');
  const get = await callTool(module, 'api_request', { method: 'GET', path: '/v2/x' }, ctx);
  assert.match(get.payload.error, /`method` must be one of "POST", "PUT", "PATCH", "DELETE"/);
  assert.equal(fetch.calls.length, before);
});

test('api_request is never retried: an unclear outcome is unknown, with api_get to check', async () => {
  for (const respond of [() => jsonResponse(503, { message: 'busy' }), () => { throw new TypeError('fetch failed'); }, () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); }]) {
    const { module, fetch, ctx } = setup(respond);
    const { payload, isError } = await callTool(module, 'api_request', { method: 'POST', path: '/v2/pages/p1/posts', json: { title: 'Hi' } }, ctx);
    assert.equal(isError, true);
    assert.equal(payload.outcome, 'unknown');
    assert.equal(payload.check, 'api_get');
    assert.equal(fetch.calls.length, 1);
  }
  const { module, ctx } = setup(() => jsonResponse(422, { message: 'title is too long' }));
  const { payload } = await callTool(module, 'api_request', { method: 'POST', path: '/v2/pages/p1/posts', json: {} }, ctx);
  assert.equal(payload.error, 'Acme rejected the request (HTTP 422): title is too long. Nothing was changed.');
  assert.equal(payload.status, 422);
});

test('the account lock: a chosen account as a path segment by default, or the module\'s own ids', async () => {
  const handler = () => jsonResponse(200, {});
  const byPath = setup(handler, { options: { accounts: { key: 'pages', label: 'Page' } }, accounts: { pages: ['p1'] } });
  assert.equal((await callTool(byPath.module, 'api_get', { path: '/v2/pages/p1/posts' }, byPath.ctx)).isError, false);
  const other = await callTool(byPath.module, 'api_request', { method: 'DELETE', path: '/v2/pages/p2' }, byPath.ctx);
  assert.equal(other.payload.error, 'This request names none of the Pages chosen for this connection. It must name one of: p1. Nothing was sent.');
  const none = await callTool(byPath.module, 'api_get', { path: '/v2/me' }, byPath.ctx);
  assert.match(none.payload.error, /names none of the Pages chosen/);
  assert.equal(byPath.fetch.calls.length, 1);

  const nothingChosen = setup(handler, { options: { accounts: { key: 'pages', label: 'Page' } }, accounts: {} });
  const empty = await callTool(nothingChosen.module, 'api_get', { path: '/v2/pages/p1' }, nothingChosen.ctx);
  assert.equal(empty.payload.error, 'This request names none of the Pages chosen for this connection. No Page is chosen for it yet. Nothing was sent.');

  const open = setup(handler, { options: { accounts: { key: 'pages' } }, accounts: null });
  assert.equal((await callTool(open.module, 'api_get', { path: '/v2/pages/p9' }, open.ctx)).isError, false, 'null accounts: no lock');

  // Ad accounts named as act_<id> in the path, or in the body: every one must be chosen.
  const ids = (request) => [
    ...request.segments.filter((segment) => segment.startsWith('act_')).map((segment) => segment.slice(4)),
    ...(typeof request.json?.account_id === 'string' ? [request.json.account_id] : []),
  ];
  const byIds = setup(handler, { options: { accounts: { key: 'ad_accounts', label: 'ad account', ids } }, accounts: { ad_accounts: ['11'] } });
  assert.equal((await callTool(byIds.module, 'api_get', { path: '/v2/act_11/campaigns' }, byIds.ctx)).isError, false);
  const mixed = await callTool(byIds.module, 'api_request', { method: 'POST', path: '/v2/act_11/copies', json: { account_id: '22' } }, byIds.ctx);
  assert.equal(mixed.payload.error, 'The ad account 22 is not among the ad accounts chosen for this connection. Use one of: 11. Nothing was sent.');
  assert.equal(byIds.fetch.calls.length, 1);

  // A segment is compared decoded: a site URL as an id.
  const sites = setup(handler, { options: { accounts: { key: 'sites', label: 'site' } }, accounts: { sites: ['https://www.example.com/'] } });
  const site = await callTool(sites.module, 'api_get', { path: '/v2/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics' }, sites.ctx);
  assert.equal(site.isError, false, site.payload.error);
});

test('a reply over 32 KB is cut to fit: long strings first, then the text itself', async () => {
  const articles = Array.from({ length: 40 }, (_, index) => ({ id: index, body: 'x'.repeat(5000) }));
  const long = setup(() => jsonResponse(200, articles));
  const cutStrings = await callTool(long.module, 'api_get', { path: '/v2/articles' }, long.ctx);
  assert.ok(textBytes(cutStrings.result) <= OUTPUT_LIMIT_BYTES);
  assert.equal(cutStrings.payload.truncated, true);
  assert.equal(cutStrings.payload.data.length, 40, 'the structure is kept');
  assert.match(cutStrings.payload.note, /Long text values were cut/);

  const rows = Array.from({ length: 5000 }, (_, index) => ({ id: index, ok: true }));
  const many = setup(() => jsonResponse(200, rows));
  const cutText = await callTool(many.module, 'api_get', { path: '/v2/rows' }, many.ctx);
  assert.ok(textBytes(cutText.result) <= OUTPUT_LIMIT_BYTES);
  assert.ok(textBytes(cutText.result) > OUTPUT_LIMIT_BYTES - 200, 'it uses the room it has');
  assert.equal(cutText.payload.truncated, true);
  assert.ok(JSON.stringify(rows).startsWith(cutText.payload.text));
  assert.match(cutText.payload.note, /^The reply has [\d,]+ bytes and was cut to fit 32 KB/);

  const text = setup(() => textResponse(200, 'plain words'));
  assert.deepEqual((await callTool(text.module, 'api_get', { path: '/v2/robots' }, text.ctx)).payload, { status: 200, data: 'plain words' });

  const image = setup(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
  assert.deepEqual((await callTool(image.module, 'api_get', { path: '/v2/logo' }, image.ctx)).payload, {
    status: 200,
    contentType: 'image/png',
    note: 'The reply is a binary file and is not shown.',
  });
});

test('the origin argument picks one of the call\'s origins, a site from an origin field included', async () => {
  const definition = { origins: ['https://api.acme.test', 'https://upload.acme.test'], originFields: ['site_url'], credentials: ['api_key', 'site_url'] };
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}), {
    options: { originArgument: 'https://api.acme.test (default), https://upload.acme.test, or the site of the connection.' },
    definition,
    credentials: { api_key: 'key-1', site_url: 'shop.example' },
  });
  await callTool(module, 'api_get', { path: '/v2/a' }, ctx);
  await callTool(module, 'api_get', { path: '/v2/b', origin: 'https://upload.acme.test/' }, ctx);
  await callTool(module, 'api_request', { method: 'POST', path: '/v2/c', origin: 'https://shop.example' }, ctx);
  assert.deepEqual(fetch.calls.map((call) => call.url), ['https://api.acme.test/v2/a', 'https://upload.acme.test/v2/b', 'https://shop.example/v2/c']);
  const { payload } = await callTool(module, 'api_get', { path: '/v2/d', origin: 'https://evil.test' }, ctx);
  assert.equal(payload.error, 'origin must be one of: https://api.acme.test, https://upload.acme.test, https://shop.example. Nothing was sent.');
  assert.equal(fetch.calls.length, 3);
});

test('a guard can refuse a request before it is sent, and send can wrap it', async () => {
  const seen = [];
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}), {
    options: {
      guard: (request) => {
        seen.push(request);
        if (request.segments[1] === 'admin') throw new ToolFailure('Admin endpoints are not available here. Nothing was sent.');
      },
      send: (request, h) => h.api({ ...request, headers: { ...request.headers, 'x-session': 's1' } }),
    },
  });
  const refused = await callTool(module, 'api_request', { method: 'POST', path: '/v2/admin/users', json: { a: 1 } }, ctx);
  assert.equal(refused.payload.error, 'Admin endpoints are not available here. Nothing was sent.');
  assert.deepEqual(seen[0], { method: 'POST', origin: 'https://api.acme.test', path: '/v2/admin/users', segments: ['v2', 'admin', 'users'], query: {}, json: { a: 1 } });
  assert.equal(fetch.calls.length, 0);

  await callTool(module, 'api_get', { path: '/v2/me', query: { a: ['1', '2'] } }, ctx);
  assert.equal(fetch.calls[0].headers['x-session'], 's1');
  assert.deepEqual(seen[1].query, { a: ['1', '2'] });
});

test('a write kind needs a check tool, like every other write', () => {
  const tool = { name: 'do_x', kind: 'write', title: 'Do', description: 'Does.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({}) };
  assert.throws(() => defineConnector({ vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: [], tools: [tool] }), /needs check: the name of a read tool/);
  assert.throws(() => defineConnector({ vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: [], tools: [{ ...tool, kind: 'toString' }] }), /unknown kind/);
});
