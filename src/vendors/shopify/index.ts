// Shopify, through the GraphQL Admin API (pinned to version 2026-07) of one
// shop (https://shopify.dev/docs/api/admin-graphql).
//
// Credentials: `shopdomain`, the shop's own <shop>.myshopify.com address, and
// `access_token`, an Admin API access token of an app installed on the shop:
// from an OAuth sign-in with the merchant's own app, or a token the app's
// client credentials exchange gives (same Shopify organization). Hosts pass
// their current token on every call; this module never refreshes or keeps it.
// The token goes to that shop only, in the X-Shopify-Access-Token header.

import { defineConnector, truncate, ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import {
  API_VERSION,
  assertNoUserErrors,
  gid,
  graphql,
  idempotencyKey,
  listPosition,
  pageCursors,
  readDocument,
  searchValue,
  shopOrigin,
  type GraphqlResult,
} from './graphql.js';

type JsonSchema = ToolDefinition['inputSchema'];

const ID = (type: string, what: string): JsonSchema => ({ type: 'string', pattern: `^(\\d{1,20}|gid://shopify/${type}/\\d{1,20})$`, description: `${what} (a number or gid://shopify/${type}/…).` });
const ID_LIST = (type: string, what: string): JsonSchema => ({ type: 'array', items: ID(type, type), maxItems: 100, uniqueItems: true, description: what });
const MONEY = (what: string): JsonSchema => ({ type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,4})?$', description: what });
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result (the other arguments then come from it).' };
const FIRST = (fallback: number): JsonSchema => ({ type: 'integer', minimum: 1, maximum: 100, default: fallback, description: `Items per page, 1 to 100 (default ${fallback}).` });
const SEARCH = (examples: string): JsonSchema => ({ type: 'string', minLength: 1, maxLength: 1000, description: `Shopify search syntax, e.g. ${examples}.` });
const REVERSE: JsonSchema = { type: 'boolean', default: true, description: 'Newest or highest first (default true).' };

const STOCK_NAMES = ['available', 'on_hand', 'committed', 'incoming', 'reserved'];
const INVENTORY_REASONS = ['correction', 'cycle_count_available', 'damaged', 'received', 'restock', 'shrinkage', 'promotion', 'quality_control', 'safety_stock', 'other'];
/** Mutations that need the @idempotent directive in this API version. */
const IDEMPOTENT_MUTATIONS = ['inventoryActivate', 'inventoryAdjustQuantities', 'inventorySetQuantities', 'inventoryMoveQuantities', 'refundCreate'];
/**
 * Mutations graphql_mutation never sends: they point Shopify at an address the
 * caller picks (webhooks, carrier and fulfillment service callbacks, server
 * pixels), make new credentials, or run other mutations from a string and a
 * file (bulkOperationRunMutation), whose names this check would not see.
 */
const BLOCKED_MUTATIONS = [
  'webhookSubscriptionCreate',
  'webhookSubscriptionUpdate',
  'eventBridgeWebhookSubscriptionCreate',
  'eventBridgeWebhookSubscriptionUpdate',
  'pubSubWebhookSubscriptionCreate',
  'pubSubWebhookSubscriptionUpdate',
  'carrierServiceCreate',
  'carrierServiceUpdate',
  'fulfillmentServiceCreate',
  'fulfillmentServiceUpdate',
  'eventBridgeServerPixelUpdate',
  'pubSubServerPixelUpdate',
  'delegateAccessTokenCreate',
  'storefrontAccessTokenCreate',
  'bulkOperationRunMutation',
];

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function amountOf(set: any): string | undefined {
  const amount = set?.shopMoney?.amount ?? set?.amount;
  return typeof amount === 'string' || typeof amount === 'number' ? String(amount) : undefined;
}

function nonZero(value: string | undefined): string | undefined {
  return value !== undefined && Number(value) !== 0 ? value : undefined;
}

function withWarnings(result: Record<string, unknown>, response: GraphqlResult): Record<string, unknown> {
  return response.warnings.length ? { ...result, warnings: response.warnings.slice(0, 5) } : result;
}

// ---------------------------------------------------------------------------
// Trimming

function priceRange(range: any): string | undefined {
  const low = range?.minVariantPrice?.amount;
  const high = range?.maxVariantPrice?.amount;
  if (low === undefined) return undefined;
  return high !== undefined && Number(high) !== Number(low) ? `${low}–${high}` : String(low);
}

function trimListProduct(product: any): Record<string, unknown> {
  return compact({
    id: product?.id,
    title: typeof product?.title === 'string' ? truncate(product.title, 300) : undefined,
    handle: product?.handle,
    status: product?.status,
    vendor: product?.vendor,
    productType: product?.productType,
    tags: Array.isArray(product?.tags) && product.tags.length ? product.tags.slice(0, 20) : undefined,
    price: priceRange(product?.priceRangeV2),
    currency: product?.priceRangeV2?.minVariantPrice?.currencyCode,
    variants: product?.variantsCount?.count,
    totalInventory: product?.tracksInventory ? product?.totalInventory : undefined,
    onlineStoreUrl: product?.onlineStoreUrl,
    image: product?.featuredMedia?.preview?.image?.url,
    updatedAt: product?.updatedAt,
    publishedAt: product?.publishedAt,
  });
}

function trimVariant(variant: any): Record<string, unknown> {
  return compact({
    id: variant?.id,
    title: variant?.title,
    sku: variant?.sku,
    barcode: variant?.barcode,
    price: variant?.price,
    compareAtPrice: variant?.compareAtPrice,
    options: Array.isArray(variant?.selectedOptions) ? variant.selectedOptions.map((option: any) => `${option?.name}: ${option?.value}`).join(', ') : undefined,
    inventoryQuantity: variant?.inventoryItem?.tracked === false ? undefined : variant?.inventoryQuantity,
    inventoryPolicy: variant?.inventoryPolicy,
    availableForSale: variant?.availableForSale,
    taxable: variant?.taxable,
    inventoryItemId: variant?.inventoryItem?.id,
    tracked: variant?.inventoryItem?.tracked,
    requiresShipping: variant?.inventoryItem?.requiresShipping,
  });
}

function trimProduct(product: any): Record<string, unknown> {
  const html = typeof product?.descriptionHtml === 'string' ? product.descriptionHtml : '';
  const points = Array.from(html);
  return compact({
    ...trimListProduct(product),
    descriptionHtml: points.length > 10_000 ? points.slice(0, 10_000).join('') : html,
    descriptionCut: points.length > 10_000 ? true : undefined,
    seo: product?.seo?.title || product?.seo?.description ? compact({ title: product.seo.title, description: product.seo.description }) : undefined,
    category: product?.category?.fullName,
    options: Array.isArray(product?.options)
      ? product.options.map((option: any) => ({ name: option?.name, values: Array.isArray(option?.optionValues) ? option.optionValues.map((value: any) => value?.name) : [] }))
      : undefined,
    media: Array.isArray(product?.media?.nodes) && product.media.nodes.length
      ? product.media.nodes.map((media: any) => compact({ id: media?.id, type: media?.mediaContentType, status: media?.status, alt: media?.alt, url: media?.preview?.image?.url }))
      : undefined,
    collections: Array.isArray(product?.collections?.nodes) && product.collections.nodes.length
      ? product.collections.nodes.map((collection: any) => compact({ id: collection?.id, title: collection?.title, handle: collection?.handle }))
      : undefined,
    onlineStorePreviewUrl: product?.onlineStorePreviewUrl,
    createdAt: product?.createdAt,
  });
}

function trimListOrder(order: any): Record<string, unknown> {
  return compact({
    id: order?.id,
    name: order?.name,
    createdAt: order?.createdAt,
    financialStatus: order?.displayFinancialStatus,
    fulfillmentStatus: order?.displayFulfillmentStatus,
    total: amountOf(order?.currentTotalPriceSet),
    currency: order?.currencyCode,
    refunded: nonZero(amountOf(order?.totalRefundedSet)),
    items: order?.subtotalLineItemsQuantity,
    returnStatus: order?.returnStatus && order.returnStatus !== 'NO_RETURN' ? order.returnStatus : undefined,
    cancelledAt: order?.cancelledAt,
    closed: order?.closed === true ? true : undefined,
    test: order?.test === true ? true : undefined,
    tags: Array.isArray(order?.tags) && order.tags.length ? order.tags.slice(0, 20) : undefined,
  });
}

function trimAddress(address: any): Record<string, unknown> | undefined {
  if (!address || typeof address !== 'object') return undefined;
  return compact({
    name: address.name,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    zip: address.zip,
    country: address.country,
    countryCode: address.countryCodeV2,
    phone: address.phone,
  });
}

function trimOrder(order: any): Record<string, unknown> {
  const customer = order?.customer;
  return compact({
    ...trimListOrder(order),
    processedAt: order?.processedAt,
    cancelReason: order?.cancelReason,
    closedAt: order?.closedAt,
    note: order?.note,
    sourceName: order?.sourceName,
    paymentGateways: Array.isArray(order?.paymentGatewayNames) && order.paymentGatewayNames.length ? order.paymentGatewayNames : undefined,
    subtotal: amountOf(order?.subtotalPriceSet),
    shipping: nonZero(amountOf(order?.totalShippingPriceSet)),
    tax: nonZero(amountOf(order?.totalTaxSet)),
    discounts: nonZero(amountOf(order?.totalDiscountsSet)),
    lineItems: Array.isArray(order?.lineItems?.nodes)
      ? order.lineItems.nodes.map((item: any) => compact({
        id: item?.id,
        name: item?.name,
        sku: item?.sku,
        quantity: item?.quantity,
        currentQuantity: item?.currentQuantity !== item?.quantity ? item?.currentQuantity : undefined,
        unitPrice: amountOf(item?.originalUnitPriceSet),
        variantId: item?.variant?.id,
      }))
      : undefined,
    moreLineItems: order?.lineItems?.pageInfo?.hasNextPage === true ? true : undefined,
    fulfillmentOrders: Array.isArray(order?.fulfillmentOrders?.nodes) && order.fulfillmentOrders.nodes.length
      ? order.fulfillmentOrders.nodes.map((fulfillmentOrder: any) => compact({
        id: fulfillmentOrder?.id,
        status: fulfillmentOrder?.status,
        requestStatus: fulfillmentOrder?.requestStatus,
        location: fulfillmentOrder?.assignedLocation?.name,
        locationId: fulfillmentOrder?.assignedLocation?.location?.id,
        lineItems: Array.isArray(fulfillmentOrder?.lineItems?.nodes)
          ? fulfillmentOrder.lineItems.nodes.map((line: any) => compact({
            id: line?.id,
            name: line?.lineItem?.name,
            remainingQuantity: line?.remainingQuantity,
            totalQuantity: line?.totalQuantity,
          }))
          : undefined,
      }))
      : undefined,
    fulfillments: Array.isArray(order?.fulfillments) && order.fulfillments.length
      ? order.fulfillments.map((fulfillment: any) => compact({
        id: fulfillment?.id,
        status: fulfillment?.status,
        createdAt: fulfillment?.createdAt,
        tracking: Array.isArray(fulfillment?.trackingInfo) && fulfillment.trackingInfo.length
          ? fulfillment.trackingInfo.map((info: any) => compact({ company: info?.company, number: info?.number, url: info?.url }))
          : undefined,
      }))
      : undefined,
    refunds: Array.isArray(order?.refunds) && order.refunds.length
      ? order.refunds.map((refund: any) => compact({ id: refund?.id, createdAt: refund?.createdAt, amount: amountOf(refund?.totalRefundedSet), note: refund?.note }))
      : undefined,
    customer: customer
      ? compact({
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.defaultEmailAddress?.emailAddress,
        phone: customer.defaultPhoneNumber?.phoneNumber,
      })
      : undefined,
    email: order?.email,
    phone: order?.phone,
    shippingAddress: trimAddress(order?.shippingAddress),
    billingAddress: trimAddress(order?.billingAddress),
  });
}

function trimCustomer(customer: any): Record<string, unknown> {
  return compact({
    id: customer?.id,
    firstName: customer?.firstName,
    lastName: customer?.lastName,
    email: customer?.defaultEmailAddress?.emailAddress,
    phone: customer?.defaultPhoneNumber?.phoneNumber,
    state: customer?.state,
    numberOfOrders: customer?.numberOfOrders,
    amountSpent: amountOf(customer?.amountSpent),
    currency: customer?.amountSpent?.currencyCode,
    tags: Array.isArray(customer?.tags) && customer.tags.length ? customer.tags.slice(0, 20) : undefined,
    createdAt: customer?.createdAt,
    updatedAt: customer?.updatedAt,
  });
}

function trimDiscount(id: unknown, discount: any): Record<string, unknown> {
  const codes = discount?.codes?.nodes;
  return compact({
    id,
    kind: typeof discount?.__typename === 'string' ? discount.__typename.replace(/^Discount/, '') : undefined,
    title: discount?.title,
    status: discount?.status,
    summary: discount?.summary,
    codes: Array.isArray(codes) && codes.length ? codes.map((code: any) => code?.code) : undefined,
    startsAt: discount?.startsAt,
    endsAt: discount?.endsAt,
    usageLimit: discount?.usageLimit,
    used: discount?.asyncUsageCount,
    oncePerCustomer: discount?.appliesOncePerCustomer === true ? true : undefined,
  });
}

// ---------------------------------------------------------------------------
// Documents

const PRODUCT_LIST_FIELDS = `id title handle status vendor productType tags updatedAt publishedAt totalInventory tracksInventory
  variantsCount { count } priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }
  onlineStoreUrl featuredMedia { preview { image { url } } }`;

const PRODUCT_DETAIL = `fragment ProductDetail on Product {
  ${PRODUCT_LIST_FIELDS}
  createdAt descriptionHtml onlineStorePreviewUrl
  seo { title description }
  category { fullName }
  options { name optionValues { name } }
  media(first: 20) { nodes { id alt mediaContentType status preview { image { url } } } }
  collections(first: 20) { nodes { id title handle } }
  variants(first: 100, after: $variantsAfter) {
    nodes { id title sku barcode price compareAtPrice inventoryQuantity inventoryPolicy availableForSale taxable selectedOptions { name value } inventoryItem { id tracked requiresShipping } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CODE_DISCOUNT_FIELDS = `
  ... on DiscountCodeBasic { title status summary startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer codes(first: 3) { nodes { code } } }
  ... on DiscountCodeBxgy { title status summary startsAt endsAt usageLimit asyncUsageCount codes(first: 3) { nodes { code } } }
  ... on DiscountCodeFreeShipping { title status summary startsAt endsAt usageLimit asyncUsageCount codes(first: 3) { nodes { code } } }
  ... on DiscountCodeApp { title status startsAt endsAt usageLimit asyncUsageCount codes(first: 3) { nodes { code } } }`;

const ORDER_DETAIL = `fragment OrderDetail on Order {
  id name createdAt processedAt cancelledAt cancelReason closed closedAt test tags note returnStatus sourceName paymentGatewayNames
  displayFinancialStatus displayFulfillmentStatus currencyCode subtotalLineItemsQuantity
  subtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } } currentTotalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
  lineItems(first: 50) { nodes { id name sku quantity currentQuantity variant { id } originalUnitPriceSet { shopMoney { amount } } } pageInfo { hasNextPage } }
  fulfillmentOrders(first: 5) { nodes { id status requestStatus assignedLocation { name location { id } }
    lineItems(first: 30) { nodes { id remainingQuantity totalQuantity lineItem { name } } } } }
  fulfillments(first: 10) { id status createdAt trackingInfo(first: 5) { company number url } }
  refunds(first: 10) { id createdAt note totalRefundedSet { shopMoney { amount } } }
  customer @include(if: $contact) { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  email @include(if: $contact)
  phone @include(if: $contact)
  shippingAddress @include(if: $contact) { name company address1 address2 city province zip country countryCodeV2 phone }
  billingAddress @include(if: $contact) { name company address1 address2 city province zip country countryCodeV2 phone }
}`;

const INVENTORY_LEVELS = `fragment Levels on InventoryItem {
  id sku tracked
  inventoryLevels(first: 50) { nodes { updatedAt location { id name } quantities(names: ${JSON.stringify(STOCK_NAMES)}) { name quantity } } }
}`;

// ---------------------------------------------------------------------------
// Schemas

const LIST_PRODUCTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: SEARCH('"status:active", "title:mug*", "vendor:Acme", "sku:MUG-1", "tag:sale", "inventory_total:<5"'),
    sort_key: { type: 'string', enum: ['UPDATED_AT', 'CREATED_AT', 'TITLE', 'INVENTORY_TOTAL', 'PUBLISHED_AT', 'PRODUCT_TYPE', 'VENDOR', 'ID'], default: 'UPDATED_AT' },
    reverse: REVERSE,
    first: FIRST(25),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const LIST_ORDERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: SEARCH('"financial_status:paid", "fulfillment_status:unfulfilled", "created_at:>=2026-11-01", "name:#1001", "status:open"'),
    sort_key: { type: 'string', enum: ['CREATED_AT', 'PROCESSED_AT', 'UPDATED_AT', 'TOTAL_PRICE', 'ORDER_NUMBER', 'ID'], default: 'CREATED_AT' },
    reverse: REVERSE,
    first: FIRST(25),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const LIST_CUSTOMERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: SEARCH('"email:ada@example.com", "tag:vip", "orders_count:>5", "country:Germany"'),
    sort_key: { type: 'string', enum: ['UPDATED_AT', 'CREATED_AT', 'NAME', 'ID'], default: 'UPDATED_AT' },
    reverse: REVERSE,
    include_contact: { type: 'boolean', default: false, description: 'Add each customer\'s email and phone.' },
    first: FIRST(25),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const LIST_COLLECTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: SEARCH('"title:summer*", "collection_type:smart"'),
    sort_key: { type: 'string', enum: ['UPDATED_AT', 'TITLE', 'ID'], default: 'UPDATED_AT' },
    reverse: REVERSE,
    first: FIRST(50),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const LIST_DISCOUNTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 255, description: 'One discount by its exact code.' },
    query: SEARCH('"status:active", "title:winter*", "type:percentage"'),
    sort_key: { type: 'string', enum: ['CREATED_AT', 'UPDATED_AT', 'STARTS_AT', 'ENDS_AT', 'TITLE', 'ID'], default: 'CREATED_AT' },
    reverse: REVERSE,
    first: FIRST(25),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const LIST_LOCATIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    include_inactive: { type: 'boolean', default: false, description: 'Also list deactivated locations.' },
    first: FIRST(50),
    cursor: CURSOR,
  },
  additionalProperties: false,
};

const VARIANT_FIELDS: Record<string, JsonSchema> = {
  price: MONEY('The price, e.g. "19.90".'),
  compare_at_price: { type: 'string', pattern: '^(\\d{1,12}(\\.\\d{1,4})?)?$', description: 'The compare-at (crossed-out) price; "" removes it.' },
  sku: { type: 'string', maxLength: 255 },
  barcode: { type: 'string', maxLength: 255 },
  inventory_policy: { type: 'string', enum: ['DENY', 'CONTINUE'], description: 'CONTINUE keeps selling when out of stock.' },
  taxable: { type: 'boolean' },
  track_inventory: { type: 'boolean', description: 'Shopify tracks its stock.' },
  cost: MONEY('Cost per item.'),
  requires_shipping: { type: 'boolean' },
};

interface VariantArgs {
  price?: string;
  compare_at_price?: string;
  sku?: string;
  barcode?: string;
  inventory_policy?: string;
  taxable?: boolean;
  track_inventory?: boolean;
  cost?: string;
  requires_shipping?: boolean;
}

/**
 * A variant's fields as the API takes them. A new variant (productSet) carries
 * its SKU itself; an existing one (productVariantsBulkUpdate) through its
 * inventory item, where "" also removes a compare-at price.
 */
function variantInput(variant: VariantArgs, existing: boolean): Record<string, unknown> {
  const item = compact({ sku: existing ? variant.sku : undefined, tracked: variant.track_inventory, cost: variant.cost, requiresShipping: variant.requires_shipping });
  return {
    ...compact({
      price: variant.price,
      compareAtPrice: variant.compare_at_price,
      sku: existing ? undefined : variant.sku,
      barcode: variant.barcode,
      inventoryPolicy: variant.inventory_policy,
      taxable: variant.taxable,
      inventoryItem: Object.keys(item).length ? item : undefined,
    }),
    ...(existing && variant.compare_at_price === '' ? { compareAtPrice: null } : {}),
  };
}

/** The ProductSetInput of a new product: its options, its variants (one default variant when it has no options) and files. */
function productSetInput(args: any): Record<string, unknown> {
  const options: Array<{ name: string; values: string[] }> = args.options ?? [];
  const variants: any[] = args.variants?.length ? args.variants : [{}];
  const refuse = (sentence: string): never => {
    throw new ToolFailure(`${sentence} Nothing was sent.`);
  };
  let productOptions: unknown[];
  let variantInputs: unknown[];
  if (!options.length) {
    if (variants.length > 1) refuse('Several variants need options (such as Size or Color) that tell them apart.');
    if (variants[0]?.option_values) refuse('option_values need options on the product.');
    productOptions = [{ name: 'Title', values: [{ name: 'Default Title' }] }];
    variantInputs = [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }] }];
  } else {
    productOptions = options.map((option) => ({ name: option.name, values: option.values.map((value) => ({ name: value })) }));
    const seen = new Set<string>();
    variantInputs = variants.map((variant, index) => {
      const chosen: Record<string, unknown> = variant.option_values ?? {};
      const optionValues = options.map((option) => {
        const value = chosen[option.name];
        if (typeof value !== 'string' || !option.values.includes(value)) {
          refuse(`variants[${index}].option_values needs a value for ${option.name}, one of: ${option.values.join(', ')}.`);
        }
        return { optionName: option.name, name: value };
      });
      const extra = Object.keys(chosen).filter((name) => !options.some((option) => option.name === name));
      if (extra.length) refuse(`variants[${index}].option_values names ${extra.join(', ')}, which is not one of the options.`);
      const key = JSON.stringify(optionValues);
      if (seen.has(key)) refuse(`variants[${index}] repeats the option values of an earlier variant.`);
      seen.add(key);
      return { optionValues };
    });
  }
  variantInputs = variantInputs.map((input, index) => {
    const variant = variants[index] ?? {};
    const quantities: any[] = variant.inventory_quantities ?? [];
    return compact({
      ...(input as Record<string, unknown>),
      ...variantInput({ ...variant, track_inventory: variant.track_inventory ?? (quantities.length ? true : undefined) }, false),
      inventoryQuantities: quantities.length
        ? quantities.map((entry, at) => ({ locationId: gid('Location', entry.location_id, `variants[${index}].inventory_quantities[${at}].location_id`), name: 'available', quantity: entry.quantity }))
        : undefined,
    });
  });
  return compact({
    title: args.title,
    descriptionHtml: args.description_html,
    vendor: args.vendor,
    productType: args.product_type,
    tags: args.tags,
    handle: args.handle,
    status: args.status,
    seo: args.seo_title || args.seo_description ? compact({ title: args.seo_title, description: args.seo_description }) : undefined,
    collections: Array.isArray(args.collection_ids) ? args.collection_ids.map((id: string, at: number) => gid('Collection', id, `collection_ids[${at}]`)) : undefined,
    productOptions,
    variants: variantInputs,
    files: Array.isArray(args.images) && args.images.length
      ? args.images.map((image: any) => compact({ originalSource: image.url, alt: image.alt, contentType: 'IMAGE' }))
      : undefined,
  });
}

/** Existing products that a new product's handle or SKUs would repeat. */
async function findDuplicates(h: ToolHelpers, handle: string | undefined, skus: string[]): Promise<string[]> {
  if (!handle && !skus.length) return [];
  const { data } = await graphql(h, `query Duplicates($handle: String!, $hasHandle: Boolean!, $skuQuery: String!, $hasSkus: Boolean!) {
  byHandle: productByIdentifier(identifier: { handle: $handle }) @include(if: $hasHandle) { id title }
  bySku: productVariants(first: 10, query: $skuQuery) @include(if: $hasSkus) { nodes { sku product { id title } } }
}`, {
    handle: handle ?? '',
    hasHandle: Boolean(handle),
    skuQuery: skus.map((sku) => `sku:${searchValue(sku)}`).join(' OR '),
    hasSkus: skus.length > 0,
  });
  const found: string[] = [];
  if (data?.byHandle?.id) found.push(`the handle ${handle} is taken by ${data.byHandle.id} ("${truncate(String(data.byHandle.title ?? ''), 80)}")`);
  for (const node of Array.isArray(data?.bySku?.nodes) ? data.bySku.nodes : []) {
    if (skus.includes(node?.sku)) found.push(`the SKU ${node.sku} is on ${node?.product?.id} ("${truncate(String(node?.product?.title ?? ''), 80)}")`);
  }
  return found;
}

// ---------------------------------------------------------------------------

const connector = defineConnector({
  vendor: 'shopify',
  label: 'Shopify',
  origins: [],
  originFields: ['shopdomain'],
  credentials: ['shopdomain', 'access_token'],
  credentialLabels: { shopdomain: 'Shopify shop domain', access_token: 'Shopify access token' },
  authHeaders: (credentials) => ({ 'x-shopify-access-token': credentials['access_token'] ?? '' }),
  tools: [
    {
      name: 'get_shop',
      kind: 'read',
      title: 'Get the Shopify shop and the app\'s access scopes',
      description:
        'The connected shop (name, myshopify domain, primary domain, currency, time zone, plan) and the access scopes the app was '
        + 'granted, which decide what the other tools may do. Use it to check the connection.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const response = await graphql(h, `query ShopIdentity {
  shop { id name myshopifyDomain url currencyCode ianaTimezone weightUnit enabledPresentmentCurrencies primaryDomain { host url } plan { publicDisplayName partnerDevelopment shopifyPlus } }
  currentAppInstallation { accessScopes { handle } }
}`);
        const shop = response.data?.shop;
        if (!shop?.id) throw new ToolFailure('Shopify answered without the shop.');
        const configured = new URL(shopOrigin(h)).hostname;
        return withWarnings(compact({
          id: shop.id,
          name: shop.name,
          myshopifyDomain: shop.myshopifyDomain,
          primaryDomain: shop.primaryDomain?.url,
          currency: shop.currencyCode,
          presentmentCurrencies: Array.isArray(shop.enabledPresentmentCurrencies) && shop.enabledPresentmentCurrencies.length > 1 ? shop.enabledPresentmentCurrencies : undefined,
          timezone: shop.ianaTimezone,
          weightUnit: shop.weightUnit,
          plan: shop.plan?.publicDisplayName,
          developmentStore: shop.plan?.partnerDevelopment === true ? true : undefined,
          accessScopes: Array.isArray(response.data?.currentAppInstallation?.accessScopes)
            ? response.data.currentAppInstallation.accessScopes.map((scope: any) => scope?.handle).filter(Boolean)
            : undefined,
          apiVersion: API_VERSION,
          warning: shop.myshopifyDomain && shop.myshopifyDomain !== configured
            ? `The token belongs to ${shop.myshopifyDomain}, not to ${configured} as connected.`
            : undefined,
        }), response);
      },
    },
    {
      name: 'list_products',
      kind: 'read',
      title: 'List Shopify products',
      description:
        'Lists products, most recently updated first: id, title, handle, status, vendor, type, tags, price range, variant count, stock '
        + 'and image. query takes Shopify search syntax (status, title, vendor, product_type, sku, tag, inventory_total ...). Pass '
        + 'nextCursor back as cursor for more.',
      inputSchema: LIST_PRODUCTS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_PRODUCTS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Products($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) { nodes { ${PRODUCT_LIST_FIELDS} } pageInfo { hasNextPage endCursor } }
}`, { first: f['first'] ?? 25, after: position.after ?? null, query: f['query'] ?? null, sortKey: f['sort_key'] ?? 'UPDATED_AT', reverse: f['reverse'] ?? true });
        const connection = response.data?.products;
        const products: unknown[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'products',
          items: products.map(trimListProduct).slice(position.skip),
          extra: response.warnings.length ? { warnings: response.warnings.slice(0, 5) } : {},
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'get_product',
      kind: 'read',
      title: 'Get a Shopify product',
      description:
        'One product by id or handle: description HTML, SEO, options, media, collections, and its variants with price, compare-at price, '
        + 'SKU, barcode, stock, inventory policy and inventory item id. Pass nextCursor back as cursor, with the same id or handle, for '
        + 'more variants.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID('Product', 'The product id'),
          handle: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,254}$', description: 'Or the product handle.' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { id?: string; handle?: string; cursor?: string }, h) {
        if ((args.id === undefined) === (args.handle === undefined)) throw new ToolFailure('Give id or handle (one of them). Nothing was sent.');
        const state = h.cursor(args.cursor);
        const after = typeof state?.['a'] === 'string' ? state['a'] : null;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const response = args.id !== undefined
          ? await graphql(h, `query Product($id: ID!, $variantsAfter: String) { product(id: $id) { ...ProductDetail } }\n${PRODUCT_DETAIL}`, {
            id: gid('Product', args.id, 'id'),
            variantsAfter: after,
          })
          : await graphql(h, `query ProductByHandle($handle: String!, $variantsAfter: String) { product: productByIdentifier(identifier: { handle: $handle }) { ...ProductDetail } }\n${PRODUCT_DETAIL}`, {
            handle: args.handle,
            variantsAfter: after,
          });
        const product = response.data?.product;
        if (!product) throw new ToolFailure(`Shopify found no product with that ${args.id !== undefined ? 'id' : 'handle'}.`);
        const variants: unknown[] = Array.isArray(product.variants?.nodes) ? product.variants.nodes : [];
        const next = product.variants?.pageInfo?.hasNextPage === true && typeof product.variants.pageInfo.endCursor === 'string' ? product.variants.pageInfo.endCursor : undefined;
        return h.page({
          key: 'variants',
          items: variants.map(trimVariant).slice(skip),
          extra: withWarnings({ ...trimProduct(product), variantCount: product.variantsCount?.count }, response),
          resumeAt: (index) => h.makeCursor({ ...(after ? { a: after } : {}), o: skip + index }),
          ...(next ? { nextPage: h.makeCursor({ a: next, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'create_product',
      kind: 'create',
      check: 'list_products',
      title: 'Create a Shopify product',
      description:
        'Creates a product with its options and variants (prices, SKUs, stock per location) and images from public URLs (Shopify fetches '
        + 'them), as a draft unless status says otherwise. ACTIVE is not on sale until it is published to a sales channel '
        + '(publish_product). It refuses a handle or SKU the shop already has, unless allow_duplicates is true.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          description_html: { type: 'string', maxLength: 500_000, description: 'The description as HTML.' },
          vendor: { type: 'string', maxLength: 255 },
          product_type: { type: 'string', maxLength: 255 },
          tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 250 },
          handle: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,254}$', description: 'The URL handle (default: from the title).' },
          status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'UNLISTED', 'ARCHIVED'], default: 'DRAFT' },
          seo_title: { type: 'string', maxLength: 255 },
          seo_description: { type: 'string', maxLength: 1000 },
          collection_ids: ID_LIST('Collection', 'Manual collections to add it to.'),
          images: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public image URL.' }, alt: { type: 'string', maxLength: 512 } },
              required: ['url'],
              additionalProperties: false,
            },
          },
          options: {
            type: 'array',
            maxItems: 3,
            description: 'Up to 3 options, e.g. [{"name": "Size", "values": ["S", "M"]}]; none for a product with one variant.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255 },
                values: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, minItems: 1, maxItems: 100, uniqueItems: true },
              },
              required: ['name', 'values'],
              additionalProperties: false,
            },
          },
          variants: {
            type: 'array',
            maxItems: 100,
            description: 'The variants: one per option combination to sell (or one, without options).',
            items: {
              type: 'object',
              properties: {
                option_values: { type: 'object', description: 'The value of each option, e.g. {"Size": "M"}.' },
                ...VARIANT_FIELDS,
                inventory_quantities: {
                  type: 'array',
                  maxItems: 50,
                  items: {
                    type: 'object',
                    properties: { location_id: ID('Location', 'A location id from list_locations'), quantity: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
                    required: ['location_id', 'quantity'],
                    additionalProperties: false,
                  },
                  description: 'Available stock per location.',
                },
              },
              additionalProperties: false,
            },
          },
          allow_duplicates: { type: 'boolean', default: false, description: 'Create it even if the handle or a SKU is in use.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      async run(args: any, h) {
        const input = productSetInput(args);
        if (!args.allow_duplicates) {
          const skus = (args.variants ?? []).map((variant: any) => variant?.sku).filter((sku: unknown): sku is string => typeof sku === 'string' && sku !== '');
          const duplicates = await findDuplicates(h, args.handle, [...new Set<string>(skus)]);
          if (duplicates.length) {
            throw new ToolFailure(`Shopify already has this product, it seems: ${duplicates.join('; ')}. Update that one, or pass allow_duplicates: true. Nothing was changed.`);
          }
        }
        const response = await graphql(h, `mutation CreateProduct($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id title handle status onlineStorePreviewUrl variants(first: 100) { nodes { id title sku price inventoryItem { id } } } }
    userErrors { field message code }
  }
}`, { input }, { write: true });
        const payload = response.data?.productSet;
        assertNoUserErrors(payload, 'create the product');
        const product = payload?.product;
        if (!product?.id) throw new ToolFailure('Shopify answered without the new product. Look for it with list_products before trying again.');
        return withWarnings(compact({
          id: product.id,
          title: product.title,
          handle: product.handle,
          status: product.status,
          onlineStorePreviewUrl: product.onlineStorePreviewUrl,
          variants: Array.isArray(product.variants?.nodes)
            ? product.variants.nodes.map((variant: any) => compact({ id: variant?.id, title: variant?.title, sku: variant?.sku, price: variant?.price, inventoryItemId: variant?.inventoryItem?.id }))
            : undefined,
          note: product.status === 'ACTIVE'
            ? 'Active, but on no sales channel yet: publish it with publish_product.'
            : product.status === 'DRAFT' ? 'A draft: customers do not see it.' : undefined,
        }), response);
      },
    },
    {
      name: 'update_product',
      kind: 'update',
      check: 'get_product',
      title: 'Update a Shopify product',
      description:
        'Changes a product\'s title, description, vendor, type, tags (the list replaces the old one), handle (the old URL redirects), '
        + 'status, SEO and manual collections (join or leave). Only the fields given change. Prices and SKUs are per variant: '
        + 'update_variants; images are added with add_product_images.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID('Product', 'The product id'),
          title: { type: 'string', minLength: 1, maxLength: 255 },
          description_html: { type: 'string', maxLength: 500_000 },
          vendor: { type: 'string', maxLength: 255 },
          product_type: { type: 'string', maxLength: 255 },
          tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 250, description: 'Replaces all tags.' },
          handle: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,254}$' },
          status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'UNLISTED', 'ARCHIVED'] },
          seo_title: { type: 'string', maxLength: 255 },
          seo_description: { type: 'string', maxLength: 1000 },
          collections_to_join: ID_LIST('Collection', 'Manual collections to add it to.'),
          collections_to_leave: ID_LIST('Collection', 'Manual collections to take it out of.'),
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: any, h) {
        const product = compact({
          id: gid('Product', args.id, 'id'),
          title: args.title,
          descriptionHtml: args.description_html,
          vendor: args.vendor,
          productType: args.product_type,
          tags: args.tags,
          handle: args.handle,
          redirectNewHandle: args.handle !== undefined ? true : undefined,
          status: args.status,
          seo: args.seo_title !== undefined || args.seo_description !== undefined ? compact({ title: args.seo_title, description: args.seo_description }) : undefined,
          collectionsToJoin: args.collections_to_join?.map((id: string, at: number) => gid('Collection', id, `collections_to_join[${at}]`)),
          collectionsToLeave: args.collections_to_leave?.map((id: string, at: number) => gid('Collection', id, `collections_to_leave[${at}]`)),
        });
        if (args.description_html === '') product['descriptionHtml'] = '';
        if (args.tags?.length === 0) product['tags'] = [];
        if (Object.keys(product).length === 1) throw new ToolFailure('Nothing to change: give at least one field besides id. Nothing was sent.');
        const response = await graphql(h, `mutation UpdateProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id title handle status vendor productType tags updatedAt onlineStoreUrl seo { title description } }
    userErrors { field message }
  }
}`, { product }, { write: true });
        const payload = response.data?.productUpdate;
        assertNoUserErrors(payload, 'update the product');
        const saved = payload?.product;
        return withWarnings(compact({
          id: saved?.id,
          title: saved?.title,
          handle: saved?.handle,
          status: saved?.status,
          vendor: saved?.vendor,
          productType: saved?.productType,
          tags: saved?.tags,
          seo: saved?.seo?.title || saved?.seo?.description ? compact({ title: saved.seo.title, description: saved.seo.description }) : undefined,
          onlineStoreUrl: saved?.onlineStoreUrl,
          updatedAt: saved?.updatedAt,
        }), response);
      },
    },
    {
      // A create, not an update: every call adds the images again.
      name: 'add_product_images',
      kind: 'create',
      check: 'get_product',
      title: 'Add images to a Shopify product',
      description:
        'Adds images to a product from public URLs; Shopify downloads and processes them in the background. Each call adds them again: '
        + 'it is not retried, and after an unclear outcome look at the product\'s media with get_product before sending it again. Returns '
        + 'the product\'s media count and its newest media with their processing status.',
      inputSchema: {
        type: 'object',
        properties: {
          product_id: ID('Product', 'The product id'),
          images: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public image URL.' }, alt: { type: 'string', maxLength: 512 } },
              required: ['url'],
              additionalProperties: false,
            },
            description: 'The images to add, from public URLs.',
          },
        },
        required: ['product_id', 'images'],
        additionalProperties: false,
      },
      async run(args: { product_id: string; images: Array<{ url: string; alt?: string }> }, h) {
        const media = args.images.map((image) => compact({ originalSource: image.url, alt: image.alt, mediaContentType: 'IMAGE' }));
        const response = await graphql(h, `mutation AddProductImages($product: ProductUpdateInput!, $media: [CreateMediaInput!], $count: Int!) {
  productUpdate(product: $product, media: $media) {
    product { id title mediaCount { count } media(first: $count, sortKey: CREATED_AT, reverse: true) { nodes { id alt mediaContentType status preview { image { url } } } } }
    userErrors { field message }
  }
}`, { product: { id: gid('Product', args.product_id, 'product_id') }, media, count: media.length }, { write: true });
        const payload = response.data?.productUpdate;
        assertNoUserErrors(payload, 'add the images');
        const saved = payload?.product;
        const newest: any[] = Array.isArray(saved?.media?.nodes) ? saved.media.nodes : [];
        return withWarnings(compact({
          id: saved?.id,
          title: saved?.title,
          imagesAdded: media.length,
          mediaCount: saved?.mediaCount?.count,
          newestMedia: newest.length
            ? newest.map((item) => compact({ id: item?.id, type: item?.mediaContentType, status: item?.status, alt: item?.alt, url: item?.preview?.image?.url }))
            : undefined,
          note: 'Shopify processes new images in the background: their status turns READY, or FAILED for a URL it could not fetch.',
        }), response);
      },
    },
    {
      name: 'update_variants',
      kind: 'update',
      check: 'get_product',
      title: 'Update Shopify variants',
      description:
        'Changes variants of one product: price, compare-at price ("" removes it), SKU, barcode, inventory policy, taxable, whether stock '
        + 'is tracked, cost and shipping. All or nothing: if Shopify refuses one, none change. Stock quantities: set_inventory_quantity.',
      inputSchema: {
        type: 'object',
        properties: {
          product_id: ID('Product', 'The product id'),
          variants: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              properties: { id: ID('ProductVariant', 'The variant id'), ...VARIANT_FIELDS },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        required: ['product_id', 'variants'],
        additionalProperties: false,
      },
      async run(args: { product_id: string; variants: Array<VariantArgs & { id: string }> }, h) {
        const variants = args.variants.map((variant, index) => {
          const input = { id: gid('ProductVariant', variant.id, `variants[${index}].id`), ...variantInput(variant, true) };
          if (Object.keys(input).length === 1) throw new ToolFailure(`variants[${index}] changes nothing: give a field besides id. Nothing was sent.`);
          return input;
        });
        const response = await graphql(h, `mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id title sku barcode price compareAtPrice inventoryPolicy taxable inventoryItem { id tracked requiresShipping } }
    userErrors { field message code }
  }
}`, { productId: gid('Product', args.product_id, 'product_id'), variants }, { write: true });
        const payload = response.data?.productVariantsBulkUpdate;
        assertNoUserErrors(payload, 'update the variants');
        return withWarnings({ variants: Array.isArray(payload?.productVariants) ? payload.productVariants.map(trimVariant) : [] }, response);
      },
    },
    {
      name: 'list_publications',
      kind: 'read',
      title: 'List Shopify sales channels',
      description:
        'Lists the shop\'s publications (sales channels such as the Online Store) with their ids for publish_product; with product_id, '
        + 'whether that product is published on each of them.',
      inputSchema: {
        type: 'object',
        properties: { product_id: ID('Product', 'A product to show the publishing state of') },
        additionalProperties: false,
      },
      async run(args: { product_id?: string }, h) {
        if (args.product_id === undefined) {
          const response = await graphql(h, `query Publications { publications(first: 50) { nodes { id name autoPublish supportsFuturePublishing catalog { title } } } }`);
          const nodes: any[] = Array.isArray(response.data?.publications?.nodes) ? response.data.publications.nodes : [];
          return withWarnings({
            publications: nodes.map((publication) => compact({
              id: publication?.id,
              name: publication?.catalog?.title ?? publication?.name,
              autoPublish: publication?.autoPublish === true ? true : undefined,
              futurePublishing: publication?.supportsFuturePublishing === true ? true : undefined,
            })),
          }, response);
        }
        const response = await graphql(h, `query ProductPublications($id: ID!) {
  product(id: $id) { id title status resourcePublicationsV2(first: 50, onlyPublished: false) { nodes { isPublished publishDate publication { id name catalog { title } } } } }
}`, { id: gid('Product', args.product_id, 'product_id') });
        const product = response.data?.product;
        if (!product) throw new ToolFailure('Shopify found no product with that id.');
        const nodes: any[] = Array.isArray(product.resourcePublicationsV2?.nodes) ? product.resourcePublicationsV2.nodes : [];
        return withWarnings({
          product: compact({ id: product.id, title: product.title, status: product.status }),
          publications: nodes.map((node) => compact({
            id: node?.publication?.id,
            name: node?.publication?.catalog?.title ?? node?.publication?.name,
            published: node?.isPublished === true,
            publishDate: node?.publishDate,
          })),
        }, response);
      },
    },
    {
      name: 'publish_product',
      kind: 'update',
      check: 'list_publications',
      title: 'Publish a Shopify product to sales channels',
      description:
        'Publishes a product on sales channels (publication ids from list_publications), or takes it off them with unpublish: true. '
        + 'Customers see it only when its status is ACTIVE too.',
      inputSchema: {
        type: 'object',
        properties: {
          product_id: ID('Product', 'The product id'),
          publication_ids: ID_LIST('Publication', 'The publications (sales channels).'),
          unpublish: { type: 'boolean', default: false, description: 'Take it off these channels instead.' },
        },
        required: ['product_id', 'publication_ids'],
        additionalProperties: false,
      },
      async run(args: { product_id: string; publication_ids: string[]; unpublish: boolean }, h) {
        if (!args.publication_ids.length) throw new ToolFailure('publication_ids must name at least one publication. Nothing was sent.');
        const field = args.unpublish ? 'publishableUnpublish' : 'publishablePublish';
        const response = await graphql(h, `mutation Publish($id: ID!, $input: [PublicationInput!]!) {
  ${field}(id: $id, input: $input) { publishable { ... on Product { id title status } } userErrors { field message } }
}`, {
          id: gid('Product', args.product_id, 'product_id'),
          input: args.publication_ids.map((id, at) => ({ publicationId: gid('Publication', id, `publication_ids[${at}]`) })),
        }, { write: true });
        const payload = response.data?.[field];
        assertNoUserErrors(payload, args.unpublish ? 'unpublish the product' : 'publish the product');
        const product = payload?.publishable;
        return withWarnings(compact({
          id: product?.id,
          title: product?.title,
          status: product?.status,
          published: !args.unpublish,
          publications: args.publication_ids.length,
          note: !args.unpublish && product?.status && product.status !== 'ACTIVE' ? `Published, but its status is ${product.status}: customers see it once it is ACTIVE.` : undefined,
        }), response);
      },
    },
    {
      name: 'list_collections',
      kind: 'read',
      title: 'List Shopify collections',
      description: 'Lists collections with their id, title, handle, product count, and for a smart collection its rules. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_COLLECTIONS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_COLLECTIONS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Collections($first: Int!, $after: String, $query: String, $sortKey: CollectionSortKeys, $reverse: Boolean) {
  collections(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { id title handle updatedAt sortOrder productsCount { count } ruleSet { appliedDisjunctively rules { column relation condition } } }
    pageInfo { hasNextPage endCursor }
  }
}`, { first: f['first'] ?? 50, after: position.after ?? null, query: f['query'] ?? null, sortKey: f['sort_key'] ?? 'UPDATED_AT', reverse: f['reverse'] ?? true });
        const connection = response.data?.collections;
        const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'collections',
          items: nodes.map((collection) => compact({
            id: collection?.id,
            title: collection?.title,
            handle: collection?.handle,
            kind: collection?.ruleSet ? 'smart' : 'manual',
            products: collection?.productsCount?.count,
            rules: Array.isArray(collection?.ruleSet?.rules) && collection.ruleSet.rules.length
              ? collection.ruleSet.rules.map((rule: any) => `${rule?.column} ${rule?.relation} ${rule?.condition ?? ''}`.trim()).join(collection.ruleSet.appliedDisjunctively ? ' OR ' : ' AND ')
              : undefined,
            sortOrder: collection?.sortOrder,
            updatedAt: collection?.updatedAt,
          })).slice(position.skip),
          extra: response.warnings.length ? { warnings: response.warnings.slice(0, 5) } : {},
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'list_locations',
      kind: 'read',
      title: 'List Shopify locations',
      description: 'Lists the shop\'s locations (warehouses, stores) with their ids for stock: name, whether active and fulfilling online orders, and city and country.',
      inputSchema: LIST_LOCATIONS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_LOCATIONS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Locations($first: Int!, $after: String, $includeInactive: Boolean) {
  locations(first: $first, after: $after, includeInactive: $includeInactive) { nodes { id name isActive fulfillsOnlineOrders address { city countryCode } } pageInfo { hasNextPage endCursor } }
}`, { first: f['first'] ?? 50, after: position.after ?? null, includeInactive: f['include_inactive'] ?? false });
        const connection = response.data?.locations;
        const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'locations',
          items: nodes.map((location) => compact({
            id: location?.id,
            name: location?.name,
            active: location?.isActive,
            fulfillsOnlineOrders: location?.fulfillsOnlineOrders,
            city: location?.address?.city,
            country: location?.address?.countryCode,
          })).slice(position.skip),
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'get_inventory',
      kind: 'read',
      title: 'Get Shopify stock levels',
      description:
        'The stock of one variant (or inventory item) at each location: available, on hand, committed, incoming and reserved, with the '
        + 'location ids and the inventory item id set_inventory_quantity needs.',
      inputSchema: {
        type: 'object',
        properties: {
          variant_id: ID('ProductVariant', 'The variant id'),
          inventory_item_id: ID('InventoryItem', 'Or the inventory item id'),
        },
        additionalProperties: false,
      },
      async run(args: { variant_id?: string; inventory_item_id?: string }, h) {
        if ((args.variant_id === undefined) === (args.inventory_item_id === undefined)) throw new ToolFailure('Give variant_id or inventory_item_id (one of them). Nothing was sent.');
        const response = args.variant_id !== undefined
          ? await graphql(h, `query VariantStock($id: ID!) { productVariant(id: $id) { id title product { id title } inventoryItem { ...Levels } } }\n${INVENTORY_LEVELS}`, { id: gid('ProductVariant', args.variant_id, 'variant_id') })
          : await graphql(h, `query ItemStock($id: ID!) { inventoryItem(id: $id) { ...Levels variant { id title product { id title } } } }\n${INVENTORY_LEVELS}`, { id: gid('InventoryItem', args.inventory_item_id as string, 'inventory_item_id') });
        const variant = args.variant_id !== undefined ? response.data?.productVariant : response.data?.inventoryItem?.variant;
        const item = args.variant_id !== undefined ? response.data?.productVariant?.inventoryItem : response.data?.inventoryItem;
        if (!item) throw new ToolFailure(`Shopify found no ${args.variant_id !== undefined ? 'variant' : 'inventory item'} with that id.`);
        const levels: any[] = Array.isArray(item.inventoryLevels?.nodes) ? item.inventoryLevels.nodes : [];
        return withWarnings(compact({
          inventoryItemId: item.id,
          sku: item.sku,
          tracked: item.tracked,
          variant: variant ? compact({ id: variant.id, title: variant.title, product: variant.product?.title, productId: variant.product?.id }) : undefined,
          levels: levels.map((level) => ({
            locationId: level?.location?.id,
            location: level?.location?.name,
            ...Object.fromEntries((Array.isArray(level?.quantities) ? level.quantities : []).map((quantity: any) => [quantity?.name, quantity?.quantity])),
            updatedAt: level?.updatedAt,
          })),
        }), response);
      },
    },
    {
      name: 'set_inventory_quantity',
      kind: 'update',
      check: 'get_inventory',
      title: 'Set a Shopify stock quantity',
      description:
        'Sets the available (or on hand) quantity of one variant at one location. Shopify applies it only if the stock is still '
        + 'expected_quantity (the number seen when deciding; without it, the stock is read right before). skip_quantity_check: true '
        + 'overwrites whatever is there. The same call sent again within 15 minutes is applied once.',
      inputSchema: {
        type: 'object',
        properties: {
          variant_id: ID('ProductVariant', 'The variant id'),
          inventory_item_id: ID('InventoryItem', 'Or its inventory item id'),
          location_id: ID('Location', 'The location id (list_locations or get_inventory)'),
          quantity: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000_000, description: 'The new quantity.' },
          expected_quantity: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000_000, description: 'The current quantity seen when deciding.' },
          skip_quantity_check: { type: 'boolean', default: false, description: 'Overwrite without comparing (only when this system is the source of truth).' },
          name: { type: 'string', enum: ['available', 'on_hand'], default: 'available' },
          reason: { type: 'string', enum: INVENTORY_REASONS, default: 'correction' },
          reference_document_uri: { type: 'string', maxLength: 500, pattern: '^[a-z][a-z0-9+.-]*:\\S+$', description: 'A URI of the document behind the change, e.g. a purchase order.' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]+$', description: 'Your own key for this change (default: made from the arguments).' },
        },
        required: ['location_id', 'quantity'],
        additionalProperties: false,
      },
      async run(args: any, h) {
        if ((args.variant_id === undefined) === (args.inventory_item_id === undefined)) throw new ToolFailure('Give variant_id or inventory_item_id (one of them). Nothing was sent.');
        if (args.skip_quantity_check && args.expected_quantity !== undefined) throw new ToolFailure('Give expected_quantity or skip_quantity_check, not both. Nothing was sent.');
        const locationId = gid('Location', args.location_id, 'location_id');
        let itemId = args.inventory_item_id !== undefined ? gid('InventoryItem', args.inventory_item_id, 'inventory_item_id') : undefined;
        let previous: number | null | undefined = args.skip_quantity_check ? null : args.expected_quantity;
        if (itemId === undefined || previous === undefined) {
          const level = `id tracked inventoryLevel(locationId: $locationId) { quantities(names: [$name]) { name quantity } }`;
          const response = itemId === undefined
            ? await graphql(h, `query Stock($id: ID!, $locationId: ID!, $name: String!) { productVariant(id: $id) { inventoryItem { ${level} } } }`, {
              id: gid('ProductVariant', args.variant_id, 'variant_id'),
              locationId,
              name: args.name,
            })
            : await graphql(h, `query Stock($id: ID!, $locationId: ID!, $name: String!) { inventoryItem(id: $id) { ${level} } }`, { id: itemId, locationId, name: args.name });
          const item = itemId === undefined ? response.data?.productVariant?.inventoryItem : response.data?.inventoryItem;
          if (!item?.id) throw new ToolFailure(`Shopify found no ${itemId === undefined ? 'variant' : 'inventory item'} with that id. Nothing was changed.`);
          itemId = item.id as string;
          if (previous === undefined) {
            if (!item.inventoryLevel) {
              throw new ToolFailure(
                'The item is not stocked at that location: activate it there first (inventoryActivate, through graphql_mutation), '
                  + 'or choose a location get_inventory lists. Nothing was changed.',
              );
            }
            const current = (Array.isArray(item.inventoryLevel.quantities) ? item.inventoryLevel.quantities : []).find((quantity: any) => quantity?.name === args.name);
            previous = typeof current?.quantity === 'number' ? current.quantity : null;
          }
        }
        const input = compact({
          name: args.name,
          reason: args.reason,
          referenceDocumentUri: args.reference_document_uri,
          quantities: [{ inventoryItemId: itemId, locationId, quantity: args.quantity, changeFromQuantity: previous ?? null }],
        });
        const key = args.idempotency_key ?? await idempotencyKey(input);
        const response = await graphql(h, `mutation SetQuantity($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { createdAt reason referenceDocumentUri changes { name delta quantityAfterChange location { id name } } }
    userErrors { code field message }
  }
}`, { input, key }, { write: true });
        const payload = response.data?.inventorySetQuantities;
        const stale = Array.isArray(payload?.userErrors) && payload.userErrors.some((error: any) => error?.code === 'CHANGE_FROM_QUANTITY_STALE');
        if (stale) {
          throw new ToolFailure(
            `The stock is no longer ${previous}: it changed since it was read. Read it again with get_inventory and decide again. Nothing was changed.`,
            { vendorCode: 'CHANGE_FROM_QUANTITY_STALE' },
          );
        }
        assertNoUserErrors(payload, 'set the quantity');
        const group = payload?.inventoryAdjustmentGroup;
        return withWarnings(compact({
          inventoryItemId: itemId,
          locationId,
          name: args.name,
          previousQuantity: previous,
          quantity: args.quantity,
          changed: Boolean(group),
          changes: Array.isArray(group?.changes) && group.changes.length
            ? group.changes.map((change: any) => compact({ name: change?.name, delta: change?.delta, quantityAfterChange: change?.quantityAfterChange, location: change?.location?.name }))
            : undefined,
          idempotencyKey: key,
        }), response);
      },
    },
    {
      name: 'list_orders',
      kind: 'read',
      title: 'List Shopify orders',
      description:
        'Lists orders, newest first: id, name (#1001), date, payment and fulfillment status, total, refunds, item count, returns and tags. '
        + 'No customer details. query takes Shopify search syntax. Shopify shows the last 60 days unless the app may read all orders. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: LIST_ORDERS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_ORDERS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt closed test tags returnStatus currencyCode subtotalLineItemsQuantity
      currentTotalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } } }
    pageInfo { hasNextPage endCursor }
  }
}`, { first: f['first'] ?? 25, after: position.after ?? null, query: f['query'] ?? null, sortKey: f['sort_key'] ?? 'CREATED_AT', reverse: f['reverse'] ?? true });
        const connection = response.data?.orders;
        const orders: unknown[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'orders',
          items: orders.map(trimListOrder).slice(position.skip),
          extra: response.warnings.length ? { warnings: response.warnings.slice(0, 5) } : {},
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'get_order',
      kind: 'read',
      title: 'Get a Shopify order',
      description:
        'One order by id or name (#1001): totals, line items, fulfillment orders with what is left to ship (the ids fulfill_order '
        + 'needs), fulfillments with tracking, refunds, note and tags; with include_customer_details the customer, email, phone and '
        + 'addresses (which need Shopify\'s protected customer data access).',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID('Order', 'The order id'),
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'Or the order name, e.g. #1001.' },
          include_customer_details: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
      async run(args: { id?: string; name?: string; include_customer_details: boolean }, h) {
        if ((args.id === undefined) === (args.name === undefined)) throw new ToolFailure('Give id or name (one of them). Nothing was sent.');
        let order: any;
        let response: GraphqlResult;
        if (args.id !== undefined) {
          response = await graphql(h, `query Order($id: ID!, $contact: Boolean!) { order(id: $id) { ...OrderDetail } }\n${ORDER_DETAIL}`, {
            id: gid('Order', args.id, 'id'),
            contact: args.include_customer_details,
          });
          order = response.data?.order;
        } else {
          // The name first, with a query that asks for nothing else: a page of full orders would cost more than Shopify runs.
          const name = args.name as string;
          const lookup = await graphql(h, 'query OrderIdByName($query: String!) { orders(first: 5, query: $query) { nodes { id name } } }', { query: `name:${searchValue(name)}` });
          const wanted = name.replace(/^#/, '');
          const match = (Array.isArray(lookup.data?.orders?.nodes) ? lookup.data.orders.nodes : []).find((node: any) => String(node?.name ?? '').replace(/^#/, '') === wanted);
          if (typeof match?.id !== 'string') throw new ToolFailure('Shopify found no order with that name.');
          response = await graphql(h, `query Order($id: ID!, $contact: Boolean!) { order(id: $id) { ...OrderDetail } }\n${ORDER_DETAIL}`, {
            id: match.id,
            contact: args.include_customer_details,
          });
          order = response.data?.order;
        }
        if (!order) throw new ToolFailure(`Shopify found no order with that ${args.id !== undefined ? 'id' : 'name'}.`);
        return withWarnings(trimOrder(order), response);
      },
    },
    {
      name: 'fulfill_order',
      kind: 'create',
      check: 'get_order',
      title: 'Fulfill a Shopify order',
      description:
        'Marks items of one fulfillment order as shipped (ids from get_order): all that is left, or the line items and quantities given, '
        + 'with optional tracking. notify_customer: true makes Shopify email the customer. Needs the staff permission to fulfill orders.',
      inputSchema: {
        type: 'object',
        properties: {
          fulfillment_order_id: ID('FulfillmentOrder', 'The fulfillment order id'),
          line_items: {
            type: 'array',
            maxItems: 250,
            items: {
              type: 'object',
              properties: { id: ID('FulfillmentOrderLineItem', 'The fulfillment order line item id'), quantity: { type: 'integer', minimum: 1 } },
              required: ['id', 'quantity'],
              additionalProperties: false,
            },
            description: 'Only these items and quantities (default: everything left).',
          },
          tracking_company: { type: 'string', maxLength: 255, description: 'The carrier, e.g. "DHL Express".' },
          tracking_number: { type: 'string', maxLength: 255 },
          tracking_url: { type: 'string', format: 'uri', maxLength: 2000 },
          notify_customer: { type: 'boolean', default: false },
        },
        required: ['fulfillment_order_id'],
        additionalProperties: false,
      },
      async run(args: any, h) {
        const tracking = compact({ company: args.tracking_company, number: args.tracking_number, url: args.tracking_url });
        const fulfillment = compact({
          lineItemsByFulfillmentOrder: [compact({
            fulfillmentOrderId: gid('FulfillmentOrder', args.fulfillment_order_id, 'fulfillment_order_id'),
            fulfillmentOrderLineItems: Array.isArray(args.line_items) && args.line_items.length
              ? args.line_items.map((item: any, at: number) => ({ id: gid('FulfillmentOrderLineItem', item.id, `line_items[${at}].id`), quantity: item.quantity }))
              : undefined,
          })],
          trackingInfo: Object.keys(tracking).length ? tracking : undefined,
          notifyCustomer: args.notify_customer,
        });
        const response = await graphql(h, `mutation Fulfill($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status createdAt trackingInfo(first: 5) { company number url } fulfillmentLineItems(first: 50) { nodes { quantity lineItem { name sku } } } }
    userErrors { field message }
  }
}`, { fulfillment }, { write: true });
        const payload = response.data?.fulfillmentCreate;
        assertNoUserErrors(payload, 'fulfill the items');
        const created = payload?.fulfillment;
        return withWarnings(compact({
          id: created?.id,
          status: created?.status,
          createdAt: created?.createdAt,
          tracking: Array.isArray(created?.trackingInfo) && created.trackingInfo.length ? created.trackingInfo.map((info: any) => compact(info ?? {})) : undefined,
          items: Array.isArray(created?.fulfillmentLineItems?.nodes)
            ? created.fulfillmentLineItems.nodes.map((item: any) => compact({ name: item?.lineItem?.name, sku: item?.lineItem?.sku, quantity: item?.quantity }))
            : undefined,
          customerNotified: args.notify_customer,
        }), response);
      },
    },
    {
      name: 'list_customers',
      kind: 'read',
      title: 'List Shopify customers',
      description:
        'Lists customers, most recently updated first: id, name, state, number of orders, amount spent and tags; with include_contact '
        + 'their email and phone. query takes Shopify search syntax, such as an exact email. Names and contacts need Shopify\'s protected '
        + 'customer data access. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_CUSTOMERS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_CUSTOMERS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Customers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys, $reverse: Boolean, $contact: Boolean!) {
  customers(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { id firstName lastName state tags numberOfOrders amountSpent { amount currencyCode } createdAt updatedAt
      defaultEmailAddress @include(if: $contact) { emailAddress } defaultPhoneNumber @include(if: $contact) { phoneNumber } }
    pageInfo { hasNextPage endCursor }
  }
}`, { first: f['first'] ?? 25, after: position.after ?? null, query: f['query'] ?? null, sortKey: f['sort_key'] ?? 'UPDATED_AT', reverse: f['reverse'] ?? true, contact: f['include_contact'] === true });
        const connection = response.data?.customers;
        const customers: unknown[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'customers',
          items: customers.map(trimCustomer).slice(position.skip),
          extra: response.warnings.length ? { warnings: response.warnings.slice(0, 5) } : {},
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'list_discounts',
      kind: 'read',
      title: 'List Shopify discounts',
      description:
        'Lists discounts, code and automatic: kind, title, status, summary, codes, dates, usage limit and times used; or one by its '
        + 'exact code. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_DISCOUNTS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        if (typeof args['code'] === 'string') {
          if (args['query'] !== undefined || args['cursor'] !== undefined) throw new ToolFailure('code finds one discount: give it without query or cursor. Nothing was sent.');
          const response = await graphql(h, `query DiscountByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ${CODE_DISCOUNT_FIELDS} } } }`, { code: args['code'] });
          const node = response.data?.codeDiscountNodeByCode;
          return withWarnings({ discounts: node ? [trimDiscount(node.id, node.codeDiscount)] : [] }, response);
        }
        const position = listPosition(h, LIST_DISCOUNTS_SCHEMA, args);
        const f = position.filters;
        const response = await graphql(h, `query Discounts($first: Int!, $after: String, $query: String, $sortKey: DiscountSortKeys, $reverse: Boolean) {
  discountNodes(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes { id discount { __typename ${CODE_DISCOUNT_FIELDS}
      ... on DiscountAutomaticBasic { title status summary startsAt endsAt }
      ... on DiscountAutomaticBxgy { title status summary startsAt endsAt }
      ... on DiscountAutomaticFreeShipping { title status summary startsAt endsAt }
      ... on DiscountAutomaticApp { title status startsAt endsAt } } }
    pageInfo { hasNextPage endCursor }
  }
}`, { first: f['first'] ?? 25, after: position.after ?? null, query: f['query'] ?? null, sortKey: f['sort_key'] ?? 'CREATED_AT', reverse: f['reverse'] ?? true });
        const connection = response.data?.discountNodes;
        const nodes: any[] = Array.isArray(connection?.nodes) ? connection.nodes : [];
        return h.page({
          key: 'discounts',
          items: nodes.map((node) => trimDiscount(node?.id, node?.discount)).slice(position.skip),
          extra: response.warnings.length ? { warnings: response.warnings.slice(0, 5) } : {},
          ...pageCursors(h, position, connection?.pageInfo),
        });
      },
    },
    {
      name: 'create_discount_code',
      kind: 'create',
      check: 'list_discounts',
      title: 'Create a Shopify discount code',
      description:
        'Creates a discount code for all customers: a percentage or a fixed amount off all items, or off some products, variants or '
        + 'collections, with optional start and end, total usage limit, once per customer, a minimum subtotal or quantity, and which '
        + 'other discounts it combines with. It works from starts_at (default now). Shopify refuses a code that exists.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 255, description: 'What customers enter.' },
          title: { type: 'string', maxLength: 255, description: 'The name in the admin (default: the code).' },
          percentage: { type: 'number', minimum: 0.01, maximum: 100, description: 'Percent off, e.g. 15.' },
          amount: MONEY('Or an amount off, in the shop\'s currency.'),
          applies_on_each_item: { type: 'boolean', default: false, description: 'With amount: off each item, not once per order.' },
          starts_at: { type: 'string', maxLength: 40, description: 'ISO date and time (default now).' },
          ends_at: { type: 'string', maxLength: 40, description: 'ISO date and time; none for no end.' },
          usage_limit: { type: 'integer', minimum: 1, description: 'Uses in all.' },
          once_per_customer: { type: 'boolean', default: false },
          minimum_subtotal: MONEY('The smallest order subtotal it works with.'),
          minimum_quantity: { type: 'integer', minimum: 1, description: 'Or the fewest items.' },
          product_ids: ID_LIST('Product', 'Only these products.'),
          variant_ids: ID_LIST('ProductVariant', 'Only these variants.'),
          collection_ids: ID_LIST('Collection', 'Only these collections.'),
          combines_with_order_discounts: { type: 'boolean', default: false },
          combines_with_product_discounts: { type: 'boolean', default: false },
          combines_with_shipping_discounts: { type: 'boolean', default: false },
        },
        required: ['code'],
        additionalProperties: false,
      },
      async run(args: any, h) {
        const refuse = (sentence: string): never => {
          throw new ToolFailure(`${sentence} Nothing was sent.`);
        };
        if ((args.percentage === undefined) === (args.amount === undefined)) refuse('Give percentage or amount (one of them).');
        if (args.minimum_subtotal !== undefined && args.minimum_quantity !== undefined) refuse('Give minimum_subtotal or minimum_quantity, not both.');
        const products = [...(args.product_ids ?? []).map((id: string, at: number) => gid('Product', id, `product_ids[${at}]`))];
        const variants = [...(args.variant_ids ?? []).map((id: string, at: number) => gid('ProductVariant', id, `variant_ids[${at}]`))];
        const collections = [...(args.collection_ids ?? []).map((id: string, at: number) => gid('Collection', id, `collection_ids[${at}]`))];
        if (collections.length && (products.length || variants.length)) refuse('Give collections or products and variants, not both.');
        for (const [name, value] of [['starts_at', args.starts_at], ['ends_at', args.ends_at]] as const) {
          if (value !== undefined && Number.isNaN(Date.parse(value))) refuse(`${name} is not a date and time, e.g. 2026-12-01T00:00:00Z.`);
        }
        const items = collections.length
          ? { collections: { add: collections } }
          : products.length || variants.length
            ? { products: compact({ productsToAdd: products.length ? products : undefined, productVariantsToAdd: variants.length ? variants : undefined }) }
            : { all: true };
        const input = compact({
          title: args.title ?? args.code,
          code: args.code,
          startsAt: args.starts_at ?? new Date().toISOString(),
          endsAt: args.ends_at,
          usageLimit: args.usage_limit,
          appliesOncePerCustomer: args.once_per_customer,
          context: { all: 'ALL' },
          customerGets: {
            value: args.percentage !== undefined
              ? { percentage: Math.round(args.percentage * 100) / 10_000 }
              : { discountAmount: { amount: args.amount, appliesOnEachItem: args.applies_on_each_item } },
            items,
          },
          minimumRequirement: args.minimum_subtotal !== undefined
            ? { subtotal: { greaterThanOrEqualToSubtotal: args.minimum_subtotal } }
            : args.minimum_quantity !== undefined ? { quantity: { greaterThanOrEqualToQuantity: String(args.minimum_quantity) } } : undefined,
          combinesWith: {
            orderDiscounts: args.combines_with_order_discounts,
            productDiscounts: args.combines_with_product_discounts,
            shippingDiscounts: args.combines_with_shipping_discounts,
          },
        });
        const response = await graphql(h, `mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id codeDiscount { __typename ... on DiscountCodeBasic { title status summary startsAt endsAt usageLimit appliesOncePerCustomer codes(first: 1) { nodes { code } } } } }
    userErrors { field message code }
  }
}`, { basicCodeDiscount: input }, { write: true });
        const payload = response.data?.discountCodeBasicCreate;
        assertNoUserErrors(payload, 'create the discount');
        const node = payload?.codeDiscountNode;
        return withWarnings(trimDiscount(node?.id, node?.codeDiscount), response);
      },
    },
    {
      name: 'graphql_query',
      kind: 'read',
      title: 'Run a Shopify GraphQL query',
      description:
        `Runs one GraphQL query (not a mutation) on the shop's Admin API ${API_VERSION} with the connected app's scopes, for what the `
        + 'other tools do not cover: metafields, inventory items, returns, transactions, markets, bulk operation status and more. '
        + 'Returns data, errors next to partial data, and the query cost. Ask for few fields and items (connections with first/after); '
        + 'a query may cost at most 1,000 points. Reference: https://shopify.dev/docs/api/admin-graphql.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 50_000, description: 'The GraphQL document: query operations and fragments.' },
          variables: { type: 'object', description: 'Its variables.' },
          operation_name: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]{0,99}$', description: 'Which operation to run, when the document has several.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; variables?: Record<string, unknown>; operation_name?: string }, h) {
        const document = readDocument(args.query);
        if (document.operations.some((operation) => operation !== 'query')) {
          throw new ToolFailure('graphql_query runs queries only: send mutations with graphql_mutation. Nothing was sent.');
        }
        const response = await graphql(h, args.query, args.variables ?? {}, args.operation_name ? { operationName: args.operation_name } : {});
        return compact({ data: response.data, errors: response.warnings.length ? response.warnings : undefined, cost: response.cost });
      },
    },
    {
      name: 'graphql_mutation',
      kind: 'write',
      check: 'graphql_query',
      title: 'Run a Shopify GraphQL mutation',
      description:
        `Runs one GraphQL mutation on the shop's Admin API ${API_VERSION}, such as customerCreate, orderCancel, refundCreate, `
        + 'collectionCreate, productVariantsBulkCreate, productDelete, inventoryAdjustQuantities or tagsAdd. Inventory and refund '
        + 'mutations need @idempotent(key: "...") with a unique key. userErrors mean nothing changed. Sent once, never retried: check '
        + 'with graphql_query. Refused: webhook subscriptions, carrier and fulfillment service callbacks, server pixel endpoints, '
        + 'bulk mutations (bulkOperationRunMutation) and new access tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 50_000, description: 'The GraphQL document with the mutation.' },
          variables: { type: 'object', description: 'Its variables.' },
          operation_name: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]{0,99}$', description: 'Which operation to run, when the document has several.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; variables?: Record<string, unknown>; operation_name?: string }, h) {
        const document = readDocument(args.query);
        if (document.operations.includes('subscription')) throw new ToolFailure('Subscriptions cannot be sent. Nothing was sent.');
        if (!document.operations.includes('mutation')) throw new ToolFailure('The document holds no mutation: run queries with graphql_query. Nothing was sent.');
        const blocked = BLOCKED_MUTATIONS.filter((name) => document.names.has(name));
        if (blocked.length) throw new ToolFailure(`${blocked.join(', ')} cannot be sent through this connector. Nothing was sent.`);
        const needsKey = IDEMPOTENT_MUTATIONS.filter((name) => document.names.has(name));
        if (needsKey.length && !document.directives.has('idempotent')) {
          throw new ToolFailure(`${needsKey.join(', ')} needs @idempotent(key: "<a unique key>") after its arguments; reuse the key only to resend the same change. Nothing was sent.`);
        }
        const response = await graphql(h, args.query, args.variables ?? {}, { write: true, ...(args.operation_name ? { operationName: args.operation_name } : {}) });
        const data = response.data ?? {};
        const failed: string[] = [];
        let succeeded = 0;
        for (const [field, payload] of Object.entries<any>(data)) {
          if (Array.isArray(payload?.userErrors) && payload.userErrors.length) failed.push(field);
          else succeeded++;
        }
        if (failed.length && !succeeded) {
          const texts = failed.map((field) => `${field}: ${(data[field].userErrors as any[]).map((error) => `${Array.isArray(error?.field) ? `${error.field.join('.')} ` : ''}${String(error?.message ?? '')}`.trim()).join('; ')}`);
          throw new ToolFailure(`Shopify did not make the change: ${truncate(texts.join(' | '), 1500)}. Nothing was changed.`);
        }
        return compact({
          data,
          userErrors: failed.length ? `Shopify refused ${failed.join(', ')}; the rest was done.` : undefined,
          errors: response.warnings.length ? response.warnings : undefined,
          cost: response.cost,
        });
      },
    },
  ],
});

export = connector;
