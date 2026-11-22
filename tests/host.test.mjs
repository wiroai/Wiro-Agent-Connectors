import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The host building blocks other programs use: the module check, the
// environment mapping of the CLI, and what its --list prints.

const require = createRequire(import.meta.url);
const { ACCESS_TOKEN_CREDENTIAL, assertConnectorModule, createConnectorServer, credentialsFromEnv, DEFAULT_MAX_FILE_BYTES, envNameFor } = require('../dist/host/index.js');
const { describeConnector, describeNeeded } = require('../dist/host/describe.js');
const { defineConnector } = require('../build/core.js');

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

test('the module check reads uploadHosts, and accepts a module built before them', () => {
  assert.doesNotThrow(() => assertConnectorModule({ ...base, uploadHosts: ['.blobstore.apple.com', 'uploads.example.com'] }, 'acme'));
  assert.doesNotThrow(() => assertConnectorModule({ ...base, uploadHosts: [] }, 'acme'));
  assert.doesNotThrow(() => assertConnectorModule(base, 'acme'), 'a module built before uploadHosts existed');
  for (const uploadHosts of ['.blobstore.apple.com', [7], ['.com'], ['Uploads.Example.com'], ['93.184.216.34'], ['uploads.example.com', 'uploads.example.com']]) {
    assert.throws(() => assertConnectorModule({ ...base, uploadHosts }, 'acme'), /uploadHosts is not a list of distinct host names/, JSON.stringify(uploadHosts));
  }
});

test('the CLI reads each credential from <VENDOR>_<CREDENTIAL>, and an OAuth access token from <VENDOR>_ACCESS_TOKEN', () => {
  assert.equal(ACCESS_TOKEN_CREDENTIAL, 'access_token');
  assert.equal(envNameFor('google-ads', 'access_token'), 'GOOGLE_ADS_ACCESS_TOKEN');
  const oauth = { vendor: 'google-ads', credentials: ['access_token', 'developer_token'] };
  assert.deepEqual(
    credentialsFromEnv(oauth, { GOOGLE_ADS_ACCESS_TOKEN: ' token-1 ', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-1' }),
    { credentials: { access_token: 'token-1', developer_token: 'dev-1' }, missing: [], needed: [] },
  );
  assert.deepEqual(credentialsFromEnv(oauth, { GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-1' }).missing, ['GOOGLE_ADS_ACCESS_TOKEN'], 'declared, it is required');

  // Not declared, it is passed along when set, as hosts pass a connection's token, and never required.
  const keyed = { vendor: 'acme', credentials: ['api_key'] };
  assert.deepEqual(credentialsFromEnv(keyed, { ACME_API_KEY: 'k', ACME_ACCESS_TOKEN: 't' }), { credentials: { api_key: 'k', access_token: 't' }, missing: [], needed: [] });
  assert.deepEqual(credentialsFromEnv(keyed, { ACME_API_KEY: 'k', ACME_ACCESS_TOKEN: '  ' }), { credentials: { api_key: 'k' }, missing: [], needed: [] });
});

test('with alternatives, the CLI needs one complete list, and names what each one lacks', () => {
  const meta = { vendor: 'meta-ads', credentials: ['access_token', 'system_user_token', 'appsecret_proof'], requiredCredentials: [['access_token'], ['system_user_token']] };
  assert.deepEqual(
    credentialsFromEnv(meta, { META_ADS_SYSTEM_USER_TOKEN: ' system-1 ' }),
    { credentials: { system_user_token: 'system-1' }, missing: [], needed: [] },
    'one complete list is enough',
  );
  assert.deepEqual(
    credentialsFromEnv(meta, { META_ADS_APPSECRET_PROOF: 'proof', META_ADS_ACCESS_TOKEN: ' ' }),
    { credentials: { appsecret_proof: 'proof' }, missing: ['META_ADS_ACCESS_TOKEN', 'META_ADS_SYSTEM_USER_TOKEN'], needed: [['META_ADS_ACCESS_TOKEN'], ['META_ADS_SYSTEM_USER_TOKEN']] },
  );
  const site = { vendor: 'acme', credentials: ['access_token', 'site_url', 'app_password'], requiredCredentials: [['access_token'], ['site_url', 'app_password']] };
  assert.deepEqual(credentialsFromEnv(site, { ACME_SITE_URL: 'blog.example' }).needed, [['ACME_ACCESS_TOKEN'], ['ACME_APP_PASSWORD']], 'what is set is not asked for again');
  // A module built before requiredCredentials existed needs every credential.
  assert.deepEqual(credentialsFromEnv({ vendor: 'acme', credentials: ['handle', 'app_password'] }, {}).needed, [['ACME_HANDLE', 'ACME_APP_PASSWORD']]);

  assert.equal(describeNeeded([['DEVTO_API_KEY']]), 'DEVTO_API_KEY');
  assert.equal(describeNeeded([['ACME_HANDLE', 'ACME_APP_PASSWORD']]), 'ACME_HANDLE and ACME_APP_PASSWORD');
  assert.equal(describeNeeded([['META_ADS_ACCESS_TOKEN'], ['META_ADS_SYSTEM_USER_TOKEN']]), 'META_ADS_ACCESS_TOKEN, or META_ADS_SYSTEM_USER_TOKEN');
  assert.equal(describeNeeded([['ACME_ACCESS_TOKEN'], ['ACME_SITE_URL', 'ACME_APP_PASSWORD']]), 'ACME_ACCESS_TOKEN, or ACME_SITE_URL and ACME_APP_PASSWORD');
});

test('the module check reads requiredCredentials and accountPickers, and accepts a module built before them', () => {
  const tools = [{ name: 'list_pages' }];
  const picker = { key: 'pages', label: 'Acme Pages', multiple: true, tool: 'list_pages', idField: 'id', nameField: 'name' };
  const v2 = { ...base, credentials: ['access_token', 'api_key'], requiredCredentials: [['access_token'], ['api_key']], accountPickers: [picker], tools };
  assert.doesNotThrow(() => assertConnectorModule(v2, 'acme'));
  assert.doesNotThrow(() => assertConnectorModule({ ...base, tools }, 'acme'), 'without either field');
  assert.throws(() => assertConnectorModule({ ...v2, requiredCredentials: [['secret']] }, 'acme'), /requiredCredentials is not a list of lists of its credentials/);
  assert.throws(() => assertConnectorModule({ ...v2, requiredCredentials: [] }, 'acme'), /requiredCredentials is not a list of lists of its credentials/);
  assert.throws(() => assertConnectorModule({ ...v2, requiredCredentials: ['api_key'] }, 'acme'), /requiredCredentials is not a list of lists of its credentials/);
  assert.throws(() => assertConnectorModule({ ...v2, accountPickers: {} }, 'acme'), /accountPickers is not a list/);
  assert.throws(() => assertConnectorModule({ ...v2, accountPickers: [{ ...picker, tool: 'list_ads' }] }, 'acme'), /an account picker has no key or names none of its tools/);
  assert.throws(() => assertConnectorModule({ ...v2, accountPickers: [null] }, 'acme'), /an account picker has no key or names none of its tools/);
});

const READ = { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false };

function readTool(name) {
  return { name, kind: 'read', title: name, description: `Runs ${name}.`, inputSchema: READ, run: async () => ({}) };
}

test('--list: variables and tools as before; the alternatives and account pickers when a connector has them', () => {
  const plain = defineConnector({ vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['api_key'], tools: [readTool('read_x')] });
  assert.equal(describeConnector(plain), 'acme\n  env:   ACME_API_KEY\n  tools: read_x');

  const optional = defineConnector({ ...plainDefinition(), credentials: ['api_key', 'region'], requiredCredentials: [['api_key']] });
  assert.equal(describeConnector(optional), 'acme\n  env:   ACME_API_KEY, ACME_REGION\n  needs: ACME_API_KEY\n  tools: read_x');

  const full = defineConnector({
    vendor: 'meta-ads',
    label: 'Acme Ads',
    origins: ['https://api.acme.test'],
    credentials: ['access_token', 'system_user_token', 'appsecret_proof'],
    requiredCredentials: [['access_token'], ['system_user_token']],
    accountPickers: [
      { key: 'ad_accounts', label: 'Ad accounts', multiple: true, tool: 'list_ad_accounts', idField: 'id', nameField: 'name' },
      { key: 'pages', label: 'Pages', description: 'The Page ads run for.', multiple: false, tool: 'list_pages', idField: 'id', nameField: 'name', legacyField: 'pageid' },
    ],
    tools: [readTool('list_ad_accounts'), readTool('list_pages')],
  });
  assert.equal(describeConnector(full), [
    'meta-ads',
    '  env:      META_ADS_ACCESS_TOKEN, META_ADS_SYSTEM_USER_TOKEN, META_ADS_APPSECRET_PROOF',
    '  needs:    META_ADS_ACCESS_TOKEN, or META_ADS_SYSTEM_USER_TOKEN',
    '  tools:    list_ad_accounts, list_pages',
    '  accounts: ad_accounts (Ad accounts, one or more, listed by list_ad_accounts)',
    '            pages (Pages, one, listed by list_pages)',
  ].join('\n'));

  const keyless = defineConnector({ ...plainDefinition(), credentials: [] });
  assert.equal(describeConnector(keyless), 'acme\n  env:   (none)\n  tools: read_x', 'no credentials: nothing to need');
});

function plainDefinition() {
  return { vendor: 'acme', label: 'Acme', origins: ['https://api.acme.test'], credentials: ['api_key'], tools: [readTool('read_x')] };
}

/** A client connected to a server in memory. */
async function connected(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'host-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

test('the CLI server gives each call a 25 MiB file limit and passes the files a tool hands back to its client unchanged', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 report');
  const limits = [];
  const module = defineConnector({
    ...plainDefinition(),
    tools: [{
      name: 'export_report',
      kind: 'read',
      title: 'Export',
      description: 'Hands back the report.',
      inputSchema: READ,
      run: async (args, h) => {
        limits.push(h.fileLimit());
        return { file: h.file({ name: 'Q3 report.pdf', mimeType: 'application/pdf', bytes: pdf }) };
      },
    }],
  });
  const client = await connected(createConnectorServer(module, { credentials: { api_key: 'k' }, accounts: null, log: () => {} }));
  try {
    const result = await client.callTool({ name: 'export_report', arguments: {} });
    assert.equal(DEFAULT_MAX_FILE_BYTES, 25 * 1024 * 1024);
    assert.deepEqual(limits, [DEFAULT_MAX_FILE_BYTES]);
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [
      { type: 'text', text: JSON.stringify({ file: { name: 'Q3 report.pdf', mimeType: 'application/pdf', size: pdf.length } }) },
      { type: 'resource', resource: { uri: 'attachment:///Q3%20report.pdf', mimeType: 'application/pdf', blob: Buffer.from(pdf).toString('base64') } },
    ]);
  } finally {
    await client.close();
  }

  // A server set to take no files gives the call none, and the tool says so.
  const none = await connected(createConnectorServer(module, { credentials: { api_key: 'k' }, accounts: null, log: () => {}, maxFileBytes: null }));
  try {
    const refused = await none.callTool({ name: 'export_report', arguments: {} });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.content, [{ type: 'text', text: JSON.stringify({ error: 'This host takes no files, so export_report cannot hand one back.' }) }]);
    assert.deepEqual(limits, [DEFAULT_MAX_FILE_BYTES, null]);
  } finally {
    await none.close();
  }
});

test('a server that takes more than 25 MiB of files reads API replies that large too; by default an API reply stops at 25 MiB', async () => {
  const size = DEFAULT_MAX_FILE_BYTES + 1024;
  const module = defineConnector({
    ...plainDefinition(),
    tools: [{
      name: 'download',
      kind: 'read',
      title: 'Download',
      description: 'Downloads the stored file.',
      inputSchema: READ,
      run: async (args, h) => {
        const { data } = await h.api({ path: '/files/big', binary: true, maxBytes: h.fileLimit() });
        return { size: data.byteLength };
      },
    }],
  });
  // The server builds its own guarded fetch, whose API requests go through the global fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(size), { headers: { 'content-length': String(size) } });
  try {
    const roomy = await connected(createConnectorServer(module, { credentials: { api_key: 'k' }, accounts: null, log: () => {}, maxFileBytes: 32 * 1024 * 1024 }));
    try {
      const result = await roomy.callTool({ name: 'download', arguments: {} });
      assert.notEqual(result.isError, true, result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text), { size });
    } finally {
      await roomy.close();
    }
    const standard = await connected(createConnectorServer(module, { credentials: { api_key: 'k' }, accounts: null, log: () => {} }));
    try {
      const refused = await standard.callTool({ name: 'download', arguments: {} });
      assert.equal(refused.isError, true);
      assert.deepEqual(JSON.parse(refused.content[0].text), { error: 'The reply from Acme is larger than this host can read.' });
    } finally {
      await standard.close();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
