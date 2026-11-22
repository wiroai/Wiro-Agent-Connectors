import { cleanVendorText, formatNumber, type ToolHelpers } from '../../core/index.js';

// Reads the video a FILE_UPLOAD sends, one chunk at a time, by byte range.
//
// The core's h.media sends no Range header yet, so these downloads go through
// ctx.fetch directly, with its rules: https only, no token, nothing but
// Accept, User-Agent and Range, the same log lines and capped reads.
//
// A host that does not pass a download's Range header on, or a server that
// ignores it, answers with the whole file (HTTP 200). The chunks then come from
// that file, which works while it fits the host's download limit.

const USER_AGENT = 'agent-connectors';
const ACCEPT_VIDEO = 'video/mp4,video/quicktime,video/webm,application/octet-stream;q=0.8';
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/i;
/** A strong ETag (a weak one, W/"...", may stay the same when the bytes change). */
export const STRONG_ETAG = /^(?!W\/)[\x21-\x7e]{1,200}$/;
/** The largest whole file held when a download comes back whole instead of as the part asked for. */
export const MAX_WHOLE_BYTES = 256 * 1024 * 1024;

/** Why a part of the video could not be read: one sentence, for the caller to finish. */
export class SourceProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceProblem';
  }
}

export interface SourcePart {
  /** The bytes read, from `start` on: the part asked for, or the whole file when the reply was not a range. */
  bytes: Uint8Array;
  start: number;
  /** The file's size. */
  total: number;
  etag?: string;
}

class TooLong extends Error {}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A failed request in plain words, never quoting a URL. */
export function describe(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const code = errorCode(error);
  if (code === 'TIMEOUT' || name === 'TimeoutError') return 'the request timed out';
  if (code === 'ABORTED' || name === 'AbortError') return 'the request was cancelled';
  if (code === 'TOO_LARGE') return 'the reply was too large';
  return cleanVendorText((error as { message?: unknown } | null)?.message, 200) ?? 'a network error';
}

/** A reply body of at most `max` bytes; a longer one throws TooLong, and its stream is cancelled. */
export async function readUpTo(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new TooLong();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLong();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export const HOST_LIMIT =
  'The host refused the download as too large for it: it downloads at most a set size (often 25 to 50 MB), and either it does not '
  + 'pass byte-range requests (the Range header) on or the server ignored them, so the whole file came instead of one chunk. Use a '
  + 'smaller video, a host that passes byte ranges on, or source PULL_FROM_URL from a domain or URL prefix verified in the TikTok '
  + 'app\'s URL properties, where TikTok downloads up to 4 GB itself.';

function downloadProblem(error: unknown): SourceProblem {
  const code = errorCode(error);
  if (code === 'URL_REFUSED') return new SourceProblem(`The video URL was refused (${describe(error)}). Use a public https URL.`);
  if (code === 'TOO_LARGE') return new SourceProblem(HOST_LIMIT);
  return new SourceProblem(`The video could not be downloaded (${describe(error)}).`);
}

async function readBody(response: Response, max: number, whole: boolean): Promise<Uint8Array> {
  try {
    return await readUpTo(response, max);
  } catch (error) {
    if (!(error instanceof TooLong)) throw downloadProblem(error);
    throw new SourceProblem(whole
      ? `The video URL sent the whole file instead of the part asked for, and it is larger than ${formatNumber(max)} bytes.`
      : 'The video URL sent more than the part asked for.');
  }
}

/**
 * Bytes `first` to `last` of the video, read with a Range request (the
 * module's own download: no token goes with it). A reply with the whole file
 * (200) is taken whole, while it fits.
 */
export async function readPart(h: ToolHelpers, videoUrl: string, first: number, last: number): Promise<SourcePart> {
  let url: URL;
  try {
    url = new URL(videoUrl);
  } catch {
    throw new SourceProblem('The video URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new SourceProblem('The video URL must start with https://.');
  const started = Date.now();
  let response: Response;
  try {
    response = await h.ctx.fetch(url.toString(), {
      method: 'GET',
      headers: { accept: ACCEPT_VIDEO, 'user-agent': USER_AGENT, range: `bytes=${first}-${last}` },
      ...(h.ctx.signal ? { signal: h.ctx.signal } : {}),
    });
  } catch (error) {
    h.log(`tiktok ${h.tool} media GET failed ${Date.now() - started}ms`);
    throw downloadProblem(error);
  }
  h.log(`tiktok ${h.tool} media GET ${response.status} ${Date.now() - started}ms`);
  const tag = response.headers.get('etag')?.trim();
  const etag = tag && STRONG_ETAG.test(tag) ? tag : undefined;

  if (response.status === 206) {
    const match = CONTENT_RANGE.exec(response.headers.get('content-range')?.trim() ?? '');
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    const size = match?.[3];
    const total = Number(size);
    // The part asked for, cut short only by the end of the file.
    if (!match || size === undefined || start !== first || end < start || end > last || (size !== '*' && (end >= total || (end !== last && end !== total - 1)))) {
      await response.body?.cancel().catch(() => {});
      throw new SourceProblem('The video URL answered with another part of the file than the one asked for.');
    }
    if (size === '*') {
      await response.body?.cancel().catch(() => {});
      throw new SourceProblem('The video URL did not say how large the file is, which TikTok needs to know before the upload starts.');
    }
    const bytes = await readBody(response, end - start + 1, false);
    if (bytes.length !== end - start + 1) throw new SourceProblem('The download of the video ended early.');
    return { bytes, start, total, ...(etag ? { etag } : {}) };
  }
  if (response.status === 200) {
    const bytes = await readBody(response, MAX_WHOLE_BYTES, true);
    return { bytes, start: 0, total: bytes.length, ...(etag ? { etag } : {}) };
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 416) {
    throw new SourceProblem(first
      ? `The video URL has no bytes from ${formatNumber(first)} on (HTTP 416): the file is smaller than when the upload started.`
      : 'The video URL has no bytes (HTTP 416): the file is empty.');
  }
  throw new SourceProblem(`The video URL answered HTTP ${response.status}.`);
}
