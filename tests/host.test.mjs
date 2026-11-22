import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// The host building blocks other programs use: the module check and the
// environment mapping of the CLI.

const require = createRequire(import.meta.url);
const { ACCESS_TOKEN_CREDENTIAL, assertConnectorModule, credentialsFromEnv, envNameFor } = require('../dist/host/index.js');

const base = { vendor: 'acme', origins: ['https://api.acme.test'], originFields: [], credentials: ['api_key'], tools: [], call: async () => ({ content: [] }) };

test('a module may name its API by an origin field instead of a fixed origin, but must name one', () => {
  assert.doesNotThrow(() => assertConnectorModule(base, 'acme'));
  assert.doesNotThrow(() => assertConnectorModule({ ...base, origins: [], originFields: ['site_url'], credentials: ['site_url'] }, 'acme'));
  const { originFields: _none, ...older } = base;
  assert.doesNotThrow(() => assertConnectorModule(older, 'acme'), 'a module built before originFields existed');
  assert.throws(() => assertConnectorModule({ ...base, origins: [] }, 'acme'), /it names no origins/);
  assert.throws(() => assertConnectorModule({ ...base, originFields: ['site_url'] }, 'acme'), /an origin field is not one of its credentials/);
  assert.throws(() => assertConnectorModule({ ...base, originFields: 'site_url' }, 'acme'), /originFields is not a list/);
});

test('the CLI reads each credential from <VENDOR>_<CREDENTIAL>, and an OAuth access token from <VENDOR>_ACCESS_TOKEN', () => {
  assert.equal(ACCESS_TOKEN_CREDENTIAL, 'access_token');
  assert.equal(envNameFor('google-ads', 'access_token'), 'GOOGLE_ADS_ACCESS_TOKEN');
  const oauth = { vendor: 'google-ads', credentials: ['access_token', 'developer_token'] };
  assert.deepEqual(
    credentialsFromEnv(oauth, { GOOGLE_ADS_ACCESS_TOKEN: ' token-1 ', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-1' }),
    { credentials: { access_token: 'token-1', developer_token: 'dev-1' }, missing: [] },
  );
  assert.deepEqual(credentialsFromEnv(oauth, { GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-1' }).missing, ['GOOGLE_ADS_ACCESS_TOKEN'], 'declared, it is required');

  // Not declared, it is passed along when set, as hosts pass a connection's token, and never required.
  const keyed = { vendor: 'acme', credentials: ['api_key'] };
  assert.deepEqual(credentialsFromEnv(keyed, { ACME_API_KEY: 'k', ACME_ACCESS_TOKEN: 't' }), { credentials: { api_key: 'k', access_token: 't' }, missing: [] });
  assert.deepEqual(credentialsFromEnv(keyed, { ACME_API_KEY: 'k', ACME_ACCESS_TOKEN: '  ' }), { credentials: { api_key: 'k' }, missing: [] });
});
