// The connector module contract. A host (the stdio CLI in this package, or any
// other MCP host) loads dist/vendors/<vendor>.js and talks to it only through
// these shapes. Modules are dependency-free CommonJS and use web-standard
// globals only; every network request goes through ctx.fetch.

/** The JSON Schema subset tool inputs use. Every schema property is optional. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: ReadonlyArray<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'uri';
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/** MCP tool annotations. Modules set all four, derived from the tool's kind. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One entry of tools/list. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

export interface TextContent {
  type: 'text';
  text: string;
}

/** An MCP CallToolResult. Modules return a single JSON text block. */
export interface CallToolResult {
  content: TextContent[];
  isError?: boolean;
}

/** What a module may pass to ctx.fetch. */
export interface ConnectorRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/**
 * The host's guarded fetch. A request to one of the module's origins is an API
 * call. A request to the origin of one of its originFields credentials (a site
 * or instance URL the user gave) is an API call too, checked like a media URL:
 * https, public addresses only, connected to the checked address, and its
 * redirects are not followed. A PUT or POST with a body to a host in its
 * uploadHosts is an upload, checked the same way, on the default https port
 * and with no Authorization, Proxy-Authorization or Cookie header. Any other
 * URL is a media download (GET only, public https addresses only, no headers
 * but Accept, User-Agent and one byte range as `Range: bytes=FIRST-LAST`,
 * whose 206 reply comes back as it is; the host's size cap applies to each
 * request). It resolves to a standard Response or rejects; a rejection whose
 * `code` is "URL_REFUSED" means nothing was sent.
 */
export type ConnectorFetch = (url: string, init?: ConnectorRequestInit) => Promise<Response>;

/**
 * Account selections, e.g. { "pages": ["123"] }. null means the host applies
 * no account lock (the stdio CLI without CONNECTOR_ACCOUNTS).
 */
export type ConnectorAccounts = Record<string, string[]> | null;

/** Passed to every call. Nothing in it outlives the call inside the module, except cached sessions. */
export interface ToolContext {
  /**
   * The connection's credentials, by the names the module declares. For an
   * OAuth connection, `access_token` holds the host's current access token:
   * the host refreshes it, and the module never stores it.
   */
  credentials: Record<string, string>;
  accounts: ConnectorAccounts;
  fetch: ConnectorFetch;
  signal?: AbortSignal;
  log(text: string): void;
}

/**
 * An account selection a host offers once a connection is made, e.g. the
 * Pages an agent may post to. The host runs `tool` with no arguments (and
 * then with `cursor` set to the result's nextCursor, while there is one),
 * reads the id and the name of each item in the list it returns at `idField`
 * and `nameField`, and passes the chosen ids on every call as
 * ctx.accounts[key]. The module's account lock refuses any other account.
 */
export interface AccountPicker {
  /** The ctx.accounts key, ^[a-z][a-z0-9_]{0,63}$, e.g. "pages". */
  key: string;
  /** What is chosen, e.g. "Facebook Pages". */
  label: string;
  /** A sentence for the person choosing, e.g. "The Pages the agent may post to." */
  description?: string;
  /** true when several may be chosen, false when one is. */
  multiple: boolean;
  /** The module's read tool that lists the candidates; it takes no required argument. */
  tool: string;
  /** The dot path of an item's id, e.g. "id" or "account.id". */
  idField: string;
  /** The dot path of an item's display name, e.g. "name". */
  nameField: string;
  /** The field an older setup kept this selection in, for a host that migrates it, e.g. "pageid". */
  legacyField?: string;
}

/** What dist/vendors/<vendor>.js exports. */
export interface ConnectorModule {
  /** ^[a-z][a-z0-9-]{1,29}$, equal to the file name. */
  vendor: string;
  /** The fixed API origins the module calls, e.g. ["https://dev.to"]. */
  origins: string[];
  /**
   * Credentials whose value is a site or instance URL, e.g. ["instance_url"]
   * (empty when unused). Per call, the module may also reach the https origin
   * of each such value; hosts resolve it the same way (parseSiteUrl) and apply
   * their SSRF rules to it.
   */
  originFields: string[];
  /**
   * The hosts the module may send an upload to: a PUT or POST with a body to
   * an address its vendor's API returned, such as a pre-signed part address
   * (empty when unused). An entry with a leading dot matches every host under
   * it (".blobstore.apple.com" matches store-030.blobstore.apple.com, not
   * blobstore.apple.com), one without only that host; lowercase host names of
   * at least two labels, no IP addresses, none twice. Hosts send no
   * credentials there, check its addresses like a media URL's and never follow
   * its redirects. A module built before it existed has none.
   */
  uploadHosts: string[];
  /** The ctx.credentials names the module reads, e.g. ["api_key"]. */
  credentials: string[];
  /**
   * The credentials a call needs, as alternatives: a call goes ahead when
   * every credential of at least one list has a value, e.g. [["access_token"],
   * ["system_user_token"]]. A credential in no list is optional. By default
   * one list of every credential, so all are required.
   */
  requiredCredentials: string[][];
  /** The account selections a host offers after connecting (empty when none). */
  accountPickers: AccountPicker[];
  tools: ToolDescriptor[];
  call(toolName: string, args: unknown, ctx: ToolContext): Promise<CallToolResult>;
}
