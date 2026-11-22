import { ToolFailure } from './errors.js';
import { base64UrlDecode, base64UrlEncode, truncate, utf8Bytes, utf8Decode, utf8Length } from './text.js';

/** The largest result text a tool returns, in UTF-8 bytes. */
export const OUTPUT_LIMIT_BYTES = 32 * 1024;

export function jsonSize(value: unknown): number {
  return utf8Length(JSON.stringify(value) ?? '');
}

function cutStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return truncate(value, max);
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, max));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cutStrings(item, max);
    return out;
  }
  return value;
}

/**
 * Returns the value unchanged when its JSON fits the limit, otherwise a copy
 * with long strings cut. Returns undefined when even that does not fit.
 */
export function shrinkToFit(value: unknown, limit = OUTPUT_LIMIT_BYTES): { value: unknown; truncated: boolean } | undefined {
  if (jsonSize(value) <= limit) return { value, truncated: false };
  for (const max of [4000, 2000, 1000, 500, 200, 80]) {
    const cut = cutStrings(value, max);
    if (jsonSize(cut) <= limit) return { value: cut, truncated: true };
  }
  return undefined;
}

export interface PageInput<T> {
  /** The result field that holds the list, e.g. "articles". */
  key: string;
  /** This page's items, already trimmed to the fields an agent needs. */
  items: T[];
  /** Other result fields, placed before the list. */
  extra?: Record<string, unknown>;
  /** A cursor that continues at items[index]: used when the size limit cuts the list. */
  resumeAt(index: number): string;
  /** A cursor for the next vendor page, when there is one. */
  nextPage?: string;
}

/**
 * Builds a list result that fits OUTPUT_LIMIT_BYTES. When the whole page does
 * not fit, it returns as many items as fit, with `truncated: true` and a
 * `nextCursor` that continues right after the last item returned.
 */
export function fitPage<T>(input: PageInput<T>, limit = OUTPUT_LIMIT_BYTES): Record<string, unknown> {
  const build = (count: number): Record<string, unknown> => {
    const cut = count < input.items.length;
    const result: Record<string, unknown> = { ...input.extra, [input.key]: input.items.slice(0, count) };
    const next = cut ? input.resumeAt(count) : input.nextPage;
    if (next) result['nextCursor'] = next;
    if (cut) result['truncated'] = true;
    return result;
  };

  const all = build(input.items.length);
  if (jsonSize(all) <= limit) return all;

  // The largest count that fits; count 0 is never returned, so a cursor always moves on.
  let low = 1;
  let high = input.items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonSize(build(middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  const best = build(low);
  if (jsonSize(best) <= limit) return best;
  const shrunk = shrinkToFit(best, limit);
  if (shrunk) return { ...(shrunk.value as Record<string, unknown>), truncated: true };
  throw new ToolFailure('The result is too large to return, even one item at a time.');
}

/** An opaque cursor that only the tool that made it accepts. */
export function encodeCursor(tool: string, state: Record<string, string | number>): string {
  return base64UrlEncode(utf8Bytes(JSON.stringify({ t: tool, ...state })));
}

export function decodeCursor(tool: string, cursor: string | undefined): Record<string, unknown> | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const state: unknown = JSON.parse(utf8Decode(base64UrlDecode(cursor)));
    if (typeof state === 'object' && state !== null && (state as { t?: unknown }).t === tool) {
      return state as Record<string, unknown>;
    }
  } catch {
    // reported below
  }
  throw new ToolFailure(
    'The cursor is not valid for this tool. Pass the nextCursor value of the previous result unchanged, '
      + 'or leave cursor out to start from the beginning.',
  );
}
