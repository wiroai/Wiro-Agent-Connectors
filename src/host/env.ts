import type { ConnectorAccounts, ConnectorModule } from '../types.js';

/** The environment variable a credential is read from: <VENDOR>_<CREDENTIAL>, e.g. DEVTO_API_KEY. */
export function envNameFor(vendor: string, credential: string): string {
  return `${vendor}_${credential}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * The credential an OAuth connection's current access token arrives in. Hosts
 * pass their current (refreshed) token there on every call; the CLI reads it
 * from <VENDOR>_ACCESS_TOKEN and never refreshes it.
 */
export const ACCESS_TOKEN_CREDENTIAL = 'access_token';

export interface EnvCredentials {
  credentials: Record<string, string>;
  /** The variables that are not set, e.g. ["DEVTO_API_KEY"]. */
  missing: string[];
}

/**
 * The credentials of a module from <VENDOR>_<CREDENTIAL> variables. Every
 * declared credential is required. An OAuth access token is read from
 * <VENDOR>_ACCESS_TOKEN into access_token even when the module does not
 * declare it, as hosts pass a connection's token, and is then optional.
 */
export function credentialsFromEnv(module: Pick<ConnectorModule, 'vendor' | 'credentials'>, env: NodeJS.ProcessEnv): EnvCredentials {
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of module.credentials) {
    const variable = envNameFor(module.vendor, name);
    const value = env[variable]?.trim();
    if (value) credentials[name] = value;
    else missing.push(variable);
  }
  if (!module.credentials.includes(ACCESS_TOKEN_CREDENTIAL)) {
    const token = env[envNameFor(module.vendor, ACCESS_TOKEN_CREDENTIAL)]?.trim();
    if (token) credentials[ACCESS_TOKEN_CREDENTIAL] = token;
  }
  return { credentials, missing };
}

/** The variable that limits account-scoped arguments in the CLI. */
export const ACCOUNTS_ENV = 'CONNECTOR_ACCOUNTS';

/**
 * Account selections from CONNECTOR_ACCOUNTS: JSON such as {"pages":["123"]},
 * or the same JSON in base64url. Unset means no account lock (null).
 */
export function accountsFromEnv(env: NodeJS.ProcessEnv): ConnectorAccounts {
  const raw = env[ACCOUNTS_ENV]?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${ACCOUNTS_ENV} must be JSON like {"pages":["123"]} (or that JSON in base64url).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${ACCOUNTS_ENV} must be a JSON object of lists, like {"pages":["123"]}.`);
  }
  const accounts: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      throw new Error(`${ACCOUNTS_ENV}: "${key}" must be a list of ids.`);
    }
    accounts[key] = value.map(String);
  }
  return accounts;
}
