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

/** One GraphQL request. Reads go as safe POSTs; a mutation is the tool's write. */
export async function gql(
  h: ToolHelpers,
  query: string,
  variables: Record<string, unknown> | undefined,
  options: { write?: boolean; operationName?: string } = {},
): Promise<GqlResult> {
  const body = compact({ query, variables, operationName: options.operationName });
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

/**
 * The operation types of a GraphQL document, in order: "query" (also for an
 * anonymous { ... }), "mutation", "subscription" or "fragment". Strings,
 * block strings, comments and argument lists are skipped.
 */
export function operationTypes(document: string): string[] {
  const types: string[] = [];
  let depth = 0;
  let parens = 0;
  let atDefinition = true;
  let index = 0;
  const length = document.length;
  while (index < length) {
    const char = document[index] as string;
    if (char === '#') {
      while (index < length && document[index] !== '\n' && document[index] !== '\r') index++;
      continue;
    }
    if (char === '"') {
      if (document.startsWith('"""', index)) {
        const end = document.indexOf('"""', index + 3);
        index = end === -1 ? length : end + 3;
        continue;
      }
      index++;
      while (index < length && document[index] !== '"' && document[index] !== '\n') {
        if (document[index] === '\\') index++;
        index++;
      }
      index++;
      continue;
    }
    if (char === '(') {
      parens++;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
    } else if (parens === 0 && char === '{') {
      if (depth === 0 && atDefinition) types.push('query');
      depth++;
      atDefinition = false;
    } else if (parens === 0 && char === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) atDefinition = true;
    } else if (depth === 0 && parens === 0 && /[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_]/.test(document[end] as string)) end++;
      const word = document.slice(index, end);
      if (atDefinition && ['query', 'mutation', 'subscription', 'fragment'].includes(word)) {
        types.push(word);
        atDefinition = false;
      }
      index = end;
      continue;
    }
    index++;
  }
  return types;
}

/** The document without its comments and strings, to look for field names. */
export function documentWords(document: string): string {
  return document
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ')
    .replace(/#[^\n\r]*/g, ' ');
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
