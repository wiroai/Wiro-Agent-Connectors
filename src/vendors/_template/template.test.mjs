// Tests for the template module. Copy this file with the folder: it finds the
// built module from its own folder name, so it runs as is once renamed. Every
// test uses a fake ctx.fetch, never the network. Cover at least: the request
// each tool sends, how its result is trimmed, the error mapping (a 429 at
// least), and for write tools the unknown outcome.

import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const credentials = { api_key: 'example-key-123' };

function setup(handler, accounts = { workspaces: ['ws_1'] }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, fetch, ctx, logs };
}

test('list_items sends one GET with the auth header and trims each item', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {
    items: [{ id: 'it_1', name: 'First', url: 'https://example.com/it_1', internal: 'left out' }],
    next_page: 'p2',
  }));
  const { payload, isError } = await callTool(module, 'list_items', { limit: 5 }, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, 'https://api.example.com/v1/items?limit=5');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer example-key-123');
  assert.deepEqual(payload.items, [{ id: 'it_1', name: 'First', url: 'https://example.com/it_1' }]);

  await callTool(module, 'list_items', { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, 'p2');
});

test('create_item refuses a workspace outside the selected accounts, before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, { id: 'it_2', name: 'New' }));
  const { payload, isError } = await callTool(module, 'create_item', { workspace_id: 'ws_9', name: 'New' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /The workspace ws_9 is not among the workspaces chosen for this connection\. Use one of: ws_1\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 0);

  const nothingChosen = setup(() => jsonResponse(201, {}), {});
  const refused = await callTool(nothingChosen.module, 'create_item', { workspace_id: 'ws_1', name: 'New' }, nothingChosen.ctx);
  assert.match(refused.payload.error, /No workspace is chosen for it yet/);
});

test('create_item posts to a selected workspace; with no account lock (null) any workspace goes', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, { id: 'it_2', name: 'New', url: 'https://example.com/it_2' }));
  const { payload } = await callTool(module, 'create_item', { workspace_id: 'ws_1', name: 'New' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { name: 'New' });
  assert.equal(fetch.calls[0].url, 'https://api.example.com/v1/workspaces/ws_1/items');
  assert.equal(payload.id, 'it_2');

  const open = setup(() => jsonResponse(201, { id: 'it_3' }), null);
  const unlocked = await callTool(open.module, 'create_item', { workspace_id: 'ws_42', name: 'New' }, open.ctx);
  assert.equal(unlocked.isError, false);
});

test('a 429 carries retryAfter, and an unclear write outcome names the check tool', async () => {
  const limited = setup(() => textResponse(429, 'slow down', { 'retry-after': '12' }));
  const rate = await callTool(limited.module, 'list_items', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 12);

  const broken = setup(() => jsonResponse(503, { message: 'unavailable' }));
  const unknown = await callTool(broken.module, 'create_item', { workspace_id: 'ws_1', name: 'New' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_items');
  assert.equal(broken.fetch.calls.length, 1);
});
