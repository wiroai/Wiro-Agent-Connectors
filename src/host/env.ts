import type { ConnectorAccounts, ConnectorModule } from '../types.js';

/** The environment variable a credential is read from: <VENDOR>_<CREDENTIAL>, e.g. DEVTO_API_KEY. */
export function envNameFor(vendor: string, credential: string): string {
  return `${vendor}_${credential}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export interface EnvCredentials {
  credentials: Record<string, string>;
  /** The variables that are not set, e.g. ["DEVTO_API_KEY"]. */
  missing: string[];
}

export function credentialsFromEnv(module: Pick<ConnectorModule, 'vendor' | 'credentials'>, env: NodeJS.ProcessEnv): EnvCredentials {
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of module.credentials) {
    const variable = envNameFor(module.vendor, name);
    const value = env[variable]?.trim();
    if (value) credentials[name] = value;
    else missing.push(variable);
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
