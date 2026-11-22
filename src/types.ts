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
 * redirects are not followed. Any other URL is a media download (GET only,
 * public https addresses only). It resolves to a standard Response or rejects;
 * a rejection whose `code` is "URL_REFUSED" means nothing was sent.
 */
export type ConnectorFetch = (url: string, init?: ConnectorRequestInit) => Promise<Response>;

/**
 * Account selections, e.g. { "pages": ["123"] }. null means the host applies
 * no account lock (the stdio CLI without CONNECTOR_ACCOUNTS).
 */
export type ConnectorAccounts = Record<string, string[]> | null;

/** Passed to every call. Nothing in it outlives the call inside the module, except cached sessions. */
export interface ToolContext {
  credentials: Record<string, string>;
  accounts: ConnectorAccounts;
  fetch: ConnectorFetch;
  signal?: AbortSignal;
  log(text: string): void;
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
  /** The ctx.credentials names the module reads, e.g. ["api_key"]. */
  credentials: string[];
  tools: ToolDescriptor[];
  call(toolName: string, args: unknown, ctx: ToolContext): Promise<CallToolResult>;
}
