import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { parseSiteUrl } from '../core/origins.js';
import { isUploadHost, uploadHostProblem } from '../core/upload-hosts.js';
import type { ConnectorFetch, ConnectorModule, ConnectorRequestInit } from '../types.js';
import { isPublicAddress } from './ip.js';

// The host side of ctx.fetch, used by the stdio CLI. Modules get the same
// contract from any host:
// - A URL on one of the module's origins is an API request: any method, the
//   module's headers and body, redirects not followed, a timeout and a size cap
//   on the reply.
// - A URL on a credential origin (the https origin of a site or instance URL
//   the user gave in one of the module's originFields credentials) is an API
//   request to an address the user chose, so it is checked like a media URL
//   first: https only, no user name or password in the URL, every address the
//   name resolves to must be public, the connection goes to the address that
//   was checked, and redirects are not followed.
// - A PUT or POST with a body to a host in the module's uploadHosts (an upload
//   address its vendor's API returned, such as a pre-signed part address) is
//   an upload: https on the default port, no user name or password, no
//   Authorization, Proxy-Authorization or Cookie header, a body within the
//   upload cap, every address public, the connection to the checked address,
//   redirects not followed, and the reply capped like an API reply.
// - Any other URL is a media download: GET or HEAD without a body, https only,
//   no headers but Accept, User-Agent and one byte range (Range: bytes=F-L, for
//   a module that reads a large file in parts), so credentials never leave for
//   it; only to public addresses after DNS resolution, every redirect checked
//   the same way, a timeout and a size cap per request. A 206 reply comes back
//   as it is, with its Content-Range.
// - Everything else is refused before it is sent, with code "URL_REFUSED".

export type ConnectorFetchErrorCode = 'URL_REFUSED' | 'TOO_LARGE' | 'TIMEOUT' | 'ABORTED' | 'NETWORK';

export class ConnectorFetchError extends Error {
  constructor(readonly code: ConnectorFetchErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorFetchError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface PinnedReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

/** One HTTPS request to an address that was already checked: a media download, an upload, or an API request to a credential origin. */
export type PinnedTransport = (request: {
  url: URL;
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal: AbortSignal;
}) => Promise<PinnedReply>;

/** The names of 0.1.0. */
export type MediaReply = PinnedReply;
export type MediaTransport = PinnedTransport;

export interface GuardedFetchOptions {
  /** The module's origins. */
  origins: readonly string[];
  /**
   * The https origins of this connection's originFields credentials (see
   * originsFromCredentials). API requests may go there, after the SSRF checks.
   */
  credentialOrigins?: readonly string[];
  /**
   * The module's uploadHosts: a PUT or POST with a body may go to an address
   * on one of them, after the checks of an upload (see isUploadHost).
   */
  uploadHosts?: readonly string[];
  /** Per request, API and media alike (default 30 s). */
  timeoutMs?: number;
  /** The largest API reply (default 25 MiB, as large as a file a call hands back may be). */
  maxResponseBytes?: number;
  /** The largest media download (default 25 MiB). */
  maxMediaBytes?: number;
  /** The largest body of an upload to an upload host (default 25 MiB). */
  maxUploadBytes?: number;
  maxRedirects?: number;
  /** Replacements for tests: the API fetch, the DNS lookup and the HTTPS transport to checked addresses. */
  apiFetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: PinnedTransport;
  /** The name of `transport` in 0.1.0. */
  mediaTransport?: PinnedTransport;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// A file a tool hands back may come from an API origin (a stored file's
// download), so an API reply may be as large as the CLI's file limit.
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MEDIA_HEADERS = new Set(['accept', 'user-agent', 'range']);
/** The Range a media download may carry: one byte range from a given first byte. */
const BYTE_RANGE = /^bytes=\d{1,15}-\d{0,15}$/;
/** Headers an upload never carries: its address holds its own signature, and credentials never go there. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function refuse(message: string): never {
  throw new ConnectorFetchError('URL_REFUSED', message);
}

/**
 * The https origins of a connection's originFields credentials, resolved with
 * the rule the modules use (parseSiteUrl). A value that is not a usable site
 * address is left out: the module refuses those calls itself, before sending.
 * Pass the result to createGuardedFetch as credentialOrigins.
 */
export function originsFromCredentials(
  module: Pick<ConnectorModule, 'originFields'> | { originFields?: readonly string[] },
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  const origins: string[] = [];
  for (const name of module.originFields ?? []) {
    const value = credentials[name];
    const site = typeof value === 'string' ? parseSiteUrl(value) : undefined;
    if (site?.ok && !origins.includes(site.origin)) origins.push(site.origin);
  }
  return origins;
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/** HTTPS to the checked address only: the socket's lookup returns it, so DNS cannot change it in between. */
const httpsTransport: PinnedTransport = ({ url, address, method, headers, body, signal }) => new Promise((resolve, reject) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const outgoing = { ...headers };
  if (body !== undefined) outgoing['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
  const request = https.request({
    protocol: 'https:',
    hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method,
    headers: outgoing,
    signal,
    agent: false,
    ...(net.isIP(hostname) ? {} : { servername: hostname }),
    lookup: (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    },
  }, (response) => {
    resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
      destroy: () => response.destroy(),
    });
  });
  request.on('error', reject);
  request.end(body);
});

function timeoutSignal(timeoutMs: number, outer: AbortSignal | undefined): { signal: AbortSignal; timedOut: () => boolean } {
  const timer = AbortSignal.timeout(timeoutMs);
  return {
    signal: outer ? AbortSignal.any([outer, timer]) : timer,
    timedOut: () => timer.aborted,
  };
}

function failure(error: unknown, timedOut: boolean, outer: AbortSignal | undefined): ConnectorFetchError {
  if (error instanceof ConnectorFetchError) return error;
  if (timedOut) return new ConnectorFetchError('TIMEOUT', 'the request timed out');
  if (outer?.aborted) return new ConnectorFetchError('ABORTED', 'the request was cancelled');
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code;
  return new ConnectorFetchError('NETWORK', typeof cause === 'string' ? `network error (${cause})` : 'network error');
}

/** A stream that errors once more than `maxBytes` pass through it. */
function capStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) controller.error(new ConnectorFetchError('TOO_LARGE', `the reply is larger than ${maxBytes} bytes`));
      else controller.enqueue(chunk);
    },
  }));
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      try {
        headers.append(name, item);
      } catch {
        // a header a Response cannot carry is left out
      }
    }
  }
  return headers;
}

/** Reads a reply up to `maxBytes`: `what` names it in the error, "file" or "reply". */
async function readReply(reply: PinnedReply, maxBytes: number, what: string): Promise<Uint8Array> {
  const tooLarge = () => new ConnectorFetchError('TOO_LARGE', `the ${what} is larger than ${maxBytes} bytes`);
  const declared = Number(reply.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    reply.destroy();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of reply.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      reply.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createGuardedFetch(options: GuardedFetchOptions): ConnectorFetch {
  const origins = new Set(options.origins);
  const credentialOrigins = new Set<string>();
  for (const origin of options.credentialOrigins ?? []) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    if (!url || url.protocol !== 'https:' || url.origin !== origin) throw new Error(`credential origin ${origin} must be an https origin like https://example.com`);
    if (!origins.has(origin)) credentialOrigins.add(origin);
  }
  const uploadHosts = [...(options.uploadHosts ?? [])];
  for (const entry of uploadHosts) {
    const problem = uploadHostProblem(entry);
    if (problem) throw new Error(`upload host ${JSON.stringify(entry)} ${problem}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolve = options.resolve ?? systemResolve;
  const transport = options.transport ?? options.mediaTransport ?? httpsTransport;

  /** The address to connect to: every address of the host must be public. */
  async function publicAddress(url: URL): Promise<ResolvedAddress> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    if (net.isIP(hostname)) {
      addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
      try {
        addresses = await resolve(hostname);
      } catch {
        throw new ConnectorFetchError('NETWORK', `${hostname} could not be resolved`);
      }
    }
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
      refuse(`${hostname} is not a public internet address`);
    }
    return addresses[0] as ResolvedAddress;
  }

  async function api(url: URL, init: ConnectorRequestInit): Promise<Response> {
    const apiFetch = options.apiFetch ?? globalThis.fetch;
    const timer = timeoutSignal(timeoutMs, init.signal);
    let response: Response;
    try {
      response = await apiFetch(url, {
        method: init.method ?? 'GET',
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: timer.signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw failure(error, timer.timedOut(), init.signal);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorFetchError('TOO_LARGE', `the reply is larger than ${maxResponseBytes} bytes`);
    }
    const body = response.body && !NULL_BODY_STATUSES.has(response.status) ? capStream(response.body, maxResponseBytes) : null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /**
   * One request to a checked address that is never redirected: an API request
   * to a credential origin, or an upload. The reply is capped like an API
   * reply, and a redirect comes back as it is.
   */
  async function pinned(url: URL, method: string, init: ConnectorRequestInit): Promise<Response> {
    const timer = timeoutSignal(timeoutMs, init.signal);
    try {
      const address = await publicAddress(url);
      const reply = await transport({
        url,
        address,
        method,
        headers: { ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: timer.signal,
      });
      if (reply.status < 200 || reply.status > 599) {
        reply.destroy();
        throw new ConnectorFetchError('NETWORK', `an invalid HTTP status (${reply.status})`);
      }
      const empty = NULL_BODY_STATUSES.has(reply.status) || method === 'HEAD';
      if (empty) reply.destroy();
      const bytes = empty ? null : await readReply(reply, maxResponseBytes, 'reply');
      return new Response(bytes, { status: reply.status, headers: toHeaders(reply.headers) });
    } catch (error) {
      throw failure(error, timer.timedOut(), init.signal);
    }
  }

  /** An API request to a credential origin: checked like a media URL, sent to the checked address, never redirected. */
  async function credentialApi(url: URL, init: ConnectorRequestInit): Promise<Response> {
    if (url.username || url.password) refuse('URLs with a user name or password are not allowed');
    return pinned(url, (init.method ?? 'GET').toUpperCase(), init);
  }

  /** An upload to one of the module's upload hosts: no credentials, checked like a media URL, sent to the checked address, never redirected. */
  async function upload(url: URL, method: string, init: ConnectorRequestInit): Promise<Response> {
    if (url.protocol !== 'https:') refuse(`only https uploads are allowed, not ${url.protocol}`);
    if (url.port) refuse('an upload goes to the default https port only');
    if (url.username || url.password) refuse('URLs with a user name or password are not allowed');
    for (const name of Object.keys(init.headers ?? {})) {
      if (CREDENTIAL_HEADERS.has(name.toLowerCase())) refuse(`an upload to ${url.hostname} cannot carry the ${name.toLowerCase()} header`);
    }
    const body = init.body as string | Uint8Array;
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    if (size > maxUploadBytes) refuse(`the upload is larger than ${maxUploadBytes} bytes`);
    return pinned(url, method, init);
  }

  async function media(start: URL, init: ConnectorRequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') refuse(`only GET and HEAD may go to ${start.origin}, which is not an API origin of this connector`);
    if (init.body !== undefined) refuse('a media download cannot carry a body');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      const key = name.toLowerCase();
      if (!MEDIA_HEADERS.has(key)) continue;
      if (key === 'range' && !BYTE_RANGE.test(value)) refuse('a media download may ask for one byte range only, as bytes=FIRST-LAST');
      headers[key] = value;
    }

    const timer = timeoutSignal(timeoutMs, init.signal);
    let url = start;
    try {
      for (let hop = 0; ; hop++) {
        if (url.protocol !== 'https:') refuse(`only https URLs can be downloaded, not ${url.protocol}`);
        if (url.username || url.password) refuse('URLs with a user name or password are not allowed');
        const address = await publicAddress(url);

        const reply = await transport({ url, address, method, headers, signal: timer.signal });
        if (REDIRECTS.has(reply.status)) {
          reply.destroy();
          const location = reply.headers['location'];
          if (typeof location !== 'string' || !location) throw new ConnectorFetchError('NETWORK', `a redirect (HTTP ${reply.status}) without a location`);
          if (hop >= maxRedirects) refuse(`more than ${maxRedirects} redirects`);
          url = new URL(location, url);
          continue;
        }
        if (reply.status < 200 || reply.status > 599) {
          reply.destroy();
          throw new ConnectorFetchError('NETWORK', `an invalid HTTP status (${reply.status})`);
        }

        const empty = NULL_BODY_STATUSES.has(reply.status) || method === 'HEAD';
        if (empty) reply.destroy();
        const bytes = empty ? null : await readReply(reply, maxMediaBytes, 'file');
        return new Response(bytes, { status: reply.status, headers: toHeaders(reply.headers) });
      }
    } catch (error) {
      throw failure(error, timer.timedOut(), init.signal);
    }
  }

  return async function guardedFetch(input: string, init: ConnectorRequestInit = {}): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      refuse('not a valid URL');
    }
    if (origins.has(url.origin)) return api(url, init);
    if (credentialOrigins.has(url.origin)) return credentialApi(url, init);
    const method = (init.method ?? 'GET').toUpperCase();
    if ((method === 'PUT' || method === 'POST') && init.body !== undefined && isUploadHost(url.hostname, uploadHosts)) return upload(url, method, init);
    return media(url, init);
  };
}
