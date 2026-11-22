// The login-customer-id of a request. Google Ads needs it for an account the
// Google account reaches through a manager account (MCC), set to that
// manager's ID; for an account it opens directly it needs none. A call may
// name it (login_customer_id) and a connection may give one for every call
// (managercustomerid). Without either, the connector finds it: the accounts the
// Google account opens directly need none, and for any other account it asks
// those accounts, one by one, whether the account sits anywhere below them
// (customer_client lists every level). It reads nothing else of them. What it
// finds is kept in memory for an hour, the life of an access token, keyed by a
// SHA-256 hash of the token (never the token itself); list_customers adds what
// it reads.

import { sha256Hex, ToolFailure, type ToolHelpers } from '../../core/index.js';
import { accessibleIds, digits, ERRORS, searchPage, VERSION } from './shared.js';

const PATHS_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_PATHS = 2_000;
/** At most this many accounts are asked whether a client account sits below them. */
export const MAX_MANAGERS_ASKED = 25;

interface LoginPaths {
  expiresAt: number;
  /** Account ID -> the login-customer-id to reach it with; "" when none is needed or none was found. */
  logins: Map<string, string>;
  /** The accounts the Google account opens directly, once read. */
  accessible?: string[];
  /** Which of them list_customers saw to be manager accounts (true) or not (false). */
  managers: Map<string, boolean>;
}

const sessions = new Map<string, LoginPaths>();

async function pathsFor(h: ToolHelpers): Promise<LoginPaths> {
  const key = await sha256Hex(`login paths\n${h.credentials['access_token'] ?? ''}`);
  const now = Date.now();
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > now) return cached;
  sessions.delete(key);
  for (const [other, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(other);
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const paths: LoginPaths = { expiresAt: now + PATHS_TTL_MS, logins: new Map(), managers: new Map() };
  sessions.set(key, paths);
  return paths;
}

function remember(paths: LoginPaths, customer: string, login: string): void {
  paths.logins.delete(customer);
  while (paths.logins.size >= MAX_PATHS) {
    const oldest = paths.logins.keys().next().value;
    if (oldest === undefined) break;
    paths.logins.delete(oldest);
  }
  paths.logins.set(customer, login);
}

/**
 * Keeps what list_customers read: the accounts the Google account opens
 * directly, which of them are managers, and the manager each client account
 * was listed under.
 */
export async function rememberHierarchy(
  h: ToolHelpers,
  accessible: string[],
  managers: ReadonlyArray<[account: string, isManager: boolean]>,
  clients: ReadonlyArray<[client: string, manager: string]>,
): Promise<void> {
  const paths = await pathsFor(h);
  paths.accessible = accessible;
  for (const id of accessible) remember(paths, id, '');
  for (const [id, isManager] of managers) paths.managers.set(id, isManager);
  for (const [client, manager] of clients) if (!paths.logins.has(client)) remember(paths, client, manager);
}

/**
 * The manager account above `customer` that the Google account opens directly,
 * or undefined when it opens the account itself or no manager was found.
 */
async function findManager(h: ToolHelpers, paths: LoginPaths, customer: string): Promise<string | undefined> {
  if (!paths.accessible) {
    const { data } = await h.api({ path: `/${VERSION}/customers:listAccessibleCustomers`, errors: ERRORS });
    paths.accessible = accessibleIds(data);
    for (const id of paths.accessible) if (!paths.logins.has(id)) remember(paths, id, '');
  }
  if (paths.accessible.includes(customer)) return undefined;
  // Known managers first; accounts list_customers saw not to be managers are not asked.
  const candidates = paths.accessible
    .filter((id) => paths.managers.get(id) !== false)
    .sort((a, b) => Number(paths.managers.get(b) === true) - Number(paths.managers.get(a) === true))
    .slice(0, MAX_MANAGERS_ASKED);
  const query = `SELECT customer_client.id FROM customer_client WHERE customer_client.id = ${customer}`;
  for (const manager of candidates) {
    let rows: unknown[];
    try {
      const page = await searchPage(h, manager, query, manager);
      rows = Array.isArray(page?.results) ? page.results : [];
    } catch (error) {
      // An account that cannot be asked (closed, suspended, or a server error) is passed over.
      const status = error instanceof ToolFailure ? error.details.status : undefined;
      if (status === 400 || status === 403 || status === 404 || (status !== undefined && status >= 500)) continue;
      throw error;
    }
    if (rows.length) return manager;
  }
  return undefined;
}

/**
 * The login-customer-id for a request on `customer`: the call's own
 * argument, else the connection's manager account ID, else the manager
 * account the Google account reaches `customer` through. undefined when none
 * is needed (the account is opened directly) or none was found; Google Ads then
 * answers for itself. A failed lookup fails the call before its own request
 * is sent.
 */
export async function loginFor(h: ToolHelpers, customer: string | undefined, explicit?: string): Promise<string | undefined> {
  if (explicit) return digits(explicit);
  const manager = h.credentials['managercustomerid'];
  if (manager) return manager;
  if (!customer) return undefined;
  const paths = await pathsFor(h);
  const known = paths.logins.get(customer);
  if (known !== undefined) return known || undefined;
  const found = await findManager(h, paths, customer);
  remember(paths, customer, found ?? '');
  return found;
}
