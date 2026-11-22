import { OutcomeUnknown, ToolFailure, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

// Small helpers for Google's JSON APIs.

/** Google wraps some words of its error messages in HTML (a link to its docs): keep the words. */
function plain(text: string): string {
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

function charBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) return 4;
  return 3;
}

/**
 * At most `maxBytes` of UTF-8 from text, starting at `start` (a string
 * index), never splitting a character: the slice, and where the next one
 * starts when text goes on.
 */
export function sliceText(text: string, start: number, maxBytes: number): { text: string; next?: number } {
  let index = Math.max(0, Math.min(start, text.length));
  // Never start inside a surrogate pair.
  if (index > 0 && index < text.length && /[\udc00-\udfff]/.test(text.charAt(index))) index -= 1;
  const from = index;
  let bytes = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const size = charBytes(code);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += size === 4 ? 2 : 1;
  }
  return { text: text.slice(from, index), ...(index < text.length ? { next: index } : {}) };
}

/** An RFC 3339 time in UTC with whole seconds, e.g. 2026-12-01T09:00:00Z. */
export function utcTime(value: string, name: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ToolFailure(`${name} is not a valid time: give one like 2026-12-01T09:00:00Z. Nothing was sent.`);
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
