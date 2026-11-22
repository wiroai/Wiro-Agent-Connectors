import { base64UrlDecode, ToolFailure, utf8Bytes, utf8Decode, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

// Sessions come from com.atproto.server.createSession. Bluesky allows 30 of
// them per 5 minutes and 300 per day for one account, so a session is kept in
// memory for a short time, keyed by a SHA-256 hash of the credentials (never
// the credentials themselves), and this process counts its own sign-ins so it
// stops before Bluesky's limit instead of at it.

export const SESSION_TTL_MS = 10 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
export const SIGN_IN_LIMITS = [
  { windowMs: 5 * MINUTE, max: 30, words: '30 sign-ins per 5 minutes' },
  { windowMs: DAY, max: 300, words: '300 sign-ins per day' },
];
const MAX_CACHED_SESSIONS = 64;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const pending = new Map<string, Promise<Session>>();
const signIns = new Map<string, number[]>();

async function credentialKey(identifier: string, password: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Bytes(`${identifier}\n${password}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jwtExpiry(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(utf8Decode(base64UrlDecode(jwt.split('.')[1] ?? '')));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string, session: Session): void {
  const now = Date.now();
  for (const [other, cached] of sessions) if (cached.expiresAt <= now) sessions.delete(other);
  while (sessions.size >= MAX_CACHED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  sessions.set(key, session);
}

function countSignIn(key: string): void {
  const now = Date.now();
  const recent = (signIns.get(key) ?? []).filter((time) => time > now - DAY);
  for (const limit of SIGN_IN_LIMITS) {
    const inWindow = recent.filter((time) => time > now - limit.windowMs);
    if (inWindow.length >= limit.max) {
      const retryAfter = Math.max(1, Math.ceil(((inWindow[0] as number) + limit.windowMs - now) / 1000));
      throw new ToolFailure(
        `Bluesky allows ${limit.words} for one account, and this connection has used them. `
          + `Nothing was sent to Bluesky. Retry after ${retryAfter} seconds.`,
        { retryAfter },
      );
    }
  }
  recent.push(now);
  signIns.set(key, recent);
}

function signInFailure(error: unknown): unknown {
  if (!(error instanceof ToolFailure)) return error;
  const { status, vendorCode, retryAfter } = error.details;
  const keep = { ...(status !== undefined ? { status } : {}), ...(vendorCode ? { vendorCode } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) };
  if (vendorCode === 'AuthFactorTokenRequired') {
    return new ToolFailure('Bluesky asked for an email sign-in code: the password given is the account password, not an app password. Create an app password in Bluesky\'s settings and use that.', keep);
  }
  if (vendorCode === 'AccountTakedown') return new ToolFailure('Bluesky reports this account as taken down or suspended.', keep);
  if (status === 401 || vendorCode === 'AuthenticationRequired') {
    return new ToolFailure(
      'Bluesky refused the handle or app password: the app password may have been deleted or mistyped, or the account is not hosted by Bluesky.',
      keep,
    );
  }
  if (status === 429) {
    return new ToolFailure(
      `Bluesky's sign-in limit for this account was reached (30 per 5 minutes, 300 per day). `
        + (retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : 'Wait a while before retrying.'),
      keep,
    );
  }
  return error;
}

async function signIn(h: ToolHelpers, key: string): Promise<Session> {
  countSignIn(key);
  let response: ApiResponse;
  try {
    response = await h.api({
      method: 'POST',
      path: '/xrpc/com.atproto.server.createSession',
      json: { identifier: h.credentials['identifier'], password: h.credentials['app_password'] },
      safe: true,
    });
  } catch (error) {
    throw signInFailure(error);
  }
  const data = response.data;
  if (typeof data?.accessJwt !== 'string' || !JWT_PATTERN.test(data.accessJwt) || typeof data?.did !== 'string') {
    throw new ToolFailure('Bluesky signed in but sent no usable session.');
  }
  if (data.active === false) {
    throw new ToolFailure(`Bluesky reports this account as ${typeof data.status === 'string' ? data.status : 'inactive'}.`);
  }
  const now = Date.now();
  const expiry = jwtExpiry(data.accessJwt);
  const session: Session = {
    did: data.did,
    handle: typeof data.handle === 'string' ? data.handle : String(h.credentials['identifier']),
    accessJwt: data.accessJwt,
    expiresAt: Math.min(now + SESSION_TTL_MS, expiry !== undefined ? expiry - MINUTE : Infinity),
  };
  remember(key, session);
  return session;
}

/** The cached session for these credentials, or a new one. Parallel calls share one sign-in. */
export async function getSession(h: ToolHelpers): Promise<Session> {
  const key = await credentialKey(String(h.credentials['identifier']), String(h.credentials['app_password']));
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  sessions.delete(key);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const started = signIn(h, key).finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

function forget(session: Session): void {
  for (const [key, cached] of sessions) if (cached === session) sessions.delete(key);
}

function isExpired(error: unknown): boolean {
  if (!(error instanceof ToolFailure)) return false;
  const { status, vendorCode } = error.details;
  return (status === 400 || status === 401) && (vendorCode === 'ExpiredToken' || vendorCode === 'InvalidToken');
}

/** An authenticated XRPC request with the session's access token. */
export function xrpc(h: ToolHelpers, session: Session, request: ApiRequest): Promise<ApiResponse> {
  return h.api({ ...request, headers: { ...request.headers, authorization: `Bearer ${session.accessJwt}` } });
}

/**
 * Runs `work` with a session. When Bluesky says the session expired, a read
 * signs in again and runs once more; a write never runs twice, and says
 * plainly that nothing was changed (an expired session is refused before any
 * change is made).
 */
export async function withSession<T>(h: ToolHelpers, readOnly: boolean, work: (session: Session) => Promise<T>): Promise<T> {
  const session = await getSession(h);
  try {
    return await work(session);
  } catch (error) {
    if (!isExpired(error)) throw error;
    forget(session);
    if (!readOnly) {
      throw new ToolFailure('The Bluesky session expired before the request was accepted, so nothing was changed. Call the tool again.');
    }
    return work(await getSession(h));
  }
}
