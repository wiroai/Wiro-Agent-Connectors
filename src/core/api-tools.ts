import type { JsonSchema } from '../types.js';
import { allowedAccounts, requireAccounts } from './accounts.js';
import type { ToolDefinition, ToolHelpers } from './connector.js';
import { ToolFailure } from './errors.js';
import type { ApiRequest, ApiResponse, QueryValue } from './http.js';
import { jsonSize, OUTPUT_LIMIT_BYTES, shrinkToFit } from './output.js';
import { formatNumber, truncate, utf8Bytes, utf8Length } from './text.js';

// Two generic tools for the parts of a vendor's API that its own tools do not
// cover: api_get (read, GET only) and api_request (POST, PUT, PATCH or DELETE,
// never retried). Both keep to the call's origins and the module's base path,
// send the module's auth headers, and apply its account lock.

export type ApiWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request of api_get or api_request as it will be sent: what account rules and guards look at. */
export interface ApiToolRequest {
  method: 'GET' | ApiWriteMethod;
  origin: string;
  /** The path as it will be sent: "." and ".." resolved, percent-escapes kept. */
  path: string;
  /** The path's segments, percent-decoded: "/v1/sites/https%3A%2F%2Fa.example%2F" gives ["v1", "sites", "https://a.example/"]. */
  segments: string[];
  /** The query parameters, each as a list of values. */
  query: Record<string, string[]>;
  /** api_request's JSON body, when it has one. */
  json?: Record<string, unknown>;
}

/** An account lock for the generic tools. While the host applies a lock, every request must act on a chosen account. */
export interface ApiAccountRule {
  /** The ctx.accounts key, e.g. "pages". */
  key: string;
  /** One account in messages, e.g. "Page" (default "account"). */
  label?: string;
  /**
   * The account ids a request acts on; each must be chosen. Without it, a
   * request must name one of the chosen ids as a whole path segment, which is
   * enough when a path names at most one account. A request that names none
   * is refused.
   */
  ids?(request: ApiToolRequest): ReadonlyArray<string | number>;
}

export interface ApiToolsOptions {
  /** The service's own name, as in the connector's label: "Call the <label> API". */
  label: string;
  /**
   * One paragraph naming the vendor's API, its base path and its reference,
   * e.g. "The Example API v1 at https://api.example.com/v1, with the connected
   * API key: paths start with /v1/, such as /v1/items. Reference:
   * https://docs.example.com/api." It opens both tools' descriptions.
   */
  description: string;
  /** Every path must start with this prefix, e.g. "/api/" (checked after "." and ".." are resolved). */
  basePath?: string;
  /** The methods api_request may send (default POST, PUT, PATCH and DELETE). */
  methods?: ApiWriteMethod[];
  /**
   * Adds an `origin` argument with this text as its description, for a module
   * whose API spans several origins. It accepts any origin of the call
   * (h.origins); without it, requests go to the call's first origin.
   */
  originArgument?: string;
  /** Refuses requests outside the accounts chosen for the connection, before they are sent. */
  accounts?: ApiAccountRule;
  /** A last check before anything is sent: throw a ToolFailure to refuse the request. */
  guard?(request: ApiToolRequest, h: ToolHelpers): void | Promise<void>;
  /** Sends the request instead of h.api, e.g. to add a session's token. It must send at most once. */
  send?(request: ApiRequest, h: ToolHelpers): Promise<ApiResponse>;
  /** Reply headers to return besides link and location, e.g. ["x-total-count"]. */
  responseHeaders?: string[];
}

interface ApiArgs {
  method?: ApiWriteMethod;
  path: string;
  query?: Record<string, unknown>;
  origin?: string;
  json?: Record<string, unknown>;
  body?: string;
  content_type?: string;
}

const ALL_METHODS: ApiWriteMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const TEXT_TYPES = /json|^text\/|xml|javascript|x-www-form-urlencoded|csv|yaml|graphql/i;
/** Room kept under the output limit for the fields a cut reply adds. */
const NOTE_ROOM = 400;
const MAX_CUT_POINTS = 40_000;

function isQueryValue(value: unknown): value is QueryValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function nothingSent(sentence: string): ToolFailure {
  return new ToolFailure(`${sentence} Nothing was sent.`);
}

/** A reply that fits the output limit: long strings cut first, then the text itself. */
function fitReply(reply: Record<string, unknown>): Record<string, unknown> {
  if (jsonSize(reply) <= OUTPUT_LIMIT_BYTES) return reply;
  const shrunk = shrinkToFit(reply, OUTPUT_LIMIT_BYTES - NOTE_ROOM);
  if (shrunk) {
    return {
      ...(shrunk.value as Record<string, unknown>),
      truncated: true,
      note: 'Long text values were cut to fit 32 KB: ask for fewer items or fields to see them whole.',
    };
  }
  const text = typeof reply['data'] === 'string' ? reply['data'] : JSON.stringify(reply['data']) ?? '';
  const points = Array.from(text.length > MAX_CUT_POINTS ? text.slice(0, MAX_CUT_POINTS) : text);
  if (/^[\ud800-\udbff]$/.test(points[points.length - 1] ?? '')) points.pop();
  const cut = (count: number): Record<string, unknown> => ({
    status: reply['status'],
    ...(reply['headers'] ? { headers: reply['headers'] } : {}),
    truncated: true,
    note: `The reply has ${formatNumber(utf8Length(text))} bytes and was cut to fit 32 KB: ask for fewer items (the API's paging or field parameters) to see it whole.`,
    text: points.slice(0, count).join(''),
  });
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonSize(cut(middle)) <= OUTPUT_LIMIT_BYTES) low = middle;
    else high = middle - 1;
  }
  return cut(low);
}

function shapeReply(response: ApiResponse, headerNames: readonly string[]): Record<string, unknown> {
  const reply: Record<string, unknown> = { status: response.status };
  const headers: Record<string, string> = {};
  for (const name of headerNames) {
    const value = response.headers.get(name);
    if (value) headers[name] = truncate(value, 2000);
  }
  if (Object.keys(headers).length) reply['headers'] = headers;
  const type = response.headers.get('content-type') ?? '';
  if (type && !TEXT_TYPES.test(type)) {
    reply['contentType'] = truncate(type, 200);
    reply['note'] = 'The reply is a binary file and is not shown.';
    return reply;
  }
  if (response.data !== null && response.data !== undefined && response.data !== '') reply['data'] = response.data;
  return fitReply(reply);
}

function checkAccounts(rule: ApiAccountRule, request: ApiToolRequest, h: ToolHelpers): void {
  const label = rule.label ?? 'account';
  const allowed = allowedAccounts(h.ctx.accounts, rule.key);
  if (allowed === null) return;
  const namesNone = nothingSent(
    `This request names none of the ${label}s chosen for this connection. `
      + (allowed.length ? `It must name one of: ${allowed.join(', ')}.` : `No ${label} is chosen for it yet.`),
  );
  if (rule.ids) {
    const ids = rule.ids(request).map(String);
    if (!ids.length) throw namesNone;
    requireAccounts(h.ctx.accounts, rule.key, ids, label);
    return;
  }
  if (!request.segments.some((segment) => allowed.includes(segment))) throw namesNone;
}

/**
 * Builds api_get (kind read) and api_request (kind write, check: "api_get")
 * for a vendor. Spread them into the connector's tools:
 *   tools: [...ownTools, ...apiTools({ label, description, basePath: "/v1/" })]
 */
export function apiTools(options: ApiToolsOptions): ToolDefinition[] {
  const { label, basePath } = options;
  const methods = options.methods?.length ? [...new Set(options.methods)] : ALL_METHODS;
  const headerNames = ['link', 'location', ...(options.responseHeaders ?? []).map((name) => name.toLowerCase())];
  // "/api/" and "/api" both allow /api and everything under /api/, never /apix.
  const base = basePath?.replace(/\/+$/, '');

  const pathSchema: JsonSchema = {
    type: 'string',
    minLength: 1,
    maxLength: 2000,
    pattern: '^(?!.*//)/[^?#]*$',
    description: `The path${basePath ? `, starting with ${basePath}` : ''}. Query parameters go in query, not in the path.`,
  };
  const querySchema: JsonSchema = {
    type: 'object',
    description: 'Query parameters, e.g. {"page": 2, "fields": "id,name"}. A list repeats the parameter: {"id": [1, 2]} sends id=1&id=2.',
  };
  const originSchema: Record<string, JsonSchema> = options.originArgument
    ? { origin: { type: 'string', pattern: '^https://', maxLength: 300, description: options.originArgument } }
    : {};

  async function run(method: 'GET' | ApiWriteMethod, args: ApiArgs, h: ToolHelpers): Promise<unknown> {
    let origin = h.origins[0] as string;
    if (args.origin !== undefined) {
      let wanted: string | undefined;
      try {
        wanted = new URL(args.origin).origin;
      } catch {
        // reported below
      }
      if (!wanted || !h.origins.includes(wanted)) throw nothingSent(`origin must be one of: ${h.origins.join(', ')}.`);
      origin = wanted;
    }

    const url = new URL(args.path, origin);
    if (url.origin !== origin) throw nothingSent(`The path must stay on ${origin}.`);
    const path = url.pathname;
    if (base !== undefined && path !== base && !path.startsWith(`${base}/`)) throw nothingSent(`The path must start with ${basePath}.`);
    let segments: string[];
    try {
      segments = path.split('/').slice(1).map((segment) => decodeURIComponent(segment));
    } catch {
      throw nothingSent('The path has a broken percent-escape (a % not followed by two hex digits).');
    }
    if (segments[segments.length - 1] === '') segments.pop();

    const query: Record<string, QueryValue | QueryValue[]> = {};
    const queryLists: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined || value === null) continue;
      const list: unknown[] = Array.isArray(value) ? value : [value];
      if (!key || !list.every(isQueryValue)) throw nothingSent(`query.${key} must be text, a number, true or false, or a list of them.`);
      query[key] = Array.isArray(value) ? (list as QueryValue[]) : (value as QueryValue);
      queryLists[key] = list.map(String);
    }

    const request: ApiRequest = { method, origin, path, query };
    if (method !== 'GET') {
      if (args.json !== undefined && args.body !== undefined) throw nothingSent('Give json or body, not both.');
      if (args.body !== undefined && !args.content_type) throw nothingSent('content_type is required with body, e.g. "application/x-www-form-urlencoded".');
      if (args.json !== undefined && !args.content_type) {
        request.json = args.json;
      } else if (args.json !== undefined || args.body !== undefined) {
        // A raw body, or JSON with another JSON type such as application/merge-patch+json.
        request.body = utf8Bytes(args.body ?? JSON.stringify(args.json));
        request.contentType = args.content_type as string;
      }
      request.write = true;
    }

    const info: ApiToolRequest = { method, origin, path, segments, query: queryLists, ...(args.json !== undefined ? { json: args.json } : {}) };
    if (options.accounts) checkAccounts(options.accounts, info, h);
    await options.guard?.(info, h);

    const response = options.send ? await options.send(request, h) : await h.api(request);
    return shapeReply(response, headerNames);
  }

  return [
    {
      name: 'api_get',
      kind: 'read',
      title: `Call the ${label} API (GET)`,
      description:
        `${options.description} Sends one GET request with the connection's credentials and returns the HTTP status and the reply, `
        + 'JSON or text, cut to fit 32 KB (use the API\'s own paging and field parameters for long lists). It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: { path: pathSchema, query: querySchema, ...originSchema },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args: ApiArgs, h) => run('GET', args, h),
    },
    {
      name: 'api_request',
      kind: 'write',
      check: 'api_get',
      title: `Send a request to the ${label} API`,
      description:
        `${options.description} Sends one ${methods.join(', ')} request with the connection's credentials, with a JSON body (json) `
        + 'or another body (body and content_type), and returns the HTTP status and the reply. It can create, change or delete data. '
        + 'It is never retried: when the outcome is unclear, check with api_get before sending it again.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: methods, description: `The HTTP method: ${methods.join(', ')}.` },
          path: pathSchema,
          query: querySchema,
          json: { type: 'object', description: 'A JSON object to send as the body (application/json unless content_type says otherwise).' },
          body: { type: 'string', maxLength: 1_000_000, description: 'Any other body, as text, with its content_type, e.g. a form: "name=a&tags=b".' },
          content_type: {
            type: 'string',
            pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(\\s*;.*)?$',
            maxLength: 200,
            description: 'The body\'s media type, e.g. "application/x-www-form-urlencoded"; required with body.',
          },
          ...originSchema,
        },
        required: ['method', 'path'],
        additionalProperties: false,
      },
      run: (args: ApiArgs, h) => run(args.method as ApiWriteMethod, args, h),
    },
  ];
}
