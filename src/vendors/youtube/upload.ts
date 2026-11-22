import {
  cleanVendorText,
  formatNumber,
  OutcomeUnknown,
  retryAfterSeconds,
  sha256Hex,
  ToolFailure,
  utf8Decode,
  vendorMessage,
  type ToolHelpers,
} from '../../core/index.js';
import { plain } from './google.js';

// Uploads in parts, across calls when one call cannot send them all.
//
// YouTube's resumable upload
// (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
// takes a video in parts of one size, a multiple of 256 KiB (the last part may
// be smaller), each sent to the upload address with Content-Range. YouTube
// answers 308 with the bytes it has (its Range header), and 200 or 201 with
// the video once the last byte is in; an empty PUT with "Content-Range:
// bytes */TOTAL" asks how far it got. Each part is read from the video URL
// with a Range request just before it is sent, so a call holds one part at a
// time, and a call starts parts only while it has time left: then it returns
// a cursor. The next call asks YouTube how far it got and goes on from there.
// A byte YouTube confirmed is never sent again, nothing is retried, and the
// video is made once, by the request that carries its last byte.
//
// Two kinds of request go through ctx.fetch directly, as the core's helpers
// cannot make them yet: the Range download (h.media sends no Range header),
// and the PUTs to the upload address (h.api turns their 308 answer into an
// error and drops its Range header). They keep the helpers' rules: https
// only, nothing but Accept, User-Agent and Range with a download, the token
// only to YouTube's own upload address, the same log lines, capped replies
// and the same error words.
//
// A host that does not pass a download's Range header on, or a server that
// ignores it, answers with the whole file. The parts then come from that
// file, which works while it fits the host's download limit.

const API = 'https://www.googleapis.com';
const MIB = 1024 * 1024;
/** Every part but the last is a multiple of this (YouTube's rule). */
export const PART_UNIT = 256 * 1024;
export const DEFAULT_PART_MB = 8;
/** Parts stay within the smallest common host download limit (25 MiB). */
export const MAX_PART_MB = 24;
/** YouTube takes video files up to 256 GB. */
export const MAX_VIDEO_BYTES = 256 * 1024 * MIB;
/** The largest whole file held when a download comes back whole instead of as the part asked for. */
const MAX_WHOLE_BYTES = 256 * MIB;
/** A call starts another part only while the time it has run, plus 1.5 times its last part's, stays within this. */
export const CALL_BUDGET_MS = 35_000;
const MAX_REPLY_BYTES = 4 * MIB;
const USER_AGENT = 'agent-connectors';
const ACCEPT_VIDEO = 'video/*,application/octet-stream;q=0.8';
const VIDEO_TYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/3gpp', 'video/x-msvideo', 'video/webm', 'video/x-flv', 'video/x-ms-wmv', 'video/mpeg', 'video/mp2t',
]);
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/i;
const RECEIVED_RANGE = /^bytes=0-(\d{1,15})$/i;
/** A strong ETag (a weak one, W/"...", may stay the same when the bytes change). */
const STRONG_ETAG = /^(?!W\/)[\x21-\x7e]{1,200}$/;

export const GONE =
  'YouTube no longer has this upload: an upload that is not finished in time expires (or the cursor comes from another sign-in). '
  + 'If list_videos does not show the video, start the upload again without cursor.';
const START_AGAIN = 'The rest cannot be sent: upload the file again without cursor (YouTube drops the unfinished upload by itself).';

/** The upload address YouTube gave for a session, checked to be its own; undefined for any other. */
export function uploadAddress(location: string | null | undefined): string | undefined {
  if (!location) return undefined;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return undefined;
  }
  if (url.origin !== API || url.username || url.password || url.pathname !== '/upload/youtube/v3/videos' || !url.searchParams.get('upload_id')) {
    return undefined;
  }
  url.hash = '';
  return url.toString();
}

// ─── The upload a cursor carries ────────────────────────────────

export interface UploadState {
  /** The upload address. */
  session: string;
  /** The file's size in bytes. */
  total: number;
  /** The part size in bytes. */
  part: number;
  /** The file's video type, told by its first bytes. */
  type: string;
  /** The first 16 hex digits of the SHA-256 of the video URL: a cursor goes on only with its own URL. */
  source: string;
  /** The file's strong ETag when the upload started, when its server sent one. */
  etag?: string;
}

export async function sourceKey(videoUrl: string): Promise<string> {
  let normal = videoUrl;
  try {
    normal = new URL(videoUrl).toString();
  } catch {
    // compared as given
  }
  return (await sha256Hex(normal)).slice(0, 16);
}

/** What a cursor of the upload holds. It never changes during an upload: how far it got is asked of YouTube. */
export function cursorState(state: UploadState): Record<string, string | number> {
  return { s: state.session, n: state.total, p: state.part, y: state.type, u: state.source, ...(state.etag ? { e: state.etag } : {}) };
}

/** The upload a cursor holds, or undefined when it holds none (a cursor is plain base64 JSON anyone can write). */
export function stateFromCursor(raw: Record<string, unknown>): UploadState | undefined {
  const session = typeof raw['s'] === 'string' ? uploadAddress(raw['s']) : undefined;
  const total = raw['n'];
  const part = raw['p'];
  const type = raw['y'];
  const source = raw['u'];
  const etag = raw['e'];
  if (!session) return undefined;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > MAX_VIDEO_BYTES) return undefined;
  if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < PART_UNIT || part > MAX_PART_MB * MIB || part % PART_UNIT !== 0) return undefined;
  if (typeof type !== 'string' || !VIDEO_TYPES.has(type)) return undefined;
  if (typeof source !== 'string' || !/^[0-9a-f]{16}$/.test(source)) return undefined;
  if (etag !== undefined && (typeof etag !== 'string' || !STRONG_ETAG.test(etag))) return undefined;
  return { session, total, part, type, source, ...(typeof etag === 'string' ? { etag } : {}) };
}

// ─── Reading a part of the video ────────────────────────────────

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

function describe(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const code = errorCode(error);
  if (code === 'TIMEOUT' || name === 'TimeoutError') return 'the request timed out';
  if (code === 'ABORTED' || name === 'AbortError') return 'the request was cancelled';
  if (code === 'TOO_LARGE') return 'the reply was too large';
  return cleanVendorText((error as { message?: unknown } | null)?.message, 200) ?? 'a network error';
}

/** A reply body of at most `max` bytes; a longer one throws TooLong, and its stream is cancelled. */
async function readUpTo(response: Response, max: number): Promise<Uint8Array> {
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

const HOST_LIMIT =
  'The host refused the download as too large for it: it downloads at most a set size (often 25 to 50 MB), and either it does not '
  + 'pass byte-range requests (the Range header) on or the server ignored them, so the whole file came instead of one part, or its '
  + 'limit is below part_mb. Use a smaller video, a host that passes byte ranges on, or a smaller part_mb.';

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
    h.log(`youtube ${h.tool} media GET failed ${Date.now() - started}ms`);
    throw downloadProblem(error);
  }
  h.log(`youtube ${h.tool} media GET ${response.status} ${Date.now() - started}ms`);
  const tag = response.headers.get('etag')?.trim();
  const etag = tag && STRONG_ETAG.test(tag) ? tag : undefined;

  if (response.status === 206) {
    const match = CONTENT_RANGE.exec(response.headers.get('content-range')?.trim() ?? '');
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    const size = match?.[3];
    // The part asked for, cut short only by the end of the file: YouTube takes no shorter part but the last.
    const total = Number(size);
    if (!match || size === undefined || start !== first || end < start || end > last || (size !== '*' && (end >= total || (end !== last && end !== total - 1)))) {
      await response.body?.cancel().catch(() => {});
      throw new SourceProblem('The video URL answered with another part of the file than the one asked for.');
    }
    if (size === '*') {
      await response.body?.cancel().catch(() => {});
      throw new SourceProblem('The video URL did not say how large the file is, which YouTube needs to know.');
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
    throw new SourceProblem(`The video URL has no bytes from ${formatNumber(first)} on (HTTP 416): the file is ${first ? 'smaller than when the upload started' : 'empty'}.`);
  }
  throw new SourceProblem(`The video URL answered HTTP ${response.status}.`);
}

/** Why the file at the video URL is not the one the upload started with, or undefined. */
function changedSince(state: UploadState, part: SourcePart): string | undefined {
  if (part.total !== state.total) {
    return `The file at video_url is ${formatNumber(part.total)} bytes now, not the ${formatNumber(state.total)} it had when the upload started.`;
  }
  if (state.etag && part.etag && state.etag !== part.etag) return 'The file at video_url changed since the upload started (its ETag is different).';
  return undefined;
}

// ─── The upload address ─────────────────────────────────────────

export type SessionAnswer =
  /** The last byte is in: YouTube made the video. */
  | { kind: 'done'; video: any }
  /** YouTube has the first `received` bytes. */
  | { kind: 'more'; received: number }
  /** A clear refusal; `gone` when the upload no longer exists. */
  | { kind: 'refused'; status?: number; message: string; gone: boolean; retryAfter?: number }
  /** No clear answer (a 5xx, a timeout, a broken connection): the bytes may have arrived in whole, in part or not at all. */
  | { kind: 'unclear'; reason: string };

function parseReply(bytes: Uint8Array): unknown {
  if (!bytes.length) return null;
  const text = utf8Decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One PUT to the upload address, with the connection's token. Never retried. */
async function toSession(h: ToolHelpers, session: string, contentRange: string, body: Uint8Array, type?: string): Promise<SessionAnswer> {
  const started = Date.now();
  let response: Response;
  try {
    response = await h.ctx.fetch(session, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        authorization: `Bearer ${h.credentials['access_token'] ?? ''}`,
        'content-range': contentRange,
        ...(type ? { 'content-type': type } : {}),
      },
      body,
      ...(h.ctx.signal ? { signal: h.ctx.signal } : {}),
    });
  } catch (error) {
    h.log(`youtube ${h.tool} PUT failed ${Date.now() - started}ms`);
    if (errorCode(error) === 'URL_REFUSED') {
      return { kind: 'refused', gone: false, message: `The request to YouTube was blocked before it was sent (${describe(error)}).` };
    }
    return { kind: 'unclear', reason: describe(error) };
  }
  h.log(`youtube ${h.tool} PUT ${response.status} ${Date.now() - started}ms`);
  const { status } = response;
  if (status === 308) {
    await response.body?.cancel().catch(() => {});
    const range = response.headers.get('range')?.trim();
    if (!range) return { kind: 'more', received: 0 };
    const match = RECEIVED_RANGE.exec(range);
    return match ? { kind: 'more', received: Number(match[1]) + 1 } : { kind: 'unclear', reason: 'a byte range that could not be read' };
  }
  let data: unknown = null;
  try {
    data = parseReply(await readUpTo(response, MAX_REPLY_BYTES));
  } catch {
    if (status === 200 || status === 201 || status >= 500) return { kind: 'unclear', reason: `HTTP ${status}, but the reply could not be read` };
  }
  if (status === 200 || status === 201) {
    return typeof (data as { id?: unknown } | null)?.id === 'string'
      ? { kind: 'done', video: data }
      : { kind: 'unclear', reason: `HTTP ${status} without the video` };
  }
  const message = vendorMessage(data);
  const said = message ? `: ${plain(message).replace(/[.!?。]+$/u, '')}` : '';
  if (status >= 500) return { kind: 'unclear', reason: `HTTP ${status}${said}` };
  if (status === 404 || status === 410) return { kind: 'refused', status, gone: true, message: GONE };
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers);
    return {
      kind: 'refused',
      status,
      gone: false,
      message: `YouTube rate limit reached (HTTP 429). ${retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : 'Wait a while before going on.'}`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
  if (status === 401) {
    return { kind: 'refused', status, gone: false, message: `YouTube rejected the credentials (HTTP 401)${said}. Check that the YouTube access token is correct and still active.` };
  }
  if (status === 403) return { kind: 'refused', status, gone: false, message: `YouTube refused the upload (HTTP 403)${said}.` };
  return { kind: 'refused', status, gone: false, message: `YouTube rejected the upload request (HTTP ${status})${said}.` };
}

/** Asks YouTube how far the upload got. Changes nothing. */
export function askSession(h: ToolHelpers, state: UploadState): Promise<SessionAnswer> {
  return toSession(h, state.session, `bytes */${state.total}`, new Uint8Array(0));
}

function sendPart(h: ToolHelpers, state: UploadState, offset: number, bytes: Uint8Array): Promise<SessionAnswer> {
  return toSession(h, state.session, `bytes ${offset}-${offset + bytes.length - 1}/${state.total}`, bytes, state.type);
}

// ─── Sending parts ──────────────────────────────────────────────

/** The uploads a call is sending right now, by upload address (memory only, never logged). */
const sending = new Set<string>();

/**
 * Runs `run` as the only call sending this upload: two calls going on with
 * the same cursor at once would both start at the byte YouTube asks for, and
 * overlapping parts spoil a resumable upload.
 */
export async function exclusive<T>(state: UploadState, run: () => Promise<T>): Promise<T> {
  if (sending.has(state.session)) {
    throw new ToolFailure('Another call is sending this upload right now: wait for its result, then go on with the cursor. Nothing was sent.');
  }
  sending.add(state.session);
  try {
    return await run();
  } finally {
    sending.delete(state.session);
  }
}

export type UploadOutcome =
  | { done: true; video: any }
  /** `uploaded`: the bytes YouTube has. `stopped`: why the call stopped before its time was up. */
  | { done: false; uploaded: number; stopped?: string; retryAfter?: number };

export interface TransferRun {
  state: UploadState;
  videoUrl: string;
  /** The first byte YouTube does not have yet. */
  offset: number;
  /** When the call started (Date.now()). */
  started: number;
  /** The upload's cursor, for an unknown outcome's message. */
  cursor: string;
  /** Bytes already read from the video URL, and when that read started. */
  held?: SourcePart;
  heldSince?: number;
}

/** What to do after an unclear answer to the last part: go on with the cursor, which asks YouTube first. */
export function resumeHint(cursor: string): string {
  return `Calling upload_video again with the same arguments and cursor "${cursor}" is safe: it asks YouTube first, returns the video if it `
    + 'was made, and sends only the bytes YouTube does not have.';
}

/** After a part got no clear answer: asks YouTube where the upload stands (a read), and never sends the part again. */
async function settle(h: ToolHelpers, run: TransferRun, offset: number, final: boolean, reason: string): Promise<UploadOutcome> {
  const { state } = run;
  if (!h.ctx.signal?.aborted) {
    const status = await askSession(h, state);
    if (status.kind === 'done') return { done: true, video: status.video };
    if (status.kind === 'more' && status.received < state.total) {
      return {
        done: false,
        uploaded: status.received,
        stopped: `YouTube did not answer the last part clearly (${reason}); it has ${formatNumber(status.received)} of the ${formatNumber(state.total)} bytes.`,
      };
    }
    if (status.kind === 'refused' && status.gone) throw new ToolFailure(GONE);
  }
  if (final) {
    throw new OutcomeUnknown(`YouTube did not answer the last part of the upload (${reason}), so it is not known whether the video was made. ${resumeHint(run.cursor)}`);
  }
  return {
    done: false,
    uploaded: offset,
    stopped: `YouTube did not answer the last part clearly (${reason}), and could not say how far the upload got: the next call asks again before it sends anything.`,
  };
}

/**
 * Sends parts from `offset` on, each read just before it goes, while the call
 * has time: the first part always, another only while the time the call has
 * run plus 1.5 times the last part's stays within CALL_BUDGET_MS. Only the
 * part that carries the last byte can make the video.
 */
export async function transfer(h: ToolHelpers, run: TransferRun): Promise<UploadOutcome> {
  const { state, videoUrl, started } = run;
  let { offset, held } = run;
  let partStarted = run.heldSince ?? Date.now();
  let lastMs = 0;
  let sent = 0;
  let finalSent = false;
  try {
    for (;;) {
      if (sent > 0) {
        if (h.ctx.signal?.aborted) return { done: false, uploaded: offset, stopped: 'The call was cancelled.' };
        if (Date.now() - started + lastMs * 1.5 > CALL_BUDGET_MS) return { done: false, uploaded: offset };
        partStarted = Date.now();
      }
      const end = Math.min(offset + state.part, state.total);
      if (!held || held.start > offset || held.start + held.bytes.length < end) {
        try {
          held = await readPart(h, videoUrl, offset, end - 1);
        } catch (error) {
          if (error instanceof SourceProblem) return { done: false, uploaded: offset, stopped: `Reading the next part of the video failed. ${error.message}` };
          throw error;
        }
        const changed = changedSince(state, held);
        if (changed) throw new ToolFailure(`${changed} ${START_AGAIN}`);
      }
      const final = end === state.total;
      if (final) finalSent = true;
      const answer = await sendPart(h, state, offset, held.bytes.subarray(offset - held.start, end - held.start));
      sent += 1;
      lastMs = Date.now() - partStarted;
      if (answer.kind === 'done') return { done: true, video: answer.video };
      if (answer.kind === 'unclear') return await settle(h, run, offset, final, answer.reason);
      if (answer.kind === 'refused') {
        if (answer.gone) throw new ToolFailure(GONE);
        return { done: false, uploaded: offset, stopped: answer.message, ...(answer.retryAfter !== undefined ? { retryAfter: answer.retryAfter } : {}) };
      }
      if (answer.received >= state.total) return await settle(h, run, offset, final, 'every byte in, but no video back');
      // Never send the same part again in a loop: the next call goes on from what YouTube says it has.
      if (answer.received <= offset) return { done: false, uploaded: answer.received, stopped: 'YouTube took none of the last part, so the next call sends it again.' };
      offset = answer.received;
    }
  } catch (error) {
    if (error instanceof ToolFailure || error instanceof OutcomeUnknown || !finalSent) throw error;
    // A bug after the last part went out: the video may have been made.
    throw new OutcomeUnknown(`The upload stopped unexpectedly after its last part was sent to YouTube, so it is not known whether the video was made. ${resumeHint(run.cursor)}`);
  }
}
