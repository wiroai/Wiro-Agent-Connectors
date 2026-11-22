// Keepa's numbers, decoded. Keepa counts time in minutes since 2011-01-01
// (Unix milliseconds = (keepaTime + 21564000) * 60000), gives prices as
// integers in the currency's smallest unit, uses -1 for "no offer" or "no
// rank", and keeps each history series as a flat list of time, value pairs
// (time, price, shipping triplets for the series that include shipping) with
// a point only where the value changed. Everything here turns that into
// plain, dated JSON.

import { truncate } from '../../core/index.js';

type Item = Record<string, any>;

export interface Market {
  site: string;
  id: number;
  currency: string;
  decimals: number;
}

/** Every marketplace Keepa covers, by its site. Id 7 (the old amazon.cn) is retired. */
export const MARKETPLACES: Readonly<Record<string, Market>> = {
  'amazon.com': { site: 'amazon.com', id: 1, currency: 'USD', decimals: 2 },
  'amazon.co.uk': { site: 'amazon.co.uk', id: 2, currency: 'GBP', decimals: 2 },
  'amazon.de': { site: 'amazon.de', id: 3, currency: 'EUR', decimals: 2 },
  'amazon.fr': { site: 'amazon.fr', id: 4, currency: 'EUR', decimals: 2 },
  'amazon.co.jp': { site: 'amazon.co.jp', id: 5, currency: 'JPY', decimals: 0 },
  'amazon.ca': { site: 'amazon.ca', id: 6, currency: 'CAD', decimals: 2 },
  'amazon.it': { site: 'amazon.it', id: 8, currency: 'EUR', decimals: 2 },
  'amazon.es': { site: 'amazon.es', id: 9, currency: 'EUR', decimals: 2 },
  'amazon.in': { site: 'amazon.in', id: 10, currency: 'INR', decimals: 2 },
  'amazon.com.mx': { site: 'amazon.com.mx', id: 11, currency: 'MXN', decimals: 2 },
  'amazon.com.br': { site: 'amazon.com.br', id: 12, currency: 'BRL', decimals: 2 },
};

export function marketById(id: unknown): Market | undefined {
  return Object.values(MARKETPLACES).find((market) => market.id === id);
}

/** The csv history series by index, as Keepa names them. */
export const SERIES_NAMES = [
  'AMAZON', 'NEW', 'USED', 'SALES', 'LISTPRICE', 'COLLECTIBLE', 'REFURBISHED', 'NEW_FBM_SHIPPING', 'LIGHTNING_DEAL',
  'WAREHOUSE', 'NEW_FBA', 'COUNT_NEW', 'COUNT_USED', 'COUNT_REFURBISHED', 'COUNT_COLLECTIBLE', 'EXTRA_INFO_UPDATES',
  'RATING', 'COUNT_REVIEWS', 'BUY_BOX_SHIPPING', 'USED_NEW_SHIPPING', 'USED_VERY_GOOD_SHIPPING', 'USED_GOOD_SHIPPING',
  'USED_ACCEPTABLE_SHIPPING', 'COLLECTIBLE_NEW_SHIPPING', 'COLLECTIBLE_VERY_GOOD_SHIPPING', 'COLLECTIBLE_GOOD_SHIPPING',
  'COLLECTIBLE_ACCEPTABLE_SHIPPING', 'REFURBISHED_SHIPPING', 'EBAY_NEW_SHIPPING', 'EBAY_USED_SHIPPING', 'TRADE_IN', 'RENT',
  'BUY_BOX_USED_SHIPPING', 'PRIME_EXCL', 'COUNT_NEW_FBA', 'COUNT_NEW_FBM',
] as const;

/** What the common series hold. */
const ABOUT: Readonly<Record<number, string>> = {
  0: "Amazon's own offer",
  1: 'lowest New price from any seller, Amazon too',
  2: 'lowest Used price',
  3: 'sales rank in the main category, lower is better',
  4: 'list price',
  7: 'lowest New price fulfilled by the seller, incl. shipping',
  9: 'Amazon Warehouse price',
  10: 'lowest New price fulfilled by Amazon, third-party sellers',
  11: 'number of New offers',
  12: 'number of Used offers',
  16: 'rating in stars',
  17: 'number of reviews',
  18: 'Buy Box price incl. shipping',
  32: 'Used Buy Box price incl. shipping',
  33: 'lowest Prime exclusive New price',
};

/** Series stored as time, price, shipping triplets. */
const TRIPLETS = new Set([7, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 32]);
/** New and Used changed meaning on 2026-02-23: from then on Keepa records the lowest price with shipping. */
const SHIPPING_CHANGE_SERIES = new Set([1, 2, 5, 6]);
const SHIPPING_CHANGE_DAY = Date.UTC(2026, 1, 23) / 86_400_000;

export type Kind = 'price' | 'rank' | 'count' | 'rating';

export function kindOf(index: number): Kind {
  if (index === 3) return 'rank';
  if (index === 16) return 'rating';
  if ([11, 12, 13, 14, 15, 17, 34, 35].includes(index)) return 'count';
  return 'price';
}

const DAY_MS = 86_400_000;

export function keepaMs(keepaTime: number): number {
  return (keepaTime + 21_564_000) * 60_000;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "2026-11-21T14:05Z": minutes, UTC. */
export function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/**
 * A value as an agent reads it: a price in currency units (34.99), a rank or
 * count as is, a rating in stars (4.5). Below zero is "no offer" for a price
 * and "no rank" for the sales rank; null when Keepa has no data.
 */
export function show(value: unknown, kind: Kind, decimals: number): number | string | null {
  if (!isNumber(value)) return null;
  if (value < 0) return kind === 'price' ? 'no offer' : kind === 'rank' ? 'no rank' : null;
  if (kind === 'price') return decimals === 0 ? value : value / 100;
  if (kind === 'rating') return value / 10;
  return value;
}

function money(value: number, decimals: number): number {
  return decimals === 0 ? value : value / 100;
}

/** A [keepaTime, value] extreme point (min, max, minInInterval, maxInInterval) with its date. */
function extreme(point: unknown, kind: Kind, decimals: number): Record<string, unknown> | undefined {
  if (!Array.isArray(point) || point.length < 2 || !isNumber(point[0])) return undefined;
  const value = show(point[1], kind, decimals);
  return value === null ? undefined : { value, date: isoDay(keepaMs(point[0])) };
}

/** The time, value points of csv series `index`, with shipping added to the price of a triplet series. */
function points(csv: unknown, index: number): Array<{ t: number; v: number }> {
  const history = Array.isArray(csv) ? csv[index] : undefined;
  if (!Array.isArray(history)) return [];
  const out: Array<{ t: number; v: number }> = [];
  if (TRIPLETS.has(index)) {
    for (let k = 0; k + 2 < history.length; k += 3) {
      const [t, price, shipping] = [history[k], history[k + 1], history[k + 2]];
      if (!isNumber(t) || !isNumber(price)) continue;
      out.push({ t: keepaMs(t), v: price < 0 ? -1 : price + Math.max(isNumber(shipping) ? shipping : 0, 0) });
    }
  } else {
    for (let k = 0; k + 1 < history.length; k += 2) {
      const [t, value] = [history[k], history[k + 1]];
      if (isNumber(t) && isNumber(value)) out.push({ t: keepaMs(t), v: value });
    }
  }
  return out;
}

export interface TokenInfo {
  used: number;
  left: number | null;
  refillRate: number;
  refillInSeconds: number;
  /** When the balance is below 1: how long until a call can run again. */
  nextCallInSeconds?: number;
  nextCallAround?: string;
  tokenFlowReduction?: number;
  note?: string;
}

/**
 * The token status every Keepa answer carries. The balance can be negative:
 * Keepa runs a call while the balance is above zero and then charges its
 * full cost; a call can run again once refills bring it back above zero.
 */
export function tokenInfo(data: Item): TokenInfo {
  const left = isNumber(data?.['tokensLeft']) ? data['tokensLeft'] : null;
  const rate = isNumber(data?.['refillRate']) ? data['refillRate'] : 0;
  const refillIn = Math.ceil((isNumber(data?.['refillIn']) ? data['refillIn'] : 0) / 1000);
  const info: TokenInfo = {
    used: isNumber(data?.['tokensConsumed']) ? data['tokensConsumed'] : 0,
    left,
    refillRate: rate,
    refillInSeconds: refillIn,
  };
  if (left !== null && left < 1 && rate > 0) {
    const wait = refillIn + (Math.ceil((1 - left) / rate) - 1) * 60;
    info.nextCallInSeconds = wait;
    if (isNumber(data['timestamp'])) info.nextCallAround = isoMinute(data['timestamp'] + wait * 1000);
    info.note = `Out of tokens: the next call can run in about ${wait < 60 ? `${wait} s` : `${Math.ceil(wait / 60)} min`}`
      + `${info.nextCallAround ? ` (around ${info.nextCallAround})` : ''}. Do not call again before then.`;
  } else if (left !== null && left < 1 && !data['error']) {
    info.note = 'No tokens and no refill rate: the key has no active Keepa API plan.';
  }
  if (isNumber(data?.['tokenFlowReduction']) && data['tokenFlowReduction'] > 0) {
    info.tokenFlowReduction = data['tokenFlowReduction'];
    info.note = `${info.note ? `${info.note} ` : ''}Keepa tracking lowers the refill rate by ${data['tokenFlowReduction']}.`;
  }
  return info;
}

/** Keepa's error object, in one line: "invalidParameter: You used an invalid parameter ... (domain)". */
export function errorLine(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { type, message, details } = error as Item;
  const parts = [typeof type === 'string' ? type : 'error', typeof message === 'string' ? `: ${message}` : ''];
  if (details !== undefined && details !== null) parts.push(` (${truncate(typeof details === 'string' ? details : JSON.stringify(details), 300)})`);
  return truncate(parts.join(''), 600);
}

/** [csv index, label] in the order a summary lists them. Warehouse, FBA, FBM, rating and reviews fill only when the call asked for them. */
const SUMMARY_SERIES: ReadonlyArray<readonly [number, string]> = [
  [0, 'Amazon'],
  [18, 'Buy Box incl. shipping'],
  [1, 'New, lowest (any seller, Amazon too)'],
  [10, 'New, lowest FBA'],
  [7, 'New, lowest FBM incl. shipping'],
  [2, 'Used, lowest'],
  [9, 'Amazon Warehouse'],
  [4, 'List price'],
  [3, 'Sales rank (lower is better)'],
  [11, 'New offers'],
  [16, 'Rating (stars)'],
  [17, 'Reviews'],
];

function at(list: unknown, index: number): unknown {
  return Array.isArray(list) ? list[index] : undefined;
}

function statRow(stats: Item, index: number, label: string, decimals: number): Record<string, unknown> | undefined {
  const kind = kindOf(index);
  const now = at(stats['current'], index);
  const avg30 = at(stats['avg30'], index);
  const avg90 = at(stats['avg90'], index);
  const low = at(stats['minInInterval'], index);
  const high = at(stats['maxInInterval'], index);
  const ever = at(stats['min'], index);
  const noValue = (value: unknown) => !isNumber(value) || value < 0;
  if (noValue(now) && noValue(avg30) && noValue(avg90) && low == null && high == null && ever == null) return undefined;
  return compact({
    series: SERIES_NAMES[index],
    label,
    now: show(now, kind, decimals),
    avg30: show(avg30, kind, decimals),
    avg90: show(avg90, kind, decimals),
    lowestInRange: extreme(low, kind, decimals),
    highestInRange: extreme(high, kind, decimals),
    lowestEver: extreme(ever, kind, decimals),
  });
}

/** The last point of csv series `index`, when the reply has no stats. */
function lastRow(product: Item, index: number, label: string, decimals: number): Record<string, unknown> | undefined {
  const list = points(product['csv'], index);
  const last = list[list.length - 1];
  if (!last) return undefined;
  return compact({ series: SERIES_NAMES[index], label, value: show(last.v, kindOf(index), decimals), since: isoMinute(last.t) });
}

const UNKNOWN_MARKET: Market = { site: 'unknown marketplace', id: 0, currency: '?', decimals: 2 };

function productNote(product: Item): string | undefined {
  switch (product['productType']) {
    case 1:
    case 2:
      return 'Digital product: Keepa has no price, rating or offer data for it.';
    case 3:
      return 'Keepa cannot read prices, ratings or offers for this product; its sales rank and offer counts update less often.';
    case 4:
      return 'Keepa has no current data for this ASIN (invalid or retired; sometimes temporary).';
    case 5:
      return 'This is a parent ASIN: prices belong to its variations (see variations).';
    default:
      return undefined;
  }
}

/** Offer conditions by Keepa's code (Open Box counts as Used). */
const CONDITIONS: readonly string[] = [
  'unknown', 'New', 'Used - Like New', 'Used - Very Good', 'Used - Good', 'Used - Acceptable', 'Refurbished',
  'Collectible - Like New', 'Collectible - Very Good', 'Collectible - Good', 'Collectible - Acceptable', 'Rental',
];

function isItem(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The last value of a time, value, ... list (an offer's stockCSV). */
function lastValue(list: unknown): number | undefined {
  if (!Array.isArray(list) || list.length < 2) return undefined;
  const value = list[list.length - 1];
  return isNumber(value) ? value : undefined;
}

/**
 * One live offer: seller, condition, the price and shipping now (the last
 * time, price, shipping triplet of offerCSV; below zero is unknown), how it
 * ships, and its stock when the call asked for stock.
 */
function offerRow(offer: Item, decimals: number): Record<string, unknown> {
  const csv = Array.isArray(offer['offerCSV']) ? offer['offerCSV'] : [];
  const price = csv.length >= 3 ? csv[csv.length - 2] : undefined;
  const shipping = csv.length >= 3 ? csv[csv.length - 1] : undefined;
  const stock = lastValue(offer['stockCSV']);
  const condition = offer['condition'];
  return compact({
    sellerId: typeof offer['sellerId'] === 'string' ? truncate(offer['sellerId'], 40) : undefined,
    condition: isNumber(condition) ? (CONDITIONS[condition] ?? `condition ${condition}`) : undefined,
    price: isNumber(price) && price >= 0 ? money(price, decimals) : undefined,
    shipping: isNumber(shipping) && shipping >= 0 ? money(shipping, decimals) : undefined,
    isAmazon: offer['isAmazon'] === true || undefined,
    isFBA: offer['isFBA'] === true || undefined,
    isPrime: offer['isPrime'] === true || undefined,
    isWarehouseDeal: offer['isWarehouseDeal'] === true || undefined,
    isPreorder: offer['isPreorder'] === true || undefined,
    isMAP: offer['isMAP'] === true || undefined,
    notShippable: offer['isShippable'] === false || undefined,
    stock: isNumber(stock) && stock >= 0 ? stock : undefined,
  });
}

/**
 * The live offers of a product loaded with the offers option: the offers on
 * Amazon's offer page now, in its order (liveOffersOrder indexes the offers
 * list, which also keeps offers that are gone), the first `max` of them.
 * Undefined when the call did not load offers.
 */
function liveOffers(product: Item, decimals: number, max: number): Record<string, unknown> | undefined {
  const offers = product['offers'];
  if (!Array.isArray(offers) || max <= 0) return undefined;
  const order = Array.isArray(product['liveOffersOrder']) ? product['liveOffersOrder'].filter(isNumber) : [];
  const list = order.slice(0, max).map((index) => offers[index]).filter(isItem).map((offer) => offerRow(offer, decimals));
  return compact({
    count: order.length,
    list,
    note: product['offersSuccessful'] === false
      ? 'Keepa could not load fresh offers this time (it charged 1 token), so the offer data is the last it had.'
      : undefined,
  });
}

/** Stock levels, when the call asked for stock: Amazon's and the Buy Box offer's stock (from the stats) and when Keepa last collected stock. */
function stockLevels(product: Item): Record<string, unknown> | undefined {
  const stats = isItem(product['stats']) ? product['stats'] : {};
  const amazon = stats['stockAmazon'];
  const buyBox = stats['stockBuyBox'];
  const updated = product['lastStockUpdate'];
  const stock = compact({
    amazon: isNumber(amazon) && amazon >= 0 ? amazon : undefined,
    buyBox: isNumber(buyBox) && buyBox >= 0 ? buyBox : undefined,
    updated: isNumber(updated) && updated > 0 ? isoMinute(keepaMs(updated)) : undefined,
  });
  return Object.keys(stock).length ? stock : undefined;
}

/** The variations no longer listed or out of stock, when the call asked for historical variations: how many, and the first `max` ASINs. */
function historicalVariations(product: Item, max: number): Record<string, unknown> | undefined {
  const list = Array.isArray(product['historicalVariations'])
    ? product['historicalVariations'].filter((asin: unknown): asin is string => typeof asin === 'string')
    : [];
  return list.length ? { count: list.length, asins: list.slice(0, max) } : undefined;
}

function categoryPath(product: Item): string | undefined {
  const tree = Array.isArray(product['categoryTree']) ? product['categoryTree'] : [];
  return tree.length ? tree.map((node: Item) => (typeof node?.['name'] === 'string' ? node['name'] : '?')).join(' > ') : undefined;
}

function salesRankIn(product: Item): string | undefined {
  const reference = product['salesRankReference'];
  if (!isNumber(reference) || reference <= 0) return undefined;
  const tree = Array.isArray(product['categoryTree']) ? product['categoryTree'] : [];
  const node = tree.find((item: Item) => item?.['catId'] === reference);
  return typeof node?.['name'] === 'string' ? node['name'] : `category ${reference}`;
}

/** The range a summary covers: the stats days of the call, or the dates of a stats range. */
export type StatsRange = { days: number } | { from: string; to: string } | null;

/**
 * One product, summarized: what it is, the marketplace and the range, then
 * per series the value now, the 30 and 90 day averages, the lowest and
 * highest in the range and the lowest ever (from the stats object), and the
 * sales rank drops, Amazon's out-of-stock share, the offer count and the Buy
 * Box now. Without stats, the last known value of each series. What the paid
 * options load comes last: stock levels, the variations no longer listed, and
 * the first `maxOffers` live offers.
 */
export function summarizeProduct(product: Item, nowMs: number, range: StatsRange, maxOffers = 20): Record<string, unknown> {
  const market = marketById(product['domainId']) ?? UNKNOWN_MARKET;
  const { decimals } = market;
  const stats = typeof product['stats'] === 'object' && product['stats'] !== null ? (product['stats'] as Item) : null;
  const variations = product['productType'] === 5 && Array.isArray(product['variations'])
    ? product['variations'].map((item: Item) => item?.['asin']).filter((asin: unknown) => typeof asin === 'string').slice(0, 20)
    : undefined;

  const summary: Record<string, unknown> = compact({
    asin: product['asin'],
    title: typeof product['title'] === 'string' ? truncate(product['title'], 200) : undefined,
    marketplace: market.site,
    currency: market.currency,
    range: range === null
      ? { to: isoDay(nowMs) }
      : 'days' in range ? { days: range.days, from: isoDay(nowMs - range.days * DAY_MS), to: isoDay(nowMs) } : { from: range.from, to: range.to },
    lastUpdate: isNumber(product['lastUpdate']) && product['lastUpdate'] > 0 ? isoMinute(keepaMs(product['lastUpdate'])) : undefined,
    note: productNote(product),
    variations: variations?.length ? variations : undefined,
    brand: typeof product['brand'] === 'string' && product['brand'] ? truncate(product['brand'], 120) : undefined,
    category: categoryPath(product),
    salesRankIn: salesRankIn(product),
    boughtPastMonth: isNumber(product['monthlySold']) && product['monthlySold'] > 0 ? `${product['monthlySold']}+` : undefined,
    trackingSince: isNumber(product['trackingSince']) && product['trackingSince'] > 0 ? isoDay(keepaMs(product['trackingSince'])) : undefined,
  });

  if (stats) {
    summary['stats'] = SUMMARY_SERIES.map(([index, label]) => statRow(stats, index, label, decimals)).filter(Boolean);
    const drops30 = stats['salesRankDrops30'];
    if (isNumber(drops30) && drops30 >= 0) {
      summary['salesRankDrops'] = compact({ days30: drops30, days90: isNumber(stats['salesRankDrops90']) && stats['salesRankDrops90'] >= 0 ? stats['salesRankDrops90'] : undefined });
    }
    const outOfStock = at(stats['outOfStockPercentage90'], 0);
    if (isNumber(outOfStock) && outOfStock >= 0) summary['amazonOutOfStockPercent90'] = outOfStock;
    if (isNumber(stats['totalOfferCount']) && stats['totalOfferCount'] >= 0) summary['offersNow'] = stats['totalOfferCount'];
    if (isNumber(stats['buyBoxPrice']) && stats['buyBoxPrice'] >= 0) {
      summary['buyBox'] = compact({
        price: money(stats['buyBoxPrice'], decimals),
        shipping: money(Math.max(isNumber(stats['buyBoxShipping']) ? stats['buyBoxShipping'] : 0, 0), decimals),
        sellerId: typeof stats['buyBoxSellerId'] === 'string' ? stats['buyBoxSellerId'] : undefined,
        isAmazon: stats['buyBoxIsAmazon'] === true ? true : undefined,
        isFBA: stats['buyBoxIsFBA'] === true ? true : undefined,
      });
    }
  } else {
    const last = SUMMARY_SERIES.map(([index, label]) => lastRow(product, index, label, decimals)).filter(Boolean);
    summary['note'] = [summary['note'], last.length
      ? 'No stats in this reply: these are the last known values; ask with stats for averages, lows and highs.'
      : 'No price or rank history in this reply.'].filter(Boolean).join(' ');
    if (last.length) summary['lastKnown'] = last;
  }
  return { ...summary, ...paidExtras(product, decimals, maxOffers, 20) };
}

/** What the paid options added to a product, for a summary or a brief row. */
function paidExtras(product: Item, decimals: number, maxOffers: number, maxVariations: number): Record<string, unknown> {
  return compact({
    stock: stockLevels(product),
    historicalVariations: historicalVariations(product, maxVariations),
    liveOffers: liveOffers(product, decimals, maxOffers),
  });
}

/** The value now of csv series `index`: from the stats when the reply has them, else the last point of the history. */
function nowValue(product: Item, index: number): unknown {
  const current = product['stats']?.['current'];
  if (Array.isArray(current)) return current[index];
  const history = at(product['csv'], index);
  return Array.isArray(history) && history.length >= 2 ? history[history.length - 1] : undefined;
}

/** How many live offers and historical variations a brief row lists. */
const BRIEF_OFFERS = 5;
const BRIEF_VARIATIONS = 10;

/**
 * One product in a list: ASIN, title, brand, lowest New and Amazon price now,
 * sales rank, bought in the past month, and what the paid options added
 * (stock levels, the first variations no longer listed, the first live offers).
 */
export function briefProduct(product: Item): Record<string, unknown> {
  const { decimals } = marketById(product['domainId']) ?? UNKNOWN_MARKET;
  return compact({
    asin: product['asin'],
    title: typeof product['title'] === 'string' ? truncate(product['title'], 120) : undefined,
    brand: typeof product['brand'] === 'string' && product['brand'] ? truncate(product['brand'], 80) : undefined,
    newNow: show(nowValue(product, 1), 'price', decimals),
    amazonNow: show(nowValue(product, 0), 'price', decimals),
    salesRank: show(nowValue(product, 3), 'rank', decimals),
    boughtPastMonth: isNumber(product['monthlySold']) && product['monthlySold'] > 0 ? `${product['monthlySold']}+` : undefined,
    note: product['productType'] === 5 ? 'parent ASIN: prices belong to its variations' : product['productType'] === 4 ? 'Keepa has no current data for it' : undefined,
    ...paidExtras(product, decimals, BRIEF_OFFERS, BRIEF_VARIATIONS),
  });
}

/** What a history call needs to fill a series that only some calls carry. */
function missingHint(index: number): string {
  if (index === 18) return ' BUY_BOX_SHIPPING needs buybox (or offers).';
  if (index === 16 || index === 17) return ' RATING and COUNT_REVIEWS need rating (or offers).';
  if ([7, 9, 10, 32, 33, 34, 35].includes(index)) return ' The FBA, FBM, Warehouse and offer-count series need offers.';
  return '';
}

/**
 * One series of one product as a dated table: one row per UTC day (or per
 * block of `step` days) with the lowest, highest and last value, the value in
 * effect carried over days without a change. The last `days` days, up to the
 * reply's timestamp.
 */
export function historyTable(product: Item, index: number, days: number, step: number, nowMs: number): Record<string, unknown> {
  const market = marketById(product['domainId']) ?? UNKNOWN_MARKET;
  const { decimals } = market;
  const kind = kindOf(index);
  const name = SERIES_NAMES[index] ?? `csv ${index}`;
  const head = compact({
    series: name,
    about: ABOUT[index],
    currency: kind === 'price' ? market.currency : undefined,
  });
  const raw = at(product['csv'], index);
  if (!Array.isArray(raw) || raw.length < 2) {
    return { ...head, note: `Keepa has no ${name} history for this product in this reply.${missingHint(index)}` };
  }

  // A Lightning Deal can end in the future; nothing after now is history.
  const all = points(product['csv'], index).filter((point) => point.t <= nowMs);
  const today = Math.floor(nowMs / DAY_MS);
  const first = all.length ? Math.floor((all[0] as { t: number }).t / DAY_MS) : today;
  const start = Math.max(today - days + 1, first);
  let carry: number | null = null;
  for (const point of all) if (point.t < start * DAY_MS) carry = point.v;
  const changes = new Map<number, number[]>();
  for (const point of all) {
    if (point.t < start * DAY_MS) continue;
    const day = Math.floor(point.t / DAY_MS);
    changes.set(day, [...(changes.get(day) ?? []), point.v]);
  }

  // One entry per day: the value carried in plus every change of that day.
  const daily: Array<{ d: number; values: number[]; close: number }> = [];
  for (let d = start; d <= today; d++) {
    const inDay = changes.get(d) ?? [];
    const values = [...(carry === null ? [] : [carry]), ...inDay];
    if (values.length) daily.push({ d, values, close: values[values.length - 1] as number });
    if (inDay.length) carry = inDay[inDay.length - 1] as number;
  }
  const blocks: Array<{ d0: number; d1: number; values: number[]; close: number }> = [];
  for (const entry of daily) {
    const block = Math.floor((entry.d - start) / step);
    const last = blocks[blocks.length - 1];
    if (last && Math.floor((last.d0 - start) / step) === block) {
      last.d1 = entry.d;
      last.values.push(...entry.values);
      last.close = entry.close;
    } else {
      blocks.push({ d0: entry.d, d1: entry.d, values: [...entry.values], close: entry.close });
    }
  }

  const [lowKey, highKey] = kind === 'price' ? ['low', 'high'] : kind === 'rank' ? ['best', 'worst'] : ['min', 'max'];
  const gapKey = kind === 'price' ? 'noOffer' : kind === 'rank' ? 'noRank' : 'noData';
  const dayText = (day: number) => isoDay(day * DAY_MS);
  const rows = blocks.map((block) => {
    const ok = block.values.filter((value) => value >= 0);
    return compact({
      date: block.d0 === block.d1 ? dayText(block.d0) : `${dayText(block.d0)}/${dayText(block.d1)}`,
      [lowKey as string]: show(ok.length ? Math.min(...ok) : -1, kind, decimals),
      [highKey as string]: show(ok.length ? Math.max(...ok) : -1, kind, decimals),
      last: show(block.close, kind, decimals),
      [gapKey]: block.values.some((value) => value < 0) ? true : undefined,
    });
  });

  const inRange = all.filter((point) => point.t >= start * DAY_MS && point.v >= 0);
  let summary: Record<string, unknown> | undefined;
  if (inRange.length) {
    // The first point at the lowest value and the last at the highest.
    let low = inRange[0] as { t: number; v: number };
    let high = low;
    for (const point of inRange) {
      if (point.v < low.v) low = point;
      if (point.v >= high.v) high = point;
    }
    const [lowName, highName] = kind === 'rank' ? ['best', 'worst'] : kind === 'price' ? ['lowest', 'highest'] : ['min', 'max'];
    summary = {
      count: inRange.length,
      [lowName as string]: { value: show(low.v, kind, decimals), at: isoMinute(low.t) },
      [highName as string]: { value: show(high.v, kind, decimals), at: isoMinute(high.t) },
    };
  }

  return compact({
    ...head,
    step: step === 1 ? 'day' : `${step} days`,
    from: dayText(start),
    to: dayText(today),
    note: SHIPPING_CHANGE_SERIES.has(index) && start < SHIPPING_CHANGE_DAY
      ? 'Until 2026-02-22 this series is the lowest listing price; from 2026-02-23 Keepa records the lowest price with shipping.'
      : undefined,
    rows: rows.length ? rows : undefined,
    changesInRange: summary,
    empty: rows.length ? undefined : `Keepa has no ${name} data in this range.`,
  });
}

/**
 * The categories of a /category or /search type=category reply, largest
 * first: id, name, the path from the root (as far as the reply's parents
 * reach), parent id, product count, subcategory count and average Buy Box.
 */
export function categoryList(data: Item): Record<string, unknown>[] {
  const categories = typeof data?.['categories'] === 'object' && data['categories'] !== null ? (data['categories'] as Item) : {};
  const parents = typeof data?.['categoryParents'] === 'object' && data['categoryParents'] !== null ? (data['categoryParents'] as Item) : {};
  const known: Item = { ...parents, ...categories };
  const chain = (id: unknown): string[] => {
    const names: string[] = [];
    let current: Item | undefined = known[String(id)];
    for (let depth = 0; current && depth <= 12; depth++) {
      names.unshift(typeof current['name'] === 'string' ? current['name'] : '?');
      current = current['parent'] ? known[String(current['parent'])] : undefined;
    }
    return names;
  };
  const list = Object.values(categories)
    .filter((item): item is Item => typeof item === 'object' && item !== null)
    .sort((a, b) => (isNumber(b['productCount']) ? b['productCount'] : 0) - (isNumber(a['productCount']) ? a['productCount'] : 0));
  return list.map((category) => {
    const { decimals } = marketById(category['domainId']) ?? UNKNOWN_MARKET;
    return compact({
      id: category['catId'],
      name: typeof category['name'] === 'string' ? truncate(category['name'], 200) : undefined,
      path: truncate(chain(category['catId']).join(' > '), 600) || undefined,
      parent: isNumber(category['parent']) ? category['parent'] : undefined,
      productCount: isNumber(category['productCount']) ? category['productCount'] : undefined,
      subcategories: Array.isArray(category['children']) ? category['children'].length : 0,
      avgBuyBox: isNumber(category['avgBuyBox']) && category['avgBuyBox'] >= 0 ? money(category['avgBuyBox'], decimals) : undefined,
    });
  });
}
