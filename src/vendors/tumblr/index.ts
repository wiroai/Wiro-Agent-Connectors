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
const MAX_TEXT_BLOCK = 4096;
const MAX_IMAGES = 30;
const MAX_LINKS = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GIF_BYTES = 10 * 1024 * 1024;
const BLOG_ARGUMENT = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 200,
  description: 'The blog: its id (t:...) from list_blogs, or its name. Optional when exactly one blog is chosen for the connection.',
};
const POST_ID = { type: 'string' as const, pattern: '^\\d{1,25}$', description: 'The post id, from list_posts or create_post.' };
const ERRORS = {
  400: 'Tumblr did not accept the request (check the JSON, the content blocks, the image URLs and that publish_on is in the future)',
  403: 'Tumblr refused: this account may not post to this blog (it may have left a group blog, or the blog was deleted)',
  404: 'Tumblr found no such blog or post',
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
  upload_images: { type: 'boolean' as const, default: false, description: 'Download the images and upload them with the post, instead of letting Tumblr fetch them by URL (default false). Use it when Tumblr refuses an image URL.' },
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

function checkBlocks(blocks: Array<Record<string, unknown>>): void {
  let images = 0;
  let links = 0;
  blocks.forEach((block, index) => {
    const type = block['type'];
    if (typeof type !== 'string') throw new ToolFailure(`content[${index}] has no type: each block is like {"type": "text", "text": "..."}. Nothing was sent.`);
    if (type === 'text') {
      const text = block['text'];
      if (typeof text !== 'string') throw new ToolFailure(`content[${index}] is a text block without text. Nothing was sent.`);
      if (codePoints(text) > MAX_TEXT_BLOCK) {
        throw new ToolFailure(`content[${index}] has ${formatNumber(codePoints(text))} characters; Tumblr allows ${formatNumber(MAX_TEXT_BLOCK)} per text block: split it. Nothing was sent.`);
      }
    } else if (type === 'image') {
      images++;
      const alt = block['alt_text'];
      if (typeof alt !== 'string' || !alt.trim()) throw new ToolFailure(`content[${index}] is an image without alt_text: say what it shows. Nothing was sent.`);
    } else if (type === 'link') {
      links++;
    }
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
  for (const [index, image] of (args.images ?? []).entries()) {
    let media: Record<string, unknown>;
    if (args.upload_images) {
      const what = (args.images?.length ?? 0) > 1 ? `image ${index + 1}` : 'image';
      const { bytes } = await h.media(image.url, { what, maxBytes: MAX_IMAGE_BYTES, accept: 'image/jpeg,image/png,image/gif,image/webp' });
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
      description: 'Returns one post of a blog in the Neue Post Format: its state, tags, content blocks and layout, and a queued post\'s time. update_post edits it.',
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
        const { data } = await api(h, { path: `/v2/blog/${blogPath(blog)}/posts/${args.post_id}`, query: { post_format: 'npf' } });
        const post = data?.response ?? {};
        return compact({
          ...trimPost(post),
          blog,
          publish_on: post.publish_on || undefined,
          slug: post.slug || undefined,
          tags: tagList(post.tags) ?? [],
          content: Array.isArray(post.content) ? post.content : undefined,
          layout: Array.isArray(post.layout) && post.layout.length ? post.layout : undefined,
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
      async run(args: ContentArgs & { blog_id?: string; state: (typeof STATES)[number] }, h) {
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
        const { data } = await api(h, { method: 'POST', path: `/v2/blog/${blogPath(blog)}/posts`, ...postBody(body, built.files), write: true });
        const id = data?.response?.id !== undefined ? String(data.response.id) : undefined;
        const result: Record<string, unknown> = compact({ id, blog, state: data?.response?.state ?? args.state, publish_on: publishOn });
        if (id && args.state === 'published') {
          // The link of a published post, read back; the post exists either way.
          try {
            const read = await api(h, { path: `/v2/blog/${blogPath(blog)}/posts`, query: { id, npf: true } });
            const post = Array.isArray(read.data?.response?.posts) ? read.data.response.posts[0] : undefined;
            if (typeof post?.post_url === 'string') result['post_url'] = post.post_url;
          } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
            result['note'] = 'The post was created, but its link could not be read: list_posts shows it.';
          }
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
        + 'Tumblr replaces a post whole, so the tool reads the post first and keeps what is not given; new content replaces all blocks. '
        + 'A queued post keeps its time unless publish_on is given. Editing a published post changes it live. Older posts not made in '
        + 'the Neue Post Format must be edited on Tumblr.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ARGUMENT,
          post_id: POST_ID,
          state: { type: 'string', enum: [...STATES], description: 'The new state: published, draft, queue or private.' },
          ...CONTENT_FIELDS,
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: ContentArgs & { blog_id?: string; post_id: string; state?: (typeof STATES)[number] }, h) {
        const blog = await resolveBlog(h, args.blog_id);
        const built = await buildContent(h, args);
        const changes = built || args.state || args.tags || args.publish_on || args.slug || args.source_url;
        if (!changes) throw new ToolFailure('Nothing to change: give state, tags, publish_on, slug, source_url or new content. Nothing was changed.');
        const path = `/v2/blog/${blogPath(blog)}/posts/${args.post_id}`;
        const { data } = await api(h, { path, query: { post_format: 'npf' } });
        const current = data?.response ?? {};
        if (!Array.isArray(current.content)) {
          throw new ToolFailure('This post is not in the Neue Post Format, so Tumblr does not let it be edited here: edit it on Tumblr. Nothing was changed.');
        }
        const state = args.state ?? stateFor(current.state);
        if (!state || !(STATES as readonly string[]).includes(state)) {
          // Never guess: a draft edited as published would go live.
          throw new ToolFailure('Tumblr did not say which state the post is in: give state (published, draft, queue or private) with the edit. Nothing was changed.');
        }
        if (args.publish_on !== undefined && state !== 'queue') throw new ToolFailure('publish_on goes with state queue. Nothing was changed.');
        const publishOn = args.publish_on !== undefined
          ? futureTime(args.publish_on)
          : state === 'queue' ? (current.publish_on || (typeof current.scheduled_publish_time === 'number' ? new Date(current.scheduled_publish_time * 1000).toISOString() : undefined)) : undefined;
        const body = compact({
          content: built ? built.content : current.content,
          layout: built ? (args.layout ?? []) : (Array.isArray(current.layout) ? current.layout : []),
          state,
          publish_on: publishOn,
          // Tags Tumblr did not send back are left out rather than cleared.
          tags: args.tags ? args.tags.join(',') : tagList(current.tags)?.join(','),
          slug: args.slug,
          source_url: args.source_url,
        });
        await api(h, { method: 'PUT', path, ...postBody(body, built?.files ?? []), write: true, errors: { 400: 'Tumblr did not accept the edit (an older post must be edited on Tumblr; check the blocks and that publish_on is in the future)' } });
        return compact({ id: args.post_id, blog, state, publish_on: publishOn, tags: typeof body['tags'] === 'string' && body['tags'] ? body['tags'].split(',') : undefined, content_blocks: (body['content'] as unknown[]).length });
      },
    },
    {
      name: 'delete_post',
      kind: 'delete',
      check: 'list_posts',
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
        await api(h, {
          method: 'POST',
          path: `/v2/blog/${blogPath(blog)}/post/delete`,
          body: utf8Bytes(`id=${encodeURIComponent(args.post_id)}`),
          contentType: 'application/x-www-form-urlencoded',
          write: true,
        });
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
