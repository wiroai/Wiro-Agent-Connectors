import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, loadModule, makeContext } from './helpers.mjs';

// The stdio CLI's ctx.fetch: origin lock, size caps, timeouts, and the SSRF
// guard on media downloads. DNS and the media transport are replaced, so no
// test touches the network.

const require = createRequire(import.meta.url);
const { createGuardedFetch, isPublicAddress, originsFromCredentials } = require('../dist/host/index.js');
const { defineConnector } = require('../build/core.js');

const ORIGINS = ['https://api.vendor.test'];

/** A fake DNS: hostname -> addresses. */
function fakeResolve(table) {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/** A fake media transport: url -> { status, headers, body }. Records what it was asked to connect to. */
function fakeTransport(routes) {
  const requests = [];
  const transport = async (request) => {
    requests.push({ url: request.url.toString(), address: request.address.address, headers: request.headers, method: request.method, body: request.body });
    const route = routes[request.url.toString()];
    if (!route) throw new Error(`no route for ${request.url}`);
    const reply = typeof route === 'function' ? route(request) : route;
    const body = reply.body ?? new Uint8Array(0);
    return {
      status: reply.status,
      headers: reply.headers ?? {},
      body: (async function* chunks() {
        for (let index = 0; index < body.length; index += 4) yield body.subarray(index, index + 4);
      })(),
      destroy() {},
    };
  };
  transport.requests = requests;
  return transport;
}

async function refusedWith(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('public and non-public addresses', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:c0a8:0101::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', '::127.0.0.1', 'not-an-ip', '',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('an API request goes to the origin as given, without following redirects, with a timeout signal', async () => {
  const seen = [];
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    apiFetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await fetch('https://api.vendor.test/v1/things?x=1', { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{}' });
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(seen[0].url, 'https://api.vendor.test/v1/things?x=1');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});

test('an API reply over the size cap fails while it is read', async () => {
  const fetch = createGuardedFetch({ origins: ORIGINS, maxResponseBytes: 10, apiFetch: async () => new Response('x'.repeat(50)) });
  const response = await fetch('https://api.vendor.test/big');
  await refusedWith(response.text(), 'TOO_LARGE');
  const declared = createGuardedFetch({ origins: ORIGINS, maxResponseBytes: 10, apiFetch: async () => new Response('x', { headers: { 'content-length': '999' } }) });
  await refusedWith(declared('https://api.vendor.test/big'), 'TOO_LARGE');
});

test('an API request that hangs times out', async () => {
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    timeoutMs: 50,
    // A real request keeps the event loop alive; this stand-in holds a timer for it.
    apiFetch: (url, init) => new Promise((resolve, reject) => {
      const alive = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(alive);
        reject(init.signal.reason);
      });
    }),
  });
  await refusedWith(fetch('https://api.vendor.test/slow'), 'TIMEOUT');
});

test('anything but GET or HEAD to another origin is refused before it is sent', async () => {
  const transport = fakeTransport({});
  const fetch = createGuardedFetch({ origins: ORIGINS, mediaTransport: transport, resolve: fakeResolve({}) });
  await refusedWith(fetch('https://elsewhere.test/collect', { method: 'POST', body: 'secrets' }), 'URL_REFUSED', /not an API origin/);
  await refusedWith(fetch('http://cdn.test/a.png'), 'URL_REFUSED', /only https/);
  await refusedWith(fetch('file:///etc/passwd'), 'URL_REFUSED');
  await refusedWith(fetch('https://user:pass@cdn.test/a.png'), 'URL_REFUSED', /user name or password/);
  await refusedWith(fetch('not a url'), 'URL_REFUSED');
  assert.equal(transport.requests.length, 0);
});

test('a media URL on a private, loopback or link-local address is refused, literal or resolved', async () => {
  const transport = fakeTransport({});
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    mediaTransport: transport,
    resolve: fakeResolve({
      'intranet.test': ['10.0.0.7'],
      'mixed.test': ['93.184.216.34', '192.168.0.10'],
      'v6local.test': ['fd00::5'],
    }),
  });
  for (const url of [
    'https://127.0.0.1/a.png',
    'https://10.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::ffff:127.0.0.1]/a.png',
    'https://intranet.test/a.png',
    'https://mixed.test/a.png',
    'https://v6local.test/a.png',
  ]) {
    await refusedWith(fetch(url), 'URL_REFUSED', /not a public internet address/);
  }
  assert.equal(transport.requests.length, 0, 'nothing was connected to');
});

test('every redirect is checked again: to a private host, to plain http, or too many', async () => {
  const transport = fakeTransport({
    'https://cdn.test/private': { status: 302, headers: { location: 'https://intranet.test/secret' } },
    'https://cdn.test/metadata': { status: 301, headers: { location: 'https://169.254.169.254/latest/meta-data/' } },
    'https://cdn.test/downgrade': { status: 307, headers: { location: 'http://cdn.test/a.png' } },
    'https://cdn.test/loop': { status: 302, headers: { location: '/loop' } },
  });
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    maxRedirects: 3,
    mediaTransport: transport,
    resolve: fakeResolve({ 'cdn.test': ['93.184.216.34'], 'intranet.test': ['10.0.0.7'] }),
  });
  await refusedWith(fetch('https://cdn.test/private'), 'URL_REFUSED', /intranet\.test is not a public internet address/);
  await refusedWith(fetch('https://cdn.test/metadata'), 'URL_REFUSED', /169\.254\.169\.254 is not a public internet address/);
  await refusedWith(fetch('https://cdn.test/downgrade'), 'URL_REFUSED', /only https/);
  await refusedWith(fetch('https://cdn.test/loop'), 'URL_REFUSED', /more than 3 redirects/);
  assert.equal(transport.requests.some((request) => request.address === '10.0.0.7' || request.address === '169.254.169.254'), false);
});

test('a media download connects to the checked address, sends no credentials, and is capped', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
  const transport = fakeTransport({
    'https://cdn.test/a.png': { status: 200, headers: { 'content-type': 'image/png' }, body: png },
    'https://cdn.test/redirect': { status: 302, headers: { location: 'https://cdn.test/a.png' } },
    'https://cdn.test/huge': { status: 200, headers: {}, body: new Uint8Array(64) },
    'https://cdn.test/declared': { status: 200, headers: { 'content-length': '999999' }, body: new Uint8Array(1) },
  });
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    maxMediaBytes: 32,
    mediaTransport: transport,
    resolve: fakeResolve({ 'cdn.test': ['93.184.216.34'] }),
  });
  const response = await fetch('https://cdn.test/redirect', { headers: { accept: 'image/*', authorization: 'Bearer secret', 'api-key': 'secret', cookie: 'a=b' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  for (const request of transport.requests) {
    assert.equal(request.address, '93.184.216.34');
    assert.deepEqual(request.headers, { accept: 'image/*' });
  }
  await refusedWith(fetch('https://cdn.test/huge'), 'TOO_LARGE');
  await refusedWith(fetch('https://cdn.test/declared'), 'TOO_LARGE');
});

test('a module behind the guard reports a refused image plainly and posts nothing', async () => {
  const { module } = loadModule('bluesky');
  const apiCalls = [];
  const fetch = createGuardedFetch({
    origins: module.origins,
    apiFetch: async (url) => {
      apiCalls.push(String(url));
      return new Response('{}', { status: 500 });
    },
    mediaTransport: fakeTransport({}),
    resolve: fakeResolve({ 'images.attacker.test': ['127.0.0.1'] }),
  });
  const { ctx } = makeContext({ credentials: { handle: 'alice.bsky.social', apppassword: 'abcd-efgh-ijkl-mnop' }, fetch });
  const { payload, isError } = await callTool(module, 'create_post', { text: 'hi', image_url: 'https://images.attacker.test/x.png', image_alt: 'x' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /The image URL was refused \(images\.attacker\.test is not a public internet address\)\. Use a public https URL\. Nothing was changed\./);
  assert.deepEqual(apiCalls, [], 'not even a sign-in was sent');
});

// Credential origins: an API on a site the user named (an instance, a blog, a shop).

const SITE = 'https://social.example';
const encoder = new TextEncoder();

test('originsFromCredentials resolves a connection\'s site URLs with the modules\' own rule', () => {
  const module = { originFields: ['instance_url', 'shop_url'] };
  assert.deepEqual(
    originsFromCredentials(module, { instance_url: 'Social.Example', shop_url: 'https://shop.example/admin', api_key: 'k' }),
    ['https://social.example', 'https://shop.example'],
  );
  assert.deepEqual(originsFromCredentials(module, { instance_url: 'http://social.example', shop_url: 'https://user:pw@shop.example' }), [], 'refused values are left out');
  assert.deepEqual(originsFromCredentials(module, {}), []);
  assert.deepEqual(originsFromCredentials({}, { instance_url: 'social.example' }), [], 'a module without originFields');
});

test('a credential origin given to the guard must be an https origin', () => {
  for (const origin of ['http://social.example', 'https://social.example/api', 'social.example']) {
    assert.throws(() => createGuardedFetch({ origins: ORIGINS, credentialOrigins: [origin] }), /must be an https origin/, origin);
  }
});

test('an API request to a credential origin on a non-public address is refused, and nothing is sent', async () => {
  const transport = fakeTransport({});
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    credentialOrigins: ['https://intranet.example', 'https://mixed.example', 'https://127.0.0.1', 'https://[fd00::1]', 'https://169.254.169.254', SITE],
    transport,
    resolve: fakeResolve({ 'intranet.example': ['10.0.0.7'], 'mixed.example': ['93.184.216.34', '192.168.1.5'], 'social.example': ['93.184.216.34'] }),
    apiFetch: async () => {
      throw new Error('a credential origin never goes through the plain API fetch');
    },
  });
  for (const url of ['https://intranet.example/api', 'https://mixed.example/api', 'https://127.0.0.1/api', 'https://[fd00::1]/api', 'https://169.254.169.254/latest/meta-data/']) {
    await refusedWith(fetch(url, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{}' }), 'URL_REFUSED', /is not a public internet address/);
  }
  await refusedWith(fetch('https://user:pass@social.example/api'), 'URL_REFUSED', /user name or password/);
  await refusedWith(fetch('https://unlisted.example/api', { method: 'POST', body: '{}' }), 'URL_REFUSED', /not an API origin/);
  assert.equal(transport.requests.length, 0, 'nothing was connected to');
});

test('an API request to a credential origin goes to the checked address with its method, headers and body', async () => {
  const transport = fakeTransport({
    [`${SITE}/api/v1/statuses?visibility=public`]: { status: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode('{"id":"110"}') },
    [`${SITE}/api/v1/statuses/110`]: { status: 204, headers: {} },
  });
  const fetch = createGuardedFetch({ origins: ORIGINS, credentialOrigins: [SITE], transport, resolve: fakeResolve({ 'social.example': ['93.184.216.34', '2606:4700::6810:84e5'] }) });
  const response = await fetch(`${SITE}/api/v1/statuses?visibility=public`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: '{"status":"hello"}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: '110' });
  assert.deepEqual(transport.requests[0], {
    url: `${SITE}/api/v1/statuses?visibility=public`,
    address: '93.184.216.34',
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: '{"status":"hello"}',
  });
  const deleted = await fetch(`${SITE}/api/v1/statuses/110`, { method: 'delete', headers: { authorization: 'Bearer k' } });
  assert.equal(deleted.status, 204);
  assert.equal(transport.requests[1].method, 'DELETE');
});

test('a redirect from a credential origin comes back as it is and is never followed', async () => {
  const transport = fakeTransport({
    [`${SITE}/api/v1/me`]: { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' }, body: encoder.encode('moved') },
  });
  const fetch = createGuardedFetch({ origins: ORIGINS, credentialOrigins: [SITE], transport, resolve: fakeResolve({ 'social.example': ['93.184.216.34'] }) });
  const response = await fetch(`${SITE}/api/v1/me`, { headers: { authorization: 'Bearer k' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://169.254.169.254/latest/meta-data/');
  assert.equal(transport.requests.length, 1);
});

test('a credential origin reply is capped and timed out like any API reply', async () => {
  const transport = fakeTransport({
    [`${SITE}/big`]: { status: 200, headers: {}, body: new Uint8Array(64) },
    [`${SITE}/declared`]: { status: 200, headers: { 'content-length': '999999' }, body: new Uint8Array(1) },
  });
  const capped = createGuardedFetch({ origins: ORIGINS, credentialOrigins: [SITE], maxResponseBytes: 32, transport, resolve: fakeResolve({ 'social.example': ['93.184.216.34'] }) });
  await refusedWith(capped(`${SITE}/big`), 'TOO_LARGE', /the reply is larger than 32 bytes/);
  await refusedWith(capped(`${SITE}/declared`), 'TOO_LARGE');

  const hanging = createGuardedFetch({
    origins: ORIGINS,
    credentialOrigins: [SITE],
    timeoutMs: 50,
    resolve: fakeResolve({ 'social.example': ['93.184.216.34'] }),
    transport: ({ signal }) => new Promise((resolve, reject) => {
      const alive = setTimeout(() => {}, 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(alive);
        reject(signal.reason);
      });
    }),
  });
  await refusedWith(hanging(`${SITE}/slow`, { method: 'POST', body: '{}' }), 'TIMEOUT');
});

test('a fixed origin keeps the plain API path even when a credential names it too', async () => {
  const seen = [];
  const fetch = createGuardedFetch({
    origins: ORIGINS,
    credentialOrigins: [ORIGINS[0]],
    apiFetch: async (url) => {
      seen.push(String(url));
      return new Response('{}');
    },
    transport: fakeTransport({}),
    resolve: fakeResolve({}),
  });
  await fetch(`${ORIGINS[0]}/v1/things`);
  assert.deepEqual(seen, [`${ORIGINS[0]}/v1/things`]);
});

test('a module with an origin field, behind the guard: a private site is refused, a public one is reached', async () => {
  const module = defineConnector({
    vendor: 'acme',
    label: 'Acme',
    origins: [],
    originFields: ['instance_url'],
    credentials: ['instance_url', 'access_token'],
    authHeaders: (credentials) => ({ authorization: `Bearer ${credentials.access_token}` }),
    tools: [{
      name: 'get_me',
      kind: 'read',
      title: 'Get me',
      description: 'Reads the account.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (args, h) => (await h.api({ path: '/api/v1/accounts/verify_credentials' })).data,
    }],
  });
  const transport = fakeTransport({ [`${SITE}/api/v1/accounts/verify_credentials`]: { status: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode('{"acct":"alice"}') } });
  const resolve = fakeResolve({ 'social.example': ['93.184.216.34'], 'intranet.example': ['10.0.0.7'] });
  const run = async (instanceUrl) => {
    const credentials = { instance_url: instanceUrl, access_token: 'token-1' };
    const fetch = createGuardedFetch({ origins: module.origins, credentialOrigins: originsFromCredentials(module, credentials), transport, resolve });
    return callTool(module, 'get_me', {}, makeContext({ credentials, fetch }).ctx);
  };

  const refused = await run('https://intranet.example');
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.error, 'The request to Acme was blocked before it was sent (intranet.example is not a public internet address).');
  assert.equal(transport.requests.length, 0);

  const reached = await run('social.example');
  assert.equal(reached.isError, false, reached.payload.error);
  assert.deepEqual(reached.payload, { acct: 'alice' });
  assert.equal(transport.requests[0].headers.authorization, 'Bearer token-1');
});
