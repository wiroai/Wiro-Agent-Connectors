import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { callTool, loadModule, makeContext } from './helpers.mjs';

// The stdio CLI's ctx.fetch: origin lock, size caps, timeouts, and the SSRF
// guard on media downloads. DNS and the media transport are replaced, so no
// test touches the network.

const require = createRequire(import.meta.url);
const { createGuardedFetch, isPublicAddress } = require('../dist/host/index.js');

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
    requests.push({ url: request.url.toString(), address: request.address.address, headers: request.headers, method: request.method });
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
  const { ctx } = makeContext({ credentials: { identifier: 'alice.bsky.social', app_password: 'abcd-efgh-ijkl-mnop' }, fetch });
  const { payload, isError } = await callTool(module, 'create_post', { text: 'hi', image_url: 'https://images.attacker.test/x.png', image_alt: 'x' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /The image URL was refused \(images\.attacker\.test is not a public internet address\)\. Use a public https URL\. Nothing was changed\./);
  assert.deepEqual(apiCalls, [], 'not even a sign-in was sent');
});
