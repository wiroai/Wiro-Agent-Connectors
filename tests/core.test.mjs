import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, fakeFetch, jsonResponse, makeContext } from './helpers.mjs';

// The shared runtime that every module bundles, built on its own for these tests.
const require = createRequire(import.meta.url);
const core = require('../build/core.js');
const {
  allowedAccounts,
  decodeCursor,
  defineConnector,
  encodeCursor,
  fitPage,
  OUTPUT_LIMIT_BYTES,
  parseSiteUrl,
  requireAccounts,
  retryAfterSeconds,
  siteOrigin,
  ToolFailure,
  validateArguments,
} = core;

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 5 },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    kind: { type: 'string', enum: ['a', 'b'] },
    url: { type: 'string', format: 'uri' },
    code: { type: 'string', pattern: '^[A-Z]{2}$', description: 'two capitals' },
    tags: { type: 'array', items: { type: 'string', maxLength: 3 }, maxItems: 2, uniqueItems: true },
  },
  required: ['name'],
  additionalProperties: false,
};

test('arguments are checked against the schema, with clear messages', () => {
  assert.deepEqual(validateArguments(schema, { name: 'ok' }), { ok: true, value: { name: 'ok', count: 3 } });
  const cases = [
    [{}, '`name` is required'],
    [{ name: '' }, '`name` must not be empty'],
    [{ name: 'toolong' }, '`name` must be at most 5 characters (it has 7)'],
    [{ name: 'a', count: 1.5 }, '`count` must be an integer'],
    [{ name: 'a', count: 11 }, '`count` must be at most 10'],
    [{ name: 'a', ratio: 'x' }, '`ratio` must be a number'],
    [{ name: 'a', flag: 'yes' }, '`flag` must be true or false'],
    [{ name: 'a', kind: 'c' }, '`kind` must be one of "a", "b"'],
    [{ name: 'a', url: 'ftp://x' }, '`url` must be an absolute http(s) URL'],
    [{ name: 'a', code: 'abc' }, '`code` does not have the expected format (two capitals)'],
    [{ name: 'a', tags: ['a', 'b', 'c'] }, '`tags` must have at most 2 items'],
    [{ name: 'a', tags: ['a', 'a'] }, '`tags` must not repeat an item'],
    [{ name: 'a', tags: ['long'] }, '`tags[0]` must be at most 3 characters (it has 4)'],
    [{ name: 'a', extra: 1 }, 'unknown argument "extra" (expected: name, count, ratio, flag, kind, url, code, tags)'],
    [[], 'the arguments must be an object'],
  ];
  for (const [args, issue] of cases) {
    const result = validateArguments(schema, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.ok(result.issues.includes(issue), `${JSON.stringify(args)}: ${result.issues.join(' | ')}`);
  }
});

test('null optional arguments count as absent, and a client\'s toolCallId is dropped', () => {
  assert.deepEqual(validateArguments(schema, { name: 'a', kind: null, toolCallId: 'call_1' }), { ok: true, value: { name: 'a', count: 3 } });
  assert.deepEqual(validateArguments(schema, undefined).issues, ['`name` is required']);
  // Lengths count characters, not UTF-16 units.
  assert.equal(validateArguments(schema, { name: '😀😀😀😀😀' }).ok, true);
});

test('a page over the limit is cut where it fits, and the cursor resumes there', () => {
  const items = Array.from({ length: 50 }, (_, index) => ({ index, text: 'x'.repeat(2000) }));
  const page = fitPage({ key: 'items', items, resumeAt: (index) => `at-${index}`, nextPage: 'next' });
  const size = Buffer.byteLength(JSON.stringify(page));
  assert.ok(size <= OUTPUT_LIMIT_BYTES, `${size}`);
  assert.equal(page.truncated, true);
  assert.equal(page.nextCursor, `at-${page.items.length}`);
  assert.ok(page.items.length > 10 && page.items.length < 50);

  const small = fitPage({ key: 'items', items: items.slice(0, 2), resumeAt: () => 'unused', nextPage: 'next' });
  assert.deepEqual(Object.keys(small), ['items', 'nextCursor']);
  assert.equal(small.nextCursor, 'next');

  // One item larger than the limit is returned cut, and the cursor still moves on.
  const huge = fitPage({ key: 'items', items: [{ text: 'y'.repeat(40000) }, { text: 'z' }], resumeAt: (index) => `at-${index}` });
  assert.equal(huge.items.length, 1);
  assert.equal(huge.nextCursor, 'at-1');
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= OUTPUT_LIMIT_BYTES);
});

test('a cursor is accepted only by the tool that made it', () => {
  const cursor = encodeCursor('list_things', { p: 2, o: 5 });
  assert.deepEqual(decodeCursor('list_things', cursor), { t: 'list_things', p: 2, o: 5 });
  assert.equal(decodeCursor('list_things', undefined), null);
  assert.throws(() => decodeCursor('other_tool', cursor), ToolFailure);
  assert.throws(() => decodeCursor('list_things', 'garbage!'), /cursor is not valid/);
});

test('retryAfter comes from Retry-After seconds or date, or RateLimit-Reset', () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0);
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '30' }), now), 30);
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': new Date(now + 90_000).toUTCString() }), now), 90);
  assert.equal(retryAfterSeconds(new Headers({ 'ratelimit-reset': String(now / 1000 + 45) }), now), 45);
  assert.equal(retryAfterSeconds(new Headers({ 'ratelimit-reset': '12' }), now), 12);
  assert.equal(retryAfterSeconds(new Headers(), now), undefined);
});

test('the account lock: null means no lock, a missing key allows nothing', () => {
  assert.equal(allowedAccounts(null, 'pages'), null);
  assert.deepEqual(allowedAccounts({}, 'pages'), []);
  assert.deepEqual(allowedAccounts(undefined, 'pages'), [], 'an undefined selection is not an open lock');
  assert.doesNotThrow(() => requireAccounts(null, 'pages', 'p9'));
  assert.doesNotThrow(() => requireAccounts({ pages: ['p1', 2] }, 'pages', ['p1', 2]));
  assert.throws(() => requireAccounts({ pages: ['p1'] }, 'pages', ['p1', 'p2'], 'Page'), /The Page p2 is not among the Pages chosen for this connection\. Use one of: p1\./);
  assert.throws(() => requireAccounts({}, 'pages', 'p1'), /No account is chosen for it yet/);
});

test('a connector definition is checked when the module loads', () => {
  const tool = { name: 'get_x', kind: 'read', title: 'Get', description: 'Gets.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({}) };
  const base = { vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['api_key'], tools: [tool] };
  assert.doesNotThrow(() => defineConnector(base));
  assert.throws(() => defineConnector({ ...base, vendor: 'Acme!' }), /vendor must match/);
  assert.throws(() => defineConnector({ ...base, origins: ['http://api.acme.test'] }), /must be an https origin/);
  assert.throws(() => defineConnector({ ...base, origins: ['https://api.acme.test/v1'] }), /must be an https origin/);
  assert.throws(() => defineConnector({ ...base, tools: [tool, tool] }), /defined twice/);
  assert.throws(() => defineConnector({ ...base, tools: [{ ...tool, inputSchema: { type: 'object', properties: {} } }] }), /additionalProperties: false/);
  assert.throws(() => defineConnector({ ...base, tools: [tool, { ...tool, name: 'add_x', kind: 'create' }] }), /needs check: the name of a read tool/);
  assert.throws(() => defineConnector({ ...base, origins: [] }), /at least one origin or origin field is required/);
  assert.throws(() => defineConnector({ ...base, originFields: ['site_url'] }), /origin field site_url must be one of the credentials/);
  assert.throws(() => defineConnector({ ...base, credentials: ['site_url'], originFields: ['site_url', 'site_url'] }), /origin field site_url is listed twice/);
  assert.doesNotThrow(() => defineConnector({ ...base, origins: [], credentials: ['site_url', 'api_key'], originFields: ['site_url'] }));
  const module = defineConnector(base);
  assert.deepEqual(Object.keys(module), ['vendor', 'origins', 'originFields', 'credentials', 'tools', 'call']);
  assert.deepEqual(module.originFields, []);
  assert.ok(Object.isFrozen(module) && Object.isFrozen(module.tools[0].annotations));
});

test('a site or instance URL credential becomes an https origin, or a plain reason why not', () => {
  const ok = [
    ['social.example', 'https://social.example'],
    [' Social.Example ', 'https://social.example'],
    ['https://social.example/@alice', 'https://social.example'],
    ['HTTPS://Blog.Example/wp/', 'https://blog.example'],
    ['https://blog.example:8443/', 'https://blog.example:8443'],
    ['https://blog.example:443', 'https://blog.example'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
  ];
  for (const [value, origin] of ok) {
    const site = parseSiteUrl(value);
    assert.equal(site.ok, true, value);
    assert.equal(site.origin, origin, value);
    assert.equal(siteOrigin(value), origin, value);
  }
  const refused = [
    ['', 'is empty'],
    ['http://social.example', 'must be an https address, not http://'],
    ['ftp://social.example', 'must be an https address, not ftp://'],
    ['https://user:secret@social.example', 'must not contain a user name or password'],
    ['https://', 'is not a valid address (expected one like https://example.com)'],
    ['social example', 'is not a valid address (expected one like https://example.com)'],
    ['javascript:alert(1)', 'is not a valid address (expected one like https://example.com)'],
  ];
  for (const [value, problem] of refused) {
    assert.deepEqual(parseSiteUrl(value), { ok: false, problem }, value);
    assert.equal(siteOrigin(value), undefined, value);
  }
});

function connector(run, kind = 'read') {
  const tools = [
    { name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: kind === 'read' ? run : async () => ({}) },
  ];
  if (kind !== 'read') {
    tools.push({ name: 'write_x', kind, check: 'read_x', title: 'Write', description: 'Writes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run });
  }
  return defineConnector({ vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['api_key'], tools });
}

test('a read tool cannot send a write method: the request never leaves', async () => {
  const module = connector((args, h) => h.api({ method: 'DELETE', path: '/things/1' }));
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const { ctx } = makeContext({ credentials: { api_key: 'k' }, fetch });
  const { payload, isError } = await callTool(module, 'read_x', {}, ctx);
  assert.equal(isError, true);
  assert.equal(payload.error, 'read_x failed unexpectedly.');
  assert.equal(fetch.calls.length, 0);
});

test('a request outside the declared origins is never made', async () => {
  const module = connector((args, h) => h.api({ path: '/x', origin: 'https://evil.test' }));
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const { ctx } = makeContext({ credentials: { api_key: 'k' }, fetch });
  const { isError } = await callTool(module, 'read_x', {}, ctx);
  assert.equal(isError, true);
  assert.equal(fetch.calls.length, 0);
});

test('a module bug never leaks its message, and after a sent write it is an unknown outcome', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { ok: true }));
  const { ctx, logs } = makeContext({ credentials: { api_key: 'k' }, fetch });

  const before = connector(async () => {
    throw new Error('secret-key-in-message');
  }, 'create');
  const early = await callTool(before, 'write_x', {}, ctx);
  assert.equal(early.payload.error, 'write_x failed unexpectedly. Nothing was changed.');
  assert.equal(early.text.includes('secret'), false);

  const after = connector(async (args, h) => {
    await h.api({ method: 'POST', path: '/things', json: {}, write: true });
    throw new TypeError('secret-in-parse');
  }, 'create');
  const late = await callTool(after, 'write_x', {}, ctx);
  assert.equal(late.payload.outcome, 'unknown');
  assert.equal(late.payload.check, 'read_x');
  assert.equal(late.text.includes('secret'), false);
  assert.equal(logs.join('\n').includes('secret'), false);
});

test('writes are never retried: one request per call, whatever the answer', async () => {
  for (const respond of [() => jsonResponse(503, {}), () => jsonResponse(429, {}), () => { throw new TypeError('reset'); }]) {
    const fetch = fakeFetch(respond);
    const { ctx } = makeContext({ credentials: { api_key: 'k' }, fetch });
    const module = connector((args, h) => h.api({ method: 'PUT', path: '/things/1', json: {}, write: true }), 'update');
    await callTool(module, 'write_x', {}, ctx);
    assert.equal(fetch.calls.length, 1);
  }
});

test('an unknown tool and a host without fetch get plain errors', async () => {
  const module = connector(async () => ({}));
  const { payload } = await callTool(module, 'nope', {}, makeContext({ credentials: { api_key: 'k' }, fetch: fakeFetch(() => jsonResponse(200, {})) }).ctx);
  assert.equal(payload.error, 'Unknown tool "nope". Acme tools: read_x.');
  const noFetch = await callTool(module, 'read_x', {}, { credentials: { api_key: 'k' }, accounts: {}, log() {} });
  assert.match(noFetch.payload.error, /no fetch function/);
});

const READ_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

/** A connector whose API is on the site the user names in site_url (and, with `origins`, on fixed origins too). */
function siteConnector(run, { origins = [], normalizeCredentials } = {}) {
  return defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins,
    originFields: ['site_url'],
    credentials: ['site_url', 'api_key'],
    credentialLabels: { site_url: 'Acme site URL' },
    authHeaders: (credentials) => ({ authorization: `Bearer ${credentials.api_key}` }),
    ...(normalizeCredentials ? { normalizeCredentials } : {}),
    tools: [{ name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run }],
  });
}

test('an origin field lets each call reach the https origin of its own site URL', async () => {
  const module = siteConnector(async (args, h) => {
    await h.api({ path: '/api/v1/me' });
    return { origins: h.origins, site: h.originOf('site_url') };
  });
  assert.deepEqual(module.origins, []);
  assert.deepEqual(module.originFields, ['site_url']);
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  for (const [value, origin] of [['Social.Example', 'https://social.example'], ['https://blog.example/wp/', 'https://blog.example']]) {
    const { ctx } = makeContext({ credentials: { site_url: value, api_key: 'k' }, fetch });
    const { payload, isError } = await callTool(module, 'read_x', {}, ctx);
    assert.equal(isError, false, payload.error);
    assert.deepEqual(payload, { origins: [origin], site: origin });
    assert.equal(fetch.calls.at(-1).url, `${origin}/api/v1/me`, 'the default origin is the site, with no fixed origin');
    assert.equal(fetch.calls.at(-1).headers.authorization, 'Bearer k');
  }
});

test('with fixed origins too, h.api reaches the site by its origin and nothing else', async () => {
  const module = siteConnector(async (args, h) => {
    await h.api({ path: '/token' });
    await h.api({ path: '/wp-json/wp/v2/posts', origin: h.originOf('site_url') });
    await h.api({ path: '/x', origin: 'https://other.example' });
  }, { origins: ['https://auth.acme.test'] });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const { ctx, logs } = makeContext({ credentials: { site_url: 'blog.example', api_key: 'k' }, fetch });
  const { isError } = await callTool(module, 'read_x', {}, ctx);
  assert.equal(isError, true);
  assert.deepEqual(fetch.calls.map((call) => call.url), ['https://auth.acme.test/token', 'https://blog.example/wp-json/wp/v2/posts']);
  assert.match(logs.at(-1), /unexpected Error/, 'the undeclared origin was never requested');
});

test('a site URL that is not https, or that carries a password, is refused before anything is sent', async () => {
  const module = siteConnector(async (args, h) => h.api({ path: '/' }));
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const cases = [
    ['http://blog.example', 'Acme is not connected correctly: the Acme site URL must be an https address, not http://. Nothing was sent to Acme.'],
    ['https://admin:hunter2@blog.example', 'Acme is not connected correctly: the Acme site URL must not contain a user name or password. Nothing was sent to Acme.'],
    ['not a site', 'Acme is not connected correctly: the Acme site URL is not a valid address (expected one like https://example.com). Nothing was sent to Acme.'],
  ];
  for (const [value, message] of cases) {
    const { ctx } = makeContext({ credentials: { site_url: value, api_key: 'k' }, fetch });
    const { payload, isError, text } = await callTool(module, 'read_x', {}, ctx);
    assert.equal(isError, true);
    assert.equal(payload.error, message);
    assert.equal(text.includes('hunter2'), false, 'the password is never repeated');
  }
  const missing = await callTool(module, 'read_x', {}, makeContext({ credentials: { site_url: '  ', api_key: 'k' }, fetch }).ctx);
  assert.equal(missing.payload.error, 'Acme is not connected: the Acme site URL is missing.');
  assert.equal(fetch.calls.length, 0);
});

test('the origin comes from the value the host passed, whatever normalizeCredentials makes of it', async () => {
  const module = siteConnector(async (args, h) => {
    await h.api({ path: '/' });
    return { value: h.credentials.site_url };
  }, { normalizeCredentials: (credentials) => ({ ...credentials, site_url: 'https://elsewhere.example' }) });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const { ctx } = makeContext({ credentials: { site_url: 'blog.example', api_key: 'k' }, fetch });
  const { payload } = await callTool(module, 'read_x', {}, ctx);
  assert.equal(payload.value, 'https://elsewhere.example');
  assert.equal(fetch.calls[0].url, 'https://blog.example/', 'hosts resolve the same value, so they agree on it');
});

test('a module that declares access_token gets the host\'s current OAuth token on every call, and keeps none', async () => {
  const module = defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://api.acme.test'],
    credentials: ['access_token'],
    credentialLabels: { access_token: 'Acme access token' },
    authHeaders: (credentials) => ({ authorization: `Bearer ${credentials.access_token}` }),
    tools: [{ name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run: async (args, h) => (await h.api({ path: '/me' })).data }],
  });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  // The host refreshes the token between calls: each call sends the one it was given.
  for (const token of ['token-1', 'token-2', 'token-1']) {
    await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: token }, fetch }).ctx);
  }
  assert.deepEqual(fetch.calls.map((call) => call.headers.authorization), ['Bearer token-1', 'Bearer token-2', 'Bearer token-1']);

  const expired = fakeFetch(() => jsonResponse(401, { error: 'invalid_token', message: 'The access token expired' }));
  const refused = await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: 'token-0' }, fetch: expired }).ctx);
  assert.equal(refused.payload.error, 'Acme rejected the credentials (HTTP 401): The access token expired. Check that the Acme access token is correct and still active.');
  assert.equal(refused.payload.status, 401);
  assert.equal(expired.calls.length, 1, 'a module never refreshes or retries: the host does');
  const missing = await callTool(module, 'read_x', {}, makeContext({ credentials: {}, fetch }).ctx);
  assert.equal(missing.payload.error, 'Acme is not connected: the Acme access token is missing.');
});
