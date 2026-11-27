import type { ToolContext } from '../types.js';
import { andList } from './credentials.js';
import { OutcomeUnknown, ToolFailure } from './errors.js';
import { cleanVendorText, formatNumber, utf8Decode } from './text.js';

/** The largest vendor API reply a module reads. */
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

const USER_AGENT = 'agent-connectors';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One query parameter value; a list repeats the parameter (?id=1&id=2). */
export type QueryValue = string | number | boolean;

export interface ApiRequest {
  method?: HttpMethod;
  /** A path on the origin, starting with "/". */
  path: string;
  /**
   * One of the call's origins (h.origins): the module's origins, or the
   * origin of an originFields credential (h.originOf). By default the first
   * module origin, or the first credential origin when the module has none.
   */
  origin?: string;
  query?: Record<string, QueryValue | ReadonlyArray<QueryValue> | undefined | null>;
  headers?: Record<string, string>;
  /** Sent as application/json. */
  json?: unknown;
  /** Sent as is, with `contentType`. */
  body?: Uint8Array;
  contentType?: string;
  /** Set on the one request that makes the tool's change: its unclear outcome is reported as unknown. */
  write?: boolean;
  /**
   * Set on a non-GET request that changes nothing: a sign-in, or a search the
   * vendor takes by POST. Read tools may send no other non-GET request.
   */
  safe?: boolean;
  /** Adds the module's auth headers (default true). */
  auth?: boolean;
  maxBytes?: number;
  /**
   * For a file download: a successful reply comes back as its bytes, a
   * Uint8Array in `data`, not parsed. An error reply is still read for its
   * message.
   */
  binary?: boolean;
  /** A sentence per HTTP status that replaces the generic one. */
  errors?: Partial<Record<number, string>>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** The reply as JSON or text; for a binary request, its bytes. */
  data: any;
}

export interface MediaOptions {
  /** What the URL points at, for messages: "image". */
  what: string;
  maxBytes: number;
  accept?: string;
}

export interface MediaResult {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface HttpEnvironment {
  vendor: string;
  label: string;
  tool: string;
  readOnly: boolean;
  /** The origins this call may reach; the first is the default. */
  origins: readonly string[];
  /** The words for the credentials this call goes ahead with, e.g. ["dev.to API key"]: a 401 names them. */
  credentialLabels: readonly string[];
  ctx: ToolContext;
  authHeaders(): Record<string, string>;
  log(text: string): void;
  onWriteSent(): void;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function describe(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const code = errorCode(error);
  if (code === 'TIMEOUT' || name === 'TimeoutError') return 'the request timed out';
  if (code === 'ABORTED' || name === 'AbortError') return 'the request was cancelled';
  if (code === 'TOO_LARGE') return 'the reply was too large';
  return cleanVendorText((error as { message?: unknown } | null)?.message, 200) ?? 'a network error';
}

/** Seconds from Retry-After (seconds or an HTTP date) or RateLimit-Reset. */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  const reset = headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset');
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value) && value >= 0) {
      // A large value is a Unix time, a small one a number of seconds.
      return value > 1e9 ? Math.max(0, Math.ceil(value - now / 1000)) : Math.ceil(value);
    }
  }
  return undefined;
}

/** A short error code from a JSON reply (`error` or `code`), e.g. "ExpiredToken". */
export function vendorCode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  for (const key of ['error', 'code']) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(value)) return value;
  }
  return undefined;
}

/** The vendor's own error message from a JSON or text reply. */
export function vendorMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return cleanVendorText(data);
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['message', 'error_description', 'error', 'detail', 'title']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return cleanVendorText(value);
    const nested = (value as { message?: unknown } | null)?.message;
    if (typeof nested === 'string' && nested.trim()) return cleanVendorText(nested);
  }
  if (Array.isArray(record['errors'])) {
    const messages = record['errors']
      .map((item) => {
        if (typeof item === 'string') return item;
        // A JSON:API error object (App Store Connect's, for one) has no message: its words are in detail, else title.
        const entry = item as { message?: unknown; detail?: unknown; title?: unknown } | null;
        return [entry?.message, entry?.detail, entry?.title].find((value) => typeof value === 'string' && value.trim() !== '');
      })
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (messages.length) return cleanVendorText(messages.join('; '));
  }
  return undefined;
}

class TooLarge extends Error {
  constructor(readonly limit: number) {
    super(`the reply is larger than ${formatNumber(limit)} bytes`);
  }
}

/** Reads a body up to `maxBytes`, stopping (and cancelling the stream) as soon as it goes over. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new TooLarge(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseBody(bytes: Uint8Array, contentType: string | null): unknown {
  if (bytes.length === 0) return null;
  const text = utf8Decode(bytes);
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // not JSON after all
    }
  }
  return text;
}

/** The per-call HTTP helpers a tool's run() gets as h.api and h.media. */
export function createHttp(env: HttpEnvironment) {
  const { label, ctx } = env;
  const nothingChanged = env.readOnly ? '' : ' Nothing was changed.';
  const checkCredentials = env.credentialLabels.length
    ? `Check that the ${andList(env.credentialLabels)} ${env.credentialLabels.length > 1 ? 'are' : 'is'} correct and still active.`
    : `Check that the ${label} credentials are correct and still active.`;

  function failureFor(status: number, headers: Headers, data: unknown, request: ApiRequest): Error {
    const message = vendorMessage(data);
    // The vendor's words go before a sentence's own full stop, so drop theirs.
    const said = message ? `: ${message.replace(/[.!?。]+$/u, '')}` : '';
    const retryAfter = retryAfterSeconds(headers);
    const code = vendorCode(data);
    const extra = { ...(code ? { vendorCode: code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) };
    const custom = request.errors?.[status];
    // A module's own sentence for a status keeps the status, the vendor's words and the outcome.
    const withCustom = (fallback: string): string => (custom
      ? `${custom.replace(/\.$/, '')} (HTTP ${status}).${message ? ` ${label} said: "${message}".` : ''}${nothingChanged}`
      : fallback);

    if (status >= 500) {
      if (request.write) {
        return new OutcomeUnknown(`${label} answered HTTP ${status}${said}, so it is not known whether the change was made.`);
      }
      return new ToolFailure(withCustom(`${label} had a server error (HTTP ${status})${said}. Try again later.${nothingChanged}`), { status, ...extra });
    }
    if (status === 429) {
      return new ToolFailure(
        `${label} rate limit reached (HTTP 429).${nothingChanged} `
          + (retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : 'Wait a while before retrying.'),
        { status, ...extra },
      );
    }
    if (status === 401) {
      return new ToolFailure(
        withCustom(`${label} rejected the credentials (HTTP 401)${said}. ${checkCredentials}${nothingChanged}`),
        { status, ...extra },
      );
    }
    if (status === 403) return new ToolFailure(withCustom(`${label} refused the request (HTTP 403)${said}.${nothingChanged}`), { status, ...extra });
    if (status === 404) return new ToolFailure(withCustom(`${label} found nothing there (HTTP 404)${said}.${nothingChanged}`), { status, ...extra });
    if (status >= 400) return new ToolFailure(withCustom(`${label} rejected the request (HTTP ${status})${said}.${nothingChanged}`), { status, ...extra });
    return new ToolFailure(`${label} answered with an unexpected HTTP ${status}.${nothingChanged}`, { status });
  }

  async function api(request: ApiRequest): Promise<ApiResponse> {
    const method = request.method ?? 'GET';
    if (env.readOnly && !SAFE_METHODS.has(method) && !request.safe) {
      // A programming error: a read-only tool must never change anything.
      throw new Error(`read-only tool sent ${method}`);
    }
    const origin = request.origin ?? env.origins[0];
    if (!origin || !env.origins.includes(origin)) throw new Error('undeclared origin');
    const url = new URL(request.path, origin);
    if (url.origin !== origin || !request.path.startsWith('/')) throw new Error('path outside the origin');
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        url.searchParams.delete(key);
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(request.auth === false ? {} : env.authHeaders()),
      ...request.headers,
    };
    let body: string | Uint8Array | undefined;
    if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers['content-type'] = 'application/json';
    } else if (request.body) {
      body = request.body;
      headers['content-type'] = request.contentType ?? 'application/octet-stream';
    }

    const started = Date.now();
    if (request.write) env.onWriteSent();
    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (error) {
      env.log(`${env.vendor} ${env.tool} ${method} failed ${Date.now() - started}ms`);
      if (errorCode(error) === 'URL_REFUSED') {
        throw new ToolFailure(`The request to ${label} was blocked before it was sent (${describe(error)}).${nothingChanged}`);
      }
      if (request.write) {
        throw new OutcomeUnknown(`${label} did not answer (${describe(error)}), so it is not known whether the change was made.`);
      }
      // A size limit of the host, not an outage: trying again gets the same reply.
      if (errorCode(error) === 'TOO_LARGE') throw new ToolFailure(`The reply from ${label} is larger than this host can read.${nothingChanged}`);
      throw new ToolFailure(`${label} could not be reached (${describe(error)}). Try again later.${nothingChanged}`);
    }
    env.log(`${env.vendor} ${env.tool} ${method} ${response.status} ${Date.now() - started}ms`);

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, request.maxBytes ?? MAX_API_RESPONSE_BYTES);
    } catch (error) {
      if (request.write && (response.ok || response.status >= 500)) {
        throw new OutcomeUnknown(`${label} answered HTTP ${response.status}, but the reply could not be read (${describe(error)}), so it is not known whether the change was made.`);
      }
      throw new ToolFailure(`${label} answered HTTP ${response.status}, but the reply could not be read (${describe(error)}).${response.ok ? '' : nothingChanged}`);
    }
    const data = request.binary && response.ok ? bytes : parseBody(bytes, response.headers.get('content-type'));
    if (response.ok) return { status: response.status, headers: response.headers, data };
    throw failureFor(response.status, response.headers, data, request);
  }

  async function media(rawUrl: string, options: MediaOptions): Promise<MediaResult> {
    const { what } = options;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ToolFailure(`The ${what} URL is not a valid URL.${nothingChanged}`);
    }
    if (url.protocol !== 'https:') throw new ToolFailure(`The ${what} URL must start with https://.${nothingChanged}`);

    const started = Date.now();
    let response: Response;
    try {
      response = await ctx.fetch(url.toString(), {
        method: 'GET',
        headers: { accept: options.accept ?? '*/*', 'user-agent': USER_AGENT },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      env.log(`${env.vendor} ${env.tool} media GET failed ${Date.now() - started}ms`);
      if (errorCode(error) === 'URL_REFUSED') {
        throw new ToolFailure(`The ${what} URL was refused (${describe(error)}). Use a public https URL.${nothingChanged}`);
      }
      throw new ToolFailure(`The ${what} could not be downloaded (${describe(error)}).${nothingChanged}`);
    }
    env.log(`${env.vendor} ${env.tool} media GET ${response.status} ${Date.now() - started}ms`);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ToolFailure(`The ${what} URL answered HTTP ${response.status}.${nothingChanged}`);
    }
    try {
      const bytes = await readCapped(response, options.maxBytes);
      return { bytes, contentType: response.headers.get('content-type') };
    } catch (error) {
      if (error instanceof TooLarge) {
        throw new ToolFailure(`The ${what} is larger than ${formatNumber(options.maxBytes)} bytes, the most ${label} accepts.${nothingChanged}`);
      }
      throw new ToolFailure(`The ${what} could not be downloaded (${describe(error)}).${nothingChanged}`);
    }
  }

  return { api, media };
}
