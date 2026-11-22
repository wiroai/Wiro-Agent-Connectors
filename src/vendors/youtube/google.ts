import {
  jsonSize,
  OUTPUT_LIMIT_BYTES,
  OutcomeUnknown,
  ToolFailure,
  type ApiRequest,
  type ApiResponse,
  type ToolHelpers,
} from '../../core/index.js';

// Small helpers for Google's JSON APIs. Each Google connector keeps its own
// copy of this file, since a module imports only from src/core and its folder.

/** Google wraps some words of its error messages in HTML (a link to its docs): keep the words. */
export function plain(text: string): string {
  return text.replace(/<\/?[A-Za-z][^<>]{0,300}>/g, '');
}

/** One request through h.api, with Google's error words freed of markup. Never retried. */
export async function googleApi(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await h.api(request);
  } catch (error) {
    if (error instanceof ToolFailure) {
      const message = plain(error.message);
      throw message === error.message ? error : new ToolFailure(message, error.details);
    }
    if (error instanceof OutcomeUnknown) {
      const message = plain(error.message);
      throw message === error.message ? error : new OutcomeUnknown(message);
    }
    throw error;
  }
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/** A number from one of Google's counts, which int64 fields send as text. */
export function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/**
 * A whole number a cursor carries, within min and max; anything else (a
 * cursor is plain base64 JSON anyone can write) gives the fallback.
 */
export function cursorNumber(state: Record<string, unknown> | null, key: string, fallback: number, min: number, max: number): number {
  const value = state?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The bytes a UTF-16 code unit takes inside a JSON string, or 0 for the high half of a pair (its low half counts 4). */
function jsonBytes(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 0 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = text.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? 4 : 6;
  }
  return 3;
}

/**
 * At most `maxBytes` of text as it stands inside a JSON string (UTF-8, with
 * quotes, backslashes and control characters escaped), starting at `start` (a
 * string index) and never splitting a character: the slice, and where the
 * next one starts when text goes on.
 */
export function sliceJsonText(text: string, start: number, maxBytes: number): { text: string; next?: number } {
  let index = Math.max(0, Math.min(Math.trunc(start), text.length));
  // Never start inside a surrogate pair.
  if (index > 0 && index < text.length && jsonBytes(text, index) === 4) index -= 1;
  const from = index;
  let bytes = 0;
  while (index < text.length) {
    const unit = jsonBytes(text, index);
    const size = unit === 0 ? 4 : unit;
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += unit === 0 ? 2 : 1;
  }
  return { text: text.slice(from, index), ...(index < text.length ? { next: index } : {}) };
}

/**
 * A result carrying one part of a long text, as large as the 32 KB output
 * limit allows: build(part, next) makes the result, and the part gets the
 * room the rest of it leaves, counted as JSON. `next` is where the following
 * part starts (undefined at the end), so parts read in turn join up to the
 * whole text. The rest must leave room for some text.
 */
export function fitTextPart(
  text: string,
  start: number,
  build: (part: string, next: number | undefined) => Record<string, unknown>,
): Record<string, unknown> {
  // The rest of the result, with the largest offset it can carry.
  let room = OUTPUT_LIMIT_BYTES - jsonSize(build('', text.length)) - 16;
  for (let round = 0; round < 5 && room > 0; round++) {
    const part = sliceJsonText(text, start, room);
    const result = build(part.text, part.next);
    const over = jsonSize(result) - OUTPUT_LIMIT_BYTES;
    if (over <= 0) return result;
    room -= over;
  }
  throw new ToolFailure('The result is too large to return.');
}

/** An RFC 3339 time in UTC with whole seconds, e.g. 2026-12-01T09:00:00Z. */
export function utcTime(value: string, name: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ToolFailure(`${name} is not a valid time: give one like 2026-12-01T09:00:00Z. Nothing was sent.`);
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
