// TikTok, through the TikTok Content Posting API and the Display API (user
// info and videos) on https://open.tiktokapis.com/v2/.
//
// Credentials:
// - `access_token`: the current OAuth access token of the creator who signed
//   in (permissions user.info.basic and video.publish; video.upload for inbox
//   drafts, video.list to read videos). The host refreshes it; this module
//   never does.
// - `tiktokusername` and `openid` (optional): the creator's display name and
//   open id, as the host wrote them after the sign-in. Only shown back.
//
// A video goes to TikTok either by PULL_FROM_URL (TikTok downloads it; the
// URL's domain or prefix must be verified in the app's URL properties) or by
// FILE_UPLOAD (this module reads it from a public https URL and sends it in
// chunks to the upload address TikTok returns). A FILE_UPLOAD reads each
// chunk by byte range just before it sends it, and goes on across calls with
// a cursor when one call cannot send them all (upload.ts), so no call holds
// more than about one chunk, whatever the size of the video.
// TikTok has no upload for photos: they are always PULL_FROM_URL, so photo
// URLs must be on a verified domain or prefix too, and TikTok refuses others.
//
// Hosts end a tool call after about a minute and drop a late result, so a
// call sends chunks and follows TikTok's status only until 35 seconds into
// the call, then returns its cursor or publish_id; the next call, or
// get_post_status, goes on from there.

import { apiTools, cleanVendorText, defineConnector, formatNumber, OutcomeUnknown, ToolFailure, truncate, utf8Bytes, type ApiRequest, type ToolHelpers } from '../../core/index.js';
import { chunkAt, CHUNK_BYTES, chunkPlan, MAX_VIDEO_BYTES, planFor, sniffVideo } from './media.js';
import { readPart, SourceProblem, type SourcePart } from './source.js';
import {
  cursorState,
  exclusive,
  sourceKey,
  stateFromCursor,
  transfer,
  UPLOAD_LIFETIME_MS,
  UPLOAD_ORIGINS,
  uploadAddress,
  type TransferRun,
  type UploadState,
} from './upload.js';

const PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
const POLL_SECONDS = 5;
/** No status read starts later than this into a call: hosts end a call after about a minute and drop a late result. */
const STATUS_BUDGET_MS = 35_000;
const MAX_WAIT_SECONDS = 30;
const DONE = new Set(['PUBLISH_COMPLETE', 'FAILED', 'SEND_TO_USER_INBOX']);
const PUBLISH_ID = '^[A-Za-z0-9._~-]{1,64}$';
const PUBLISH_PATTERN = new RegExp(PUBLISH_ID);
const HTTPS_URL = { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000 };
const JSON_TYPE = 'application/json; charset=UTF-8';
const READ_TOOLS = new Set(['get_creator_info', 'get_profile', 'get_post_status', 'list_videos', 'get_videos', 'api_get']);
const VIDEO_FIELDS = [
  'id', 'title', 'video_description', 'create_time', 'share_url', 'duration', 'height', 'width', 'cover_image_url',
  'embed_link', 'embed_html', 'view_count', 'like_count', 'comment_count', 'share_count', 'is_aigc',
] as const;
const DEFAULT_VIDEO_FIELDS = ['id', 'title', 'video_description', 'create_time', 'share_url', 'duration', 'view_count', 'like_count', 'comment_count', 'share_count'];
/** Direct-post settings a video sent to the inbox (MEDIA_UPLOAD) cannot carry: TikTok's inbox upload takes the file only. */
const DIRECT_ONLY_VIDEO = ['caption', 'privacy_level', 'disable_comment', 'disable_duet', 'disable_stitch', 'cover_timestamp_ms', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc'] as const;
/** Direct-post settings of a photo post that TikTok ignores in the inbox. */
const DIRECT_ONLY_PHOTO = ['privacy_level', 'disable_comment', 'auto_add_music', 'brand_content_toggle', 'brand_organic_toggle'] as const;

type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];
type PostMode = 'DIRECT_POST' | 'MEDIA_UPLOAD';

const FAIL_REASONS: Record<string, string> = {
  file_format_check_failed: 'TikTok does not support the file format',
  duration_check_failed: 'the video is too short or too long for this creator',
  frame_rate_check_failed: 'the frame rate is not supported (23 to 60 FPS)',
  picture_size_check_failed: 'the picture size is not supported',
  internal: 'TikTok had an internal error',
  video_pull_failed: 'TikTok could not download the video from the URL within an hour',
  photo_pull_failed: 'TikTok could not download a photo from its URL within an hour',
  publish_cancelled: 'the upload was cancelled',
  auth_removed: 'the creator removed the app\'s access while it was processing',
  spam_risk_too_many_posts: 'the creator posted too many times through the API in 24 hours',
  spam_risk_user_banned_from_posting: 'the creator is banned from posting',
  spam_risk_text: 'TikTok flagged the text as risky',
  spam_risk: 'TikTok flagged the post as risky',
};

/** Why TikTok refuses a post with HTTP 403, whatever its source. */
const REFUSAL_CAUSES =
  'an app TikTok has not audited may post only with privacy_level SELF_ONLY to a private account; the creator may have reached '
  + 'the daily post limit, be barred from posting, or not allow that privacy level; the app may have reached its cap of active '
  + 'creators; the inbox takes at most 5 pending drafts a day';
const POST_REFUSED = `TikTok refused the post (${REFUSAL_CAUSES})`;
// TikTok answers HTTP 403 (url_ownership_unverified) to a URL whose host is not verified for the app, the
// usual reason it refuses a post it would download itself, so those refusals say that first.
const PULL_REFUSED =
  'TikTok refused the post (with PULL_FROM_URL, TikTok downloads the video itself, only from a domain or URL prefix verified in the '
  + 'TikTok app\'s URL properties: use a URL on such a host, or source FILE_UPLOAD, which needs no verification; other causes: '
  + `${REFUSAL_CAUSES})`;
const PHOTO_REFUSED =
  'TikTok refused the photo post (TikTok downloads photos itself, only from a domain or URL prefix verified in the TikTok app\'s URL '
  + 'properties: use photo URLs on such a host, such as the creator\'s own website, or make a video of the photos and post it with '
  + `post_video, whose FILE_UPLOAD needs no verification; other causes: ${REFUSAL_CAUSES})`;
const GO_ON =
  'call post_video again with the same video_url and cursor set to nextCursor, until done is true. Each call sends the next chunks: '
  + 'no chunk goes twice, and the cursor belongs to this one post, so no second post is made. Go on soon: the upload must be finished '
  + 'by uploadExpiresAt, an hour after the post was started (TikTok\'s limit).';
const INBOX_REFUSED =
  'TikTok refused the inbox upload: MEDIA_UPLOAD needs the video.upload permission, which this connection may not have '
  + '(sign in to TikTok again with it, or use DIRECT_POST), or the token is no longer valid';
const VIDEO_LIST_REFUSED = 'TikTok refused to read videos: the connection needs the video.list permission, or its token is no longer valid';

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function jsonBody(value: unknown): Pick<ApiRequest, 'body' | 'contentType'> {
  return { body: utf8Bytes(JSON.stringify(value)), contentType: JSON_TYPE };
}

/**
 * One request to the TikTok API. TikTok can answer HTTP 200 with an error
 * (error.code other than "ok"); that is a failure too, and for a write it
 * means nothing was changed.
 */
async function tiktok(h: ToolHelpers, request: ApiRequest): Promise<any> {
  const response = await h.api(request);
  const error = response.data?.error;
  if (error && typeof error.code === 'string' && error.code !== 'ok') {
    const message = cleanVendorText(error.message);
    throw new ToolFailure(
      `TikTok refused the request (${error.code})${message ? `: ${message.replace(/[.!?]+$/, '')}` : ''}.${READ_TOOLS.has(h.tool) ? '' : ' Nothing was changed.'}`,
      { status: response.status, vendorCode: error.code },
    );
  }
  return response.data?.data ?? {};
}

interface CreatorInfo {
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}

async function creatorInfo(h: ToolHelpers): Promise<CreatorInfo> {
  const data = await tiktok(h, {
    method: 'POST',
    path: '/v2/post/publish/creator_info/query/',
    headers: { 'content-type': JSON_TYPE },
    safe: true,
  });
  return {
    username: typeof data?.creator_username === 'string' ? data.creator_username : undefined,
    nickname: typeof data?.creator_nickname === 'string' ? data.creator_nickname : undefined,
    avatarUrl: typeof data?.creator_avatar_url === 'string' ? data.creator_avatar_url : undefined,
    privacyLevelOptions: Array.isArray(data?.privacy_level_options) ? data.privacy_level_options.map(String) : [],
    commentDisabled: data?.comment_disabled === true,
    duetDisabled: data?.duet_disabled === true,
    stitchDisabled: data?.stitch_disabled === true,
    maxVideoPostDurationSec: typeof data?.max_video_post_duration_sec === 'number' ? data.max_video_post_duration_sec : undefined,
  };
}

interface PublishStatus {
  status: string;
  failReason?: string;
  postIds?: string[];
  /** TikTok sent post ids as numbers too long for JSON to keep exact, so they are left out rather than given wrong. */
  postIdsInexact?: boolean;
  uploadedBytes?: number;
  downloadedBytes?: number;
}

async function fetchStatus(h: ToolHelpers, publishId: string): Promise<PublishStatus> {
  const data = await tiktok(h, {
    method: 'POST',
    path: '/v2/post/publish/status/fetch/',
    ...jsonBody({ publish_id: publishId }),
    safe: true,
    errors: { 400: 'TikTok knows no such publish_id for this account' },
  });
  // TikTok spells the field "publicaly_available_post_id", and sends int64 numbers: an id
  // beyond 2^53 cannot be read exactly from JSON, so only exact ones are passed on.
  const ids: unknown[] = Array.isArray(data?.publicaly_available_post_id ?? data?.publicly_available_post_id)
    ? (data?.publicaly_available_post_id ?? data?.publicly_available_post_id)
    : [];
  const exact = ids.filter((id) => (typeof id === 'string' && /^[0-9]{1,30}$/.test(id)) || Number.isSafeInteger(id)).map(String);
  return compact({
    status: typeof data?.status === 'string' ? data.status : 'UNKNOWN',
    failReason: typeof data?.fail_reason === 'string' && data.fail_reason ? data.fail_reason : undefined,
    postIds: exact.length ? exact : undefined,
    postIdsInexact: exact.length < ids.length ? true : undefined,
    uploadedBytes: typeof data?.uploaded_bytes === 'number' ? data.uploaded_bytes : undefined,
    downloadedBytes: typeof data?.downloaded_bytes === 'number' ? data.downloaded_bytes : undefined,
  }) as unknown as PublishStatus;
}

/** Waits `ms`, or less when the call is cancelled; resolves false when it was. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function explainFailure(reason: string | undefined): string {
  return (reason && FAIL_REASONS[reason]) || (reason ? `TikTok reported ${reason}` : 'TikTok gave no reason');
}

interface Followed {
  status: PublishStatus;
  /** Why the wait ended before TikTok was done: the call's time ran out, or it was cancelled. */
  stopped?: 'time' | 'cancelled';
}

/**
 * Reads a post's status (unless `known` is one just read), then again every 5
 * seconds until TikTok is done, `waitSeconds` pass, or the next read would
 * start after `deadline` (a time from Date.now()). A failed read throws.
 */
async function follow(h: ToolHelpers, publishId: string, waitSeconds: number, deadline: number, known?: PublishStatus): Promise<Followed> {
  let status = known ?? await fetchStatus(h, publishId);
  let waited = 0;
  while (!DONE.has(status.status) && waited < waitSeconds) {
    const step = Math.min(POLL_SECONDS, waitSeconds - waited);
    if (Date.now() + step * 1000 > deadline) return { status, stopped: 'time' };
    if (!(await pause(step * 1000, h.ctx.signal))) return { status, stopped: 'cancelled' };
    waited += step;
    status = await fetchStatus(h, publishId);
  }
  return { status };
}

/**
 * Follows a started post until it is done, `waitSeconds` pass or the call's
 * status budget (`deadline`) runs out, from `known` when its status was just
 * read. The post is already under way, so a failed status read is reported,
 * never thrown: the caller must not post again because of it.
 */
async function finish(
  h: ToolHelpers,
  publishId: string,
  waitSeconds: number,
  deadline: number,
  extra: Record<string, unknown>,
  notes: string[] = [],
  known?: PublishStatus,
): Promise<Record<string, unknown>> {
  let status: PublishStatus | undefined;
  let note: string | undefined;
  if (Date.now() >= deadline && !known) {
    note = 'Sending it took most of the call, so its status was not read.';
  } else {
    try {
      const followed = await follow(h, publishId, waitSeconds, deadline, known);
      status = followed.status;
      if (followed.stopped === 'cancelled') note = 'Stopped waiting because the call was cancelled.';
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
      note = `The post was sent, but its status could not be read (${error.message.replace(/ Nothing was changed\.$/, '')}).`;
    }
  }
  if (status?.status === 'FAILED') {
    throw new ToolFailure(`TikTok did not publish it: ${explainFailure(status.failReason)} (publish_id ${publishId}). Nothing was posted.`, status.failReason ? { vendorCode: status.failReason } : {});
  }
  const state = status?.status ?? 'UNKNOWN';
  const all = [...notes, ...(note ? [note] : [])];
  if (status?.postIdsInexact) all.push('TikTok\'s post id is too long to pass on exactly; the post is on the creator\'s profile.');
  if (!status) {
    all.push(`Call get_post_status with publish_id ${publishId} to see whether TikTok published it; do not post it again.`);
  } else if (!DONE.has(state)) {
    all.push(`TikTok is still processing it, which often takes a minute or more. Call get_post_status with publish_id ${publishId} (it can wait up to ${MAX_WAIT_SECONDS} seconds) to follow it; do not post it again.`);
  }
  return compact({
    publishId,
    status: state,
    published: state === 'PUBLISH_COMPLETE',
    sentToInbox: state === 'SEND_TO_USER_INBOX' ? true : undefined,
    postIds: status?.postIds,
    ...extra,
    note: all.length ? all.join(' ') : undefined,
  });
}

/**
 * An unclear post init: TikTok may have started the post, but sent back no
 * publish_id to follow it with, so the only check is the TikTok app.
 */
function withoutPublishId(error: OutcomeUnknown, inbox: boolean): OutcomeUnknown {
  const where = inbox ? 'among the drafts TikTok sends to the creator\'s inbox' : 'on the creator\'s TikTok profile';
  return new OutcomeUnknown(
    `${error.message} TikTok sent back no publish_id, so get_post_status has nothing to look up: before posting again, `
      + `look for the post ${where} in the TikTok app, where it can take a few minutes to appear.`,
  );
}

/** Refuses direct-post settings in a post sent to the creator's inbox, before anything is sent. */
function refuseInboxSettings(args: object, names: readonly string[], what: string): void {
  const given = names.filter((name) => (args as Record<string, unknown>)[name] !== undefined);
  if (!given.length) return;
  throw new ToolFailure(
    `TikTok's inbox upload (MEDIA_UPLOAD) takes no ${given.join(', ')}: the creator sets ${what} in the TikTok app when they post the draft. `
      + 'Leave them out, or use DIRECT_POST. Nothing was posted.',
  );
}

function videoTime(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,12}$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

/** One video of the Display API, with the requested fields in camelCase. */
function trimVideo(video: any, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = video?.[field];
    if (value === undefined || value === null || value === '') continue;
    if (field === 'create_time') {
      out['createdAt'] = videoTime(value);
      continue;
    }
    const name = field.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
    out[name] = typeof value === 'string' ? truncate(value, field === 'embed_html' ? 2000 : 1000) : value;
  }
  return compact(out);
}

const VIDEO_FIELDS_SCHEMA = {
  type: 'array' as const,
  uniqueItems: true,
  minItems: 1,
  maxItems: VIDEO_FIELDS.length,
  items: { type: 'string' as const, enum: [...VIDEO_FIELDS] },
  description: `The fields to read (default ${DEFAULT_VIDEO_FIELDS.join(', ')}).`,
};

/** Checks the chosen privacy level and interaction settings against the creator's current options. */
function checkPostSettings(creator: CreatorInfo, privacy: PrivacyLevel | undefined, brandContent: boolean | undefined): PrivacyLevel {
  if (!privacy) {
    throw new ToolFailure(
      `privacy_level is required for a direct post: choose one of ${creator.privacyLevelOptions.join(', ') || 'the options get_creator_info lists'}. Nothing was posted.`,
    );
  }
  if (creator.privacyLevelOptions.length && !creator.privacyLevelOptions.includes(privacy)) {
    throw new ToolFailure(`This creator cannot post with privacy_level ${privacy}: choose one of ${creator.privacyLevelOptions.join(', ')}. Nothing was posted.`);
  }
  if (brandContent && privacy === 'SELF_ONLY') {
    throw new ToolFailure('Branded content (brand_content_toggle) cannot be private: choose another privacy_level. Nothing was posted.');
  }
  return privacy;
}

/** The upload address TikTok returned, refused unless it is on one of TikTok's own upload hosts. */
function checkedUploadUrl(value: unknown): string {
  let target: URL;
  try {
    target = new URL(String(value));
  } catch {
    throw new ToolFailure('TikTok returned no valid upload address. Nothing was posted.');
  }
  const address = uploadAddress(value);
  if (!address) {
    throw new ToolFailure(`TikTok asked for the video to be uploaded to ${target.host}, an address this connector does not send files to. Nothing was posted.`);
  }
  return address;
}

/** A FILE_UPLOAD that is not finished yet: how far it got, and the cursor to go on with. */
function pending(
  outcome: { uploaded: number; stopped?: string; retryAfter?: number },
  state: UploadState,
  cursor: string,
  extra: Record<string, unknown>,
  notes: string[],
): Record<string, unknown> {
  // A call that stopped for a problem says so first: going on before it is dealt with would stop the same way.
  const first = outcome.stopped
    ? `Deal with what stopped says first${outcome.retryAfter !== undefined ? ` (wait ${outcome.retryAfter} seconds)` : ''}, then `
    : 'To go on, ';
  return compact({
    done: false,
    publishId: state.publishId,
    uploadedBytes: outcome.uploaded,
    totalBytes: state.total,
    stopped: outcome.stopped,
    retryAfter: outcome.retryAfter,
    uploadExpiresAt: new Date(state.startedAt + UPLOAD_LIFETIME_MS).toISOString(),
    nextCursor: cursor,
    next: `${first}${GO_ON}`,
    ...extra,
    note: notes.length ? notes.join(' ') : undefined,
  });
}

/**
 * Sends a FILE_UPLOAD's chunks from `run.offset` while the call has time,
 * then follows the post once every chunk is in, or returns the cursor to go
 * on with. Call it as the post's only sender (exclusive).
 */
async function sendVideo(
  h: ToolHelpers,
  run: Omit<TransferRun, 'cursor' | 'readStatus'>,
  waitSeconds: number,
  extra: Record<string, unknown>,
  notes: string[],
): Promise<Record<string, unknown>> {
  const { state } = run;
  const cursorAt = (offset: number): string => h.makeCursor(cursorState(state, offset));
  const outcome = await transfer(h, { ...run, cursor: cursorAt, readStatus: () => fetchStatus(h, state.publishId) });
  if (!outcome.done) return pending(outcome, state, cursorAt(outcome.uploaded), extra, notes);
  return finish(h, state.publishId, waitSeconds, run.started + STATUS_BUDGET_MS, { done: true, ...extra, bytes: state.total }, notes);
}

/**
 * Goes on with a FILE_UPLOAD a cursor holds: asks TikTok's status first (the
 * post may be done, or further along than the cursor says), then sends the
 * rest. The status read and the chunks after it go together (exclusive).
 */
async function goOn(h: ToolHelpers, args: VideoArgs, carried: Record<string, unknown>, started: number): Promise<Record<string, unknown>> {
  const parsed = stateFromCursor(carried);
  if (!parsed) throw new ToolFailure('The cursor holds no upload: pass nextCursor unchanged, or leave cursor out to start a new post. Nothing was changed.');
  if (args.source === 'PULL_FROM_URL') {
    throw new ToolFailure('A cursor goes on with a FILE_UPLOAD: leave source out, or set it to FILE_UPLOAD, when you pass cursor. Nothing was changed.');
  }
  const { state } = parsed;
  if (state.source !== (await sourceKey(args.video_url))) {
    throw new ToolFailure('The cursor belongs to a post of another video_url: give the video_url it started with, or leave cursor out to start a new post. Nothing was changed.');
  }
  // Going on: the caption and settings were sent when the post started.
  const extra = { mode: state.inbox ? 'MEDIA_UPLOAD' : 'DIRECT_POST', source: 'FILE_UPLOAD', account: h.credentials['tiktokusername'] };
  return exclusive(state.publishId, async () => {
    let status: PublishStatus;
    try {
      status = await fetchStatus(h, state.publishId);
    } catch (error) {
      if (error instanceof ToolFailure) throw new ToolFailure(`${error.message} Go on later with the same cursor.`, error.details);
      throw error;
    }
    if (DONE.has(status.status) || status.uploadedBytes === state.total) {
      // Every chunk is in (an earlier call's last answer may have been unclear), or TikTok ended the post: follow it.
      return finish(h, state.publishId, args.wait_seconds, started + STATUS_BUDGET_MS, { done: true, ...extra, bytes: state.total }, [], status);
    }
    // TikTok may be further along than the cursor (an unclear answer that got through, or an older cursor).
    const told = status.uploadedBytes;
    const plan = planFor(state.total, state.chunkSize);
    const offset = told !== undefined && told > parsed.offset && chunkAt(plan, told) !== -1 ? told : parsed.offset;
    return sendVideo(h, { state, videoUrl: args.video_url, offset, started }, args.wait_seconds, extra, []);
  });
}

interface VideoArgs {
  video_url: string;
  source: 'FILE_UPLOAD' | 'PULL_FROM_URL';
  post_mode: PostMode;
  caption?: string;
  privacy_level?: PrivacyLevel;
  disable_comment?: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  cover_timestamp_ms?: number;
  brand_content_toggle?: boolean;
  brand_organic_toggle?: boolean;
  is_aigc?: boolean;
  wait_seconds: number;
  cursor?: string;
}

interface PhotoArgs {
  image_urls: string[];
  post_mode: PostMode;
  title?: string;
  description?: string;
  privacy_level?: PrivacyLevel;
  cover_index: number;
  disable_comment?: boolean;
  auto_add_music?: boolean;
  brand_content_toggle?: boolean;
  brand_organic_toggle?: boolean;
  is_aigc?: boolean;
  wait_seconds: number;
}

const PRIVACY_SCHEMA = {
  type: 'string' as const,
  enum: [...PRIVACY_LEVELS],
  description:
    'Who sees the post, required for a direct post: one of the privacy_level_options get_creator_info returns '
    + '(an app TikTok has not audited may only use SELF_ONLY).',
};
const MODE_SCHEMA = {
  type: 'string' as const,
  enum: ['DIRECT_POST', 'MEDIA_UPLOAD'],
  default: 'DIRECT_POST',
  description:
    'DIRECT_POST (default) publishes it; MEDIA_UPLOAD sends it to the creator\'s TikTok inbox as a draft that the creator finishes and '
    + 'posts in the app, with their own caption and settings (needs the video.upload permission, which a connection may not have).',
};
const WAIT_SCHEMA = {
  type: 'integer' as const,
  minimum: 0,
  maximum: MAX_WAIT_SECONDS,
  default: 20,
  description:
    `Seconds to wait for TikTok to finish, checking every 5 seconds (default 20, at most ${MAX_WAIT_SECONDS}, 0 to return at once); `
    + 'the wait also ends 35 seconds into the call. TikTok often takes a minute or more: if it is still processing, follow it with '
    + 'get_post_status and the publish_id. The post goes on either way.',
};

const connector = defineConnector({
  vendor: 'tiktok',
  label: 'TikTok',
  origins: ['https://open.tiktokapis.com', ...UPLOAD_ORIGINS],
  credentials: ['access_token', 'tiktokusername', 'openid'],
  requiredCredentials: [['access_token']],
  credentialLabels: {
    access_token: 'TikTok access token',
    tiktokusername: 'TikTok account name',
    openid: 'TikTok open ID',
  },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'get_creator_info',
      kind: 'read',
      title: 'Get the TikTok creator\'s posting options',
      description:
        'Returns what the connected creator can post right now: their name, the privacy levels they may choose, whether comments, '
        + 'duets and stitches are turned off on their account, and the longest video they may post. TikTok asks for this before every post; '
        + 'post_video and post_photos check it themselves.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const creator = await creatorInfo(h);
        return compact({ ...creator, account: creator.username ?? h.credentials['tiktokusername'] });
      },
    },
    {
      name: 'get_profile',
      kind: 'read',
      title: 'Get the TikTok profile',
      description:
        'Returns the connected TikTok account: open id, union id, display name and avatar. Profile and stats fields (bio, follower and '
        + 'video counts) need the user.info.profile and user.info.stats permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            uniqueItems: true,
            maxItems: 14,
            items: {
              type: 'string',
              enum: ['open_id', 'union_id', 'avatar_url', 'display_name', 'username', 'bio_description', 'profile_deep_link', 'is_verified', 'follower_count', 'following_count', 'likes_count', 'video_count', 'avatar_url_100', 'avatar_large_url'],
            },
            description: 'The fields to read (default open_id, union_id, avatar_url, display_name).',
          },
        },
        additionalProperties: false,
      },
      async run(args: { fields?: string[] }, h) {
        const fields = args.fields?.length ? args.fields : ['open_id', 'union_id', 'avatar_url', 'display_name'];
        const data = await tiktok(h, { path: '/v2/user/info/', query: { fields: fields.join(',') } });
        const user: Record<string, unknown> = data?.user && typeof data.user === 'object' ? data.user : {};
        const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
        const profile: Record<string, unknown> = {};
        for (const field of fields) if (user[field] !== undefined && user[field] !== null && user[field] !== '') profile[camel(field)] = user[field];
        if (profile['openId'] === undefined && h.credentials['openid']) profile['openId'] = h.credentials['openid'];
        if (profile['displayName'] === undefined && h.credentials['tiktokusername']) profile['displayName'] = h.credentials['tiktokusername'];
        return profile;
      },
    },
    {
      name: 'post_video',
      kind: 'create',
      check: 'get_post_status',
      title: 'Post a video to TikTok',
      description:
        'Posts one video (MP4, MOV or WebM, up to 4 GB) to the connected TikTok account from a public https URL. FILE_UPLOAD (default) '
        + 'sends it to TikTok in 10 MB chunks, each read from the URL by byte range just before it goes, for about 35 seconds a call: '
        + 'while done is false, call again with the same video_url and cursor set to nextCursor, until done is true, within an hour of '
        + 'the first call. A host that does not pass byte ranges on gets the whole file, which must then fit its download limit. '
        + 'PULL_FROM_URL lets TikTok download it itself, only from a domain or URL prefix verified in the TikTok app\'s URL properties. '
        + 'Checks the creator\'s posting options first, then waits a little for TikTok to finish and returns the publish_id to follow with '
        + 'get_post_status. Caption up to 2,200 characters with #hashtags and @mentions (links are not clickable). One video per post: '
        + 'join clips beforehand.',
      inputSchema: {
        type: 'object',
        properties: {
          video_url: { ...HTTPS_URL, description: 'A public https URL of the video (MP4 recommended, H.264, 23 to 60 FPS).' },
          source: {
            type: 'string',
            enum: ['FILE_UPLOAD', 'PULL_FROM_URL'],
            default: 'FILE_UPLOAD',
            description: 'FILE_UPLOAD (default; sent in chunks, across calls with cursor when one call is not enough) or PULL_FROM_URL (only from a domain or URL prefix verified for the TikTok app).',
          },
          post_mode: MODE_SCHEMA,
          caption: { type: 'string', maxLength: 2200, description: 'The caption, up to 2,200 characters, with hashtags and mentions (DIRECT_POST only).' },
          privacy_level: PRIVACY_SCHEMA,
          disable_comment: { type: 'boolean', description: 'true turns comments off for this video.' },
          disable_duet: { type: 'boolean', description: 'true turns duets off for this video.' },
          disable_stitch: { type: 'boolean', description: 'true turns stitches off for this video.' },
          cover_timestamp_ms: { type: 'integer', minimum: 0, description: 'The frame used as the cover, in milliseconds from the start (default the first frame).' },
          brand_content_toggle: { type: 'boolean', description: 'true when the video is a paid partnership promoting a third-party business.' },
          brand_organic_toggle: { type: 'boolean', description: 'true when the video promotes the creator\'s own business.' },
          is_aigc: { type: 'boolean', description: 'true labels the video as AI-generated.' },
          wait_seconds: WAIT_SCHEMA,
          cursor: {
            type: 'string',
            maxLength: 4096,
            description:
              'nextCursor from the previous result, while done is false: goes on with that FILE_UPLOAD where TikTok stopped. Give the same '
              + 'video_url with it (the caption and settings were sent when the post started and are not sent again). Leave out to start a post.',
          },
        },
        required: ['video_url'],
        additionalProperties: false,
      },
      async run(args: VideoArgs, h) {
        const started = Date.now();
        const deadline = started + STATUS_BUDGET_MS;
        const carried = h.cursor(args.cursor);
        if (carried) return goOn(h, args, carried, started);
        const direct = args.post_mode === 'DIRECT_POST';
        if (!direct) refuseInboxSettings(args, DIRECT_ONLY_VIDEO, 'the caption and every post setting');
        let creator: CreatorInfo | undefined;
        let privacy: PrivacyLevel | undefined;
        const turnedOff: string[] = [];
        if (direct) {
          creator = await creatorInfo(h);
          privacy = checkPostSettings(creator, args.privacy_level, args.brand_content_toggle);
          if (creator.commentDisabled && args.disable_comment === false) turnedOff.push('comments');
          if (creator.duetDisabled && args.disable_duet === false) turnedOff.push('duets');
          if (creator.stitchDisabled && args.disable_stitch === false) turnedOff.push('stitches');
        }

        const notes = turnedOff.length ? [`The creator has ${turnedOff.join(', ')} turned off for every post, so they stay off.`] : [];
        const extra = { mode: args.post_mode, source: args.source, account: creator?.username ?? h.credentials['tiktokusername'], privacyLevel: privacy };
        const postInfo = direct
          ? compact({
            title: args.caption,
            privacy_level: privacy,
            disable_comment: creator?.commentDisabled ? true : args.disable_comment,
            disable_duet: creator?.duetDisabled ? true : args.disable_duet,
            disable_stitch: creator?.stitchDisabled ? true : args.disable_stitch,
            video_cover_timestamp_ms: args.cover_timestamp_ms,
            brand_content_toggle: args.brand_content_toggle,
            brand_organic_toggle: args.brand_organic_toggle,
            is_aigc: args.is_aigc,
          })
          : undefined;
        const init = (sourceInfo: Record<string, unknown>, refused: string, write: boolean): Promise<any> => tiktok(h, {
          method: 'POST',
          path: direct ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/',
          ...jsonBody(postInfo ? { post_info: postInfo, source_info: sourceInfo } : { source_info: sourceInfo }),
          write,
          errors: direct ? { 403: refused } : { 401: INBOX_REFUSED, 403: refused },
        });

        if (args.source === 'PULL_FROM_URL') {
          let data: any;
          try {
            // PULL_FROM_URL starts the post right here.
            data = await init({ source: 'PULL_FROM_URL', video_url: args.video_url }, PULL_REFUSED, true);
          } catch (error) {
            if (error instanceof OutcomeUnknown) throw withoutPublishId(error, !direct);
            throw error;
          }
          const publishId = typeof data?.publish_id === 'string' ? data.publish_id : undefined;
          if (!publishId) throw new ToolFailure('TikTok accepted the request but sent back no publish_id. Check the TikTok app before posting again.');
          return finish(h, publishId, args.wait_seconds, deadline, { done: true, ...extra }, notes);
        }

        // FILE_UPLOAD: the first read tells the size (from its Content-Range) and the type, before the post is started.
        const readStarted = Date.now();
        let first: SourcePart;
        try {
          first = await readPart(h, args.video_url, 0, CHUNK_BYTES - 1);
        } catch (error) {
          if (error instanceof SourceProblem) throw new ToolFailure(`${error.message} Nothing was posted.`);
          throw error;
        }
        const type = sniffVideo(first.bytes);
        if (!type) throw new ToolFailure('The video URL did not return an MP4, MOV or WebM video. Nothing was posted.');
        if (first.total > MAX_VIDEO_BYTES) {
          throw new ToolFailure(`The video is ${formatNumber(first.total)} bytes; TikTok takes files up to 4 GB (${formatNumber(MAX_VIDEO_BYTES)} bytes). Nothing was posted.`);
        }
        const plan = chunkPlan(first.total);
        // A FILE_UPLOAD posts only after its last chunk: starting it makes nothing yet.
        const data = await init({ source: 'FILE_UPLOAD', video_size: first.total, chunk_size: plan.chunkSize, total_chunk_count: plan.count }, POST_REFUSED, false);
        const publishId = typeof data?.publish_id === 'string' && PUBLISH_PATTERN.test(data.publish_id) ? data.publish_id : undefined;
        if (!publishId) throw new ToolFailure('TikTok sent back no usable publish_id. Nothing was posted.');
        const state: UploadState = {
          uploadUrl: checkedUploadUrl(data?.upload_url),
          publishId,
          total: first.total,
          chunkSize: plan.chunkSize,
          type,
          source: await sourceKey(args.video_url),
          ...(first.etag ? { etag: first.etag } : {}),
          inbox: !direct,
          startedAt: Date.now(),
        };
        return exclusive(publishId, () => sendVideo(h, { state, videoUrl: args.video_url, offset: 0, started, held: first, heldSince: readStarted }, args.wait_seconds, extra, notes));
      },
    },
    {
      name: 'post_photos',
      kind: 'create',
      check: 'get_post_status',
      title: 'Post photos to TikTok',
      description:
        'Posts a photo post (a carousel of 1 to 35 photos) to the connected TikTok account. TikTok has no upload for photos: it downloads '
        + 'them itself, only from a domain or URL prefix verified in the TikTok app\'s URL properties, and refuses photo URLs on any other '
        + 'host. Use photo URLs on such a host, such as the creator\'s own website; without one, make a video of the photos and post it with '
        + 'post_video, whose FILE_UPLOAD needs no verification. JPEG or WebP, up to 1080p and 20 MB each. Title up to 90 characters, '
        + 'description up to 4,000 with #hashtags (links are not clickable). Checks the creator\'s posting options first, then waits a little '
        + 'for TikTok to finish and returns the publish_id to follow with get_post_status.',
      inputSchema: {
        type: 'object',
        properties: {
          image_urls: {
            type: 'array',
            minItems: 1,
            maxItems: 35,
            items: HTTPS_URL,
            description: 'Public https URLs of the photos, in order, on a domain or URL prefix verified for the TikTok app.',
          },
          post_mode: MODE_SCHEMA,
          title: { type: 'string', maxLength: 90, description: 'A short title, up to 90 characters.' },
          description: { type: 'string', maxLength: 4000, description: 'The post text, up to 4,000 characters, with hashtags.' },
          privacy_level: PRIVACY_SCHEMA,
          cover_index: { type: 'integer', minimum: 0, maximum: 34, default: 0, description: 'The photo used as the cover, counted from 0 (default the first).' },
          disable_comment: { type: 'boolean', description: 'true turns comments off for this post (DIRECT_POST only).' },
          auto_add_music: { type: 'boolean', description: 'Let TikTok add music (DIRECT_POST only; default true).' },
          brand_content_toggle: { type: 'boolean', description: 'true when the post is a paid partnership promoting a third-party business (DIRECT_POST only).' },
          brand_organic_toggle: { type: 'boolean', description: 'true when the post promotes the creator\'s own business (DIRECT_POST only).' },
          is_aigc: { type: 'boolean', description: 'true labels the post as AI-generated.' },
          wait_seconds: WAIT_SCHEMA,
        },
        required: ['image_urls'],
        additionalProperties: false,
      },
      async run(args: PhotoArgs, h) {
        if (args.cover_index >= args.image_urls.length) {
          throw new ToolFailure(`cover_index ${args.cover_index} points past the last photo (there are ${args.image_urls.length}). Nothing was posted.`);
        }
        const deadline = Date.now() + STATUS_BUDGET_MS;
        const direct = args.post_mode === 'DIRECT_POST';
        if (!direct) refuseInboxSettings(args, DIRECT_ONLY_PHOTO, 'privacy, comments, music and the branded-content labels');
        let creator: CreatorInfo | undefined;
        let privacy: PrivacyLevel | undefined;
        if (direct) {
          creator = await creatorInfo(h);
          privacy = checkPostSettings(creator, args.privacy_level, args.brand_content_toggle);
        }
        let data: any;
        try {
          data = await tiktok(h, {
            method: 'POST',
            path: '/v2/post/publish/content/init/',
            ...jsonBody(compact({
              media_type: 'PHOTO',
              post_mode: args.post_mode,
              post_info: compact({
                title: args.title,
                description: args.description,
                privacy_level: privacy,
                disable_comment: direct ? (creator?.commentDisabled ? true : args.disable_comment) : undefined,
                auto_add_music: direct ? (args.auto_add_music ?? true) : undefined,
                brand_content_toggle: direct ? args.brand_content_toggle : undefined,
                brand_organic_toggle: direct ? args.brand_organic_toggle : undefined,
              }),
              source_info: { source: 'PULL_FROM_URL', photo_cover_index: args.cover_index, photo_images: args.image_urls },
              is_aigc: args.is_aigc,
            })),
            write: true,
            errors: direct ? { 403: PHOTO_REFUSED } : { 401: INBOX_REFUSED, 403: PHOTO_REFUSED },
          });
        } catch (error) {
          if (error instanceof OutcomeUnknown) throw withoutPublishId(error, !direct);
          throw error;
        }
        const publishId = typeof data?.publish_id === 'string' ? data.publish_id : undefined;
        if (!publishId) throw new ToolFailure('TikTok accepted the request but sent back no publish_id. Check the TikTok app before posting again.');
        return finish(h, publishId, args.wait_seconds, deadline, {
          mode: args.post_mode,
          photos: args.image_urls.length,
          account: creator?.username ?? h.credentials['tiktokusername'],
          privacyLevel: privacy,
        });
      },
    },
    {
      name: 'get_post_status',
      kind: 'read',
      title: 'Get a TikTok post\'s status',
      description:
        'Returns where a TikTok post stands by its publish_id: PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, '
        + 'PUBLISH_COMPLETE or FAILED (with the reason), and the public post ids once it is public and moderated. With wait_seconds it '
        + `checks every 5 seconds until TikTok is done or the time is up (at most ${MAX_WAIT_SECONDS} seconds).`,
      inputSchema: {
        type: 'object',
        properties: {
          publish_id: { type: 'string', pattern: PUBLISH_ID, description: 'The publish_id post_video or post_photos returned.' },
          wait_seconds: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_WAIT_SECONDS,
            default: 0,
            description: `Seconds to wait for TikTok to finish, checking every 5 seconds (default 0: one read; at most ${MAX_WAIT_SECONDS}).`,
          },
        },
        required: ['publish_id'],
        additionalProperties: false,
      },
      async run(args: { publish_id: string; wait_seconds: number }, h) {
        const { status, stopped } = await follow(h, args.publish_id, args.wait_seconds, Date.now() + STATUS_BUDGET_MS);
        const notes: string[] = [];
        if (status.postIdsInexact) notes.push('TikTok\'s post id is too long to pass on exactly; the post is on the creator\'s profile.');
        if (stopped === 'cancelled') notes.push('Stopped waiting because the call was cancelled.');
        if (!DONE.has(status.status) && status.status !== 'UNKNOWN') notes.push('TikTok is still processing it: check again in a little while; do not post it again.');
        return compact({
          publishId: args.publish_id,
          ...status,
          note: notes.length ? notes.join(' ') : undefined,
          failReasonText: status.status === 'FAILED' ? explainFailure(status.failReason) : undefined,
          published: status.status === 'PUBLISH_COMPLETE',
        });
      },
    },
    {
      name: 'list_videos',
      kind: 'read',
      title: 'List the TikTok creator\'s videos',
      description:
        'Lists the connected creator\'s public TikTok videos, newest first: id, title, description, time, link, length, and view, like, '
        + 'comment and share counts (choose others with fields). Private posts are not listed. Needs the video.list permission. Pass '
        + 'nextCursor back as cursor for older ones.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: VIDEO_FIELDS_SCHEMA,
          max_count: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Videos per page, 1 to 20 (default 10).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { fields?: string[]; max_count: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const before = typeof state?.['c'] === 'number' ? state['c'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const max = typeof state?.['n'] === 'number' ? state['n'] : args.max_count;
        const fields = typeof state?.['f'] === 'string' ? state['f'].split(',') : [...new Set(['id', ...(args.fields?.length ? args.fields : DEFAULT_VIDEO_FIELDS)])];
        const data = await tiktok(h, {
          method: 'POST',
          path: '/v2/video/list/',
          query: { fields: fields.join(',') },
          ...jsonBody(compact({ max_count: max, cursor: before })),
          safe: true,
          errors: { 401: VIDEO_LIST_REFUSED },
        });
        const videos: unknown[] = Array.isArray(data?.videos) ? data.videos : [];
        const cursor = typeof data?.cursor === 'number' ? data.cursor : typeof data?.cursor === 'string' && /^[0-9]{1,15}$/.test(data.cursor) ? Number(data.cursor) : undefined;
        const next = data?.has_more === true && cursor !== undefined && cursor !== before ? cursor : undefined;
        const f = fields.join(',');
        return h.page({
          key: 'videos',
          items: videos.map((video) => trimVideo(video, fields)).slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(before !== undefined ? { c: before } : {}), o: skip + index, n: max, f }),
          ...(next !== undefined ? { nextPage: h.makeCursor({ c: next, o: 0, n: max, f }) } : {}),
        });
      },
    },
    {
      name: 'get_videos',
      kind: 'read',
      title: 'Get TikTok videos by id',
      description:
        'Returns up to 20 of the connected creator\'s videos by their ids, such as the post ids get_post_status returns: title, '
        + 'description, time, link, length, and view, like, comment and share counts (choose others with fields). Ids that are not the '
        + 'creator\'s come back as missing. Needs the video.list permission.',
      inputSchema: {
        type: 'object',
        properties: {
          video_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[0-9]{1,30}$' }, description: 'The video ids.' },
          fields: VIDEO_FIELDS_SCHEMA,
        },
        required: ['video_ids'],
        additionalProperties: false,
      },
      async run(args: { video_ids: string[]; fields?: string[] }, h) {
        const fields = [...new Set(['id', ...(args.fields?.length ? args.fields : DEFAULT_VIDEO_FIELDS)])];
        const data = await tiktok(h, {
          method: 'POST',
          path: '/v2/video/query/',
          query: { fields: fields.join(',') },
          ...jsonBody({ filters: { video_ids: args.video_ids } }),
          safe: true,
          errors: { 401: VIDEO_LIST_REFUSED },
        });
        const videos: any[] = Array.isArray(data?.videos) ? data.videos : [];
        const found = new Set(videos.map((video) => String(video?.id)));
        const missing = args.video_ids.filter((id) => !found.has(id));
        return compact({ videos: videos.map((video) => trimVideo(video, fields)), missing: missing.length ? missing : undefined });
      },
    },
    ...apiTools({
      label: 'TikTok',
      description:
        'The TikTok API v2 at https://open.tiktokapis.com/v2/, with the connection\'s token: paths start with /v2/, such as /v2/user/info/ '
        + '(GET, with fields in query). api_request sends POST requests, which TikTok uses for its writes; the reads TikTok takes by POST '
        + 'have their own tools (get_creator_info, get_post_status, list_videos, get_videos). Reference: https://developers.tiktok.com/doc/overview.',
      basePath: '/v2/',
      methods: ['POST'],
    }),
  ],
});

export = connector;
