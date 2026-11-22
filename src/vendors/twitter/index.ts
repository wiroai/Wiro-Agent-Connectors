// X (formerly Twitter), through the X API v2 on https://api.x.com: posts,
// replies, threads, deletes, and the v2 chunked media upload
// (initialize, append, finalize, status).
//
// Credentials:
// - `access_token`: the current OAuth 2.0 user access token of the account
//   that signed in (permissions tweet.read, tweet.write and users.read;
//   media.write for media uploads). The host refreshes it; this module never
//   does.
// - `xusername` (optional): the account's username, as the host wrote it
//   after the sign-in. Only shown back.

import { apiTools, defineConnector, formatNumber, OutcomeUnknown, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';
import { base64, sniffMedia, VIDEO_MAX_BYTES } from './media.js';

const SEGMENT_BYTES = 4 * 1024 * 1024;
const ID = '^[0-9]{1,19}$';
const HTTPS_URL = { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000 };
const TWEET_FIELDS = 'created_at,public_metrics,conversation_id,in_reply_to_user_id,referenced_tweets,attachments,author_id,note_tweet';
const MEDIA_REFUSED = 'X refused the media upload: the connection needs the media.write permission (connect X again and allow media uploads)';

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function postUrl(id: string): string {
  // This form opens the post whichever account posted it.
  return `https://x.com/i/web/status/${id}`;
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

function trimMedia(media: any): Record<string, unknown> {
  return compact({
    mediaKey: media?.media_key,
    type: media?.type,
    url: media?.url ?? media?.preview_image_url,
    altText: media?.alt_text,
    durationMs: media?.duration_ms,
    width: media?.width,
    height: media?.height,
  });
}

function trimPost(post: any, mediaByKey: Map<string, any> = new Map()): Record<string, unknown> {
  const id = typeof post?.id === 'string' ? post.id : undefined;
  const text = typeof post?.note_tweet?.text === 'string' ? post.note_tweet.text : post?.text;
  const metrics = post?.public_metrics ?? {};
  const referenced: any[] = Array.isArray(post?.referenced_tweets) ? post.referenced_tweets : [];
  const ref = (type: string) => referenced.find((item) => item?.type === type)?.id;
  const keys: unknown[] = Array.isArray(post?.attachments?.media_keys) ? post.attachments.media_keys : [];
  const media = keys.map((key) => mediaByKey.get(String(key))).filter(Boolean).map(trimMedia);
  return compact({
    id,
    url: id ? postUrl(id) : undefined,
    text: typeof text === 'string' ? truncate(text, 1000) : undefined,
    createdAt: post?.created_at,
    likes: metrics.like_count,
    reposts: metrics.retweet_count,
    replies: metrics.reply_count,
    quotes: metrics.quote_count,
    bookmarks: metrics.bookmark_count,
    impressions: metrics.impression_count,
    replyTo: ref('replied_to'),
    quoteOf: ref('quoted'),
    repostOf: ref('retweeted'),
    conversationId: post?.conversation_id !== id ? post?.conversation_id : undefined,
    mediaCount: keys.length || undefined,
    media: media.length ? media : undefined,
  });
}

interface Processing {
  state?: string;
  check_after_secs?: number;
  progress_percent?: number;
  error?: { message?: string; name?: string };
}

interface Uploaded {
  mediaId: string;
  mediaKey?: string;
  type: string;
  category: string;
  bytes: number;
  state: string;
  progressPercent?: number;
}

/**
 * Uploads one file from a public https URL with X's chunked upload: initialize,
 * append in 4 MB segments, finalize, then follow the processing of a GIF or a
 * video for up to `waitSeconds`. Nothing is posted.
 */
async function uploadMedia(h: ToolHelpers, url: string, what: string, waitSeconds: number, altText?: string): Promise<Uploaded> {
  const { bytes } = await h.media(url, { what, maxBytes: VIDEO_MAX_BYTES, accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime' });
  const kind = sniffMedia(bytes);
  if (!kind) throw new ToolFailure(`The ${what} URL did not return a JPEG, PNG, WebP or GIF image, or an MP4 or MOV video. Nothing was posted.`);
  if (bytes.length > kind.maxBytes) {
    throw new ToolFailure(`The ${what} has ${formatNumber(bytes.length)} bytes; X takes up to ${formatNumber(kind.maxBytes)} for a ${kind.type} file. Nothing was posted.`);
  }

  const init = await h.api({
    method: 'POST',
    path: '/2/media/upload/initialize',
    json: { media_type: kind.type, total_bytes: bytes.length, media_category: kind.category },
    errors: { 403: MEDIA_REFUSED },
  });
  const mediaId = init.data?.data?.id;
  if (typeof mediaId !== 'string' || !/^[0-9]{1,19}$/.test(mediaId)) throw new ToolFailure(`X did not start the upload of the ${what}. Nothing was posted.`);

  for (let segment = 0, offset = 0; offset < bytes.length; segment++, offset += SEGMENT_BYTES) {
    await h.api({
      method: 'POST',
      path: `/2/media/upload/${mediaId}/append`,
      json: { media: base64(bytes.subarray(offset, offset + SEGMENT_BYTES)), segment_index: segment },
      errors: { 403: MEDIA_REFUSED },
    });
  }
  const finalized = await h.api({ method: 'POST', path: `/2/media/upload/${mediaId}/finalize`, errors: { 403: MEDIA_REFUSED } });
  const mediaKey = typeof finalized.data?.data?.media_key === 'string' ? finalized.data.data.media_key : init.data?.data?.media_key;
  let processing: Processing | undefined = finalized.data?.data?.processing_info;

  let waited = 0;
  while (processing && processing.state !== 'succeeded' && processing.state !== 'failed' && waited < waitSeconds) {
    const after = typeof processing.check_after_secs === 'number' ? processing.check_after_secs : 5;
    const step = Math.min(Math.max(1, Math.min(10, after)), waitSeconds - waited);
    if (!(await pause(step * 1000, h.ctx.signal))) break;
    waited += step;
    const { data } = await h.api({ path: '/2/media/upload', query: { command: 'STATUS', media_id: mediaId } });
    processing = data?.data?.processing_info ?? { state: 'succeeded' };
  }
  if (processing?.state === 'failed') {
    const reason = processing.error?.message ?? processing.error?.name;
    throw new ToolFailure(`X could not process the ${what}${reason ? `: ${truncate(String(reason), 200).replace(/[.!?]+$/, '')}` : ''}. Nothing was posted.`);
  }
  const state = processing?.state ?? 'succeeded';
  if (altText && state === 'succeeded') {
    await h.api({ method: 'POST', path: '/2/media/metadata', json: { id: mediaId, metadata: { alt_text: { text: altText } } }, errors: { 403: MEDIA_REFUSED } });
  }
  return compact({
    mediaId,
    mediaKey,
    type: kind.type,
    category: kind.category,
    bytes: bytes.length,
    state,
    progressPercent: state === 'succeeded' ? undefined : processing?.progress_percent,
  }) as unknown as Uploaded;
}

interface MediaArgs {
  media_urls?: string[];
  media_alt_texts?: string[];
  media_ids?: string[];
}

/**
 * The media ids of one post: uploads its URLs (each one processed and ready)
 * or takes its ids. `post` names the post in a thread, e.g. "post 2".
 */
async function mediaFor(h: ToolHelpers, args: MediaArgs, waitSeconds: number, post?: string): Promise<{ ids: string[]; uploaded: Uploaded[] }> {
  const where = post ? ` for ${post}` : '';
  if (args.media_urls?.length && args.media_ids?.length) throw new ToolFailure(`Give media_urls or media_ids${where}, not both. Nothing was posted.`);
  if (args.media_alt_texts?.length && args.media_alt_texts.length > (args.media_urls?.length ?? 0)) {
    throw new ToolFailure(`media_alt_texts${where} has more entries than media_urls. Nothing was posted.`);
  }
  if (!args.media_urls?.length) return { ids: args.media_ids ?? [], uploaded: [] };
  const uploaded: Uploaded[] = [];
  const many = args.media_urls.length > 1;
  for (const [index, url] of args.media_urls.entries()) {
    const what = `${post ? `${post} ` : ''}media${many ? ` ${index + 1}` : ''}`;
    const file = await uploadMedia(h, url, what, waitSeconds, args.media_alt_texts?.[index] || undefined);
    if (file.state !== 'succeeded') {
      throw new ToolFailure(
        `The ${what} is still being processed by X (media_id ${file.mediaId}). Nothing was posted: check it with get_media_status, `
          + 'then post with media_ids instead of media_urls.',
      );
    }
    uploaded.push(file);
  }
  return { ids: uploaded.map((file) => file.mediaId), uploaded };
}

const MEDIA_PROPERTIES = {
  media_urls: { type: 'array' as const, minItems: 1, maxItems: 4, items: HTTPS_URL, description: 'Up to 4 public https URLs of images, or one GIF or video, uploaded before posting.' },
  media_alt_texts: { type: 'array' as const, maxItems: 4, items: { type: 'string' as const, maxLength: 1000 }, description: 'Alt text for each of media_urls, in the same order.' },
  media_ids: { type: 'array' as const, minItems: 1, maxItems: 4, items: { type: 'string' as const, pattern: ID }, description: 'Media already uploaded with upload_media, instead of media_urls.' },
};
const TEXT_SCHEMA = {
  type: 'string' as const,
  maxLength: 25000,
  description: 'The post text: up to 280 characters (X counts a link as 23 and some characters as 2), or up to 25,000 on an X Premium account.',
};
const WAIT_SCHEMA = {
  type: 'integer' as const,
  minimum: 0,
  maximum: 180,
  default: 60,
  description: 'Seconds to wait for X to process a GIF or video before giving up (default 60).',
};

interface PostArgs extends MediaArgs {
  text?: string;
  reply_to_post_id?: string;
  quote_post_id?: string;
  poll?: { options: string[]; duration_minutes: number };
  reply_settings?: string;
  made_with_ai?: boolean;
  paid_partnership?: boolean;
  wait_seconds: number;
}

interface ThreadPost extends MediaArgs {
  text?: string;
}

async function createPost(h: ToolHelpers, body: Record<string, unknown>): Promise<string> {
  const { data } = await h.api({ method: 'POST', path: '/2/tweets', json: body, write: true });
  const id = data?.data?.id;
  if (typeof id !== 'string' || !/^[0-9]{1,19}$/.test(id)) {
    throw new OutcomeUnknown('X answered without the new post\'s id, so it is not known whether it was published.');
  }
  return id;
}

async function myUserId(h: ToolHelpers): Promise<string> {
  const { data } = await h.api({ path: '/2/users/me' });
  const id = data?.data?.id;
  if (typeof id !== 'string' || !/^[0-9]{1,19}$/.test(id)) throw new ToolFailure('X did not say which account is connected.');
  return id;
}

const connector = defineConnector({
  vendor: 'twitter',
  label: 'X',
  origins: ['https://api.x.com'],
  credentials: ['access_token', 'xusername'],
  requiredCredentials: [['access_token']],
  credentialLabels: { access_token: 'X access token', xusername: 'X username' },
  normalizeCredentials: (credentials) => ({ ...credentials, ...(credentials['xusername'] ? { xusername: credentials['xusername'].replace(/^@/, '') } : {}) }),
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'get_me',
      kind: 'read',
      title: 'Get the connected X account',
      description: 'Returns the connected X account: id, username, name, bio, follower, following and post counts, verification and X Premium subscription type.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await h.api({
          path: '/2/users/me',
          query: { 'user.fields': 'created_at,description,location,profile_image_url,protected,public_metrics,subscription_type,url,verified,verified_type' },
        });
        const user = data?.data ?? {};
        const metrics = user.public_metrics ?? {};
        const username = typeof user.username === 'string' ? user.username : h.credentials['xusername'];
        return compact({
          id: user.id,
          username,
          name: user.name,
          url: username ? `https://x.com/${username}` : undefined,
          description: typeof user.description === 'string' && user.description ? truncate(user.description, 600) : undefined,
          location: user.location || undefined,
          followers: metrics.followers_count,
          following: metrics.following_count,
          posts: metrics.tweet_count,
          listed: metrics.listed_count,
          verified: user.verified,
          verifiedType: user.verified_type,
          subscriptionType: user.subscription_type,
          protected: user.protected,
          createdAt: user.created_at,
          profileImageUrl: user.profile_image_url,
        });
      },
    },
    {
      name: 'list_my_posts',
      kind: 'read',
      title: 'List my X posts',
      description:
        "Lists the connected account's own posts, newest first, with each post's link, text, time and like, repost, reply, quote and "
        + 'impression counts. Replies and reposts can be left out. Pass nextCursor back as cursor for older posts.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'integer', minimum: 5, maximum: 100, default: 10, description: 'Posts per page, 5 to 100 (default 10).' },
          exclude: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['replies', 'retweets'] }, description: 'Leave out replies, reposts (retweets), or both.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { max_results: number; exclude?: string[]; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const userId = typeof state?.['u'] === 'string' ? state['u'] : await myUserId(h);
        const token = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const max = typeof state?.['n'] === 'number' ? state['n'] : args.max_results;
        const exclude = typeof state?.['x'] === 'string' ? state['x'] : (args.exclude ?? []).join(',');
        const { data } = await h.api({
          path: `/2/users/${userId}/tweets`,
          query: {
            max_results: max,
            pagination_token: token,
            exclude: exclude || undefined,
            'tweet.fields': TWEET_FIELDS,
            expansions: 'attachments.media_keys',
            'media.fields': 'type,url,preview_image_url,alt_text,duration_ms',
          },
        });
        const mediaByKey = new Map<string, any>((Array.isArray(data?.includes?.media) ? data.includes.media : []).map((media: any) => [String(media?.media_key), media]));
        const posts: unknown[] = Array.isArray(data?.data) ? data.data : [];
        const here = (offset: number) => h.makeCursor({ u: userId, ...(token ? { p: token } : {}), o: offset, n: max, x: exclude });
        const next = typeof data?.meta?.next_token === 'string' ? data.meta.next_token : undefined;
        return h.page({
          key: 'posts',
          items: posts.map((post) => trimPost(post, mediaByKey)).slice(skip),
          extra: { userId },
          resumeAt: (index) => here(skip + index),
          ...(next ? { nextPage: h.makeCursor({ u: userId, p: next, o: 0, n: max, x: exclude }) } : {}),
        });
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Get an X post',
      description: 'Returns one X post by its id: link, text, time, counts, the post it replies to or quotes, and its media.',
      inputSchema: {
        type: 'object',
        properties: { post_id: { type: 'string', pattern: ID, description: 'The post id, the number at the end of its link.' } },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { post_id: string }, h) {
        const { data } = await h.api({
          path: `/2/tweets/${args.post_id}`,
          query: { 'tweet.fields': TWEET_FIELDS, expansions: 'attachments.media_keys', 'media.fields': 'type,url,preview_image_url,alt_text,duration_ms,width,height' },
          errors: { 404: 'X found no post with that id' },
        });
        if (!data?.data && Array.isArray(data?.errors) && data.errors.length) {
          throw new ToolFailure(`X found no post with that id: ${truncate(String(data.errors[0]?.detail ?? data.errors[0]?.title ?? 'it may be deleted or private'), 200)}.`);
        }
        const mediaByKey = new Map<string, any>((Array.isArray(data?.includes?.media) ? data.includes.media : []).map((media: any) => [String(media?.media_key), media]));
        return trimPost(data?.data, mediaByKey);
      },
    },
    {
      name: 'upload_media',
      kind: 'create',
      check: 'get_media_status',
      title: 'Upload media to X',
      description:
        'Uploads one image, GIF or video from a public https URL to X with the chunked upload and returns its media_id for create_post '
        + 'or create_thread (media_ids). JPEG, PNG or WebP up to 5 MB, GIF up to 15 MB, MP4 or MOV video up to 512 MB. Waits for X to '
        + 'process a GIF or video. Nothing is posted; an unused upload expires after a day.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { ...HTTPS_URL, description: 'A public https URL of the image, GIF or video.' },
          alt_text: { type: 'string', maxLength: 1000, description: 'Alt text describing it, up to 1,000 characters.' },
          wait_seconds: WAIT_SCHEMA,
        },
        required: ['url'],
        additionalProperties: false,
      },
      async run(args: { url: string; alt_text?: string; wait_seconds: number }, h) {
        const file = await uploadMedia(h, args.url, 'media', args.wait_seconds, args.alt_text);
        return compact({
          ...file,
          ready: file.state === 'succeeded',
          note: file.state === 'succeeded' ? undefined : 'X is still processing it: check get_media_status before posting with it.',
        });
      },
    },
    {
      name: 'get_media_status',
      kind: 'read',
      title: 'Get an X media upload\'s status',
      description: 'Returns the processing state of an upload by its media_id: pending, in_progress, succeeded or failed, with progress and when to check again.',
      inputSchema: {
        type: 'object',
        properties: { media_id: { type: 'string', pattern: ID, description: 'The media_id upload_media returned.' } },
        required: ['media_id'],
        additionalProperties: false,
      },
      async run(args: { media_id: string }, h) {
        const { data } = await h.api({ path: '/2/media/upload', query: { command: 'STATUS', media_id: args.media_id }, errors: { 403: MEDIA_REFUSED } });
        const media = data?.data ?? {};
        const processing: Processing = media.processing_info ?? { state: 'succeeded' };
        return compact({
          mediaId: media.id ?? args.media_id,
          mediaKey: media.media_key,
          state: processing.state,
          ready: processing.state === 'succeeded',
          progressPercent: processing.progress_percent,
          checkAfterSecs: processing.check_after_secs,
          error: processing.error ? truncate(String(processing.error.message ?? processing.error.name ?? 'failed'), 200) : undefined,
          expiresAfterSecs: media.expires_after_secs,
        });
      },
    },
    {
      name: 'create_post',
      kind: 'create',
      check: 'list_my_posts',
      title: 'Publish an X post',
      description:
        'Publishes a post on X right away: text, up to 4 images or one GIF or video (from public https URLs, uploaded first, or media_ids), '
        + 'or a poll; optionally as a reply to a post, quoting a post, with reply settings and AI or paid-partnership labels. '
        + 'Returns the post id and link. It is sent once, never retried; X refuses a duplicate of a recent post.',
      inputSchema: {
        type: 'object',
        properties: {
          text: TEXT_SCHEMA,
          ...MEDIA_PROPERTIES,
          reply_to_post_id: { type: 'string', pattern: ID, description: 'Post as a reply to this post.' },
          quote_post_id: { type: 'string', pattern: ID, description: 'Quote this post.' },
          poll: {
            type: 'object',
            description: 'A poll instead of media: 2 to 4 options of up to 25 characters, open 5 to 10,080 minutes.',
            properties: {
              options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 25 } },
              duration_minutes: { type: 'integer', minimum: 5, maximum: 10080 },
            },
            required: ['options', 'duration_minutes'],
            additionalProperties: false,
          },
          reply_settings: { type: 'string', enum: ['following', 'mentionedUsers', 'subscribers', 'verified'], description: 'Who may reply (default everyone).' },
          made_with_ai: { type: 'boolean', description: 'true labels the media as made with AI.' },
          paid_partnership: { type: 'boolean', description: 'true labels the post as a paid partnership.' },
          wait_seconds: WAIT_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const hasMedia = Boolean(args.media_urls?.length || args.media_ids?.length);
        if (!args.text && !hasMedia) throw new ToolFailure('Give text, media, or both. Nothing was posted.');
        if (args.poll && hasMedia) throw new ToolFailure('A post has a poll or media, not both. Nothing was posted.');
        const { ids, uploaded } = await mediaFor(h, args, args.wait_seconds);
        const id = await createPost(h, compact({
          text: args.text || undefined,
          media: ids.length ? { media_ids: ids } : undefined,
          reply: args.reply_to_post_id ? { in_reply_to_tweet_id: args.reply_to_post_id } : undefined,
          quote_tweet_id: args.quote_post_id,
          poll: args.poll,
          reply_settings: args.reply_settings,
          made_with_ai: args.made_with_ai,
          paid_partnership: args.paid_partnership,
        }));
        return compact({
          id,
          url: postUrl(id),
          replyTo: args.reply_to_post_id,
          account: h.credentials['xusername'],
          media: ids.length ? (uploaded.length ? uploaded.map((file) => ({ mediaId: file.mediaId, type: file.type })) : ids.map((mediaId) => ({ mediaId }))) : undefined,
        });
      },
    },
    {
      name: 'create_thread',
      kind: 'create',
      check: 'list_my_posts',
      title: 'Publish an X thread',
      description:
        'Publishes a thread on X: 2 to 25 posts, each with text and up to 4 images or one GIF or video, every post replying to the one '
        + 'before (the first optionally replying to an existing post). All media is uploaded before anything is posted. Posts go out one '
        + 'by one and are never retried: if one fails, the result names the posts already published.',
      inputSchema: {
        type: 'object',
        properties: {
          posts: {
            type: 'array',
            minItems: 2,
            maxItems: 25,
            description: 'The posts, in thread order.',
            items: { type: 'object', properties: { text: TEXT_SCHEMA, ...MEDIA_PROPERTIES }, additionalProperties: false },
          },
          reply_to_post_id: { type: 'string', pattern: ID, description: 'Start the thread as a reply to this post.' },
          wait_seconds: WAIT_SCHEMA,
        },
        required: ['posts'],
        additionalProperties: false,
      },
      async run(args: { posts: ThreadPost[]; reply_to_post_id?: string; wait_seconds: number }, h) {
        args.posts.forEach((post, index) => {
          if (!post.text && !post.media_urls?.length && !post.media_ids?.length) {
            throw new ToolFailure(`Post ${index + 1} has no text and no media. Nothing was posted.`);
          }
        });
        const media: string[][] = [];
        for (const [index, post] of args.posts.entries()) {
          media.push((await mediaFor(h, post, args.wait_seconds, `post ${index + 1}`)).ids);
        }

        const posted: Array<{ id: string; url: string }> = [];
        let previous = args.reply_to_post_id;
        for (const [index, post] of args.posts.entries()) {
          const ids = media[index] ?? [];
          let id: string;
          try {
            id = await createPost(h, compact({
              text: post.text || undefined,
              media: ids.length ? { media_ids: ids } : undefined,
              reply: previous ? { in_reply_to_tweet_id: previous } : undefined,
            }));
          } catch (error) {
            if (!posted.length) throw error;
            const done = `Posts 1 to ${posted.length} of ${args.posts.length} were published (${posted.map((item) => item.id).join(', ')}).`;
            if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${done} For post ${index + 1}: ${error.message}`);
            if (error instanceof ToolFailure) {
              throw new ToolFailure(`${done} Post ${index + 1} was not: ${error.message.replace(/ Nothing was changed\.$/, '')} The rest were not sent.`, error.details);
            }
            throw error;
          }
          posted.push({ id, url: postUrl(id) });
          previous = id;
        }
        return { posts: posted, url: posted[0]?.url, count: posted.length, replyTo: args.reply_to_post_id };
      },
    },
    {
      name: 'delete_post',
      kind: 'delete',
      check: 'get_post',
      title: 'Delete an X post',
      description: 'Deletes one of the connected account\'s posts by its id, for good.',
      inputSchema: {
        type: 'object',
        properties: { post_id: { type: 'string', pattern: ID, description: 'The id of the post to delete.' } },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { post_id: string }, h) {
        const { data } = await h.api({
          method: 'DELETE',
          path: `/2/tweets/${args.post_id}`,
          write: true,
          errors: { 403: 'X refused to delete the post: only the connected account\'s own posts can be deleted', 404: 'X found no post with that id' },
        });
        return { deleted: data?.data?.deleted === true, id: args.post_id };
      },
    },
    ...apiTools({
      label: 'X',
      description:
        'The X API v2 at https://api.x.com/2, with the connected account\'s token: paths start with /2/, such as /2/users/me, '
        + '/2/tweets/search/recent (query in query) or /2/users/{id}/liking_tweets. What a call may do depends on the permissions the '
        + 'account granted and the app\'s X API plan. Reference: https://docs.x.com/x-api.',
      basePath: '/2/',
      methods: ['POST', 'PUT', 'DELETE'],
    }),
  ],
});

export = connector;
