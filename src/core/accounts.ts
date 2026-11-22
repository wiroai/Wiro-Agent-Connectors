import type { ConnectorAccounts } from '../types.js';
import { ToolFailure } from './errors.js';

/**
 * The account ids a host allows for `key`, or null when the host applies no
 * account lock (ctx.accounts === null). A missing key allows nothing.
 */
export function allowedAccounts(accounts: ConnectorAccounts | undefined, key: string): string[] | null {
  if (accounts === null) return null;
  const list = accounts?.[key];
  return Array.isArray(list) ? list.map(String) : [];
}

/**
 * Refuses the call unless every given account id is among the accounts the
 * host selected under `key`, e.g. requireAccounts(ctx.accounts, "pages",
 * args.page_id, "Page"). Call it before any request that acts on an account.
 * An undefined ctx.accounts is treated as an empty selection, never as no lock.
 */
export function requireAccounts(
  accounts: ConnectorAccounts | undefined,
  key: string,
  ids: string | number | ReadonlyArray<string | number>,
  label = 'account',
): void {
  const allowed = allowedAccounts(accounts, key);
  if (allowed === null) return;
  const requested = (Array.isArray(ids) ? ids : [ids]).map(String);
  const refused = requested.filter((id) => !allowed.includes(id));
  if (!refused.length) return;
  throw new ToolFailure(
    `The ${label} ${refused.join(', ')} ${refused.length > 1 ? 'are' : 'is'} not among the ${label}s chosen for this connection. `
      + (allowed.length ? `Use one of: ${allowed.join(', ')}.` : `No ${label} is chosen for it yet.`)
      + ' Nothing was sent.',
  );
}
