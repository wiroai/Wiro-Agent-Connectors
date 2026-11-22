import type {
  CallToolResult,
  ConnectorModule,
  JsonSchema,
  ToolAnnotations,
  ToolContext,
  ToolDescriptor,
} from '../types.js';
import { OutcomeUnknown, ToolFailure, type FailureDetails } from './errors.js';
import { createHttp, type ApiRequest, type ApiResponse, type MediaOptions, type MediaResult } from './http.js';
import { parseSiteUrl } from './origins.js';
import { decodeCursor, encodeCursor, fitPage, shrinkToFit, type PageInput } from './output.js';
import { validateArguments } from './schema.js';

/**
 * What a tool does. The MCP annotations follow from it, so they are true by
 * construction, and a read tool can only send GET (or a request marked safe:
 * a sign-in, or a search a vendor takes by POST).
 * - read: changes nothing.
 * - create: adds something; calling it twice adds two.
 * - update: overwrites something; calling it twice with the same arguments changes nothing more.
 * - delete: removes something.
 * - write: any of these, depending on its arguments, like a generic API
 *   request (api_request). It carries MCP's own cautious defaults:
 *   destructive, and not idempotent.
 */
export type ToolKind = 'read' | 'create' | 'update' | 'delete' | 'write';

const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const VENDOR_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CREDENTIAL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** What a tool's run() gets besides its arguments. */
export interface ToolHelpers {
  readonly tool: string;
  /** The call's credentials, trimmed (and normalized by the connector, if it says how). */
  readonly credentials: Readonly<Record<string, string>>;
  readonly ctx: ToolContext;
  /**
   * The API origins this call may reach: the module's origins, then the https
   * origins of its originFields credentials. The first one is h.api's default.
   */
  readonly origins: readonly string[];
  /** The https origin a credential named in originFields gave for this call, e.g. "https://mastodon.social". */
  originOf(credential: string): string;
  /** One request to one of this call's origins. Never retried. */
  api(request: ApiRequest): Promise<ApiResponse>;
  /** Downloads a file from a public https URL through ctx.fetch (the host applies its SSRF guard). */
  media(url: string, options: MediaOptions): Promise<MediaResult>;
  /** A list result that fits the 32 KB limit, with a cursor when it had to be cut. */
  page<T>(input: PageInput<T>): Record<string, unknown>;
  /** The state inside a cursor this tool made, or null without one. */
  cursor(cursor: string | undefined): Record<string, unknown> | null;
  /** A cursor carrying `state`, for this tool only. */
  makeCursor(state: Record<string, string | number>): string;
  /** A log line for the host. Never pass arguments or credentials. */
  log(text: string): void;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  inputSchema: JsonSchema;
  /** For create, update and delete tools: the read tool to check with when the outcome is unknown. */
  check?: string;
  run(args: any, h: ToolHelpers): Promise<unknown>;
}

export interface ConnectorDefinition {
  vendor: string;
  /** The service's own name, the only name tool texts use, e.g. "dev.to". */
  label: string;
  /** The fixed https origins of the vendor's API. May be empty when originFields names the API's site. */
  origins: string[];
  /**
   * Credentials whose value is a site or instance URL, e.g. ["instance_url"]:
   * each call may also reach the https origin of that value (see
   * parseSiteUrl). It is resolved from the value the host passed, before
   * normalizeCredentials, so hosts and the module agree on it.
   */
  originFields?: string[];
  credentials: string[];
  /** Words for each credential in messages, e.g. { api_key: "dev.to API key" }. */
  credentialLabels?: Record<string, string>;
  /** Headers added to every API request (not to media downloads). */
  authHeaders?(credentials: Readonly<Record<string, string>>): Record<string, string>;
  /** Cleans credential values before use; values are trimmed either way. */
  normalizeCredentials?(credentials: Record<string, string>): Record<string, string>;
  tools: ToolDefinition[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function assertDefinition(def: ConnectorDefinition): void {
  const problem = (message: string): never => {
    throw new Error(`connector "${def.vendor}": ${message}`);
  };
  if (!VENDOR_PATTERN.test(def.vendor)) problem('vendor must match ^[a-z][a-z0-9-]{1,29}$');
  if (!def.label?.trim()) problem('label is required');
  const originFields = def.originFields ?? [];
  if (!def.origins.length && !originFields.length) problem('at least one origin or origin field is required');
  for (const origin of def.origins) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    if (!url || url.protocol !== 'https:' || url.origin !== origin) problem(`origin ${origin} must be an https origin like https://api.example.com`);
  }
  for (const name of def.credentials) {
    if (!CREDENTIAL_PATTERN.test(name)) problem(`credential ${name} must match ^[a-z][a-z0-9_]*$`);
  }
  for (const [index, name] of originFields.entries()) {
    if (!def.credentials.includes(name)) problem(`origin field ${name} must be one of the credentials`);
    if (originFields.indexOf(name) !== index) problem(`origin field ${name} is listed twice`);
  }
  const names = new Set<string>();
  for (const tool of def.tools) {
    if (!TOOL_PATTERN.test(tool.name)) problem(`tool ${tool.name} must match ^[a-z][a-z0-9_]{0,63}$`);
    if (names.has(tool.name)) problem(`tool ${tool.name} is defined twice`);
    names.add(tool.name);
    if (!tool.title?.trim() || !tool.description?.trim()) problem(`tool ${tool.name} needs a title and a description`);
    if (tool.description.length > 1024) problem(`tool ${tool.name} has a description over 1024 characters`);
    if (!Object.hasOwn(ANNOTATIONS, tool.kind)) problem(`tool ${tool.name} has an unknown kind`);
    if (tool.inputSchema.type !== 'object' || tool.inputSchema.additionalProperties !== false) {
      problem(`tool ${tool.name} needs an object input schema with additionalProperties: false`);
    }
  }
  for (const tool of def.tools) {
    if (tool.kind === 'read') continue;
    const check = def.tools.find((candidate) => candidate.name === tool.check);
    if (!check || check.kind !== 'read') problem(`write tool ${tool.name} needs check: the name of a read tool`);
  }
}

function result(payload: Record<string, unknown>, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function failure(message: string, details: FailureDetails = {}): CallToolResult {
  return result({ error: message, ...details }, true);
}

function trimmed(values: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof values !== 'object' || values === null) return out;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

/** Turns a connector definition into the module the hosts load. */
export function defineConnector(def: ConnectorDefinition): ConnectorModule {
  assertDefinition(def);
  const { label } = def;
  const tools = new Map(def.tools.map((tool) => [tool.name, tool]));
  const toolList = def.tools.map((tool) => tool.name).join(', ');
  const credentialLabel = (name: string): string => def.credentialLabels?.[name] ?? `${label} ${name.replace(/_/g, ' ')}`;

  const descriptors: ToolDescriptor[] = def.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as JsonSchema,
    annotations: { ...ANNOTATIONS[tool.kind] },
  }));

  async function call(toolName: string, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const tool = typeof toolName === 'string' ? tools.get(toolName) : undefined;
    if (!tool) return failure(`Unknown tool ${JSON.stringify(String(toolName))}. ${label} tools: ${toolList}.`);
    if (!ctx || typeof ctx.fetch !== 'function') return failure(`${tool.name} cannot run: the host gave it no fetch function.`);

    const log = (text: string): void => {
      try {
        ctx.log?.(text);
      } catch {
        // a broken logger never fails a call
      }
    };
    const given = trimmed(ctx.credentials);
    const credentials = def.normalizeCredentials ? def.normalizeCredentials({ ...given }) : given;
    const missing = def.credentials.filter((name) => !credentials[name]);
    if (missing.length) {
      return failure(`${label} is not connected: the ${missing.map(credentialLabel).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`);
    }
    // Credential origins are this call's only: they come from the values the host passed.
    const fieldOrigins = new Map<string, string>();
    for (const name of def.originFields ?? []) {
      const site = parseSiteUrl(given[name] ?? '');
      if (!site.ok) return failure(`${label} is not connected correctly: the ${credentialLabel(name)} ${site.problem}. Nothing was sent to ${label}.`);
      fieldOrigins.set(name, site.origin);
    }
    const origins = [...new Set([...def.origins, ...fieldOrigins.values()])];

    const parsed = validateArguments(tool.inputSchema, args);
    if (!parsed.ok) return failure(`Invalid arguments for ${tool.name}: ${parsed.issues.join('; ')}. Nothing was sent to ${label}.`);

    const frozenCredentials = Object.freeze({ ...credentials });
    let writeSent = false;
    const http = createHttp({
      vendor: def.vendor,
      label,
      tool: tool.name,
      readOnly: tool.kind === 'read',
      origins,
      credentialLabel: def.credentials.map(credentialLabel).join(' and '),
      ctx,
      authHeaders: () => def.authHeaders?.(frozenCredentials) ?? {},
      log,
      onWriteSent: () => {
        writeSent = true;
      },
    });
    const helpers: ToolHelpers = {
      tool: tool.name,
      credentials: frozenCredentials,
      ctx,
      origins: Object.freeze([...origins]),
      originOf: (credential) => {
        const origin = fieldOrigins.get(credential);
        if (!origin) throw new Error(`${credential} is not an origin field`);
        return origin;
      },
      api: http.api,
      media: http.media,
      page: (input) => fitPage(input),
      cursor: (cursor) => decodeCursor(tool.name, cursor),
      makeCursor: (state) => encodeCursor(tool.name, state),
      log,
    };

    try {
      const data = await tool.run(parsed.value, helpers);
      const fitted = shrinkToFit(data ?? {});
      if (!fitted) return failure(`The ${label} result was too large to return. Ask for fewer items.`);
      const payload = fitted.value as Record<string, unknown>;
      return result(fitted.truncated && typeof payload === 'object' ? { ...payload, truncated: true } : payload, false);
    } catch (error) {
      if (error instanceof OutcomeUnknown) {
        return result({
          outcome: 'unknown',
          check: tool.check,
          error: `${error.message} Call ${tool.check} to see whether it was, before trying again.`,
        }, true);
      }
      if (error instanceof ToolFailure) return failure(error.message, error.details);
      // A bug in the module. Its message may quote arguments or replies, so it is not passed on.
      log(`${def.vendor} ${tool.name} unexpected ${(error as { name?: string } | null)?.name ?? 'error'}`);
      if (writeSent) {
        return result({
          outcome: 'unknown',
          check: tool.check,
          error: `${tool.name} stopped unexpectedly after the change was sent to ${label}. Call ${tool.check} to see whether it was made, before trying again.`,
        }, true);
      }
      return failure(`${tool.name} failed unexpectedly.${tool.kind === 'read' ? '' : ' Nothing was changed.'}`);
    }
  }

  return deepFreeze({
    vendor: def.vendor,
    origins: [...def.origins],
    originFields: [...(def.originFields ?? [])],
    credentials: [...def.credentials],
    tools: descriptors,
    call,
  });
}
