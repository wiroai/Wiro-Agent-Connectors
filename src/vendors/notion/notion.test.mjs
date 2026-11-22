import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'ntn_1234567890abcdefghijABCDEFGHIJ';
const PAGE = '1429989f-e8ac-4eff-bc8f-57f56486db54';
const ROW = '59833787-2cf9-4fdf-8782-e53db20768a5';
const SOURCE = '248104cd-477e-80af-bc30-000bd28de8f9';

function setup(handler, credentials = { token: TOKEN }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

test('get_connection reads the bot user with the Bearer token and the pinned Notion-Version', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'users-me.json')), { token: `Bearer ${TOKEN}` });
  const { payload, isError } = await callTool(module, 'get_connection', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.notion.com/v1/users/me');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`, 'a pasted "Bearer " prefix is not sent twice');
  assert.equal(request.headers['notion-version'], '2026-03-11');
  assert.deepEqual(payload, {
    id: '16d84278-ab0e-484c-9bdd-b35da3bd8905',
    name: 'Content agent',
    type: 'bot',
    workspace_name: 'Acme Team',
    owner_type: 'workspace',
    reach: 'internal connection: reaches only the pages and databases shared with it',
  });
});

test('search posts a safe read with the filter and sort, trims results and continues with Notion\'s cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'search.json')));
  const first = await callTool(module, 'search', { query: 'Roadmap', page_size: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.notion.com/v1/search');
  assert.deepEqual(fetch.calls[0].json, { query: 'Roadmap', sort: { timestamp: 'last_edited_time', direction: 'descending' }, page_size: 2 });
  assert.deepEqual(first.payload.results, [
    {
      object: 'page',
      id: PAGE,
      title: 'Q4 Roadmap',
      url: 'https://www.notion.so/Q4-Roadmap-1429989fe8ac4effbc8f57f56486db54',
      parent: { type: 'page_id', id: ROW },
      last_edited_time: '2026-11-20T14:05:00.000Z',
    },
    {
      object: 'data_source',
      id: SOURCE,
      title: 'Content Calendar',
      url: 'https://www.notion.so/248104cd477e80fdb757e945d38000bd',
      parent: { type: 'database_id', id: '248104cd-477e-80fd-b757-e945d38000bd' },
      last_edited_time: '2026-11-19T10:30:00.000Z',
    },
  ]);
  assert.ok(first.payload.nextCursor);

  await callTool(module, 'search', { query: 'Roadmap', filter: 'data_source', cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].json, {
    query: 'Roadmap',
    filter: { property: 'object', value: 'data_source' },
    sort: { timestamp: 'last_edited_time', direction: 'descending' },
    page_size: 20,
    start_cursor: 'e6c6f5ff-ea9a-4a8b-9a1f-000000000002',
  });

  const empty = setup(() => jsonResponse(200, { object: 'list', results: [], has_more: false, next_cursor: null }));
  const none = await callTool(empty.module, 'search', {}, empty.ctx);
  assert.deepEqual(none.payload.results, []);
  assert.match(none.payload.note, /shared with it/);
});

test('get_page takes a link, and gives every property as type and plain value', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'page.json')));
  const { payload, isError } = await callTool(module, 'get_page', { page_id: 'https://www.notion.so/acme/Launch-post-598337872cf94fdf8782e53db20768a5?pvs=4' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/pages/${ROW}`);
  assert.equal(payload.title, 'Launch post');
  assert.deepEqual(payload.parent, { type: 'data_source_id', id: SOURCE, database_id: '248104cd-477e-80fd-b757-e945d38000bd' });
  assert.deepEqual(payload.properties, {
    Name: { type: 'title', value: 'Launch post' },
    Status: { type: 'status', value: 'Draft' },
    Channel: { type: 'select', value: 'Blog' },
    Tags: { type: 'multi_select', value: ['Q4', 'Launch'] },
    Due: { type: 'date', value: { start: '2026-11-28' } },
    Done: { type: 'checkbox', value: false },
    Estimate: { type: 'number', value: 3 },
    Notes: { type: 'rich_text', value: 'Short note' },
    Owner: { type: 'people', value: [{ id: 'ee5f0f84-409a-440f-983a-a5315961c6e4', name: 'Alex Example' }] },
    Related: { type: 'relation', value: [PAGE] },
    Link: { type: 'url', value: 'https://example.com/launch' },
    Score: { type: 'formula', value: 42 },
    Ticket: { type: 'unique_id', value: 'CNT-17' },
    Edited: { type: 'last_edited_time', value: '2026-11-21T16:40:00.000Z' },
  });
});

test('a value that is not a Notion ID is refused before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const { payload, isError } = await callTool(module, 'get_page', { page_id: 'https://www.notion.so/Roadmap-without-an-id-at-all' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /page_id is not a Notion ID or link/);
  assert.equal(fetch.calls.length, 0);
});

test('a page the connection cannot see says how to share it', async () => {
  const { module, ctx } = setup(() => jsonResponse(404, fixture(import.meta.url, 'error-404.json')));
  const { payload } = await callTool(module, 'get_page', { page_id: PAGE }, ctx);
  assert.equal(payload.status, 404);
  assert.equal(payload.vendorCode, 'object_not_found');
  assert.match(payload.error, /not shared with the connection: in Notion, open the page, click ••• > Connections > \+ Add connection/);
  assert.match(payload.error, /\(HTTP 404\)/);
});

test('read_page_markdown reads Notion-flavored Markdown v2 and names the blocks Notion left out', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'page-markdown.json')));
  const { payload, isError } = await callTool(module, 'read_page_markdown', { page_id: '1429989fe8ac4effbc8f57f56486db54' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/pages/${PAGE}/markdown?markdown_version=v2`);
  assert.match(payload.markdown, /^# Q4 Roadmap\n/);
  assert.equal(payload.nextCursor, undefined);
  assert.deepEqual(payload.left_out_block_ids, ['2b5b3c1d-0000-4000-8000-000000000010']);
  assert.match(payload.note, /Notion left 1 block\(s\) out/);
});

test('a long page body comes in windows under 32 KB that join up exactly', async () => {
  const line = (index) => `Paragraph ${index}: ${'ü€'.repeat(40)} "quoted" text\n`;
  const markdown = Array.from({ length: 900 }, (_, index) => line(index)).join('');
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { object: 'page_markdown', id: PAGE, markdown, truncated: false, unknown_block_ids: [] }));
  let cursor;
  let joined = '';
  let calls = 0;
  do {
    const step = await callTool(module, 'read_page_markdown', { page_id: PAGE, ...(cursor ? { cursor } : {}) }, ctx);
    assert.equal(step.isError, false, step.payload.error);
    assert.ok(textBytes(step.result) <= 32 * 1024);
    assert.equal(step.payload.truncated, undefined, 'the window itself is never cut');
    joined += step.payload.markdown;
    cursor = step.payload.nextCursor;
    calls += 1;
  } while (cursor && calls < 20);
  assert.ok(calls > 2, `${calls} windows`);
  assert.equal(joined, markdown);
  assert.equal(fetch.calls.length, calls);
});

test('list_block_children trims blocks and pages with start_cursor', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'block-children.json')));
  const first = await callTool(module, 'list_block_children', { block_id: PAGE }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/blocks/${PAGE}/children?page_size=100`);
  assert.deepEqual(first.payload.blocks, [
    { id: 'c02fc1d3-db8b-45c5-a222-27595b15aea7', type: 'heading_2', text: 'Goals' },
    { id: 'acc7eb06-05cd-4603-a384-5e1e4f1f4e72', type: 'to_do', text: 'Update the pricing page', checked: true },
    { id: '5e8a1f8b-0000-4000-8000-000000000011', type: 'toggle', text: 'Details', has_children: true },
    { id: '5e8a1f8b-0000-4000-8000-000000000012', type: 'code', text: "print('hi')", language: 'python' },
    { id: '5e8a1f8b-0000-4000-8000-000000000013', type: 'image', url: 'https://images.example.com/chart.png', caption: 'Signups' },
    { id: '2b5b3c1d-0000-4000-8000-000000000010', type: 'child_database', title: 'Tasks' },
  ]);
  await callTool(module, 'list_block_children', { block_id: PAGE, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.start_cursor, '5e8a1f8b-0000-4000-8000-000000000014');
});

test('get_database lists its data sources, and get_data_source gives the schema with the title first', async () => {
  const database = setup(() => jsonResponse(200, fixture(import.meta.url, 'database.json')));
  const db = await callTool(database.module, 'get_database', { database_id: 'https://www.notion.so/248104cd477e80fdb757e945d38000bd?v=0000000000000000000000000000abcd' }, database.ctx);
  assert.equal(database.fetch.calls[0].url, 'https://api.notion.com/v1/databases/248104cd-477e-80fd-b757-e945d38000bd');
  assert.deepEqual(db.payload.data_sources, [{ id: SOURCE, name: 'Content Calendar' }]);

  const source = setup(() => jsonResponse(200, fixture(import.meta.url, 'data-source.json')));
  const schema = await callTool(source.module, 'get_data_source', { data_source_id: SOURCE }, source.ctx);
  assert.equal(source.fetch.calls[0].url, `https://api.notion.com/v1/data_sources/${SOURCE}`);
  assert.equal(schema.payload.database_id, '248104cd-477e-80fd-b757-e945d38000bd');
  assert.deepEqual(schema.payload.properties, [
    { name: 'Name', type: 'title', id: 'title' },
    { name: 'Status', type: 'status', id: '%3AUPp', options: ['Draft', 'Published'] },
    { name: 'Tags', type: 'multi_select', id: 'q%5E%3Cv', options: ['Q4'] },
    { name: 'Related', type: 'relation', id: 'rel1', links_to: '248104cd-477e-80af-bc30-000bd28de8fa' },
    { name: 'Score', type: 'formula', id: 'f1', read_only: true },
  ]);
});

test('query_data_source sends the filter and sorts as a safe read and returns flat rows', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'query.json')));
  const filter = { property: 'Status', status: { does_not_equal: 'Done' } };
  const sorts = [{ property: 'Due', direction: 'ascending' }];
  const { payload, isError } = await callTool(module, 'query_data_source', { data_source_id: SOURCE, filter, sorts, properties: ['Status', 'Due'] }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/data_sources/${SOURCE}/query`);
  assert.deepEqual(fetch.calls[0].json, { filter, sorts, page_size: 50 });
  assert.deepEqual(payload.rows, [{
    id: ROW,
    title: 'Launch post',
    url: 'https://www.notion.so/Launch-post-598337872cf94fdf8782e53db20768a5',
    last_edited_time: '2026-11-21T16:40:00.000Z',
    properties: { Status: 'Draft', Due: { start: '2026-11-28' } },
  }]);
  assert.equal(payload.nextCursor, undefined);
});

test('list_users returns people and bots with their IDs', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'users.json')));
  const { payload } = await callTool(module, 'list_users', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.notion.com/v1/users?page_size=100');
  assert.deepEqual(payload.users, [
    { id: 'ee5f0f84-409a-440f-983a-a5315961c6e4', name: 'Alex Example', type: 'person', email: 'alex@example.com' },
    { id: '16d84278-ab0e-484c-9bdd-b35da3bd8905', name: 'Content agent', type: 'bot' },
  ]);
});

test('create_page under a page sends the Markdown body as v2 with the title property', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'created-page.json')));
  const { payload, isError } = await callTool(module, 'create_page', {
    parent_page_id: 'https://www.notion.so/Q4-Roadmap-1429989fe8ac4effbc8f57f56486db54',
    title: 'Meeting notes',
    markdown: '## Decisions\n\n- Ship on Friday\n',
    icon: '📝',
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.notion.com/v1/pages');
  assert.deepEqual(fetch.calls[0].json, {
    parent: { page_id: PAGE },
    properties: { title: { title: [{ type: 'text', text: { content: 'Meeting notes' } }] } },
    markdown: '## Decisions\n\n- Ship on Friday\n',
    markdown_version: 'v2',
    icon: { type: 'emoji', emoji: '📝' },
  });
  assert.equal(payload.id, '7a1c5e2d-0000-4000-8000-000000000020');
  assert.equal(payload.url, 'https://www.notion.so/Meeting-notes-7a1c5e2d000040008000000000000020');
});

test('create_page as a database row keeps the properties as given and adds no second title', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'page.json')));
  const properties = { Name: { title: [{ text: { content: 'Launch post' } }] }, Status: { status: { name: 'Draft' } } };
  await callTool(module, 'create_page', { data_source_id: SOURCE, title: 'ignored', properties }, ctx);
  assert.deepEqual(fetch.calls[0].json, { parent: { type: 'data_source_id', data_source_id: SOURCE }, properties });
});

test('create_page needs exactly one parent and one kind of body, before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, {}));
  const two = await callTool(module, 'create_page', { parent_page_id: PAGE, workspace: true, title: 'x' }, ctx);
  assert.match(two.payload.error, /exactly one parent/);
  const none = await callTool(module, 'create_page', { title: 'x' }, ctx);
  assert.match(none.payload.error, /exactly one parent/);
  const both = await callTool(module, 'create_page', { parent_page_id: PAGE, markdown: 'a', children: [{ type: 'divider', divider: {} }] }, ctx);
  assert.match(both.payload.error, /markdown or children, not both/);
  const bad = await callTool(module, 'create_page', { parent_page_id: PAGE, children: [{ type: 'divider', divider: {} }, 'text'] }, ctx);
  assert.match(bad.payload.error, /`children\[1\]` must be an object|children\[1\] must be a Notion block object/);
  assert.equal(fetch.calls.length, 0);
});

test('append_markdown sends insert_content with a position', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'markdown-updated.json')));
  const { payload, isError } = await callTool(module, 'append_markdown', { page_id: PAGE, markdown: '- Launch the new pricing\n' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/pages/${PAGE}/markdown`);
  assert.deepEqual(fetch.calls[0].json, {
    type: 'insert_content',
    insert_content: { content: '- Launch the new pricing\n', position: { type: 'end' } },
    markdown_version: 'v2',
  });
  assert.deepEqual(payload, { id: PAGE, appended: true, position: 'end', page_markdown_length: 76 });
});

test('update_page_text sends update_content, and a passage that matches nothing keeps Notion\'s words', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'markdown-updated.json')));
  await callTool(module, 'update_page_text', { page_id: PAGE, edits: [{ old_text: 'Update the pricing page', new_text: 'Launch the new pricing' }] }, ctx);
  assert.deepEqual(fetch.calls[0].json, {
    type: 'update_content',
    update_content: { content_updates: [{ old_str: 'Update the pricing page', new_str: 'Launch the new pricing' }] },
    markdown_version: 'v2',
  });

  const refused = setup(() => jsonResponse(400, fixture(import.meta.url, 'error-400.json')));
  const { payload } = await callTool(refused.module, 'update_page_text', { page_id: PAGE, edits: [{ old_text: 'missing', new_text: 'x', replace_all: true }] }, refused.ctx);
  assert.equal(payload.status, 400);
  assert.equal(payload.outcome, undefined);
  assert.match(payload.error, /^Notion did not apply the edits \(each old_text must match exactly one place/);
  assert.match(payload.error, /\(HTTP 400\)\. Notion said: "No match found for old_str in page content\."\. Nothing was changed\./);
  assert.deepEqual(refused.fetch.calls[0].json.update_content.content_updates, [{ old_str: 'missing', new_str: 'x', replace_all_matches: true }]);
});

test('replace_page_markdown replaces the body and never allows deleting child pages', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'markdown-updated.json')));
  await callTool(module, 'replace_page_markdown', { page_id: PAGE, markdown: '# New body\n' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { type: 'replace_content', replace_content: { new_str: '# New body\n' }, markdown_version: 'v2' });
  assert.equal(JSON.stringify(fetch.calls[0].json).includes('allow_deleting_content'), false);
});

test('append_blocks places blocks after a given block', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'appended-blocks.json')));
  const children = [{ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '2026-11-21: shipped the onboarding flow.' } }] } }];
  const { payload } = await callTool(module, 'append_blocks', { block_id: PAGE, children, after_block_id: 'c02fc1d3db8b45c5a22227595b15aea7' }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/blocks/${PAGE}/children`);
  assert.deepEqual(fetch.calls[0].json, { children, position: { type: 'after_block', after_block: { id: 'c02fc1d3-db8b-45c5-a222-27595b15aea7' } } });
  assert.deepEqual(payload.blocks, [{ id: '9b0e3f1a-0000-4000-8000-000000000030', type: 'paragraph', text: '2026-11-21: shipped the onboarding flow.' }]);
});

test('update_page renames and sets properties silently; it needs something to change', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'page.json')));
  await callTool(module, 'update_page', { page_id: ROW, title: 'Launch post v2', properties: { Status: { status: { name: 'Published' } } }, silent: true }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/pages/${ROW}`);
  assert.deepEqual(fetch.calls[0].json, {
    properties: { Status: { status: { name: 'Published' } }, title: { title: [{ type: 'text', text: { content: 'Launch post v2' } }] } },
    notifications: { mode: 'silent' },
  });
  const nothing = await callTool(module, 'update_page', { page_id: ROW, silent: true }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 1);
});

test('update_block patches one block, and trashing goes through trash_block', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'trashed-block.json')));
  await callTool(module, 'update_block', { block_id: 'acc7eb06-05cd-4603-a384-5e1e4f1f4e72', block: { to_do: { checked: true } } }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.deepEqual(fetch.calls[0].json, { to_do: { checked: true } });
  const refused = await callTool(module, 'update_block', { block_id: 'acc7eb06-05cd-4603-a384-5e1e4f1f4e72', block: { in_trash: true } }, ctx);
  assert.match(refused.payload.error, /Use trash_block/);

  const trashed = await callTool(module, 'trash_block', { block_id: 'https://www.notion.so/Q4-Roadmap-1429989fe8ac4effbc8f57f56486db54#acc7eb0605cd4603a3845e1e4f1f4e72' }, ctx);
  assert.equal(fetch.calls[1].method, 'DELETE');
  assert.equal(fetch.calls[1].url, 'https://api.notion.com/v1/blocks/acc7eb06-05cd-4603-a384-5e1e4f1f4e72');
  assert.equal(trashed.payload.in_trash, true);
  assert.equal(fetch.calls.length, 2);
});

test('trash_page and restore_page set in_trash, the field Notion-Version 2026-03-11 uses', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { ...fixture(import.meta.url, 'page.json'), in_trash: true }));
  const trashed = await callTool(module, 'trash_page', { page_id: ROW }, ctx);
  assert.deepEqual(fetch.calls[0].json, { in_trash: true });
  assert.deepEqual(trashed.payload, { id: ROW, title: 'Launch post', url: 'https://www.notion.so/Launch-post-598337872cf94fdf8782e53db20768a5', in_trash: true });
  await callTool(module, 'restore_page', { page_id: ROW }, ctx);
  assert.deepEqual(fetch.calls[1].json, { in_trash: false });
});

test('a write without a clear answer is unknown, sent once, with the read tool to check', async () => {
  const cases = [
    ['create_page', { parent_page_id: PAGE, title: 'x' }, 'search'],
    ['append_markdown', { page_id: PAGE, markdown: 'x' }, 'read_page_markdown'],
    ['append_blocks', { block_id: PAGE, children: [{ type: 'divider', divider: {} }] }, 'list_block_children'],
    ['update_page_text', { page_id: PAGE, edits: [{ old_text: 'a', new_text: 'b' }] }, 'read_page_markdown'],
    ['replace_page_markdown', { page_id: PAGE, markdown: 'x' }, 'read_page_markdown'],
    ['update_page', { page_id: PAGE, title: 'x' }, 'get_page'],
    ['update_block', { block_id: PAGE, block: { paragraph: {} } }, 'get_block'],
    ['trash_page', { page_id: PAGE }, 'get_page'],
    ['restore_page', { page_id: PAGE }, 'get_page'],
    ['trash_block', { block_id: PAGE }, 'get_block'],
  ];
  for (const [tool, args, check] of cases) {
    const { module, fetch, ctx } = setup(() => jsonResponse(503, { object: 'error', status: 503, code: 'service_unavailable', message: 'Notion is unavailable' }));
    const { payload, isError } = await callTool(module, tool, args, ctx);
    assert.equal(isError, true);
    assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
    assert.equal(payload.check, check);
    assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
  }
});

test('a rate limit carries retryAfter, and reads that fail say nothing changed nowhere', async () => {
  const { module, ctx } = setup(() => jsonResponse(429, fixture(import.meta.url, 'error-429.json'), { 'retry-after': '7' }));
  const { payload } = await callTool(module, 'search', {}, ctx);
  assert.equal(payload.retryAfter, 7);
  assert.equal(payload.vendorCode, 'rate_limited');
  assert.match(payload.error, /Notion rate limit reached \(HTTP 429\)\. Retry after 7 seconds\./);
});

test('api_get and api_request reach the rest of the API under /v1/ only', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { object: 'list', results: [] }));
  const read = await callTool(module, 'api_get', { path: '/v1/comments', query: { block_id: PAGE } }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { object: 'list', results: [] } });
  assert.equal(fetch.calls[0].url, `https://api.notion.com/v1/comments?block_id=${PAGE}`);
  assert.equal(fetch.calls[0].headers['notion-version'], '2026-03-11');
  const outside = await callTool(module, 'api_get', { path: '/v2/anything' }, ctx);
  assert.match(outside.payload.error, /must start with \/v1\//);
  const put = await callTool(module, 'api_request', { method: 'PUT', path: '/v1/pages/x', json: {} }, ctx);
  assert.match(put.payload.error, /`method` must be one of "POST", "PATCH", "DELETE"/);
  assert.equal(fetch.calls.length, 1);

  const down = setup(() => jsonResponse(502, { object: 'error', status: 502, code: 'bad_gateway', message: 'Bad gateway' }));
  const unknown = await callTool(down.module, 'api_request', { method: 'POST', path: '/v1/comments', json: { parent: { page_id: PAGE } } }, down.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(down.fetch.calls.length, 1);
});

test('without a token nothing is sent, and logs carry neither the token nor the content', async () => {
  const missing = setup(() => jsonResponse(200, {}), {});
  const refused = await callTool(missing.module, 'search', {}, missing.ctx);
  assert.equal(refused.payload.error, 'Notion is not connected: the Notion API token is missing.');
  assert.equal(missing.fetch.calls.length, 0);

  const { module, ctx, logs } = setup(() => jsonResponse(200, fixture(import.meta.url, 'created-page.json')));
  await callTool(module, 'create_page', { parent_page_id: PAGE, title: 'Secret plan', markdown: 'very private text' }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['notion create_page POST 200 Nms']);
  const joined = logs.join('\n');
  for (const secret of [TOKEN, 'Secret plan', 'very private text']) assert.equal(joined.includes(secret), false);
});
