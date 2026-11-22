// Reddit's rate and mutation rules, kept in memory for as long as the module
// is loaded (nothing is stored anywhere else):
//
// - Requests of one app go out one at a time, and the X-Ratelimit-Used,
//   -Remaining and -Reset headers of every reply are remembered. When the
//   window is spent, or Reddit answers 429, nothing more is sent until the
//   reset; a write limit Reddit states in a reply (RATELIMIT) holds writes
//   back for the later of that delay and the header reset. The last request
//   of a window is kept for a write.
// - Every post and comment gets a SHA-256 digest of the operation, the
//   account, the target and the normalized text (never the text itself). An
//   identical one that succeeded in the last 48 hours is not sent again, one
//   whose outcome is unknown needs an explicit go-ahead after a check, and the
//   same text is not repeated in another community or thread.
//
// The app is told apart by a hash of its developer profile username.

import { sha256Hex, ToolFailure, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

const HOUR = 60 * 60 * 1000;
export const LEDGER_TTL_MS = 48 * HOUR;
const MAX_LEDGER_ROWS = 500;
const MAX_APPS = 64;

interface RateState {
  cooldownUntil: number;
  writeCooldownUntil: number;
  used?: number;
  remaining?: number;
  resetAt?: number;
  queue: Promise<void>;
}

export interface RateInfo {
  used?: number;
  remaining?: number;
  resetSeconds?: number;
}

const rates = new Map<string, RateState>();

async function appKey(h: ToolHelpers): Promise<string> {
  return sha256Hex(`reddit-app\n${String(h.credentials['developerprofileusername'] ?? '').toLowerCase()}`);
}

function stateFor(key: string): RateState {
  let state = rates.get(key);
  if (!state) {
    while (rates.size >= MAX_APPS) {
      const oldest = rates.keys().next().value;
      if (oldest === undefined) break;
      rates.delete(oldest);
    }
    state = { cooldownUntil: 0, writeCooldownUntil: 0, queue: Promise.resolve() };
    rates.set(key, state);
  }
  return state;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function remember(state: RateState, headers: Headers, now: number): void {
  const used = headerNumber(headers, 'x-ratelimit-used');
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (used !== undefined) state.used = used;
  if (remaining !== undefined) state.remaining = remaining;
  if (reset !== undefined) state.resetAt = now + reset * 1000;
  if (remaining !== undefined && remaining < 1 && reset !== undefined) state.cooldownUntil = Math.max(state.cooldownUntil, now + reset * 1000);
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** What the last reply said about the app's rate window. */
export async function rateInfo(h: ToolHelpers): Promise<RateInfo | undefined> {
  const state = rates.get(await appKey(h));
  if (!state || (state.used === undefined && state.remaining === undefined)) return undefined;
  const reset = state.resetAt !== undefined ? Math.max(0, Math.ceil((state.resetAt - Date.now()) / 1000)) : undefined;
  return { used: state.used, remaining: state.remaining, resetSeconds: reset };
}

/**
 * One request to Reddit, after any other request of the same app finished,
 * and only when its rate window allows one. A GET is a read; every other
 * request is a write.
 */
export async function redditRequest(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  const state = stateFor(await appKey(h));
  const previous = state.queue;
  let release: () => void = () => {};
  state.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const now = Date.now();
    const read = (request.method ?? 'GET') === 'GET';
    const until = Math.max(state.cooldownUntil, read ? 0 : state.writeCooldownUntil);
    if (until > now) {
      const retryAfter = seconds(until - now);
      throw new ToolFailure(`Reddit's rate limit for this app needs a pause. Nothing was sent. Retry after ${retryAfter} seconds.`, { retryAfter });
    }
    if (read && state.remaining !== undefined && state.remaining <= 1 && state.resetAt !== undefined && state.resetAt > now) {
      const retryAfter = seconds(state.resetAt - now);
      throw new ToolFailure(
        `Only one Reddit request is left in this rate window, kept for a post or comment. Nothing was sent. Retry the read after ${retryAfter} seconds.`,
        { retryAfter },
      );
    }
    try {
      const response = await h.api(request);
      remember(state, response.headers, Date.now());
      return response;
    } catch (error) {
      if (error instanceof ToolFailure && error.details.status === 429 && error.details.retryAfter !== undefined) {
        state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + error.details.retryAfter * 1000);
      }
      throw error;
    }
  } finally {
    release();
  }
}

/** Holds writes back after Reddit stated a write limit; returns the seconds to wait. */
export async function noteWriteLimit(h: ToolHelpers, statedSeconds: number | undefined): Promise<number | undefined> {
  const state = stateFor(await appKey(h));
  const now = Date.now();
  const headerWait = state.resetAt !== undefined ? (state.resetAt - now) / 1000 : 0;
  const wait = Math.max(statedSeconds ?? 0, headerWait);
  if (wait <= 0) return undefined;
  const rounded = Math.ceil(wait);
  state.writeCooldownUntil = Math.max(state.writeCooldownUntil, now + rounded * 1000);
  return rounded;
}

// ---- the mutation ledger ----

type Status = 'in_flight' | 'succeeded' | 'failed' | 'ambiguous';

interface Row {
  status: Status;
  at: number;
  target: string;
  payload?: string;
  result?: string;
}

const ledger = new Map<string, Row>();

export interface Mutation {
  key: string;
  target: string;
  /** Set for posts and comments: the same text may not go to another target. */
  payload?: string;
}

const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$/i;

/** Unicode-normalized, case-folded, whitespace-collapsed text. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A URL without its fragment and tracking-only parameters, normalized like text. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (TRACKING.test(key)) parsed.searchParams.delete(key);
    return normalizeText(parsed.toString());
  } catch {
    return normalizeText(url);
  }
}

function thing(target: string): Promise<string> {
  return sha256Hex(`reddit-target\n${target.toLowerCase()}`);
}

function prune(now: number): void {
  for (const [key, row] of ledger) {
    if ((row.status === 'succeeded' || row.status === 'failed') && now - row.at > LEDGER_TTL_MS) ledger.delete(key);
  }
  while (ledger.size >= MAX_LEDGER_ROWS) {
    const terminal = [...ledger.entries()].find(([, row]) => row.status === 'succeeded' || row.status === 'failed');
    const oldest = terminal?.[0] ?? ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

/**
 * The digests of one mutation. `kind` groups the texts that must not repeat
 * across targets ("post", "comment"); leave it out for edits and deletes.
 */
export async function describeMutation(operation: string, identity: string, target: string, content: string, kind?: string): Promise<Mutation> {
  const who = identity.toLowerCase();
  return {
    key: await sha256Hex(`reddit-mutation\n${operation}\n${who}\n${target.toLowerCase()}\n${content}`),
    target: await thing(target),
    ...(kind ? { payload: await sha256Hex(`reddit-payload\n${kind}\n${who}\n${content}`) } : {}),
  };
}

export interface LedgerCheck {
  /** "post", "comment", "edit", "delete": words for messages. */
  what: string;
  /** The read tool that shows whether an earlier attempt went through. */
  check: string;
  allowRepeat?: boolean;
  /** Edits and deletes may be repeated once they succeeded: doing them again changes nothing more. */
  idempotent?: boolean;
}

/** Refuses a mutation the ledger says must not be sent now. */
export function checkMutation(mutation: Mutation, options: LedgerCheck): void {
  const now = Date.now();
  prune(now);
  const row = ledger.get(mutation.key);
  if (row?.status === 'in_flight') throw new ToolFailure(`The same Reddit ${options.what} is being sent right now. Nothing was sent.`);
  if (row?.status === 'succeeded' && !options.idempotent) {
    throw new ToolFailure(`This exact Reddit ${options.what} already went through in the last 48 hours, so it was not sent again. Nothing was sent.`);
  }
  if (row?.status === 'ambiguous' && !options.idempotent && !options.allowRepeat) {
    throw new ToolFailure(
      `An identical Reddit ${options.what} was sent earlier and its outcome is unknown. Check ${options.check} first; only if it is not there `
        + 'and a new attempt is approved, call again with allow_repeat_after_check: true. Nothing was sent.',
    );
  }
  if (mutation.payload) {
    for (const other of ledger.values()) {
      if (other.payload === mutation.payload && other.target !== mutation.target && other.status !== 'failed' && now - other.at <= LEDGER_TTL_MS) {
        throw new ToolFailure(
          `The same ${options.what} text went to another ${options.what === 'post' ? 'community' : 'thread'} in the last 48 hours. Reddit does not allow `
            + `repeating it: write a materially different ${options.what} for this one. Nothing was sent.`,
        );
      }
    }
  }
}

export async function recordMutation(mutation: Mutation, status: Status, resultFullname?: string): Promise<void> {
  ledger.set(mutation.key, {
    status,
    at: Date.now(),
    target: mutation.target,
    ...(mutation.payload ? { payload: mutation.payload } : {}),
    ...(resultFullname ? { result: await thing(resultFullname) } : {}),
  });
}

/** After a delete, forgets every row about that post or comment: it may be written again. */
export async function forgetThing(fullname: string): Promise<void> {
  const digest = await thing(fullname);
  for (const [key, row] of ledger) if (row.target === digest || row.result === digest) ledger.delete(key);
}
