// LinkedIn, through the versioned LinkedIn REST API on https://api.linkedin.com
// (Posts and Images APIs) and OpenID Connect's /v2/userinfo.
//
// Credentials:
// - `access_token`: the current OAuth access token of the member who signed
//   in. The host refreshes it; this module never does. Posting as an
//   organization needs the w_organization_social permission and an
//   administrator or content admin role on the Page; posting as the member
//   needs w_member_social; get_profile needs openid and profile.
// - `organizationid` (optional): the numeric id of the LinkedIn Page posts go
//   to, from the Page's admin URL (linkedin.com/company/<id>/admin/).
// - `linkedinname` (optional): the connected member's name, as the host
//   wrote it after the sign-in. Only shown back.
//
// Image uploads go to the address LinkedIn's initializeUpload returns, on
// https://www.linkedin.com (or https://api.linkedin.com), with the same token.

import { apiTools, defineConnector, OutcomeUnknown, ToolFailure, truncate, type ApiRequest, type ToolHelpers } from '../../core/index.js';
import { sniffImage } from './image.js';
import { fromLittle, toLittle } from './little.js';

/** The LinkedIn-Version every /rest/ request names. LinkedIn retires each version about a year after its release. */
const LINKEDIN_VERSION = '202611';
const MAX_TEXT = 3000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const POST_ID = '^urn:li:(share|ugcPost):[0-9]{1,30}$';
const HTTPS_URL = { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000 };

type AuthorKind = 'organization' | 'member';

interface Author {
  kind: AuthorKind;
  urn: string;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

function isoTime(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

/** The organization id from the credential, or a plain reason why there is none. */
function organizationId(h: ToolHelpers): string {
  const id = h.credentials['organizationid'];
  if (!id) {
    throw new ToolFailure(
      'Posting as an organization needs the LinkedIn organization ID (the number in the Page\'s admin URL, linkedin.com/company/<id>/admin/), '
        + 'and none is set for this connection. Set it, or use author: "member". Nothing was sent to LinkedIn.',
    );
  }
  if (!/^[0-9]{1,20}$/.test(id)) {
    throw new ToolFailure(
      'The LinkedIn organization ID must be the number in the Page\'s admin URL (linkedin.com/company/<id>/admin/), such as 12345678. Nothing was sent to LinkedIn.',
    );
  }
  return id;
}

interface UserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: unknown;
  email?: string;
  email_verified?: boolean;
}

async function userInfo(h: ToolHelpers): Promise<UserInfo> {
  const { data } = await h.api({
    path: '/v2/userinfo',
    errors: { 403: 'LinkedIn did not share the member\'s profile: the connection needs the openid and profile permissions' },
  });
  if (typeof data?.sub !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.sub)) {
    throw new ToolFailure('LinkedIn answered without the member\'s id, so the member could not be identified.');
  }
  return data as UserInfo;
}

async function resolveAuthor(h: ToolHelpers, wanted: AuthorKind | undefined): Promise<Author> {
  const kind: AuthorKind = wanted ?? (h.credentials['organizationid'] ? 'organization' : 'member');
  if (kind === 'organization') return { kind, urn: `urn:li:organization:${organizationId(h)}` };
  const me = await userInfo(h);
  return { kind, urn: `urn:li:person:${me.sub}` };
}

function refusedPost(kind: AuthorKind): string {
  return kind === 'organization'
    ? 'LinkedIn refused to post for the organization: the connection needs the w_organization_social permission, and the member an administrator or content admin role on that Page'
    : 'LinkedIn refused to post for the member: the connection needs the w_member_social permission (the Share on LinkedIn product)';
}

function contentKind(content: any): string {
  if (!content || typeof content !== 'object') return 'text';
  if (content.multiImage) return 'images';
  if (content.article) return 'article';
  if (content.poll) return 'poll';
  if (content.media) {
    const id = typeof content.media.id === 'string' ? content.media.id : '';
    return id.startsWith('urn:li:video:') ? 'video' : id.startsWith('urn:li:document:') ? 'document' : 'image';
  }
  return Object.keys(content)[0] ?? 'text';
}

function trimPost(post: any): Record<string, unknown> {
  const id = typeof post?.id === 'string' ? post.id : undefined;
  const article = post?.content?.article;
  const images = post?.content?.multiImage?.images;
  return compact({
    id,
    url: id ? postUrl(id) : undefined,
    author: post?.author,
    text: typeof post?.commentary === 'string' && post.commentary ? truncate(fromLittle(post.commentary), 1000) : undefined,
    content: contentKind(post?.content),
    images: Array.isArray(images) ? images.length : undefined,
    article: article ? compact({ url: article.source, title: article.title, description: typeof article.description === 'string' ? truncate(article.description, 300) : undefined }) : undefined,
    reshareOf: post?.reshareContext?.parent,
    visibility: post?.visibility,
    state: post?.lifecycleState,
    edited: post?.lifecycleStateInfo?.isEditedByAuthor === true ? true : undefined,
    createdAt: isoTime(post?.createdAt),
    publishedAt: isoTime(post?.publishedAt),
    lastModifiedAt: isoTime(post?.lastModifiedAt),
  });
}

/**
 * Uploads one image from a public https URL through LinkedIn's Images API and
 * returns its urn:li:image URN. LinkedIn takes JPEG, PNG and GIF.
 */
async function uploadImage(h: ToolHelpers, author: Author, url: string, what: string): Promise<string> {
  const { bytes } = await h.media(url, { what, maxBytes: MAX_IMAGE_BYTES, accept: 'image/jpeg,image/png,image/gif' });
  const type = sniffImage(bytes);
  if (type === 'image/webp') throw new ToolFailure(`The ${what} is a WebP image, which LinkedIn does not take: use a JPEG, PNG or GIF. Nothing was posted.`);
  if (!type) throw new ToolFailure(`The ${what} URL did not return a JPEG, PNG or GIF image. Nothing was posted.`);

  const { data } = await h.api({
    method: 'POST',
    path: '/rest/images',
    query: { action: 'initializeUpload' },
    json: { initializeUploadRequest: { owner: author.urn } },
    errors: { 403: refusedPost(author.kind) },
  });
  const uploadUrl = data?.value?.uploadUrl;
  const image = data?.value?.image;
  if (typeof uploadUrl !== 'string' || typeof image !== 'string' || !image.startsWith('urn:li:image:')) {
    throw new ToolFailure(`LinkedIn did not return an upload address for the ${what}. Nothing was posted.`);
  }
  let target: URL;
  try {
    target = new URL(uploadUrl);
  } catch {
    throw new ToolFailure(`LinkedIn returned an upload address for the ${what} that is not a valid URL. Nothing was posted.`);
  }
  if (!h.origins.includes(target.origin)) {
    throw new ToolFailure(`LinkedIn asked for the ${what} to be uploaded to ${target.host}, an address this connector does not send files to. Nothing was posted.`);
  }
  await h.api({ method: 'PUT', origin: target.origin, path: `${target.pathname}${target.search}`, body: bytes, contentType: type });
  return image;
}

interface ImageArg {
  url: string;
  alt_text?: string;
}

interface PostArgs {
  text: string;
  author?: AuthorKind;
  images?: ImageArg[];
  image_title?: string;
  article?: { url: string; title: string; description?: string; thumbnail_url?: string };
  visibility: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';
  disable_reshare: boolean;
}

const AUTHOR_SCHEMA = {
  type: 'string' as const,
  enum: ['organization', 'member'],
  description:
    'organization posts as the LinkedIn Page of the connection\'s organization ID; member posts as the member who signed in, which '
    + 'needs the w_member_social permission (a connection may have only the Page permissions). Default: organization when an '
    + 'organization ID is set, otherwise member.',
};

/** Where to look for a member's own posts: LinkedIn shows them to an app only with r_member_social, which it grants to few. */
const MEMBER_POSTS_WHERE = 'look at the Activity section of the member\'s LinkedIn profile';

/** The start of the next page, from the "next" link LinkedIn sends with a page. */
function nextLinkStart(links: unknown[]): number | undefined {
  const next = links.find((link) => (link as { rel?: unknown } | null)?.rel === 'next') as { href?: unknown } | undefined;
  if (typeof next?.href !== 'string') return undefined;
  try {
    const value = new URL(next.href, 'https://api.linkedin.com').searchParams.get('start');
    const start = Number(value);
    return value !== null && value !== '' && Number.isSafeInteger(start) && start >= 0 ? start : undefined;
  } catch {
    return undefined;
  }
}

/** LinkedIn's Rest.li methods for the generic tools: PATCH becomes a partial update, DELETE names itself. */
function restliRequest(request: ApiRequest): ApiRequest {
  if (request.method === 'PATCH') return { ...request, method: 'POST', headers: { ...request.headers, 'x-restli-method': 'PARTIAL_UPDATE' } };
  if (request.method === 'DELETE') return { ...request, headers: { ...request.headers, 'x-restli-method': 'DELETE' } };
  return request;
}

const connector = defineConnector({
  vendor: 'linkedin',
  label: 'LinkedIn',
  origins: ['https://api.linkedin.com', 'https://www.linkedin.com'],
  credentials: ['access_token', 'organizationid', 'linkedinname'],
  requiredCredentials: [['access_token']],
  credentialLabels: {
    access_token: 'LinkedIn access token',
    organizationid: 'LinkedIn organization ID',
    linkedinname: 'LinkedIn account name',
  },
  normalizeCredentials: (credentials) => {
    const raw = credentials['organizationid'];
    if (raw) {
      const match = /^(?:urn:li:organization:)?([0-9]+)$/.exec(raw) ?? /linkedin\.com\/company\/([0-9]+)/.exec(raw);
      if (match) credentials['organizationid'] = match[1] as string;
    }
    return credentials;
  },
  authHeaders: (credentials) => ({
    authorization: `Bearer ${credentials['access_token']}`,
    'linkedin-version': LINKEDIN_VERSION,
    'x-restli-protocol-version': '2.0.0',
  }),
  tools: [
    {
      name: 'get_profile',
      kind: 'read',
      title: 'Get the connected LinkedIn member',
      description:
        'Returns the member who signed in to LinkedIn: id, person URN (urn:li:person:...), name, photo and locale, '
        + 'plus the organization (Page) this connection posts for, when an organization ID is set.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const me = await userInfo(h);
        const organization = h.credentials['organizationid'];
        const locale = typeof me.locale === 'string'
          ? me.locale
          : me.locale && typeof me.locale === 'object'
            ? [(me.locale as { language?: string }).language, (me.locale as { country?: string }).country].filter(Boolean).join('_') || undefined
            : undefined;
        return compact({
          id: me.sub,
          personUrn: `urn:li:person:${me.sub}`,
          name: me.name ?? h.credentials['linkedinname'],
          givenName: me.given_name,
          familyName: me.family_name,
          picture: me.picture,
          locale,
          email: me.email,
          organization: organization
            ? compact({ id: organization, urn: /^[0-9]+$/.test(organization) ? `urn:li:organization:${organization}` : undefined, url: /^[0-9]+$/.test(organization) ? `https://www.linkedin.com/company/${organization}/` : undefined })
            : undefined,
        });
      },
    },
    {
      name: 'list_posts',
      kind: 'read',
      title: 'List LinkedIn posts',
      description:
        "Lists the posts of the connection's organization (Page), newest first, with each post's URN, link, text, content type, "
        + 'visibility and times. author: member lists the member\'s own posts instead, which LinkedIn allows only to apps it approved '
        + 'for r_member_social. A page can hold fewer posts than count while more follow: pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          author: AUTHOR_SCHEMA,
          count: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Posts per page, 1 to 100 (default 10).' },
          sort_by: { type: 'string', enum: ['LAST_MODIFIED', 'CREATED'], default: 'LAST_MODIFIED', description: 'LAST_MODIFIED (default) or CREATED, newest first.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { author?: AuthorKind; count: number; sort_by: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const start = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const count = typeof state?.['n'] === 'number' ? state['n'] : args.count;
        const sortBy = typeof state?.['b'] === 'string' ? state['b'] : args.sort_by;
        const author: Author = typeof state?.['u'] === 'string'
          ? { kind: String(state['u']).startsWith('urn:li:organization:') ? 'organization' : 'member', urn: String(state['u']) }
          : await resolveAuthor(h, args.author);
        const { data } = await h.api({
          path: '/rest/posts',
          query: { q: 'author', author: author.urn, count, start, sortBy },
          headers: { 'x-restli-method': 'FINDER' },
          errors: {
            403: author.kind === 'organization'
              ? 'LinkedIn refused to list the organization\'s posts: the connection needs the r_organization_social permission and a role on that Page'
              : `LinkedIn lists a member's own posts only to apps it approved for the r_member_social permission. To see whether a member post went out, ${MEMBER_POSTS_WHERE}`,
          },
        });
        const elements: unknown[] = Array.isArray(data?.elements) ? data.elements : [];
        const links: unknown[] = Array.isArray(data?.paging?.links) ? data.paging.links : [];
        // LinkedIn may send fewer posts than count while more follow; its "next" link says where the next page starts.
        const hasNext = links.some((link) => (link as { rel?: unknown } | null)?.rel === 'next');
        const following = nextLinkStart(links) ?? (hasNext || elements.length >= count ? start + count : undefined);
        const here = (offset: number) => h.makeCursor({ u: author.urn, s: start, n: count, b: sortBy, o: offset });
        return h.page({
          key: 'posts',
          items: elements.map(trimPost).slice(skip),
          extra: compact({
            author: author.urn,
            note: !elements.length && following !== undefined && following > start ? 'LinkedIn sent no posts on this page but says more follow: pass nextCursor to go on.' : undefined,
          }),
          resumeAt: (index) => here(skip + index),
          ...(following !== undefined && following > start ? { nextPage: h.makeCursor({ u: author.urn, s: following, n: count, b: sortBy, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Get a LinkedIn post',
      description: 'Returns one LinkedIn post by its URN (urn:li:share:... or urn:li:ugcPost:...), as its author sees it: text, content type, visibility, state and times.',
      inputSchema: {
        type: 'object',
        properties: { post_id: { type: 'string', pattern: POST_ID, description: 'The post URN, such as urn:li:share:7212345678901234567.' } },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { post_id: string }, h) {
        const { data } = await h.api({
          path: `/rest/posts/${encodeURIComponent(args.post_id)}`,
          query: { viewContext: 'AUTHOR' },
          errors: { 404: 'LinkedIn found no post with that URN' },
        });
        return trimPost(data);
      },
    },
    {
      name: 'create_post',
      kind: 'create',
      check: 'list_posts',
      title: 'Publish a LinkedIn post',
      description:
        'Publishes a post on LinkedIn right away, as the organization (Page) or as the member: text up to 3,000 characters, '
        + 'with #hashtags and @[Name](urn:li:organization:123) mentions; optionally up to 20 images from public https URLs '
        + '(JPEG, PNG or GIF, with alt text), or an article link with its title, description and thumbnail image (LinkedIn does not read the page for them). '
        + 'Returns the post URN and its link. LinkedIn has no drafts here: the post goes live. A member post whose outcome is unclear '
        + 'cannot be checked with list_posts on most apps: look at the member\'s LinkedIn profile instead.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'The post text, up to 3,000 characters. Written as is: characters such as ( ) and * are kept.' },
          author: AUTHOR_SCHEMA,
          images: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: 'Images to attach, in order: one image, or 2 to 20 for a multi-image post. Not with article.',
            items: {
              type: 'object',
              properties: {
                url: { ...HTTPS_URL, description: 'A public https URL of a JPEG, PNG or GIF image.' },
                alt_text: { type: 'string', maxLength: 4086, description: 'Alt text describing the image.' },
              },
              required: ['url'],
              additionalProperties: false,
            },
          },
          image_title: { type: 'string', maxLength: 200, description: 'A title for a single image.' },
          article: {
            type: 'object',
            description: 'A link to share as an article card. Not with images.',
            properties: {
              url: { ...HTTPS_URL, description: 'The article URL.' },
              title: { type: 'string', minLength: 1, maxLength: 400, description: 'The title shown on the card.' },
              description: { type: 'string', maxLength: 4086, description: 'The description shown on the card.' },
              thumbnail_url: { ...HTTPS_URL, description: 'A public https URL of a JPEG, PNG or GIF thumbnail for the card.' },
            },
            required: ['url', 'title'],
            additionalProperties: false,
          },
          visibility: {
            type: 'string',
            enum: ['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'],
            default: 'PUBLIC',
            description: 'PUBLIC (default), LOGGED_IN (signed-in members only), or CONNECTIONS (the member\'s connections; member posts only).',
          },
          disable_reshare: { type: 'boolean', default: false, description: 'true stops others from resharing the post.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        if (args.images && args.article) throw new ToolFailure('Give images or article, not both. Nothing was posted.');
        if (args.image_title !== undefined && args.images?.length !== 1) throw new ToolFailure('image_title is for a post with exactly one image. Nothing was posted.');
        const author = await resolveAuthor(h, args.author);
        if (author.kind === 'organization' && args.visibility === 'CONNECTIONS') {
          throw new ToolFailure('An organization post cannot be limited to connections: use PUBLIC or LOGGED_IN. Nothing was posted.');
        }

        // Every image is on LinkedIn before the post is made, so a bad image posts nothing.
        let content: Record<string, unknown> | undefined;
        if (args.images) {
          const images = args.images;
          const uploaded: Array<{ id: string; altText?: string }> = [];
          for (const [index, image] of images.entries()) {
            const id = await uploadImage(h, author, image.url, images.length > 1 ? `image ${index + 1}` : 'image');
            uploaded.push(compact({ id, altText: image.alt_text }) as { id: string; altText?: string });
          }
          content = uploaded.length === 1
            ? { media: compact({ id: uploaded[0]?.id, title: args.image_title, altText: uploaded[0]?.altText }) }
            : { multiImage: { images: uploaded } };
        } else if (args.article) {
          const thumbnail = args.article.thumbnail_url ? await uploadImage(h, author, args.article.thumbnail_url, 'thumbnail image') : undefined;
          content = { article: compact({ source: args.article.url, title: args.article.title, description: args.article.description, thumbnail }) };
        }

        let response: Awaited<ReturnType<ToolHelpers['api']>>;
        try {
          response = await h.api({
            method: 'POST',
            path: '/rest/posts',
            json: compact({
              author: author.urn,
              commentary: toLittle(args.text),
              visibility: args.visibility,
              distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
              content,
              lifecycleState: 'PUBLISHED',
              isReshareDisabledByAuthor: args.disable_reshare,
            }),
            write: true,
            errors: { 403: refusedPost(author.kind), 422: 'LinkedIn did not accept the post' },
          });
        } catch (error) {
          if (error instanceof OutcomeUnknown && author.kind === 'member') {
            throw new OutcomeUnknown(
              `${error.message} LinkedIn lists a member's posts only to apps it approved for r_member_social, so list_posts may not show it: `
                + `before posting again, ${MEMBER_POSTS_WHERE}.`,
            );
          }
          throw error;
        }
        const header = response.headers.get('x-restli-id') ?? response.headers.get('x-linkedin-id');
        let id: string | undefined;
        try {
          id = header ? decodeURIComponent(header) : typeof response.data?.id === 'string' ? response.data.id : undefined;
        } catch {
          id = header ?? undefined;
        }
        return compact({
          id,
          url: id ? postUrl(id) : undefined,
          author: author.urn,
          authorType: author.kind,
          content: content ? contentKind(content) : 'text',
          images: args.images?.length,
          note: id ? undefined : 'LinkedIn created the post but sent back no post URN, so there is no link to it. Find it with list_posts.',
        });
      },
    },
    {
      name: 'delete_post',
      kind: 'delete',
      check: 'get_post',
      title: 'Delete a LinkedIn post',
      description: 'Deletes one LinkedIn post by its URN, for good. Deleting a post that is already gone succeeds too.',
      inputSchema: {
        type: 'object',
        properties: { post_id: { type: 'string', pattern: POST_ID, description: 'The post URN, such as urn:li:share:7212345678901234567.' } },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { post_id: string }, h) {
        await h.api({
          method: 'DELETE',
          path: `/rest/posts/${encodeURIComponent(args.post_id)}`,
          headers: { 'x-restli-method': 'DELETE' },
          write: true,
          errors: { 403: 'LinkedIn refused to delete the post: the connection may delete only posts it is allowed to manage', 404: 'LinkedIn found no post with that URN' },
        });
        return { deleted: true, id: args.post_id };
      },
    },
    ...apiTools({
      label: 'LinkedIn',
      description:
        'The LinkedIn REST API on https://api.linkedin.com, with the connection\'s token and the LinkedIn-Version and Rest.li 2.0 headers: '
        + 'paths start with /rest/ (such as /rest/organizationAcls with q=roleAssignee, or /rest/socialActions/{post URN}/comments) or /v2/ '
        + '(such as /v2/userinfo), with URNs URL-encoded in the path. PATCH is sent as a Rest.li partial update (POST with '
        + 'X-RestLi-Method: PARTIAL_UPDATE and a {"patch": {"$set": {...}}} body). A create answers 201 with the new id in the '
        + 'x-restli-id header, which the result returns. Reference: https://learn.microsoft.com/linkedin/.',
      guard: (request) => {
        if (!/^\/(rest|v2)\//.test(request.path)) throw new ToolFailure('LinkedIn API paths start with /rest/ or /v2/. Nothing was sent.');
      },
      send: (request, h) => h.api(restliRequest(request)),
      responseHeaders: ['x-restli-id', 'x-linkedin-id'],
    }),
  ],
});

export = connector;
