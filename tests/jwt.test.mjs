import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { loadSandboxed } from '../scripts/module-sandbox.mjs';
import { callTool, controlClock, fakeFetch, jsonResponse, makeContext, ROOT } from './helpers.mjs';

// JWT signing with WebCrypto, for Google service accounts (RS256) and App
// Store Connect keys (ES256). The core runs in the module sandbox, with
// web-standard globals only. The keys are made here, for this run: no key is
// ever stored in the repository.

const { module: core, context } = loadSandboxed(path.join(ROOT, 'build', 'core.js'));
const { appStoreConnectToken, defineConnector, googleServiceAccountToken, signJwt, ToolFailure } = core;

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const EC_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });

function decode(jwt) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    signature: Buffer.from(signature, 'base64url'),
    signed: Buffer.from(`${header}.${payload}`),
  };
}

async function refusedWith(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ToolFailure, String(error));
    assert.match(error.message, message);
    return true;
  });
}

test('RS256: a PKCS#8 RSA key signs a JWT that its public key verifies', async () => {
  const jwt = await signJwt({ algorithm: 'RS256', privateKey: RSA_PEM, header: { kid: 'key-1', alg: 'none' }, payload: { iss: 'a', n: 1 } });
  const { header, payload, signature, signed } = decode(jwt);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'key-1' }, 'alg cannot be overridden');
  assert.deepEqual(payload, { iss: 'a', n: 1 });
  assert.equal(verify('sha256', signed, rsa.publicKey, signature), true);
});

test('ES256: a P-256 key signs with the raw r||s signature JWS needs', async () => {
  const jwt = await signJwt({ algorithm: 'ES256', privateKey: EC_PEM, payload: { sub: 'x' } });
  const { header, signature, signed } = decode(jwt);
  assert.deepEqual(header, { alg: 'ES256', typ: 'JWT' });
  assert.equal(signature.length, 64, 'r and s, 32 bytes each, not DER');
  assert.equal(verify('sha256', signed, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
});

test('a key pasted with literal \\n sequences, as in a JSON file, is read too', async () => {
  const escaped = RSA_PEM.trim().split('\n').join('\\n');
  const jwt = await signJwt({ algorithm: 'RS256', privateKey: escaped, payload: {} });
  const { signature, signed } = decode(jwt);
  assert.equal(verify('sha256', signed, rsa.publicKey, signature), true);
});

test('a key that cannot be used is refused with what to do, and never quoted', async () => {
  const pkcs1 = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const encrypted = rsa.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' });
  await refusedWith(signJwt({ algorithm: 'RS256', privateKey: pkcs1, payload: {} }), /is a "RSA PRIVATE KEY" block, not a PKCS#8 "PRIVATE KEY": convert it with openssl pkcs8 -topk8 -nocrypt\. Nothing was sent\./);
  await refusedWith(signJwt({ algorithm: 'RS256', privateKey: encrypted, payload: {} }), /is encrypted with a passphrase/);
  await refusedWith(signJwt({ algorithm: 'ES256', privateKey: p384, payload: {}, keyName: 'App Store Connect private key' }), /^The App Store Connect private key is not a P-256 \(ES256\) private key\. Nothing was sent\.$/);
  await refusedWith(signJwt({ algorithm: 'ES256', privateKey: RSA_PEM, payload: {} }), /is not a P-256 \(ES256\) private key/);
  await refusedWith(signJwt({ algorithm: 'RS256', privateKey: EC_PEM, payload: {} }), /is not an RSA private key/);
  for (const garbage of ['', 'not a key', '-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----']) {
    await assert.rejects(signJwt({ algorithm: 'RS256', privateKey: garbage, payload: {} }), (error) => {
      assert.match(error.message, /^The private key could not be read: it must be the whole PEM text/);
      assert.equal(error.message.includes('!!!'), false);
      return true;
    });
  }
});

test('App Store Connect: ES256 with kid, iss, aud appstoreconnect-v1 and a 20-minute expiry', async () => {
  const before = Math.floor(Date.now() / 1000);
  const team = decode(await appStoreConnectToken({ issuerId: '57246542-96fe-1a63-e053-0824d011072a', keyId: '2X9R4HXF34', privateKey: EC_PEM }));
  assert.deepEqual(team.header, { alg: 'ES256', typ: 'JWT', kid: '2X9R4HXF34' });
  assert.equal(team.payload.iss, '57246542-96fe-1a63-e053-0824d011072a');
  assert.equal(team.payload.aud, 'appstoreconnect-v1');
  assert.ok(team.payload.iat >= before && team.payload.iat <= before + 5);
  assert.equal(team.payload.exp - team.payload.iat, 20 * 60);
  assert.equal(verify('sha256', team.signed, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, team.signature), true);

  const individual = decode(await appStoreConnectToken({ keyId: '2X9R4HXF34', privateKey: EC_PEM }));
  assert.equal(individual.payload.sub, 'user');
  assert.equal(individual.payload.iss, undefined);
});

// A Google module: the token exchange, then a read of the API with the token.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

function serviceAccount(overrides = {}) {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'kid-0123456789',
    private_key: RSA_PEM,
    client_email: 'reporter@example-project.iam.gserviceaccount.com',
    token_uri: 'https://attacker.example/token',
    ...overrides,
  });
}

const googleModule = defineConnector({
  vendor: 'acme-analytics',
  label: 'Acme Analytics',
  origins: ['https://analyticsdata.googleapis.com', 'https://oauth2.googleapis.com'],
  credentials: ['serviceaccountjson'],
  tools: [{
    name: 'run_report',
    kind: 'read',
    title: 'Run a report',
    description: 'Runs a report.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' } }, additionalProperties: false },
    async run(args, h) {
      const token = await googleServiceAccountToken(h, h.credentials.serviceaccountjson, { scopes: SCOPES, ...(args.subject ? { subject: args.subject } : {}) });
      const { data } = await h.api({ origin: 'https://analyticsdata.googleapis.com', path: '/v1beta/properties/1:runReport', method: 'POST', json: {}, safe: true, headers: { authorization: `Bearer ${token}` } });
      return data;
    },
  }],
});

function googleSetup(tokenReply = () => jsonResponse(200, { access_token: 'ya29.token-1', expires_in: 3599, token_type: 'Bearer' })) {
  let issued = 0;
  const fetch = fakeFetch((request) => {
    if (request.url === TOKEN_URL) {
      issued++;
      return tokenReply(request, issued);
    }
    return jsonResponse(200, { rows: [], token: request.headers.authorization });
  });
  return { fetch, tokenCalls: () => fetch.calls.filter((call) => call.url === TOKEN_URL) };
}

test('a service account key is exchanged for a token at Google\'s fixed token URL, with a signed jwt-bearer assertion', async () => {
  const { fetch, tokenCalls } = googleSetup();
  const { ctx, logs } = makeContext({ credentials: { serviceaccountjson: serviceAccount() }, fetch });
  const { payload, isError } = await callTool(googleModule, 'run_report', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(payload.token, 'Bearer ya29.token-1');

  const [exchange] = tokenCalls();
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(exchange.headers.authorization, undefined);
  const form = new URLSearchParams(new TextDecoder().decode(exchange.body));
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = decode(form.get('assertion'));
  assert.deepEqual(assertion.header, { alg: 'RS256', typ: 'JWT', kid: 'kid-0123456789' });
  assert.equal(assertion.payload.iss, 'reporter@example-project.iam.gserviceaccount.com');
  assert.equal(assertion.payload.scope, SCOPES[0]);
  assert.equal(assertion.payload.aud, TOKEN_URL, 'the key file\'s own token_uri is never used');
  assert.equal(assertion.payload.exp - assertion.payload.iat, 3600);
  assert.equal(assertion.payload.sub, undefined);
  assert.equal(verify('sha256', assertion.signed, rsa.publicKey, assertion.signature), true);

  const all = logs.join('\n');
  for (const secret of ['ya29', 'BEGIN PRIVATE KEY', form.get('assertion').slice(0, 40)]) assert.equal(all.includes(secret), false, secret);
});

test('the token is reused from memory until shortly before it expires, and parallel calls share one exchange', async () => {
  const advance = controlClock(context);
  const { fetch, tokenCalls } = googleSetup((request, issued) => jsonResponse(200, { access_token: `ya29.token-${issued}`, expires_in: 3599 }));
  const { ctx } = makeContext({ credentials: { serviceaccountjson: serviceAccount({ client_email: 'cache@example-project.iam.gserviceaccount.com' }) }, fetch });
  await Promise.all([callTool(googleModule, 'run_report', {}, ctx), callTool(googleModule, 'run_report', {}, ctx), callTool(googleModule, 'run_report', {}, ctx)]);
  assert.equal(tokenCalls().length, 1, 'one exchange for three parallel calls');
  advance(50 * 60 * 1000);
  assert.equal((await callTool(googleModule, 'run_report', {}, ctx)).payload.token, 'Bearer ya29.token-1');
  assert.equal(tokenCalls().length, 1, 'still fresh after 50 minutes');
  advance(6 * 60 * 1000);
  assert.equal((await callTool(googleModule, 'run_report', {}, ctx)).payload.token, 'Bearer ya29.token-2');
  assert.equal(tokenCalls().length, 2, 'renewed 5 minutes before expiry');

  await callTool(googleModule, 'run_report', { subject: 'admin@example.com' }, ctx);
  assert.equal(tokenCalls().length, 3, 'another subject is another token');
  assert.equal(decode(new URLSearchParams(new TextDecoder().decode(tokenCalls()[2].body)).get('assertion')).payload.sub, 'admin@example.com');
  const other = makeContext({ credentials: { serviceaccountjson: serviceAccount({ client_email: 'other@example-project.iam.gserviceaccount.com' }) }, fetch });
  await callTool(googleModule, 'run_report', {}, other.ctx);
  assert.equal(tokenCalls().length, 4, 'another key is another token');
});

test('Google\'s refusal is passed on plainly and nothing is cached; a bad key file sends nothing', async () => {
  const { fetch, tokenCalls } = googleSetup(() => jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
  const { ctx } = makeContext({ credentials: { serviceaccountjson: serviceAccount({ client_email: 'revoked@example-project.iam.gserviceaccount.com' }) }, fetch });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { payload, isError } = await callTool(googleModule, 'run_report', {}, ctx);
    assert.equal(isError, true);
    assert.equal(payload.error, 'Google did not accept the service account key (HTTP 400). Acme Analytics said: "Invalid JWT Signature.".');
    assert.equal(payload.vendorCode, 'invalid_grant');
    assert.equal(tokenCalls().length, attempt, 'a refusal is not cached');
  }

  const bad = googleSetup();
  for (const [value, message] of [
    ['{"client_email": "x@example.com"}', /^The service account key is not a Google service account key file/],
    ['not json', /^The service account key is not a Google service account key file/],
    [JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: 'y' }), /^The Google key is a "authorized_user" credential, not a service account key/],
    [serviceAccount({ private_key: 'garbage' }), /^The service account private key could not be read/],
  ]) {
    const { payload } = await callTool(googleModule, 'run_report', {}, makeContext({ credentials: { serviceaccountjson: value }, fetch: bad.fetch }).ctx);
    assert.match(payload.error, message);
  }
  assert.equal(bad.fetch.calls.length, 0);
});
