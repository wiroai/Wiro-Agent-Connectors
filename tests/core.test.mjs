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
  requireAccounts,
  retryAfterSeconds,
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
  const module = defineConnector(base);
  assert.deepEqual(Object.keys(module), ['vendor', 'origins', 'credentials', 'tools', 'call']);
  assert.ok(Object.isFrozen(module) && Object.isFrozen(module.tools[0].annotations));
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
