// Notion, through the Notion API (https://developers.notion.com/reference),
// Notion-Version 2026-03-11.
//
// Credential: `token`, the API token of an internal Notion connection (it
// starts with ntn_, or secret_ for tokens made before September 2024), or a
// personal access token. A Workspace Owner makes a connection in Notion's
// Developer portal (https://app.notion.com/developers/connections) and shares
// pages with it; a personal access token comes from
// https://www.notion.so/developers/tokens. The token is sent as a Bearer token
// to https://api.notion.com/v1/ only. An internal connection reaches only what
// is shared with it; a personal access token acts as its owner. Notion's API
// deletes nothing for good: trashed pages and blocks stay in Notion's Trash.

import { apiTools, defineConnector, ToolFailure, type ToolHelpers } from '../../core/index.js';
import {
  compact,
  notionId,
  pageTitle,
  parentOf,
  plain,
  schemaProperties,
  TEXT_WINDOW_BYTES,
  textWindow,
  trimBlock,
  trimPage,
  trimSearchResult,
} from './format.js';

const NOTION_VERSION = '2026-03-11';

const NOT_SHARED =
  'Notion found nothing with that ID that this connection can see. Check the ID; if it is right, the page is not shared with the connection: '
  + 'in Notion, open the page, click ••• > Connections > + Add connection and pick the connection';
const WRITE_REFUSED =
  'Notion refused the change: the connection may lack the Update content or Insert content capability (the connection\'s Configuration tab '
  + 'in Notion\'s Developer portal), or a Free workspace with several members has used up its block limit';

const ID_SCHEMA = { type: 'string' as const, minLength: 32, maxLength: 2000 };
const CURSOR_SCHEMA = { type: 'string' as const, description: 'nextCursor from the previous result; pass the same other arguments again.' };
const MARKDOWN_HELP =
  'Notion-flavored Markdown: # to #### headings, lists, - [ ] to-dos, > quotes, fenced code with a language, --- dividers, '
  + '![caption](https://...) images on their own line, pipe tables, <callout icon="💡">...</callout> and <toggle>...</toggle> blocks. '
  + 'Write \\< for a literal < outside code.';

function cursorState(h: ToolHelpers, cursor: string | undefined): { start?: string; skip: number } {
  const state = h.cursor(cursor);
  return {
    ...(typeof state?.['c'] === 'string' && state['c'] ? { start: state['c'] } : {}),
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
  };
}

/** A Notion list result through h.page, with a cursor that continues within the page or at Notion's next one. */
function notionPage(h: ToolHelpers, key: string, data: any, items: unknown[], start: string | undefined, skip: number, extra?: Record<string, unknown>) {
  const next = data?.has_more === true && typeof data?.next_cursor === 'string' ? data.next_cursor : undefined;
  return h.page({
    key,
    items: items.slice(skip),
    ...(extra ? { extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...(start ? { c: start } : {}), o: skip + index }),
    ...(next ? { nextPage: h.makeCursor({ c: next, o: 0 }) } : {}),
  });
}

function incompleteNote(data: any): string | undefined {
  const status = data?.request_status;
  if (status?.type !== 'incomplete') return undefined;
  return `Notion stopped the list early (${String(status.incomplete_reason ?? 'incomplete')}): narrow the query or the filter.`;
}

function titleProperty(title: string): Record<string, unknown> {
  return { title: [{ type: 'text', text: { content: title } }] };
}

function hasTitleValue(properties: Record<string, unknown> | undefined): boolean {
  return Object.values(properties ?? {}).some((value) => typeof value === 'object' && value !== null && 'title' in value);
}

function assertObjects(list: unknown[] | undefined, name: string): void {
  (list ?? []).forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ToolFailure(`${name}[${index}] must be a Notion block object, such as {"type":"paragraph","paragraph":{"rich_text":[...]}}. Nothing was sent.`);
    }
  });
}

function markdownResult(id: string, data: any, extra: Record<string, unknown>): Record<string, unknown> {
  const warnings = Array.isArray(data?.warnings) ? data.warnings.slice(0, 10).map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item)).slice(0, 300)) : undefined;
  return compact({
    id,
    ...extra,
    page_markdown_length: typeof data?.markdown === 'string' ? data.markdown.length : undefined,
    warnings: warnings?.length ? warnings : undefined,
  });
}

async function patchMarkdown(h: ToolHelpers, id: string, body: Record<string, unknown>, refused: string) {
  return h.api({
    method: 'PATCH',
    path: `/v1/pages/${id}/markdown`,
    json: { ...body, markdown_version: 'v2' },
    write: true,
    errors: { 400: refused, 403: WRITE_REFUSED, 404: NOT_SHARED },
  });
}

const connector = defineConnector({
  vendor: 'notion',
  label: 'Notion',
  origins: ['https://api.notion.com'],
  credentials: ['token'],
  credentialLabels: { token: 'Notion API token' },
  normalizeCredentials: (credentials) => ({ ...credentials, token: (credentials['token'] ?? '').replace(/^Bearer\s+/i, '') }),
  authHeaders: (credentials) => ({
    authorization: `Bearer ${credentials['token']}`,
    'notion-version': NOTION_VERSION,
  }),
  tools: [
    {
      name: 'get_connection',
      kind: 'read',
      title: 'Check the Notion connection',
      description:
        'Checks that the Notion token works and says what it is: the connection\'s name, its workspace, and whether it is an internal '
        + 'connection (it sees only the pages shared with it) or acts as a person.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await h.api({ path: '/v1/users/me' });
        const ownerType = data?.bot?.owner?.type;
        const kind = data?.type === 'person' || ownerType === 'user'
          ? 'acts as a person: reaches what that person can open'
          : 'internal connection: reaches only the pages and databases shared with it';
        return compact({
          id: data?.id,
          name: data?.name ?? undefined,
          type: data?.type,
          workspace_name: data?.bot?.workspace_name ?? undefined,
          owner_type: ownerType,
          reach: kind,
        });
      },
    },
    {
      name: 'search',
      kind: 'read',
      title: 'Search Notion pages and databases',
      description:
        'Searches the pages and data sources (databases) this connection can see, by title (not page text), most recently edited first '
        + 'by default. Leave query out to list everything shared with the connection. Each result has its type, ID, title, link, parent and '
        + 'last edit. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 500, description: 'Words in the title. Leave out to list everything.' },
          filter: { type: 'string', enum: ['page', 'data_source'], description: 'page for pages only, data_source for databases only; leave out for both.' },
          sort: { type: 'string', enum: ['descending', 'ascending'], default: 'descending', description: 'By last edit time: descending (default) or ascending.' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Results per page, 1 to 100 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { query?: string; filter?: string; sort: string; page_size: number; cursor?: string }, h) {
        const { start, skip } = cursorState(h, args.cursor);
        const { data } = await h.api({
          method: 'POST',
          path: '/v1/search',
          safe: true,
          json: compact({
            query: args.query,
            filter: args.filter ? { property: 'object', value: args.filter } : undefined,
            sort: { timestamp: 'last_edited_time', direction: args.sort },
            page_size: args.page_size,
            start_cursor: start,
          }),
        });
        const results: unknown[] = Array.isArray(data?.results) ? data.results.map(trimSearchResult) : [];
        const note = results.length || skip
          ? incompleteNote(data)
          : 'Nothing found. A connection sees only the pages and databases shared with it (in Notion: ••• > Connections > + Add connection on the page).';
        return notionPage(h, 'results', data, results, start, skip, note ? { note } : undefined);
      },
    },
    {
      name: 'get_page',
      kind: 'read',
      title: 'Get a Notion page',
      description:
        'Reads one page (or database row) by its ID or link: title, link, parent, trash state, last edit, and every property with its type '
        + 'and value. The page body is read with read_page_markdown or list_block_children.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      async run(args: { page_id: string }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await h.api({ path: `/v1/pages/${id}`, errors: { 404: NOT_SHARED } });
        return trimPage(data, 'typed');
      },
    },
    {
      name: 'read_page_markdown',
      kind: 'read',
      title: 'Read a Notion page as Markdown',
      description:
        'Reads a page\'s body as Notion-flavored Markdown, the shortest way to read or quote a page. A long body comes in windows of about '
        + '24 KB: pass nextCursor back as cursor for the next one. Blocks Notion left out (a very long page, or content not shared with the '
        + 'connection) are listed by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' },
          include_transcript: { type: 'boolean', default: false, description: 'Include meeting notes transcripts (default false).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['page_id'],
        additionalProperties: false,
      },
      async run(args: { page_id: string; include_transcript: boolean; cursor?: string }, h) {
        const id = notionId(args.page_id, 'page_id');
        const state = h.cursor(args.cursor);
        const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({
          path: `/v1/pages/${id}/markdown`,
          query: { markdown_version: 'v2', include_transcript: args.include_transcript ? true : undefined },
          errors: { 404: NOT_SHARED },
        });
        const markdown = typeof data?.markdown === 'string' ? data.markdown : '';
        const window = textWindow(markdown, offset, TEXT_WINDOW_BYTES);
        const unknown: string[] = Array.isArray(data?.unknown_block_ids) ? data.unknown_block_ids.map(String) : [];
        return compact({
          id,
          markdown: window.text,
          offset: window.offset || undefined,
          length: markdown.length,
          nextCursor: window.next !== undefined ? h.makeCursor({ o: window.next }) : undefined,
          left_out_block_ids: unknown.length ? unknown.slice(0, 50) : undefined,
          note: data?.truncated === true || unknown.length
            ? `Notion left ${unknown.length} block(s) out${data?.truncated === true ? ' (the page is too long for one read)' : ''}: `
              + 'read each with read_page_markdown on its ID, or with list_block_children.'
            : undefined,
        });
      },
    },
    {
      name: 'list_block_children',
      kind: 'read',
      title: 'List the blocks of a Notion page',
      description:
        'Lists one level of a page\'s or block\'s child blocks, up to 100 per page, each with its ID, type and text: the IDs to append after '
        + 'a block, update one or move one to the trash. A block with has_children (a toggle, a nested list, a child page) is read with '
        + 'the same tool on its own ID. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          block_id: { ...ID_SCHEMA, description: 'The page or block ID, or the page\'s Notion link.' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Blocks per page, 1 to 100 (default 100).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['block_id'],
        additionalProperties: false,
      },
      async run(args: { block_id: string; page_size: number; cursor?: string }, h) {
        const id = notionId(args.block_id, 'block_id', true);
        const { start, skip } = cursorState(h, args.cursor);
        const { data } = await h.api({
          path: `/v1/blocks/${id}/children`,
          query: { page_size: args.page_size, start_cursor: start },
          errors: { 404: NOT_SHARED },
        });
        const blocks: unknown[] = Array.isArray(data?.results) ? data.results.map(trimBlock) : [];
        return notionPage(h, 'blocks', data, blocks, start, skip, { parent_id: id });
      },
    },
    {
      name: 'get_block',
      kind: 'read',
      title: 'Get a Notion block',
      description: 'Reads one block by its ID: its type, text, to-do state and whether it has children or is in the trash.',
      inputSchema: {
        type: 'object',
        properties: { block_id: { ...ID_SCHEMA, description: 'The block ID (list_block_children lists them), or a link to the block.' } },
        required: ['block_id'],
        additionalProperties: false,
      },
      async run(args: { block_id: string }, h) {
        const id = notionId(args.block_id, 'block_id', true);
        const { data } = await h.api({ path: `/v1/blocks/${id}`, errors: { 404: NOT_SHARED } });
        return compact({ ...trimBlock(data), parent: parentOf(data) });
      },
    },
    {
      name: 'get_database',
      kind: 'read',
      title: 'Get a Notion database',
      description:
        'Reads a database by its ID or link: its title, link and the data sources inside it. Queries, new rows and the schema use a '
        + 'data source ID from this list, never the database ID.',
      inputSchema: {
        type: 'object',
        properties: { database_id: { ...ID_SCHEMA, description: 'The database ID, or its Notion link (the part before ?v=).' } },
        required: ['database_id'],
        additionalProperties: false,
      },
      async run(args: { database_id: string }, h) {
        const id = notionId(args.database_id, 'database_id');
        const { data } = await h.api({ path: `/v1/databases/${id}`, errors: { 404: NOT_SHARED } });
        return compact({
          id: data?.id,
          title: plain(data?.title) || '(untitled)',
          url: data?.url,
          parent: parentOf(data),
          in_trash: data?.in_trash === true ? true : undefined,
          data_sources: Array.isArray(data?.data_sources)
            ? data.data_sources.map((source: any) => compact({ id: source?.id, name: source?.name || '(untitled)' }))
            : [],
        });
      },
    },
    {
      name: 'get_data_source',
      kind: 'read',
      title: 'Get a Notion data source schema',
      description:
        'Reads a data source\'s schema: every property with its type and ID (the title property first), the option names of select, '
        + 'multi-select and status properties, relation targets, and which properties Notion computes. Read it before writing rows: '
        + 'property names are case-sensitive and option names must match exactly.',
      inputSchema: {
        type: 'object',
        properties: { data_source_id: { ...ID_SCHEMA, description: 'The data source ID, from get_database or search.' } },
        required: ['data_source_id'],
        additionalProperties: false,
      },
      async run(args: { data_source_id: string }, h) {
        const id = notionId(args.data_source_id, 'data_source_id');
        const { data } = await h.api({ path: `/v1/data_sources/${id}`, errors: { 404: NOT_SHARED } });
        return compact({
          id: data?.id,
          title: plain(data?.title) || '(untitled)',
          database_id: data?.parent?.database_id,
          properties: schemaProperties(data),
        });
      },
    },
    {
      name: 'query_data_source',
      kind: 'read',
      title: 'Query a Notion database',
      description:
        'Lists the rows of a data source, with an optional Notion filter and sorts, e.g. filter {"and":[{"property":"Status","status":'
        + '{"does_not_equal":"Done"}},{"property":"Due","date":{"on_or_before":"2026-11-28"}}]} and sorts [{"property":"Due","direction":'
        + '"ascending"}]. Each row has its ID, title, link and property values; properties keeps only the named ones. Pass nextCursor back as '
        + 'cursor (with the same filter) for more. Notion allows about 3 queries a second.',
      inputSchema: {
        type: 'object',
        properties: {
          data_source_id: { ...ID_SCHEMA, description: 'The data source ID, from get_database or search.' },
          filter: { type: 'object', description: 'A Notion filter object; the key of each condition is the property\'s type.' },
          sorts: { type: 'array', maxItems: 10, items: { type: 'object' }, description: 'Notion sort objects; the first sort wins.' },
          properties: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Property names to return (default: all).' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Rows per page, 1 to 100 (default 50).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['data_source_id'],
        additionalProperties: false,
      },
      async run(args: { data_source_id: string; filter?: object; sorts?: object[]; properties?: string[]; page_size: number; cursor?: string }, h) {
        const id = notionId(args.data_source_id, 'data_source_id');
        const { start, skip } = cursorState(h, args.cursor);
        const { data } = await h.api({
          method: 'POST',
          path: `/v1/data_sources/${id}/query`,
          safe: true,
          json: compact({ filter: args.filter, sorts: args.sorts, page_size: args.page_size, start_cursor: start }),
          errors: { 404: NOT_SHARED },
        });
        const rows: unknown[] = Array.isArray(data?.results)
          ? data.results.map((row: any) => {
            const { parent: _parent, created_time: _created, ...rest } = trimPage(row, 'flat', args.properties);
            const properties = { ...(rest['properties'] as Record<string, unknown>) };
            for (const [name, value] of Object.entries(row?.properties ?? {}) as Array<[string, any]>) {
              if (value?.type === 'title') delete properties[name];
            }
            return { ...rest, properties };
          })
          : [];
        const note = incompleteNote(data) ?? (rows.length || skip ? undefined : 'No rows match.');
        return notionPage(h, 'rows', data, rows, start, skip, note ? { data_source_id: id, note } : { data_source_id: id });
      },
    },
    {
      name: 'list_users',
      kind: 'read',
      title: 'List Notion workspace members',
      description:
        'Lists the people and bots of the workspace with their IDs, to fill a person property by name. It needs a user information '
        + 'capability on the connection, and personal access tokens cannot use it. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Users per page, 1 to 100 (default 100).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { page_size: number; cursor?: string }, h) {
        const { start, skip } = cursorState(h, args.cursor);
        const { data } = await h.api({
          path: '/v1/users',
          query: { page_size: args.page_size, start_cursor: start },
          errors: { 403: 'Notion refused to list users: the connection needs a user information capability, and personal access tokens cannot list users' },
        });
        const users: unknown[] = Array.isArray(data?.results)
          ? data.results.map((user: any) => compact({ id: user?.id, name: user?.name ?? undefined, type: user?.type, email: user?.person?.email }))
          : [];
        return notionPage(h, 'users', data, users, start, skip);
      },
    },
    {
      name: 'create_page',
      kind: 'create',
      check: 'search',
      title: 'Create a Notion page',
      description:
        'Creates a page under a parent page, or a row in a data source with its properties, with a body in Markdown or as blocks (up to 100; '
        + 'append the rest with append_blocks). Under a page, a Markdown body\'s first # heading becomes the title when title is left out. '
        + 'workspace: true makes a private top-level page, for personal access tokens only. Returns the new page with its link.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_page_id: { ...ID_SCHEMA, description: 'Create the page under this page (its ID or link).' },
          data_source_id: { ...ID_SCHEMA, description: 'Create a row in this data source (from get_database); set its properties.' },
          workspace: { type: 'boolean', description: 'true: a private page at the top of the workspace (personal access tokens only).' },
          title: { type: 'string', minLength: 1, maxLength: 2000, description: 'The page title.' },
          properties: {
            type: 'object',
            description:
              'Property values keyed by name, as Notion takes them: {"Status":{"status":{"name":"Draft"}},"Due":{"date":{"start":"2026-11-28"}},'
              + '"Tags":{"multi_select":[{"name":"Q4"}]}}. Read get_data_source first for names and options.',
          },
          markdown: { type: 'string', minLength: 1, maxLength: 400000, description: `The body. ${MARKDOWN_HELP} Up to 5,000 blocks.` },
          children: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' }, description: 'The body as Notion block objects instead of markdown.' },
          icon: { type: 'string', minLength: 1, maxLength: 16, description: 'An emoji for the page icon.' },
          cover_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public https image URL for the page cover.' },
        },
        additionalProperties: false,
      },
      async run(args: {
        parent_page_id?: string;
        data_source_id?: string;
        workspace?: boolean;
        title?: string;
        properties?: Record<string, unknown>;
        markdown?: string;
        children?: unknown[];
        icon?: string;
        cover_url?: string;
      }, h) {
        const parents = [args.parent_page_id !== undefined, args.data_source_id !== undefined, args.workspace === true].filter(Boolean).length;
        if (parents !== 1) throw new ToolFailure('Give exactly one parent: parent_page_id, data_source_id, or workspace: true. Nothing was sent.');
        if (args.markdown !== undefined && args.children !== undefined) throw new ToolFailure('Give markdown or children, not both. Nothing was sent.');
        assertObjects(args.children, 'children');
        const parent = args.parent_page_id !== undefined
          ? { page_id: notionId(args.parent_page_id, 'parent_page_id') }
          : args.data_source_id !== undefined
            ? { type: 'data_source_id', data_source_id: notionId(args.data_source_id, 'data_source_id') }
            : { workspace: true };
        const properties: Record<string, unknown> = { ...(args.properties ?? {}) };
        if (args.title !== undefined && !hasTitleValue(properties)) properties['title'] = titleProperty(args.title);
        const { data } = await h.api({
          method: 'POST',
          path: '/v1/pages',
          json: compact({
            parent,
            properties: Object.keys(properties).length ? properties : undefined,
            markdown: args.markdown,
            markdown_version: args.markdown !== undefined ? 'v2' : undefined,
            children: args.children,
            icon: args.icon !== undefined ? { type: 'emoji', emoji: args.icon } : undefined,
            cover: args.cover_url !== undefined ? { type: 'external', external: { url: args.cover_url } } : undefined,
          }),
          write: true,
          errors: { 403: WRITE_REFUSED, 404: NOT_SHARED },
        });
        return trimPage(data, 'typed');
      },
    },
    {
      name: 'append_markdown',
      kind: 'create',
      check: 'read_page_markdown',
      title: 'Add Markdown to a Notion page',
      description:
        'Adds Markdown at the end of a page (or at its start). Sending it twice adds it twice. If Notion refuses the Markdown insert, '
        + 'append_blocks adds blocks instead.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' },
          markdown: { type: 'string', minLength: 1, maxLength: 400000, description: `What to add. ${MARKDOWN_HELP}` },
          position: { type: 'string', enum: ['end', 'start'], default: 'end', description: 'end (default) or start of the page.' },
        },
        required: ['page_id', 'markdown'],
        additionalProperties: false,
      },
      async run(args: { page_id: string; markdown: string; position: 'end' | 'start' }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await patchMarkdown(h, id, {
          type: 'insert_content',
          insert_content: { content: args.markdown, position: { type: args.position } },
        }, 'Notion did not accept the Markdown insert; append_blocks adds the same content as blocks');
        return markdownResult(id, data, { appended: true, position: args.position });
      },
    },
    {
      name: 'append_blocks',
      kind: 'create',
      check: 'list_block_children',
      title: 'Add blocks to a Notion page',
      description:
        'Adds up to 100 Notion block objects to a page or inside a block (a toggle, a list item), at the end by default, at the start, or '
        + 'right after a block whose ID list_block_children gave. Blocks nest at most two levels per call; send longer content in further '
        + 'calls, in order. Returns the new blocks with their IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          block_id: { ...ID_SCHEMA, description: 'The page or block to add to (ID or the page\'s link).' },
          children: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'object' },
            description: 'Notion block objects, e.g. {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"Ship it"}}],"checked":false}}.',
          },
          position: { type: 'string', enum: ['end', 'start'], default: 'end', description: 'end (default) or start; ignored with after_block_id.' },
          after_block_id: { ...ID_SCHEMA, description: 'Put the blocks right after this child block.' },
        },
        required: ['block_id', 'children'],
        additionalProperties: false,
      },
      async run(args: { block_id: string; children: unknown[]; position: 'end' | 'start'; after_block_id?: string }, h) {
        const id = notionId(args.block_id, 'block_id', true);
        assertObjects(args.children, 'children');
        const position = args.after_block_id !== undefined
          ? { type: 'after_block', after_block: { id: notionId(args.after_block_id, 'after_block_id', true) } }
          : { type: args.position };
        const { data } = await h.api({
          method: 'PATCH',
          path: `/v1/blocks/${id}/children`,
          json: { children: args.children, position },
          write: true,
          errors: { 403: WRITE_REFUSED, 404: NOT_SHARED },
        });
        const blocks: unknown[] = Array.isArray(data?.results) ? data.results.map(trimBlock) : [];
        return { parent_id: id, appended: args.children.length, blocks };
      },
    },
    {
      name: 'update_page_text',
      kind: 'update',
      check: 'read_page_markdown',
      title: 'Edit text in a Notion page',
      description:
        'Changes words in place: each old_text is replaced with new_text in the page\'s Markdown. old_text must match exactly one place, '
        + 'case-sensitive (copy it from read_page_markdown and make it longer until it is unique), unless replace_all is true. An edit that '
        + 'would remove a child page or database is refused by Notion.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', minLength: 1, maxLength: 100000, description: 'The exact passage to replace.' },
                new_text: { type: 'string', maxLength: 100000, description: 'The new passage (empty removes the old one).' },
                replace_all: { type: 'boolean', description: 'Replace every match instead of exactly one.' },
              },
              required: ['old_text', 'new_text'],
              additionalProperties: false,
            },
            description: 'The replacements, applied in order.',
          },
        },
        required: ['page_id', 'edits'],
        additionalProperties: false,
      },
      async run(args: { page_id: string; edits: Array<{ old_text: string; new_text: string; replace_all?: boolean }> }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await patchMarkdown(h, id, {
          type: 'update_content',
          update_content: {
            content_updates: args.edits.map((edit) => compact({ old_str: edit.old_text, new_str: edit.new_text, replace_all_matches: edit.replace_all })),
          },
        }, 'Notion did not apply the edits (each old_text must match exactly one place, case-sensitive, unless replace_all is set: copy it from read_page_markdown)');
        return markdownResult(id, data, { edits_applied: args.edits.length });
      },
    },
    {
      name: 'replace_page_markdown',
      kind: 'update',
      check: 'read_page_markdown',
      title: 'Replace a Notion page body',
      description:
        'Replaces the whole body of a page with new Markdown. The old body is gone from the page (Notion\'s page history keeps it). Child '
        + 'pages and databases are never deleted: Notion refuses a replacement that would remove them.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' },
          markdown: { type: 'string', minLength: 1, maxLength: 400000, description: `The new body. ${MARKDOWN_HELP}` },
        },
        required: ['page_id', 'markdown'],
        additionalProperties: false,
      },
      async run(args: { page_id: string; markdown: string }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await patchMarkdown(h, id, {
          type: 'replace_content',
          replace_content: { new_str: args.markdown },
        }, 'Notion did not replace the body (a replacement that would remove a child page or database is refused)');
        return markdownResult(id, data, { replaced: true });
      },
    },
    {
      name: 'update_page',
      kind: 'update',
      check: 'get_page',
      title: 'Update a Notion page\'s properties',
      description:
        'Renames a page or changes a database row\'s properties, icon or cover. Only what is given changes; a multi-select, people or relation '
        + 'value replaces the whole list, and null clears a value ({"Due":{"date":null}}). silent: true sends no notifications, for bulk updates.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' },
          title: { type: 'string', minLength: 1, maxLength: 2000, description: 'A new title.' },
          properties: { type: 'object', description: 'Property values keyed by name, as in create_page.' },
          icon: { type: 'string', minLength: 1, maxLength: 16, description: 'An emoji for the page icon.' },
          cover_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public https image URL for the cover.' },
          silent: { type: 'boolean', default: false, description: 'true: no notifications to people (default false).' },
        },
        required: ['page_id'],
        additionalProperties: false,
      },
      async run(args: { page_id: string; title?: string; properties?: Record<string, unknown>; icon?: string; cover_url?: string; silent: boolean }, h) {
        const id = notionId(args.page_id, 'page_id');
        const properties: Record<string, unknown> = { ...(args.properties ?? {}) };
        if (args.title !== undefined && !hasTitleValue(properties)) properties['title'] = titleProperty(args.title);
        const body = compact({
          properties: Object.keys(properties).length ? properties : undefined,
          icon: args.icon !== undefined ? { type: 'emoji', emoji: args.icon } : undefined,
          cover: args.cover_url !== undefined ? { type: 'external', external: { url: args.cover_url } } : undefined,
        });
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give title, properties, icon or cover_url. Nothing was changed.');
        if (args.silent) body['notifications'] = { mode: 'silent' };
        const { data } = await h.api({ method: 'PATCH', path: `/v1/pages/${id}`, json: body, write: true, errors: { 403: WRITE_REFUSED, 404: NOT_SHARED } });
        return trimPage(data, 'typed');
      },
    },
    {
      name: 'update_block',
      kind: 'update',
      check: 'get_block',
      title: 'Update a Notion block',
      description:
        'Changes one block, e.g. ticks a to-do with {"to_do":{"checked":true}} or rewrites a paragraph with {"paragraph":{"rich_text":'
        + '[{"type":"text","text":{"content":"New text"}}]}}. A field left out keeps its value; new text replaces the block\'s whole text.',
      inputSchema: {
        type: 'object',
        properties: {
          block_id: { ...ID_SCHEMA, description: 'The block ID (list_block_children lists them), or a link to the block.' },
          block: { type: 'object', description: 'The change, keyed by the block\'s type.' },
        },
        required: ['block_id', 'block'],
        additionalProperties: false,
      },
      async run(args: { block_id: string; block: Record<string, unknown> }, h) {
        const id = notionId(args.block_id, 'block_id', true);
        if (!Object.keys(args.block).length) throw new ToolFailure('Nothing to change: block is empty. Nothing was changed.');
        if ('in_trash' in args.block || 'archived' in args.block) {
          throw new ToolFailure('Use trash_block to move a block to the trash. Nothing was changed.');
        }
        const { data } = await h.api({ method: 'PATCH', path: `/v1/blocks/${id}`, json: args.block, write: true, errors: { 403: WRITE_REFUSED, 404: NOT_SHARED } });
        return trimBlock(data);
      },
    },
    {
      name: 'trash_page',
      kind: 'delete',
      check: 'get_page',
      title: 'Move a Notion page to the trash',
      description:
        'Moves a page or a database row to Notion\'s Trash. It can be restored with restore_page (a top-level private page only from Notion\'s '
        + 'Trash). Notion\'s API cannot delete anything for good.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      async run(args: { page_id: string }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await h.api({ method: 'PATCH', path: `/v1/pages/${id}`, json: { in_trash: true }, write: true, errors: { 403: WRITE_REFUSED, 404: NOT_SHARED } });
        return compact({ id: data?.id ?? id, title: pageTitle(data) || undefined, url: data?.url, in_trash: data?.in_trash ?? true });
      },
    },
    {
      name: 'restore_page',
      kind: 'update',
      check: 'get_page',
      title: 'Restore a Notion page from the trash',
      description: 'Takes a page or a database row out of Notion\'s Trash.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { ...ID_SCHEMA, description: 'The page ID or its Notion link.' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      async run(args: { page_id: string }, h) {
        const id = notionId(args.page_id, 'page_id');
        const { data } = await h.api({ method: 'PATCH', path: `/v1/pages/${id}`, json: { in_trash: false }, write: true, errors: { 403: WRITE_REFUSED, 404: NOT_SHARED } });
        return compact({ id: data?.id ?? id, title: pageTitle(data) || undefined, url: data?.url, in_trash: data?.in_trash ?? false });
      },
    },
    {
      name: 'trash_block',
      kind: 'delete',
      check: 'get_block',
      title: 'Move a Notion block to the trash',
      description: 'Moves one block to Notion\'s Trash; it is restored from Notion\'s Trash in the app. Notion\'s API cannot delete anything for good.',
      inputSchema: {
        type: 'object',
        properties: { block_id: { ...ID_SCHEMA, description: 'The block ID (list_block_children lists them), or a link to the block.' } },
        required: ['block_id'],
        additionalProperties: false,
      },
      async run(args: { block_id: string }, h) {
        const id = notionId(args.block_id, 'block_id', true);
        const { data } = await h.api({ method: 'DELETE', path: `/v1/blocks/${id}`, write: true, errors: { 403: WRITE_REFUSED, 404: NOT_SHARED } });
        return compact({ ...trimBlock(data), id: data?.id ?? id, in_trash: data?.in_trash ?? true });
      },
    },
    // The rest of the Notion API: comments, file uploads, data source and database changes, moving pages.
    ...apiTools({
      label: 'Notion',
      description:
        'The Notion API at https://api.notion.com/v1, with the connected token and Notion-Version 2026-03-11: paths start with /v1/, such as '
        + '/v1/comments (with block_id in query), /v1/blocks/{id} or /v1/data_sources/{id}. Reference: https://developers.notion.com/reference.',
      basePath: '/v1/',
      methods: ['POST', 'PATCH', 'DELETE'],
    }),
  ],
});

export = connector;
