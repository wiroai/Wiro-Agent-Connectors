import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('serper over stdio: named after the vendor, lists its tool, and calls Serper with the key from the environment', async () => {
  const { client, stderr } = await connect('serper', { SERPER_API_KEY: SERPER_KEY, MOCK_VENDOR_URL: mock.url });
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'serper', version: VERSION });

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['web_search']);
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
    assert.deepEqual(tools.map((tool) => tool.name), ['list_my_articles', 'create_draft_article', 'update_article', 'api_get', 'api_request']);
    const result = await client.callTool({ name: 'list_my_articles', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /set DEVTO_API_KEY in its environment/);
    assert.doesNotMatch(result.content[0].text, /wiro/i);
  } finally {
    await client.close();
  }
  assert.equal(mock.requests.length, before, 'nothing was sent');
  assert.match(stderr(), /devto: DEVTO_API_KEY is not set/);
});

test('--list, --version, an unknown connector and a bad CONNECTOR_ACCOUNTS', () => {
  const list = spawnSync(process.execPath, [CLI, '--list'], { encoding: 'utf8' });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /bluesky\n {2}env: {3}BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD\n {2}tools: get_profile, list_my_posts, create_post, api_get, api_request\n/);
  assert.match(list.stdout, /devto\n {2}env: {3}DEVTO_API_KEY/);
  assert.match(list.stdout, /serper\n {2}env: {3}SERPER_API_KEY\n {2}tools: web_search/);
  // These need every variable and offer no account picker, so neither line appears.
  assert.doesNotMatch(list.stdout, /needs:|accounts:/);

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /set CONNECTOR_ACCOUNTS to JSON such as\n\{"pages":\["123"\]\}, keyed by the account keys --list prints/);

  const version = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), VERSION);

  const unknown = spawnSync(process.execPath, [CLI, 'nosuchvendor'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /There is no connector named "nosuchvendor"\. Available: bluesky, devto, serper\./);

  const traversal = spawnSync(process.execPath, [CLI, '../package'], { encoding: 'utf8' });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /is not a connector name/);

  const badAccounts = spawnSync(process.execPath, [CLI, 'serper'], { encoding: 'utf8', env: { PATH: process.env.PATH, CONNECTOR_ACCOUNTS: '{"pages":"123"}' }, input: '' });
  assert.equal(badAccounts.status, 1);
  assert.match(badAccounts.stderr, /CONNECTOR_ACCOUNTS: "pages" must be a list of ids/);
});
