// Bluesky, through the AT Protocol on https://bsky.social (the entry point of
// every account Bluesky hosts; accounts on other servers are not supported).
//
// Credentials: `identifier`, the account's handle (e.g. alice.bsky.social) or
// DID, and `app_password`, an app password from Bluesky's Settings -> Privacy
// and security -> App passwords (never the account password). They open a
// session through com.atproto.server.createSession; see session.ts.

import { apiTools, defineConnector, formatNumber, ToolFailure, truncate, utf8Length, type ApiToolRequest, type ToolHelpers } from '../../core/index.js';
import { imageSize, sniffImage } from './image.js';
import { buildFacets, graphemeLength, MAX_GRAPHEMES, MAX_TEXT_BYTES } from './richtext.js';
import { withSession, xrpc, type Session } from './session.js';

const MAX_IMAGE_BYTES = 2_000_000;
const ACTOR_PATTERN = '^(did:[a-z]+:[A-Za-z0-9._:%-]+|@?[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z][A-Za-z0-9-]*)$';

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function profileUrl(actor: string): string {
  return `https://bsky.app/profile/${encodeURIComponent(actor)}`;
}

/** https://bsky.app/profile/<handle>/post/<rkey> for at://<did>/app.bsky.feed.post/<rkey>. */
function postUrl(handleOrDid: string, uri: unknown): string | undefined {
  const match = typeof uri === 'string' ? /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri) : null;
  return match ? `${profileUrl(handleOrDid)}/post/${match[1]}` : undefined;
}

function trimProfile(profile: any): Record<string, unknown> {
  const handle = typeof profile?.handle === 'string' ? profile.handle : undefined;
  return compact({
    did: profile?.did,
    handle,
    displayName: profile?.displayName || undefined,
    description: typeof profile?.description === 'string' && profile.description ? truncate(profile.description, 600) : undefined,
    avatar: profile?.avatar,
    followersCount: profile?.followersCount,
    followsCount: profile?.followsCount,
    postsCount: profile?.postsCount,
    createdAt: profile?.createdAt,
    url: handle ? profileUrl(handle) : undefined,
  });
}

function embedKind(embed: any): string | undefined {
  const type = typeof embed?.$type === 'string' ? embed.$type : '';
  const match = /^app\.bsky\.embed\.(\w+)/.exec(type);
  return match ? match[1] : undefined;
}

function trimPost(post: any, session: Session): Record<string, unknown> {
  return compact({
    uri: post?.uri,
    cid: post?.cid,
    url: postUrl(post?.author?.handle ?? session.handle, post?.uri),
    text: typeof post?.record?.text === 'string' ? post.record.text : undefined,
    createdAt: post?.record?.createdAt,
    likeCount: post?.likeCount,
    repostCount: post?.repostCount,
    replyCount: post?.replyCount,
    quoteCount: post?.quoteCount,
    isReply: post?.record?.reply ? true : undefined,
    embed: embedKind(post?.embed ?? post?.record?.embed),
  });
}

interface PostArgs {
  text: string;
  langs?: string[];
  image_url?: string;
  image_alt?: string;
}

async function resolver(h: ToolHelpers, handle: string): Promise<string | undefined> {
  try {
    const { data } = await h.api({ path: '/xrpc/com.atproto.identity.resolveHandle', query: { handle } });
    return typeof data?.did === 'string' ? data.did : undefined;
  } catch (error) {
    if (error instanceof ToolFailure) return undefined;
    throw error;
  }
}

/**
 * Account, session and identity methods stay in the Bluesky app: the generic
 * tools never sign in, mint tokens, or change the handle or the account.
 */
function accountMethodGuard(request: ApiToolRequest): void {
  const method = (request.segments[1] ?? '').toLowerCase();
  if (method.startsWith('com.atproto.server.') || (request.method !== 'GET' && method.startsWith('com.atproto.identity.'))) {
    throw new ToolFailure(
      'Bluesky account, session and identity methods (com.atproto.server.* and com.atproto.identity.*) are not available here: '
        + 'manage the account in the Bluesky app. Nothing was sent.',
    );
  }
}

const connector = defineConnector({
  vendor: 'bluesky',
  label: 'Bluesky',
  origins: ['https://bsky.social'],
  credentials: ['identifier', 'app_password'],
  credentialLabels: { identifier: 'Bluesky handle', app_password: 'Bluesky app password' },
  normalizeCredentials: (credentials) => {
    const identifier = (credentials['identifier'] ?? '').replace(/^@/, '');
    return { ...credentials, identifier: identifier.startsWith('did:') ? identifier : identifier.toLowerCase() };
  },
  tools: [
    {
      name: 'get_profile',
      kind: 'read',
      title: 'Get a Bluesky profile',
      description:
        'Returns a Bluesky profile: DID, handle, display name, bio, avatar, and follower, following and post counts. '
        + 'Without actor it returns the connected account.',
      inputSchema: {
        type: 'object',
        properties: {
          actor: {
            type: 'string',
            minLength: 3,
            maxLength: 253,
            pattern: ACTOR_PATTERN,
            description: 'A handle such as alice.bsky.social, or a DID. Leave out for the connected account.',
          },
        },
        additionalProperties: false,
      },
      async run(args: { actor?: string }, h) {
        const { data } = await withSession(h, true, (session) => xrpc(h, session, {
          path: '/xrpc/app.bsky.actor.getProfile',
          query: { actor: args.actor?.replace(/^@/, '') ?? session.did },
          errors: { 400: 'Bluesky found no such profile' },
        }));
        return trimProfile(data);
      },
    },
    {
      name: 'list_my_posts',
      kind: 'read',
      title: 'List my recent Bluesky posts',
      description:
        "Lists the connected account's own recent posts, newest first (reposts of other people's posts are left out), "
        + 'with each post\'s URL, text, time, and like, repost, reply and quote counts. Pass nextCursor back as cursor for older posts.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Posts to fetch, 1 to 100 (default 25).' },
          include_replies: { type: 'boolean', default: false, description: 'Include the account\'s replies to other posts (default false).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; include_replies: boolean; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const vendorCursor = typeof state?.['c'] === 'string' ? state['c'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
        return withSession(h, true, async (session) => {
          const { data } = await xrpc(h, session, {
            path: '/xrpc/app.bsky.feed.getAuthorFeed',
            query: { actor: session.did, limit, filter: args.include_replies ? 'posts_with_replies' : 'posts_no_replies', cursor: vendorCursor },
          });
          const feed: any[] = Array.isArray(data?.feed) ? data.feed : [];
          const posts = feed
            .filter((item) => !item?.reason && item?.post?.author?.did === session.did)
            .map((item) => trimPost(item.post, session))
            .slice(skip);
          const here = (offset: number) => h.makeCursor({ ...(vendorCursor ? { c: vendorCursor } : {}), o: offset, n: limit });
          return h.page({
            key: 'posts',
            items: posts,
            extra: { handle: session.handle },
            resumeAt: (index) => here(skip + index),
            ...(typeof data?.cursor === 'string' && data.cursor ? { nextPage: h.makeCursor({ c: data.cursor, o: 0, n: limit }) } : {}),
          });
        });
      },
    },
    {
      name: 'create_post',
      kind: 'create',
      check: 'list_my_posts',
      title: 'Create a Bluesky post',
      description:
        'Publishes a post on the connected Bluesky account right away: text up to 300 characters (Bluesky counts each emoji as one), '
        + 'with links, @handles and #hashtags made clickable, and optionally one image from a public https URL '
        + `(JPEG, PNG or WebP, up to ${formatNumber(MAX_IMAGE_BYTES)} bytes) with alt text. Returns the post's URL. Bluesky has no edits.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 3000, description: 'The post text, up to 300 characters.' },
          langs: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$' },
            maxItems: 3,
            uniqueItems: true,
            description: 'Up to 3 language codes of the text, e.g. ["en"].',
          },
          image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of one image to attach.' },
          image_alt: { type: 'string', maxLength: 2000, description: 'Alt text describing the image; required with image_url.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const graphemes = graphemeLength(args.text);
        if (graphemes > MAX_GRAPHEMES || utf8Length(args.text) > MAX_TEXT_BYTES) {
          throw new ToolFailure(`The text has ${graphemes} characters; Bluesky allows ${MAX_GRAPHEMES} (and ${formatNumber(MAX_TEXT_BYTES)} bytes). Shorten it. Nothing was changed.`);
        }
        if (args.image_url && args.image_alt === undefined) {
          throw new ToolFailure('image_alt is required with image_url: describe the image for people who cannot see it. Nothing was changed.');
        }
        if (!args.image_url && args.image_alt !== undefined) {
          throw new ToolFailure('image_alt was given without image_url. Nothing was changed.');
        }

        // The image is fetched and checked before signing in, so a bad URL costs no sign-in.
        let image: { bytes: Uint8Array; type: string; size?: { width: number; height: number } } | undefined;
        if (args.image_url) {
          const { bytes } = await h.media(args.image_url, { what: 'image', maxBytes: MAX_IMAGE_BYTES, accept: 'image/jpeg,image/png,image/webp' });
          const type = sniffImage(bytes);
          if (!type) throw new ToolFailure('The image URL did not return a JPEG, PNG or WebP image. Nothing was changed.');
          const size = imageSize(bytes, type);
          image = { bytes, type, ...(size ? { size } : {}) };
        }

        return withSession(h, false, async (session) => {
          let embed: Record<string, unknown> | undefined;
          if (image) {
            const { data } = await xrpc(h, session, {
              method: 'POST',
              path: '/xrpc/com.atproto.repo.uploadBlob',
              body: image.bytes,
              contentType: image.type,
            });
            if (!data?.blob) throw new ToolFailure('Bluesky accepted the image upload but sent back no blob. Nothing was posted.');
            embed = {
              $type: 'app.bsky.embed.images',
              images: [{ alt: args.image_alt ?? '', image: data.blob, ...(image.size ? { aspectRatio: image.size } : {}) }],
            };
          }

          const facets = await buildFacets(args.text, (handle) => resolver(h, handle));
          const createdAt = new Date().toISOString();
          const record = compact({
            $type: 'app.bsky.feed.post',
            text: args.text,
            createdAt,
            langs: args.langs,
            facets: facets.facets.length ? facets.facets : undefined,
            embed,
          });

          const { data } = await xrpc(h, session, {
            method: 'POST',
            path: '/xrpc/com.atproto.repo.createRecord',
            json: { repo: session.did, collection: 'app.bsky.feed.post', record },
            write: true,
          });
          return compact({
            uri: data?.uri,
            cid: data?.cid,
            url: postUrl(session.handle, data?.uri),
            createdAt,
            links: facets.links,
            mentions: facets.mentions,
            hashtags: facets.tags,
            unresolvedMentions: facets.unresolvedMentions.length ? facets.unresolvedMentions : undefined,
            image: image ? compact({ type: image.type, bytes: image.bytes.length, width: image.size?.width, height: image.size?.height }) : undefined,
          });
        });
      },
    },
    // Any other XRPC method, with the account's session: a read may sign in
    // again once after the session expired, a procedure never runs twice.
    ...apiTools({
      label: 'Bluesky',
      description:
        "The Bluesky (AT Protocol) XRPC API on https://bsky.social, with the connected account's session: a path is /xrpc/ and a method id. "
        + 'Queries are GET with their parameters in query, such as /xrpc/app.bsky.feed.getTimeline or /xrpc/app.bsky.notification.listNotifications; '
        + 'procedures are POST with a JSON body, such as /xrpc/com.atproto.repo.deleteRecord. Reference: https://docs.bsky.app.',
      basePath: '/xrpc/',
      methods: ['POST'],
      guard: accountMethodGuard,
      send: (request, h) => withSession(h, !request.write, (session) => xrpc(h, session, request)),
    }),
  ],
});

export = connector;
