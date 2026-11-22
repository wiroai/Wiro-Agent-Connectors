// A minimal connector module, to copy when adding a service.
//
//   cp -r src/vendors/_template src/vendors/<vendor>
//
// then rename `vendor` below to the folder name and replace the example API
// with the real one. CONTRIBUTING.md walks through every step.
//
// The build bundles this file and src/core into one dependency-free CommonJS
// file, dist/vendors/<vendor>.js. Inside a module:
// - every request goes through h.api (to your origins) or h.media (public
//   https files); both use ctx.fetch, which the host guards. Never call fetch
//   yourself, and never import an npm package or a Node module;
// - no console, process or Buffer: stdout belongs to the MCP protocol, and the
//   module must run on web-standard globals only;
// - tool texts name only the service ("Example"), never any other product.

import { apiTools, defineConnector, requireAccounts } from '../../core/index.js';

// The trimmed shape an agent gets back: only the fields it needs.
function trimItem(item: any) {
  return { id: item?.id, name: item?.name, url: item?.url };
}

const connector = defineConnector({
  // ^[a-z][a-z0-9-]{1,29}$, the same as the folder name. The CLI reads each
  // credential from the environment as <VENDOR>_<CREDENTIAL>: EXAMPLE_API_KEY.
  vendor: 'example',
  // The service's own name. Error messages use it.
  label: 'Example',
  // The only origins the module may call. The host refuses any other API URL.
  origins: ['https://api.example.com'],
  // Only when the API lives at an address the user gives (an instance, a
  // site, a shop): the credential that holds it, also listed in credentials,
  // e.g. originFields: ['site_url']. Reach it with
  // h.api({ origin: h.originOf('site_url'), path }).
  originFields: [],
  // Names the module reads from ctx.credentials. All are required, unless
  // requiredCredentials lists alternatives. For a service that takes an OAuth
  // token or an API key, say, credentials: ['access_token', 'api_key'] with
  // requiredCredentials: [['access_token'], ['api_key']] lets a call go ahead
  // with either one (authHeaders then sends the one given); a credential in
  // no list is optional.
  credentials: ['api_key'],
  credentialLabels: { api_key: 'Example API key' },
  // The accounts a host lets the user choose after connecting. The host runs
  // `tool` (a read tool with no required argument) to list the candidates,
  // reads each item's id and name at idField and nameField (dot paths), and
  // passes the chosen ids on every call as ctx.accounts[key]. Tools check
  // them with requireAccounts under the same key, as create_item does.
  accountPickers: [
    {
      key: 'workspaces',
      label: 'Example workspaces',
      description: 'The workspaces the agent may create items in.',
      multiple: true,
      tool: 'list_workspaces',
      idField: 'id',
      nameField: 'name',
    },
  ],
  // Added to every API request (never to media downloads).
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['api_key']}` }),
  tools: [
    {
      name: 'list_items',
      // read | create | update | delete: the MCP annotations follow from it,
      // and a read tool can only send GET requests.
      kind: 'read',
      title: 'List Example items',
      description: 'Lists the items of the connected Example account, newest first. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page, 1 to 100 (default 20).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        // Required: unknown arguments are refused with a clear message.
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        // A cursor this tool made earlier, or null on the first page.
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;

        // HTTP errors become clear tool errors (429 carries retryAfter). Nothing is retried.
        const { data } = await h.api({ path: '/v1/items', query: { limit: args.limit, page } });
        const items: unknown[] = Array.isArray(data?.items) ? data.items : [];

        // h.page keeps the result under 32 KB. If it has to cut the list, the
        // cursor continues right after the last item returned.
        return h.page({
          key: 'items',
          items: items.map(trimItem).slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(page ? { p: page } : {}), o: skip + index }),
          ...(typeof data?.next_page === 'string' ? { nextPage: h.makeCursor({ p: data.next_page, o: 0 }) } : {}),
        });
      },
    },
    {
      // The workspaces picker's tool. Hosts call it with no arguments, then
      // with cursor while the result has a nextCursor, so it pages like
      // list_items and returns one list whose items carry id and name.
      name: 'list_workspaces',
      kind: 'read',
      title: 'List Example workspaces',
      description: 'Lists the workspaces of the connected Example account, with their ids and names. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: '/v1/workspaces', query: { page } });
        const workspaces: any[] = Array.isArray(data?.workspaces) ? data.workspaces : [];
        return h.page({
          key: 'workspaces',
          items: workspaces.map((workspace) => ({ id: workspace?.id, name: workspace?.name })).slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(page ? { p: page } : {}), o: skip + index }),
          ...(typeof data?.next_page === 'string' ? { nextPage: h.makeCursor({ p: data.next_page, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'create_item',
      kind: 'create',
      // A write tool names the read tool to check with when its outcome is
      // unknown (a timeout or a 5xx after the request was sent).
      check: 'list_items',
      title: 'Create an Example item',
      description: 'Creates an item in one of the workspaces chosen for this connection. Returns the new item.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', minLength: 1, description: 'The workspace to create the item in.' },
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The item name.' },
        },
        required: ['workspace_id', 'name'],
        additionalProperties: false,
      },
      async run(args: { workspace_id: string; name: string }, h) {
        // Account-scoped arguments are checked against the host's selection
        // (ctx.accounts) before anything is sent.
        requireAccounts(h.ctx.accounts, 'workspaces', args.workspace_id, 'workspace');

        // write: true marks the request that makes the change. If it fails
        // without a clear answer, the result says the outcome is unknown and
        // names the check tool; it is never sent twice.
        const { data } = await h.api({
          method: 'POST',
          path: `/v1/workspaces/${encodeURIComponent(args.workspace_id)}/items`,
          json: { name: args.name },
          write: true,
        });
        return trimItem(data);
      },
    },
    // api_get and api_request: the rest of the API, for what the tools above
    // do not cover. They send the auth headers and keep to basePath. With an
    // account lock, a path must name one of the chosen workspaces as a whole
    // segment; give accounts.ids when a path can name more than one account.
    // api_request is never retried, and api_get is its check tool.
    ...apiTools({
      label: 'Example',
      description:
        'The Example API v1 at https://api.example.com/v1, with the connected API key: paths start with /v1/, '
        + 'such as /v1/items or /v1/workspaces/ws_1/items, and parameters go in query. Reference: https://docs.example.com/api.',
      basePath: '/v1/',
      accounts: { key: 'workspaces', label: 'workspace' },
    }),
  ],
});

// Exported as the module itself:
// { vendor, origins, originFields, credentials, requiredCredentials, accountPickers, tools, call }.
export = connector;
