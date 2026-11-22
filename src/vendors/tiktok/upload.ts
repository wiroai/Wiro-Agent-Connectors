import { cleanVendorText, formatNumber, OutcomeUnknown, retryAfterSeconds, sha256Hex, ToolFailure, utf8Decode, vendorMessage, type ToolHelpers } from '../../core/index.js';
import { chunkAt, chunkPlan, MAX_VIDEO_BYTES, planFor, VIDEO_TYPES, type VideoType } from './media.js';
import { describe, readPart, readUpTo, SourceProblem, STRONG_ETAG, type SourcePart } from './source.js';

// A FILE_UPLOAD in chunks, across calls when one call cannot send them all.
//
// TikTok's media transfer guide
// (https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
// takes the video in the chunks the post was started with, in order, each sent
// with Content-Range to the upload address. TikTok answers 206 while more
// chunks are to come, 201 once the last one is in (TikTok then makes the post),
// and 416 to a chunk that does not continue where its upload stands. The
// post's status (uploaded_bytes) says how far it got. The address works for an
// hour after the post was started.
//
// Each chunk is read from the video URL with a Range request just before it is
// sent, so a call holds about one chunk at a time, and a call starts chunks
// only while it has time left: then it returns a cursor with the next byte.
// The next call asks TikTok's status first and goes on from there. Nothing is
// retried within a call, and the post is made once, by the request that
// carries the last chunk: the cursor belongs to that one post, so going on
// with it never makes a second one.
//
// The PUTs go through ctx.fetch directly, so that each answer can be told
// apart: they keep the helpers' rules (only TikTok's own upload hosts, the
// same log lines, capped replies). The upload address carries its own token,
// so the connection's token never goes with them.

/** The upload hosts TikTok's media transfer guide shows. Origins are exact: an upload address on any other host is refused before anything is sent. */
export const UPLOAD_ORIGINS = ['https://open-upload.tiktokapis.com', 'https://upload.us.tiktokapis.com'];
/** A call starts another chunk only while the time it has run, plus 1.5 times its last chunk's, stays within this. */
export const CALL_BUDGET_MS = 35_000;
/** TikTok's upload address works for an hour after the post was started. */
export const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
const PUBLISH_ID = /^[A-Za-z0-9._~-]{1,64}$/;
const USER_AGENT = 'agent-connectors';
const MAX_REPLY_BYTES = 64 * 1024;
/** Statuses after which TikTok takes no more chunks: the post went out, went to the inbox, or failed. */
const ENDED = new Set(['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED']);

export const START_AGAIN = 'The rest cannot be sent, and nothing was posted: post the video again without cursor.';
const EXPIRED =
  'TikTok refused the chunk because the post\'s upload address expired (HTTP 403): it works for an hour after the post was started. '
  + START_AGAIN;
const GONE =
  'TikTok has no upload for this post any more (HTTP 404): its upload address works for an hour after the post was started. If '
  + 'get_post_status does not show the post, post the video again without cursor.';

/** The upload address TikTok gave, checked to be on its own upload hosts; undefined for any other. */
export function uploadAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!UPLOAD_ORIGINS.includes(url.origin) || url.username || url.password) return undefined;
  url.hash = '';
  return url.toString();
}

// ─── The upload a cursor carries ────────────────────────────────

export interface UploadState {
  /** The upload address (it carries TikTok's own upload token and works for an hour). */
  uploadUrl: string;
  publishId: string;
  /** The file's size in bytes. */
  total: number;
  /** The chunk size the post was started with. */
  chunkSize: number;
  /** The file's video type, told by its first bytes. */
  type: VideoType;
  /** The first 16 hex digits of the SHA-256 of the video URL: a cursor goes on only with its own URL. */
  source: string;
  /** The file's strong ETag when the upload started, when its server sent one. */
  etag?: string;
  /** true for a draft sent to the creator's inbox (MEDIA_UPLOAD). */
  inbox: boolean;
  /** When the post was started (Date.now()), to say when the upload address expires. */
  startedAt: number;
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

/** What a cursor of the upload holds: the post, and the first byte TikTok did not confirm yet. */
export function cursorState(state: UploadState, offset: number): Record<string, string | number> {
  return {
    s: state.uploadUrl,
    i: state.publishId,
    n: state.total,
    c: state.chunkSize,
    o: offset,
    y: state.type,
    u: state.source,
    m: state.inbox ? 'i' : 'd',
    a: Math.floor(state.startedAt / 1000),
    ...(state.etag ? { e: state.etag } : {}),
  };
}

/** The upload a cursor holds, or undefined when it holds none (a cursor is plain base64 JSON anyone can write). */
export function stateFromCursor(raw: Record<string, unknown>): { state: UploadState; offset: number } | undefined {
  const uploadUrl = uploadAddress(raw['s']);
  const { i: publishId, n: total, c: chunkSize, o: offset, y: type, u: source, m: mode, a: started, e: etag } = raw;
  if (!uploadUrl || typeof publishId !== 'string' || !PUBLISH_ID.test(publishId)) return undefined;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > MAX_VIDEO_BYTES) return undefined;
  // The chunk size this connector starts a post with: anything else did not come from it.
  if (typeof chunkSize !== 'number' || chunkSize !== chunkPlan(total).chunkSize) return undefined;
  if (typeof offset !== 'number' || chunkAt(planFor(total, chunkSize), offset) === -1) return undefined;
  if (typeof type !== 'string' || !(VIDEO_TYPES as readonly string[]).includes(type)) return undefined;
  if (typeof source !== 'string' || !/^[0-9a-f]{16}$/.test(source)) return undefined;
  if (mode !== 'd' && mode !== 'i') return undefined;
  if (typeof started !== 'number' || !Number.isSafeInteger(started) || started < 1) return undefined;
  if (etag !== undefined && (typeof etag !== 'string' || !STRONG_ETAG.test(etag))) return undefined;
  return {
    state: {
      uploadUrl,
      publishId,
      total,
      chunkSize,
      type: type as VideoType,
      source,
      ...(typeof etag === 'string' ? { etag } : {}),
      inbox: mode === 'i',
      startedAt: started * 1000,
    },
    offset,
  };
}

// ─── One at a time ──────────────────────────────────────────────

/** The posts a call is sending right now, by publish_id (memory only, never logged). */
const sending = new Set<string>();

/**
 * Runs `run` as the only call sending this post's video: two calls going on
 * with the same cursor at once would send the same chunk twice.
 */
export async function exclusive<T>(publishId: string, run: () => Promise<T>): Promise<T> {
  if (sending.has(publishId)) {
    throw new ToolFailure('Another call is sending this video right now: wait for its result, then go on with its nextCursor. Nothing was sent.');
  }
  sending.add(publishId);
  try {
    return await run();
  } finally {
    sending.delete(publishId);
  }
}

// ─── One chunk to the upload address ────────────────────────────

type ChunkAnswer =
  /** 201: every chunk is in, and TikTok makes the post. */
  | { kind: 'complete' }
  /** Another 2xx (206): TikTok took the chunk and waits for more. */
  | { kind: 'more' }
  /** 416: the chunk does not continue where TikTok's upload stands. */
  | { kind: 'mismatch' }
  /** A clear refusal: TikTok did not take the chunk. `resumable` when the same chunk can go later (a rate limit). */
  | { kind: 'refused'; message: string; resumable: boolean; status?: number; retryAfter?: number }
  /** No clear answer (a 5xx, a timeout, a broken connection): the chunk may or may not be in. */
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

/** TikTok's own words from an upload reply: its error message, or the top-level one. */
function said(data: unknown): string {
  const error = (data as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  const message = cleanVendorText(typeof error?.message === 'string' && error.message ? error.message : undefined)
    ?? (typeof error?.code === 'string' ? cleanVendorText(error.code) : undefined)
    ?? vendorMessage(data);
  return message ? `: ${message.replace(/[.!?]+$/u, '')}` : '';
}

/** One PUT of bytes `first` to `last` to the upload address. Never retried. */
async function putChunk(h: ToolHelpers, state: UploadState, first: number, last: number, bytes: Uint8Array): Promise<ChunkAnswer> {
  const started = Date.now();
  let response: Response;
  try {
    response = await h.ctx.fetch(state.uploadUrl, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        'content-type': state.type,
        'content-range': `bytes ${first}-${last}/${state.total}`,
      },
      body: bytes,
      ...(h.ctx.signal ? { signal: h.ctx.signal } : {}),
    });
  } catch (error) {
    h.log(`tiktok ${h.tool} PUT failed ${Date.now() - started}ms`);
    if ((error as { code?: unknown } | null)?.code === 'URL_REFUSED') {
      return { kind: 'refused', resumable: false, message: `The upload to TikTok was blocked before it was sent (${describe(error)}).` };
    }
    return { kind: 'unclear', reason: describe(error) };
  }
  h.log(`tiktok ${h.tool} PUT ${response.status} ${Date.now() - started}ms`);
  const { status } = response;
  let data: unknown = null;
  try {
    data = parseReply(await readUpTo(response, MAX_REPLY_BYTES));
  } catch {
    if ((status >= 200 && status < 300) || status >= 500) return { kind: 'unclear', reason: `HTTP ${status}, but the reply could not be read` };
  }
  if (status === 201) return { kind: 'complete' };
  if (status >= 200 && status < 300) return { kind: 'more' };
  if (status === 416) return { kind: 'mismatch' };
  if (status >= 500) return { kind: 'unclear', reason: `HTTP ${status}${said(data)}` };
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers);
    return {
      kind: 'refused',
      resumable: true,
      status,
      message: `TikTok rate limit reached (HTTP 429). ${retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : 'Wait a while before going on.'}`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
  if (status === 403) return { kind: 'refused', resumable: false, status, message: EXPIRED };
  if (status === 404) return { kind: 'refused', resumable: false, status, message: GONE };
  if (status >= 400) {
    return { kind: 'refused', resumable: false, status, message: `TikTok rejected a chunk of the video (HTTP ${status})${said(data)}. ${START_AGAIN}` };
  }
  return { kind: 'unclear', reason: `an unexpected HTTP ${status}` };
}

// ─── Sending chunks ─────────────────────────────────────────────

/** Where TikTok says the post stands: its status and, while it uploads, how many bytes it has. */
export interface StatusSnapshot {
  status: string;
  uploadedBytes?: number;
}

export type UploadOutcome =
  /** Every chunk is in, or TikTok ended the post: follow its status. */
  | { done: true }
  /** `uploaded`: the first byte TikTok does not have yet. `stopped`: why the call stopped before its time was up. */
  | { done: false; uploaded: number; stopped?: string; retryAfter?: number };

export interface TransferRun {
  state: UploadState;
  videoUrl: string;
  /** The first byte TikTok does not have yet: the start of a chunk. */
  offset: number;
  /** When the call started (Date.now()). */
  started: number;
  /** The cursor that goes on from a byte, for an unknown outcome's message. */
  cursor(offset: number): string;
  /** Reads the post's status (a read; throws when it cannot be read). */
  readStatus(): Promise<StatusSnapshot>;
  /** Bytes already read from the video URL, and when that read started. */
  held?: SourcePart;
  heldSince?: number;
}

/** What to do after an unclear answer to the last chunk: go on with the cursor, which asks TikTok first. */
export function resumeHint(cursor: string): string {
  return `Calling post_video again with the same video_url and cursor "${cursor}" is safe: it asks TikTok first, follows the post if TikTok `
    + 'has the whole video, and sends only what TikTok lacks; the cursor belongs to this one post, so it never makes a second one.';
}

/** Why the file at the video URL is not the one the upload started with, or undefined. */
function changedSince(state: UploadState, part: SourcePart): string | undefined {
  if (part.total !== state.total) {
    return `The file at video_url is ${formatNumber(part.total)} bytes now, not the ${formatNumber(state.total)} it had when the upload started.`;
  }
  if (state.etag && part.etag && state.etag !== part.etag) return 'The file at video_url changed since the upload started (its ETag is different).';
  return undefined;
}

/**
 * Bytes `first` to `last` of the video: from what is held when it covers
 * them, else read by byte range. A held start of the chunk (the first read of
 * a post asks for 10 MB, while its one chunk can be nearly twice that) is kept,
 * and only the rest is read.
 */
async function chunkBytes(h: ToolHelpers, run: TransferRun, held: SourcePart | undefined, first: number, last: number): Promise<{ bytes: Uint8Array; held: SourcePart }> {
  const covers = (part: SourcePart): boolean => part.start <= first && part.start + part.bytes.length > last;
  if (held && covers(held)) return { bytes: held.bytes.subarray(first - held.start, last + 1 - held.start), held };
  const prefix = held && held.start <= first && held.start + held.bytes.length > first ? held.bytes.subarray(first - held.start) : undefined;
  const from = first + (prefix?.length ?? 0);
  const part = await readPart(h, run.videoUrl, from, last);
  const changed = changedSince(run.state, part);
  if (changed) throw new ToolFailure(`${changed} ${START_AGAIN}`);
  if (covers(part)) return { bytes: part.bytes.subarray(first - part.start, last + 1 - part.start), held: part };
  if (!prefix || part.start !== from || part.start + part.bytes.length <= last) {
    throw new SourceProblem('The video URL answered with another part of the file than the one asked for.');
  }
  const bytes = new Uint8Array(last - first + 1);
  bytes.set(prefix, 0);
  bytes.set(part.bytes.subarray(0, last + 1 - from), prefix.length);
  return { bytes, held: { bytes, start: first, total: part.total, ...(part.etag ? { etag: part.etag } : {}) } };
}

/** Reads the post's status for a decision, or undefined when it cannot be read (or the call was cancelled). */
async function where(h: ToolHelpers, run: TransferRun): Promise<StatusSnapshot | undefined> {
  if (h.ctx.signal?.aborted) return undefined;
  try {
    return await run.readStatus();
  } catch (error) {
    if (error instanceof ToolFailure) return undefined;
    throw error;
  }
}

/**
 * Sends chunks from `offset` on, each read just before it goes, while the call
 * has time: the first chunk always, another only while the time the call has
 * run plus 1.5 times the last chunk's stays within CALL_BUDGET_MS. Only the
 * chunk that carries the last byte can make the post.
 */
export async function transfer(h: ToolHelpers, run: TransferRun): Promise<UploadOutcome> {
  const { state, started } = run;
  const plan = planFor(state.total, state.chunkSize);
  let { offset, held } = run;
  let chunkStarted = run.heldSince ?? Date.now();
  let lastMs = 0;
  let sent = 0;
  let finalSent = false;
  let resynced = false;
  try {
    for (;;) {
      const index = chunkAt(plan, offset);
      if (index === -1) throw new ToolFailure(`TikTok's upload of this video is at byte ${formatNumber(offset)}, where no chunk starts. ${START_AGAIN}`);
      if (sent > 0) {
        if (h.ctx.signal?.aborted) return { done: false, uploaded: offset, stopped: 'The call was cancelled.' };
        if (Date.now() - started + lastMs * 1.5 > CALL_BUDGET_MS) return { done: false, uploaded: offset };
        chunkStarted = Date.now();
      }
      const [first, last] = plan.ranges[index] as [number, number];
      let bytes: Uint8Array;
      try {
        ({ bytes, held } = await chunkBytes(h, run, held, first, last));
      } catch (error) {
        if (error instanceof SourceProblem) return { done: false, uploaded: offset, stopped: `Reading the next chunk of the video failed. ${error.message}` };
        throw error;
      }
      const final = index === plan.count - 1;
      if (final) finalSent = true;
      const answer = await putChunk(h, state, first, last, bytes);
      sent += 1;
      lastMs = Date.now() - chunkStarted;

      if (answer.kind === 'complete') return { done: true };
      if (answer.kind === 'more' && !final) {
        offset = last + 1;
        continue;
      }
      if (answer.kind === 'refused') {
        if (!answer.resumable) throw new ToolFailure(answer.message, answer.status !== undefined ? { status: answer.status } : {});
        return { done: false, uploaded: offset, stopped: answer.message, ...(answer.retryAfter !== undefined ? { retryAfter: answer.retryAfter } : {}) };
      }
      if (answer.kind === 'mismatch') {
        // TikTok says its upload is elsewhere: its status says where, once a call.
        const status = resynced ? undefined : await where(h, run);
        if (status && (ENDED.has(status.status) || status.uploadedBytes === state.total)) return { done: true };
        const at = status?.uploadedBytes;
        if (at !== undefined && at !== first && chunkAt(plan, at) !== -1) {
          resynced = true;
          offset = at;
          continue;
        }
        const refusal = `TikTok refused the chunk of bytes ${formatNumber(first)} to ${formatNumber(last)} (HTTP 416): its upload of this video is not at `
          + 'that point, and its status did not say where it is.';
        // The last chunk may have gone through in an earlier call whose answer was unclear: the post may exist.
        throw new ToolFailure(
          final
            ? `${refusal} TikTok may already have the whole video: if get_post_status with publish_id ${state.publishId} does not show the post, post the video again without cursor.`
            : `${refusal} ${START_AGAIN}`,
          { status: 416 },
        );
      }
      // No clear answer, or "more" after the last chunk: TikTok's status says whether the chunk is in. It is never sent again in this call.
      const reason = answer.kind === 'unclear' ? answer.reason : 'TikTok asked for more after the last chunk';
      const status = await where(h, run);
      if (status && (ENDED.has(status.status) || status.uploadedBytes === state.total)) return { done: true };
      if (status?.uploadedBytes === last + 1 && !final) {
        offset = last + 1;
        continue;
      }
      if (status?.uploadedBytes === first) {
        return { done: false, uploaded: first, stopped: `TikTok did not answer the last chunk sent clearly (${reason}), and does not have it: the next call sends it again.` };
      }
      if (final) {
        throw new OutcomeUnknown(
          `TikTok did not answer the last chunk of the video clearly (${reason}), so it is not known whether the post was started. ${resumeHint(run.cursor(first))}`,
        );
      }
      return {
        done: false,
        uploaded: first,
        stopped: `TikTok did not answer the last chunk sent clearly (${reason}), and could not say how far the upload got: the next call asks again before it sends anything.`,
      };
    }
  } catch (error) {
    if (error instanceof ToolFailure || error instanceof OutcomeUnknown || !finalSent) throw error;
    // A bug after the last chunk went out: the post may have been started.
    throw new OutcomeUnknown(`The upload stopped unexpectedly after its last chunk was sent to TikTok, so it is not known whether the post was started. ${resumeHint(run.cursor(offset))}`);
  }
}
