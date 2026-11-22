// Helpers for the Kaggle connector: names of notebooks, datasets and
// competitions, Kaggle's two answer shapes (legacy lists with *Nullable twins,
// and objects with a next page token), durations, run logs, the three-step
// file upload, and long text in windows.

import { formatNumber, ToolFailure, truncate, utf8Bytes, utf8Decode, utf8Length, type ToolHelpers } from '../../core/index.js';

/** Where Kaggle's signed upload addresses may point; the Kaggle token is never sent there. */
export const UPLOAD_ORIGINS = ['https://storage.googleapis.com', 'https://www.googleapis.com', 'https://www.kaggle.com'];
/** The largest file a host downloads for an upload. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Drops undefined and null fields. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/** A field of a Kaggle answer, read from its plain name or its *Nullable twin. */
export function field(item: any, name: string): any {
  if (!item || typeof item !== 'object') return undefined;
  const value = item[name];
  return value !== undefined && value !== null ? value : item[`${name}Nullable`] ?? undefined;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * An owner/slug reference from "owner/slug", "slug" (owned by the
 * connection's user) or a kaggle.com link to a notebook or dataset.
 */
export function ownerSlug(value: string, username: string, what: 'notebook' | 'dataset'): { owner: string; slug: string; ref: string } {
  let text = String(value ?? '').trim();
  const link = /^https?:\/\/(?:www\.)?kaggle\.com\/(?:code|datasets)\/([^/?#]+)\/([^/?#]+)/i.exec(text);
  if (link) text = `${link[1]}/${link[2]}`;
  const parts = text.split('/');
  const [owner, slug] = parts.length === 1 ? [username, parts[0]] : parts.length === 2 ? parts : [undefined, undefined];
  if (!owner || !slug || !NAME.test(owner) || !NAME.test(slug)) {
    throw new ToolFailure(`The ${what} must be named "owner/slug", like janedoe/sales-forecast, or by its slug alone for your own. Nothing was sent.`);
  }
  return { owner, slug, ref: `${owner}/${slug}` };
}

/** A competition's slug, from the slug or its kaggle.com link. */
export function competitionSlug(value: string): string {
  let text = String(value ?? '').trim();
  const link = /^https?:\/\/(?:www\.)?kaggle\.com\/(?:c|competitions)\/([^/?#]+)/i.exec(text);
  if (link?.[1]) text = link[1];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(text)) {
    throw new ToolFailure('The competition must be named by its slug, such as titanic, or its kaggle.com link. Nothing was sent.');
  }
  return text;
}

/** The list in a Kaggle list answer: a bare array (older answers) or the named field. */
export function listOf(data: any, key: string): any[] {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

/** Kaggle's own error inside a 200 answer: an `error` text, or a `code` of 400 or more. */
export function answerError(data: any): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (typeof data.error === 'string' && data.error.trim()) return truncate(data.error.trim(), 500);
  if (typeof data.code === 'number' && data.code >= 400) return truncate(String(data.message ?? `code ${data.code}`), 500);
  return undefined;
}

/** A duration as Kaggle writes it ("3600s", "151.500s", seconds, or { seconds, nanos }) in hours, one decimal. */
export function hours(value: unknown): number | undefined {
  let seconds: number | undefined;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string') seconds = Number(value.replace(/s$/, ''));
  else if (value && typeof value === 'object') {
    const record = value as { seconds?: unknown; nanos?: unknown };
    seconds = Number(record.seconds ?? 0) + Number(record.nanos ?? 0) / 1e9;
  }
  return seconds !== undefined && Number.isFinite(seconds) ? Math.round((seconds / 3600) * 10) / 10 : undefined;
}

/** The last lines of a run's log, from Kaggle's JSON event list or plain text, within a byte budget. */
export function logTail(raw: unknown, maxLines: number, budget = 12_000): { lines: string[]; total: number } {
  let text = typeof raw === 'string' ? raw : '';
  if (/^\s*\[/.test(text)) {
    try {
      const events: unknown = JSON.parse(text);
      if (Array.isArray(events)) text = events.map((event: any) => (typeof event?.data === 'string' ? event.data : '')).join('');
    } catch {
      // plain text after all
    }
  }
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const lines: string[] = [];
  let used = 0;
  for (let index = all.length - 1; index >= 0 && lines.length < maxLines; index--) {
    const line = truncate(all[index] as string, 500);
    used += utf8Length(JSON.stringify(line)) + 1;
    if (used > budget) break;
    lines.unshift(line);
  }
  return { lines, total: all.length };
}

export interface FileArg {
  name: string;
  url?: string;
  content?: string;
  description?: string;
}

/** The bytes of a file argument: downloaded from its public https URL, or its text content. */
export async function fileBytes(h: ToolHelpers, file: FileArg): Promise<Uint8Array> {
  if ((file.url === undefined) === (file.content === undefined)) {
    throw new ToolFailure(`File ${file.name}: give url or content, one of them. Nothing was created.`);
  }
  if (file.content !== undefined) return utf8Bytes(file.content);
  const { bytes } = await h.media(file.url as string, { what: `file ${file.name}`, maxBytes: MAX_FILE_BYTES });
  return bytes;
}

/**
 * Kaggle's three-step upload: a ticket from Kaggle (an upload address and a
 * token), the file sent to that address with no Kaggle token, and the token
 * returned for the call that creates the dataset or the submission.
 */
export async function uploadFile(h: ToolHelpers, ticket: { path: string; json: Record<string, unknown> }, bytes: Uint8Array, name: string): Promise<string> {
  const { data } = await h.api({ method: 'POST', path: ticket.path, json: ticket.json });
  const failed = answerError(data);
  if (failed) throw new ToolFailure(`Kaggle refused the upload of ${name}: ${failed}. Nothing was created.`);
  const token = field(data, 'token');
  const address = field(data, 'createUrl');
  if (typeof token !== 'string' || !token || typeof address !== 'string') {
    throw new ToolFailure(`Kaggle gave no upload address for ${name}. Nothing was created.`);
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ToolFailure(`Kaggle gave an upload address for ${name} that is not a valid URL. Nothing was created.`);
  }
  if (!UPLOAD_ORIGINS.includes(url.origin)) {
    throw new ToolFailure(`Kaggle gave an upload address on ${url.host}, where this connector does not send files. Nothing was created.`);
  }
  await h.api({
    method: 'PUT',
    origin: url.origin,
    path: `${url.pathname}${url.search}`,
    body: bytes,
    contentType: 'application/octet-stream',
    auth: false,
    errors: {
      403: `The upload address Kaggle gave refused ${name}`,
      404: `The upload address Kaggle gave for ${name} has expired: try again`,
    },
  });
  return token;
}

/** Uploads each file in turn and returns their tokens, in order. */
export async function uploadAll(
  h: ToolHelpers,
  files: FileArg[],
  ticketFor: (file: FileArg, size: number) => { path: string; json: Record<string, unknown> },
): Promise<Array<{ token: string; file: FileArg; size: number }>> {
  const names = new Set<string>();
  for (const file of files) {
    if (names.has(file.name)) throw new ToolFailure(`The file name ${file.name} is given twice. Nothing was created.`);
    names.add(file.name);
  }
  const uploaded: Array<{ token: string; file: FileArg; size: number }> = [];
  for (const file of files) {
    const bytes = await fileBytes(h, file);
    if (!bytes.length) throw new ToolFailure(`File ${file.name} is empty. Nothing was created.`);
    const token = await uploadFile(h, ticketFor(file, bytes.length), bytes, file.name);
    uploaded.push({ token, file, size: bytes.length });
  }
  return uploaded;
}

export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
  if (bytes >= 1024) return `${formatNumber(Math.round((bytes / 1024) * 10) / 10)} KB`;
  return `${formatNumber(bytes)} bytes`;
}

/** Text of a downloaded file, or a failure when it is binary. */
export function textOf(bytes: Uint8Array, name: string): string {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) {
    throw new ToolFailure(`${name} is a binary file, which is not shown here: open it from the notebook's Output tab on Kaggle.`);
  }
  return utf8Decode(bytes);
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
