// YouTube, through the YouTube Data API v3 (https://developers.google.com/youtube/v3/docs)
// and the YouTube Analytics API v2 (https://developers.google.com/youtube/analytics).
//
// Credential: `access_token`, an OAuth 2.0 access token of the Google account
// (or Brand Account) of the channel, with the scopes
// https://www.googleapis.com/auth/youtube and
// https://www.googleapis.com/auth/yt-analytics.readonly. Comments and
// captions need https://www.googleapis.com/auth/youtube.force-ssl, and
// revenue metrics yt-analytics-monetary.readonly, which these are not. The
// host refreshes the token; the module sends it to
// https://www.googleapis.com/youtube/v3/,
// https://www.googleapis.com/upload/youtube/v3/ and
// https://youtubeanalytics.googleapis.com/v2/ only.
//
// Account picker `channels` (list_channels). The sign-in acts as one channel
// and sees its private videos and playlists: with a channel choice in place,
// anything that could reach them, and every write, needs that channel chosen.
// Uploads take the video from a public https URL and send it through
// YouTube's resumable upload in parts, each read by byte range just before it
// is sent, across calls when one call cannot send them all (upload.ts).

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  formatNumber,
  requireAccounts,
  ToolFailure,
  truncate,
  utf8Length,
  type ApiToolRequest,
  type FailureDetails,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { ownChannel, requireOwnChannel, resolveChannel } from './channel.js';
import { compact, count, cursorNumber, googleApi, utcTime } from './google.js';
import { durationSeconds, sniffImage, sniffVideo } from './media.js';
import {
  askSession,
  cursorState,
  DEFAULT_PART_MB,
  exclusive,
  GONE,
  MAX_PART_MB,
  MAX_VIDEO_BYTES,
  readPart,
  SourceProblem,
  sourceKey,
  stateFromCursor,
  transfer,
  uploadAddress,
  type SourcePart,
  type UploadOutcome,
  type UploadState,
} from './upload.js';

type Schema = ToolDefinition['inputSchema'];

const API = 'https://www.googleapis.com';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com';
const MIB = 1024 * 1024;
/** The highest offset or index a list cursor may carry. */
const MAX_OFFSET = 100_000;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const VIDEO_PARTS = 'snippet,statistics,contentDetails,status';
const UPLOAD_NOTE =
  'YouTube processes the video for a few minutes. A vertical or square video of 3 minutes or less becomes a Short '
  + '(https://youtube.com/shorts/VIDEO_ID). If get_videos later shows it private although public or unlisted was asked, YouTube '
  + 'locked it: videos uploaded through a Google Cloud project that has not passed the YouTube API audit stay private '
  + '(audit form: https://support.google.com/youtube/contact/yt_api_form). Do not upload it again.';

const CHANNEL_ID: Schema = {
  type: 'string',
  pattern: '^UC[A-Za-z0-9_-]{22}$',
  description: 'The channel id (UC...), from list_channels. Leave out for the chosen channel, or the connected one.',
};
const VIDEO_ID: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$', description: 'The video id, from list_videos.' };
const PLAYLIST_ID: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{2,64}$', description: 'The playlist id, from list_playlists.' };
const CURSOR: Schema = { type: 'string', description: 'nextCursor from the previous result (send the same filters with it).' };
const PAGE_SIZE: Schema = { type: 'integer', minimum: 1, maximum: 50, default: 25, description: 'Items per page, 1 to 50 (default 25).' };
const DATE: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$';
const LANGUAGE: Schema = { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' };
const PRIVACY = ['public', 'unlisted', 'private'];

const METADATA_FIELDS: Record<string, Schema> = {
  title: { type: 'string', minLength: 1, maxLength: 100, description: 'The title: up to 100 characters, no < or >.' },
  description: { type: 'string', maxLength: 5000, description: 'The description: up to 5,000 bytes, no < or >.' },
  tags: {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 100 },
    maxItems: 100,
    description: 'Tags; all of them together at most 500 characters (a tag with a space counts its quotes).',
  },
  category_id: {
    type: 'string',
    pattern: '^[0-9]{1,3}$',
    description: 'The category: 1 Film and Animation, 10 Music, 17 Sports, 20 Gaming, 22 People and Blogs, 24 Entertainment, 27 Education, 28 Science and Technology.',
  },
  default_language: { ...LANGUAGE, description: 'The language of the title and description, such as "en" or "tr".' },
  default_audio_language: { ...LANGUAGE, description: 'The spoken language of the video.' },
};
const STATUS_FIELDS: Record<string, Schema> = {
  privacy_status: { type: 'string', enum: PRIVACY, description: 'public (anyone; "publish" means this), unlisted (anyone with the link) or private.' },
  publish_at: { type: 'string', pattern: TIME, description: 'A scheduled release, as a future RFC 3339 time such as 2026-12-01T07:00:00Z: needs privacy_status private, and YouTube makes the video public then.' },
  made_for_kids: { type: 'boolean', description: "Whether the video is made for kids (YouTube's audience setting)." },
  contains_synthetic_media: { type: 'boolean', description: 'true when the video shows AI-generated realistic people or scenes: YouTube labels it as altered or synthetic content.' },
  embeddable: { type: 'boolean', description: 'Whether other sites may embed the video.' },
  public_stats_viewable: { type: 'boolean', description: 'Whether the like count and other statistics are public.' },
  license: { type: 'string', enum: ['youtube', 'creativeCommon'], description: 'The license: youtube (standard) or creativeCommon.' },
};

interface MetadataArgs {
  title?: string;
  description?: string;
  tags?: string[];
  category_id?: string;
  default_language?: string;
  default_audio_language?: string;
  privacy_status?: string;
  publish_at?: string;
  made_for_kids?: boolean;
  contains_synthetic_media?: boolean;
  embeddable?: boolean;
  public_stats_viewable?: boolean;
  license?: string;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

function thumbnailOf(snippet: any): string | undefined {
  const thumbnails = snippet?.thumbnails ?? {};
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    if (typeof thumbnails[size]?.url === 'string') return thumbnails[size].url;
  }
  return undefined;
}

function trimVideoSummary(video: any): Record<string, unknown> {
  const snippet = video?.snippet ?? {};
  const status = video?.status ?? {};
  const stats = video?.statistics ?? {};
  const details = video?.contentDetails ?? {};
  return compact({
    id: video?.id,
    title: text(snippet.title, 200),
    published_at: snippet.publishedAt,
    privacy_status: status.privacyStatus,
    publish_at: status.publishAt,
    upload_status: status.uploadStatus && status.uploadStatus !== 'processed' ? status.uploadStatus : undefined,
    duration: details.duration,
    duration_seconds: durationSeconds(details.duration),
    views: count(stats.viewCount),
    likes: count(stats.likeCount),
    comments: count(stats.commentCount),
    made_for_kids: status.madeForKids,
    url: typeof video?.id === 'string' ? `https://youtu.be/${video.id}` : undefined,
  });
}

function trimVideo(video: any): Record<string, unknown> {
  const snippet = video?.snippet ?? {};
  const status = video?.status ?? {};
  const details = video?.contentDetails ?? {};
  return compact({
    ...trimVideoSummary(video),
    description: text(snippet.description, 5000),
    tags: Array.isArray(snippet.tags) ? snippet.tags.map((tag: unknown) => String(tag)) : undefined,
    category_id: snippet.categoryId,
    default_language: snippet.defaultLanguage,
    default_audio_language: snippet.defaultAudioLanguage,
    channel_id: snippet.channelId,
    channel_title: text(snippet.channelTitle, 200),
    upload_status: status.uploadStatus,
    failure_reason: status.failureReason,
    rejection_reason: status.rejectionReason,
    license: status.license,
    embeddable: status.embeddable,
    public_stats_viewable: status.publicStatsViewable,
    self_declared_made_for_kids: status.selfDeclaredMadeForKids,
    contains_synthetic_media: status.containsSyntheticMedia,
    definition: details.definition,
    caption: details.caption === 'true' ? true : details.caption === 'false' ? false : undefined,
    thumbnail: thumbnailOf(snippet),
    studio_url: typeof video?.id === 'string' ? `https://studio.youtube.com/video/${video.id}/edit` : undefined,
  });
}

function trimChannel(channel: any, full: boolean): Record<string, unknown> {
  const snippet = channel?.snippet ?? {};
  const stats = channel?.statistics ?? {};
  return compact({
    id: channel?.id,
    title: text(snippet.title, 200),
    handle: snippet.customUrl,
    subscribers: stats.hiddenSubscriberCount ? undefined : count(stats.subscriberCount),
    views: count(stats.viewCount),
    videos: count(stats.videoCount),
    uploads_playlist_id: channel?.contentDetails?.relatedPlaylists?.uploads,
    url: typeof channel?.id === 'string' ? `https://www.youtube.com/channel/${channel.id}` : undefined,
    ...(full
      ? {
        description: text(snippet.description, 2000),
        published_at: snippet.publishedAt,
        country: snippet.country,
        default_language: snippet.defaultLanguage,
        keywords: text(channel?.brandingSettings?.channel?.keywords, 500),
        privacy_status: channel?.status?.privacyStatus,
        made_for_kids: channel?.status?.madeForKids,
        long_uploads: channel?.status?.longUploadsStatus,
        thumbnail: thumbnailOf(snippet),
      }
      : {}),
  });
}

function trimPlaylist(playlist: any): Record<string, unknown> {
  return compact({
    id: playlist?.id,
    title: text(playlist?.snippet?.title, 200),
    description: text(playlist?.snippet?.description, 300),
    privacy_status: playlist?.status?.privacyStatus,
    item_count: playlist?.contentDetails?.itemCount,
    published_at: playlist?.snippet?.publishedAt,
    url: typeof playlist?.id === 'string' ? `https://www.youtube.com/playlist?list=${playlist.id}` : undefined,
  });
}

/** Refuses what YouTube would refuse in a title, description or tag list, before anything is sent. */
function checkMetadata(args: MetadataArgs): void {
  for (const [name, value] of [['title', args.title], ['description', args.description]] as const) {
    if (value !== undefined && /[<>]/.test(value)) throw new ToolFailure(`The ${name} may not contain < or >: YouTube refuses them. Nothing was changed.`);
  }
  if (args.description !== undefined && utf8Length(args.description) > 5000) {
    throw new ToolFailure(`The description is ${formatNumber(utf8Length(args.description))} bytes; YouTube allows 5,000. Nothing was changed.`);
  }
  if (args.tags) {
    if (args.tags.some((tag) => /[<>]/.test(tag))) throw new ToolFailure('A tag may not contain < or >. Nothing was changed.');
    const total = args.tags.reduce((sum, tag) => sum + Array.from(tag).length + (/\s/.test(tag) ? 2 : 0), 0) + Math.max(0, args.tags.length - 1);
    if (total > 500) throw new ToolFailure(`The tags come to ${total} characters; YouTube allows 500 in all (a tag with a space counts its quotes). Nothing was changed.`);
  }
}

/** A future publish time in UTC, or a refusal. */
function futureTime(value: string): string {
  const time = utcTime(value, 'publish_at');
  if (Date.parse(time) <= Date.now()) throw new ToolFailure('publish_at must be in the future. Nothing was changed.');
  return time;
}

async function readVideo(h: ToolHelpers, videoId: string, parts: string): Promise<any> {
  const { data } = await googleApi(h, { path: '/youtube/v3/videos', query: { part: parts, id: videoId } });
  const video = Array.isArray(data?.items) ? data.items[0] : undefined;
  if (!video) throw new ToolFailure(`YouTube found no video ${videoId} that this account can see.`);
  return video;
}

/** Video details for up to 50 ids, by id. */
async function videoDetails(h: ToolHelpers, ids: string[]): Promise<Map<string, any>> {
  const byId = new Map<string, any>();
  if (!ids.length) return byId;
  const { data } = await googleApi(h, { path: '/youtube/v3/videos', query: { part: VIDEO_PARTS, id: ids.join(',') } });
  for (const video of Array.isArray(data?.items) ? data.items : []) if (typeof video?.id === 'string') byId.set(video.id, video);
  return byId;
}

/**
 * One page of a channel's uploads, as video resources in upload order. A
 * cursor's uploads list is used only when it is the channel's own (UU and the
 * id after UC); otherwise it is read again, and the cursor's page only counts
 * when the list read is the cursor's.
 */
async function uploadsPage(h: ToolHelpers, state: Record<string, unknown> | null, channelId: string, size: number) {
  const carried = typeof state?.['u'] === 'string' ? state['u'] : undefined;
  let uploads = carried === `UU${channelId.slice(2)}` ? carried : undefined;
  if (!uploads) {
    const { data } = await googleApi(h, { path: '/youtube/v3/channels', query: { part: 'contentDetails', id: channelId } });
    uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (typeof uploads !== 'string' || !uploads) throw new ToolFailure(`YouTube found no channel ${channelId} or no uploads list for it.`);
  }
  const pageToken = carried === uploads && typeof state?.['p'] === 'string' ? state['p'] : undefined;
  const { data } = await googleApi(h, {
    path: '/youtube/v3/playlistItems',
    query: { part: 'contentDetails', playlistId: uploads, maxResults: size, pageToken },
    errors: { 404: 'YouTube found no uploads list for this channel' },
  });
  const ids: string[] = (Array.isArray(data?.items) ? data.items : [])
    .map((item: any) => item?.contentDetails?.videoId)
    .filter((id: unknown): id is string => typeof id === 'string');
  const details = await videoDetails(h, ids);
  return {
    uploads,
    pageToken,
    videos: ids.map((id) => details.get(id)).filter((video) => video !== undefined),
    nextToken: typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined,
  };
}

const GO_ON =
  'call upload_video again with the same arguments and cursor set to nextCursor, until done is true. Each call asks YouTube how far '
  + 'it got and sends only the rest: no byte goes twice and no second video is made. Go on soon: YouTube drops an upload that is not '
  + 'finished in time.';

/** An upload's result: the video once YouTube made it, else how far it got and the cursor to go on with. */
function uploadResult(outcome: UploadOutcome, state: UploadState, cursor: string): Record<string, unknown> {
  if (!outcome.done) {
    // A call that stopped for a problem says so first: going on before it is dealt with would stop the same way.
    const first = outcome.stopped
      ? `Deal with what stopped says first${outcome.retryAfter !== undefined ? ` (wait ${outcome.retryAfter} seconds)` : ''}, then `
      : 'To go on, ';
    return compact({
      done: false,
      bytes_uploaded: outcome.uploaded,
      bytes_total: state.total,
      stopped: outcome.stopped,
      retryAfter: outcome.retryAfter,
      nextCursor: cursor,
      next: `${first}${GO_ON}`,
    });
  }
  const video = trimVideo(outcome.video);
  return compact({
    done: true,
    id: video['id'],
    url: video['url'],
    studio_url: video['studio_url'],
    title: video['title'],
    channel_id: video['channel_id'],
    privacy_status: video['privacy_status'],
    publish_at: video['publish_at'],
    upload_status: video['upload_status'],
    bytes: state.total,
    content_type: state.type,
    note: UPLOAD_NOTE,
  });
}

/**
 * Goes on with an upload a cursor holds: asks YouTube how far it got (or for
 * the video), then sends the rest. Call it as the upload's only sender
 * (exclusive): the question and the parts that follow it go together.
 */
async function goOn(h: ToolHelpers, state: UploadState, videoUrl: string, started: number): Promise<Record<string, unknown>> {
  const cursor = h.makeCursor(cursorState(state));
  const status = await askSession(h, state);
  if (status.kind === 'done') return uploadResult({ done: true, video: status.video }, state, cursor);
  if (status.kind === 'refused') {
    const details: FailureDetails = {
      ...(status.status !== undefined ? { status: status.status } : {}),
      ...(status.retryAfter !== undefined ? { retryAfter: status.retryAfter } : {}),
    };
    throw new ToolFailure(status.gone ? GONE : `${status.message} Nothing was sent: go on later with the same cursor.`, details);
  }
  if (status.kind === 'unclear' || status.received >= state.total) {
    const why = status.kind === 'unclear' ? status.reason : 'every byte in, but no video';
    throw new ToolFailure(`YouTube could not say how far the upload got (${why}). Nothing was sent: go on later with the same cursor.`);
  }
  return uploadResult(await transfer(h, { state, videoUrl, offset: status.received, started, cursor }), state, cursor);
}

const REPORTS: Record<string, { metrics: string[]; dimensions: string[]; sort?: string; maxResults?: number; needsVideo?: boolean }> = {
  top_videos: { metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage'], dimensions: ['video'], sort: '-views', maxResults: 25 },
  daily: { metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'], dimensions: ['day'], sort: 'day' },
  retention: { metrics: ['audienceWatchRatio', 'relativeRetentionPerformance'], dimensions: ['elapsedVideoTimeRatio'], needsVideo: true },
  traffic_sources: { metrics: ['views', 'estimatedMinutesWatched'], dimensions: ['insightTrafficSourceType'], sort: '-views' },
  countries: { metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration'], dimensions: ['country'], sort: '-views', maxResults: 25 },
  devices: { metrics: ['views', 'estimatedMinutesWatched'], dimensions: ['deviceType'], sort: '-views' },
  demographics: { metrics: ['viewerPercentage'], dimensions: ['ageGroup', 'gender'], sort: 'gender,ageGroup' },
};

const AD_FORMATS: Record<string, { min?: number; max?: number; words: string }> = {
  any: { words: 'any length' },
  bumper: { max: 6, words: 'at most 6 seconds' },
  non_skippable: { max: 15, words: 'at most 15 seconds' },
  skippable: { min: 12, max: 180, words: '12 seconds to 3 minutes' },
};

function day(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The channel lock for the generic tools. Every request goes with the
 * sign-in of the connected channel, which sees that channel's private videos,
 * playlists and captions: with a channel choice in place, that channel must
 * be chosen, and a channel a request names (channelId, a channels id, an
 * analytics channel==ID) too. Content-owner requests are refused.
 */
async function guard(request: ApiToolRequest, h: ToolHelpers): Promise<void> {
  const base = request.origin === ANALYTICS ? '/v2/' : '/youtube/v3/';
  if (!request.path.startsWith(base)) throw new ToolFailure(`Paths on ${request.origin} start with ${base}. Nothing was sent.`);
  for (const name of ['onBehalfOfContentOwner', 'onBehalfOfContentOwnerChannel', 'forContentOwner']) {
    if (request.query[name]?.length) throw new ToolFailure('Requests on behalf of a content owner are not available here. Nothing was sent.');
  }
  if (h.ctx.accounts === null) return;
  const named = new Set<string>();
  for (const name of ['channelId', 'allThreadsRelatedToChannelId']) for (const value of request.query[name] ?? []) named.add(value);
  if (request.origin !== ANALYTICS && request.segments[2] === 'channels') {
    for (const value of request.query['id'] ?? []) for (const id of value.split(',')) if (id.trim()) named.add(id.trim());
  }
  if (request.origin === ANALYTICS) {
    for (const value of request.query['ids'] ?? []) {
      const match = /^channel==(.+)$/.exec(value);
      if (!match) throw new ToolFailure('Analytics requests here take ids=channel==CHANNEL_ID (or channel==MINE). Nothing was sent.');
      if (match[1] !== 'MINE') named.add(match[1] as string);
    }
  }
  if (named.size) requireAccounts(h.ctx.accounts, 'channels', [...named], 'channel');
  await requireOwnChannel(h);
}

const connector = defineConnector({
  vendor: 'youtube',
  label: 'YouTube',
  origins: [API, ANALYTICS],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'YouTube access token' },
  accountPickers: [
    {
      key: 'channels',
      label: 'YouTube channels',
      description: 'The channels the agent may work on.',
      multiple: true,
      tool: 'list_channels',
      idField: 'id',
      nameField: 'title',
      legacyField: 'channelid',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_channels',
      kind: 'read',
      title: 'List YouTube channels',
      description:
        'Lists the YouTube channels of the connected Google account (only the chosen ones when a choice was made), with id, title, '
        + 'handle, subscriber, view and video counts and the uploads playlist id.',
      inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: 'nextCursor from the previous result.' } }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const { data } = await googleApi(h, {
          path: '/youtube/v3/channels',
          query: { part: 'snippet,statistics,contentDetails', mine: true, maxResults: 50, pageToken },
        });
        const allowed = allowedAccounts(h.ctx.accounts, 'channels');
        const channels = (Array.isArray(data?.items) ? data.items : [])
          .map((channel: any) => trimChannel(channel, false))
          .filter((channel: Record<string, unknown>) => allowed === null || allowed.includes(String(channel['id'])));
        return h.page({
          key: 'channels',
          items: channels.slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_channel',
      kind: 'read',
      title: 'Get a YouTube channel',
      description: "A channel's details and statistics: title, handle, description, country, subscribers, views, videos, keywords, uploads playlist id, audience setting and upload limits.",
      inputSchema: { type: 'object', properties: { channel_id: CHANNEL_ID }, additionalProperties: false },
      async run(args: { channel_id?: string }, h) {
        const channelId = await resolveChannel(h, args.channel_id);
        const { data } = await googleApi(h, {
          path: '/youtube/v3/channels',
          query: { part: 'snippet,statistics,contentDetails,brandingSettings,status', id: channelId },
        });
        const channel = Array.isArray(data?.items) ? data.items[0] : undefined;
        if (!channel) throw new ToolFailure(`YouTube found no channel ${channelId}.`);
        return trimChannel(channel, true);
      },
    },
    {
      name: 'list_videos',
      kind: 'read',
      title: 'List YouTube channel videos',
      description:
        "Lists a channel's uploads, newest first, with each video's id, title, publish time, visibility (and scheduled time), "
        + 'duration, views, likes, comments, audience setting and link. Pass nextCursor back as cursor for older videos.',
      inputSchema: { type: 'object', properties: { channel_id: CHANNEL_ID, page_size: PAGE_SIZE, cursor: CURSOR }, additionalProperties: false },
      async run(args: { channel_id?: string; page_size: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const size = cursorNumber(state, 'n', args.page_size, 1, 50);
        const channelId = await resolveChannel(h, args.channel_id);
        const page = await uploadsPage(h, state, channelId, size);
        return h.page({
          key: 'videos',
          items: page.videos.map(trimVideoSummary).slice(skip),
          extra: { channel_id: channelId },
          resumeAt: (index) => h.makeCursor({ u: page.uploads, ...(page.pageToken ? { p: page.pageToken } : {}), o: skip + index, n: size }),
          ...(page.nextToken ? { nextPage: h.makeCursor({ u: page.uploads, p: page.nextToken, o: 0, n: size }) } : {}),
        });
      },
    },
    {
      name: 'get_videos',
      kind: 'read',
      title: 'Get YouTube videos',
      description:
        'Reads up to 50 videos by id: title, description, tags, category, languages, channel, visibility and scheduled time, upload and '
        + 'processing state, license, embedding, audience setting, synthetic-media label, duration, definition, captions, views, '
        + 'likes, comments and thumbnail. Ids YouTube does not know (or that are private to another account) are listed in not_found.',
      inputSchema: {
        type: 'object',
        properties: {
          video_ids: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' }, minItems: 1, maxItems: 50, uniqueItems: true, description: 'Video ids.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result (with the same video_ids).' },
        },
        required: ['video_ids'],
        additionalProperties: false,
      },
      async run(args: { video_ids: string[]; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        // The sign-in sees its channel's private videos: with a choice in place, that channel must be chosen.
        await requireOwnChannel(h);
        const details = await videoDetails(h, args.video_ids);
        const found = args.video_ids.filter((id) => details.has(id));
        const missing = args.video_ids.filter((id) => !details.has(id));
        return h.page({
          key: 'videos',
          items: found.map((id) => trimVideo(details.get(id))).slice(skip),
          ...(missing.length ? { extra: { not_found: missing } } : {}),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'search_videos',
      kind: 'read',
      title: 'Search the videos of a YouTube channel',
      description:
        "Searches a channel's public videos by words, sorted by relevance, date, views, rating or title, optionally in a time range. "
        + 'Each search costs 100 units of the daily YouTube quota (10,000 by default): prefer list_videos to browse. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: CHANNEL_ID,
          query: { type: 'string', minLength: 1, maxLength: 500, description: 'The words to search for. Leave out to list by order.' },
          order: { type: 'string', enum: ['relevance', 'date', 'viewCount', 'rating', 'title'], default: 'relevance', description: 'The order (default relevance).' },
          published_after: { type: 'string', pattern: TIME, description: 'Only videos published at or after this RFC 3339 time.' },
          published_before: { type: 'string', pattern: TIME, description: 'Only videos published before this RFC 3339 time.' },
          max_results: PAGE_SIZE,
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { channel_id?: string; query?: string; order: string; published_after?: string; published_before?: string; max_results: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const size = cursorNumber(state, 'n', args.max_results, 1, 50);
        const channelId = await resolveChannel(h, args.channel_id);
        const { data } = await googleApi(h, {
          path: '/youtube/v3/search',
          query: {
            part: 'snippet',
            type: 'video',
            channelId,
            q: args.query,
            order: args.order,
            publishedAfter: args.published_after ? utcTime(args.published_after, 'published_after') : undefined,
            publishedBefore: args.published_before ? utcTime(args.published_before, 'published_before') : undefined,
            maxResults: size,
            pageToken,
          },
        });
        const videos = (Array.isArray(data?.items) ? data.items : []).map((item: any) => compact({
          id: item?.id?.videoId,
          title: text(item?.snippet?.title, 200),
          description: text(item?.snippet?.description, 300),
          published_at: item?.snippet?.publishedAt,
          url: typeof item?.id?.videoId === 'string' ? `https://youtu.be/${item.id.videoId}` : undefined,
        }));
        return h.page({
          key: 'videos',
          items: videos.slice(skip),
          extra: compact({ channel_id: channelId, total_results: data?.pageInfo?.totalResults }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: size }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: size }) } : {}),
        });
      },
    },
    {
      name: 'upload_video',
      kind: 'create',
      check: 'list_videos',
      title: 'Upload a video to YouTube',
      description:
        'Uploads a video (regular or Short) from a public https URL to the connected channel, with its title, description, tags, '
        + 'category, languages, visibility or scheduled release, audience setting and synthetic-media label. A vertical or square '
        + 'video of 3 minutes or less becomes a Short. It goes through YouTube\'s resumable upload in parts, each read from the URL by '
        + 'byte range just before it is sent, for about 35 seconds a call: while done is false, call again with the same arguments and '
        + 'cursor set to nextCursor, until done is true and the video id and link come back. A host that does not pass byte ranges on '
        + 'gets the whole file, which must then fit its download limit (often 25 to 50 MB). Upload each video once: when the outcome is '
        + 'unclear, look for it with list_videos first.',
      inputSchema: {
        type: 'object',
        properties: {
          video_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of the video file (MP4, MOV, WebM, AVI, FLV, WMV, MPEG or 3GP).' },
          ...METADATA_FIELDS,
          category_id: { ...(METADATA_FIELDS['category_id'] as Schema), default: '22' },
          ...STATUS_FIELDS,
          made_for_kids: { ...(STATUS_FIELDS['made_for_kids'] as Schema), default: false },
          embeddable: { ...(STATUS_FIELDS['embeddable'] as Schema), default: true },
          public_stats_viewable: { ...(STATUS_FIELDS['public_stats_viewable'] as Schema), default: true },
          license: { ...(STATUS_FIELDS['license'] as Schema), default: 'youtube' },
          notify_subscribers: { type: 'boolean', default: true, description: 'Tell subscribers about the new video (default true).' },
          part_mb: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PART_MB,
            default: DEFAULT_PART_MB,
            description: `The size of each part in MiB, 1 to ${MAX_PART_MB} (default ${DEFAULT_PART_MB}); an upload keeps the size it started with. Lower it when a part is refused as too large for the host or takes too long.`,
          },
          cursor: {
            type: 'string',
            maxLength: 4096,
            description: 'nextCursor from the previous result, while done is false: goes on with that upload where YouTube stopped. Give the same video_url with it (the other details are not sent again). Leave out to start an upload.',
          },
        },
        required: ['video_url', 'title', 'privacy_status', 'contains_synthetic_media'],
        additionalProperties: false,
      },
      async run(args: MetadataArgs & { video_url: string; notify_subscribers: boolean; part_mb: number; cursor?: string }, h) {
        const started = Date.now();
        const carried = h.cursor(args.cursor);
        if (carried) {
          // Going on: the details were sent when the upload started, and its time checks no longer apply.
          const state = stateFromCursor(carried);
          if (!state) throw new ToolFailure('The cursor holds no upload: pass nextCursor unchanged, or leave cursor out to start a new upload. Nothing was changed.');
          if (state.source !== (await sourceKey(args.video_url))) {
            throw new ToolFailure('The cursor belongs to an upload of another video_url: give the video_url it started with, or leave cursor out to start a new upload. Nothing was changed.');
          }
          await requireOwnChannel(h);
          return exclusive(state, () => goOn(h, state, args.video_url, started));
        }
        checkMetadata(args);
        let publishAt: string | undefined;
        if (args.publish_at !== undefined) {
          if (args.privacy_status !== 'private') throw new ToolFailure('publish_at needs privacy_status private: YouTube makes the video public at that time. Nothing was changed.');
          publishAt = futureTime(args.publish_at);
        }
        await requireOwnChannel(h);
        const part = args.part_mb * MIB;
        const readStarted = Date.now();
        let first: SourcePart;
        try {
          first = await readPart(h, args.video_url, 0, part - 1);
        } catch (error) {
          if (error instanceof SourceProblem) throw new ToolFailure(`${error.message} Nothing was changed.`);
          throw error;
        }
        const type = sniffVideo(first.bytes);
        if (!type) throw new ToolFailure('The video URL did not return a video file YouTube takes (MP4, MOV, WebM, AVI, FLV, WMV, MPEG or 3GP). Nothing was changed.');
        if (first.total > MAX_VIDEO_BYTES) {
          throw new ToolFailure(`The video is ${formatNumber(first.total)} bytes; YouTube takes files up to 256 GB. Nothing was changed.`);
        }
        const snippet = compact({
          title: args.title,
          description: args.description,
          tags: args.tags,
          categoryId: args.category_id,
          defaultLanguage: args.default_language,
          defaultAudioLanguage: args.default_audio_language,
        });
        const status = compact({
          privacyStatus: args.privacy_status,
          publishAt,
          embeddable: args.embeddable,
          publicStatsViewable: args.public_stats_viewable,
          license: args.license,
          selfDeclaredMadeForKids: args.made_for_kids,
          containsSyntheticMedia: args.contains_synthetic_media,
        });
        // Opening the upload makes nothing yet: YouTube makes the video only once its last byte is in.
        const session = await googleApi(h, {
          method: 'POST',
          path: '/upload/youtube/v3/videos',
          query: { uploadType: 'resumable', part: 'snippet,status', notifySubscribers: args.notify_subscribers },
          headers: { 'x-upload-content-type': type, 'x-upload-content-length': String(first.total) },
          json: { snippet, status },
          errors: { 400: 'YouTube did not accept the video details', 403: 'YouTube refused the upload' },
        });
        const address = uploadAddress(session.headers.get('location'));
        if (!address) throw new ToolFailure('YouTube opened no upload address for the video. Nothing was changed.');
        const state: UploadState = {
          session: address,
          total: first.total,
          part,
          type,
          source: await sourceKey(args.video_url),
          ...(first.etag ? { etag: first.etag } : {}),
        };
        const cursor = h.makeCursor(cursorState(state));
        const outcome = await exclusive(state, () => transfer(h, { state, videoUrl: args.video_url, offset: 0, started, cursor, held: first, heldSince: readStarted }));
        return uploadResult(outcome, state, cursor);
      },
    },
    {
      name: 'update_video',
      kind: 'update',
      check: 'get_videos',
      title: 'Update a YouTube video',
      description:
        "Changes a video's title, description, tags, category, languages, visibility or scheduled release, audience setting, "
        + 'synthetic-media label, embedding, public statistics or license: only the fields given change (the others are read and sent '
        + 'back as they are, since YouTube resets what an update leaves out). privacy_status public publishes a private or unlisted '
        + 'video; private with publish_at schedules it. Returns the video as saved.',
      inputSchema: {
        type: 'object',
        properties: { video_id: VIDEO_ID, ...METADATA_FIELDS, ...STATUS_FIELDS },
        required: ['video_id'],
        additionalProperties: false,
      },
      async run(args: MetadataArgs & { video_id: string }, h) {
        const snippetKeys = ['title', 'description', 'tags', 'category_id', 'default_language', 'default_audio_language'] as const;
        const statusKeys = ['privacy_status', 'publish_at', 'made_for_kids', 'contains_synthetic_media', 'embeddable', 'public_stats_viewable', 'license'] as const;
        const changesSnippet = snippetKeys.some((key) => args[key] !== undefined);
        const changesStatus = statusKeys.some((key) => args[key] !== undefined);
        if (!changesSnippet && !changesStatus) throw new ToolFailure('Nothing to change: give at least one field besides video_id. Nothing was changed.');
        checkMetadata(args);
        const publishAt = args.publish_at !== undefined ? futureTime(args.publish_at) : undefined;

        const current = await readVideo(h, args.video_id, 'snippet,status');
        requireAccounts(h.ctx.accounts, 'channels', String(current?.snippet?.channelId ?? ''), 'channel');
        const body: Record<string, unknown> = { id: args.video_id };
        const parts: string[] = [];
        if (changesSnippet) {
          const now = current.snippet ?? {};
          body['snippet'] = compact({
            title: args.title ?? now.title,
            categoryId: args.category_id ?? now.categoryId ?? '22',
            description: args.description ?? now.description,
            tags: args.tags ?? now.tags,
            defaultLanguage: args.default_language ?? now.defaultLanguage,
            defaultAudioLanguage: args.default_audio_language ?? now.defaultAudioLanguage,
          });
          parts.push('snippet');
        }
        if (changesStatus) {
          const now = current.status ?? {};
          const privacy = publishAt ? (args.privacy_status ?? 'private') : (args.privacy_status ?? now.privacyStatus);
          if (publishAt && privacy !== 'private') throw new ToolFailure('publish_at needs privacy_status private: YouTube makes the video public at that time. Nothing was changed.');
          // A schedule stays only while the video stays private and no new visibility was asked for.
          const keepSchedule = !publishAt && args.privacy_status === undefined && privacy === 'private' ? now.publishAt : undefined;
          body['status'] = compact({
            privacyStatus: privacy,
            publishAt: publishAt ?? keepSchedule,
            embeddable: args.embeddable ?? now.embeddable,
            publicStatsViewable: args.public_stats_viewable ?? now.publicStatsViewable,
            license: args.license ?? now.license,
            selfDeclaredMadeForKids: args.made_for_kids ?? now.selfDeclaredMadeForKids ?? now.madeForKids,
            containsSyntheticMedia: args.contains_synthetic_media ?? now.containsSyntheticMedia,
          });
          parts.push('status');
        }
        const { data } = await googleApi(h, {
          method: 'PUT',
          path: '/youtube/v3/videos',
          query: { part: parts.join(',') },
          json: body,
          write: true,
          errors: { 400: 'YouTube did not accept the change', 403: 'YouTube refused the change: the video must belong to the connected channel' },
        });
        const saved = trimVideo(data);
        const asked = args.privacy_status;
        if ((asked === 'public' || asked === 'unlisted') && saved['privacy_status'] === 'private') {
          saved['warning'] = `YouTube kept the video private although ${asked} was asked: ${UPLOAD_NOTE.slice(UPLOAD_NOTE.indexOf('videos uploaded'))}`;
        }
        return saved;
      },
    },
    {
      name: 'set_thumbnail',
      kind: 'update',
      check: 'get_videos',
      title: 'Set a YouTube video thumbnail',
      description:
        "Sets a video's custom thumbnail from a public https URL of a JPEG or PNG image under 2 MB (1280 x 720 is best). The channel "
        + 'must be verified for custom thumbnails. Returns the thumbnail URLs.',
      inputSchema: {
        type: 'object',
        properties: {
          video_id: VIDEO_ID,
          image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of a JPEG or PNG image under 2 MB.' },
        },
        required: ['video_id', 'image_url'],
        additionalProperties: false,
      },
      async run(args: { video_id: string; image_url: string }, h) {
        await requireOwnChannel(h);
        const { bytes } = await h.media(args.image_url, { what: 'thumbnail image', maxBytes: MAX_THUMBNAIL_BYTES, accept: 'image/jpeg,image/png' });
        const type = sniffImage(bytes);
        if (!type) throw new ToolFailure('The image URL did not return a JPEG or PNG image. Nothing was changed.');
        const { data } = await googleApi(h, {
          method: 'POST',
          path: '/upload/youtube/v3/thumbnails/set',
          query: { videoId: args.video_id, uploadType: 'media' },
          body: bytes,
          contentType: type,
          write: true,
          errors: {
            403: 'YouTube refused the thumbnail: custom thumbnails need a verified channel and work only on its own videos',
            404: `YouTube found no video ${args.video_id} on the connected channel`,
          },
        });
        const sizes = data?.items?.[0] ?? {};
        const thumbnails = compact(Object.fromEntries(['default', 'medium', 'high', 'standard', 'maxres'].map((size) => [size, sizes?.[size]?.url])));
        return { video_id: args.video_id, thumbnails };
      },
    },
    {
      name: 'list_playlists',
      kind: 'read',
      title: 'List YouTube playlists',
      description:
        "Lists a channel's playlists with id, title, visibility, item count and link; the connected channel's private playlists too. "
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { channel_id: CHANNEL_ID, page_size: PAGE_SIZE, cursor: CURSOR }, additionalProperties: false },
      async run(args: { channel_id?: string; page_size: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const size = cursorNumber(state, 'n', args.page_size, 1, 50);
        const channelId = await resolveChannel(h, args.channel_id);
        // The connected channel lists its private playlists only through mine=true.
        const mine = channelId === (await ownChannel(h));
        const { data } = await googleApi(h, {
          path: '/youtube/v3/playlists',
          query: { part: 'snippet,contentDetails,status', ...(mine ? { mine: true } : { channelId }), maxResults: size, pageToken },
        });
        const playlists = (Array.isArray(data?.items) ? data.items : []).map(trimPlaylist);
        return h.page({
          key: 'playlists',
          items: playlists.slice(skip),
          extra: { channel_id: channelId },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: size }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: size }) } : {}),
        });
      },
    },
    {
      name: 'list_playlist_items',
      kind: 'read',
      title: 'List the videos of a YouTube playlist',
      description: 'Lists the videos of a playlist in order, with each entry\'s item id, video id, title, position and visibility. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { playlist_id: PLAYLIST_ID, page_size: PAGE_SIZE, cursor: CURSOR },
        required: ['playlist_id'],
        additionalProperties: false,
      },
      async run(args: { playlist_id: string; page_size: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const size = cursorNumber(state, 'n', args.page_size, 1, 50);
        // The sign-in sees its channel's private playlists: with a choice in place, that channel must be chosen.
        await requireOwnChannel(h);
        const { data } = await googleApi(h, {
          path: '/youtube/v3/playlistItems',
          query: { part: 'snippet,contentDetails,status', playlistId: args.playlist_id, maxResults: size, pageToken },
          errors: { 404: `YouTube found no playlist ${args.playlist_id}` },
        });
        const items = (Array.isArray(data?.items) ? data.items : []).map((item: any) => compact({
          item_id: item?.id,
          video_id: item?.contentDetails?.videoId ?? item?.snippet?.resourceId?.videoId,
          title: text(item?.snippet?.title, 200),
          position: item?.snippet?.position,
          published_at: item?.contentDetails?.videoPublishedAt,
          privacy_status: item?.status?.privacyStatus,
          owner_channel_id: item?.snippet?.videoOwnerChannelId,
        }));
        return h.page({
          key: 'items',
          items: items.slice(skip),
          extra: { playlist_id: args.playlist_id },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: size }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: size }) } : {}),
        });
      },
    },
    {
      name: 'create_playlist',
      kind: 'create',
      check: 'list_playlists',
      title: 'Create a YouTube playlist',
      description: 'Creates a playlist on the connected channel (private unless told otherwise). Returns its id and link.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 150, description: 'The playlist title.' },
          description: { type: 'string', maxLength: 5000, description: 'The playlist description.' },
          privacy_status: { type: 'string', enum: PRIVACY, default: 'private', description: 'public, unlisted or private (default).' },
          default_language: { ...LANGUAGE, description: 'The language of the title and description.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      async run(args: { title: string; description?: string; privacy_status: string; default_language?: string }, h) {
        if (/[<>]/.test(args.title) || /[<>]/.test(args.description ?? '')) throw new ToolFailure('The title and description may not contain < or >. Nothing was changed.');
        await requireOwnChannel(h);
        const { data } = await googleApi(h, {
          method: 'POST',
          path: '/youtube/v3/playlists',
          query: { part: 'snippet,status' },
          json: {
            snippet: compact({ title: args.title, description: args.description, defaultLanguage: args.default_language }),
            status: { privacyStatus: args.privacy_status },
          },
          write: true,
        });
        return trimPlaylist(data);
      },
    },
    {
      name: 'add_to_playlist',
      kind: 'create',
      check: 'list_playlist_items',
      title: 'Add a video to a YouTube playlist',
      description: 'Adds a video to one of the connected channel\'s playlists, at the end or at a position (0 is first). Returns the new playlist item.',
      inputSchema: {
        type: 'object',
        properties: {
          playlist_id: PLAYLIST_ID,
          video_id: VIDEO_ID,
          position: { type: 'integer', minimum: 0, maximum: 4999, description: 'Where in the playlist, 0 first. Leave out to add at the end.' },
        },
        required: ['playlist_id', 'video_id'],
        additionalProperties: false,
      },
      async run(args: { playlist_id: string; video_id: string; position?: number }, h) {
        await requireOwnChannel(h);
        const { data } = await googleApi(h, {
          method: 'POST',
          path: '/youtube/v3/playlistItems',
          query: { part: 'snippet' },
          json: {
            snippet: {
              playlistId: args.playlist_id,
              resourceId: { kind: 'youtube#video', videoId: args.video_id },
              ...(args.position !== undefined ? { position: args.position } : {}),
            },
          },
          write: true,
          errors: { 404: 'YouTube found no such playlist or video', 403: 'YouTube refused: the playlist must belong to the connected channel' },
        });
        return compact({ item_id: data?.id, playlist_id: data?.snippet?.playlistId ?? args.playlist_id, video_id: data?.snippet?.resourceId?.videoId ?? args.video_id, position: data?.snippet?.position });
      },
    },
    {
      name: 'get_analytics_report',
      kind: 'read',
      title: 'Get a YouTube Analytics report',
      description:
        'Runs a YouTube Analytics report for a channel and a date range: a ready report (top_videos, daily, retention for one video, '
        + 'traffic_sources, countries, devices, demographics; daily when neither report nor metrics is given) or your own metrics, '
        + 'dimensions, filters and sort. Rows come back as objects keyed by column; rows by video also carry the title. The latest two or '
        + 'three days may be missing. Pass nextCursor back as cursor for more rows.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: CHANNEL_ID,
          start_date: { ...DATE, description: 'First day, YYYY-MM-DD.' },
          end_date: { ...DATE, description: 'Last day, YYYY-MM-DD.' },
          report: { type: 'string', enum: Object.keys(REPORTS), description: 'A ready report. Leave out to give metrics (and dimensions) yourself; with neither, daily.' },
          video_id: { ...VIDEO_ID, description: 'One video: required for retention; with another report, only this video\'s data.' },
          metrics: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,63}$' }, minItems: 1, maxItems: 20, uniqueItems: true, description: 'Your own report\'s metrics, such as ["views", "estimatedMinutesWatched", "likes"].' },
          dimensions: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,63}$' }, maxItems: 5, uniqueItems: true, description: 'Your own report\'s dimensions, such as ["day"], ["video"] or ["country"].' },
          filters: { type: 'string', maxLength: 2000, pattern: '^[A-Za-z0-9=,;:_.\\-]+$', description: 'Your own report\'s filters, such as "video==VIDEO_ID" or "country==US".' },
          sort: { type: 'string', maxLength: 200, pattern: '^-?[A-Za-z0-9]+(,-?[A-Za-z0-9]+)*$', description: 'Your own report\'s sort, such as "-views"; a minus sorts high to low.' },
          max_results: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows per page (top video reports allow up to 200).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result (with the same report).' },
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
      async run(args: {
        channel_id?: string; start_date: string; end_date: string; report?: string; video_id?: string; metrics?: string[];
        dimensions?: string[]; filters?: string; sort?: string; max_results?: number; cursor?: string;
      }, h) {
        const state = h.cursor(args.cursor);
        const startIndex = cursorNumber(state, 'i', 1, 1, 1_000_000);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        if (args.report && (args.metrics || args.dimensions || args.filters || args.sort)) {
          throw new ToolFailure('Give either report or your own metrics, dimensions, filters and sort, not both. Nothing was sent.');
        }
        const name = args.report ?? (args.metrics?.length ? undefined : 'daily');
        const preset = name ? REPORTS[name] : undefined;
        if (!preset && !args.metrics?.length) throw new ToolFailure('Give metrics for your own report, or pick a ready report. Nothing was sent.');
        if (preset?.needsVideo && !args.video_id) throw new ToolFailure(`The ${name} report needs video_id. Nothing was sent.`);
        const channelId = await resolveChannel(h, args.channel_id);
        const filters = preset
          ? (args.video_id ? `video==${args.video_id}` : undefined)
          : [args.filters, args.video_id ? `video==${args.video_id}` : undefined].filter(Boolean).join(';') || undefined;
        const maxResults = args.max_results ?? preset?.maxResults;
        const dimensions = preset ? preset.dimensions : args.dimensions ?? [];
        const { data } = await googleApi(h, {
          origin: ANALYTICS,
          path: '/v2/reports',
          query: {
            ids: `channel==${channelId}`,
            startDate: args.start_date,
            endDate: args.end_date,
            metrics: (preset ? preset.metrics : args.metrics ?? []).join(','),
            dimensions: dimensions.length ? dimensions.join(',') : undefined,
            filters,
            sort: preset ? preset.sort : args.sort,
            maxResults,
            startIndex: maxResults ? startIndex : undefined,
          },
          errors: { 400: 'YouTube Analytics did not accept the report: check the metrics, dimensions and filters together' },
        });
        const columns: string[] = (Array.isArray(data?.columnHeaders) ? data.columnHeaders : []).map((header: any) => String(header?.name));
        const rows: Record<string, unknown>[] = (Array.isArray(data?.rows) ? data.rows : []).map((row: unknown[]) => Object.fromEntries(columns.map((name, index) => [name, row?.[index]])));
        if (columns.includes('video') && rows.length) {
          const ids = [...new Set(rows.map((row) => String(row['video'])))].slice(0, 50);
          try {
            const details = await videoDetails(h, ids);
            for (const row of rows) {
              const title = text(details.get(String(row['video']))?.snippet?.title, 200);
              if (title) row['title'] = title;
            }
          } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
          }
        }
        const more = maxResults !== undefined && rows.length >= maxResults;
        return h.page({
          key: 'rows',
          items: rows.slice(skip),
          extra: { channel_id: channelId, start_date: args.start_date, end_date: args.end_date, columns },
          resumeAt: (index) => h.makeCursor({ i: startIndex, o: skip + index }),
          ...(more ? { nextPage: h.makeCursor({ i: startIndex + rows.length, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'screen_videos_for_ads',
      kind: 'read',
      title: 'Screen YouTube videos for video ads',
      description:
        "Checks a channel's uploads for use in video ad campaigns: public or unlisted, not made for kids, enough views, a length that fits "
        + 'the ad format (bumper up to 6 s, non_skippable up to 15 s, skippable 12 s to 3 min) and, from Analytics, an average view '
        + 'percentage over the last days. Each video comes back with eligible and the reasons it is not. Pass nextCursor back as cursor for older uploads.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: CHANNEL_ID,
          ad_format: { type: 'string', enum: Object.keys(AD_FORMATS), default: 'any', description: 'any (default), bumper, non_skippable or skippable.' },
          min_views: { type: 'integer', minimum: 0, default: 1000, description: 'Fewest views (default 1,000).' },
          min_view_percentage: { type: 'number', minimum: 0, maximum: 100, default: 40, description: 'Lowest average view percentage (default 40).' },
          days: { type: 'integer', minimum: 0, maximum: 365, default: 90, description: 'Days of Analytics for the view percentage (default 90); 0 skips it.' },
          page_size: { ...PAGE_SIZE, default: 50, description: 'Uploads per page, 1 to 50 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { channel_id?: string; ad_format: string; min_views: number; min_view_percentage: number; days: number; page_size: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const size = cursorNumber(state, 'n', args.page_size, 1, 50);
        const format = AD_FORMATS[args.ad_format] as { min?: number; max?: number; words: string };
        const channelId = await resolveChannel(h, args.channel_id);
        const page = await uploadsPage(h, state, channelId, size);
        const retention = new Map<string, number>();
        let note: string | undefined;
        if (args.days > 0 && page.videos.length) {
          try {
            const { data } = await googleApi(h, {
              origin: ANALYTICS,
              path: '/v2/reports',
              query: {
                ids: `channel==${channelId}`,
                startDate: day(args.days),
                endDate: day(0),
                metrics: 'views,averageViewPercentage',
                dimensions: 'video',
                filters: `video==${page.videos.map((video) => video.id).join(',')}`,
                sort: '-views',
                maxResults: 50,
              },
            });
            const columns: string[] = (Array.isArray(data?.columnHeaders) ? data.columnHeaders : []).map((header: any) => String(header?.name));
            const videoAt = columns.indexOf('video');
            const percentAt = columns.indexOf('averageViewPercentage');
            for (const row of Array.isArray(data?.rows) ? data.rows : []) {
              if (videoAt >= 0 && percentAt >= 0 && typeof row?.[percentAt] === 'number') retention.set(String(row[videoAt]), row[percentAt]);
            }
          } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
            note = `The view percentage could not be read from YouTube Analytics, so it was not checked: ${error.message}`;
          }
        }
        const videos = page.videos.map((video: any) => {
          const summary = trimVideoSummary(video);
          const reasons: string[] = [];
          const privacy = String(summary['privacy_status'] ?? 'unknown');
          if (privacy !== 'public' && privacy !== 'unlisted') reasons.push(`it is ${privacy}`);
          if (summary['made_for_kids'] === true) reasons.push('it is made for kids');
          const views = typeof summary['views'] === 'number' ? summary['views'] : 0;
          if (views < args.min_views) reasons.push(`${formatNumber(views)} views, fewer than ${formatNumber(args.min_views)}`);
          const seconds = summary['duration_seconds'];
          if (typeof seconds === 'number' && ((format.min !== undefined && seconds < format.min) || (format.max !== undefined && seconds > format.max))) {
            reasons.push(`${seconds} s long; ${args.ad_format} needs ${format.words}`);
          }
          const percent = retention.get(String(summary['id']));
          if (percent !== undefined && percent < args.min_view_percentage) reasons.push(`average view percentage ${percent}, below ${args.min_view_percentage}`);
          return compact({
            id: summary['id'],
            title: summary['title'],
            duration_seconds: seconds,
            views,
            privacy_status: privacy,
            made_for_kids: summary['made_for_kids'],
            average_view_percentage: percent,
            eligible: reasons.length === 0,
            reasons: reasons.length ? reasons : undefined,
            url: summary['url'],
          });
        });
        return h.page({
          key: 'videos',
          items: videos.slice(skip),
          extra: compact({
            channel_id: channelId,
            criteria: { ad_format: args.ad_format, length: format.words, min_views: args.min_views, min_view_percentage: args.days > 0 ? args.min_view_percentage : undefined },
            note,
          }),
          resumeAt: (index) => h.makeCursor({ u: page.uploads, ...(page.pageToken ? { p: page.pageToken } : {}), o: skip + index, n: size }),
          ...(page.nextToken ? { nextPage: h.makeCursor({ u: page.uploads, p: page.nextToken, o: 0, n: size }) } : {}),
        });
      },
    },
    // The rest of the YouTube Data and Analytics APIs: deletes, playlist changes, channel settings.
    ...apiTools({
      label: 'YouTube',
      description:
        'The YouTube Data API v3 on https://www.googleapis.com (paths start with /youtube/v3/, such as /youtube/v3/videos with id in '
        + 'query to delete a video, /youtube/v3/playlistItems with id to take a video out of a playlist, or /youtube/v3/channels with '
        + 'part=brandingSettings) and the YouTube Analytics API v2 on https://youtubeanalytics.googleapis.com (/v2/reports with '
        + 'ids=channel==CHANNEL_ID). Comments and captions need a token with the youtube.force-ssl scope. With a channel choice in '
        + 'place, the connected channel and any channel a request names must be chosen. Reference: https://developers.google.com/youtube/v3/docs.',
      originArgument: 'The API host: https://www.googleapis.com (default) or https://youtubeanalytics.googleapis.com.',
      methods: ['POST', 'PUT', 'DELETE'],
      guard,
      send: (request, h) => googleApi(h, request),
    }),
  ],
});

export = connector;
