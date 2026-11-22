import type { ToolHelpers } from './connector.js';
import { ToolFailure } from './errors.js';
import { base64Decode, base64UrlEncode, sha256Hex, utf8Bytes } from './text.js';

// JWTs for services whose credential is a private key: a Google service
// account (RS256, exchanged for an access token) and an App Store Connect API
// key (ES256, sent as the token itself). WebCrypto only (crypto.subtle), so the
// modules stay dependency-free.

export type JwtAlgorithm = 'RS256' | 'ES256';

export interface SignJwtOptions {
  algorithm: JwtAlgorithm;
  /**
   * A PEM PKCS#8 private key: "-----BEGIN PRIVATE KEY-----" ... "-----END
   * PRIVATE KEY-----" (RSA for RS256, P-256 for ES256). Literal "\n"
   * sequences, as in a key pasted out of a JSON file, count as line breaks.
   */
  privateKey: string;
  /** The claims. */
  payload: Record<string, unknown>;
  /** Header fields besides alg and typ, e.g. { kid: "ABC123DEFG" }. */
  header?: Record<string, unknown>;
  /** What the key is called in messages (default "private key"). */
  keyName?: string;
}

const KEY_ALGORITHMS = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' }, kind: 'an RSA' },
  // WebCrypto returns ECDSA signatures as raw r||s, the form JWS (ES256) needs.
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' }, kind: 'a P-256 (ES256)' },
} as const;

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(utf8Bytes(JSON.stringify(value)));
}

/** The DER bytes of a PEM PKCS#8 private key, or a ToolFailure that says what is wrong with it. */
function pkcs8Der(pem: string, keyName: string): Uint8Array {
  const text = String(pem).replace(/\\r\\n|\\n/g, '\n').trim();
  const block = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  const whole = `it must be the whole PEM text, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----`;
  if (!block) throw new ToolFailure(`The ${keyName} could not be read: ${whole}. Nothing was sent.`);
  const type = block[1] as string;
  if (type === 'ENCRYPTED PRIVATE KEY') throw new ToolFailure(`The ${keyName} is encrypted with a passphrase: use the key without one. Nothing was sent.`);
  if (type !== 'PRIVATE KEY') {
    throw new ToolFailure(`The ${keyName} is a "${type}" block, not a PKCS#8 "PRIVATE KEY": convert it with openssl pkcs8 -topk8 -nocrypt. Nothing was sent.`);
  }
  try {
    return base64Decode(block[2] as string);
  } catch {
    throw new ToolFailure(`The ${keyName} could not be read: ${whole}. Nothing was sent.`);
  }
}

/** Signs a JWT with RS256 or ES256 from a PEM PKCS#8 private key, with WebCrypto. */
export async function signJwt(options: SignJwtOptions): Promise<string> {
  const keyName = options.keyName ?? 'private key';
  const algorithm = KEY_ALGORITHMS[options.algorithm];
  if (!algorithm) throw new Error(`unsupported JWT algorithm ${String(options.algorithm)}`);
  const der = pkcs8Der(options.privateKey, keyName);
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, algorithm.import, false, ['sign']);
  } catch {
    throw new ToolFailure(`The ${keyName} is not ${algorithm.kind} private key. Nothing was sent.`);
  }
  const header = { alg: options.algorithm, typ: 'JWT', ...options.header };
  header.alg = options.algorithm;
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(options.payload)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm.sign, key, utf8Bytes(signingInput)));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** An App Store Connect API key, from App Store Connect -> Users and Access -> Integrations. */
export interface AppStoreConnectKey {
  /** The issuer id shown above the team keys. Leave it out for an individual key. */
  issuerId?: string;
  /** The key id, e.g. "2X9R4HXF34". */
  keyId: string;
  /** The text of the key's .p8 file. */
  privateKey: string;
}

/**
 * A token for the App Store Connect API: an ES256 JWT with the key id as kid,
 * the issuer id as iss (sub "user" for an individual key), aud
 * "appstoreconnect-v1", and a 20-minute expiry, the longest Apple accepts.
 * Send it as "Authorization: Bearer <token>".
 */
export async function appStoreConnectToken(key: AppStoreConnectKey): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({
    algorithm: 'ES256',
    privateKey: key.privateKey,
    header: { kid: key.keyId },
    payload: { ...(key.issuerId ? { iss: key.issuerId } : { sub: 'user' }), iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1' },
    keyName: 'App Store Connect private key',
  });
}

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_EARLY_MS = 5 * 60 * 1000;
const MAX_CACHED_TOKENS = 64;
const SERVICE_ACCOUNT_HELP =
  'The service account key is not a Google service account key file: paste the whole JSON file Google Cloud creates for the key '
  + '(IAM and admin -> Service accounts -> Keys -> Add key -> JSON), with "client_email" and "private_key" in it. Nothing was sent.';

export interface GoogleServiceAccountOptions {
  /** OAuth scopes, e.g. ["https://www.googleapis.com/auth/analytics.readonly"]. */
  scopes: string[];
  /** A user to act as, for a key with domain-wide delegation. */
  subject?: string;
}

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  keyId?: string;
}

const googleTokens = new Map<string, { token: string; expiresAt: number }>();
const pendingGoogleTokens = new Map<string, Promise<string>>();

function readServiceAccount(json: string): ServiceAccount {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ToolFailure(SERVICE_ACCOUNT_HELP);
  }
  if (typeof data !== 'object' || data === null || typeof data.client_email !== 'string' || typeof data.private_key !== 'string') {
    throw new ToolFailure(SERVICE_ACCOUNT_HELP);
  }
  if (data.type !== undefined && data.type !== 'service_account') {
    throw new ToolFailure(`The Google key is a "${String(data.type).slice(0, 40)}" credential, not a service account key. ${SERVICE_ACCOUNT_HELP}`);
  }
  return { clientEmail: data.client_email, privateKey: data.private_key, ...(typeof data.private_key_id === 'string' ? { keyId: data.private_key_id } : {}) };
}

async function exchangeGoogleToken(h: ToolHelpers, account: ServiceAccount, options: GoogleServiceAccountOptions): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const assertion = await signJwt({
    algorithm: 'RS256',
    privateKey: account.privateKey,
    header: account.keyId ? { kid: account.keyId } : {},
    payload: {
      iss: account.clientEmail,
      scope: options.scopes.join(' '),
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
      ...(options.subject ? { sub: options.subject } : {}),
    },
    keyName: 'service account private key',
  });
  const { data } = await h.api({
    method: 'POST',
    origin: GOOGLE_TOKEN_ORIGIN,
    path: '/token',
    body: utf8Bytes(new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString()),
    contentType: 'application/x-www-form-urlencoded',
    // The assertion is the credential: no module auth header goes with it.
    auth: false,
    // A token exchange changes nothing, so read tools may make it.
    safe: true,
    errors: {
      400: 'Google did not accept the service account key',
      401: 'Google did not accept the service account key',
    },
  });
  if (typeof data?.access_token !== 'string' || !data.access_token) throw new ToolFailure('Google sent no access token for the service account.');
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { token: data.access_token, expiresIn };
}

/**
 * An OAuth access token for a Google service account: a JWT signed with the
 * account's key (RS256) and exchanged at https://oauth2.googleapis.com/token
 * with the jwt-bearer grant. The module must list https://oauth2.googleapis.com
 * in its origins. The token stays in memory until 5 minutes before it expires,
 * keyed by a SHA-256 hash of the key, the scopes and the subject (never the
 * key itself), and parallel calls share one exchange.
 */
export async function googleServiceAccountToken(h: ToolHelpers, serviceAccountJson: string, options: GoogleServiceAccountOptions): Promise<string> {
  if (!h.origins.includes(GOOGLE_TOKEN_ORIGIN)) throw new Error(`a module that uses googleServiceAccountToken declares ${GOOGLE_TOKEN_ORIGIN} in its origins`);
  const account = readServiceAccount(serviceAccountJson);
  const key = await sha256Hex([account.clientEmail, account.privateKey, options.scopes.join(' '), options.subject ?? ''].join('\n'));
  const cached = googleTokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  googleTokens.delete(key);
  const inFlight = pendingGoogleTokens.get(key);
  if (inFlight) return inFlight;

  const started = exchangeGoogleToken(h, account, options)
    .then(({ token, expiresIn }) => {
      const now = Date.now();
      for (const [other, entry] of googleTokens) if (entry.expiresAt <= now) googleTokens.delete(other);
      while (googleTokens.size >= MAX_CACHED_TOKENS) {
        const oldest = googleTokens.keys().next().value;
        if (oldest === undefined) break;
        googleTokens.delete(oldest);
      }
      googleTokens.set(key, { token, expiresAt: now + Math.min(expiresIn, 3600) * 1000 - TOKEN_EARLY_MS });
      return token;
    })
    .finally(() => pendingGoogleTokens.delete(key));
  pendingGoogleTokens.set(key, started);
  return started;
}
