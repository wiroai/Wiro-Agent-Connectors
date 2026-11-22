// The connected store's REST API (WooCommerce REST API v3 under the WordPress
// REST root): where it lives (a store may sit in a WordPress subdirectory, such
// as https://example.com/shop), how requests are signed (HTTP Basic auth with
// the consumer key and secret, never query parameters), list paging, and the
// hints added to WooCommerce's own error codes.

import {
  parseSiteUrl,
  ToolFailure,
  utf8Bytes,
  validateArguments,
  type ApiRequest,
  type ApiResponse,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';

type JsonSchema = ToolDefinition['inputSchema'];

/** "Basic <base64 of key:secret>", from the UTF-8 bytes. */
export function basicAuth(user: string, password: string): string {
  let binary = '';
  for (const byte of utf8Bytes(`${user}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * The path of the WordPress install the store runs on, "" or "/shop": the
 * path of the store URL credential, without a REST, admin or login part pasted
 * with it.
 */
export function storePath(value: string | undefined): string {
  const site = parseSiteUrl(value ?? '');
  if (!site.ok) return '';
  return site.url.pathname.replace(/\/(?:wp-admin|wp-json|wp-login\.php)(?:\/.*)?$/i, '').replace(/\/+$/, '');
}

const NOT_FOUND =
  'Check that the store URL is the address of the site the store runs on (Settings → General in its admin, with its subdirectory '
  + 'if it has one; not the shop page), that WooCommerce is active, and that permalinks are not set to Plain.';

const HINTS: Record<string, string> = {
  woocommerce_rest_authentication_error:
    'Check the consumer key and secret (WooCommerce → Settings → Advanced → REST API); a change needs a key with Read/Write permissions.',
  woocommerce_rest_cannot_view:
    'The key\'s user may not read this, or the site\'s server drops the Authorization header: the key needs a user with the Shop manager or Administrator role.',
  woocommerce_rest_cannot_create: 'The key needs Read/Write permissions and a user with the Shop manager or Administrator role.',
  woocommerce_rest_cannot_edit: 'The key needs Read/Write permissions and a user with the Shop manager or Administrator role.',
  woocommerce_rest_cannot_delete: 'The key needs Read/Write permissions and a user with the Shop manager or Administrator role.',
  rest_no_route: NOT_FOUND,
};

/** A WooCommerce error with a sentence on what to check next, when its code has one. */
export function withHint(error: unknown): unknown {
  if (!(error instanceof ToolFailure)) return error;
  const { vendorCode, status } = error.details;
  const hint = (vendorCode !== undefined ? HINTS[vendorCode] : undefined) ?? (status === 404 && vendorCode === undefined ? NOT_FOUND : undefined);
  return hint ? new ToolFailure(`${error.message} ${hint}`, error.details) : error;
}

/** The REST path of a WooCommerce route, such as "/products" → "/shop/wp-json/wc/v3/products". */
export function restPath(h: ToolHelpers, route: string): string {
  return `${storePath(h.credentials['storeurl'])}/wp-json${route}`;
}

/** One request to a route of the WooCommerce REST API v3, such as "/products". */
export async function wc(h: ToolHelpers, route: string, request: Omit<ApiRequest, 'path' | 'origin'> = {}): Promise<ApiResponse> {
  try {
    return await h.api({ ...request, origin: h.originOf('storeurl'), path: restPath(h, `/wc/v3${route}`) });
  } catch (error) {
    throw withHint(error);
  }
}

export function totalItems(response: ApiResponse): number | undefined {
  const value = Number(response.headers.get('x-wp-total'));
  return response.headers.has('x-wp-total') && Number.isFinite(value) ? value : undefined;
}

/** Whether a list has a next page: from X-WP-TotalPages, or a full page when a proxy dropped it. */
export function hasMore(response: ApiResponse, page: number, count: number, perPage: number): boolean {
  const pages = Number(response.headers.get('x-wp-totalpages'));
  return response.headers.has('x-wp-totalpages') && Number.isFinite(pages) ? page < pages : count >= perPage;
}

export interface ListPosition {
  page: number;
  skip: number;
  filters: Record<string, any>;
}

function invalidCursor(): ToolFailure {
  return new ToolFailure('The cursor is not valid for this tool. Pass the nextCursor value of the previous result unchanged, or leave cursor out to start from the beginning.');
}

/**
 * Where a list continues: page and offset from the cursor, and the list's
 * filters from the cursor too (checked against the tool's schema again), so a
 * page continues the same list; without a cursor, page 1 with the arguments.
 */
export function listPosition(h: ToolHelpers, schema: JsonSchema, args: Record<string, unknown>): ListPosition {
  const state = h.cursor(args['cursor'] as string | undefined);
  if (!state) {
    const { cursor: _cursor, ...filters } = args;
    return { page: 1, skip: 0, filters };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(state['f'] ?? '{}'));
  } catch {
    throw invalidCursor();
  }
  const checked = validateArguments(schema, parsed);
  const page = Number(state['p']);
  const skip = Number(state['o']);
  if (!checked.ok || 'cursor' in checked.value || !Number.isInteger(page) || page < 1 || !Number.isInteger(skip) || skip < 0) throw invalidCursor();
  return { page, skip, filters: checked.value };
}

export function pageCursors(h: ToolHelpers, position: ListPosition, more: boolean) {
  const f = JSON.stringify(position.filters);
  return {
    resumeAt: (index: number) => h.makeCursor({ p: position.page, o: position.skip + index, f }),
    ...(more ? { nextPage: h.makeCursor({ p: position.page + 1, o: 0, f }) } : {}),
  };
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** The text of an HTML fragment, on one line, at most `max` characters. */
export function plainText(html: unknown, max: number): string | undefined {
  if (typeof html !== 'string') return undefined;
  const text = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}

/** An HTML field cut to `max` characters, with a flag when it was cut. */
export function cutHtml(html: unknown, max: number): { text?: string; cut?: true } {
  if (typeof html !== 'string' || !html) return {};
  const points = Array.from(html);
  return points.length > max ? { text: points.slice(0, max).join(''), cut: true } : { text: html };
}

/** Refuses a call before anything is sent. */
export function refuse(sentence: string): never {
  throw new ToolFailure(`${sentence} Nothing was sent.`);
}
