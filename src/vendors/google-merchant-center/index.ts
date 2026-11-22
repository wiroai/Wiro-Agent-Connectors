// Google Merchant Center, through the Merchant API v1 on
// https://merchantapi.googleapis.com (sub-APIs: accounts, products,
// datasources, reports, issueresolution, promotions, inventories).
//
// Credential: `access_token`, a Google OAuth access token with the scope
// https://www.googleapis.com/auth/content, from an OAuth client in the user's
// own Google Cloud project (registered once with Merchant Center, see the
// README). The host signs in, refreshes the token and passes the current one.
//
// Account picker `accounts` (the Merchant Center accounts the agent may use):
// every tool that names an account checks it against ctx.accounts.accounts.

import {
  apiTools,
  base64UrlEncode,
  defineConnector,
  requireAccounts,
  ToolFailure,
  truncate,
  utf8Bytes,
  type ApiToolRequest,
  type ToolHelpers,
} from '../../core/index.js';

const LABEL = 'Google Merchant Center';
const ACCOUNT = 'Merchant Center account';

const ACCOUNT_ID = { type: 'string' as const, pattern: '^(accounts/)?[0-9]{1,20}$', description: 'The Merchant Center account ID, digits only (list_accounts lists them).' };
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const DATA_SOURCE = {
  type: 'string' as const,
  pattern: '^(accounts/[0-9]{1,20}/dataSources/)?[0-9]{1,20}$',
  description: 'The API data source the product input belongs to: its ID or its name accounts/{account_id}/dataSources/{id} (list_data_sources lists them; only API data sources take writes).',
};
const PRODUCT_KEY = {
  offer_id: { type: 'string' as const, minLength: 1, maxLength: 150, description: 'The product\'s offer ID (your SKU), e.g. "SKU123".' },
  content_language: { type: 'string' as const, pattern: '^[a-z]{2,3}$', description: 'The two-letter ISO 639-1 language of the product data, e.g. "en".' },
  feed_label: { type: 'string' as const, pattern: '^[A-Za-z0-9_-]{1,20}$', description: 'The feed label, often a country code, e.g. "US".' },
  legacy_local: { type: 'boolean' as const, description: 'true for a local-only product (its name starts with local~).' },
};
const PRODUCT_ATTRIBUTES_HELP =
  'Product attributes in the Merchant API\'s JSON (camelCase), e.g. {"title": "Running Shoes", "description": "...", "link": "https://example.com/p/SKU123", '
  + '"imageLink": "https://example.com/i/SKU123.jpg", "availability": "IN_STOCK", "condition": "NEW", "price": {"amountMicros": "129990000", "currencyCode": "USD"}, '
  + '"brand": "Example", "gtins": ["01234567890123"]}. Prices are micros: 19.99 is "19990000". Enums are upper case: IN_STOCK, OUT_OF_STOCK, PREORDER, BACKORDER; NEW, REFURBISHED, USED.';
const CUSTOM_ATTRIBUTES = {
  type: 'array' as const,
  maxItems: 50,
  items: { type: 'object' as const },
  description: 'Custom attributes, e.g. [{"name": "season", "value": "winter"}].',
};

interface ProductKey {
  account_id: string;
  offer_id: string;
  content_language: string;
  feed_label: string;
  legacy_local?: boolean;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function accountId(value: string): string {
  return value.replace(/^accounts\//, '');
}

function chosenAccount(h: ToolHelpers, value: string): string {
  const id = accountId(value);
  requireAccounts(h.ctx.accounts, 'accounts', id, ACCOUNT);
  return id;
}

/** The product's ID as Google recommends it: contentLanguage~feedLabel~offerId, unpadded base64url. */
function productId(key: ProductKey): string {
  const plain = `${key.legacy_local ? 'local~' : ''}${key.content_language}~${key.feed_label}~${key.offer_id}`;
  return base64UrlEncode(utf8Bytes(plain));
}

/** The data source name for an account, refusing one of another account. */
function dataSourceName(account: string, value: string): string {
  const match = /^accounts\/([0-9]+)\/dataSources\/([0-9]+)$/.exec(value);
  if (match && match[1] !== account) {
    throw new ToolFailure(`The data source ${value} belongs to another account than ${account}. Nothing was sent.`);
  }
  return `accounts/${account}/dataSources/${match ? match[2] : value}`;
}

function money(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const micros = Number(value.amountMicros);
  return compact({
    amount: Number.isFinite(micros) ? micros / 1_000_000 : undefined,
    amount_micros: value.amountMicros,
    currency_code: value.currencyCode,
  });
}

function trimStatus(status: any, full: boolean): Record<string, unknown> | undefined {
  if (!status || typeof status !== 'object') return undefined;
  const destinations = Array.isArray(status.destinationStatuses)
    ? status.destinationStatuses.map((item: any) => compact({
      reporting_context: item?.reportingContext,
      approved: item?.approvedCountries?.length ? item.approvedCountries : undefined,
      pending: item?.pendingCountries?.length ? item.pendingCountries : undefined,
      disapproved: item?.disapprovedCountries?.length ? item.disapprovedCountries : undefined,
    }))
    : undefined;
  const issues = Array.isArray(status.itemLevelIssues)
    ? status.itemLevelIssues.map((issue: any) => compact({
      code: issue?.code,
      severity: issue?.severity,
      resolution: issue?.resolution,
      attribute: issue?.attribute,
      reporting_context: issue?.reportingContext,
      description: issue?.description,
      detail: full && typeof issue?.detail === 'string' ? truncate(issue.detail, 500) : undefined,
      documentation: full ? issue?.documentation : undefined,
      countries: issue?.applicableCountries?.length ? issue.applicableCountries : undefined,
    }))
    : undefined;
  return compact({
    destinations: destinations?.length ? destinations : undefined,
    issues: issues?.length ? issues : undefined,
    created: full ? status.creationDate : undefined,
    last_updated: full ? status.lastUpdateDate : undefined,
    expires: full ? status.googleExpirationDate : undefined,
  });
}

/** The fields of a processed product an agent needs in a list. */
function trimProduct(product: any): Record<string, unknown> {
  const attributes = product?.productAttributes ?? {};
  return compact({
    name: product?.name,
    offer_id: product?.offerId,
    content_language: product?.contentLanguage,
    feed_label: product?.feedLabel,
    legacy_local: product?.legacyLocal === true ? true : undefined,
    data_source: product?.dataSource,
    title: typeof attributes.title === 'string' ? truncate(attributes.title, 200) : undefined,
    link: attributes.link,
    image_link: attributes.imageLink,
    price: money(attributes.price),
    sale_price: money(attributes.salePrice),
    availability: attributes.availability,
    condition: attributes.condition,
    brand: attributes.brand,
    gtins: attributes.gtins ?? (attributes.gtin ? [attributes.gtin] : undefined),
    status: trimStatus(product?.productStatus, false),
  });
}

/** Long attribute texts cut, everything else as the API sent it. */
function fullAttributes(attributes: any): Record<string, unknown> | undefined {
  if (!attributes || typeof attributes !== 'object') return undefined;
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, typeof value === 'string' ? truncate(value, 1500) : value]));
}

function trimInput(input: any): Record<string, unknown> {
  return compact({
    name: input?.name,
    product: input?.product,
    offer_id: input?.offerId,
    content_language: input?.contentLanguage,
    feed_label: input?.feedLabel,
    legacy_local: input?.legacyLocal === true ? true : undefined,
    version_number: input?.versionNumber,
  });
}

function trimDataSource(source: any): Record<string, unknown> {
  const kinds: Record<string, string> = {
    primaryProductDataSource: 'primary_product',
    supplementalProductDataSource: 'supplemental_product',
    localInventoryDataSource: 'local_inventory',
    regionalInventoryDataSource: 'regional_inventory',
    promotionDataSource: 'promotion',
    productReviewDataSource: 'product_review',
    merchantReviewDataSource: 'merchant_review',
  };
  const kind = Object.keys(kinds).find((key) => source?.[key]);
  const details = kind ? source[kind] : {};
  return compact({
    id: source?.dataSourceId,
    name: source?.name,
    display_name: source?.displayName,
    input: source?.input,
    type: kind ? kinds[kind] : undefined,
    feed_label: details?.feedLabel,
    content_language: details?.contentLanguage,
    countries: details?.countries?.length ? details.countries : undefined,
    legacy_local: details?.legacyLocal === true ? true : undefined,
    file: source?.fileInput ? compact({ name: source.fileInput.fileName, fetch_uri: source.fileInput.fetchSettings?.fetchUri }) : undefined,
  });
}

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** A report row as flat snake_case fields, e.g. {"offer_id": "SKU1", "price.amount_micros": "1990000"}. */
function flattenRow(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flattenRow(item, prefix ? `${prefix}.${snake(key)}` : snake(key), out);
  } else if (prefix) {
    out[prefix] = typeof value === 'string' ? truncate(value, 1000) : value;
  }
  return out;
}

/** The account IDs a generic request names: in its path, and in a dataSource name in its query or body. */
function accountsNamed(request: ApiToolRequest): string[] {
  const ids = new Set<string>();
  // The first two segments are the sub-API and its version: /accounts/v1/accounts/{id}/...
  request.segments.forEach((segment, index) => {
    const next = request.segments[index + 1];
    if (index >= 2 && segment === 'accounts' && next) ids.add(next.split(':')[0] as string);
  });
  const sources = [...(request.query['dataSource'] ?? []), typeof request.json?.['dataSource'] === 'string' ? request.json['dataSource'] : ''];
  for (const source of sources) {
    const match = /^accounts\/([0-9]+)\//.exec(String(source));
    if (match) ids.add(match[1] as string);
  }
  return [...ids].filter(Boolean);
}

/** Endpoints the generic tools keep out of reach: deleting a whole account and managing its users. */
function guardRequest(request: ApiToolRequest): void {
  if (!/^\/[a-z_]+\/v1(alpha|beta)?\//.test(request.path)) {
    throw new ToolFailure('The path must start with a sub-API and its version, e.g. /accounts/v1/ or /products/v1/. Nothing was sent.');
  }
  if (request.method === 'GET') return;
  if (request.segments.some((segment) => segment === 'users' || segment.startsWith('users:'))) {
    throw new ToolFailure(`Managing the users of a ${ACCOUNT} is not offered here: do it in Merchant Center, Settings, People and access. Nothing was sent.`);
  }
  if (request.method === 'DELETE' && request.segments.length === 4 && request.segments[2] === 'accounts') {
    throw new ToolFailure(`Deleting a whole ${ACCOUNT} is not offered here: do it in Merchant Center. Nothing was sent.`);
  }
}

// A project that is not registered with the account gets HTTP 401 with Google's own explanation.
const UNAUTHORIZED = {
  401: 'Google Merchant Center did not accept the access token, or the Google Cloud project of its OAuth client is not registered with this account yet (register it once: see the connector\'s README)',
};

const PRODUCT_ERRORS = {
  ...UNAUTHORIZED,
  400: 'Google Merchant Center did not accept the product: check the attribute names (camelCase, inside productAttributes), the upper-case enums and that prices are in micros',
  403: 'Google Merchant Center refused the request: the connected Google account has no access to this account, or its Google Cloud project is not registered with Merchant Center (see the connector\'s README)',
  404: 'Google Merchant Center found no such product input in that data source, or no such data source',
};

const connector = defineConnector({
  vendor: 'google-merchant-center',
  label: LABEL,
  origins: ['https://merchantapi.googleapis.com'],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Google Merchant Center access token' },
  accountPickers: [
    {
      key: 'accounts',
      label: 'Merchant Center accounts',
      description: 'The Merchant Center accounts the agent may read and change.',
      multiple: true,
      tool: 'list_accounts',
      idField: 'id',
      nameField: 'name',
      legacyField: 'merchantid',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_accounts',
      kind: 'read',
      title: 'List Merchant Center accounts',
      description:
        'Lists the Merchant Center accounts the connected Google account can open (standalone, advanced and sub-accounts): account ID, name, '
        + 'time zone and language. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: '/accounts/v1/accounts', query: { pageSize: 250, pageToken }, errors: UNAUTHORIZED });
        const accounts = (Array.isArray(data?.accounts) ? data.accounts : []).map((account: any) => {
          const id = account?.accountId ?? (typeof account?.name === 'string' ? accountId(account.name) : undefined);
          return compact({
            id,
            name: typeof account?.accountName === 'string' ? truncate(account.accountName, 200) : id,
            time_zone: account?.timeZone?.id,
            language: account?.languageCode,
            adult_content: account?.adultContent === true ? true : undefined,
            test_account: account?.testAccount === true ? true : undefined,
          });
        });
        return h.page({
          key: 'accounts',
          items: accounts.slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'list_products',
      kind: 'read',
      title: 'List Merchant Center products',
      description:
        'Lists the processed products of one account (the final data after every data source and rule): offer ID, language, feed label, '
        + 'title, link, price, availability, brand, and the status per destination (approved, pending and disapproved countries) with item '
        + 'issues. For counts of issues across the catalog, summarize_product_statuses is cheaper. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Products per page, 1 to 1000 (default 50).' },
          cursor: CURSOR,
        },
        required: ['account_id'],
        additionalProperties: false,
      },
      async run(args: { account_id: string; page_size: number; cursor?: string }, h) {
        const id = chosenAccount(h, args.account_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: `/products/v1/accounts/${id}/products`, query: { pageSize: args.page_size, pageToken }, errors: { ...UNAUTHORIZED, 403: PRODUCT_ERRORS[403] } });
        const products = (Array.isArray(data?.products) ? data.products : []).map(trimProduct);
        return h.page({
          key: 'products',
          items: products.slice(skip),
          extra: { account_id: id },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_product',
      kind: 'read',
      title: 'Get a Merchant Center product',
      description:
        'Gets one processed product by offer ID, language and feed label: every attribute, custom attributes, the data source, and the full '
        + 'status per destination with each item issue\'s detail and help link. A product inserted moments ago can take a few minutes to appear.',
      inputSchema: {
        type: 'object',
        properties: { account_id: ACCOUNT_ID, ...PRODUCT_KEY },
        required: ['account_id', 'offer_id', 'content_language', 'feed_label'],
        additionalProperties: false,
      },
      async run(args: ProductKey, h) {
        const id = chosenAccount(h, args.account_id);
        const { data } = await h.api({
          path: `/products/v1/accounts/${id}/products/${productId(args)}`,
          errors: { ...UNAUTHORIZED, 403: PRODUCT_ERRORS[403], 404: 'Google Merchant Center has no processed product with that offer ID, language and feed label (a new one can take a few minutes)' },
        });
        return compact({
          ...trimProduct(data),
          version_number: data?.versionNumber,
          attributes: fullAttributes(data?.productAttributes),
          custom_attributes: Array.isArray(data?.customAttributes) && data.customAttributes.length ? data.customAttributes.slice(0, 50) : undefined,
          status: trimStatus(data?.productStatus, true),
        });
      },
    },
    {
      name: 'insert_product',
      kind: 'update',
      check: 'get_product',
      title: 'Insert or replace a Merchant Center product',
      description:
        'Inserts a product input into an API data source of one account, or replaces the input with the same offer ID, language and feed label '
        + 'in that data source. Merchant Center then processes it into the product (a few minutes). Needs an API data source: list_data_sources, '
        + 'or create_data_source. Returns the input\'s name and the product\'s.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          data_source: DATA_SOURCE,
          ...PRODUCT_KEY,
          product_attributes: { type: 'object', description: PRODUCT_ATTRIBUTES_HELP },
          custom_attributes: CUSTOM_ATTRIBUTES,
        },
        required: ['account_id', 'data_source', 'offer_id', 'content_language', 'feed_label', 'product_attributes'],
        additionalProperties: false,
      },
      async run(args: ProductKey & { data_source: string; product_attributes: Record<string, unknown>; custom_attributes?: Record<string, unknown>[] }, h) {
        const id = chosenAccount(h, args.account_id);
        const { data } = await h.api({
          method: 'POST',
          path: `/products/v1/accounts/${id}/productInputs:insert`,
          query: { dataSource: dataSourceName(id, args.data_source) },
          json: compact({
            offerId: args.offer_id,
            contentLanguage: args.content_language,
            feedLabel: args.feed_label,
            legacyLocal: args.legacy_local,
            productAttributes: args.product_attributes,
            customAttributes: args.custom_attributes?.length ? args.custom_attributes : undefined,
          }),
          write: true,
          errors: PRODUCT_ERRORS,
        });
        return { ...trimInput(data), note: 'Merchant Center processes the input into the product within a few minutes; check it with get_product.' };
      },
    },
    {
      name: 'update_product',
      kind: 'update',
      check: 'get_product',
      title: 'Update a Merchant Center product',
      description:
        'Changes some attributes of a product input in an API data source, leaving the others as they are: give the attributes to set, and '
        + 'remove_attributes to clear (e.g. "salePrice"). The change stays until that input is changed again, even if a feed is uploaded. '
        + 'Returns the updated input.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          data_source: DATA_SOURCE,
          ...PRODUCT_KEY,
          product_attributes: { type: 'object', description: `The attributes to set; only these change. ${PRODUCT_ATTRIBUTES_HELP}` },
          custom_attributes: { ...CUSTOM_ATTRIBUTES, description: 'Custom attributes to set, by name, e.g. [{"name": "season", "value": "winter"}].' },
          remove_attributes: {
            type: 'array',
            maxItems: 50,
            uniqueItems: true,
            items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' },
            description: 'Attribute names to clear, e.g. ["salePrice", "salePriceEffectiveDate"].',
          },
        },
        required: ['account_id', 'data_source', 'offer_id', 'content_language', 'feed_label'],
        additionalProperties: false,
      },
      async run(args: ProductKey & { data_source: string; product_attributes?: Record<string, unknown>; custom_attributes?: Record<string, unknown>[]; remove_attributes?: string[] }, h) {
        const id = chosenAccount(h, args.account_id);
        const attributes = args.product_attributes ?? {};
        const custom = args.custom_attributes ?? [];
        const removed = (args.remove_attributes ?? []).filter((name) => !(name in attributes));
        const customNames = custom.map((item) => item?.['name']);
        if (customNames.some((name) => typeof name !== 'string' || !name)) {
          throw new ToolFailure('Each custom attribute needs a name. Nothing was changed.');
        }
        const mask = [
          ...Object.keys(attributes).map((name) => `productAttributes.${name}`),
          ...removed.map((name) => `productAttributes.${name}`),
          ...customNames.map((name) => `custom_attribute.${name as string}`),
        ];
        if (!mask.length) throw new ToolFailure('Nothing to change: give product_attributes, custom_attributes or remove_attributes. Nothing was changed.');
        const { data } = await h.api({
          method: 'PATCH',
          path: `/products/v1/accounts/${id}/productInputs/${productId(args)}`,
          query: { dataSource: dataSourceName(id, args.data_source), updateMask: mask.join(',') },
          json: compact({ productAttributes: attributes, customAttributes: custom.length ? custom : undefined }),
          write: true,
          errors: PRODUCT_ERRORS,
        });
        return { ...trimInput(data), updated: mask };
      },
    },
    {
      name: 'delete_product',
      kind: 'delete',
      check: 'get_product',
      title: 'Delete a Merchant Center product',
      description:
        'Deletes a product input from an API data source. The product disappears once no other data source provides it (a few minutes).',
      inputSchema: {
        type: 'object',
        properties: { account_id: ACCOUNT_ID, data_source: DATA_SOURCE, ...PRODUCT_KEY },
        required: ['account_id', 'data_source', 'offer_id', 'content_language', 'feed_label'],
        additionalProperties: false,
      },
      async run(args: ProductKey & { data_source: string }, h) {
        const id = chosenAccount(h, args.account_id);
        await h.api({
          method: 'DELETE',
          path: `/products/v1/accounts/${id}/productInputs/${productId(args)}`,
          query: { dataSource: dataSourceName(id, args.data_source) },
          write: true,
          errors: PRODUCT_ERRORS,
        });
        return { deleted: true, account_id: id, offer_id: args.offer_id, content_language: args.content_language, feed_label: args.feed_label };
      },
    },
    {
      name: 'list_data_sources',
      kind: 'read',
      title: 'List Merchant Center data sources',
      description:
        'Lists the data sources of one account: ID, display name, input (API, FILE, UI, AUTOFEED), type (primary or supplemental product, '
        + 'inventory, promotion, review), feed label, language and countries. Product writes need an API primary or supplemental product source.',
      inputSchema: { type: 'object', properties: { account_id: ACCOUNT_ID, cursor: CURSOR }, required: ['account_id'], additionalProperties: false },
      async run(args: { account_id: string; cursor?: string }, h) {
        const id = chosenAccount(h, args.account_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: `/datasources/v1/accounts/${id}/dataSources`, query: { pageSize: 100, pageToken }, errors: UNAUTHORIZED });
        const sources = (Array.isArray(data?.dataSources) ? data.dataSources : []).map(trimDataSource);
        return h.page({
          key: 'data_sources',
          items: sources.slice(skip),
          extra: { account_id: id },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'create_data_source',
      kind: 'create',
      check: 'list_data_sources',
      title: 'Create a Merchant Center API data source',
      description:
        'Creates a primary product data source of input type API in one account, the kind insert_product writes to. With a feed label and '
        + 'a language (both or neither), it only takes products with that pair. Returns its ID and name.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          display_name: { type: 'string', minLength: 1, maxLength: 150, description: 'A name shown in Merchant Center, e.g. "Agent API feed".' },
          feed_label: PRODUCT_KEY.feed_label,
          content_language: PRODUCT_KEY.content_language,
          countries: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[A-Z]{2}$' }, description: 'Where the products may show, as CLDR codes, e.g. ["US"].' },
          legacy_local: { type: 'boolean', description: 'true for a source of local-only products.' },
        },
        required: ['account_id', 'display_name'],
        additionalProperties: false,
      },
      async run(args: { account_id: string; display_name: string; feed_label?: string; content_language?: string; countries?: string[]; legacy_local?: boolean }, h) {
        const id = chosenAccount(h, args.account_id);
        if (Boolean(args.feed_label) !== Boolean(args.content_language)) {
          throw new ToolFailure('Give feed_label and content_language together, or neither. Nothing was changed.');
        }
        const { data } = await h.api({
          method: 'POST',
          path: `/datasources/v1/accounts/${id}/dataSources`,
          json: {
            displayName: args.display_name,
            primaryProductDataSource: compact({
              feedLabel: args.feed_label,
              contentLanguage: args.content_language,
              countries: args.countries?.length ? args.countries : undefined,
              legacyLocal: args.legacy_local,
            }),
          },
          write: true,
          errors: UNAUTHORIZED,
        });
        return trimDataSource(data);
      },
    },
    {
      name: 'list_account_issues',
      kind: 'read',
      title: 'List Merchant Center account issues',
      description:
        'Lists the account-level issues of one account, such as an unverified website or missing tax or shipping settings: title, severity '
        + '(CRITICAL, ERROR, SUGGESTION), the destinations and regions affected, detail and help link. On an advanced account it lists the '
        + 'parent\'s own issues only.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          language_code: { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$', description: 'The language of the texts, e.g. "en-US" (default).' },
          time_zone: { type: 'string', maxLength: 64, description: 'The IANA time zone for times in the texts, e.g. "America/Los_Angeles" (default).' },
          cursor: CURSOR,
        },
        required: ['account_id'],
        additionalProperties: false,
      },
      async run(args: { account_id: string; language_code?: string; time_zone?: string; cursor?: string }, h) {
        const id = chosenAccount(h, args.account_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({ path: `/accounts/v1/accounts/${id}/issues`, query: { pageSize: 100, pageToken, languageCode: args.language_code, timeZone: args.time_zone }, errors: UNAUTHORIZED });
        const issues = (Array.isArray(data?.accountIssues) ? data.accountIssues : []).map((issue: any) => compact({
          title: issue?.title,
          severity: issue?.severity,
          impacted: Array.isArray(issue?.impactedDestinations)
            ? issue.impactedDestinations.map((item: any) => compact({
              reporting_context: item?.reportingContext,
              regions: Array.isArray(item?.impacts) ? item.impacts.map((impact: any) => compact({ region: impact?.regionCode, severity: impact?.severity })) : undefined,
            }))
            : undefined,
          detail: typeof issue?.detail === 'string' ? truncate(issue.detail, 600) : undefined,
          documentation: issue?.documentationUri,
        }));
        return h.page({
          key: 'issues',
          items: issues.slice(skip),
          extra: { account_id: id },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'summarize_product_statuses',
      kind: 'read',
      title: 'Summarize Merchant Center product statuses',
      description:
        'Counts the products of one account per destination and country: active, pending, disapproved and expiring, with each item issue '
        + '(code, severity, resolution, attribute, description) and how many products it affects. The cheapest feed health check: no paging '
        + 'through products. Standalone and sub-accounts only.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          reporting_context: { type: 'string', pattern: '^[A-Z_]{2,60}$', description: 'Only this destination, e.g. "SHOPPING_ADS" or "FREE_LISTINGS".' },
          country: { type: 'string', pattern: '^[A-Z]{2}$', description: 'Only this country, as a CLDR code, e.g. "US".' },
          cursor: CURSOR,
        },
        required: ['account_id'],
        additionalProperties: false,
      },
      async run(args: { account_id: string; reporting_context?: string; country?: string; cursor?: string }, h) {
        const id = chosenAccount(h, args.account_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const filter = [
          args.reporting_context ? `reportingContext = "${args.reporting_context}"` : '',
          args.country ? `country = "${args.country}"` : '',
        ].filter(Boolean).join(' AND ');
        const { data } = await h.api({ path: `/issueresolution/v1/accounts/${id}/aggregateProductStatuses`, query: { pageSize: 250, pageToken, filter: filter || undefined }, errors: UNAUTHORIZED });
        const count = (value: unknown) => (value === undefined ? 0 : Number(value));
        const buckets = (Array.isArray(data?.aggregateProductStatuses) ? data.aggregateProductStatuses : []).map((item: any) => compact({
          reporting_context: item?.reportingContext,
          country: item?.country,
          active: count(item?.stats?.activeCount),
          pending: count(item?.stats?.pendingCount),
          disapproved: count(item?.stats?.disapprovedCount),
          expiring: count(item?.stats?.expiringCount),
          issues: Array.isArray(item?.itemLevelIssues) && item.itemLevelIssues.length
            ? item.itemLevelIssues.map((issue: any) => compact({
              code: issue?.code,
              severity: issue?.severity,
              resolution: issue?.resolution,
              attribute: issue?.attribute,
              description: issue?.description,
              products: count(issue?.productCount),
              documentation: issue?.documentationUri,
            }))
            : undefined,
        }));
        return h.page({
          key: 'statuses',
          items: buckets.slice(skip),
          extra: { account_id: id },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'search_reports',
      kind: 'read',
      title: 'Search Merchant Center reports',
      description:
        'Runs a Merchant Center Query Language report on one account, e.g. "SELECT offer_id, title, clicks, impressions, click_through_rate '
        + 'FROM product_performance_view WHERE date DURING LAST_30_DAYS ORDER BY clicks DESC LIMIT 50". Views include product_performance_view, '
        + 'product_view, price_competitiveness_product_view, price_insights_product_view, best_sellers_product_cluster_view and '
        + 'competitive_visibility_*_view; fields are snake_case without prefixes. Rows come back flat. It changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: ACCOUNT_ID,
          query: { type: 'string', minLength: 10, maxLength: 10000, description: 'The query, SELECT ... FROM <view> [WHERE ...] [ORDER BY ...] [LIMIT n].' },
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Rows per page, 1 to 1000 (default 100).' },
          cursor: CURSOR,
        },
        required: ['account_id', 'query'],
        additionalProperties: false,
      },
      async run(args: { account_id: string; query: string; page_size: number; cursor?: string }, h) {
        const id = chosenAccount(h, args.account_id);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await h.api({
          method: 'POST',
          path: `/reports/v1/accounts/${id}/reports:search`,
          json: compact({ query: args.query, pageSize: args.page_size, pageToken }),
          safe: true,
          errors: { ...UNAUTHORIZED, 400: 'Google Merchant Center did not accept the query: check the view and the snake_case field names' },
        });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        const view = results.length ? Object.keys(results[0] ?? {})[0] : undefined;
        const rows = results.map((result) => {
          const key = Object.keys(result ?? {})[0];
          return key ? flattenRow(result[key]) : {};
        });
        return h.page({
          key: 'rows',
          items: rows.slice(skip),
          extra: compact({ account_id: id, view: view ? snake(view) : undefined }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    // The rest of the Merchant API: business info, homepage, shipping settings,
    // promotions, inventories, sub-accounts.
    ...apiTools({
      label: LABEL,
      description:
        'The Merchant API at https://merchantapi.googleapis.com with the connected account. Each sub-API has its own path and version, e.g. '
        + '/accounts/v1/accounts/{account_id}/businessInfo, /homepage, /homepage:claim, /shippingSettings, /shippingSettings:insert, '
        + ':listSubaccounts; /promotions/v1/accounts/{account_id}/promotions:insert; /inventories/v1/accounts/{account_id}/products/{product}/localInventories. '
        + 'Prices are {"amountMicros", "currencyCode"}. Reference: https://developers.google.com/merchant/api/reference/rest.',
      methods: ['POST', 'PATCH', 'DELETE'],
      accounts: { key: 'accounts', label: ACCOUNT, ids: accountsNamed },
      guard: (request) => guardRequest(request),
    }),
  ],
});

export = connector;
