// Google Ads, through the Google Ads API v26 REST interface on
// https://googleads.googleapis.com: GAQL reports, grouped mutates for
// campaigns, budgets, ad groups, ads, keywords, criteria, assets, audiences and
// conversion settings, image assets from a URL, Keyword Planner ideas, Customer
// Match uploads, and the rest of the API through api_get and api_request.
//
// Credentials:
// - `access_token`: a Google OAuth access token with the scope
//   https://www.googleapis.com/auth/adwords, from an OAuth client in the user's
//   own Google Cloud project, whose Google Ads API access level applies. The
//   host signs in, refreshes it and passes the current one on every call.
// - `developertoken` (optional): Google sunset developer tokens on 2026-09-09,
//   ignores them since and will refuse them in a later major API version. It
//   stays declared so an older setup's value still loads, but it is not sent.
// - `managercustomerid` (optional): a manager account (MCC) sent as
//   login-customer-id on every request. Without it, the connector finds the
//   manager account of a client account itself (login.ts).
//
// Account picker `customers` (the Google Ads accounts the agent may use): every
// tool that names an account checks it against ctx.accounts.customers.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  jsonSize,
  OUTPUT_LIMIT_BYTES,
  OutcomeUnknown,
  requireAccounts,
  sha256Hex,
  ToolFailure,
  truncate,
  type ApiRequest,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  CONSENT,
  HASHED_LISTS,
  hashIdentifiers,
  IDENTIFIER_LISTS,
  identifierCount,
  MAX_MATCH_IDENTIFIERS,
  normalizeEmail,
  normalizePhone,
  skippedSummary,
} from './identifiers.js';
import { loginFor, rememberHierarchy } from './login.js';
import {
  accessibleIds,
  ACCOUNT,
  ADS_ORIGIN,
  compact,
  CURSOR,
  CUSTOMER_ID,
  chosenCustomer,
  digits,
  ERRORS,
  LABEL,
  LOGIN_CUSTOMER_ID,
  loginHeaders,
  searchPage,
  snake,
  snakeDeep,
  VERSION,
} from './shared.js';

const MAX_IMAGE_BYTES = 5_120 * 1024;
const PICKER_BATCH = 10;

const MUTATE_ERRORS = {
  ...ERRORS,
  400: 'Google Ads rejected the operations: check the field names (camelCase), resource names, enum values and text limits (headlines 30 characters, descriptions 90, paths 15); validate_only: true checks operations without changing anything',
};

const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.manager, customer.status, customer.currency_code, customer.time_zone, customer.test_account FROM customer LIMIT 1';
const CLIENTS_QUERY =
  'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, '
  + 'customer_client.currency_code, customer_client.time_zone, customer_client.test_account FROM customer_client WHERE customer_client.level <= 2';

/**
 * "customers/<id>" as a resource name: at the start of a value, or after a
 * quote or a space, never inside a URL's path (an ad's final URL may hold
 * "/customers/..."). Any number of digits, so a zero-padded ID is caught too
 * and refused, as it is no chosen 10-digit ID.
 */
const CUSTOMER_NAME = /(?<![A-Za-z0-9_./-])customers\/([0-9]+)/g;

/** The customer IDs of every "customers/<id>" inside a JSON value or a text. */
function customersIn(value: unknown): string[] {
  if (value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...new Set([...text.matchAll(CUSTOMER_NAME)].map((match) => match[1] as string))];
}

/** The account a generic request's path acts on: /v26/customers/<id>/... or /v26/customers/<id>:method. */
function customerOfPath(path: string): string | undefined {
  return /^\/v[0-9]+\/customers\/([0-9]+)(?:[/:]|$)/.exec(path)?.[1];
}

/** A GAQL result row as flat fields named like the query's: {"campaign.id": "1", "metrics.cost_micros": "2500000"}. */
function flattenRow(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flattenRow(item, prefix ? `${prefix}.${snake(key)}` : snake(key), out);
  } else if (prefix) {
    out[prefix] = Array.isArray(value) ? snakeDeep(value) : typeof value === 'string' ? truncate(value, 2000) : value;
  }
  return out;
}

/** A name for an image asset left unnamed: Google Ads wants unique names for image assets (it adds a suffix to a repeated one). */
function defaultAssetName(url: string): string {
  let file = '';
  try {
    file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    // a broken escape: the name goes without the file part
  }
  const base = truncate(file.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'Image', 80);
  return `${base} ${new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z')}`;
}

/** Google's partial failure details: which operation failed and why. */
function failuresOf(error: any): Record<string, unknown>[] | undefined {
  const details: any[] = Array.isArray(error?.details) ? error.details : [];
  const failures = details.flatMap((detail) => (Array.isArray(detail?.errors) ? detail.errors : [])).slice(0, 50).map((item: any) => {
    const path: any[] = Array.isArray(item?.location?.fieldPathElements) ? item.location.fieldPathElements : [];
    const indexed = path.find((element) => typeof element?.index === 'number');
    const code = item?.errorCode && typeof item.errorCode === 'object' ? Object.entries(item.errorCode)[0] : undefined;
    return compact({
      operation: indexed?.index,
      message: typeof item?.message === 'string' ? truncate(item.message, 300) : undefined,
      error_code: code ? `${snake(String(code[0]))}: ${String(code[1])}` : undefined,
      field: path.length ? path.map((element) => `${element?.fieldName}${typeof element?.index === 'number' ? `[${element.index}]` : ''}`).join('.') : undefined,
    });
  });
  if (!failures.length && typeof error?.message === 'string') return [{ message: truncate(error.message, 300) }];
  return failures.length ? failures : undefined;
}

/**
 * A write's result cut to fit the output limit: the change is made either way,
 * so the result must never be refused for its size (that would invite a retry).
 */
function fitWriteResult(result: Record<string, unknown>, listKey: string): Record<string, unknown> {
  const list = result[listKey];
  if (!Array.isArray(list) || jsonSize(result) <= OUTPUT_LIMIT_BYTES - 500) return result;
  let count = list.length;
  while (count > 0 && jsonSize({ ...result, [listKey]: list.slice(0, count) }) > OUTPUT_LIMIT_BYTES - 500) count = Math.floor(count * 0.8);
  return { ...result, [listKey]: list.slice(0, count), [`${listKey}_total`]: list.length, [`${listKey}_note`]: `Only the first ${count} of ${list.length} are listed here; search lists the rest.` };
}

function hasPartialFailure(data: any): boolean {
  return Boolean(data?.partialFailureError && (data.partialFailureError.code || data.partialFailureError.message));
}

/** Sniffs the image type from its first bytes: Google Ads takes JPEG, PNG and GIF. */
function imageType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return undefined;
}

/** Standard base64 with padding, as Google's JSON takes bytes fields. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Endpoints the generic tools keep out of reach, and their account lock. */
function guardRequest(request: ApiToolRequest, h: ToolHelpers): void {
  const allowed = allowedAccounts(h.ctx.accounts, 'customers');
  if (allowed !== null) {
    // The JSON body is the only body api_request sends, so nothing goes out unread.
    const ids = new Set<string>([...customersIn(request.json), ...Object.values(request.query).flat().flatMap((value) => customersIn(value))]);
    request.segments.forEach((segment, index) => {
      const next = request.segments[index + 1];
      if (segment === 'customers' && next) ids.add(next.split(':')[0] as string);
    });
    // Field metadata and the list of accessible accounts name no account and reveal none of its data.
    const free = request.method === 'GET' && /^\/v[0-9]+\/(googleAdsFields(\/|:|$)|customers:listAccessibleCustomers$)/.test(request.path);
    if (!ids.size && !free) {
      throw new ToolFailure(
        `This request names none of the ${ACCOUNT}s chosen for this connection. `
          + (allowed.length ? `It must name one of: ${allowed.join(', ')}. Nothing was sent.` : `No ${ACCOUNT} is chosen for it yet. Nothing was sent.`),
      );
    }
    if (ids.size) requireAccounts(h.ctx.accounts, 'customers', [...ids], ACCOUNT);
  }
  if (request.method !== 'GET' && request.segments.some((segment) => /^(customerUserAccesses|customerUserAccessInvitations|customerManagerLinks|customerClientLinks)(:|$)/.test(segment))) {
    throw new ToolFailure(`Changing who can access a ${ACCOUNT}, or its manager links, is not offered here: do it in Google Ads, Admin, Access and security. Nothing was sent.`);
  }
}

/**
 * The generic tools, with a login_customer_id argument and search as the way
 * to check a change. api_request sends a JSON body only: Google Ads takes
 * nothing else, and a body sent as text would go out without the account
 * check reading it. The login-customer-id is settled when the request is
 * sent, after the account lock passed it.
 */
function genericTools(): ToolDefinition[] {
  return apiTools({
    label: LABEL,
    description:
      `The Google Ads API ${VERSION} REST interface at ${ADS_ORIGIN} with the connected account: paths start with `
      + `/${VERSION}/customers/{customer_id}, such as /${VERSION}/customers/{customer_id}/campaigns:mutate, recommendations:apply or `
      + 'recommendations:dismiss, offlineUserDataJobs:create, {customer_id}:uploadClickConversions or :uploadConversionAdjustments. '
      + 'Money is in micros (1 unit = 1000000). Reference: https://developers.google.com/google-ads/api/rest/overview.',
    basePath: `/${VERSION}/`,
    methods: ['POST'],
    guard: guardRequest,
  }).map((tool) => {
    const properties: NonNullable<ToolDefinition['inputSchema']['properties']> = { ...tool.inputSchema.properties, login_customer_id: LOGIN_CUSTOMER_ID };
    let description = tool.description;
    if (tool.name === 'api_request') {
      delete properties['body'];
      delete properties['content_type'];
      properties['json'] = { type: 'object', description: 'A JSON object to send as the body.' };
      description = description.replace(' or another body (body and content_type)', '').replace('check with api_get', 'check with search (GAQL)');
    }
    return {
      ...tool,
      ...(tool.name === 'api_request' ? { check: 'search' } : {}),
      description,
      inputSchema: { ...tool.inputSchema, properties },
      run: (args: Record<string, unknown>, h: ToolHelpers) => {
        const { login_customer_id: login, ...rest } = args;
        const api = async (request: ApiRequest) => {
          const resolved = await loginFor(h, customerOfPath(request.path), typeof login === 'string' ? login : undefined);
          return h.api({ ...request, headers: { ...request.headers, ...loginHeaders(resolved) } });
        };
        return tool.run(rest, { ...h, api });
      },
    };
  });
}

interface MutateArgs {
  customer_id: string;
  login_customer_id?: string;
  operations: Record<string, unknown>[];
  partial_failure?: boolean;
  validate_only?: boolean;
}

interface KeywordArgs {
  customer_id: string;
  login_customer_id?: string;
  keywords?: string[];
  url?: string;
  site?: string;
  language: string;
  geo_target_constants?: string[];
  keyword_plan_network: string;
  include_adult_keywords?: boolean;
  page_size: number;
  cursor?: string;
}

interface MatchArgs {
  customer_id: string;
  login_customer_id?: string;
  user_list: string;
  operation: 'add' | 'remove';
  emails?: string[];
  phones?: string[];
  hashed_emails?: string[];
  hashed_phones?: string[];
  ad_user_data_consent?: 'GRANTED' | 'DENIED';
  ad_personalization_consent?: 'GRANTED' | 'DENIED';
}

const connector = defineConnector({
  vendor: 'google-ads',
  label: LABEL,
  origins: [ADS_ORIGIN],
  credentials: ['access_token', 'developertoken', 'managercustomerid'],
  requiredCredentials: [['access_token']],
  credentialLabels: {
    access_token: 'Google Ads access token',
    developertoken: 'Google Ads developer token',
    managercustomerid: 'Google Ads manager account ID',
  },
  accountPickers: [
    {
      key: 'customers',
      label: 'Google Ads accounts',
      description: 'The Google Ads accounts the agent may report on and change.',
      multiple: true,
      tool: 'list_customers',
      idField: 'id',
      nameField: 'name',
      legacyField: 'customerid',
    },
  ],
  normalizeCredentials: (credentials) => {
    const manager = credentials['managercustomerid'] ? digits(credentials['managercustomerid']) : '';
    if (manager) credentials['managercustomerid'] = manager;
    else delete credentials['managercustomerid'];
    return credentials;
  },
  // No developer-token header: Google ignores it since 2026-09-09 and will refuse it in a later major version.
  // The login-customer-id goes on each request (loginFor).
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_customers',
      kind: 'read',
      title: 'List Google Ads accounts',
      description:
        'Lists the Google Ads accounts the connected Google account can open: those it has direct access to, and the client accounts (two '
        + 'levels deep) of each manager account among them. Each has its ID, name, status, currency, time zone, whether it is a manager, and '
        + 'for a client account the login_customer_id to act through. When the connection is limited to chosen accounts, those are marked '
        + 'selected: true, and only they can be used. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const start = typeof state?.['i'] === 'number' ? state['i'] : 0;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const chosen = allowedAccounts(h.ctx.accounts, 'customers');
        const selected = (id: string) => (chosen?.includes(id) ? true : undefined);
        const { data } = await h.api({ path: `/${VERSION}/customers:listAccessibleCustomers`, errors: ERRORS });
        const accessible = accessibleIds(data);
        const seen = new Set<string>(accessible);
        const customers: Record<string, unknown>[] = [];
        const managers: Array<[string, boolean]> = [];
        const clients: Array<[string, string]> = [];
        // A closed or suspended account answers with an error: it is listed as not accessible.
        const tryRead = async (customer: string, query: string, login: string): Promise<any[] | string> => {
          try {
            const page = await searchPage(h, customer, query, login);
            return Array.isArray(page?.results) ? page.results : [];
          } catch (error) {
            const status = error instanceof ToolFailure ? error.details.status : undefined;
            if (status === 400 || status === 403 || status === 404) return `HTTP ${status}`;
            throw error;
          }
        };
        for (const id of accessible.slice(start, start + PICKER_BATCH)) {
          const rows = await tryRead(id, CUSTOMER_QUERY, id);
          if (typeof rows === 'string') {
            customers.push(compact({ id, name: id, status: 'NOT_ACCESSIBLE', note: `Google Ads answered ${rows} for this account.`, selected: selected(id) }));
            continue;
          }
          const customer = rows[0]?.customer ?? {};
          managers.push([id, customer.manager === true]);
          customers.push(compact({
            id,
            name: typeof customer.descriptiveName === 'string' && customer.descriptiveName ? truncate(customer.descriptiveName, 200) : id,
            status: customer.status,
            manager: customer.manager === true,
            currency_code: customer.currencyCode,
            time_zone: customer.timeZone,
            test_account: customer.testAccount === true ? true : undefined,
            selected: selected(id),
          }));
          if (customer.manager !== true) continue;
          const found = await tryRead(id, CLIENTS_QUERY, id);
          if (typeof found === 'string') continue;
          for (const row of found) {
            const client = row?.customerClient ?? {};
            const clientId = client.id !== undefined ? String(client.id) : '';
            if (!/^[0-9]{10}$/.test(clientId) || seen.has(clientId)) continue;
            seen.add(clientId);
            clients.push([clientId, id]);
            customers.push(compact({
              id: clientId,
              name: typeof client.descriptiveName === 'string' && client.descriptiveName ? truncate(client.descriptiveName, 200) : clientId,
              status: client.status,
              manager: client.manager === true,
              currency_code: client.currencyCode,
              time_zone: client.timeZone,
              test_account: client.testAccount === true ? true : undefined,
              level: client.level !== undefined ? Number(client.level) : undefined,
              login_customer_id: id,
              selected: selected(clientId),
            }));
          }
        }
        // What was read tells later calls which manager account each client account is reached through.
        await rememberHierarchy(h, accessible, managers, clients);
        return h.page({
          key: 'customers',
          items: customers.slice(skip),
          extra: { accessible_accounts: accessible.length },
          resumeAt: (index) => h.makeCursor({ i: start, o: skip + index }),
          ...(start + PICKER_BATCH < accessible.length ? { nextPage: h.makeCursor({ i: start + PICKER_BATCH, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'search',
      kind: 'read',
      title: 'Search Google Ads with GAQL',
      description:
        'Runs a Google Ads Query Language query on one account, e.g. "SELECT campaign.id, campaign.name, metrics.clicks, metrics.cost_micros '
        + 'FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != REMOVED ORDER BY metrics.cost_micros DESC LIMIT 50". '
        + 'Rows come back flat, named like the query\'s fields; money is in micros (1 unit = 1000000) and counts are text. Google sends '
        + 'pages of 10,000 rows and a page over 8 MB cannot be read, so bound a query that can match more than a few thousand rows '
        + '(keywords, search terms, daily segments) with ORDER BY and LIMIT, or split it by segments.date or campaign.id. Pass nextCursor '
        + 'back as cursor with the same query for more. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: CUSTOMER_ID,
          query: { type: 'string', minLength: 10, maxLength: 20000, description: 'The GAQL query: SELECT fields FROM resource [WHERE ...] [ORDER BY ...] [LIMIT n].' },
          login_customer_id: LOGIN_CUSTOMER_ID,
          cursor: CURSOR,
        },
        required: ['customer_id', 'query'],
        additionalProperties: false,
      },
      async run(args: { customer_id: string; query: string; login_customer_id?: string; cursor?: string }, h) {
        const id = chosenCustomer(h, args.customer_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const login = await loginFor(h, id, args.login_customer_id);
        const data = await searchPage(h, id, args.query, login, pageToken);
        const rows = (Array.isArray(data?.results) ? data.results : []).map((row: unknown) => flattenRow(row));
        return h.page({
          key: 'rows',
          items: rows.slice(skip),
          extra: compact({ customer_id: id, field_mask: typeof data?.fieldMask === 'string' ? truncate(data.fieldMask, 2000) : undefined }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'mutate',
      kind: 'write',
      check: 'search',
      title: 'Change Google Ads resources',
      description:
        'Creates, updates or removes resources of one account in one atomic request (GoogleAdsService.Mutate): campaign budgets, campaigns, '
        + 'ad groups, ads, keywords and other criteria, assets and their links, user lists, conversion actions, bidding strategies, shared sets '
        + 'and more. Each operation is e.g. {"campaignOperation": {"update": {"resourceName": "customers/1234567890/campaigns/111", "status": '
        + '"PAUSED"}, "updateMask": "status"}}; new resources can refer to each other by negative IDs. validate_only checks without changing '
        + 'anything. Sent once, never retried.',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: CUSTOMER_ID,
          login_customer_id: LOGIN_CUSTOMER_ID,
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: { type: 'object' },
            description:
              'MutateOperation objects in the API\'s JSON (camelCase), e.g. campaignBudgetOperation, campaignOperation, adGroupOperation, '
              + 'adGroupAdOperation, adGroupCriterionOperation, campaignCriterionOperation, assetOperation, campaignAssetOperation, '
              + 'userListOperation, conversionActionOperation. Money is in micros; new campaigns are best created PAUSED.',
          },
          partial_failure: { type: 'boolean', description: 'Apply the valid operations even if others fail (default false: all or nothing).' },
          validate_only: { type: 'boolean', description: 'Check the operations and change nothing.' },
        },
        required: ['customer_id', 'operations'],
        additionalProperties: false,
      },
      async run(args: MutateArgs, h) {
        const id = chosenCustomer(h, args.customer_id);
        const named = customersIn(args.operations).filter((other) => other !== id);
        if (named.length) {
          requireAccounts(h.ctx.accounts, 'customers', named, ACCOUNT);
          throw new ToolFailure(`The operations name another account (${named.join(', ')}) than ${id}: every resource name must be under customers/${id}. Nothing was changed.`);
        }
        const login = await loginFor(h, id, args.login_customer_id);
        const { data } = await h.api({
          method: 'POST',
          path: `/${VERSION}/customers/${id}/googleAds:mutate`,
          headers: loginHeaders(login),
          json: compact({ mutateOperations: args.operations, partialFailure: args.partial_failure, validateOnly: args.validate_only }),
          write: !args.validate_only,
          errors: MUTATE_ERRORS,
        });
        const responses: any[] = Array.isArray(data?.mutateOperationResponses) ? data.mutateOperationResponses : [];
        const results = responses.map((response) => {
          const key = Object.keys(response ?? {})[0];
          const value = key ? response[key] : undefined;
          return key ? compact({ type: snake(key.replace(/Result$/, '')), resource_name: value?.resourceName }) : {};
        });
        return fitWriteResult(compact({
          customer_id: id,
          validate_only: args.validate_only ? true : undefined,
          results: args.validate_only ? undefined : results,
          valid: args.validate_only && !hasPartialFailure(data) ? true : undefined,
          failures: hasPartialFailure(data) ? failuresOf(data.partialFailureError) : undefined,
        }), 'results');
      },
    },
    {
      name: 'upload_image_asset',
      kind: 'create',
      check: 'search',
      title: 'Upload a Google Ads image asset',
      description:
        'Downloads a JPEG, PNG or GIF from a public https URL (up to 5,120 KB) and creates an image asset in one account. Returns its '
        + 'resource name, to use in ads (e.g. responsive display ads) or link with campaignAssetOperation or assetGroupAssetOperation through '
        + 'mutate. Recommended sizes: 1200x628 landscape, 1200x1200 square, 900x1600 portrait; no added text or logos on marketing images.',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: CUSTOMER_ID,
          login_customer_id: LOGIN_CUSTOMER_ID,
          image_url: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^https://', description: 'A public https URL of the image.' },
          name: { type: 'string', minLength: 1, maxLength: 128, description: 'A name for the asset, unique in the account, e.g. "Spring sale - landscape" (default: the image\'s file name and the time).' },
        },
        required: ['customer_id', 'image_url'],
        additionalProperties: false,
      },
      async run(args: { customer_id: string; login_customer_id?: string; image_url: string; name?: string }, h) {
        const id = chosenCustomer(h, args.customer_id);
        const media = await h.media(args.image_url, { what: 'image', maxBytes: MAX_IMAGE_BYTES, accept: 'image/jpeg,image/png,image/gif' });
        const type = imageType(media.bytes);
        if (!type) throw new ToolFailure('The image is not a JPEG, PNG or GIF file, the formats Google Ads takes. Nothing was changed.');
        const login = await loginFor(h, id, args.login_customer_id);
        const { data } = await h.api({
          method: 'POST',
          path: `/${VERSION}/customers/${id}/assets:mutate`,
          headers: loginHeaders(login),
          json: { operations: [{ create: { name: args.name ?? defaultAssetName(args.image_url), type: 'IMAGE', imageAsset: { data: base64(media.bytes) } } }] },
          write: true,
          errors: MUTATE_ERRORS,
        });
        const resourceName = data?.results?.[0]?.resourceName;
        if (typeof resourceName !== 'string') throw new OutcomeUnknown(`${LABEL} answered without the new asset's resource name, so it is not known whether the asset was created.`);
        return { customer_id: id, resource_name: resourceName, mime_type: type, bytes: media.bytes.length };
      },
    },
    {
      name: 'generate_keyword_ideas',
      kind: 'read',
      title: 'Get Google Ads keyword ideas',
      description:
        'Keyword Planner ideas for one account from seed keywords, a page URL, both, or a whole site: each idea with its average monthly '
        + 'searches, competition (LOW, MEDIUM, HIGH) and index (0 to 100), and the low and high top-of-page bids in micros. Language and '
        + 'locations are IDs: English is 1000; the United States 2840, the United Kingdom 2826, Germany 2276. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: CUSTOMER_ID,
          login_customer_id: LOGIN_CUSTOMER_ID,
          keywords: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 80 }, description: 'Seed keywords, e.g. ["trail running shoes"].' },
          url: { type: 'string', format: 'uri', maxLength: 2048, description: 'A page to draw ideas from, alone or with keywords.' },
          site: { type: 'string', pattern: '^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$', maxLength: 253, description: 'A whole site, e.g. "example.com", instead of keywords and url.' },
          language: { type: 'string', pattern: '^(languageConstants/)?[0-9]{1,6}$', default: '1000', description: 'A language ID or languageConstants/ID (default 1000, English).' },
          geo_target_constants: {
            type: 'array',
            maxItems: 10,
            uniqueItems: true,
            items: { type: 'string', pattern: '^(geoTargetConstants/)?[0-9]{1,12}$' },
            description: 'Location IDs or geoTargetConstants/ID, e.g. ["2840"]. None means everywhere.',
          },
          keyword_plan_network: { type: 'string', enum: ['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS'], default: 'GOOGLE_SEARCH', description: 'Where the searches are counted.' },
          include_adult_keywords: { type: 'boolean', description: 'Include adult keywords.' },
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Ideas per page, 1 to 1000 (default 50).' },
          cursor: CURSOR,
        },
        required: ['customer_id'],
        additionalProperties: false,
      },
      async run(args: KeywordArgs, h) {
        const id = chosenCustomer(h, args.customer_id);
        const keywords = args.keywords ?? [];
        if (args.site && (keywords.length || args.url)) throw new ToolFailure('Give site alone, or keywords and/or url. Nothing was sent.');
        if (!args.site && !keywords.length && !args.url) throw new ToolFailure('Give seed keywords, a url, both, or a site. Nothing was sent.');
        const seed = args.site
          ? { siteSeed: { site: args.site } }
          : keywords.length && args.url
            ? { keywordAndUrlSeed: { url: args.url, keywords } }
            : args.url
              ? { urlSeed: { url: args.url } }
              : { keywordSeed: { keywords } };
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const login = await loginFor(h, id, args.login_customer_id);
        const { data } = await h.api({
          method: 'POST',
          path: `/${VERSION}/customers/${id}:generateKeywordIdeas`,
          headers: loginHeaders(login),
          json: compact({
            language: `languageConstants/${args.language.replace(/^languageConstants\//, '')}`,
            geoTargetConstants: args.geo_target_constants?.length ? args.geo_target_constants.map((geo) => `geoTargetConstants/${geo.replace(/^geoTargetConstants\//, '')}`) : undefined,
            keywordPlanNetwork: args.keyword_plan_network,
            includeAdultKeywords: args.include_adult_keywords,
            pageSize: args.page_size,
            pageToken,
            ...seed,
          }),
          safe: true,
          errors: { ...ERRORS, 400: 'Google Ads did not accept the keyword request: check the language and location IDs and the seeds' },
        });
        const number = (value: unknown) => (value === undefined || value === null ? undefined : Number(value));
        const ideas = (Array.isArray(data?.results) ? data.results : []).map((idea: any) => compact({
          text: idea?.text,
          avg_monthly_searches: number(idea?.keywordIdeaMetrics?.avgMonthlySearches),
          competition: idea?.keywordIdeaMetrics?.competition,
          competition_index: number(idea?.keywordIdeaMetrics?.competitionIndex),
          low_top_of_page_bid_micros: idea?.keywordIdeaMetrics?.lowTopOfPageBidMicros,
          high_top_of_page_bid_micros: idea?.keywordIdeaMetrics?.highTopOfPageBidMicros,
        }));
        return h.page({
          key: 'ideas',
          items: ideas.slice(skip),
          extra: compact({ customer_id: id, total: number(data?.totalSize) }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'upload_customer_match',
      kind: 'write',
      check: 'search',
      title: 'Add or remove Google Ads Customer Match members',
      description:
        'Adds people to, or removes them from, a Customer Match user list (a CRM-based list with upload key type CONTACT_INFO) by email or '
        + 'phone: normalizes and hashes them with SHA-256 here, then creates an offline user data job, adds them and runs it. Up to 10,000 '
        + 'identifiers per call; matching takes up to 48 hours. Google only grants Customer Match uploads to Cloud projects that used them '
        + 'before April 2026. Returns the job to check with search.',
      inputSchema: {
        type: 'object',
        properties: {
          customer_id: CUSTOMER_ID,
          login_customer_id: LOGIN_CUSTOMER_ID,
          user_list: { type: 'string', pattern: '^(customers/[0-9]{10}/userLists/)?[0-9]{1,20}$', description: 'The user list ID or its resource name customers/{customer_id}/userLists/{id}.' },
          operation: { type: 'string', enum: ['add', 'remove'], default: 'add', description: 'add (default) or remove these people.' },
          ...IDENTIFIER_LISTS,
          ...HASHED_LISTS,
          ...CONSENT,
        },
        required: ['customer_id', 'user_list'],
        additionalProperties: false,
      },
      async run(args: MatchArgs, h) {
        const id = chosenCustomer(h, args.customer_id);
        const listMatch = /^customers\/([0-9]{10})\/userLists\/([0-9]+)$/.exec(args.user_list);
        if (listMatch && listMatch[1] !== id) throw new ToolFailure(`The user list belongs to another account than ${id}. Nothing was changed.`);
        const userList = `customers/${id}/userLists/${listMatch ? listMatch[2] : args.user_list}`;
        const total = identifierCount(args);
        if (!total) throw new ToolFailure('Give at least one email or phone number. Nothing was changed.');
        if (total > MAX_MATCH_IDENTIFIERS) throw new ToolFailure(`Give at most ${MAX_MATCH_IDENTIFIERS} identifiers per call (got ${total}). Nothing was changed.`);
        const hashed = await hashIdentifiers(args);
        const identifiers = [...hashed.emails.map((hash) => ({ hashedEmail: hash })), ...hashed.phones.map((hash) => ({ hashedPhoneNumber: hash }))];
        if (!identifiers.length) throw new ToolFailure('None of the emails or phone numbers is valid (phones need E.164 form, e.g. "+15551234567"). Nothing was changed.');
        const headers = loginHeaders(await loginFor(h, id, args.login_customer_id));
        const consent = compact({ adUserData: args.ad_user_data_consent, adPersonalization: args.ad_personalization_consent });

        const created = await h.api({
          method: 'POST',
          path: `/${VERSION}/customers/${id}/offlineUserDataJobs:create`,
          headers,
          json: { job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: compact({ userList, consent: Object.keys(consent).length ? consent : undefined }) } },
          write: true,
          errors: { ...MUTATE_ERRORS, 400: 'Google Ads did not accept the Customer Match job: check that the user list exists in this account and is a CRM-based list' },
        });
        const job = created.data?.resourceName;
        if (typeof job !== 'string' || !new RegExp(`^customers/${id}/offlineUserDataJobs/[0-9]+$`).test(job)) {
          throw new OutcomeUnknown(`${LABEL} answered without the new job's name, so it is not known whether a job was created.`);
        }
        const statusQuery = `SELECT offline_user_data_job.resource_name, offline_user_data_job.status, offline_user_data_job.failure_reason FROM offline_user_data_job WHERE offline_user_data_job.resource_name = '${job}'`;
        const verb = args.operation === 'remove' ? 'remove' : 'create';
        const added = await h.api({
          method: 'POST',
          path: `/${VERSION}/${job}:addOperations`,
          headers,
          json: { enablePartialFailure: true, operations: identifiers.map((identifier) => ({ [verb]: { userIdentifiers: [identifier] } })) },
          write: true,
          errors: MUTATE_ERRORS,
        });
        let operationName: unknown;
        try {
          const ran = await h.api({ method: 'POST', path: `/${VERSION}/${job}:run`, headers, json: {}, write: true, errors: MUTATE_ERRORS });
          operationName = ran.data?.name;
        } catch (error) {
          if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${error.message} The job is ${job}; check its status with: ${statusQuery}.`);
          throw error;
        }
        return compact({
          customer_id: id,
          user_list: userList,
          operation: args.operation,
          job,
          long_running_operation: typeof operationName === 'string' ? operationName : undefined,
          identifiers_sent: identifiers.length,
          skipped_emails: skippedSummary(hashed.skippedEmails),
          skipped_phones: skippedSummary(hashed.skippedPhones),
          failures: hasPartialFailure(added.data) ? failuresOf(added.data.partialFailureError) : undefined,
          status_query: statusQuery,
          note: 'The job runs in the background; matching can take up to 48 hours. Run status_query with search to follow it.',
        });
      },
    },
    {
      name: 'hash_user_identifiers',
      kind: 'read',
      title: 'Hash emails and phones for Google Ads',
      description:
        'Normalizes emails (trimmed, lower case, and for gmail.com and googlemail.com no dots and no +suffix in the name) and E.164 phone '
        + 'numbers the way Google Ads requires and hashes them with SHA-256, for the hashedEmail and hashedPhoneNumber user identifiers of '
        + 'enhanced conversions or Customer Match sent with api_request. Sends nothing anywhere.',
      inputSchema: {
        type: 'object',
        properties: {
          emails: { ...IDENTIFIER_LISTS.emails, maxItems: 200, description: 'Up to 200 email addresses in plain text.' },
          phones: { ...IDENTIFIER_LISTS.phones, maxItems: 200, description: 'Up to 200 phone numbers in E.164 form, e.g. "+15551234567".' },
        },
        additionalProperties: false,
      },
      async run(args: { emails?: string[]; phones?: string[] }) {
        if (!(args.emails?.length || args.phones?.length)) throw new ToolFailure('Give at least one email or phone number.');
        // One hash per input, in the same order; null for an input that is not a valid email or E.164 number.
        const hashAll = async (list: string[] | undefined, normalize: (raw: string) => string | undefined) => {
          const out: (string | null)[] = [];
          for (const raw of list ?? []) {
            const normalized = normalize(raw);
            out.push(normalized ? await sha256Hex(normalized) : null);
          }
          return out;
        };
        const emails = await hashAll(args.emails, normalizeEmail);
        const phones = await hashAll(args.phones, normalizePhone);
        const invalid = (list: (string | null)[]) => list.flatMap((hash, index) => (hash === null ? [index] : []));
        return compact({
          hashed_emails: emails.length ? emails : undefined,
          hashed_phone_numbers: phones.length ? phones : undefined,
          invalid_emails: invalid(emails).length ? invalid(emails) : undefined,
          invalid_phones: invalid(phones).length ? invalid(phones) : undefined,
        });
      },
    },
    // The rest of the API: recommendations, conversion uploads, keyword plans, batch jobs, field metadata.
    ...genericTools(),
  ],
});

export = connector;
