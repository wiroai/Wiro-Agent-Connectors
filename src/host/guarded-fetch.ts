import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { ConnectorFetch, ConnectorRequestInit } from '../types.js';
import { isPublicAddress } from './ip.js';

// The host side of ctx.fetch, used by the stdio CLI. Modules get the same
// contract from any host:
// - A URL on one of the module's origins is an API request: any method, the
//   module's headers and body, redirects not followed, a timeout and a size cap
//   on the reply.
// - Any other URL is a media download: GET or HEAD without a body, https only,
//   no headers but Accept and User-Agent (so credentials never leave for it),
//   only to public addresses after DNS resolution, every redirect checked the
//   same way, a timeout and a size cap.
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

export interface MediaReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

/** One HTTPS request to an already checked address. */
export type MediaTransport = (request: {
  url: URL;
  address: ResolvedAddress;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<MediaReply>;

export interface GuardedFetchOptions {
  /** The module's origins. */
  origins: readonly string[];
  /** Per request, API and media alike (default 30 s). */
  timeoutMs?: number;
  /** The largest API reply (default 8 MiB). */
  maxResponseBytes?: number;
  /** The largest media download (default 25 MiB). */
  maxMediaBytes?: number;
  maxRedirects?: number;
  /** Replacements for tests: the API fetch, the DNS lookup and the media transport. */
  apiFetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  mediaTransport?: MediaTransport;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MEDIA_HEADERS = new Set(['accept', 'user-agent']);

function refuse(message: string): never {
  throw new ConnectorFetchError('URL_REFUSED', message);
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/** HTTPS to the checked address only: the socket's lookup returns it, so DNS cannot change it in between. */
const httpsTransport: MediaTransport = ({ url, address, method, headers, signal }) => new Promise((resolve, reject) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const request = https.request({
    protocol: 'https:',
    hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
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
  request.end();
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

export function createGuardedFetch(options: GuardedFetchOptions): ConnectorFetch {
  const origins = new Set(options.origins);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolve = options.resolve ?? systemResolve;
  const transport = options.mediaTransport ?? httpsTransport;

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

  async function media(start: URL, init: ConnectorRequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') refuse(`only GET and HEAD may go to ${start.origin}, which is not an API origin of this connector`);
    if (init.body !== undefined) refuse('a media download cannot carry a body');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (MEDIA_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }

    const timer = timeoutSignal(timeoutMs, init.signal);
    let url = start;
    try {
      for (let hop = 0; ; hop++) {
        if (url.protocol !== 'https:') refuse(`only https URLs can be downloaded, not ${url.protocol}`);
        if (url.username || url.password) refuse('URLs with a user name or password are not allowed');
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

        const reply = await transport({ url, address: addresses[0] as ResolvedAddress, method: method as 'GET' | 'HEAD', headers, signal: timer.signal });
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

        const declared = Number(reply.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxMediaBytes) {
          reply.destroy();
          throw new ConnectorFetchError('TOO_LARGE', `the file is larger than ${maxMediaBytes} bytes`);
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (method === 'GET') {
          for await (const chunk of reply.body) {
            total += chunk.byteLength;
            if (total > maxMediaBytes) {
              reply.destroy();
              throw new ConnectorFetchError('TOO_LARGE', `the file is larger than ${maxMediaBytes} bytes`);
            }
            chunks.push(chunk);
          }
        } else {
          reply.destroy();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const status = reply.status;
        return new Response(NULL_BODY_STATUSES.has(status) || method === 'HEAD' ? null : bytes, { status, headers: toHeaders(reply.headers) });
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
    return media(url, init);
  };
}
