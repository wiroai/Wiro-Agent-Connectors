// Graph API helpers for this module: the API version and hosts, form bodies,
// paging, a short in-memory cache of Page tokens, waits that stop with the
// call, date ranges, and the checks the generic tools apply.

import {
  allowedAccounts,
  requireAccounts,
  sha256Hex,
  ToolFailure,
  utf8Bytes,
  type ApiToolRequest,
  type ToolHelpers,
} from '../../core/index.js';

export const VERSION = 'v26.0';
/** Instagram accounts reached through a Facebook Page (system user tokens). */
export const GRAPH = 'https://graph.facebook.com';
/** Instagram accounts that signed in with Instagram Login. */
export const GRAPH_INSTAGRAM = 'https://graph.instagram.com';

/** Leaves out undefined and null values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/**
 * A form body (application/x-www-form-urlencoded), the way the Graph API takes
 * POST parameters. Objects and lists go as JSON text, as Meta documents them.
 */
export function form(params: Record<string, unknown>): { body: Uint8Array; contentType: string } {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return { body: utf8Bytes(search.toString()), contentType: 'application/x-www-form-urlencoded' };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Page tokens, kept for a short time so a post does not need a lookup every
// time. Keyed by a SHA-256 hash of the credential and the Page, never the
// credential itself.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS = 256;
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function tokenKey(...parts: string[]): Promise<string> {
  return sha256Hex(parts.join('\n'));
}

export function cachedToken(key: string): string | undefined {
  const hit = tokens.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt > Date.now()) return hit.value;
  tokens.delete(key);
  return undefined;
}

export function rememberToken(key: string, value: string): void {
  const now = Date.now();
  for (const [other, item] of tokens) if (item.expiresAt <= now) tokens.delete(other);
  while (tokens.size >= MAX_TOKENS) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
  tokens.set(key, { value, expiresAt: now + TOKEN_TTL_MS });
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

/** The after cursor of a Graph list reply, when it has a next page. */
export function nextAfter(data: any): string | undefined {
  const after = data?.paging?.cursors?.after;
  return data?.paging?.next && typeof after === 'string' && after ? after : undefined;
}

export function rowsOf(data: any): any[] {
  return Array.isArray(data?.data) ? data.data : [];
}

/** A list result under 32 KB, continuing where it was cut or at the next Graph page. */
export function listResult<T>(h: ToolHelpers, key: string, items: T[], state: ListState, data: any, extra?: Record<string, unknown>): Record<string, unknown> {
  const next = nextAfter(data);
  return h.page({
    key,
    items: items.slice(state.skip),
    ...(extra ? { extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...(state.after ? { a: state.after } : {}), o: state.skip + index, n: state.limit }),
    ...(next ? { nextPage: h.makeCursor({ a: next, o: 0, n: state.limit }) } : {}),
  });
}

class WaitStopped extends ToolFailure {}

/** Waits, unless the call is cancelled first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WaitStopped('The call was cancelled while waiting.'));
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(new WaitStopped('The call was cancelled while waiting.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Reads until done or until the deadline would pass, waiting between reads. */
export async function poll<T>(h: ToolHelpers, deadline: number, intervalMs: number, read: () => Promise<{ done: boolean; value: T }>): Promise<{ done: boolean; value: T }> {
  for (;;) {
    const result = await read();
    if (result.done || Date.now() + intervalMs > deadline) return result;
    await sleep(intervalMs, h.ctx.signal);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A range of whole days (UTC), both ends included: by default the 28 days that
 * end yesterday (or, for a list, up to today). `untilExclusive` is the day
 * after the last day, as the Graph API's until parameter wants it.
 */
export function dayRange(
  since: string | undefined,
  until: string | undefined,
  maxDays: number,
  lastDefault: 'yesterday' | 'today' = 'yesterday',
): { since: string; until: string; untilExclusive: string; days: number } {
  const today = Date.parse(`${day(new Date())}T00:00:00Z`);
  const last = until ? Date.parse(`${until}T00:00:00Z`) : lastDefault === 'today' ? today : today - DAY_MS;
  const first = since ? Date.parse(`${since}T00:00:00Z`) : last - 27 * DAY_MS;
  if ((since && !ISO_DATE.test(since)) || (until && !ISO_DATE.test(until)) || Number.isNaN(first) || Number.isNaN(last)) {
    throw new ToolFailure('since and until must be dates such as 2026-11-01. Nothing was sent.');
  }
  if (first > last) throw new ToolFailure('since must be on or before until. Nothing was sent.');
  if (last >= today + DAY_MS) throw new ToolFailure('until cannot be in the future. Nothing was sent.');
  const days = Math.round((last - first) / DAY_MS) + 1;
  if (days > maxDays) throw new ToolFailure(`The range has ${days} days; one call covers at most ${maxDays}. Ask for a shorter range. Nothing was sent.`);
  return { since: day(new Date(first)), until: day(new Date(last)), untilExclusive: day(new Date(last + DAY_MS)), days };
}

/**
 * Text that could hand out a token or an app secret is kept out of the generic
 * tools: a second check, on the request as the core resolved it, after the
 * full check of every argument (graph-rules.ts).
 */
export function refuseSecrets(request: ApiToolRequest, label: string): void {
  const texts = [...request.segments, ...Object.keys(request.query), ...Object.values(request.query).flat()];
  if (request.segments.includes('oauth') || texts.some((text) => /access_token|appsecret|app_secret|client_secret|debug_token/i.test(text))) {
    throw new ToolFailure(`Tokens and app secrets are not available through the generic ${label} tools, and the connection's own token is added for you. Nothing was sent.`);
  }
}

/** The kind of media a URL points at, from its path's extension. */
export function mediaKind(url: string): 'image' | 'gif' | 'video' | 'other' {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (/\.(jpe?g|png|webp|bmp|tiff?)$/.test(path)) return 'image';
  if (/\.gif$/.test(path)) return 'gif';
  if (/\.(mp4|mov|m4v|webm)$/.test(path)) return 'video';
  return 'other';
}

export const HTTPS_URL = { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000 };
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
