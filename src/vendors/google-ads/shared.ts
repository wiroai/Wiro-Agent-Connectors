// What the Google Ads tools share: the API version, the account argument and
// its lock, error sentences, and the GAQL search request.

import { requireAccounts, truncate, type ToolHelpers } from '../../core/index.js';

export const VERSION = 'v26';
export const LABEL = 'Google Ads';
export const ACCOUNT = 'Google Ads account';
export const ADS_ORIGIN = 'https://googleads.googleapis.com';
/** Google Ads search pages hold 10,000 rows, with no smaller page size: read up to the hosts' usual 8 MB reply cap. */
export const MAX_SEARCH_BYTES = 8 * 1024 * 1024;

export const CUSTOMER_ID = {
  type: 'string' as const,
  pattern: '^[0-9]{3}-?[0-9]{3}-?[0-9]{4}$',
  description: 'The 10-digit Google Ads account ID, with or without dashes, e.g. "1234567890" (list_customers lists them).',
};
export const LOGIN_CUSTOMER_ID = {
  type: 'string' as const,
  pattern: '^[0-9]{3}-?[0-9]{3}-?[0-9]{4}$',
  description:
    'The manager account (MCC) the account is reached through, sent as login-customer-id. Default: the connection\'s manager account ID '
    + 'if set, else the manager account the connector finds above the account (list_customers gives it as login_customer_id).',
};
export const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };

export const ERRORS = {
  403: 'Google Ads refused the request: the Google account has no access to this account, the account is reached through a manager account (give login_customer_id), or the Google Cloud project of the OAuth client has no Google Ads API access to production accounts yet',
};
export const SEARCH_ERRORS = {
  ...ERRORS,
  400: `Google Ads did not accept the query: check the GAQL syntax, the field names (snake_case, e.g. metrics.cost_micros) and that the fields can be selected together FROM that resource (api_get /${VERSION}/googleAdsFields/<field> tells whether a field exists and what it can be selected with)`,
};

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

export function digits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/** The account ID of an argument, refused unless it is among the accounts chosen for the connection. */
export function chosenCustomer(h: ToolHelpers, value: string): string {
  const id = digits(value);
  requireAccounts(h.ctx.accounts, 'customers', id, ACCOUNT);
  return id;
}

export function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function snakeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [snake(key), snakeDeep(item)]));
  }
  return typeof value === 'string' ? truncate(value, 2000) : value;
}

/** The login-customer-id header for a request, or none. */
export function loginHeaders(login: string | undefined): Record<string, string> {
  return login ? { 'login-customer-id': digits(login) } : {};
}

/** One page of a GAQL query on one account, sent with `login` as login-customer-id (none when undefined). */
export async function searchPage(h: ToolHelpers, customer: string, query: string, login: string | undefined, pageToken?: string): Promise<any> {
  const { data } = await h.api({
    method: 'POST',
    path: `/${VERSION}/customers/${customer}/googleAds:search`,
    headers: loginHeaders(login),
    json: compact({ query, pageToken }),
    safe: true,
    maxBytes: MAX_SEARCH_BYTES,
    errors: SEARCH_ERRORS,
  });
  return data;
}

/** The account IDs of a customers:listAccessibleCustomers reply, sorted. */
export function accessibleIds(data: any): string[] {
  return [...new Set((Array.isArray(data?.resourceNames) ? data.resourceNames : [])
    .map((name: unknown) => /^customers\/([0-9]+)$/.exec(String(name))?.[1])
    .filter((id: string | undefined): id is string => Boolean(id)))].sort() as string[];
}
