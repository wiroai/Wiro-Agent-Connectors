import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, fakeFetch, jsonResponse, makeContext } from './helpers.mjs';

// The shared runtime that every module bundles, built on its own for these tests.
const require = createRequire(import.meta.url);
const core = require('../build/core.js');
const {
  allowedAccounts,
  andList,
  decodeCursor,
  defineConnector,
  encodeCursor,
  fitPage,
  isUploadHost,
  orList,
  OUTPUT_LIMIT_BYTES,
  parseSiteUrl,
  requireAccounts,
  requiredAlternatives,
  retryAfterSeconds,
  siteOrigin,
  ToolFailure,
  unmetAlternatives,
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
  assert.deepEqual(Object.keys(module), ['vendor', 'origins', 'originFields', 'uploadHosts', 'credentials', 'requiredCredentials', 'accountPickers', 'tools', 'call']);
  assert.deepEqual(module.originFields, []);
  assert.deepEqual(module.uploadHosts, [], 'no upload hosts by default');
  assert.deepEqual(module.requiredCredentials, [['api_key']], 'by default one list of every credential');
  assert.deepEqual(module.accountPickers, []);
  assert.ok(Object.isFrozen(module) && Object.isFrozen(module.tools[0].annotations));
  assert.ok(Object.isFrozen(module.requiredCredentials[0]));
});

test('upload hosts are checked when the module loads: lowercase host names, with a leading dot for every host under one', () => {
  const tool = { name: 'get_x', kind: 'read', title: 'Get', description: 'Gets.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({}) };
  const base = { vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['api_key'], tools: [tool] };
  const module = defineConnector({ ...base, uploadHosts: ['.blobstore.apple.com', 'uploads.example.com', '.xn--bcher-kva.example'] });
  assert.deepEqual(module.uploadHosts, ['.blobstore.apple.com', 'uploads.example.com', '.xn--bcher-kva.example'], 'exported as given');
  assert.ok(Object.isFrozen(module.uploadHosts));
  const cases = [
    ['.blobstore.apple.com', /uploadHosts must be a list of host names/],
    [[7], /upload host 7 must be a host name/],
    [['Uploads.Example.com'], /upload host "Uploads\.Example\.com" must be a lowercase host name like uploads\.example\.com/],
    [['https://uploads.example.com'], /must be a lowercase host name/],
    [['*.apple.com'], /must be a lowercase host name/],
    [['uploads..example.com'], /must be a lowercase host name/],
    [['-uploads.example.com'], /must be a lowercase host name/],
    [['uploads.example.com.'], /must be a lowercase host name/],
    [['..example.com'], /must be a lowercase host name/],
    [[''], /must be a lowercase host name/],
    [['[::1]'], /must be a lowercase host name/],
    [['.com'], /upload host "\.com" needs at least two labels, like example\.com/],
    [['localhost'], /needs at least two labels/],
    [['93.184.216.34'], /upload host "93\.184\.216\.34" must be a host name, not an IP address/],
    [['.blobstore.apple.com', '.blobstore.apple.com'], /upload host \.blobstore\.apple\.com is listed twice/],
  ];
  for (const [uploadHosts, message] of cases) {
    assert.throws(() => defineConnector({ ...base, uploadHosts }), message, JSON.stringify(uploadHosts));
  }
});

test('an address is on an upload host when it is the host itself, or under one with a leading dot, never a look-alike', () => {
  const hosts = ['.blobstore.apple.com', 'uploads.example.com'];
  for (const name of ['store-030.blobstore.apple.com', 'a.b.blobstore.apple.com', 'STORE-030.Blobstore.Apple.COM', 'store-030.blobstore.apple.com.', 'uploads.example.com']) {
    assert.equal(isUploadHost(name, hosts), true, name);
  }
  for (const name of ['blobstore.apple.com', 'evil-blobstore.apple.com', 'store-030.blobstore.apple.com.evil.test', 'apple.com', 'x.uploads.example.com', 'uploads.example.com.evil.test', '93.184.216.34', '']) {
    assert.equal(isUploadHost(name, hosts), false, name);
  }
  assert.equal(isUploadHost('store-030.blobstore.apple.com', []), false, 'a module without upload hosts has none');
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

test('a tool hands files to a host that takes them: one embedded resource each, after the JSON text', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const module = connector(async (args, h) => {
    const limit = h.fileLimit();
    const image = h.file({ name: 'Q3 report/final.png', mimeType: 'IMAGE/PNG; charset=binary', bytes: png });
    const notes = h.file({ name: ' notes.txt\n', mimeType: 'not a type', bytes: new TextEncoder().encode('hi') });
    return { limit, image, notes };
  });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const { ctx } = makeContext({ credentials: { api_key: 'k' }, fetch, files: { maxBytes: 64 } });
  const raw = await module.call('read_x', {}, ctx);
  assert.deepEqual(raw.content.map((block) => block.type), ['text', 'resource', 'resource'], 'the JSON text first');
  assert.deepEqual(raw.content[1], {
    type: 'resource',
    resource: { uri: 'attachment:///Q3%20report_final.png', mimeType: 'image/png', blob: Buffer.from(png).toString('base64') },
  });
  const { payload, files, isError } = await callTool(module, 'read_x', {}, ctx);
  assert.equal(isError, false);
  assert.deepEqual(payload, {
    limit: 64,
    image: { name: 'Q3 report_final.png', mimeType: 'image/png', size: 8 },
    notes: { name: 'notes.txt', mimeType: 'application/octet-stream', size: 2 },
  });
  assert.deepEqual(files.map(({ name, mimeType, bytes }) => [name, mimeType, [...bytes]]), [
    ['Q3 report_final.png', 'image/png', [...png]],
    ['notes.txt', 'application/octet-stream', [0x68, 0x69]],
  ]);
  assert.equal(fetch.calls.length, 0);

  // A long name keeps its extension.
  const long = connector(async (args, h) => h.file({ name: `${'x'.repeat(300)}.pdf`, mimeType: 'application/pdf', bytes: png }));
  const cut = await callTool(long, 'read_x', {}, ctx);
  assert.equal(cut.payload.name, `${'x'.repeat(196)}.pdf`);
});

test('a host without ctx.files takes no file, the files of one call keep within its limit, and an error carries none', async () => {
  const limitOf = connector(async (args, h) => ({ limit: h.fileLimit() }));
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  for (const files of [undefined, { maxBytes: 0 }, { maxBytes: -5 }, { maxBytes: 1.5 }, { maxBytes: '64' }, {}]) {
    const { payload } = await callTool(limitOf, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch, files }).ctx);
    assert.deepEqual(payload, { limit: null }, JSON.stringify(files));
  }
  const bytes = (size) => new Uint8Array(size);
  const hand = (...sizes) => connector(async (args, h) => {
    for (const size of sizes) h.file({ name: 'a.bin', mimeType: 'application/octet-stream', bytes: bytes(size) });
    return { ok: true };
  });
  const none = await callTool(hand(1), 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch }).ctx);
  assert.equal(none.payload.error, 'This host takes no files, so read_x cannot hand one back.');
  const ctx = makeContext({ credentials: { api_key: 'k' }, fetch, files: { maxBytes: 64 } }).ctx;
  const one = await callTool(hand(65), 'read_x', {}, ctx);
  assert.equal(one.payload.error, 'The file has 65 bytes, more than the 64 bytes this host takes.');
  const two = await callTool(hand(40, 30), 'read_x', {}, ctx);
  assert.equal(two.payload.error, 'The files of this call have 70 bytes in all, more than the 64 bytes this host takes from one call.');
  assert.deepEqual([one.files, two.files], [[], []], 'an error hands back no file');
  const exact = await callTool(hand(40, 24), 'read_x', {}, ctx);
  assert.deepEqual(exact.files.map((file) => file.bytes.length), [40, 24]);

  const late = connector(async (args, h) => {
    h.file({ name: 'a.bin', mimeType: 'application/octet-stream', bytes: bytes(4) });
    throw new ToolFailure('Something else failed.');
  });
  const failed = await callTool(late, 'read_x', {}, ctx);
  assert.deepEqual([failed.isError, failed.payload.error, failed.files], [true, 'Something else failed.', []]);
});

test('a binary request returns the reply\'s bytes unparsed, and an error reply is still read for its message', async () => {
  const file = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0xff, 0x00]);
  const module = connector(async (args, h) => {
    const { data } = await h.api({ path: '/files/1', binary: true, maxBytes: 64 });
    return { bytes: data instanceof Uint8Array, values: [...data] };
  });
  const ok = await callTool(module, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: fakeFetch(() => new Response(file, { headers: { 'content-type': 'application/json' } })) }).ctx);
  assert.deepEqual(ok.payload, { bytes: true, values: [...file] }, 'not parsed, even when it looks like JSON');
  const missing = await callTool(module, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: fakeFetch(() => jsonResponse(404, { message: 'No such file' })) }).ctx);
  assert.equal(missing.payload.error, 'Acme found nothing there (HTTP 404): No such file.');
  const big = await callTool(module, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: fakeFetch(() => new Response(new Uint8Array(65))) }).ctx);
  assert.equal(big.payload.error, 'Acme answered HTTP 200, but the reply could not be read (the reply is larger than 64 bytes).');
});

test('a reply the host refuses as too large is its size limit, not an outage: no "try again later"', async () => {
  const tooLarge = () => fakeFetch(() => { throw Object.assign(new Error('the reply is larger than 5242880 bytes'), { code: 'TOO_LARGE' }); });
  const read = connector((args, h) => h.api({ path: '/files/1', binary: true }));
  const refused = await callTool(read, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: tooLarge() }).ctx);
  assert.equal(refused.payload.error, 'The reply from Acme is larger than this host can read.');

  // A read before a write changes nothing; the write itself was sent, so its outcome stays unknown.
  const before = connector((args, h) => h.api({ path: '/things/1' }), 'create');
  const stopped = await callTool(before, 'write_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: tooLarge() }).ctx);
  assert.equal(stopped.payload.error, 'The reply from Acme is larger than this host can read. Nothing was changed.');
  const write = connector((args, h) => h.api({ method: 'POST', path: '/things', json: {}, write: true }), 'create');
  const unknown = await callTool(write, 'write_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: tooLarge() }).ctx);
  assert.equal(unknown.payload.outcome, 'unknown');

  // Any other failure to reach the vendor still says to try again later.
  const unreachable = await callTool(read, 'read_x', {}, makeContext({ credentials: { api_key: 'k' }, fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }) }).ctx);
  assert.equal(unreachable.payload.error, 'Acme could not be reached (fetch failed). Try again later.');
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

test('alternatives: what each one lacks, smallest first, in plain words', () => {
  const has = (...names) => (name) => names.includes(name);
  assert.deepEqual(requiredAlternatives({ credentials: ['a', 'b'] }), [['a', 'b']], 'by default every credential');
  assert.deepEqual(requiredAlternatives({ credentials: ['a', 'b'], requiredCredentials: [['a'], ['b']] }), [['a'], ['b']]);
  assert.deepEqual(unmetAlternatives([['a'], ['b', 'c']], has('a')), [], 'one complete list is enough');
  assert.deepEqual(unmetAlternatives([['a'], ['b', 'c']], has('b')), [['a'], ['c']], 'what is given is not asked for again');
  assert.deepEqual(unmetAlternatives([['a', 'b'], ['c', 'b']], has('a', 'c')), [['b']], 'two lists that lack the same are named once');
  assert.deepEqual(unmetAlternatives([['a', 'b', 'c'], ['d', 'b']], has('a', 'd')), [['b']], 'a list that lacks more than another is left out');
  assert.deepEqual(unmetAlternatives([[]], has()), [], 'an empty list needs nothing');
  assert.deepEqual(['A', 'A and B', 'A, B and C'], [andList(['A']), andList(['A', 'B']), andList(['A', 'B', 'C'])]);
  assert.deepEqual(['A', 'A, or B', 'A, B, or C'], [orList(['A']), orList(['A', 'B']), orList(['A', 'B', 'C'])]);
});

test('requiredCredentials are checked when the module loads: lists of its own credentials, none of them redundant', () => {
  const tool = { name: 'get_x', kind: 'read', title: 'Get', description: 'Gets.', inputSchema: READ_SCHEMA, run: async () => ({}) };
  const base = { vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['access_token', 'system_user_token', 'appsecret_proof'], tools: [tool] };
  const module = defineConnector({ ...base, requiredCredentials: [['access_token'], ['system_user_token']] });
  assert.deepEqual(module.requiredCredentials, [['access_token'], ['system_user_token']], 'exported as given');
  const cases = [
    [[], /requiredCredentials must be a list of credential lists/],
    ['access_token', /requiredCredentials must be a list of credential lists/],
    [[[]], /requiredCredentials\[0\] must list at least one credential/],
    [[['access_token'], 'system_user_token'], /requiredCredentials\[1\] must list at least one credential/],
    [[['api_key']], /requiredCredentials\[0\]: api_key is not one of the credentials/],
    [[['access_token', 'access_token']], /requiredCredentials\[0\] lists access_token twice/],
    [[['access_token'], ['access_token']], /requiredCredentials\[1\] contains all of requiredCredentials\[0\], so it is never needed/],
    [[['access_token', 'appsecret_proof'], ['access_token']], /requiredCredentials\[0\] contains all of requiredCredentials\[1\], so it is never needed/],
  ];
  for (const [requiredCredentials, message] of cases) {
    assert.throws(() => defineConnector({ ...base, requiredCredentials }), message, JSON.stringify(requiredCredentials));
  }

  // With no fixed origin, every list must bring the address the API lives at.
  const site = { ...base, origins: [], originFields: ['site_url'], credentials: ['site_url', 'access_token', 'app_password'] };
  assert.doesNotThrow(() => defineConnector({ ...site, requiredCredentials: [['site_url', 'access_token'], ['site_url', 'app_password']] }));
  assert.throws(
    () => defineConnector({ ...site, requiredCredentials: [['access_token'], ['site_url', 'app_password']] }),
    /requiredCredentials\[0\] needs an origin field: the module has no fixed origin, so a call made with only these credentials could reach nothing/,
  );
});

test('account pickers are checked when the module loads, and exported as given', () => {
  const listPages = { name: 'list_pages', kind: 'read', title: 'List', description: 'Lists Pages.', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false }, run: async () => ({}) };
  const getPage = { name: 'get_page', kind: 'read', title: 'Get', description: 'Gets a Page.', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'], additionalProperties: false }, run: async () => ({}) };
  const post = { name: 'create_post', kind: 'create', check: 'list_pages', title: 'Post', description: 'Posts.', inputSchema: READ_SCHEMA, run: async () => ({}) };
  const base = { vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['access_token'], tools: [listPages, getPage, post] };
  const pages = { key: 'pages', label: 'Acme Pages', description: 'The Pages the agent may post to.', multiple: true, tool: 'list_pages', idField: 'id', nameField: 'name', legacyField: 'pageid' };
  const owners = { key: 'owners', label: 'Acme owners', multiple: false, tool: 'list_pages', idField: 'owner.id', nameField: 'owner.profile.name' };

  const module = defineConnector({ ...base, accountPickers: [pages, owners] });
  assert.deepEqual(module.accountPickers, [pages, owners]);
  assert.deepEqual(Object.keys(module.accountPickers[1]), ['key', 'label', 'multiple', 'tool', 'idField', 'nameField'], 'optional fields only when given');
  assert.notEqual(module.accountPickers[0], pages, 'a copy');
  assert.ok(Object.isFrozen(module.accountPickers) && Object.isFrozen(module.accountPickers[0]));

  const cases = [
    [{}, /accountPickers must be a list/],
    [['pages'], /each account picker must be an object/],
    [[{ ...pages, key: 'Pages' }], /account picker "Pages": key must match \^\[a-z\]\[a-z0-9_\]\{0,63\}\$/],
    [[{ ...pages, key: undefined }], /account picker undefined: key must match/],
    [[pages, { ...owners, key: 'pages' }], /account picker pages is defined twice/],
    [[{ ...pages, idfield: 'id' }], /account picker pages: unknown field idfield \(expected: key, label, description, multiple, tool, idField, nameField, legacyField\)/],
    [[{ ...pages, label: ' ' }], /account picker pages: label is required/],
    [[{ ...pages, description: '' }], /account picker pages: description, when given, must be a text of 1 to 1024 characters/],
    [[{ ...pages, description: 'x'.repeat(1025) }], /description, when given, must be a text of 1 to 1024 characters/],
    [[{ ...pages, multiple: 'yes' }], /account picker pages: multiple must be true or false/],
    [[{ ...pages, tool: 'list_everything' }], /account picker pages: tool must be the name of a read tool/],
    [[{ ...pages, tool: 'create_post' }], /account picker pages: tool must be the name of a read tool/],
    [[{ ...pages, tool: 'get_page' }], /account picker pages: its tool get_page must take no required argument/],
    [[{ ...pages, idField: undefined }], /account picker pages: idField must be a dot path into each item the tool returns/],
    [[{ ...pages, idField: 'owner..id' }], /idField must be a dot path/],
    [[{ ...pages, idField: '.id' }], /idField must be a dot path/],
    [[{ ...pages, idField: 'page id' }], /idField must be a dot path/],
    [[{ ...pages, nameField: 'owner.__proto__' }], /account picker pages: nameField must be a dot path/],
    [[{ ...pages, nameField: 'constructor' }], /nameField must be a dot path/],
    [[{ ...pages, nameField: 'a.b.c.d.e.f.g' }], /nameField must be a dot path/],
    [[{ ...pages, legacyField: 'Page-ID' }], /account picker pages: legacyField, when given, must match/],
  ];
  for (const [accountPickers, message] of cases) {
    assert.throws(() => defineConnector({ ...base, accountPickers }), message, JSON.stringify(accountPickers));
  }
});

/** A connector a call may make with a token from an OAuth sign-in, or with a long-lived system token. */
function alternativesConnector(run = async (args, h) => (await h.api({ path: '/me' })).data) {
  return defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://api.acme.test'],
    credentials: ['access_token', 'system_user_token', 'appsecret_proof'],
    credentialLabels: { access_token: 'Acme access token', system_user_token: 'Acme system user token', appsecret_proof: 'Acme app secret proof' },
    requiredCredentials: [['access_token'], ['system_user_token']],
    authHeaders: (credentials) => ({ authorization: `Bearer ${credentials.access_token ?? credentials.system_user_token}` }),
    tools: [{ name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run }],
  });
}

test('a call goes ahead when one alternative is complete; otherwise it names the alternatives and sends nothing', async () => {
  const module = alternativesConnector();
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  for (const credentials of [{ access_token: 'token-1' }, { system_user_token: 'system-1' }, { access_token: 'token-2', appsecret_proof: 'proof' }]) {
    const { isError, payload } = await callTool(module, 'read_x', {}, makeContext({ credentials, fetch }).ctx);
    assert.equal(isError, false, payload.error);
  }
  assert.deepEqual(fetch.calls.map((call) => call.headers.authorization), ['Bearer token-1', 'Bearer system-1', 'Bearer token-2'], 'a credential in no list is optional');

  // A blank value counts as missing, and an optional credential completes nothing.
  const none = await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: '  ', appsecret_proof: 'proof' }, fetch }).ctx);
  assert.equal(none.isError, true);
  assert.equal(none.payload.error, 'Acme is not connected: it needs the Acme access token, or the Acme system user token.');
  assert.equal(fetch.calls.length, 3, 'nothing was sent');
});

test('the message names only what each alternative still lacks, once each', async () => {
  const module = defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://api.acme.test'],
    credentials: ['access_token', 'username', 'app_password', 'api_token'],
    credentialLabels: { access_token: 'Acme access token', username: 'Acme user name', app_password: 'Acme app password', api_token: 'Acme API token' },
    requiredCredentials: [['access_token'], ['username', 'app_password'], ['username', 'api_token']],
    tools: [{ name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run: async () => ({}) }],
  });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const cases = [
    [{}, 'Acme is not connected: it needs the Acme access token, the Acme user name and Acme app password, or the Acme user name and Acme API token.'],
    [{ username: 'alice' }, 'Acme is not connected: it needs the Acme access token, the Acme app password, or the Acme API token.'],
    [{ app_password: 'p', api_token: 't' }, 'Acme is not connected: it needs the Acme access token, or the Acme user name.'],
  ];
  for (const [credentials, message] of cases) {
    const { payload } = await callTool(module, 'read_x', {}, makeContext({ credentials, fetch }).ctx);
    assert.equal(payload.error, message, JSON.stringify(credentials));
  }
  assert.equal(fetch.calls.length, 0);
});

test('a 401 names the credentials the call went ahead with, not every one the module reads', async () => {
  const module = alternativesConnector();
  const rejected = fakeFetch(() => jsonResponse(401, {}));
  const token = await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: 't', appsecret_proof: 'p' }, fetch: rejected }).ctx);
  assert.equal(token.payload.error, 'Acme rejected the credentials (HTTP 401). Check that the Acme access token is correct and still active.');
  const system = await callTool(module, 'read_x', {}, makeContext({ credentials: { system_user_token: 's' }, fetch: rejected }).ctx);
  assert.equal(system.payload.error, 'Acme rejected the credentials (HTTP 401). Check that the Acme system user token is correct and still active.');

  // By default every credential is in use.
  const pair = defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://api.acme.test'],
    credentials: ['handle', 'app_password'],
    credentialLabels: { handle: 'Acme handle', app_password: 'Acme app password' },
    tools: [{ name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run: async (args, h) => h.api({ path: '/me' }) }],
  });
  const both = await callTool(pair, 'read_x', {}, makeContext({ credentials: { handle: 'h', app_password: 'p' }, fetch: rejected }).ctx);
  assert.equal(both.payload.error, 'Acme rejected the credentials (HTTP 401). Check that the Acme handle and Acme app password are correct and still active.');
});

test('an origin field the call goes ahead without may be empty, and then gives no origin', async () => {
  const module = defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: ['https://public-api.acme.test'],
    originFields: ['site_url'],
    credentials: ['access_token', 'site_url', 'app_password'],
    credentialLabels: { site_url: 'Acme site URL' },
    requiredCredentials: [['access_token'], ['site_url', 'app_password']],
    tools: [
      { name: 'read_x', kind: 'read', title: 'Read', description: 'Reads.', inputSchema: READ_SCHEMA, run: async (args, h) => {
        await h.api({ path: '/me', origin: h.origins.at(-1) });
        return { origins: h.origins };
      } },
      { name: 'read_site', kind: 'read', title: 'Site', description: 'Reads the site.', inputSchema: READ_SCHEMA, run: async (args, h) => h.api({ path: '/', origin: h.originOf('site_url') }) },
    ],
  });
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const token = await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: 't' }, fetch }).ctx);
  assert.deepEqual(token.payload, { origins: ['https://public-api.acme.test'] });
  const site = await callTool(module, 'read_x', {}, makeContext({ credentials: { site_url: 'blog.example', app_password: 'p' }, fetch }).ctx);
  assert.deepEqual(site.payload, { origins: ['https://public-api.acme.test', 'https://blog.example'] });
  assert.deepEqual(fetch.calls.map((call) => call.url), ['https://public-api.acme.test/me', 'https://blog.example/me']);

  // A site URL that is given must still be a good one, even beside the token.
  const bad = await callTool(module, 'read_x', {}, makeContext({ credentials: { access_token: 't', site_url: 'http://blog.example' }, fetch }).ctx);
  assert.equal(bad.payload.error, 'Acme is not connected correctly: the Acme site URL must be an https address, not http://. Nothing was sent to Acme.');
  // Asking for the origin of an empty field is a module error, never a request.
  const empty = await callTool(module, 'read_site', {}, makeContext({ credentials: { access_token: 't' }, fetch }).ctx);
  assert.equal(empty.payload.error, 'read_site failed unexpectedly.');
  assert.equal(fetch.calls.length, 2);
});
