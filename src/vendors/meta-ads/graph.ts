// Graph API helpers for this module: the API version, paging, the way the
// sign-in token's app secret proof goes out, waits that stop with the call, and
// the checks the generic tools apply.

import {
  allowedAccounts,
  requireAccounts,
  ToolFailure,
  type ApiToolRequest,
  type ToolHelpers,
} from '../../core/index.js';

export const VERSION = 'v26.0';
export const GRAPH = 'https://graph.facebook.com';

/** Leaves out undefined and null values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/**
 * The token every call signs in with: the system user token, or the sign-in's
 * access token. A connection has one way in: when a host passes both, the
 * system user token is used, since a token next to it is one left over from before.
 */
export function tokenOf(credentials: Readonly<Record<string, string>>): string {
  return credentials['systemusertoken'] || credentials['access_token'] || '';
}

const PROOF = /^[0-9a-f]{64}$/i;

/** The app secret proof, which goes only with the sign-in token it was made for (never with a system user token). */
export function proofQuery(credentials: Readonly<Record<string, string>>): Record<string, string> {
  const proof = credentials['appsecret_proof'];
  return credentials['access_token'] && !credentials['systemusertoken'] && proof && PROOF.test(proof) ? { appsecret_proof: proof } : {};
}

/**
 * The account a call acts on: the one given (checked against the accounts
 * chosen for the connection), or the only one chosen when none is given.
 */
export function pickAccount(h: ToolHelpers, key: string, given: string | undefined, words: { argument: string; label: string }): string {
  if (given) {
    requireAccounts(h.ctx.accounts, key, given, words.label);
    return given;
  }
  const allowed = allowedAccounts(h.ctx.accounts, key);
  if (allowed && allowed.length === 1) return allowed[0] as string;
  if (allowed && allowed.length > 1) throw new ToolFailure(`${words.argument} is required: one of ${allowed.join(', ')}. Nothing was sent.`);
  if (allowed) throw new ToolFailure(`No ${words.label} is chosen for this connection yet. Nothing was sent.`);
  throw new ToolFailure(`${words.argument} is required. Nothing was sent.`);
}

/** Where a list continues: the Graph after cursor, an offset into that page, and the page size. */
export interface ListState {
  after?: string;
  skip: number;
  limit: number;
}

export function listState(h: ToolHelpers, cursor: string | undefined, limit: number): ListState {
  const state = h.cursor(cursor);
  return {
    ...(typeof state?.['a'] === 'string' ? { after: state['a'] } : {}),
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
    limit: typeof state?.['n'] === 'number' ? state['n'] : limit,
  };
}

export function rowsOf(data: any): any[] {
  return Array.isArray(data?.data) ? data.data : [];
}

/** A list result under 32 KB, continuing where it was cut or at the next Graph page. */
export function listResult<T>(h: ToolHelpers, key: string, items: T[], state: ListState, data: any, extra?: Record<string, unknown>): Record<string, unknown> {
  const after = data?.paging?.cursors?.after;
  const next = data?.paging?.next && typeof after === 'string' && after ? after : undefined;
  return h.page({
    key,
    items: items.slice(state.skip),
    ...(extra ? { extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...(state.after ? { a: state.after } : {}), o: state.skip + index, n: state.limit }),
    ...(next ? { nextPage: h.makeCursor({ a: next, o: 0, n: state.limit }) } : {}),
  });
}

/** Waits, unless the call is cancelled first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolFailure('The call was cancelled while waiting.'));
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(new ToolFailure('The call was cancelled while waiting.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Text that could hand out a token or an app secret is kept out of the generic
 * tools: a second check, on the request as the core resolved it, after the
 * full check of every argument (graph-rules.ts).
 */
export function refuseSecrets(request: ApiToolRequest): void {
  const texts = [...request.segments, ...Object.keys(request.query), ...Object.values(request.query).flat()];
  if (request.segments.includes('oauth') || texts.some((text) => /access_token|appsecret|app_secret|client_secret|debug_token/i.test(text))) {
    throw new ToolFailure('Tokens and app secrets are not available through the generic Meta Ads tools, and the connection\'s own token is added for you. Nothing was sent.');
  }
}

/** Standard base64, as the ad image upload takes it. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** JPEG, PNG or GIF, told by the first bytes (a server's Content-Type is not trusted). */
export function imageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith('GIF8')) return 'image/gif';
  return undefined;
}

export const HTTPS_URL = { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000 };
export const ISO_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})$';
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
