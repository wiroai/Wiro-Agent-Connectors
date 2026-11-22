// WooCommerce, through the REST API v3 of the user's own store
// (https://woocommerce.github.io/woocommerce-rest-api-docs/).
//
// Credentials: `storeurl`, the store's WordPress address (with its
// subdirectory when WordPress is installed in one, such as
// https://example.com/shop), and `consumerkey` + `consumersecret`, a REST API
// key from WooCommerce -> Settings -> Advanced -> REST API. They go to that
// store only, as HTTP Basic auth over https, never as query parameters.

import {
  apiTools,
  defineConnector,
  OutcomeUnknown,
  ToolFailure,
  truncate,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  basicAuth,
  compact,
  cutHtml,
  decodeEntities,
  hasMore,
  listPosition,
  pageCursors,
  plainText,
  refuse,
  restPath,
  totalItems,
  wc,
  withHint,
} from './store.js';

type JsonSchema = ToolDefinition['inputSchema'];

const PRICE = (what: string): JsonSchema => ({ type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,6})?$', description: what });
const PRICE_OR_CLEAR = (what: string): JsonSchema => ({ type: 'string', pattern: '^(\\d{1,12}(\\.\\d{1,6})?)?$', description: what });
const ID_LIST = (what: string): JsonSchema => ({ type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100, uniqueItems: true, description: what });
const CURSOR_SCHEMA: JsonSchema = { type: 'string', description: 'nextCursor from the previous result (the other arguments then come from it).' };
const PER_PAGE = (fallback: number): JsonSchema => ({ type: 'integer', minimum: 1, maximum: 100, default: fallback, description: `1 to 100 (default ${fallback}).` });
const DATE: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2})?)?$', description: '2026-11-01 or 2026-11-01T00:00:00, store time.' };
const IMAGE: JsonSchema = {
  type: 'object',
  properties: {
    src: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public image URL (WooCommerce downloads it).' },
    id: { type: 'integer', minimum: 1, description: 'Or a media library id.' },
    alt: { type: 'string', maxLength: 500 },
  },
  additionalProperties: false,
};
const ATTRIBUTE: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 0, description: 'A global attribute id; leave out for a custom one.' },
    name: { type: 'string', maxLength: 200, description: 'E.g. "Size".' },
    options: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 100, description: 'E.g. ["S", "M"].' },
    visible: { type: 'boolean' },
    variation: { type: 'boolean', description: 'Used for variations.' },
  },
  additionalProperties: false,
};

const STOCK_STATUS: JsonSchema = { type: 'string', enum: ['instock', 'outofstock', 'onbackorder'] };

/** Fields a product and a variation share. */
const SHARED_FIELDS: Record<string, JsonSchema> = {
  sku: { type: 'string', maxLength: 100, description: 'Unique: WooCommerce refuses one another product has.' },
  regular_price: PRICE_OR_CLEAR('E.g. "49.00".'),
  sale_price: PRICE_OR_CLEAR('"" ends the sale.'),
  manage_stock: { type: 'boolean', description: 'Track stock.' },
  stock_quantity: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000_000 },
  stock_status: STOCK_STATUS,
  weight: { type: 'string', maxLength: 20, description: 'In the store\'s unit.' },
  description: { type: 'string', maxLength: 200_000, description: 'HTML.' },
};

/** Fields of a product only (not of a variation). */
const PRODUCT_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 500 },
  short_description: { type: 'string', maxLength: 20_000, description: 'HTML.' },
  categories: ID_LIST('Category ids; replaces the current ones.'),
  tags: ID_LIST('Tag ids; replaces the current ones.'),
  images: { type: 'array', items: IMAGE, maxItems: 20, description: 'The first is the main image; replaces the current ones.' },
};

const MORE_FIELDS: JsonSchema = {
  type: 'object',
  description:
    'Other fields of the WooCommerce product (or variation) API, e.g. {"date_on_sale_to": "2026-12-31", "backorders": "notify", '
    + '"low_stock_amount": 5, "dimensions": {"length": "10"}, "shipping_class": "bulky", "tax_class": "reduced-rate", '
    + '"catalog_visibility": "hidden", "featured": true, "slug": "blue-mug"}.',
};

/** What a variation takes when it is created with its product. */
const NEW_VARIATION: JsonSchema = {
  type: 'object',
  properties: {
    attributes: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 0 }, name: { type: 'string', maxLength: 200 }, option: { type: 'string', maxLength: 200 } },
        required: ['option'],
        additionalProperties: false,
      },
      description: 'One value per variation attribute: [{"name": "Size", "option": "M"}].',
    },
    regular_price: SHARED_FIELDS['regular_price'] as JsonSchema,
    sale_price: SHARED_FIELDS['sale_price'] as JsonSchema,
    sku: SHARED_FIELDS['sku'] as JsonSchema,
    manage_stock: SHARED_FIELDS['manage_stock'] as JsonSchema,
    stock_quantity: SHARED_FIELDS['stock_quantity'] as JsonSchema,
    stock_status: STOCK_STATUS,
    image: IMAGE,
  },
  required: ['attributes'],
  additionalProperties: false,
};

/** The arguments of create_product and update_product, which more_fields must not repeat. */
const CREATE_KEYS = ['type', 'status', 'attributes', 'variations', ...Object.keys(SHARED_FIELDS), ...Object.keys(PRODUCT_FIELDS)];
const UPDATE_KEYS = ['variation_id', 'expected_stock_quantity', 'status', 'image', ...Object.keys(SHARED_FIELDS), ...Object.keys(PRODUCT_FIELDS)];

const PRODUCT_STATUS: JsonSchema = { type: 'string', enum: ['draft', 'pending', 'private', 'publish'], description: 'publish puts it on sale in the shop.' };
const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash', 'checkout-draft'] as const;

function trimCategories(list: unknown): unknown {
  return Array.isArray(list) && list.length
    ? list.map((item: any) => compact({ id: item?.id, name: typeof item?.name === 'string' ? decodeEntities(item.name) : undefined }))
    : undefined;
}

function trimListProduct(product: any): Record<string, unknown> {
  return compact({
    id: product?.id,
    name: typeof product?.name === 'string' ? truncate(decodeEntities(product.name), 300) : undefined,
    type: product?.type,
    status: product?.status,
    sku: product?.sku,
    price: product?.price,
    regular_price: product?.regular_price,
    sale_price: product?.sale_price,
    on_sale: product?.on_sale === true ? true : undefined,
    stock_status: product?.stock_status,
    manage_stock: product?.manage_stock,
    stock_quantity: product?.manage_stock === true ? product?.stock_quantity : undefined,
    variations: Array.isArray(product?.variations) && product.variations.length ? product.variations.length : undefined,
    categories: trimCategories(product?.categories),
    featured: product?.featured === true ? true : undefined,
    total_sales: product?.total_sales,
    permalink: product?.permalink,
    date_modified: product?.date_modified,
  });
}

function trimImages(images: unknown): unknown {
  return Array.isArray(images) && images.length
    ? images.slice(0, 20).map((image: any) => compact({ id: image?.id, src: image?.src, alt: image?.alt }))
    : undefined;
}

function trimAttributes(attributes: unknown): unknown {
  return Array.isArray(attributes) && attributes.length
    ? attributes.map((attribute: any) => compact({
      id: attribute?.id || undefined,
      name: attribute?.name,
      option: attribute?.option,
      options: Array.isArray(attribute?.options) ? attribute.options : undefined,
      variation: attribute?.variation,
      visible: attribute?.visible,
    }))
    : undefined;
}

function trimDimensions(dimensions: any): unknown {
  return dimensions && (dimensions.length || dimensions.width || dimensions.height) ? compact({ length: dimensions.length, width: dimensions.width, height: dimensions.height }) : undefined;
}

function trimProduct(product: any): Record<string, unknown> {
  const description = cutHtml(product?.description, 8000);
  const short = cutHtml(product?.short_description, 2000);
  return compact({
    ...trimListProduct(product),
    stock_quantity: product?.stock_quantity ?? undefined,
    slug: product?.slug,
    catalog_visibility: product?.catalog_visibility,
    description: description.text,
    description_cut: description.cut,
    short_description: short.text,
    short_description_cut: short.cut,
    tags: trimCategories(product?.tags),
    images: trimImages(product?.images),
    attributes: trimAttributes(product?.attributes),
    default_attributes: trimAttributes(product?.default_attributes),
    backorders: product?.backorders,
    low_stock_amount: product?.low_stock_amount ?? undefined,
    weight: product?.weight,
    dimensions: trimDimensions(product?.dimensions),
    shipping_class: product?.shipping_class,
    tax_status: product?.tax_status,
    tax_class: product?.tax_class,
    virtual: product?.virtual === true ? true : undefined,
    downloadable: product?.downloadable === true ? true : undefined,
    external_url: product?.external_url,
    date_on_sale_from: product?.date_on_sale_from,
    date_on_sale_to: product?.date_on_sale_to,
    date_created: product?.date_created,
    variation_ids: Array.isArray(product?.variations) && product.variations.length ? product.variations.slice(0, 200) : undefined,
    variations: undefined,
  });
}

function trimVariation(variation: any): Record<string, unknown> {
  return compact({
    id: variation?.id,
    sku: variation?.sku,
    status: variation?.status,
    attributes: Array.isArray(variation?.attributes)
      ? variation.attributes.map((attribute: any) => `${attribute?.name}: ${attribute?.option}`).join(', ')
      : undefined,
    price: variation?.price,
    regular_price: variation?.regular_price,
    sale_price: variation?.sale_price,
    stock_status: variation?.stock_status,
    manage_stock: variation?.manage_stock,
    stock_quantity: variation?.stock_quantity ?? undefined,
    backorders: variation?.backorders,
    low_stock_amount: variation?.low_stock_amount ?? undefined,
    weight: variation?.weight,
    image: variation?.image?.src,
  });
}

function money(value: unknown): unknown {
  return value === '0.00' || value === '0' ? undefined : value;
}

function trimLineItem(item: any): Record<string, unknown> {
  return compact({
    id: item?.id,
    name: item?.name,
    product_id: item?.product_id || undefined,
    variation_id: item?.variation_id || undefined,
    sku: item?.sku,
    quantity: item?.quantity,
    price: item?.price,
    subtotal: item?.subtotal,
    total: item?.total,
    total_tax: money(item?.total_tax),
  });
}

function trimListOrder(order: any): Record<string, unknown> {
  const items: any[] = Array.isArray(order?.line_items) ? order.line_items : [];
  return compact({
    id: order?.id,
    number: order?.number,
    status: order?.status,
    date_created: order?.date_created,
    date_paid: order?.date_paid,
    date_completed: order?.date_completed,
    total: order?.total,
    currency: order?.currency,
    customer_id: order?.customer_id || undefined,
    payment_method_title: order?.payment_method_title,
    items: items.slice(0, 10).map((item) => compact({ name: item?.name, quantity: item?.quantity, total: item?.total, product_id: item?.product_id || undefined })),
    more_items: items.length > 10 ? items.length - 10 : undefined,
    refunded: Array.isArray(order?.refunds) && order.refunds.length ? order.refunds.reduce((sum: number, refund: any) => sum - Number(refund?.total ?? 0), 0).toFixed(2) : undefined,
  });
}

function trimAddress(address: any): Record<string, unknown> | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const value = compact({
    first_name: address.first_name,
    last_name: address.last_name,
    company: address.company,
    address_1: address.address_1,
    address_2: address.address_2,
    city: address.city,
    state: address.state,
    postcode: address.postcode,
    country: address.country,
    email: address.email,
    phone: address.phone,
  });
  return Object.keys(value).length ? value : undefined;
}

function trimOrder(order: any, withCustomer: boolean): Record<string, unknown> {
  return compact({
    id: order?.id,
    number: order?.number,
    status: order?.status,
    currency: order?.currency,
    date_created: order?.date_created,
    date_modified: order?.date_modified,
    date_paid: order?.date_paid,
    date_completed: order?.date_completed,
    total: order?.total,
    total_tax: money(order?.total_tax),
    shipping_total: money(order?.shipping_total),
    discount_total: money(order?.discount_total),
    prices_include_tax: order?.prices_include_tax,
    payment_method: order?.payment_method,
    payment_method_title: order?.payment_method_title,
    transaction_id: order?.transaction_id,
    customer_id: order?.customer_id || undefined,
    customer_note: order?.customer_note,
    created_via: order?.created_via,
    line_items: Array.isArray(order?.line_items) ? order.line_items.slice(0, 100).map(trimLineItem) : undefined,
    shipping_lines: Array.isArray(order?.shipping_lines) && order.shipping_lines.length
      ? order.shipping_lines.map((line: any) => compact({ id: line?.id, method_title: line?.method_title, method_id: line?.method_id, total: line?.total }))
      : undefined,
    fee_lines: Array.isArray(order?.fee_lines) && order.fee_lines.length ? order.fee_lines.map((line: any) => compact({ id: line?.id, name: line?.name, total: line?.total })) : undefined,
    coupon_lines: Array.isArray(order?.coupon_lines) && order.coupon_lines.length ? order.coupon_lines.map((line: any) => compact({ code: line?.code, discount: line?.discount })) : undefined,
    refunds: Array.isArray(order?.refunds) && order.refunds.length ? order.refunds.map((refund: any) => compact({ id: refund?.id, reason: refund?.reason, total: refund?.total })) : undefined,
    billing: withCustomer ? trimAddress(order?.billing) : undefined,
    shipping: withCustomer ? trimAddress(order?.shipping) : undefined,
  });
}

function trimCoupon(coupon: any): Record<string, unknown> {
  const list = (value: unknown) => (Array.isArray(value) && value.length ? value : undefined);
  return compact({
    id: coupon?.id,
    code: coupon?.code,
    status: coupon?.status,
    discount_type: coupon?.discount_type,
    amount: coupon?.amount,
    description: coupon?.description,
    date_expires: coupon?.date_expires,
    usage_count: coupon?.usage_count,
    usage_limit: coupon?.usage_limit ?? undefined,
    usage_limit_per_user: coupon?.usage_limit_per_user ?? undefined,
    limit_usage_to_x_items: coupon?.limit_usage_to_x_items ?? undefined,
    individual_use: coupon?.individual_use === true ? true : undefined,
    free_shipping: coupon?.free_shipping === true ? true : undefined,
    exclude_sale_items: coupon?.exclude_sale_items === true ? true : undefined,
    minimum_amount: money(coupon?.minimum_amount),
    maximum_amount: money(coupon?.maximum_amount),
    product_ids: list(coupon?.product_ids),
    excluded_product_ids: list(coupon?.excluded_product_ids),
    product_categories: list(coupon?.product_categories),
    excluded_product_categories: list(coupon?.excluded_product_categories),
    email_restrictions: list(coupon?.email_restrictions),
    date_created: coupon?.date_created,
  });
}

function trimCustomer(customer: any): Record<string, unknown> {
  return compact({
    id: customer?.id,
    email: customer?.email,
    first_name: customer?.first_name,
    last_name: customer?.last_name,
    username: customer?.username,
    role: customer?.role,
    is_paying_customer: customer?.is_paying_customer,
    orders_count: customer?.orders_count,
    total_spent: customer?.total_spent,
    date_created: customer?.date_created,
  });
}

function trimTerm(term: any): Record<string, unknown> {
  return compact({
    id: term?.id,
    name: typeof term?.name === 'string' ? decodeEntities(term.name) : undefined,
    slug: term?.slug,
    count: term?.count,
    parent: term?.parent || undefined,
    type: term?.type,
    description: plainText(term?.description, 200),
    image: term?.image?.src,
  });
}

/**
 * The REST body of a product, variation or order from the arguments given,
 * minus the tool's own options; more_fields adds other API fields, but never
 * one the tool takes as an argument of its own.
 */
function productBody(args: Record<string, unknown>, skip: string[], own: readonly string[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || skip.includes(key) || key === 'more_fields') continue;
    body[key] = value;
  }
  const more = args['more_fields'];
  if (more && typeof more === 'object') {
    const clash = Object.keys(more).filter((key) => own.includes(key) || key === 'id');
    if (clash.length) refuse(`more_fields must not repeat ${clash.join(', ')}: give ${clash.length > 1 ? 'them as arguments' : 'it as an argument'}.`);
    Object.assign(body, more);
  }
  return body;
}

/** A tool error's message without the closing "Nothing was changed.", for a sentence that goes on. */
function cause(error: ToolFailure | OutcomeUnknown): string {
  return error.message.replace(/\s*Nothing was changed\.?\s*$/, '').replace(/\.$/, '');
}

const LIST_PRODUCTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Words in the name or description.' },
    sku: { type: 'string', minLength: 1, maxLength: 100, description: 'Exact SKU (several: comma-separated).' },
    status: { type: 'string', enum: ['any', 'draft', 'pending', 'private', 'publish'], default: 'any' },
    type: { type: 'string', enum: ['simple', 'grouped', 'external', 'variable'] },
    category: { type: 'integer', minimum: 1, description: 'Category id.' },
    tag: { type: 'integer', minimum: 1, description: 'Tag id.' },
    stock_status: STOCK_STATUS,
    on_sale: { type: 'boolean' },
    featured: { type: 'boolean' },
    orderby: { type: 'string', enum: ['date', 'modified', 'id', 'title', 'slug', 'price', 'popularity', 'rating', 'menu_order'], default: 'date', description: 'popularity: by sales.' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
    per_page: PER_PAGE(20),
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const LIST_ORDERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'array', items: { type: 'string', enum: [...ORDER_STATUSES] }, minItems: 1, uniqueItems: true, description: 'E.g. ["processing", "on-hold"]; default all but trash.' },
    customer: { type: 'integer', minimum: 0, description: 'Customer id (0: guests).' },
    product: { type: 'integer', minimum: 1, description: 'Orders with this product id.' },
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Order number, name, email or address words.' },
    after: { ...DATE, description: 'Created after this date.' },
    before: { ...DATE, description: 'Created before this date.' },
    orderby: { type: 'string', enum: ['date', 'modified', 'id'], default: 'date' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
    per_page: PER_PAGE(20),
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const LIST_COUPONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 100, description: 'An exact code.' },
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Part of a code.' },
    orderby: { type: 'string', enum: ['date', 'modified', 'id', 'title'], default: 'date' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
    per_page: PER_PAGE(20),
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const LIST_CUSTOMERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Part of a name, email or user name.' },
    email: { type: 'string', minLength: 3, maxLength: 200, description: 'An exact email.' },
    role: { type: 'string', enum: ['customer', 'all', 'subscriber', 'shop_manager', 'administrator'], default: 'customer' },
    orderby: { type: 'string', enum: ['registered_date', 'id', 'name'], default: 'registered_date' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
    per_page: PER_PAGE(20),
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const TERM_ROUTES: Record<string, string> = {
  categories: '/products/categories',
  tags: '/products/tags',
  attributes: '/products/attributes',
  attribute_terms: '/products/attributes/{id}/terms',
  shipping_classes: '/products/shipping_classes',
};

function termRoute(taxonomy: string, attributeId: number | undefined): string {
  if (taxonomy === 'attribute_terms') {
    if (attributeId === undefined) refuse('attribute_terms needs attribute_id (from list_terms attributes).');
    return `/products/attributes/${attributeId}/terms`;
  }
  if (attributeId !== undefined) refuse('attribute_id is for attribute_terms only.');
  return TERM_ROUTES[taxonomy] as string;
}

const LIST_TERMS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    taxonomy: {
      type: 'string',
      enum: ['categories', 'tags', 'attributes', 'attribute_terms', 'shipping_classes'],
      default: 'categories',
      description: 'attributes: global product attributes; attribute_terms: an attribute\'s values.',
    },
    attribute_id: { type: 'integer', minimum: 1, description: 'For attribute_terms.' },
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Part of the name.' },
    slug: { type: 'string', pattern: '^[A-Za-z0-9%_-]{1,200}$' },
    parent: { type: 'integer', minimum: 0, description: 'Categories: children of this id (0: top level).' },
    hide_empty: { type: 'boolean', default: false },
    per_page: PER_PAGE(100),
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const REPORT_ROUTES: Record<string, string> = {
  sales: '/reports/sales',
  top_sellers: '/reports/top_sellers',
  orders_totals: '/reports/orders/totals',
  products_totals: '/reports/products/totals',
  customers_totals: '/reports/customers/totals',
  coupons_totals: '/reports/coupons/totals',
  reviews_totals: '/reports/reviews/totals',
};

const BLOCKED_WRITES: Record<string, string> = {
  webhooks: 'Webhooks cannot be created or changed through this connector.',
  payment_gateways: 'Payment gateway settings cannot be changed through this connector.',
  system_status: 'System status tools cannot be run through this connector.',
};

/** Keeps the generic tools to the store's WooCommerce routes. */
function storeGuard(request: ApiToolRequest): void {
  for (const key of Object.keys(request.query)) {
    // WordPress lets these override the route and the HTTP method of a request.
    if (/^(?:_method|rest_route)$/i.test(key)) refuse(`The query parameter ${key} is not allowed: give the route as the path and the method as method.`);
  }
  const [namespace, version, resource] = request.segments.map((segment) => segment.toLowerCase());
  if (namespace === 'wc-analytics') {
    if (request.method !== 'GET') refuse('The /wc-analytics/ reports are read-only here.');
    return;
  }
  if (namespace !== 'wc' || version !== 'v3') refuse('The path must start with /wc/v3/ (or /wc-analytics/ for reports).');
  if (request.method !== 'GET' && resource && Object.hasOwn(BLOCKED_WRITES, resource)) refuse(BLOCKED_WRITES[resource] as string);
}

async function findTerm(h: ToolHelpers, route: string, name: string, slug: string | undefined): Promise<any> {
  const { data } = await wc(h, route, { query: slug ? { slug, per_page: 10 } : { search: name, per_page: 100 } });
  const terms: any[] = Array.isArray(data) ? data : [];
  const wanted = name.trim().toLowerCase();
  return terms.find((term) => (slug && term?.slug === slug) || decodeEntities(String(term?.name ?? '')).trim().toLowerCase() === wanted);
}

const connector = defineConnector({
  vendor: 'woocommerce',
  label: 'WooCommerce',
  origins: [],
  originFields: ['storeurl'],
  credentials: ['storeurl', 'consumerkey', 'consumersecret'],
  credentialLabels: { storeurl: 'WooCommerce store URL', consumerkey: 'WooCommerce consumer key', consumersecret: 'WooCommerce consumer secret' },
  authHeaders: (credentials) => ({ authorization: basicAuth(credentials['consumerkey'] ?? '', credentials['consumersecret'] ?? '') }),
  tools: [
    {
      name: 'list_products',
      kind: 'read',
      title: 'List WooCommerce products',
      description:
        'Lists the store\'s products, newest first by default: id, name, type, status, SKU, prices, sale, stock, number of variations, '
        + 'categories, sales count and link. Filters: search words, exact SKU, status, type, category, tag, stock status, sale. '
        + 'Pass nextCursor back as cursor for more. Use it to check the connection.',
      inputSchema: LIST_PRODUCTS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_PRODUCTS_SCHEMA, args);
        const f = position.filters;
        const perPage = Number(f['per_page'] ?? 20);
        const response = await wc(h, '/products', {
          query: {
            _fields: 'id,name,type,status,sku,price,regular_price,sale_price,on_sale,stock_status,manage_stock,stock_quantity,variations,categories,featured,total_sales,permalink,date_modified',
            search: f['search'],
            sku: f['sku'],
            status: f['status'] ?? 'any',
            type: f['type'],
            category: f['category'],
            tag: f['tag'],
            stock_status: f['stock_status'],
            on_sale: f['on_sale'],
            featured: f['featured'],
            orderby: f['orderby'] ?? 'date',
            order: f['order'] ?? 'desc',
            per_page: perPage,
            page: position.page,
          },
        });
        const products: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'products',
          items: products.map(trimListProduct).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, products.length, perPage)),
        });
      },
    },
    {
      name: 'get_product',
      kind: 'read',
      title: 'Get a WooCommerce product',
      description:
        'One product with everything needed to edit it: prices, stock (and who manages it), description, images, categories, tags, '
        + 'attributes, shipping and tax fields, and for a variable product its variations with their attributes, prices and stock. Pass '
        + 'nextCursor back as cursor, with the same id, for more variations.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The product id.' },
          include_variations: { type: 'boolean', default: true, description: 'For a variable product, list its variations too (default true).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: { id: number; include_variations: boolean; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'number' && state['p'] >= 1 ? state['p'] : 1;
        const skip = typeof state?.['o'] === 'number' && state['o'] >= 0 ? state['o'] : 0;
        const { data: product } = await wc(h, `/products/${args.id}`);
        const result = trimProduct(product);
        if (product?.type !== 'variable' || !args.include_variations) return result;
        const response = await wc(h, `/products/${args.id}/variations`, { query: { per_page: 100, page } });
        const variations: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'variations',
          items: variations.map(trimVariation).slice(skip),
          extra: result,
          resumeAt: (index) => h.makeCursor({ p: page, o: skip + index }),
          ...(hasMore(response, page, variations.length, 100) ? { nextPage: h.makeCursor({ p: page + 1, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'create_product',
      kind: 'create',
      check: 'list_products',
      title: 'Create a WooCommerce product',
      description:
        'Creates a product, as a draft unless status says otherwise (publish puts it on sale). Images come from public URLs (WooCommerce '
        + 'downloads them). For a variable product, give attributes with variation: true and the variations to create with it; they are '
        + 'created right after the product, and the result says if any failed. WooCommerce refuses an SKU another product has.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PRODUCT_FIELDS,
          type: { type: 'string', enum: ['simple', 'variable', 'grouped', 'external'], default: 'simple' },
          status: { ...PRODUCT_STATUS, default: 'draft' },
          ...SHARED_FIELDS,
          attributes: { type: 'array', items: ATTRIBUTE, maxItems: 50, description: 'For a variable product, those with variation: true.' },
          variations: { type: 'array', items: NEW_VARIATION, maxItems: 100, description: 'Variable products: the variations to create with it.' },
          more_fields: MORE_FIELDS,
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const variations: any[] | undefined = args['variations'];
        if (variations?.length && args['type'] !== 'variable') refuse('variations are for type variable only.');
        const { data: product } = await wc(h, '/products', { method: 'POST', json: productBody(args, ['variations'], CREATE_KEYS), write: true });
        const result = trimProduct(product);
        if (!variations?.length) return result;
        const id = product?.id;
        if (typeof id !== 'number') throw new ToolFailure('WooCommerce answered without the new product\'s id, so its variations were not sent. Look for the product with list_products.');
        let batch: any;
        try {
          ({ data: batch } = await wc(h, `/products/${id}/variations/batch`, { method: 'POST', json: { create: variations }, write: true }));
        } catch (error) {
          const made = `WooCommerce created the product (id ${id}, status ${String(product?.status)})`;
          if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${made}, but its variations got no clear answer (${cause(error)}).`);
          if (error instanceof ToolFailure) {
            throw new ToolFailure(
              `${made}, but not its variations: ${cause(error)}. Add them with api_request (POST /wc/v3/products/${id}/variations/batch).`,
              error.details,
            );
          }
          throw error;
        }
        const created: any[] = Array.isArray(batch?.create) ? batch.create : [];
        const failed = created
          .map((item, index) => ({ index, item }))
          .filter(({ item }) => item?.error)
          .map(({ index, item }) => `variation ${index + 1}: ${String(item.error?.message ?? item.error?.code ?? 'refused')}`);
        return compact({
          ...result,
          variations: created.filter((item) => !item?.error).map(trimVariation),
          variation_errors: failed.length ? failed : undefined,
        });
      },
    },
    {
      name: 'update_product',
      kind: 'update',
      check: 'get_product',
      title: 'Update a WooCommerce product or variation',
      description:
        'Changes a product, or one of its variations with variation_id: prices, sale, stock, status (publish puts it on sale), text, '
        + 'images, categories and the rest. Only the fields given change. With expected_stock_quantity, the current stock is read first '
        + 'and nothing changes if it moved. Stock is changed where it is managed: a variation whose stock its parent manages is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The product id.' },
          variation_id: { type: 'integer', minimum: 1, description: 'Change this variation of the product instead.' },
          expected_stock_quantity: { type: 'integer', description: 'The stock read before deciding; nothing is sent if it changed.' },
          ...PRODUCT_FIELDS,
          status: PRODUCT_STATUS,
          ...SHARED_FIELDS,
          image: { ...IMAGE, description: 'Variations only.' },
          more_fields: MORE_FIELDS,
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const variationId: number | undefined = args['variation_id'];
        const route = variationId !== undefined ? `/products/${args['id']}/variations/${variationId}` : `/products/${args['id']}`;
        if (variationId !== undefined) {
          const productOnly = Object.keys(PRODUCT_FIELDS).filter((key) => args[key] !== undefined);
          if (productOnly.length) refuse(`${productOnly.join(', ')} ${productOnly.length > 1 ? 'are' : 'is'} for the product, not a variation.`);
          if (args['status'] !== undefined && !['publish', 'private'].includes(args['status'])) refuse('A variation\'s status is publish or private.');
        } else if (args['image'] !== undefined) {
          refuse('image is for variations: a product takes images.');
        }
        const body = productBody(args, ['id', 'variation_id', 'expected_stock_quantity'], UPDATE_KEYS);
        if (!Object.keys(body).length) refuse('Nothing to change: give at least one field besides id.');

        let previous: any;
        if (args['stock_quantity'] !== undefined || args['expected_stock_quantity'] !== undefined) {
          ({ data: previous } = await wc(h, route));
          const current = previous?.stock_quantity ?? null;
          if (args['expected_stock_quantity'] !== undefined && current !== args['expected_stock_quantity']) {
            refuse(`The stock is ${current === null ? 'not tracked' : current} now, not ${args['expected_stock_quantity']}: it changed since it was read. Read it again and decide again.`);
          }
          if (args['stock_quantity'] !== undefined && args['manage_stock'] === undefined) {
            if (previous?.manage_stock === 'parent') refuse('This variation\'s stock is managed by its parent product: change the stock on the product (without variation_id), or pass manage_stock: true to manage it on the variation from now on.');
            if (previous?.manage_stock === false) refuse('This item does not track stock: pass manage_stock: true with stock_quantity to start tracking it.');
          }
        }
        const { data } = await wc(h, route, { method: 'PUT', json: body, write: true });
        const trimmed = variationId !== undefined ? trimVariation(data) : trimProduct(data);
        return compact({ ...trimmed, previous_stock_quantity: previous !== undefined ? previous?.stock_quantity ?? null : undefined });
      },
    },
    {
      name: 'list_orders',
      kind: 'read',
      title: 'List WooCommerce orders',
      description:
        'Lists orders, newest first: number, status, dates, total, currency, customer id, payment method, the items with quantities '
        + 'and refunds. Filters: statuses, customer, product, dates, search words. No addresses or contact details (get_order has them '
        + 'on request). Pass nextCursor back as cursor for more.',
      inputSchema: LIST_ORDERS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_ORDERS_SCHEMA, args);
        const f = position.filters;
        const perPage = Number(f['per_page'] ?? 20);
        const response = await wc(h, '/orders', {
          query: {
            _fields: 'id,number,status,currency,date_created,date_paid,date_completed,total,customer_id,payment_method_title,line_items,refunds',
            status: Array.isArray(f['status']) ? f['status'].join(',') : undefined,
            customer: f['customer'],
            product: f['product'],
            search: f['search'],
            after: f['after'],
            before: f['before'],
            orderby: f['orderby'] ?? 'date',
            order: f['order'] ?? 'desc',
            per_page: perPage,
            page: position.page,
          },
        });
        const orders: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'orders',
          items: orders.map(trimListOrder).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, orders.length, perPage)),
        });
      },
    },
    {
      name: 'get_order',
      kind: 'read',
      title: 'Get a WooCommerce order',
      description:
        'One order with its line items (ids for refunds), shipping, fees, coupons, totals, payment method and refunds; with include_notes '
        + 'its notes, and with include_customer_details the billing and shipping names, addresses, email and phone.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The order id.' },
          include_notes: { type: 'boolean', default: false, description: 'Add the order notes.' },
          include_customer_details: { type: 'boolean', default: false, description: 'Add billing and shipping addresses, email and phone.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: { id: number; include_notes: boolean; include_customer_details: boolean }, h) {
        const { data: order } = await wc(h, `/orders/${args.id}`);
        const result = trimOrder(order, args.include_customer_details);
        if (!args.include_notes) return result;
        const { data: notes } = await wc(h, `/orders/${args.id}/notes`);
        return compact({
          ...result,
          notes: (Array.isArray(notes) ? notes : []).slice(0, 30).map((note: any) => compact({
            id: note?.id,
            date_created: note?.date_created,
            author: note?.author,
            note: plainText(note?.note, 400),
            customer_note: note?.customer_note === true ? true : undefined,
          })),
        });
      },
    },
    {
      name: 'update_order',
      kind: 'update',
      check: 'get_order',
      title: 'Update a WooCommerce order',
      description:
        'Changes an order\'s status (processing, on-hold, completed, cancelled, ...), customer note, or billing and shipping details. Only '
        + 'the fields given change. WooCommerce may email the customer on a status change (completed, for example) and restocks items '
        + 'of a cancelled order. Refunds go through create_refund.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The order id.' },
          status: { type: 'string', enum: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'failed'], description: 'The new status.' },
          customer_note: { type: 'string', maxLength: 5000, description: 'The note the customer left at checkout.' },
          billing: { type: 'object', description: 'Billing fields to change: first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone.' },
          shipping: { type: 'object', description: 'Shipping fields to change: first_name, last_name, company, address_1, address_2, city, state, postcode, country, phone.' },
          transaction_id: { type: 'string', maxLength: 200, description: 'The payment\'s transaction id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const body = productBody(args, ['id']);
        if (!Object.keys(body).length) refuse('Nothing to change: give at least one field besides id.');
        const { data } = await wc(h, `/orders/${args['id']}`, { method: 'PUT', json: body, write: true });
        return trimOrder(data, false);
      },
    },
    {
      name: 'add_order_note',
      kind: 'create',
      check: 'get_order',
      title: 'Add a note to a WooCommerce order',
      description:
        'Adds a note to an order. A private note (default) is for the store\'s staff; with customer_note: true WooCommerce emails it to '
        + 'the customer as well.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The order id.' },
          note: { type: 'string', minLength: 1, maxLength: 5000, description: 'The note.' },
          customer_note: { type: 'boolean', default: false, description: 'true emails the note to the customer.' },
        },
        required: ['id', 'note'],
        additionalProperties: false,
      },
      async run(args: { id: number; note: string; customer_note: boolean }, h) {
        const { data } = await wc(h, `/orders/${args.id}/notes`, { method: 'POST', json: { note: args.note, customer_note: args.customer_note }, write: true });
        return compact({ id: data?.id, order_id: args.id, date_created: data?.date_created, customer_note: data?.customer_note === true, note: plainText(data?.note, 1000) });
      },
    },
    {
      name: 'create_refund',
      kind: 'create',
      check: 'get_order',
      title: 'Refund a WooCommerce order',
      description:
        'Records a refund on an order: an amount, a reason, and optionally which line items (ids from get_order) and quantities. By '
        + 'default it only records the refund; refund_payment: true also sends the money back through the payment gateway, and '
        + 'restock_items: true puts the refunded items back in stock. A refund cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'integer', minimum: 1, description: 'The order id.' },
          amount: PRICE('E.g. "12.50"; at most what is left to refund.'),
          reason: { type: 'string', maxLength: 1000, description: 'Shown on the order.' },
          line_items: {
            type: 'array',
            maxItems: 100,
            description: 'The refunded line items (ids from get_order).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', minimum: 1 },
                quantity: { type: 'integer', minimum: 1 },
                refund_total: PRICE('Amount before tax.'),
                refund_tax: {
                  type: 'array',
                  maxItems: 20,
                  items: {
                    type: 'object',
                    properties: { id: { type: 'integer', minimum: 1, description: 'Tax rate id.' }, refund_total: PRICE('Tax refunded.') },
                    required: ['id', 'refund_total'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
          refund_payment: { type: 'boolean', default: false, description: 'Also refund through the payment gateway (default: record only).' },
          restock_items: { type: 'boolean', default: false, description: 'Put the refunded items back in stock.' },
        },
        required: ['order_id', 'amount'],
        additionalProperties: false,
      },
      async run(args: { order_id: number; amount: string; reason?: string; line_items?: unknown[]; refund_payment: boolean; restock_items: boolean }, h) {
        const { data } = await wc(h, `/orders/${args.order_id}/refunds`, {
          method: 'POST',
          json: compact({
            amount: args.amount,
            reason: args.reason,
            line_items: args.line_items,
            api_refund: args.refund_payment,
            api_restock: args.restock_items,
          }),
          write: true,
        });
        return compact({
          id: data?.id,
          order_id: args.order_id,
          amount: data?.amount,
          reason: data?.reason,
          date_created: data?.date_created,
          refunded_payment: data?.refunded_payment ?? args.refund_payment,
          restocked: args.restock_items,
          line_items: Array.isArray(data?.line_items) && data.line_items.length ? data.line_items.map(trimLineItem) : undefined,
        });
      },
    },
    {
      name: 'list_coupons',
      kind: 'read',
      title: 'List WooCommerce coupons',
      description:
        'Lists coupons with their code, discount type and amount, expiry, usage and limits, and restrictions. Look up an exact code before '
        + 'creating one. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_COUPONS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_COUPONS_SCHEMA, args);
        const f = position.filters;
        const perPage = Number(f['per_page'] ?? 20);
        const response = await wc(h, '/coupons', {
          query: { code: f['code'], search: f['search'], orderby: f['orderby'] ?? 'date', order: f['order'] ?? 'desc', per_page: perPage, page: position.page },
        });
        const coupons: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'coupons',
          items: coupons.map(trimCoupon).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, coupons.length, perPage)),
        });
      },
    },
    {
      name: 'create_coupon',
      kind: 'create',
      check: 'list_coupons',
      title: 'Create a WooCommerce coupon',
      description:
        'Creates a coupon: its code, a percent, fixed cart or fixed product discount, and optional expiry, usage limits, minimum and '
        + 'maximum spend, products, categories and allowed emails. It works as soon as it is created. WooCommerce refuses a code that '
        + 'exists already.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 100, description: 'What customers enter (stored in lower case).' },
          discount_type: { type: 'string', enum: ['percent', 'fixed_cart', 'fixed_product'], description: 'fixed_cart: an amount off the cart; fixed_product: off each product.' },
          amount: PRICE('A percentage for percent, an amount otherwise.'),
          description: { type: 'string', maxLength: 1000, description: 'A note for the staff.' },
          date_expires: { ...DATE, description: 'The day it expires.' },
          individual_use: { type: 'boolean', description: 'Not combinable with other coupons.' },
          usage_limit: { type: 'integer', minimum: 1, description: 'Uses in all.' },
          usage_limit_per_user: { type: 'integer', minimum: 1 },
          limit_usage_to_x_items: { type: 'integer', minimum: 1 },
          free_shipping: { type: 'boolean' },
          exclude_sale_items: { type: 'boolean' },
          minimum_amount: PRICE('Smallest order subtotal.'),
          maximum_amount: PRICE('Largest order subtotal.'),
          product_ids: ID_LIST('Only these products.'),
          excluded_product_ids: ID_LIST('Not these products.'),
          product_categories: ID_LIST('Only these category ids.'),
          excluded_product_categories: ID_LIST('Not these category ids.'),
          email_restrictions: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 200 }, maxItems: 100, description: 'Allowed billing emails (* wildcards).' },
        },
        required: ['code', 'discount_type', 'amount'],
        additionalProperties: false,
      },
      async run(args: Record<string, unknown>, h) {
        const { data } = await wc(h, '/coupons', { method: 'POST', json: productBody(args, []), write: true });
        return trimCoupon(data);
      },
    },
    {
      name: 'list_customers',
      kind: 'read',
      title: 'List WooCommerce customers',
      description:
        'Lists customers (store users) with id, email, name, user name, role and whether they have paid for an order. Look up an exact '
        + 'email before creating a customer. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_CUSTOMERS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_CUSTOMERS_SCHEMA, args);
        const f = position.filters;
        const perPage = Number(f['per_page'] ?? 20);
        const response = await wc(h, '/customers', {
          query: { search: f['search'], email: f['email'], role: f['role'] ?? 'customer', orderby: f['orderby'] ?? 'registered_date', order: f['order'] ?? 'desc', per_page: perPage, page: position.page },
        });
        const customers: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'customers',
          items: customers.map(trimCustomer).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, customers.length, perPage)),
        });
      },
    },
    {
      name: 'get_report',
      kind: 'read',
      title: 'Get a WooCommerce report',
      description:
        'A store report: sales (totals for a period with a line per day or month: sales, orders, items, tax, shipping, refunds, '
        + 'discounts), top_sellers (best-selling products), or the counts of orders, products, customers, coupons and reviews by status '
        + 'or type. Sales and top sellers take a period or a date range. Pass nextCursor back as cursor for more lines.',
      inputSchema: {
        type: 'object',
        properties: {
          report: {
            type: 'string',
            enum: Object.keys(REPORT_ROUTES),
            description: 'sales, top_sellers, orders_totals, products_totals, customers_totals, coupons_totals or reviews_totals.',
          },
          period: { type: 'string', enum: ['week', 'month', 'last_month', 'year'], description: 'sales and top_sellers: the period (default this week).' },
          date_min: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'sales and top_sellers: the first day, 2026-11-01.' },
          date_max: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'sales and top_sellers: the last day.' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['report'],
        additionalProperties: false,
      },
      async run(args: { report: string; period?: string; date_min?: string; date_max?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const dated = args.report === 'sales' || args.report === 'top_sellers';
        if (!dated && (args.period || args.date_min || args.date_max)) refuse(`${args.report} takes no period or dates.`);
        if (args.period && (args.date_min || args.date_max)) refuse('Give period or date_min and date_max, not both.');
        const { data } = await wc(h, REPORT_ROUTES[args.report] as string, {
          query: dated ? { period: args.period, date_min: args.date_min, date_max: args.date_max } : {},
        });
        const rows: any[] = Array.isArray(data) ? data : [];
        const resumeAt = (index: number) => h.makeCursor({ o: skip + index });
        if (args.report === 'sales') {
          const { totals, ...summary } = rows[0] ?? {};
          const lines = Object.entries(typeof totals === 'object' && totals !== null ? totals : {})
            .map(([date, values]: [string, any]) => compact({
              date,
              sales: values?.sales,
              orders: values?.orders,
              items: values?.items,
              tax: money(values?.tax),
              shipping: money(values?.shipping),
              discount: money(values?.discount),
              customers: values?.customers || undefined,
            }));
          return h.page({ key: 'totals', items: lines.slice(skip), extra: { report: 'sales', summary }, resumeAt });
        }
        if (args.report === 'top_sellers') {
          const sellers = rows.map((row) => compact({ product_id: row?.product_id, title: row?.title ?? row?.name, quantity: row?.quantity }));
          return h.page({ key: 'top_sellers', items: sellers.slice(skip), extra: { report: 'top_sellers' }, resumeAt });
        }
        const counts = rows.map((row) => compact({ slug: row?.slug, name: row?.name, total: row?.total }));
        return h.page({ key: 'counts', items: counts.slice(skip), extra: { report: args.report }, resumeAt });
      },
    },
    {
      name: 'list_terms',
      kind: 'read',
      title: 'List WooCommerce categories, tags, attributes or shipping classes',
      description:
        'Lists product categories, tags, global attributes, an attribute\'s values (attribute_terms with attribute_id) or shipping '
        + 'classes, with ids, names, slugs and product counts. Look up a slug or name before creating a term. Pass nextCursor back as '
        + 'cursor for more.',
      inputSchema: LIST_TERMS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_TERMS_SCHEMA, args);
        const f = position.filters;
        const taxonomy = String(f['taxonomy'] ?? 'categories');
        const route = termRoute(taxonomy, f['attribute_id']);
        if (taxonomy !== 'categories' && f['parent'] !== undefined) refuse('parent is for categories only.');
        const paged = taxonomy !== 'attributes';
        const perPage = Number(f['per_page'] ?? 100);
        const response = await wc(h, route, {
          query: paged
            ? { search: f['search'], slug: f['slug'], parent: f['parent'], hide_empty: f['hide_empty'] ? true : undefined, per_page: perPage, page: position.page }
            : {},
        });
        const terms: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: taxonomy,
          items: terms.map(trimTerm).slice(position.skip),
          extra: compact({ total: totalItems(response), page: paged ? position.page : undefined }),
          ...pageCursors(h, position, paged && hasMore(response, position.page, terms.length, perPage)),
        });
      },
    },
    {
      name: 'create_term',
      kind: 'create',
      check: 'list_terms',
      title: 'Create a WooCommerce category, tag, attribute value or shipping class',
      description:
        'Creates a product category, tag, attribute value (attribute_terms with attribute_id) or shipping class, and returns its id. When '
        + 'one with that name or slug already exists, this returns it with existing: true instead of making a second.',
      inputSchema: {
        type: 'object',
        properties: {
          taxonomy: { type: 'string', enum: ['categories', 'tags', 'attribute_terms', 'shipping_classes'], description: 'categories, tags, attribute_terms or shipping_classes.' },
          attribute_id: { type: 'integer', minimum: 1, description: 'For attribute_terms: the attribute id.' },
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The name.' },
          slug: { type: 'string', pattern: '^[A-Za-z0-9%_-]{1,200}$', description: 'The slug (default: made from the name).' },
          parent: { type: 'integer', minimum: 0, description: 'Categories only: the parent category id.' },
          description: { type: 'string', maxLength: 2000, description: 'A description.' },
        },
        required: ['taxonomy', 'name'],
        additionalProperties: false,
      },
      async run(args: { taxonomy: string; attribute_id?: number; name: string; slug?: string; parent?: number; description?: string }, h) {
        const route = termRoute(args.taxonomy, args.attribute_id);
        if (args.taxonomy !== 'categories' && args.parent !== undefined) refuse('parent is for categories only.');
        try {
          const { data } = await wc(h, route, { method: 'POST', json: compact({ name: args.name, slug: args.slug, parent: args.parent, description: args.description }), write: true });
          return { ...trimTerm(data), existing: false };
        } catch (error) {
          if (!(error instanceof ToolFailure) || error.details.vendorCode !== 'term_exists') throw error;
        }
        const existing = await findTerm(h, route, args.name, args.slug);
        if (!existing) throw new ToolFailure('WooCommerce says this term already exists, but it was not found by name: look for it with list_terms. Nothing was changed.');
        return { ...trimTerm(existing), existing: true };
      },
    },
    // The rest of the WooCommerce REST API v3: customers, variations, batches, settings, shipping, taxes, deletions.
    ...apiTools({
      label: 'WooCommerce',
      description:
        'The WooCommerce REST API v3 of the connected store: paths start with /wc/v3/, such as /wc/v3/customers/12, '
        + '/wc/v3/products/34/variations/batch or /wc/v3/settings/general (GET also reads /wc-analytics/ reports). DELETE needs '
        + 'force=true. Webhooks, payment gateways and system status tools are out of reach. Reference: https://woocommerce.github.io/woocommerce-rest-api-docs/.',
      guard: storeGuard,
      send: async (request, h) => {
        try {
          return await h.api({ ...request, origin: h.originOf('storeurl'), path: restPath(h, request.path) });
        } catch (error) {
          throw withHint(error);
        }
      },
      responseHeaders: ['x-wp-total', 'x-wp-totalpages'],
    }),
  ],
});

export = connector;
