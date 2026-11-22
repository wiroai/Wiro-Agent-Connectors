// Bluesky, through the AT Protocol on https://bsky.social (the entry point of
// every account Bluesky hosts; accounts on other servers are not supported).
//
// Credentials: `handle`, the account's handle (e.g. alice.bsky.social) or DID,
// and `apppassword`, an app password from Bluesky's Settings -> Privacy and
// security -> App passwords (never the account password). They open a session
// through com.atproto.server.createSession; see session.ts.

import { apiTools, defineConnector, formatNumber, ToolFailure, truncate, utf8Length, type ApiToolRequest, type ToolHelpers } from '../../core/index.js';
import { imageSize, sniffImage, type ImageType, type Size } from './image.js';
import { parsePostRef, postUri, readPageCard, type PostRef } from './links.js';
import { buildFacets, graphemeLength, MAX_GRAPHEMES, MAX_TEXT_BYTES } from './richtext.js';
import { withSession, xrpc, type Session } from './session.js';

const MAX_IMAGE_BYTES = 2_000_000;
const MAX_THUMB_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_IMAGES = 4;
const MAX_GET_POSTS = 25;
const ACTOR_PATTERN = '^(did:[a-z]+:[A-Za-z0-9._:%-]+|@?[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z][A-Za-z0-9-]*)$';
const POST_REF_DESCRIPTION = 'A post\'s bsky.app link (https://bsky.app/profile/<handle>/post/<id>) or its at:// URI.';
const FILTERS = ['posts_no_replies', 'posts_with_replies', 'posts_and_author_threads', 'posts_with_media'] as const;

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

function trimPost(post: any, fallbackHandle: string, withAuthor = false): Record<string, unknown> {
  const author = post?.author?.handle ?? post?.author?.did;
  return compact({
    uri: post?.uri,
    cid: post?.cid,
    url: postUrl(author ?? fallbackHandle, post?.uri),
    author: withAuthor ? author : undefined,
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

interface ImageArg {
  url: string;
  alt: string;
}

interface LinkCardArg {
  url: string;
  title?: string;
  description?: string;
  thumb_url?: string;
}

interface PostArgs {
  text?: string;
  langs?: string[];
  images?: ImageArg[];
  image_url?: string;
  image_alt?: string;
  link_card?: LinkCardArg;
  reply_to?: string;
}

interface Picture {
  bytes: Uint8Array;
  type: ImageType;
  size?: Size;
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

/** The DID behind a post reference's actor (a handle is resolved). */
async function didOf(h: ToolHelpers, ref: PostRef): Promise<string> {
  if (ref.actor.startsWith('did:')) return ref.actor;
  const did = await resolver(h, ref.actor);
  if (!did) throw new ToolFailure(`Bluesky found no account with the handle ${ref.actor}.`);
  return did;
}

function postRef(value: string, argument: string): PostRef {
  const ref = parsePostRef(value);
  if (!ref) {
    throw new ToolFailure(`${argument} is not a Bluesky post: use its bsky.app link (https://bsky.app/profile/<handle>/post/<id>) or its at:// URI. Nothing was sent.`);
  }
  return ref;
}

async function downloadPicture(h: ToolHelpers, url: string, what: string, maxBytes: number): Promise<Picture> {
  const { bytes } = await h.media(url, { what, maxBytes, accept: 'image/jpeg,image/png,image/webp' });
  const type = sniffImage(bytes);
  if (!type) throw new ToolFailure(`The ${what} URL did not return a JPEG, PNG or WebP image. Nothing was changed.`);
  const size = imageSize(bytes, type);
  return { bytes, type, ...(size ? { size } : {}) };
}

async function uploadBlob(h: ToolHelpers, session: Session, picture: Picture): Promise<unknown> {
  const { data } = await xrpc(h, session, {
    method: 'POST',
    path: '/xrpc/com.atproto.repo.uploadBlob',
    body: picture.bytes,
    contentType: picture.type,
  });
  if (!data?.blob) throw new ToolFailure('Bluesky accepted an image upload but sent back no blob. Nothing was posted.');
  return data.blob;
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
  credentials: ['handle', 'apppassword'],
  credentialLabels: { handle: 'Bluesky handle', apppassword: 'Bluesky app password' },
  normalizeCredentials: (credentials) => {
    const handle = (credentials['handle'] ?? '').replace(/^@/, '');
    return { ...credentials, handle: handle.startsWith('did:') ? handle : handle.toLowerCase() };
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
        + 'with each post\'s URL, text, time, and like, repost, reply and quote counts. filter picks posts without replies (default), '
        + 'with replies, with the account\'s own threads, or with media only. Pass nextCursor back as cursor for older posts.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Posts to fetch, 1 to 100 (default 25).' },
          filter: {
            type: 'string',
            enum: [...FILTERS],
            description: 'posts_no_replies (default), posts_with_replies, posts_and_author_threads (posts and the account\'s own threads) or posts_with_media.',
          },
          include_replies: { type: 'boolean', default: false, description: 'The same as filter posts_with_replies (default false).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; filter?: (typeof FILTERS)[number]; include_replies: boolean; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const vendorCursor = typeof state?.['c'] === 'string' ? state['c'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
        // An explicit filter (or include_replies: true) wins over the one a cursor carries.
        const filter = args.filter ?? (args.include_replies ? 'posts_with_replies' : (typeof state?.['f'] === 'string' ? state['f'] : 'posts_no_replies'));
        return withSession(h, true, async (session) => {
          const { data } = await xrpc(h, session, {
            path: '/xrpc/app.bsky.feed.getAuthorFeed',
            query: { actor: session.did, limit, filter, cursor: vendorCursor },
          });
          const feed: any[] = Array.isArray(data?.feed) ? data.feed : [];
          const posts = feed
            .filter((item) => !item?.reason && item?.post?.author?.did === session.did)
            .map((item) => trimPost(item.post, session.handle))
            .slice(skip);
          const here = (offset: number) => h.makeCursor({ ...(vendorCursor ? { c: vendorCursor } : {}), o: offset, n: limit, f: filter });
          return h.page({
            key: 'posts',
            items: posts,
            extra: { handle: session.handle },
            resumeAt: (index) => here(skip + index),
            ...(typeof data?.cursor === 'string' && data.cursor ? { nextPage: h.makeCursor({ c: data.cursor, o: 0, n: limit, f: filter }) } : {}),
          });
        });
      },
    },
    {
      name: 'get_posts',
      kind: 'read',
      title: 'Get Bluesky posts by link',
      description:
        'Returns up to 25 posts, the account\'s own or anyone\'s, by their bsky.app links or at:// URIs: author, text, time, and like, '
        + 'repost, reply and quote counts. Use it to check how known posts are doing, or whether a post went out.',
      inputSchema: {
        type: 'object',
        properties: {
          posts: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_GET_POSTS,
            uniqueItems: true,
            items: { type: 'string', minLength: 10, maxLength: 600, description: POST_REF_DESCRIPTION },
            description: 'Up to 25 post links or at:// URIs.',
          },
          cursor: { type: 'string', description: 'nextCursor from the previous result, with the same posts.' },
        },
        required: ['posts'],
        additionalProperties: false,
      },
      async run(args: { posts: string[]; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const refs = args.posts.map((value, index) => postRef(value, `posts[${index}]`));
        return withSession(h, true, async (session) => {
          const dids = new Map<string, string>([[session.handle, session.did]]);
          const uris: string[] = [];
          for (const ref of refs) {
            let did = ref.actor.startsWith('did:') ? ref.actor : dids.get(ref.actor);
            if (!did) {
              did = await didOf(h, ref);
              dids.set(ref.actor, did);
            }
            uris.push(postUri(did, ref.rkey));
          }
          const { data } = await xrpc(h, session, { path: '/xrpc/app.bsky.feed.getPosts', query: { uris } });
          const posts: any[] = Array.isArray(data?.posts) ? data.posts : [];
          const found = new Set(posts.map((post) => post?.uri));
          const missing = uris.filter((uri) => !found.has(uri));
          return h.page({
            key: 'posts',
            items: posts.map((post) => trimPost(post, session.handle, true)).slice(skip),
            extra: missing.length ? { notFound: missing } : {},
            resumeAt: (index) => h.makeCursor({ o: skip + index }),
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
        + 'with links, @handles and #hashtags made clickable; up to 4 images from public https URLs (JPEG, PNG or WebP, up to '
        + `${formatNumber(MAX_IMAGE_BYTES)} bytes each) with alt text, or one link card (title, description and picture from the page). `
        + 'reply_to makes it a reply, or the next post of a thread: pass the post above it. Returns the post\'s URL. Bluesky has no edits '
        + 'and no scheduling.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 3000, description: 'The post text, up to 300 characters. May be empty only with images or a link card.' },
          langs: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$' },
            maxItems: 3,
            uniqueItems: true,
            description: 'Up to 3 language codes of the text, e.g. ["en"].',
          },
          images: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_IMAGES,
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of the image.' },
                alt: { type: 'string', minLength: 1, maxLength: 2000, description: 'Alt text: what the image shows, for people who cannot see it.' },
              },
              required: ['url', 'alt'],
              additionalProperties: false,
            },
            description: 'Up to 4 images, in order, each with alt text.',
          },
          image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'One image to attach (the same as images with one item).' },
          image_alt: { type: 'string', maxLength: 2000, description: 'Alt text for image_url; required with it.' },
          link_card: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri', maxLength: 2000, description: 'The page the card opens.' },
              title: { type: 'string', maxLength: 300, description: 'The card title. Left out, it comes from the page itself.' },
              description: { type: 'string', maxLength: 1000, description: 'The card text. Left out, it comes from the page itself.' },
              thumb_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A picture for the card (up to 1,000,000 bytes). Left out, the page\'s own picture is used when the page is read.' },
            },
            required: ['url'],
            additionalProperties: false,
            description: 'A link card under the text, only on a post without images.',
          },
          reply_to: { type: 'string', minLength: 10, maxLength: 600, description: `The post this one answers: ${POST_REF_DESCRIPTION}` },
        },
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const text = args.text ?? '';
        const graphemes = graphemeLength(text);
        if (graphemes > MAX_GRAPHEMES || utf8Length(text) > MAX_TEXT_BYTES) {
          throw new ToolFailure(`The text has ${graphemes} characters; Bluesky allows ${MAX_GRAPHEMES} (and ${formatNumber(MAX_TEXT_BYTES)} bytes). Shorten it. Nothing was changed.`);
        }
        if (args.image_url && args.image_alt === undefined) {
          throw new ToolFailure('image_alt is required with image_url: describe the image for people who cannot see it. Nothing was changed.');
        }
        if (!args.image_url && args.image_alt !== undefined) throw new ToolFailure('image_alt was given without image_url. Nothing was changed.');
        if (args.image_url && args.images) throw new ToolFailure('Give images or image_url, not both. Nothing was changed.');
        const images: ImageArg[] = args.images ?? (args.image_url ? [{ url: args.image_url, alt: args.image_alt ?? '' }] : []);
        if (images.length && args.link_card) {
          throw new ToolFailure('A Bluesky post has images or a link card, not both: leave out link_card (a link in the text stays clickable). Nothing was changed.');
        }
        if (!text.trim() && !images.length && !args.link_card) throw new ToolFailure('The post needs text, images or a link card. Nothing was changed.');
        const replyRef = args.reply_to !== undefined ? postRef(args.reply_to, 'reply_to') : undefined;

        // Images and the link card are fetched and checked before signing in, so a bad URL costs no sign-in.
        const pictures: Picture[] = [];
        for (const [index, image] of images.entries()) {
          pictures.push(await downloadPicture(h, image.url, images.length > 1 ? `image ${index + 1}` : 'image', MAX_IMAGE_BYTES));
        }
        let card: { uri: string; title: string; description: string; thumb?: Picture; thumbNote?: string } | undefined;
        if (args.link_card) {
          const { url } = args.link_card;
          if (!/^https?:\/\//i.test(url)) throw new ToolFailure('link_card.url must be an http or https address. Nothing was changed.');
          let title = args.link_card.title;
          let description = args.link_card.description;
          let thumbUrl = args.link_card.thumb_url;
          if (title === undefined) {
            if (!/^https:\/\//i.test(url)) throw new ToolFailure('The link card page is not https, so it is not read: give link_card.title and description. Nothing was changed.');
            let page;
            try {
              page = readPageCard((await h.media(url, { what: 'link card page', maxBytes: MAX_PAGE_BYTES, accept: 'text/html' })).bytes, url);
            } catch (error) {
              if (!(error instanceof ToolFailure)) throw error;
              throw new ToolFailure(
                `${error.message.replace(/ Nothing was changed\.$/, '')} Give link_card.title and link_card.description, or leave link_card out `
                  + '(a link in the text stays clickable). Nothing was changed.',
              );
            }
            if (!page.title) {
              throw new ToolFailure('The link card page names no title: give link_card.title and link_card.description, or leave link_card out. Nothing was changed.');
            }
            title = page.title;
            description = description ?? page.description;
            thumbUrl = thumbUrl ?? page.image;
          }
          card = { uri: url, title, description: description ?? '' };
          if (thumbUrl) {
            try {
              card.thumb = await downloadPicture(h, thumbUrl, 'link card picture', MAX_THUMB_BYTES);
            } catch (error) {
              // The page's own picture is optional: the card goes out without it.
              if (args.link_card.thumb_url || !(error instanceof ToolFailure)) throw error;
              card.thumbNote = 'The page\'s picture could not be used, so the card has none.';
            }
          }
        }

        return withSession(h, false, async (session) => {
          let reply: Record<string, unknown> | undefined;
          if (replyRef) {
            const did = replyRef.actor === session.handle ? session.did : await didOf(h, replyRef);
            const uri = postUri(did, replyRef.rkey);
            const { data } = await xrpc(h, session, { path: '/xrpc/app.bsky.feed.getPosts', query: { uris: [uri] } });
            const parent = Array.isArray(data?.posts) ? data.posts[0] : undefined;
            if (typeof parent?.uri !== 'string' || typeof parent?.cid !== 'string') {
              throw new ToolFailure('Bluesky found no post at reply_to (it may have been deleted). Nothing was posted.');
            }
            const root = parent.record?.reply?.root;
            reply = {
              root: typeof root?.uri === 'string' && typeof root?.cid === 'string' ? { uri: root.uri, cid: root.cid } : { uri: parent.uri, cid: parent.cid },
              parent: { uri: parent.uri, cid: parent.cid },
            };
          }

          let embed: Record<string, unknown> | undefined;
          if (pictures.length) {
            const uploaded = [];
            for (const [index, picture] of pictures.entries()) {
              const blob = await uploadBlob(h, session, picture);
              uploaded.push({ alt: images[index]?.alt ?? '', image: blob, ...(picture.size ? { aspectRatio: picture.size } : {}) });
            }
            embed = { $type: 'app.bsky.embed.images', images: uploaded };
          } else if (card) {
            const thumb = card.thumb ? await uploadBlob(h, session, card.thumb) : undefined;
            embed = { $type: 'app.bsky.embed.external', external: compact({ uri: card.uri, title: card.title, description: card.description, thumb }) };
          }

          const facets = await buildFacets(text, (handle) => resolver(h, handle));
          const createdAt = new Date().toISOString();
          const record = compact({
            $type: 'app.bsky.feed.post',
            text,
            createdAt,
            langs: args.langs,
            facets: facets.facets.length ? facets.facets : undefined,
            embed,
            reply,
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
            replyTo: reply ? (reply['parent'] as { uri: string }).uri : undefined,
            images: pictures.length
              ? pictures.map((picture) => compact({ type: picture.type, bytes: picture.bytes.length, width: picture.size?.width, height: picture.size?.height }))
              : undefined,
            linkCard: card ? compact({ url: card.uri, title: card.title, picture: card.thumb ? true : undefined, note: card.thumbNote }) : undefined,
          });
        });
      },
    },
    {
      name: 'delete_post',
      kind: 'delete',
      check: 'list_my_posts',
      title: 'Delete a Bluesky post',
      description:
        "Deletes one of the connected account's own posts, by its bsky.app link or at:// URI. It cannot be undone, and the post's "
        + 'replies stay. Other accounts\' posts are refused before anything is sent.',
      inputSchema: {
        type: 'object',
        properties: {
          post: { type: 'string', minLength: 10, maxLength: 600, description: POST_REF_DESCRIPTION },
        },
        required: ['post'],
        additionalProperties: false,
      },
      async run(args: { post: string }, h) {
        const ref = postRef(args.post, 'post');
        return withSession(h, false, async (session) => {
          const did = ref.actor === session.handle ? session.did : await didOf(h, ref);
          if (did !== session.did) {
            throw new ToolFailure(`Only the connected account's own posts can be deleted, and this post belongs to ${ref.actor}. Nothing was sent.`);
          }
          await xrpc(h, session, {
            method: 'POST',
            path: '/xrpc/com.atproto.repo.deleteRecord',
            json: { repo: session.did, collection: 'app.bsky.feed.post', rkey: ref.rkey },
            write: true,
          });
          return { deleted: true, uri: postUri(session.did, ref.rkey) };
        });
      },
    },
    // Any other XRPC method, with the account's session: a read may sign in
    // again once after the session expired, a procedure never runs twice.
    ...apiTools({
      label: 'Bluesky',
      description:
        "The Bluesky (AT Protocol) XRPC API on https://bsky.social, with the connected account's session: a path is /xrpc/ and a method id. "
        + 'Queries are GET with their parameters in query, such as /xrpc/app.bsky.feed.getTimeline, /xrpc/app.bsky.feed.getPostThread '
        + '(a post\'s replies) or /xrpc/app.bsky.notification.listNotifications; procedures are POST with a JSON body, such as '
        + '/xrpc/com.atproto.repo.createRecord for a like or a repost. Reference: https://docs.bsky.app.',
      basePath: '/xrpc/',
      methods: ['POST'],
      guard: accountMethodGuard,
      send: (request, h) => withSession(h, !request.write, (session) => xrpc(h, session, request)),
    }),
  ],
});

export = connector;
