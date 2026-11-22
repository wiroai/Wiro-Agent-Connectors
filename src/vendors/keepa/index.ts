// Keepa: Amazon price, sales rank and offer history (https://keepa.com),
// through the Keepa API at https://api.keepa.com. Read only: nothing on
// Keepa or Amazon changes.
//
// Credential: `apikey`, the 64-character API access key from the Keepa API
// page (https://keepa.com/#!api), on a paid Keepa API plan. Keepa takes it
// only as the `key` query parameter. Every call spends Keepa tokens from the
// plan, and every result reports the tokens left.

import { apiTools, defineConnector, ToolFailure, type ApiRequest, type ApiResponse, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import {
  briefProduct,
  categoryList,
  errorLine,
  historyTable,
  isoMinute,
  keepaMs,
  MARKETPLACES,
  SERIES_NAMES,
  summarizeProduct,
  tokenInfo,
  type StatsRange,
} from './decode.js';

type JsonSchema = ToolDefinition['inputSchema'];

const ORIGIN = 'https://api.keepa.com';
const KEY_PATTERN = /^[A-Za-z0-9]{64}$/;
/** The most rows a history call returns, over all its series. */
const MAX_HISTORY_ROWS = 250;
/** The most ASINs or codes one product request may name. */
const MAX_PRODUCTS_PER_REQUEST = 100;
/** How many live offers a history call's product summary lists. */
const HISTORY_OFFERS = 10;
/**
 * A best sellers list of a root category or a product group holds up to
 * 500,000 ASINs, about 6.5 MB of JSON once unpacked: more than the default
 * reply limit, so that call reads up to 8 MiB.
 */
const BESTSELLERS_MAX_BYTES = 8 * 1024 * 1024;
/** The product finder's page size: Keepa's minimum and default, and the most one result holds. */
const FINDER_DEFAULT_PER_PAGE = 50;
const FINDER_MAX_PER_PAGE = 2000;
/** Keepa's product finder reaches only the first 10,000 results of a query. */
const FINDER_MAX_RESULTS = 10_000;

const ERRORS = {
  400: 'Keepa refused a parameter of this call',
  402: 'Keepa does not accept this API key: it is unknown or has no active API plan. Check the key and the plan on keepa.com/api',
  404: 'Keepa has no such API path',
  405: 'Keepa refused a parameter value outside its allowed range',
};

const SITES = Object.keys(MARKETPLACES);
const MARKETPLACE: JsonSchema = {
  type: 'string',
  enum: SITES,
  description: `The Amazon marketplace: ${SITES.join(', ')}. Keepa covers no other (not amazon.com.tr, amazon.com.au, amazon.nl, amazon.se, amazon.pl, amazon.com.be, amazon.ae, amazon.sa, amazon.sg or amazon.eg).`,
};
const ASIN: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9]{10}$', description: 'An ASIN, 10 letters and digits, e.g. "B0F3GWXLTS".' };
const UPDATE: JsonSchema = {
  type: 'integer',
  minimum: 0,
  maximum: 1_000_000,
  description: 'Refresh a product whose Keepa data is older than this many hours (Keepa\'s default 1). 0 forces a refresh and costs 1 more token per product.',
};
/** The offers option; `listed` says which of the live offers the result lists. */
function offersOption(listed: string): JsonSchema {
  return {
    type: 'integer',
    minimum: 20,
    maximum: 100,
    description: `Paid: also load up to this many live offers (20 to 100), with the Buy Box history and the FBA, FBM, Warehouse, rating and review series. ${listed} Costs 6 tokens per 10 offers found instead of 1, and takes 2 to 20 seconds. Only when asked for.`,
  };
}
const BUYBOX: JsonSchema = { type: 'boolean', description: 'Paid: also load the Buy Box price history and statistics (2 more tokens per product). Only when asked for.' };
const RATING: JsonSchema = { type: 'boolean', description: 'Paid: also load the rating and review count history (up to 1 more token per product). Only when asked for.' };
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result.' };

type Market = (typeof MARKETPLACES)[string];

function marketOf(site: string): Market {
  return MARKETPLACES[site] as Market;
}

function flag(value: boolean | undefined): 1 | undefined {
  return value ? 1 : undefined;
}

function linkTemplate(market: Market): string {
  return `https://www.${market.site}/dp/{asin}`;
}

function apiKey(h: ToolHelpers): string {
  const key = h.credentials['apikey'] ?? '';
  if (!KEY_PATTERN.test(key)) {
    throw new ToolFailure('The Keepa API key must be the 64 letters and digits shown on the Keepa API page, and the one given is not. Copy it again from keepa.com/api. Nothing was sent to Keepa.');
  }
  return key;
}

/** A 429 means the tokens are used up: the free /token call says when the next call can run. */
async function outOfTokens(h: ToolHelpers, key: string): Promise<ToolFailure> {
  try {
    const { data } = await h.api({ origin: ORIGIN, path: '/token', query: { key } });
    const tokens = tokenInfo(data);
    if (tokens.nextCallInSeconds !== undefined) {
      const wait = tokens.nextCallInSeconds;
      return new ToolFailure(
        `Keepa tokens are used up (HTTP 429): the next call can run in about ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}`
          + `${tokens.nextCallAround ? ` (around ${tokens.nextCallAround})` : ''}. Do not call Keepa again before then.`,
        { status: 429, retryAfter: wait },
      );
    }
    if (tokens.left !== null && tokens.left >= 1) {
      return new ToolFailure(`Keepa tokens were used up for this call (HTTP 429); ${tokens.left} tokens are available again now.`, { status: 429 });
    }
  } catch {
    // The status call failed too: the plain sentence below has to do.
  }
  return new ToolFailure('Keepa tokens are used up (HTTP 429). Wait for the plan\'s tokens to refill before calling again; get_token_status says when.', { status: 429 });
}

/** One request to the Keepa API with the key added. A 429 comes back with the refill time. */
async function keepaRequest(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  const key = apiKey(h);
  try {
    return await h.api({ ...request, query: { ...request.query, key }, errors: ERRORS });
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 429) throw await outOfTokens(h, key);
    throw error;
  }
}

async function keepaGet(h: ToolHelpers, path: string, query: ApiRequest['query'], maxBytes?: number): Promise<Record<string, any>> {
  const { data } = await keepaRequest(h, { origin: ORIGIN, path, query, ...(maxBytes !== undefined ? { maxBytes } : {}) });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ToolFailure('Keepa sent a reply that is not JSON (a compressed reply the host did not unpack, or an error page). Try again later.');
  }
  return data;
}

/** The token status and, when Keepa refused part of a batch, its error: the fields every result starts with. */
function common(data: Record<string, any>): Record<string, unknown> {
  const warning = errorLine(data['error']);
  return { tokens: tokenInfo(data), ...(warning ? { warning: `Keepa: ${warning}` } : {}) };
}

const getTokenStatus: ToolDefinition = {
  name: 'get_token_status',
  kind: 'read',
  title: 'Get the Keepa token balance',
  description:
    'The Keepa token balance of the connected key: tokens left (it can be negative after a large call), tokens added per minute, '
    + 'seconds to the next refill and, when the balance is below 1, when the next call can run. Free: it costs no tokens. '
    + 'Check it before an expensive call (a search costs 10 tokens, a best sellers list 50).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args: Record<string, never>, h) {
    return { tokens: tokenInfo(await keepaGet(h, '/token', {})) };
  },
};

interface ProductArgs {
  marketplace: string;
  asins?: string[];
  codes?: string[];
  code_limit?: number;
  stats_days: number;
  stats_from?: string;
  stats_to?: string;
  update_hours?: number;
  offers?: number;
  buybox?: boolean;
  stock?: boolean;
  rating?: boolean;
  historical_variations?: boolean;
  brief?: boolean;
  cursor?: string;
}

const DATE: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

const getProducts: ToolDefinition = {
  name: 'get_products',
  kind: 'read',
  title: 'Get Amazon products from Keepa',
  description:
    'Up to 100 products by ASIN, or by UPC, EAN or ISBN-13 code: what each is (title, brand, category, Amazon\'s bought-in-past-month '
    + 'bracket), then per series (Amazon, Buy Box, lowest New, FBA, FBM, Used, Warehouse, list price, sales rank, offer count, rating, '
    + 'reviews) the value now, the 30 and 90 day averages, the lowest and highest in the range and the lowest ever, with sales rank drops '
    + 'and the Buy Box now; plus what a paid option adds: the live offers, stock levels, the variations no longer listed. Prices in the '
    + 'marketplace currency. 1 token per product, plus the paid options. With brief, one short row per product. A result over 32 KB is '
    + 'cut, and nextCursor loads the products left out, as many per call as fit (charged again): ask for about 15 products per call with '
    + 'full summaries, a few with offers.',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      asins: { type: 'array', items: ASIN, minItems: 1, maxItems: 100, uniqueItems: true, description: 'Up to 100 ASINs.' },
      codes: {
        type: 'array',
        items: { type: 'string', pattern: '^[0-9]{8,14}$', description: 'A UPC, EAN, GTIN or ISBN-13, digits only.' },
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        description: 'Instead of asins: up to 100 UPC, EAN, GTIN or ISBN-13 codes. One code can match several products.',
      },
      code_limit: { type: 'integer', minimum: 1, maximum: 100, description: 'With codes: the most products one code may return.' },
      stats_days: { type: 'integer', minimum: 1, maximum: 3650, default: 90, description: 'The range of the statistics, in days up to now (default 90). Free.' },
      stats_from: { ...DATE, description: 'Instead of stats_days: the first day of the range, YYYY-MM-DD (with stats_to).' },
      stats_to: { ...DATE, description: 'The last day of the range, YYYY-MM-DD (with stats_from).' },
      update_hours: UPDATE,
      offers: offersOption('Each product lists its live offers in Amazon\'s order: seller, condition, price, shipping, FBA and Prime, and each offer\'s stock with stock.'),
      buybox: BUYBOX,
      stock: {
        type: 'boolean',
        description: 'Paid: also load stock levels: the stock of Amazon\'s offer and of the Buy Box offer, and with offers each live offer\'s '
          + '(usually the first 10). 2 more tokens per product when Keepa has stock data from the last 7 days. Only when asked for.',
      },
      rating: RATING,
      historical_variations: {
        type: 'boolean',
        description: 'Paid: also list the variation ASINs that are no longer listed or out of stock (1 more token per product with a parent). Only when asked for.',
      },
      brief: {
        type: 'boolean',
        description: 'One short row per product (title, brand, New and Amazon price now, sales rank; with the paid options, their stock levels, '
          + 'the first 10 variations no longer listed and the first 5 live offers) instead of the full summary.',
      },
      cursor: CURSOR,
    },
    required: ['marketplace'],
    additionalProperties: false,
  },
  async run(args: ProductArgs, h) {
    const market = marketOf(args.marketplace);
    const state = h.cursor(args.cursor);
    let field: 'asin' | 'code';
    let ids: string[];
    // ASINs still to load after this call: a code lookup can match more than one request may name.
    let pending: string[] = [];
    if (typeof state?.['a'] === 'string') {
      // The products a cut result left out, by ASIN: as many as fit the last result (each one is
      // charged again), and never more than one request may name.
      const left = state['a'].split(',').filter(Boolean);
      const fit = typeof state['n'] === 'number' && Number.isInteger(state['n']) && state['n'] >= 1 ? state['n'] : MAX_PRODUCTS_PER_REQUEST;
      const batch = Math.min(fit, MAX_PRODUCTS_PER_REQUEST);
      [field, ids] = ['asin', left.slice(0, batch)];
      pending = left.slice(batch);
    } else if (args.asins && args.codes) {
      throw new ToolFailure('Give asins or codes, not both. Nothing was sent to Keepa.');
    } else if (args.asins) {
      [field, ids] = ['asin', args.asins.map((asin) => asin.toUpperCase())];
    } else if (args.codes) {
      [field, ids] = ['code', args.codes];
    } else {
      throw new ToolFailure('Give asins (up to 100) or codes (UPC, EAN or ISBN-13, up to 100). Nothing was sent to Keepa.');
    }
    if (args.code_limit !== undefined && !args.codes) throw new ToolFailure('code_limit only goes with codes. Nothing was sent to Keepa.');
    if ((args.stats_from === undefined) !== (args.stats_to === undefined)) {
      throw new ToolFailure('Give stats_from and stats_to together, or neither. Nothing was sent to Keepa.');
    }
    const range: StatsRange = args.stats_from && args.stats_to ? { from: args.stats_from, to: args.stats_to } : { days: args.stats_days };

    const data = await keepaGet(h, '/product', {
      domain: market.id,
      [field]: ids.join(','),
      stats: 'days' in range ? range.days : `${range.from},${range.to}`,
      // The summaries come from the stats: the history arrays would only make the reply larger.
      history: 0,
      update: args.update_hours,
      offers: args.offers,
      buybox: flag(args.buybox),
      stock: flag(args.stock),
      rating: flag(args.rating),
      'historical-variations': flag(args.historical_variations),
      'code-limit': field === 'code' ? args.code_limit : undefined,
    });
    const products: Array<Record<string, any>> = Array.isArray(data['products']) ? data['products'] : [];
    const nowMs = typeof data['timestamp'] === 'number' ? data['timestamp'] : Date.now();
    const asinsFrom = (index: number): string[] => products.slice(index).map((product) => product['asin']).filter((asin): asin is string => typeof asin === 'string');
    return h.page({
      key: 'products',
      // A full summary lists every live offer the call loaded: Keepa loads at most 100, which fit one result.
      items: products.map((product) => (args.brief ? briefProduct(product) : summarizeProduct(product, nowMs, range, args.offers ?? 0))),
      extra: { marketplace: market.site, currency: market.currency, ...common(data) },
      // `n`, the size of the next request: how many products fit this result, or all it asked for.
      resumeAt: (index) => h.makeCursor({ a: [...asinsFrom(index), ...pending].join(','), n: index }),
      ...(pending.length ? { nextPage: h.makeCursor({ a: pending.join(','), n: ids.length }) } : {}),
    });
  },
};

interface HistoryArgs {
  marketplace: string;
  asin: string;
  series: string[];
  days: number;
  step?: number;
  buybox?: boolean;
  rating?: boolean;
  offers?: number;
  update_hours?: number;
}

const getPriceHistory: ToolDefinition = {
  name: 'get_price_history',
  kind: 'read',
  title: 'Get the price and sales rank history of an Amazon product from Keepa',
  description:
    'Dated tables of one product\'s price, sales rank, offer count or rating over the last days: one row per UTC day, or per block of '
    + 'days (step 7 for weeks, 30 for months), with the lowest, highest and last value, the value in effect carried over days without '
    + 'a change, and the lowest and highest point in the range; plus the product summary (now, averages, lows, highs). By default '
    + 'daily up to a month, weekly up to half a year, monthly beyond. 1 token, plus the paid options a series needs '
    + '(BUY_BOX_SHIPPING: buybox; RATING and COUNT_REVIEWS: rating; FBA, FBM and Warehouse: offers).',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      asin: ASIN,
      series: {
        type: 'array',
        items: { type: 'string', enum: [...SERIES_NAMES] },
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        default: ['NEW', 'SALES'],
        description: 'The series, up to 4 (default NEW and SALES): AMAZON (Amazon\'s offer), NEW (lowest New), USED, SALES (sales rank), '
          + 'LISTPRICE, BUY_BOX_SHIPPING, NEW_FBA, NEW_FBM_SHIPPING, WAREHOUSE, COUNT_NEW, COUNT_USED, RATING, COUNT_REVIEWS and the rest of Keepa\'s series.',
      },
      days: { type: 'integer', minimum: 1, maximum: 3650, default: 90, description: 'The last this many days, up to now (default 90).' },
      step: { type: 'integer', minimum: 1, maximum: 365, description: 'Days per row: 1 for days, 7 for weeks, 30 for months. Default: 1 up to 31 days, 7 up to 186, else 30.' },
      buybox: BUYBOX,
      rating: RATING,
      offers: offersOption(`The product summary lists the first ${HISTORY_OFFERS} live offers in Amazon's order.`),
      update_hours: UPDATE,
    },
    required: ['marketplace', 'asin'],
    additionalProperties: false,
  },
  async run(args: HistoryArgs, h) {
    const market = marketOf(args.marketplace);
    const step = args.step ?? (args.days <= 31 ? 1 : args.days <= 186 ? 7 : 30);
    const rows = Math.ceil(args.days / step) * args.series.length;
    if (rows > MAX_HISTORY_ROWS) {
      throw new ToolFailure(
        `That makes up to ${rows} rows (${Math.ceil(args.days / step)} per series), and the most is ${MAX_HISTORY_ROWS}. `
          + 'Use a larger step (7 for weeks, 30 for months), fewer days or fewer series. Nothing was sent to Keepa.',
      );
    }
    const asin = args.asin.toUpperCase();
    const data = await keepaGet(h, '/product', {
      domain: market.id,
      asin,
      days: args.days,
      stats: args.days,
      update: args.update_hours,
      offers: args.offers,
      buybox: flag(args.buybox),
      rating: flag(args.rating),
    });
    const product = Array.isArray(data['products']) ? data['products'][0] : undefined;
    if (typeof product !== 'object' || product === null) {
      return { asin, marketplace: market.site, ...common(data), note: 'Keepa returned no product for this ASIN on this marketplace.' };
    }
    const nowMs = typeof data['timestamp'] === 'number' ? data['timestamp'] : Date.now();
    return {
      ...common(data),
      product: summarizeProduct(product, nowMs, { days: args.days }, HISTORY_OFFERS),
      history: args.series.map((name) => historyTable(product, SERIES_NAMES.indexOf(name as (typeof SERIES_NAMES)[number]), args.days, step, nowMs)),
    };
  },
};

const searchProducts: ToolDefinition = {
  name: 'search_products',
  kind: 'read',
  title: 'Search Amazon products with Keepa',
  description:
    'Searches a marketplace as Amazon\'s search does and returns up to 20 products in Amazon\'s order, sponsored results left out, each '
    + 'with ASIN, title, brand, the lowest New and Amazon price now, sales rank and bought-in-past-month bracket. 10 tokens per search. '
    + 'For a product\'s history, pass its ASIN to get_products or get_price_history.',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      term: { type: 'string', minLength: 1, maxLength: 200, description: 'The search words, e.g. "bluetooth speaker".' },
      asins_only: { type: 'boolean', description: 'Return only the ASINs, without product details (same cost).' },
    },
    required: ['marketplace', 'term'],
    additionalProperties: false,
  },
  async run(args: { marketplace: string; term: string; asins_only?: boolean }, h) {
    const market = marketOf(args.marketplace);
    const data = await keepaGet(h, '/search', {
      domain: market.id,
      type: 'product',
      term: args.term,
      ...(args.asins_only ? { 'asins-only': 1 } : { stats: 30, history: 0 }),
    });
    const products: Array<Record<string, any>> = Array.isArray(data['products']) ? data['products'] : [];
    const asins: unknown[] = Array.isArray(data['asinList']) ? data['asinList'] : [];
    return {
      marketplace: market.site,
      currency: market.currency,
      term: args.term,
      ...common(data),
      ...(args.asins_only || (!products.length && asins.length)
        ? { asins: asins.filter((asin) => typeof asin === 'string'), linkTemplate: linkTemplate(market) }
        : { products: products.map(briefProduct) }),
    };
  },
};

interface BestSellerArgs {
  marketplace: string;
  category: string;
  range?: number;
  month?: number;
  year?: number;
  variations?: boolean;
  sublist?: boolean;
  offset: number;
  top: number;
}

const getBestSellers: ToolDefinition = {
  name: 'get_best_sellers',
  kind: 'read',
  title: 'Get an Amazon best sellers list from Keepa',
  description:
    'The ranked ASINs of a category\'s best sellers list, best seller first: by the current sales rank, the average of the last 30, 90 '
    + 'or 180 days (range), or a past month (month and year, within the last 36 months, never the current one). Returns top ASINs '
    + 'from offset with the list\'s size and when Keepa updated it. A root category or product group list holds up to 500,000 ASINs, '
    + 'a subcategory list up to 10,000. 50 tokens per list, an empty one too; nothing when Keepa has no list. For titles and prices, '
    + 'pass the ASINs to get_products with brief (1 token each).',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      category: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description: 'A category id from search_categories (e.g. "172282"), or a product group name such as "Beauty".',
      },
      range: { type: 'integer', enum: [30, 90, 180], description: 'Rank by the average sales rank of the last 30, 90 or 180 days instead of the current one.' },
      month: { type: 'integer', minimum: 1, maximum: 12, description: 'The list of a past month (with year).' },
      year: { type: 'integer', minimum: 2000, maximum: 2100, description: 'The year of month.' },
      variations: { type: 'boolean', description: 'List every variation instead of one per parent.' },
      sublist: { type: 'boolean', description: 'Rank by the subcategory sales rank instead of the main category\'s. Not with range, month or year.' },
      offset: { type: 'integer', minimum: 0, default: 0, description: 'Skip this many entries (default 0): the next part of a long list. Each call loads the list again (50 tokens).' },
      top: { type: 'integer', minimum: 1, maximum: 2000, default: 20, description: 'How many ASINs to return, 1 to 2,000 (default 20).' },
    },
    required: ['marketplace', 'category'],
    additionalProperties: false,
  },
  async run(args: BestSellerArgs, h) {
    if ((args.month === undefined) !== (args.year === undefined)) throw new ToolFailure('Give month and year together. Nothing was sent to Keepa.');
    if (args.month !== undefined && args.range !== undefined) throw new ToolFailure('Give range or a month, not both. Nothing was sent to Keepa.');
    if (args.sublist && (args.range !== undefined || args.month !== undefined)) {
      throw new ToolFailure('Keepa takes sublist without range, month and year: ask for the subcategory ranking on its own. Nothing was sent to Keepa.');
    }
    const market = marketOf(args.marketplace);
    const data = await keepaGet(h, '/bestsellers', {
      domain: market.id,
      category: args.category,
      range: args.range,
      month: args.month,
      year: args.year,
      variations: flag(args.variations),
      sublist: flag(args.sublist),
    }, BESTSELLERS_MAX_BYTES);
    const list = typeof data['bestSellersList'] === 'object' && data['bestSellersList'] !== null ? data['bestSellersList'] : null;
    const asins: string[] = Array.isArray(list?.asinList) ? list.asinList.filter((asin: unknown) => typeof asin === 'string') : [];
    if (!asins.length) {
      return {
        marketplace: market.site,
        category: list?.categoryId ?? args.category,
        ...common(data),
        asins: [],
        // Keepa charges for a list that exists but is empty, and nothing when there is no list.
        note: list
          ? 'Keepa\'s best sellers list for that category on this marketplace is empty; the call still used its 50 tokens.'
          : 'Keepa has no best sellers list for that category on this marketplace (no tokens were used for it).',
      };
    }
    const end = Math.min(args.offset + args.top, asins.length);
    return {
      marketplace: market.site,
      category: list.categoryId ?? args.category,
      listUpdated: typeof list.lastUpdate === 'number' && list.lastUpdate > 0 ? isoMinute(keepaMs(list.lastUpdate)) : undefined,
      total: asins.length,
      offset: args.offset,
      ...common(data),
      asins: asins.slice(args.offset, end),
      linkTemplate: linkTemplate(market),
      ...(end < asins.length ? { nextOffset: end } : {}),
    };
  },
};

const INCLUDE_PATH: JsonSchema = { type: 'boolean', default: true, description: 'Add each category\'s path from the root (default true).' };

const searchCategories: ToolDefinition = {
  name: 'search_categories',
  kind: 'read',
  title: 'Search Amazon categories with Keepa',
  description:
    'Finds a marketplace\'s categories by name: up to 50, largest first, with id, name, path from the root, parent id, product count, '
    + 'subcategory count and average Buy Box price. Every word must match and needs 3 letters or more. Category ids differ per '
    + 'marketplace. 1 token.',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      term: { type: 'string', minLength: 3, maxLength: 200, description: 'The category name words, e.g. "bluetooth speakers".' },
      include_path: INCLUDE_PATH,
    },
    required: ['marketplace', 'term'],
    additionalProperties: false,
  },
  async run(args: { marketplace: string; term: string; include_path: boolean }, h) {
    if (args.term.trim().split(/\s+/).some((word) => word.length < 3)) {
      throw new ToolFailure('Every word of term needs 3 letters or more for Keepa\'s category search. Nothing was sent to Keepa.');
    }
    const market = marketOf(args.marketplace);
    const data = await keepaGet(h, '/search', { domain: market.id, type: 'category', term: args.term.trim(), parents: flag(args.include_path) });
    return { marketplace: market.site, currency: market.currency, ...common(data), categories: categoryList(data) };
  },
};

const getCategories: ToolDefinition = {
  name: 'get_categories',
  kind: 'read',
  title: 'Look up Amazon categories in Keepa',
  description:
    'Up to 10 categories of a marketplace by id (0 lists the root categories), with name, path from the root, parent id, product count, '
    + 'subcategory count and average Buy Box price, largest first. 1 token.',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      category_ids: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
        description: 'Up to 10 category ids, or [0] for the root categories.',
      },
      include_path: INCLUDE_PATH,
    },
    required: ['marketplace', 'category_ids'],
    additionalProperties: false,
  },
  async run(args: { marketplace: string; category_ids: number[]; include_path: boolean }, h) {
    const market = marketOf(args.marketplace);
    const data = await keepaGet(h, '/category', { domain: market.id, category: args.category_ids.join(','), parents: flag(args.include_path) });
    return { marketplace: market.site, currency: market.currency, ...common(data), categories: categoryList(data) };
  },
};

const findProducts: ToolDefinition = {
  name: 'find_products',
  kind: 'read',
  title: 'Find Amazon products with the Keepa product finder',
  description:
    'Searches Keepa\'s product database with filters and returns matching ASINs (no titles or prices) with the total count. Filters '
    + 'are ANDed, at least one: rootCategory and categories_include (arrays of ids), title, brand (array), current_<TYPE>_gte and '
    + 'current_<TYPE>_lte with TYPE AMAZON, NEW, USED, SALES or BUY_BOX_SHIPPING, avg90_<TYPE>_lte, deltaPercent90_<TYPE>_gte, '
    + 'monthlySold_gte, salesRankDrops30_gte and more; prices in the smallest currency unit (2500 = 25.00). Sorted by sales rank unless '
    + 'sort says otherwise, e.g. [["current_SALES","asc"]]. 10 tokens plus 1 per 100 ASINs returned.',
  inputSchema: {
    type: 'object',
    properties: {
      marketplace: MARKETPLACE,
      selection: {
        type: 'object',
        description: 'Keepa product finder filters, e.g. {"rootCategory":[172282],"current_SALES_lte":5000,"current_NEW_lte":2500}.',
      },
      page: { type: 'integer', minimum: 0, maximum: 199, description: 'The result page, from 0 (default 0). Keepa reaches only the first 10,000 results: (page + 1) × per_page at most 10,000.' },
      per_page: { type: 'integer', minimum: 50, maximum: 2000, description: 'ASINs per page, 50 to 2,000 (Keepa\'s default and minimum 50). More ASINs cost more tokens.' },
    },
    required: ['marketplace', 'selection'],
    additionalProperties: false,
  },
  async run(args: { marketplace: string; selection: Record<string, unknown>; page?: number; per_page?: number }, h) {
    const filters = Object.keys(args.selection).filter((key) => !['page', 'perPage', 'sort'].includes(key));
    if (!filters.length) throw new ToolFailure('selection needs at least one filter, such as rootCategory or current_SALES_lte. Nothing was sent to Keepa.');
    // The page and its size, from the arguments or from inside selection: the ASINs of one page must fit one result.
    const perPage = args.per_page ?? args.selection['perPage'] ?? FINDER_DEFAULT_PER_PAGE;
    const page = args.page ?? args.selection['page'] ?? 0;
    if (!Number.isInteger(perPage) || (perPage as number) < FINDER_DEFAULT_PER_PAGE) {
      throw new ToolFailure('perPage must be a whole number from 50 to 2,000. Nothing was sent to Keepa.');
    }
    if ((perPage as number) > FINDER_MAX_PER_PAGE) {
      throw new ToolFailure('A page of more than 2,000 ASINs does not fit in one result: use per_page up to 2,000 and page for the next ones. Nothing was sent to Keepa.');
    }
    if (!Number.isInteger(page) || (page as number) < 0) throw new ToolFailure('page must be a whole number from 0. Nothing was sent to Keepa.');
    if (((page as number) + 1) * (perPage as number) > FINDER_MAX_RESULTS) {
      throw new ToolFailure(
        `Keepa's product finder reaches only the first 10,000 results, and page ${page} with ${perPage} per page goes past them. `
          + 'Narrow the filters or sort differently instead. Nothing was sent to Keepa.',
      );
    }
    const market = marketOf(args.marketplace);
    const selection = {
      ...args.selection,
      ...(args.page !== undefined ? { page: args.page } : {}),
      ...(args.per_page !== undefined ? { perPage: args.per_page } : {}),
    };
    const data = await keepaGet(h, '/query', { domain: market.id, selection: JSON.stringify(selection) });
    const asins: string[] = Array.isArray(data['asinList']) ? data['asinList'].filter((asin: unknown) => typeof asin === 'string') : [];
    return {
      marketplace: market.site,
      totalResults: typeof data['totalResults'] === 'number' ? data['totalResults'] : undefined,
      page: typeof selection.page === 'number' ? selection.page : 0,
      ...common(data),
      asins,
      linkTemplate: linkTemplate(market),
    };
  },
};

const connector = defineConnector({
  vendor: 'keepa',
  label: 'Keepa',
  origins: [ORIGIN],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'Keepa API key' },
  tools: [
    getTokenStatus,
    getProducts,
    getPriceHistory,
    searchProducts,
    getBestSellers,
    searchCategories,
    getCategories,
    findProducts,
    // Keepa's API only reads, except the tracking calls (/tracking), which
    // change the account's tracked products even by GET: api_get keeps away
    // from them, and there is no api_request.
    ...apiTools({
      label: 'Keepa',
      description:
        'The Keepa API at https://api.keepa.com with the connected key (added as the key parameter), for the calls the other tools do not '
        + 'make: /seller (seller and storefront), /deal, /topseller, /lightningdeal and the raw /product, with domain (1 = amazon.com, '
        + '2 = .co.uk, 3 = .de, 4 = .fr, 5 = .co.jp, 6 = .ca, 8 = .it, 9 = .es, 10 = .in, 11 = .com.mx, 12 = .com.br) and the other '
        + 'parameters in query. Reference: https://keepa.com/#!api. Every call spends tokens as Keepa prices it; /tracking is not reachable.',
      guard(request) {
        if (request.segments[0]?.toLowerCase() === 'tracking') {
          throw new ToolFailure('api_get does not reach /tracking: those calls change the account\'s tracked products. Nothing was sent.');
        }
      },
      send: (request, h) => keepaRequest(h, request),
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

export = connector;
