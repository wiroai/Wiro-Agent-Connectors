// Tumblr, through the Tumblr API v2 and the Neue Post Format
// (https://www.tumblr.com/docs/en/api/v2, https://www.tumblr.com/docs/npf).
//
// Credential: `access_token`, the current OAuth 2 access token of the user's
// own Tumblr app (scopes basic, write and offline_access). The host refreshes
// it (it lasts about 42 minutes); the module never does. The blogs the agent
// may use are the `blogs` account picker: each by its Tumblr id (t:...), or by
// its name for a blog Tumblr lists without one.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  formatNumber,
  OutcomeUnknown,
  requireAccounts,
  ToolFailure,
  truncate,
  utf8Bytes,
  type ApiRequest,
  type ApiResponse,
  type ToolHelpers,
} from '../../core/index.js';
import { imageSize, multipart, sniffImage, type FormPart } from './media.js';

const STATES = ['draft', 'published', 'queue', 'private'] as const;
type PostState = (typeof STATES)[number];
const MAX_TEXT_BLOCK = 4096;
const MAX_IMAGES = 30;
const MAX_LINKS = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GIF_BYTES = 10 * 1024 * 1024;
/** The most one post downloads with upload_images, all its images together. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BLOG_ARGUMENT = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 200,
  description: 'The blog: its id (t:...) from list_blogs, or its name. Optional when exactly one blog is chosen for the connection.',
};
const POST_ID = { type: 'string' as const, pattern: '^\\d{1,25}$', description: 'The post id, from list_posts or create_post.' };
// Tumblr's own reason (its errors[].detail) does not reach these messages, so
// each names every cause Tumblr documents for its status.
const ERRORS = {
  400: 'Tumblr did not accept the request: the post\'s JSON, a content block or the layout may not be valid, an image may be in a format or at an address Tumblr cannot use, or publish_on may not be in the future',
  403: 'Tumblr refused: the account may not use this blog (as when it left a group blog, or the blog was deleted), or a Tumblr limit was reached: 250 posts or 250 image uploads a day, or a full queue of 1,000 posts',
  404: 'Tumblr found no such blog or post',
};

/** Where a post that may have been made shows, by the state it was sent in. */
const CREATE_CHECKS: Record<PostState, string> = {
  draft: 'It was sent as a draft: list_posts shows it with state "draft" and the same blog_id.',
  queue: 'It was sent to the queue: list_posts shows it with state "queue" and the same blog_id.',
  published: 'list_posts shows the blog\'s published posts, newest first.',
  private: 'It was sent as a private post, which list_posts may not show: look on the blog in Tumblr.',
};

const CONTENT_FIELDS = {
  content: {
    type: 'array' as const,
    minItems: 1,
    maxItems: 100,
    items: { type: 'object' as const, description: 'One Neue Post Format block, such as {"type": "text", "text": "..."}.' },
    description: 'The post as Neue Post Format blocks, for full control (text with subtype and formatting, link, image with alt_text). Instead of text, images and link_url.',
  },
  layout: { type: 'array' as const, maxItems: 20, items: { type: 'object' as const }, description: 'Neue Post Format layout objects, with content.' },
  text: { type: 'string' as const, maxLength: 200000, description: 'The text; a blank line starts a new paragraph (each up to 4,096 characters).' },
  images: {
    type: 'array' as const,
    minItems: 1,
    maxItems: MAX_IMAGES,
    items: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' as const, format: 'uri' as const, pattern: '^https://', maxLength: 2000, description: 'A public https URL of a JPEG, PNG, GIF or WebP image.' },
        alt_text: { type: 'string' as const, minLength: 1, maxLength: 4096, description: 'What the image shows, for people who cannot see it.' },
        caption: { type: 'string' as const, maxLength: 4096, description: 'An optional caption under the image.' },
      },
      required: ['url', 'alt_text'],
      additionalProperties: false,
    },
    description: 'Images after the text, each with alt text, up to 30.',
  },
  link_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'A link block after the images; Tumblr fills its title, text and picture from the page.' },
  upload_images: { type: 'boolean' as const, default: false, description: 'Download the images and upload them with the post (up to 50 MB in all), instead of letting Tumblr fetch them by URL (default false). Use it when Tumblr refuses an image URL.' },
  tags: {
    type: 'array' as const,
    maxItems: 30,
    uniqueItems: true,
    items: { type: 'string' as const, minLength: 1, maxLength: 140, pattern: '^[^,#][^,]*$' },
    description: 'Tags without #, up to 140 characters each and no commas, e.g. ["illustration", "digital art"]. Tumblr search reads the first 30.',
  },
  publish_on: { type: 'string' as const, maxLength: 40, description: 'With state queue: when it goes out, e.g. 2026-12-01T18:00:00Z. Without it, a queued post goes out on the blog\'s queue times.' },
  slug: { type: 'string' as const, maxLength: 200, pattern: '^[A-Za-z0-9-]+$', description: 'Words for the post\'s address, e.g. new-print-series.' },
  source_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'Where the content comes from, for attribution.' },
};

const UPDATE_FIELDS = {
  replace_blocks: {
    type: 'array' as const,
    minItems: 1,
    maxItems: 100,
    items: {
      type: 'object' as const,
      properties: {
        index: { type: 'integer' as const, minimum: 0, maximum: 9999, description: 'The block\'s place in the post, from 0: get_post\'s blocks_from plus its place in that page\'s content.' },
        block: { type: 'object' as const, description: 'Its new Neue Post Format block, such as {"type": "text", "text": "..."}.' },
      },
      required: ['index', 'block'],
      additionalProperties: false,
    },
    description: 'Changes single blocks by their index and keeps the other blocks and the layout. Instead of content, text, images and link_url.',
  },
  replace_all: {
    type: 'boolean' as const,
    default: false,
    description: 'With content: replace the post with exactly these blocks even when there are more or fewer than the post has now (default false).',
  },
};

interface ImageArg {
  url: string;
  alt_text: string;
  caption?: string;
}

interface ContentArgs {
  content?: Array<Record<string, unknown>>;
  layout?: Array<Record<string, unknown>>;
  text?: string;
  images?: ImageArg[];
  link_url?: string;
  upload_images: boolean;
  tags?: string[];
  publish_on?: string;
  slug?: string;
  source_url?: string;
}

interface UpdateArgs extends ContentArgs {
  blog_id?: string;
  post_id: string;
  state?: PostState;
  replace_blocks?: Array<{ index: number; block: Record<string, unknown> }>;
  replace_all: boolean;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

async function api(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  return h.api({ ...request, errors: { ...ERRORS, ...request.errors } });
}

/** A blog identifier in a path: t:... keeps its colon. */
function blogPath(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ':');
}

function blogIdOf(blog: any): string {
  return typeof blog?.uuid === 'string' && blog.uuid ? blog.uuid : String(blog?.name ?? '');
}

async function userBlogs(h: ToolHelpers): Promise<any[]> {
  const { data } = await api(h, { path: '/v2/user/info' });
  return Array.isArray(data?.response?.user?.blogs) ? data.response.user.blogs : [];
}

/** The blog a call acts on: the one given (an id, or a name looked up), else the only blog chosen for the connection. */
async function resolveBlog(h: ToolHelpers, given: string | undefined): Promise<string> {
  const allowed = allowedAccounts(h.ctx.accounts, 'blogs');
  if (given === undefined) {
    if (allowed?.length === 1) return allowed[0] as string;
    throw new ToolFailure(
      allowed?.length
        ? `blog_id is required: this connection has several blogs (${allowed.join(', ')}). Nothing was sent.`
        : 'blog_id is required: list_blogs shows the blogs. Nothing was sent.',
    );
  }
  const value = given.trim().replace(/^@/, '');
  if (allowed === null || allowed.includes(value)) return value;
  if (!value.startsWith('t:')) {
    // A blog's name or address where its id was chosen.
    const name = value.replace(/\.tumblr\.com$/i, '').toLowerCase();
    const match = (await userBlogs(h)).find((blog) => String(blog?.name ?? '').toLowerCase() === name);
    if (match && allowed.includes(blogIdOf(match))) return blogIdOf(match);
  }
  requireAccounts(h.ctx.accounts, 'blogs', value, 'blog');
  return value;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** The time of a queued post, or a refusal when it is not a future time with its zone. */
function futureTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ToolFailure('publish_on must be a time with its zone, such as 2026-12-01T18:00:00Z. Nothing was sent.');
  }
  const time = Date.parse(value);
  if (Number.isNaN(time) || time <= Date.now()) throw new ToolFailure('publish_on must be in the future. Nothing was sent.');
  return new Date(time).toISOString().replace(/\.000Z$/, 'Z');
}

function guessType(url: string): string | undefined {
  const extension = /\.([a-z0-9]{3,4})(?:$|[?#])/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension ?? ''];
}

/** One Neue Post Format block, checked for what Tumblr refuses and what every image needs; returns its type. */
function checkBlock(block: Record<string, unknown>, where: string): string {
  const type = block['type'];
  if (typeof type !== 'string') throw new ToolFailure(`${where} has no type: each block is like {"type": "text", "text": "..."}. Nothing was sent.`);
  if (type === 'text') {
    const text = block['text'];
    if (typeof text !== 'string') throw new ToolFailure(`${where} is a text block without text. Nothing was sent.`);
    if (codePoints(text) > MAX_TEXT_BLOCK) {
      throw new ToolFailure(`${where} has ${formatNumber(codePoints(text))} characters; Tumblr allows ${formatNumber(MAX_TEXT_BLOCK)} per text block: split it. Nothing was sent.`);
    }
  } else if (type === 'image') {
    const alt = block['alt_text'];
    if (typeof alt !== 'string' || !alt.trim()) throw new ToolFailure(`${where} is an image without alt_text: say what it shows. Nothing was sent.`);
  }
  return type;
}

function checkBlocks(blocks: Array<Record<string, unknown>>): void {
  let images = 0;
  let links = 0;
  blocks.forEach((block, index) => {
    const type = checkBlock(block, `content[${index}]`);
    if (type === 'image') images++;
    else if (type === 'link') links++;
  });
  if (images > MAX_IMAGES) throw new ToolFailure(`The post has ${images} images; Tumblr allows ${MAX_IMAGES}. Nothing was sent.`);
  if (links > MAX_LINKS) throw new ToolFailure(`The post has ${links} link blocks; Tumblr allows ${MAX_LINKS}. Nothing was sent.`);
}

interface BuiltContent {
  content: Array<Record<string, unknown>>;
  files: FormPart[];
}

/** The post's blocks from the arguments, with its image files when they are uploaded. */
async function buildContent(h: ToolHelpers, args: ContentArgs): Promise<BuiltContent | undefined> {
  const simple = args.text !== undefined || args.images !== undefined || args.link_url !== undefined;
  if (args.content && simple) throw new ToolFailure('Give content, or text, images and link_url, not both. Nothing was sent.');
  if (args.layout && !args.content) throw new ToolFailure('layout goes with content. Nothing was sent.');
  if (args.content) {
    checkBlocks(args.content);
    return { content: args.content, files: [] };
  }
  if (!simple) return undefined;
  const content: Array<Record<string, unknown>> = [];
  const paragraphs = (args.text ?? '').split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  paragraphs.forEach((paragraph, index) => {
    if (codePoints(paragraph) > MAX_TEXT_BLOCK) {
      throw new ToolFailure(`Paragraph ${index + 1} has ${formatNumber(codePoints(paragraph))} characters; Tumblr allows ${formatNumber(MAX_TEXT_BLOCK)} per paragraph: split it with a blank line. Nothing was sent.`);
    }
    content.push({ type: 'text', text: paragraph });
  });
  const files: FormPart[] = [];
  let downloaded = 0;
  for (const [index, image] of (args.images ?? []).entries()) {
    let media: Record<string, unknown>;
    if (args.upload_images) {
      const what = (args.images?.length ?? 0) > 1 ? `image ${index + 1}` : 'image';
      const { bytes } = await h.media(image.url, { what, maxBytes: MAX_IMAGE_BYTES, accept: 'image/jpeg,image/png,image/gif,image/webp' });
      // Every image is held in memory until the post goes out, so one post uploads a bounded amount.
      downloaded += bytes.length;
      if (downloaded > MAX_UPLOAD_BYTES) {
        throw new ToolFailure(
          `The images to upload come to more than ${formatNumber(MAX_UPLOAD_BYTES)} bytes, the most one post uploads here: upload the rest `
            + 'in another post, or leave upload_images out so Tumblr fetches the images by URL. Nothing was sent.',
        );
      }
      const type = sniffImage(bytes);
      if (!type) throw new ToolFailure(`The ${what} URL did not return a JPEG, PNG, GIF or WebP image. Nothing was sent.`);
      if (type === 'image/gif' && bytes.length > MAX_GIF_BYTES) throw new ToolFailure(`The ${what} is a GIF of ${formatNumber(bytes.length)} bytes; Tumblr takes GIFs up to ${formatNumber(MAX_GIF_BYTES)}. Nothing was sent.`);
      const identifier = `image${index + 1}`;
      const size = imageSize(bytes, type);
      media = compact({ type, identifier, width: size?.width, height: size?.height });
      files.push({ name: identifier, filename: `${identifier}.${type.slice(6).replace('jpeg', 'jpg')}`, contentType: type, bytes });
    } else {
      media = compact({ url: image.url, type: guessType(image.url) });
    }
    content.push(compact({ type: 'image', media: [media], alt_text: image.alt_text, caption: image.caption || undefined }));
  }
  if (args.link_url) content.push({ type: 'link', url: args.link_url });
  if (!content.length) throw new ToolFailure('The post has no content: give text, images, link_url or content. Nothing was sent.');
  return { content, files };
}

/** A JSON body, or a multipart one with the post's JSON and its image files. */
function postBody(body: Record<string, unknown>, files: FormPart[]): Pick<ApiRequest, 'json' | 'body' | 'contentType'> {
  if (!files.length) return { json: body };
  const form = multipart([{ name: 'json', value: JSON.stringify(body), contentType: 'application/json' }, ...files]);
  return { body: form.body, contentType: form.contentType };
}

/** A post id from Tumblr's answer: a string of digits, or a number small enough to be exact. */
function idFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{1,25}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

/** A published post's link, read back by its id; the post exists either way. */
async function readLink(h: ToolHelpers, blog: string, id: string, done: string): Promise<Record<string, unknown>> {
  try {
    const { data } = await api(h, { path: `/v2/blog/${blogPath(blog)}/posts`, query: { id, npf: true } });
    const posts: any[] = Array.isArray(data?.response?.posts) ? data.response.posts : [];
    const post = posts.find((item) => idFrom(item?.id_string) === id || idFrom(item?.id) === id);
    if (typeof post?.post_url === 'string') return { post_url: post.post_url };
  } catch (error) {
    if (!(error instanceof ToolFailure)) throw error;
  }
  return { note: `The post was ${done}, but its link could not be read: list_posts shows it.` };
}

function tagList(tags: unknown): string[] | undefined {
  return Array.isArray(tags) ? tags.map(String) : undefined;
}

function summaryOf(post: any): string | undefined {
  if (typeof post?.summary === 'string' && post.summary.trim()) return truncate(post.summary.trim(), 200);
  const text = Array.isArray(post?.content)
    ? post.content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join(' ')
    : '';
  return text ? truncate(text, 200) : undefined;
}

function trimPost(post: any): Record<string, unknown> {
  const scheduled = typeof post?.scheduled_publish_time === 'number' ? new Date(post.scheduled_publish_time * 1000).toISOString() : undefined;
  return compact({
    id: post?.id_string ?? (post?.id !== undefined ? String(post.id) : undefined),
    state: post?.state,
    date: post?.date,
    scheduled_for: scheduled,
    post_url: post?.post_url,
    note_count: post?.note_count,
    tags: tagList(post?.tags)?.length ? tagList(post?.tags) : undefined,
    summary: summaryOf(post),
    type: post?.type,
  });
}

function trimBlog(blog: any): Record<string, unknown> {
  return compact({
    id: blogIdOf(blog),
    name: blog?.name,
    title: blog?.title || undefined,
    url: blog?.url,
    primary: blog?.primary,
    type: blog?.type,
    followers: blog?.followers,
  });
}

function stateFor(value: unknown): string | undefined {
  if (value === 'queued') return 'queue';
  return typeof value === 'string' ? value : undefined;
}

const connector = defineConnector({
  vendor: 'tumblr',
  label: 'Tumblr',
  origins: ['https://api.tumblr.com'],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Tumblr access token' },
  accountPickers: [
    {
      key: 'blogs',
      label: 'Tumblr blogs',
      description: 'The blogs the agent may post to and read, group blogs included.',
      multiple: true,
      tool: 'list_blogs',
      idField: 'id',
      nameField: 'name',
      legacyField: 'blogid',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_blogs',
      kind: 'read',
      title: 'List Tumblr blogs',
      description:
        'Lists the blogs the connected account can post to, group blogs included: id (t:..., what the other tools take), name, title, '
        + 'address, whether it is the main blog, and followers.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const blogs = (await userBlogs(h)).map(trimBlog);
        return h.page({ key: 'blogs', items: blogs.slice(skip), resumeAt: (index) => h.makeCursor({ o: skip + index }) });
      },
    },
    {
      name: 'list_posts',
      kind: 'read',
      title: 'List a Tumblr blog\'s posts',
      description:
        "Lists a blog's posts, newest first: published posts with their link, note count (likes, reblogs and replies together) and tags, "
        + 'or its drafts, or its queue with each post\'s time. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          state: { type: 'string', enum: ['published', 'draft', 'queue'], default: 'published', description: 'published (default), draft or queue.' },
          tag: { type: 'string', minLength: 1, maxLength: 140, description: 'Only published posts with this tag.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: 'Posts per page, 1 to 20 (default 20).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { blog_id?: string; state: 'published' | 'draft' | 'queue'; tag?: string; limit: number; cursor?: string }, h) {
        const blog = await resolveBlog(h, args.blog_id);
        const state = h.cursor(args.cursor);
        const offset = typeof state?.['p'] === 'number' ? state['p'] : 0;
        const before = typeof state?.['b'] === 'string' ? state['b'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
        const which = typeof state?.['s'] === 'string' ? state['s'] : args.state;
        const tag = typeof state?.['g'] === 'string' ? state['g'] : args.tag;
        if (tag && which !== 'published') throw new ToolFailure('tag works with published posts only.');
        const base = `/v2/blog/${blogPath(blog)}/posts`;
        const request = which === 'draft'
          ? { path: `${base}/draft`, query: { npf: true, before_id: before } }
          : { path: which === 'queue' ? `${base}/queue` : base, query: { npf: true, limit, offset: offset || undefined, tag } };
        const { data } = await api(h, request);
        const posts: any[] = Array.isArray(data?.response?.posts) ? data.response.posts : [];
        const keep = { s: which, n: limit, ...(tag ? { g: tag } : {}) };
        const total = typeof data?.response?.total_posts === 'number' ? data.response.total_posts : undefined;
        let nextPage: string | undefined;
        if (which === 'draft') {
          const last = posts[posts.length - 1];
          const lastId = last?.id_string ?? (last?.id !== undefined ? String(last.id) : undefined);
          if (posts.length && lastId) nextPage = h.makeCursor({ ...keep, b: lastId, o: 0 });
        } else if (posts.length >= limit && (total === undefined || offset + posts.length < total)) {
          nextPage = h.makeCursor({ ...keep, p: offset + posts.length, o: 0 });
        }
        return h.page({
          key: 'posts',
          items: posts.map(trimPost).slice(skip),
          extra: compact({ blog, state: which, total_posts: total }),
          resumeAt: (index) => h.makeCursor({ ...keep, ...(before ? { b: before } : {}), ...(offset ? { p: offset } : {}), o: skip + index }),
          ...(nextPage ? { nextPage } : {}),
        });
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Get a Tumblr post',
      description:
        'Returns one post of a blog in the Neue Post Format: its state, tags, a scheduled post\'s time, its layout and its content '
        + 'blocks, with blocks_total and blocks_from (the index of the first block returned). A long post comes in parts: pass '
        + 'nextCursor back as cursor, with the same blog_id and post_id, for the next blocks. update_post edits it, and its '
        + 'replace_blocks changes single blocks by their index.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          post_id: POST_ID,
          cursor: { type: 'string', description: 'nextCursor from the previous result, for the next blocks of the same post.' },
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { blog_id?: string; post_id: string; cursor?: string }, h) {
        const blog = await resolveBlog(h, args.blog_id);
        const state = h.cursor(args.cursor);
        if (state && (state['i'] !== args.post_id || state['b'] !== blog)) {
          throw new ToolFailure('The cursor belongs to another post. Pass the same blog_id and post_id as in the previous call, or leave cursor out.');
        }
        const start = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await api(h, { path: `/v2/blog/${blogPath(blog)}/posts/${args.post_id}`, query: { post_format: 'npf' } });
        const post = data?.response ?? {};
        const fields = compact({
          ...trimPost(post),
          blog,
          publish_on: post.publish_on || undefined,
          slug: post.slug || undefined,
          tags: tagList(post.tags) ?? [],
          layout: Array.isArray(post.layout) && post.layout.length ? post.layout : undefined,
        });
        if (!Array.isArray(post.content)) {
          return { ...fields, note: 'Tumblr sent this post without Neue Post Format blocks: read and edit it on Tumblr.' };
        }
        // Blocks are never cut: a post too long for one result continues at the next block.
        const blocks: unknown[] = post.content;
        return h.page({
          key: 'content',
          items: blocks.slice(start),
          extra: { ...fields, blocks_total: blocks.length, blocks_from: start },
          resumeAt: (index) => h.makeCursor({ b: blog, i: args.post_id, o: start + index }),
        });
      },
    },
    {
      name: 'create_post',
      kind: 'create',
      check: 'list_posts',
      title: 'Create a Tumblr post',
      description:
        'Creates a post on a blog, as a draft by default (state draft): text in paragraphs, images with alt text (by URL, or uploaded '
        + 'with upload_images), a link block, or Neue Post Format content blocks, with tags. state published posts it now, queue adds '
        + 'it to the queue (at publish_on, or the blog\'s queue times), private keeps it to the blog. Returns its id, and its link once '
        + 'published. Tumblr allows 250 posts a day per account.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          state: { type: 'string', enum: [...STATES], default: 'draft', description: 'draft (default), published, queue or private.' },
          ...CONTENT_FIELDS,
        },
        additionalProperties: false,
      },
      async run(args: ContentArgs & { blog_id?: string; state: PostState }, h) {
        if (args.publish_on !== undefined && args.state !== 'queue') throw new ToolFailure('publish_on goes with state queue. Nothing was sent.');
        const publishOn = args.publish_on !== undefined ? futureTime(args.publish_on) : undefined;
        const blog = await resolveBlog(h, args.blog_id);
        const built = await buildContent(h, args);
        if (!built) throw new ToolFailure('The post has no content: give text, images, link_url or content. Nothing was sent.');
        const body = compact({
          content: built.content,
          layout: args.layout,
          state: args.state,
          publish_on: publishOn,
          tags: args.tags?.length ? args.tags.join(',') : undefined,
          slug: args.slug,
          source_url: args.source_url,
        });
        let data: any;
        try {
          ({ data } = await api(h, { method: 'POST', path: `/v2/blog/${blogPath(blog)}/posts`, ...postBody(body, built.files), write: true }));
        } catch (error) {
          // list_posts shows published posts unless told the state: name the list this post would be in.
          if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${error.message} ${CREATE_CHECKS[args.state]}`);
          throw error;
        }
        const id = idFrom(data?.response?.id_string) ?? idFrom(data?.response?.id);
        const result: Record<string, unknown> = compact({ id, blog, state: data?.response?.state ?? args.state, publish_on: publishOn });
        if (id && args.state === 'published') {
          Object.assign(result, await readLink(h, blog, id, 'created'));
        } else if (id && !blog.startsWith('t:') && (args.state === 'draft' || args.state === 'queue')) {
          result['manage_url'] = `https://www.tumblr.com/blog/${blog}/${args.state === 'draft' ? 'drafts' : 'queue'}`;
        }
        return result;
      },
    },
    {
      name: 'update_post',
      kind: 'update',
      check: 'get_post',
      title: 'Edit or publish a Tumblr post',
      description:
        'Changes a post: its state (publish a draft with state published, or queue it with publish_on), its tags, or its content. '
        + 'Tumblr replaces a post whole, so the tool reads the post first and keeps what is not given. replace_blocks changes single '
        + 'blocks by their index and keeps the rest and the layout; content (or text, images and link_url) replaces all blocks, and '
        + 'content must have as many blocks as the post has unless replace_all is true. A scheduled post keeps its time, and a queued '
        + 'post its place, unless publish_on is given. Tumblr gives a draft or a queued post a new id when it publishes it: use the id '
        + 'this returns. Editing a published post changes it live. Older posts not made in the Neue Post Format must be edited on Tumblr.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          post_id: POST_ID,
          state: { type: 'string', enum: [...STATES], description: 'The new state: published, draft, queue or private.' },
          ...CONTENT_FIELDS,
          ...UPDATE_FIELDS,
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: UpdateArgs, h) {
        const blog = await resolveBlog(h, args.blog_id);
        if (args.replace_blocks && (args.content || args.text !== undefined || args.images || args.link_url !== undefined)) {
          throw new ToolFailure('Give replace_blocks, or new content (content, or text, images and link_url), not both. Nothing was changed.');
        }
        args.replace_blocks?.forEach((item, index) => checkBlock(item.block, `replace_blocks[${index}].block`));
        const built = await buildContent(h, args);
        const changes = built || args.replace_blocks || args.state || args.tags || args.publish_on || args.slug || args.source_url;
        if (!changes) throw new ToolFailure('Nothing to change: give state, tags, publish_on, slug, source_url, replace_blocks or new content. Nothing was changed.');
        const path = `/v2/blog/${blogPath(blog)}/posts/${args.post_id}`;
        const { data } = await api(h, { path, query: { post_format: 'npf' } });
        const current = data?.response ?? {};
        if (!Array.isArray(current.content)) {
          throw new ToolFailure('This post is not in the Neue Post Format, so Tumblr does not let it be edited here: edit it on Tumblr. Nothing was changed.');
        }
        const before = stateFor(current.state);
        const state = args.state ?? before;
        if (!state || !(STATES as readonly string[]).includes(state)) {
          // Never guess: a draft edited as published would go live.
          throw new ToolFailure('Tumblr did not say which state the post is in: give state (published, draft, queue or private) with the edit. Nothing was changed.');
        }
        if (args.publish_on !== undefined && state !== 'queue') throw new ToolFailure('publish_on goes with state queue. Nothing was changed.');
        // Only a scheduled post has publish_on. A post waiting in the queue goes back without one, so it keeps its place there.
        const publishOn = args.publish_on !== undefined
          ? futureTime(args.publish_on)
          : state === 'queue' && typeof current.publish_on === 'string' && current.publish_on ? current.publish_on : undefined;

        const blocks = current.content as Array<Record<string, unknown>>;
        const currentLayout: unknown[] = Array.isArray(current.layout) ? current.layout : [];
        let content = blocks;
        let layout = currentLayout;
        if (args.replace_blocks) {
          content = [...blocks];
          const seen = new Set<number>();
          for (const { index, block } of args.replace_blocks) {
            if (index >= blocks.length) {
              throw new ToolFailure(`replace_blocks names block ${index}, but the post has ${blocks.length} block${blocks.length === 1 ? '' : 's'}, numbered from 0. Nothing was changed.`);
            }
            if (seen.has(index)) throw new ToolFailure(`replace_blocks names block ${index} twice. Nothing was changed.`);
            seen.add(index);
            content[index] = block;
          }
        } else if (built) {
          // Blocks sent back from part of a long post would drop the rest of it.
          if (args.content && !args.replace_all && args.content.length !== blocks.length) {
            throw new ToolFailure(
              `The post has ${blocks.length} blocks and content has ${args.content.length}: content replaces the whole post. To change single `
                + 'blocks, use replace_blocks; to replace the post with exactly these blocks, add replace_all: true. Nothing was changed.',
            );
          }
          content = built.content;
          // The layout names blocks by index: it stays while the blocks keep their places.
          layout = args.layout ?? (args.content && args.content.length === blocks.length ? currentLayout : []);
        }
        const body = compact({
          content,
          layout,
          state,
          publish_on: publishOn,
          // Tags Tumblr did not send back are left out rather than cleared.
          tags: args.tags ? args.tags.join(',') : tagList(current.tags)?.join(','),
          slug: args.slug,
          source_url: args.source_url,
        });
        const publishing = state === 'published' && before !== 'published';
        let answer: any;
        try {
          ({ data: answer } = await api(h, {
            method: 'PUT',
            path,
            ...postBody(body, built?.files ?? []),
            write: true,
            errors: { 400: 'Tumblr did not accept the edit: the post may be an older one that must be edited on Tumblr, or a content block, the layout, an image or publish_on may not be valid' },
          }));
        } catch (error) {
          if (error instanceof OutcomeUnknown && publishing) {
            throw new OutcomeUnknown(
              `${error.message} Tumblr gives a draft or a queued post a new id when it publishes it: if get_post finds no post ${args.post_id}, `
                + 'it was most likely published, and list_posts shows it.',
            );
          }
          throw error;
        }
        // A published draft or queued post has a new id; the old one finds nothing any more.
        const id = idFrom(answer?.response?.id_string) ?? idFrom(answer?.response?.id) ?? args.post_id;
        const result: Record<string, unknown> = compact({
          id,
          previous_id: id !== args.post_id ? args.post_id : undefined,
          blog,
          state,
          publish_on: publishOn,
          tags: typeof body['tags'] === 'string' && body['tags'] ? body['tags'].split(',') : undefined,
          content_blocks: content.length,
        });
        if (state === 'published') Object.assign(result, await readLink(h, blog, id, publishing ? 'published' : 'changed'));
        return result;
      },
    },
    {
      name: 'delete_post',
      kind: 'delete',
      check: 'get_post',
      title: 'Delete a Tumblr post',
      description: 'Deletes a post of a blog. Tumblr has no trash: it cannot be restored, and its notes and reblog trail go with it.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          post_id: POST_ID,
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { blog_id?: string; post_id: string }, h) {
        const blog = await resolveBlog(h, args.blog_id);
        try {
          await api(h, {
            method: 'POST',
            path: `/v2/blog/${blogPath(blog)}/post/delete`,
            body: utf8Bytes(`id=${encodeURIComponent(args.post_id)}`),
            contentType: 'application/x-www-form-urlencoded',
            write: true,
          });
        } catch (error) {
          if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${error.message} Once the post is deleted, get_post finds no such post (HTTP 404).`);
          throw error;
        }
        return { deleted: true, id: args.post_id, blog };
      },
    },
    // The rest of the Tumblr API v2, on the chosen blogs.
    ...apiTools({
      label: 'Tumblr',
      description:
        'The Tumblr API v2 at https://api.tumblr.com/v2, with the connected account\'s token: paths start with /v2/, such as '
        + '/v2/blog/<blog id>/info, /v2/blog/<blog id>/notes (with id in query) or /v2/blog/<blog id>/followers; while blogs are chosen '
        + 'for the connection, a path must name one of them by its id. Reference: https://www.tumblr.com/docs/en/api/v2.',
      basePath: '/v2/',
      accounts: {
        key: 'blogs',
        label: 'blog',
        ids: (request) => (request.segments[1] === 'blog' && request.segments[2] ? [request.segments[2]] : []),
      },
      guard: (request) => {
        if (request.segments[1] === 'oauth2') throw new ToolFailure('Tumblr OAuth endpoints are not available here. Nothing was sent.');
      },
    }),
  ],
});

export = connector;
