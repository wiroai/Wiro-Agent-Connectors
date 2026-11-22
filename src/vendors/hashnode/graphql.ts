// GraphQL plumbing for the Hashnode connector: one POST endpoint, errors that
// come back inside an HTTP 200 answer, the operation types of a document, and
// long Markdown returned in windows.

import { cleanVendorText, formatNumber, OutcomeUnknown, shrinkToFit, ToolFailure, utf8Length, type ToolHelpers } from '../../core/index.js';

/** Hashnode takes requests up to 100 KB. */
export const MAX_REQUEST_BYTES = 100 * 1024;
/** Answers can carry whole posts: read up to the 8 MiB a host allows for an API reply. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** Drops undefined and null fields. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

export interface GqlResult {
  data: any;
  errors: any[];
}

/**
 * One GraphQL request. Reads go as safe POSTs; a mutation is the tool's write.
 * Every document holds one operation, so no operationName is sent.
 */
export async function gql(
  h: ToolHelpers,
  query: string,
  variables: Record<string, unknown> | undefined,
  options: { write?: boolean } = {},
): Promise<GqlResult> {
  const body = compact({ query, variables });
  const size = utf8Length(JSON.stringify(body));
  if (size > MAX_REQUEST_BYTES) {
    throw new ToolFailure(
      `Hashnode takes requests up to 100 KB, and this one is ${formatNumber(Math.ceil(size / 1024))} KB: shorten it. `
        + `${options.write ? 'Nothing was changed.' : 'Nothing was sent.'}`,
    );
  }
  const response = await h.api({ method: 'POST', path: '/', json: body, maxBytes: MAX_ANSWER_BYTES, ...(options.write ? { write: true } : { safe: true }) });
  const payload = response.data;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    if (options.write) throw new OutcomeUnknown('Hashnode answered without GraphQL JSON, so it is not known whether the change was made.');
    throw new ToolFailure('Hashnode answered without GraphQL JSON. Try again later.');
  }
  return { data: payload.data ?? null, errors: Array.isArray(payload.errors) ? payload.errors : [] };
}

function errorText(errors: any[]): string | undefined {
  const messages = errors
    .map((error) => (typeof error?.message === 'string' ? error.message : ''))
    .filter((message) => message.trim() !== '');
  return cleanVendorText(messages.join('; '));
}

/** The error code of a GraphQL error, e.g. "NOT_FOUND". */
export function errorCode(errors: any[]): string | undefined {
  const code = errors[0]?.extensions?.code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(code) ? code : undefined;
}

/** Turns the errors of an answer without data into a clear failure, or an unknown outcome for a write. */
export function failFromErrors(errors: any[], write: boolean): never {
  const code = errorCode(errors);
  const message = errorText(errors);
  const said = message ? `: ${message.replace(/[.!?]+$/u, '')}` : '';
  const nothing = write ? ' Nothing was changed.' : '';
  const details = code ? { vendorCode: code } : {};
  if (message && /pro plan/i.test(message)) {
    throw new ToolFailure(
      `Hashnode's API works only for blogs on Hashnode Pro, and this blog is not on it (${code ?? 'FORBIDDEN'})${said}. A blog owner turns it on `
        + 'in the blog dashboard under Billing → Upgrade to Pro ($5 a month or $50 a year per seat); the API works right after checkout. '
        + `Do not retry before that.${nothing}`,
      details,
    );
  }
  switch (code) {
    case 'UNAUTHENTICATED':
      throw new ToolFailure(`Hashnode rejected the token (UNAUTHENTICATED)${said}. Check that the Hashnode Personal Access Token is correct and still active.${nothing}`, details);
    case 'FORBIDDEN':
      throw new ToolFailure(
        `Hashnode refused the request (FORBIDDEN)${said}. The account may lack the role for it: on a team blog a contributor cannot publish, `
          + `and submit_draft_for_review hands a draft to the blog's editors.${nothing}`,
        details,
      );
    case 'NOT_FOUND':
      throw new ToolFailure(`Hashnode found nothing there (NOT_FOUND)${said}. Check the ID or slug.${nothing}`, details);
    case 'BAD_USER_INPUT':
    case 'GRAPHQL_VALIDATION_FAILED':
    case 'GRAPHQL_PARSE_FAILED':
      throw new ToolFailure(`Hashnode rejected the request (${code})${said}.${nothing}`, details);
    default:
      if (write) {
        throw new OutcomeUnknown(`Hashnode answered with an error (${code ?? 'no code'})${said}, so it is not known whether the change was made.`);
      }
      throw new ToolFailure(`Hashnode answered with an error (${code ?? 'no code'})${said}. Try again later.`, details);
  }
}

/** The field of an answer's data a tool asked for; its errors become a failure when the field is missing. */
export function rootField(result: GqlResult, field: string, write: boolean): any {
  const value = result.data?.[field];
  if (value !== undefined && value !== null) return value;
  if (result.errors.length) failFromErrors(result.errors, write);
  return value ?? null;
}

/** Error messages that came back next to data, for the result. */
export function warningsOf(result: GqlResult): string[] | undefined {
  if (!result.errors.length) return undefined;
  return result.errors.slice(0, 5).map((error) => cleanVendorText(String(error?.message ?? 'error'), 300) ?? 'error');
}

// Reading a GraphQL document as the server does. The generic tools decide what
// a document may do from its operations and names, so the lexer follows the
// GraphQL specification (and graphql-js, the server's parser) to the letter:
// one pass, comments, strings and block strings (with their \""" escape) read
// the way the server reads them, and anything it would not read is refused
// rather than guessed at.

interface Token {
  kind: 'name' | 'punctuator' | 'string' | 'number';
  value: string;
}

export interface GraphqlOperation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
}

export interface GraphqlDocument {
  /** The operations, in order; an anonymous { ... } is a query. */
  operations: GraphqlOperation[];
  fragments: number;
  /** Every name outside strings and comments: fields, aliases, arguments, types, directives. */
  names: Set<string>;
}

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const CLOSERS: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';
const isNameStart = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z_]$/.test(char);
const isHex = (char: string | undefined): boolean => char !== undefined && /^[0-9A-Fa-f]$/.test(char);

class NotGraphql extends Error {}

/** The end of a number starting at `start`, as graphql-js reads IntValue and FloatValue. */
function readNumber(source: string, start: number): number {
  let index = start;
  if (source[index] === '-') index++;
  if (source[index] === '0') {
    index++;
    if (isDigit(source[index])) throw new NotGraphql('a number with a leading zero');
  } else if (isDigit(source[index])) {
    while (isDigit(source[index])) index++;
  } else {
    throw new NotGraphql('a "-" without a number');
  }
  if (source[index] === '.') {
    index++;
    if (!isDigit(source[index])) throw new NotGraphql('a number without digits after its "."');
    while (isDigit(source[index])) index++;
  }
  if (source[index] === 'e' || source[index] === 'E') {
    index++;
    if (source[index] === '+' || source[index] === '-') index++;
    if (!isDigit(source[index])) throw new NotGraphql('a number without digits in its exponent');
    while (isDigit(source[index])) index++;
  }
  if (source[index] === '.' || isNameStart(source[index])) throw new NotGraphql('a number followed by a name or a "."');
  return index;
}

/** The end of a "..." string starting at `start`: its escapes are checked, and a line break ends nothing but the document. */
function readString(source: string, start: number): number {
  let index = start + 1;
  for (;;) {
    const char = source[index];
    if (char === undefined || char === '\n' || char === '\r') throw new NotGraphql('a string that is not closed on its line');
    if (char === '"') return index + 1;
    if (char !== '\\') {
      index++;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped !== undefined && '"\\/bfnrt'.includes(escaped)) {
      index += 2;
    } else if (escaped === 'u' && source[index + 2] === '{') {
      let end = index + 3;
      while (isHex(source[end])) end++;
      if (end === index + 3 || source[end] !== '}') throw new NotGraphql('a broken \\u{...} escape in a string');
      index = end + 1;
    } else if (escaped === 'u' && [2, 3, 4, 5].every((offset) => isHex(source[index + offset]))) {
      index += 6;
    } else {
      throw new NotGraphql('an unknown escape in a string');
    }
  }
}

/** The end of a """...""" block string starting at `start`. Inside it, \""" is a quote, not its end. */
function readBlockString(source: string, start: number): number {
  let index = start + 3;
  for (;;) {
    if (index >= source.length) throw new NotGraphql('a block string that is not closed');
    if (source.startsWith('"""', index)) return index + 3;
    if (source.startsWith('\\"""', index)) {
      index += 4;
      continue;
    }
    index++;
  }
}

/** The tokens of a document, without its ignored parts (white space, line breaks, commas, comments). */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index++;
    } else if (char === '#') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
    } else if (char === '"') {
      const end = source.startsWith('"""', index) ? readBlockString(source, index) : readString(source, index);
      tokens.push({ kind: 'string', value: '' });
      index = end;
    } else if (isNameStart(char)) {
      let end = index + 1;
      while (end < source.length && /^[A-Za-z0-9_]$/.test(source[end] as string)) end++;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
    } else if (char === '-' || isDigit(char)) {
      const end = readNumber(source, index);
      tokens.push({ kind: 'number', value: source.slice(index, end) });
      index = end;
    } else if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punctuator', value: '...' });
      index += 3;
    } else if (PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'punctuator', value: char });
      index++;
    } else {
      throw new NotGraphql(`the character ${JSON.stringify(char)}`);
    }
  }
  return tokens;
}

/**
 * Reads a GraphQL document the way the server does: its operations (type and
 * name), its fragments, and every name in it. It refuses what is not an
 * executable document of queries, mutations, subscriptions and fragments.
 */
export function parseDocument(source: string): { ok: true; document: GraphqlDocument } | { ok: false; problem: string } {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (error instanceof NotGraphql) return { ok: false, problem: `it has ${error.message}` };
    throw error;
  }
  let index = 0;
  const is = (kind: Token['kind'], value?: string): boolean => tokens[index]?.kind === kind && (value === undefined || tokens[index]?.value === value);
  /** Steps over a (...), [...] or {...} group and everything inside it; false when the brackets do not match. */
  const skipGroup = (): boolean => {
    const open: string[] = [];
    do {
      const token = tokens[index];
      if (!token) return false;
      if (token.kind === 'punctuator') {
        if (token.value === '{' || token.value === '(' || token.value === '[') open.push(token.value);
        else if (CLOSERS[token.value] && open.pop() !== CLOSERS[token.value]) return false;
      }
      index++;
    } while (open.length);
    return true;
  };
  const skipDirectives = (): boolean => {
    while (is('punctuator', '@')) {
      index++;
      if (!is('name')) return false;
      index++;
      if (is('punctuator', '(') && !skipGroup()) return false;
    }
    return true;
  };
  const operations: GraphqlOperation[] = [];
  let fragments = 0;
  const broken = (what: string) => ({ ok: false as const, problem: what });
  while (index < tokens.length) {
    if (is('punctuator', '{')) {
      if (!skipGroup()) return broken('its brackets do not match');
      operations.push({ type: 'query' });
    } else if (is('name', 'query') || is('name', 'mutation') || is('name', 'subscription')) {
      const type = (tokens[index] as Token).value as GraphqlOperation['type'];
      index++;
      let name: string | undefined;
      if (is('name')) {
        name = (tokens[index] as Token).value;
        index++;
      }
      if (is('punctuator', '(') && !skipGroup()) return broken('its brackets do not match');
      if (!skipDirectives()) return broken('a directive is cut short');
      if (!is('punctuator', '{')) return broken(`the ${type}${name ? ` ${name}` : ''} has no selection set`);
      if (!skipGroup()) return broken('its brackets do not match');
      operations.push({ type, ...(name ? { name } : {}) });
    } else if (is('name', 'fragment')) {
      index++;
      if (!is('name') || is('name', 'on')) return broken('a fragment has no name');
      index++;
      if (!is('name', 'on')) return broken('a fragment has no type condition (on Type)');
      index++;
      if (!is('name')) return broken('a fragment has no type condition (on Type)');
      index++;
      if (!skipDirectives()) return broken('a directive is cut short');
      if (!is('punctuator', '{') || !skipGroup()) return broken('a fragment has no selection set');
      fragments++;
    } else {
      return broken('a definition that is not a query, mutation, subscription or fragment');
    }
  }
  const names = new Set(tokens.filter((token) => token.kind === 'name').map((token) => token.value));
  return { ok: true, document: { operations, fragments, names } };
}

/** A generic GraphQL answer that fits the 32 KB limit: long strings cut first, then the text itself. */
export function fitAnswer(answer: Record<string, unknown>): Record<string, unknown> {
  const limit = 31 * 1024;
  const shrunk = shrinkToFit(answer, limit);
  if (shrunk) return shrunk.truncated ? { ...(shrunk.value as Record<string, unknown>), truncated: true } : answer;
  const text = JSON.stringify(answer['data']) ?? '';
  const window = textWindow(text, 0, 28 * 1024);
  return {
    truncated: true,
    note: `The answer has ${formatNumber(utf8Length(text))} bytes and was cut to fit 32 KB: ask for fewer fields or items (first) to see it whole.`,
    text: window.text,
  };
}

/** The room a window of long text may take in a result, in UTF-8 bytes of its JSON form. */
export const TEXT_WINDOW_BYTES = 24_000;

/**
 * A window of a long text that fits `budget` bytes once JSON-encoded, starting
 * at `offset`. It ends at a line break when one is near, never inside a
 * character, and says where the next window starts.
 */
export function textWindow(text: string, offset: number, budget = TEXT_WINDOW_BYTES): { text: string; offset: number; next?: number } {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const rest = text.length - start;
  const size = (count: number): number => utf8Length(JSON.stringify(text.slice(start, start + count)));
  let count = Math.min(rest, budget);
  if (size(count) > budget) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(middle) <= budget) low = middle;
      else high = middle - 1;
    }
    count = low;
  }
  if (count < rest) {
    const lineBreak = text.lastIndexOf('\n', start + count - 1);
    if (lineBreak >= start + Math.floor(count / 2)) count = lineBreak + 1 - start;
    const code = text.charCodeAt(start + count - 1);
    if (code >= 0xd800 && code <= 0xdbff) count -= 1;
  }
  const end = start + Math.max(count, 0);
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { next: end } : {}) };
}
