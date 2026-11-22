import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './helpers.mjs';

// The stdio CLI, run for real: `node dist/cli.js <vendor>` with credentials in
// its environment, driven by the MCP SDK client. Its vendor requests go to a
// local mock server (tests/fixtures/mock-vendor-fetch.mjs).

const CLI = path.join(ROOT, 'dist', 'cli.js');
const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'mock-vendor-fetch.mjs')).href;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SERPER_KEY = 'serper-cli-test-key';
const search = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'vendors', 'serper', 'fixtures', 'search.json'), 'utf8'));
const DRIVE_FILE = '7ReportPdfFile00000000000000000';
const DRIVE_BYTES = Buffer.from('%PDF-1.7\n% a report\n%%EOF\n');

async function startMockVendor() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/google.serper.dev/search') {
        res.end(JSON.stringify(search));
        return;
      }
      if (req.url === '/oauth2.googleapis.com/token') {
        res.end(JSON.stringify({ access_token: 'ya29.cli-test-token', expires_in: 3599, token_type: 'Bearer' }));
        return;
      }
      if (req.url.startsWith(`/www.googleapis.com/drive/v3/files/${DRIVE_FILE}?`)) {
        if (new URL(req.url, 'http://mock').searchParams.get('alt') === 'media') {
          res.setHeader('content-type', 'application/pdf');
          res.end(DRIVE_BYTES);
          return;
        }
        res.end(JSON.stringify({ id: DRIVE_FILE, name: 'report.pdf', mimeType: 'application/pdf', size: String(DRIVE_BYTES.length), parents: ['1Folder'] }));
        return;
      }
      res.statusCode = 404;
      res.end('{"message":"not found"}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, url: `http://127.0.0.1:${server.address().port}` };
}

async function connect(vendor, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', PRELOAD, CLI, vendor],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'cli-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

let mock;

test.before(async () => {
  mock = await startMockVendor();
});

test.after(() => {
  mock?.server.close();
});

test('serper over stdio: named after the vendor, lists its tools, and calls Serper with the key from the environment', async () => {
  const { client, stderr } = await connect('serper', { SERPER_APIKEY: SERPER_KEY, MOCK_VENDOR_URL: mock.url });
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'serper', version: VERSION });

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      'web_search', 'news_search', 'image_search', 'video_search', 'places_search', 'maps_search', 'place_reviews',
      'shopping_search', 'scholar_search', 'patent_search', 'autocomplete', 'lens_search', 'find_locations',
    ]);
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });

    const before = mock.requests.length;
    const result = await client.callTool({ name: 'web_search', arguments: { q: 'a private query', num: 3 } });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.results.length, 3);
    assert.equal(payload.results[0].link, 'https://modelcontextprotocol.io/introduction');

    const request = mock.requests[before];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/google.serper.dev/search');
    assert.equal(request.headers['x-api-key'], SERPER_KEY);
    assert.deepEqual(JSON.parse(request.body), { q: 'a private query', num: 3, page: 1 });
  } finally {
    await client.close();
  }
  const log = stderr();
  assert.match(log, /serper web_search POST 200 \d+ms/);
  assert.match(log, /serper web_search ok \d+ms/);
  assert.equal(log.includes(SERPER_KEY), false, 'the key is never logged');
  assert.equal(log.includes('private query'), false, 'arguments are never logged');
});

test('without its credentials a connector still lists its tools and names the missing variable', async () => {
  const { client, stderr } = await connect('devto', { MOCK_VENDOR_URL: mock.url });
  const before = mock.requests.length;
  try {
    assert.equal(client.getServerVersion().name, 'devto');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['list_my_articles', 'get_article', 'create_draft_article', 'update_article', 'get_analytics', 'api_get', 'api_request']);
    const result = await client.callTool({ name: 'list_my_articles', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /set DEVTO_APIKEY in its environment/);
    assert.doesNotMatch(result.content[0].text, /wiro/i);
  } finally {
    await client.close();
  }
  assert.equal(mock.requests.length, before, 'nothing was sent');
  assert.match(stderr(), /devto: DEVTO_APIKEY is not set/);
});

test('a file a tool hands back reaches the MCP client as an embedded resource after the JSON text, unchanged', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'kid-cli-test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'cli-test@example-project.iam.gserviceaccount.com',
  };
  const { client, stderr } = await connect('google-drive', {
    GOOGLE_DRIVE_SERVICEACCOUNTJSON: Buffer.from(JSON.stringify(key)).toString('base64'),
    MOCK_VENDOR_URL: mock.url,
  });
  const before = mock.requests.length;
  try {
    const result = await client.callTool({ name: 'download_file', arguments: { file_id: DRIVE_FILE } });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(result.content[0].text).file, { name: 'report.pdf', mimeType: 'application/pdf', size: DRIVE_BYTES.length });
    assert.deepEqual(result.content[1], {
      type: 'resource',
      resource: { uri: 'attachment:///report.pdf', mimeType: 'application/pdf', blob: DRIVE_BYTES.toString('base64') },
    });
  } finally {
    await client.close();
  }
  const drive = mock.requests.slice(before).filter((request) => request.url.startsWith('/www.googleapis.com/'));
  assert.equal(drive.length, 2, 'the metadata, then the file');
  assert.equal(drive[1].headers.authorization, 'Bearer ya29.cli-test-token');
  assert.match(stderr(), /google-drive download_file ok \d+ms/);
});

test('--list, --version, an unknown connector and a bad CONNECTOR_ACCOUNTS', () => {
  const list = spawnSync(process.execPath, [CLI, '--list'], { encoding: 'utf8' });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /bluesky\n {2}env: {3}BLUESKY_HANDLE, BLUESKY_APPPASSWORD\n {2}tools: get_profile, list_my_posts, get_posts, create_post, delete_post, api_get, api_request\n/);
  assert.match(list.stdout, /devto\n {2}env: {3}DEVTO_APIKEY/);
  assert.match(list.stdout, /serper\n {2}env: {3}SERPER_APIKEY\n {2}tools: web_search/);
  // These need every variable and offer no account picker, so neither line appears in their entries.
  const entries = Object.fromEntries(list.stdout.trim().split('\n\n').map((entry) => [entry.split('\n')[0], entry]));
  for (const vendor of ['bluesky', 'devto', 'serper']) assert.doesNotMatch(entries[vendor], /needs:|accounts:/, vendor);
  // One with alternatives and account pickers prints both.
  assert.match(entries['meta-ads'], /\n {2}needs: {4}META_ADS_ACCESS_TOKEN, or META_ADS_SYSTEMUSERTOKEN\n/);
  assert.match(entries['meta-ads'], /\n {2}accounts: ad_accounts \(Meta ad accounts, one or more, listed by list_ad_accounts\)\n {12}pages \(/);

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /set CONNECTOR_ACCOUNTS to JSON such as\n\{"pages":\["123"\]\}, keyed by the account keys --list prints/);

  const version = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), VERSION);

  const unknown = spawnSync(process.execPath, [CLI, 'nosuchvendor'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.ok(unknown.stderr.includes(`There is no connector named "nosuchvendor". Available: ${Object.keys(entries).sort().join(', ')}.`), unknown.stderr);

  const traversal = spawnSync(process.execPath, [CLI, '../package'], { encoding: 'utf8' });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /is not a connector name/);

  const badAccounts = spawnSync(process.execPath, [CLI, 'serper'], { encoding: 'utf8', env: { PATH: process.env.PATH, CONNECTOR_ACCOUNTS: '{"pages":"123"}' }, input: '' });
  assert.equal(badAccounts.status, 1);
  assert.match(badAccounts.stderr, /CONNECTOR_ACCOUNTS: "pages" must be a list of ids/);
});
