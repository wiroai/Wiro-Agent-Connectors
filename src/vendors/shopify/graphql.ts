// The Shopify GraphQL Admin API of one shop: the shop's address (its own
// <shop>.myshopify.com host, never a custom domain), one request per call to
// the pinned API version, and what a GraphQL answer means. Shopify answers
// HTTP 200 for most failures, so success is: no top-level errors (or data
// besides them), no userErrors in a mutation's payload, and the expected
// object. Throttling is by query cost and comes back as a THROTTLED error.

import {
  cleanVendorText,
  OutcomeUnknown,
  sha256Hex,
  ToolFailure,
  validateArguments,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';

type JsonSchema = ToolDefinition['inputSchema'];

/** The pinned Admin API version. */
export const API_VERSION = '2026-07';
const SHOP_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

/** The shop's https origin, after checking it is a <shop>.myshopify.com host. */
export function shopOrigin(h: ToolHelpers): string {
  const origin = h.originOf('shopdomain');
  const url = new URL(origin);
  if (!SHOP_HOST.test(url.hostname) || url.port) {
    throw new ToolFailure(
      `The Shopify shop domain must be the store's own <shop>.myshopify.com address (Shopify admin → Settings → Domains lists it), not ${url.host}. `
        + 'Nothing was sent to Shopify.',
    );
  }
  return origin;
}

export interface Cost {
  requested?: number;
  actual?: number;
  available?: number;
  restoreRate?: number;
}

function readCost(extensions: any): Cost | undefined {
  const cost = extensions?.cost;
  if (typeof cost !== 'object' || cost === null) return undefined;
  const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    requested: number(cost.requestedQueryCost),
    actual: number(cost.actualQueryCost),
    available: number(cost.throttleStatus?.currentlyAvailable),
    restoreRate: number(cost.throttleStatus?.restoreRate),
  };
}

/** Seconds until the bucket holds the request's cost again. */
function waitSeconds(cost: Cost | undefined): number | undefined {
  if (!cost || cost.requested === undefined || cost.available === undefined || !cost.restoreRate) return undefined;
  return Math.max(1, Math.ceil((cost.requested - cost.available) / cost.restoreRate));
}

export interface GraphqlResult {
  data: any;
  /** Errors Shopify sent with data, such as a field the app may not read. */
  warnings: string[];
  cost?: Cost;
}

/** One GraphQL request. A query is a read (sent as a safe POST); a mutation is a write, never retried. */
export async function graphql(h: ToolHelpers, query: string, variables: Record<string, unknown> = {}, options: { write?: boolean; operationName?: string } = {}): Promise<GraphqlResult> {
  const origin = shopOrigin(h);
  const nothing = options.write ? ' Nothing was changed.' : '';
  const { data: body } = await h.api({
    method: 'POST',
    origin,
    path: `/admin/api/${API_VERSION}/graphql.json`,
    json: { query, variables, ...(options.operationName ? { operationName: options.operationName } : {}) },
    ...(options.write ? { write: true } : { safe: true }),
    errors: {
      402: 'Shopify refused the request: the store is frozen or has no active plan',
      403: 'Shopify refused the request: the app lacks an access scope, or the staff permission, for it',
      404: 'Shopify found no store API at that address: check the shop domain (<shop>.myshopify.com)',
      423: 'Shopify refused the request: the store is locked',
    },
  });
  if (typeof body !== 'object' || body === null) {
    if (options.write) throw new OutcomeUnknown('Shopify answered with something other than GraphQL JSON, so it is not known whether the change was made.');
    throw new ToolFailure('Shopify answered with something other than GraphQL JSON.');
  }
  const errors: any[] = Array.isArray(body.errors) ? body.errors : typeof body.errors === 'string' ? [{ message: body.errors }] : [];
  const cost = readCost(body.extensions) ?? errors.map((error) => readCost(error?.extensions)).find(Boolean);
  if (!errors.length) return { data: body.data ?? {}, warnings: [], ...(cost ? { cost } : {}) };

  const codes = errors.map((error) => (typeof error?.extensions?.code === 'string' ? error.extensions.code : undefined));
  const messages = errors.map((error) => cleanVendorText(error?.message, 300)).filter((message): message is string => Boolean(message));
  const said = [...new Set(messages)].slice(0, 5).join('; ') || 'it answered with errors';
  if (codes.includes('THROTTLED')) {
    const retryAfter = waitSeconds(cost);
    throw new ToolFailure(
      `Shopify rate limit reached (the request costs more than the app has left right now).${nothing} `
        + (retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : 'Wait a few seconds before retrying.'),
      { vendorCode: 'THROTTLED', ...(retryAfter !== undefined ? { retryAfter } : {}) },
    );
  }
  if (options.write && codes.some((code) => code === 'INTERNAL_SERVER_ERROR' || code === 'TIMEOUT')) {
    throw new OutcomeUnknown(`Shopify reported an internal error (${said}), so it is not known whether the change was made.`);
  }
  const hasData = typeof body.data === 'object' && body.data !== null && Object.values(body.data).some((value) => value !== null);
  if (hasData) return { data: body.data, warnings: [...new Set(messages)], ...(cost ? { cost } : {}) };
  const code = codes.find((item): item is string => item !== undefined);
  const hint = code === 'ACCESS_DENIED'
    ? ' The app may lack an access scope, or protected customer data access, for this.'
    : code === 'MAX_COST_EXCEEDED' ? ' Ask for fewer items or fields.' : '';
  throw new ToolFailure(`Shopify did not run the request: ${said.replace(/[.!]+$/, '')}.${hint}${nothing}`, code ? { vendorCode: code } : {});
}

/** A mutation payload's userErrors as one line, or undefined when there are none. */
export function userErrorText(list: unknown): string | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list
    .slice(0, 10)
    .map((error: any) => {
      const field = Array.isArray(error?.field) && error.field.length ? error.field.join('.') : undefined;
      const message = cleanVendorText(error?.message, 300) ?? 'refused';
      return field ? `${field}: ${message}` : message;
    })
    .join('; ');
}

/** Throws when a mutation payload has userErrors: Shopify made no change. */
export function assertNoUserErrors(payload: any, what: string): void {
  const text = userErrorText(payload?.userErrors);
  if (!text) return;
  const code = (payload.userErrors as any[]).find((error) => typeof error?.code === 'string')?.code;
  throw new ToolFailure(`Shopify did not ${what}: ${text.replace(/[.!]+$/, '')}. Nothing was changed.`, code ? { vendorCode: code } : {});
}

/** A global id from a number or a gid of the type, e.g. gid("Product", 123) → "gid://shopify/Product/123". */
export function gid(type: string, value: string | number, argument: string): string {
  const text = String(value).trim();
  if (/^\d{1,20}$/.test(text)) return `gid://shopify/${type}/${text}`;
  if (new RegExp(`^gid://shopify/${type}/\\d{1,20}(\\?[\\w=&.-]{1,200})?$`).test(text)) return text;
  throw new ToolFailure(`${argument} must be a ${type} id: a number, or gid://shopify/${type}/<number>. Nothing was sent.`);
}

/** The text of a search query value, quoted when it needs to be. */
export function searchValue(value: string): string {
  return /^[A-Za-z0-9_.@#-]+$/.test(value) ? value : `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * A key for the @idempotent directive, the same for the same change within a
 * 15-minute window (so a resent call is applied once) and new after it.
 */
export async function idempotencyKey(parts: unknown): Promise<string> {
  const window = Math.floor(Date.now() / (15 * 60 * 1000));
  const hex = await sha256Hex(JSON.stringify([parts, window]));
  // UUID layout, version 8 (custom), RFC 9562 variant.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Lists

export interface ListPosition {
  after?: string;
  skip: number;
  filters: Record<string, any>;
}

function invalidCursor(): ToolFailure {
  return new ToolFailure('The cursor is not valid for this tool. Pass the nextCursor value of the previous result unchanged, or leave cursor out to start from the beginning.');
}

/**
 * Where a list continues: Shopify's page cursor and an offset from the
 * cursor, and the list's filters from it too (checked against the tool's
 * schema again), so a page continues the same list.
 */
export function listPosition(h: ToolHelpers, schema: JsonSchema, args: Record<string, unknown>): ListPosition {
  const state = h.cursor(args['cursor'] as string | undefined);
  if (!state) {
    const { cursor: _cursor, ...filters } = args;
    return { skip: 0, filters };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(state['f'] ?? '{}'));
  } catch {
    throw invalidCursor();
  }
  const checked = validateArguments(schema, parsed);
  const skip = Number(state['o']);
  const after = state['a'];
  if (!checked.ok || 'cursor' in checked.value || !Number.isInteger(skip) || skip < 0 || (after !== undefined && typeof after !== 'string')) throw invalidCursor();
  return { ...(typeof after === 'string' ? { after } : {}), skip, filters: checked.value };
}

export function pageCursors(h: ToolHelpers, position: ListPosition, pageInfo: any) {
  const f = JSON.stringify(position.filters);
  const next = pageInfo?.hasNextPage === true && typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : undefined;
  return {
    resumeAt: (index: number) => h.makeCursor({ ...(position.after ? { a: position.after } : {}), o: position.skip + index, f }),
    ...(next ? { nextPage: h.makeCursor({ a: next, o: 0, f }) } : {}),
  };
}

// ---------------------------------------------------------------------------
// GraphQL documents: which operations a document holds and which names it uses

interface Token {
  kind: 'name' | 'punct' | 'value';
  text: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let at = 0;
  const fail = (what: string): never => {
    throw new ToolFailure(`The GraphQL document could not be read: ${what}. Nothing was sent.`);
  };
  while (at < length) {
    const char = source[at] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      at++;
    } else if (char === '#') {
      while (at < length && source[at] !== '\n' && source[at] !== '\r') at++;
    } else if (char === '"') {
      if (source.startsWith('"""', at)) {
        at += 3;
        while (at < length && !source.startsWith('"""', at)) at += source.startsWith('\\"""', at) ? 4 : 1;
        if (at >= length) fail('a block string is not closed');
        at += 3;
      } else {
        at++;
        while (at < length && source[at] !== '"') {
          if (source[at] === '\n' || source[at] === '\r') fail('a string is not closed');
          at += source[at] === '\\' ? 2 : 1;
        }
        if (at >= length) fail('a string is not closed');
        at++;
      }
      tokens.push({ kind: 'value', text: '"' });
    } else if (char === '.') {
      if (!source.startsWith('...', at)) fail('a lone "."');
      tokens.push({ kind: 'punct', text: '...' });
      at += 3;
    } else if ('!$&()[]{}:=@|'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      at++;
    } else if (/[_A-Za-z]/.test(char)) {
      let end = at + 1;
      while (end < length && /[_0-9A-Za-z]/.test(source[end] as string)) end++;
      tokens.push({ kind: 'name', text: source.slice(at, end) });
      at = end;
    } else if (char === '-' || /[0-9]/.test(char)) {
      let end = at + 1;
      while (end < length && /[0-9eE.+-]/.test(source[end] as string)) end++;
      tokens.push({ kind: 'value', text: source.slice(at, end) });
      at = end;
    } else {
      fail(`an unexpected character at position ${at}`);
    }
  }
  return tokens;
}

export interface DocumentInfo {
  operations: Array<'query' | 'mutation' | 'subscription'>;
  /** Every name the document uses: fields, arguments, types, directives. */
  names: Set<string>;
  directives: Set<string>;
}

/** The operations of an executable GraphQL document (queries, mutations, fragments only). */
export function readDocument(source: string): DocumentInfo {
  const tokens = lex(source);
  const operations: DocumentInfo['operations'] = [];
  const names = new Set<string>();
  const directives = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.kind !== 'name') return;
    names.add(token.text);
    if (tokens[index - 1]?.text === '@') directives.add(token.text);
  });
  const fail = (what: string): never => {
    throw new ToolFailure(`The GraphQL document could not be read: ${what}. Nothing was sent.`);
  };
  /** The index just past the selection set that starts at `open`. */
  const skipSelection = (open: number): number => {
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
      const text = (tokens[index] as Token).text;
      if (text === '{') depth++;
      else if (text === '}' && --depth === 0) return index + 1;
    }
    return fail('a "{" is not closed');
  };
  /** The "{" that opens a definition's selection set (not one inside its variables or directive arguments). */
  const selectionStart = (from: number): number => {
    let parens = 0;
    for (let index = from; index < tokens.length; index++) {
      const text = (tokens[index] as Token).text;
      if (text === '(') parens++;
      else if (text === ')') parens--;
      else if (text === '{' && parens === 0) return index;
    }
    return fail('a definition has no selection set');
  };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as Token;
    if (token.text === '{') {
      operations.push('query');
      index = skipSelection(index);
    } else if (token.kind === 'name' && (token.text === 'query' || token.text === 'mutation' || token.text === 'subscription')) {
      operations.push(token.text);
      index = skipSelection(selectionStart(index + 1));
    } else if (token.kind === 'name' && token.text === 'fragment') {
      index = skipSelection(selectionStart(index + 1));
    } else {
      fail('only query, mutation and fragment definitions can be sent');
    }
  }
  if (!operations.length) fail('it holds no operation');
  return { operations, names, directives };
}
