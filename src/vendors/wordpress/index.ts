// WordPress (self-hosted), through the REST API of the user's own site
// (https://developer.wordpress.org/rest-api/reference/).
//
// Credentials: `url`, the site's address (with its subdirectory when WordPress
// is installed in one, such as https://example.com/blog), `user`, the
// WordPress login name, and `apppassword`, an application password from Users
// -> Profile -> Application Passwords (WordPress 5.6 or later, over https).
// They go to that site only, as HTTP Basic auth.

import {
  apiTools,
  defineConnector,
  ToolFailure,
  truncate,
  validateArguments,
  type ApiResponse,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { MEDIA_TYPES_TEXT, sniffFile, uploadName } from './media.js';
import {
  basicAuth,
  compact,
  dateFields,
  decodeEntities,
  editLink,
  fieldText,
  installPath,
  isJsonBody,
  phpFieldName,
  plainText,
  rest,
  siteAddress,
  termKey,
  termSearch,
  totalItems,
  totalPages,
  withHint,
} from './site.js';

type JsonSchema = ToolDefinition['inputSchema'];

/** The most a media download may be; the host may allow less. */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
/** How much of a post's content get_post returns at a time, in bytes of the JSON result. */
const CONTENT_BYTES = 22_000;

const TYPE_ROUTES = { post: '/wp/v2/posts', page: '/wp/v2/pages' } as const;
type ItemType = keyof typeof TYPE_ROUTES;

const LIST_FIELDS = 'id,type,status,title,date,modified,slug,link,excerpt,author,categories,tags,featured_media,sticky,parent,menu_order';
const MEDIA_FIELDS = 'id,date,title,source_url,mime_type,media_type,alt_text,post,link,media_details.width,media_details.height,media_details.filesize';

const TYPE_SCHEMA = { type: 'string', enum: ['post', 'page'], default: 'post', description: 'post (default) or page.' } as const;
const CURSOR_SCHEMA = { type: 'string', description: 'nextCursor from the previous result; the other arguments then come from it.' } as const;
const ID_LIST = (what: string): JsonSchema => ({ type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100, uniqueItems: true, description: what });

const POST_FIELDS: Record<string, JsonSchema> = {
  title: { type: 'string', maxLength: 1000, description: 'The title, as plain text.' },
  content: {
    type: 'string',
    maxLength: 2_000_000,
    description: 'The body as HTML (<h2>, <p>, <img src="..."> with media library URLs, <figure>, <table>, ...).',
  },
  excerpt: { type: 'string', maxLength: 5000, description: 'A short summary shown in lists and feeds.' },
  slug: { type: 'string', pattern: '^[A-Za-z0-9%_-]{1,200}$', description: 'The URL slug, e.g. "my-first-post".' },
  status: {
    type: 'string',
    enum: ['draft', 'publish', 'pending', 'private', 'future'],
    description: 'draft (not public), publish (goes live now), pending (waits for an editor), private, or future (published at date).',
  },
  date: {
    type: 'string',
    maxLength: 40,
    description: 'Publication date: 2026-12-01T09:00:00 in the site\'s time zone, or with Z or an offset (+03:00). Needed with status future.',
  },
  categories: ID_LIST('Category ids (posts only), from list_terms or create_term. Replaces the post\'s categories.'),
  tags: ID_LIST('Tag ids (posts only), from list_terms or create_term. Replaces the post\'s tags.'),
  featured_media: { type: 'integer', minimum: 0, description: 'The media id of the featured image (cover), from upload_media; 0 removes it.' },
  author: { type: 'integer', minimum: 1, description: 'The author\'s user id (an Editor or Administrator may set another user).' },
  comment_status: { type: 'string', enum: ['open', 'closed'], description: 'Whether comments are open.' },
  sticky: { type: 'boolean', description: 'Posts only: keep it at the top of the blog page.' },
  parent: { type: 'integer', minimum: 0, description: 'Pages only: the parent page id (0 for none).' },
  menu_order: { type: 'integer', minimum: 0, description: 'Pages only: the order among sibling pages.' },
};

interface PostArgs {
  type: ItemType;
  title?: string;
  content?: string;
  excerpt?: string;
  slug?: string;
  status?: string;
  date?: string;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  author?: number;
  comment_status?: string;
  sticky?: boolean;
  parent?: number;
  menu_order?: number;
}

function invalidCursor(): ToolFailure {
  return new ToolFailure('The cursor is not valid for this tool. Pass the nextCursor value of the previous result unchanged, or leave cursor out to start from the beginning.');
}

interface ListPosition {
  page: number;
  skip: number;
  filters: Record<string, unknown>;
}

/**
 * Where a list continues: page and offset from the cursor, and the list's
 * filters from the cursor too (checked against the tool's schema again), so a
 * page continues the same list; without a cursor, page 1 with the arguments.
 */
function listPosition(h: ToolHelpers, schema: JsonSchema, args: Record<string, unknown>): ListPosition {
  const state = h.cursor(args['cursor'] as string | undefined);
  if (!state) {
    const { cursor: _cursor, ...filters } = args;
    return { page: 1, skip: 0, filters };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(state['f'] ?? '{}'));
  } catch {
    throw invalidCursor();
  }
  const checked = validateArguments(schema, parsed);
  const page = Number(state['p']);
  const skip = Number(state['o']);
  if (!checked.ok || 'cursor' in checked.value || !Number.isInteger(page) || page < 1 || !Number.isInteger(skip) || skip < 0) throw invalidCursor();
  return { page, skip, filters: checked.value };
}

function pageCursors(h: ToolHelpers, position: ListPosition, more: boolean) {
  const f = JSON.stringify(position.filters);
  return {
    resumeAt: (index: number) => h.makeCursor({ p: position.page, o: position.skip + index, f }),
    ...(more ? { nextPage: h.makeCursor({ p: position.page + 1, o: 0, f }) } : {}),
  };
}

function hasMore(response: ApiResponse, page: number, count: number, perPage: number): boolean {
  const pages = totalPages(response);
  return pages !== undefined ? page < pages : count >= perPage;
}

/** Where a part of the text that starts at `start` ends so that its JSON form stays within `maxBytes`. */
function chunkEnd(points: string[], start: number, maxBytes: number): number {
  let bytes = 0;
  let index = start;
  for (; index < points.length; index++) {
    const point = points[index] as string;
    const code = point.codePointAt(0) ?? 0;
    const size = point === '"' || point === '\\' ? 2 : code < 0x20 ? 6 : code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
  }
  return index;
}

function trimPost(h: ToolHelpers, post: any): Record<string, unknown> {
  const isPage = post?.type === 'page';
  return compact({
    id: post?.id,
    type: post?.type,
    status: post?.status,
    title: truncate(fieldText(post?.title) ?? '', 300),
    date: post?.date,
    modified: post?.modified,
    slug: post?.slug,
    link: post?.link,
    edit_link: editLink(h, post?.id),
    excerpt: plainText(post?.excerpt?.rendered ?? post?.excerpt?.raw, 240),
    author: post?.author,
    categories: Array.isArray(post?.categories) && post.categories.length ? post.categories : undefined,
    tags: Array.isArray(post?.tags) && post.tags.length ? post.tags : undefined,
    featured_media: post?.featured_media || undefined,
    sticky: post?.sticky === true ? true : undefined,
    parent: isPage && post?.parent ? post.parent : undefined,
    menu_order: isPage && post?.menu_order ? post.menu_order : undefined,
  });
}

function trimMedia(media: any): Record<string, unknown> {
  return compact({
    id: media?.id,
    date: media?.date,
    title: truncate(fieldText(media?.title) ?? '', 200),
    source_url: media?.source_url,
    mime_type: media?.mime_type,
    media_type: media?.media_type,
    alt_text: media?.alt_text,
    caption: plainText(media?.caption?.raw ?? media?.caption?.rendered, 300),
    width: media?.media_details?.width,
    height: media?.media_details?.height,
    filesize: media?.media_details?.filesize,
    attached_to: media?.post || undefined,
    link: media?.link,
  });
}

function trimTerm(term: any): Record<string, unknown> {
  return compact({
    id: term?.id,
    name: typeof term?.name === 'string' ? decodeEntities(term.name) : undefined,
    slug: term?.slug,
    count: term?.count,
    parent: term?.parent || undefined,
    description: plainText(term?.description, 200),
    link: term?.link,
  });
}

/** The REST body of a post or page from the arguments that were given. */
function postBody(args: PostArgs): Record<string, unknown> {
  const isPage = args.type === 'page';
  const wrongType = (field: string, only: string): never => {
    throw new ToolFailure(`${field} is for ${only} only. Nothing was sent.`);
  };
  if (isPage && (args.categories !== undefined || args.tags !== undefined || args.sticky !== undefined)) wrongType('categories, tags and sticky are', 'posts');
  if (!isPage && (args.parent !== undefined || args.menu_order !== undefined)) wrongType('parent and menu_order are', 'pages');
  if (args.status === 'future' && args.date === undefined) {
    throw new ToolFailure('status future needs date: the time the post goes live. Nothing was sent.');
  }
  const body: Record<string, unknown> = {};
  for (const field of ['title', 'content', 'excerpt', 'slug', 'status', 'categories', 'tags', 'featured_media', 'author', 'comment_status', 'sticky', 'parent', 'menu_order'] as const) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  if (args.date !== undefined) Object.assign(body, dateFields(args.date, 'date'));
  return body;
}

function savedPost(h: ToolHelpers, post: any): Record<string, unknown> {
  return compact({
    ...trimPost(h, post),
    date_gmt: post?.date_gmt,
    note: post?.status === 'draft' || post?.status === 'pending' ? 'Not public yet: it goes live with update_post and status publish.' : undefined,
  });
}

function refuseRequest(sentence: string): never {
  throw new ToolFailure(`${sentence} Nothing was sent.`);
}

/** Refuses REST routes and parameters the generic tools must not reach. */
function restGuard(request: ApiToolRequest): void {
  for (const key of Object.keys(request.query)) {
    // WordPress takes a request's method from _method and its route from rest_route, under the names PHP gives fields.
    if (/^(?:_method|rest_route)/i.test(phpFieldName(key))) {
      refuseRequest(`The query parameter ${JSON.stringify(key)} is not allowed: WordPress would read it as _method or rest_route, which change a request's method or route. Give the route as the path and the method as method.`);
    }
  }
  // WordPress decodes the route once more, so an encoded slash would start a new segment there.
  if (request.segments.some((segment) => /[/\\]/.test(segment))) {
    refuseRequest('A path segment must not hold an encoded slash or backslash (%2F, %5C): give each part of the route as its own segment.');
  }
  const segments = request.segments.map((segment) => segment.toLowerCase());
  if (segments[0] === 'batch') refuseRequest('Batch requests (/batch/v1) cannot be sent through this connector: send each request on its own.');
  if (segments.includes('application-passwords')) refuseRequest('Application passwords cannot be listed or changed through this connector.');
  if (request.method === 'GET' || segments[0] !== 'wp' || segments[1] !== 'v2') return;
  const resource = segments[2];
  if (resource === 'plugins' || resource === 'themes') refuseRequest('Plugins and themes cannot be installed, changed or removed through this connector.');
  if (resource === 'settings') refuseRequest('Site settings cannot be changed through this connector.');
  if (resource === 'users') refuseRequest('Users cannot be created, changed or deleted through this connector.');
}

const LIST_POSTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: TYPE_SCHEMA,
    status: {
      type: 'string',
      enum: ['any', 'publish', 'draft', 'pending', 'future', 'private'],
      default: 'any',
      description: 'any (default: every status but trash), publish, draft, pending, future (scheduled) or private.',
    },
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for in the title and content.' },
    categories: ID_LIST('Only posts in one of these category ids.'),
    tags: ID_LIST('Only posts with one of these tag ids.'),
    author: { type: 'integer', minimum: 1, description: 'Only items by this user id.' },
    after: { type: 'string', maxLength: 40, description: 'Only items published after this date, e.g. 2026-11-01T00:00:00.' },
    before: { type: 'string', maxLength: 40, description: 'Only items published before this date.' },
    orderby: { type: 'string', enum: ['date', 'modified', 'title', 'id', 'slug', 'relevance'], default: 'date', description: 'Sort field (relevance needs search).' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc', description: 'desc (default, newest first) or asc.' },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page, 1 to 100 (default 20).' },
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const LIST_MEDIA_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for in the title, caption or file name.' },
    media_type: { type: 'string', enum: ['image', 'video', 'audio', 'application', 'text'], description: 'Only this kind of file.' },
    mime_type: { type: 'string', pattern: '^[a-z]+/[A-Za-z0-9.+-]+$', description: 'Only this MIME type, e.g. image/png.' },
    attached_to: { type: 'integer', minimum: 0, description: 'Only files attached to this post id (0: unattached).' },
    orderby: { type: 'string', enum: ['date', 'title', 'id'], default: 'date', description: 'Sort field.' },
    order: { type: 'string', enum: ['desc', 'asc'], default: 'desc', description: 'desc (default, newest first) or asc.' },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Files per page, 1 to 100 (default 20).' },
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

const TAXONOMY_SCHEMA = { type: 'string', enum: ['categories', 'tags'], description: 'categories or tags.' } as const;

const LIST_TERMS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    taxonomy: { ...TAXONOMY_SCHEMA, default: 'categories', description: 'categories (default) or tags.' },
    search: { type: 'string', minLength: 1, maxLength: 200, description: 'Part of the name to look for.' },
    slug: { type: 'string', pattern: '^[A-Za-z0-9%_-]{1,200}$', description: 'An exact slug.' },
    parent: { type: 'integer', minimum: 0, description: 'Categories only: only children of this category id (0: top level).' },
    hide_empty: { type: 'boolean', default: false, description: 'Leave out terms that no post uses.' },
    orderby: { type: 'string', enum: ['name', 'count', 'id', 'slug'], default: 'name', description: 'Sort field.' },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Terms per page, 1 to 100 (default 100).' },
    cursor: CURSOR_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * The term WordPress said exists: by its slug, or by its name. A category is
 * looked for under the parent it was to have (0, the top level, by default),
 * since another category may have the same name under another parent.
 */
async function findTerm(h: ToolHelpers, taxonomy: string, name: string, slug: string | undefined, parent: number | undefined): Promise<any> {
  const query = slug ? { slug, per_page: 10 } : { search: termSearch(name), per_page: 100 };
  const { data } = await rest(h, `/wp/v2/${taxonomy}`, { query: { ...query, parent, _fields: 'id,name,slug,count,parent,description,link' } });
  const terms: any[] = Array.isArray(data) ? data : [];
  const wanted = termKey(name);
  return terms.find((term) => (parent === undefined || Number(term?.parent ?? 0) === parent)
    && ((slug !== undefined && term?.slug === slug) || termKey(String(term?.name ?? '')) === wanted));
}

const connector = defineConnector({
  vendor: 'wordpress',
  label: 'WordPress',
  origins: [],
  originFields: ['url'],
  credentials: ['url', 'user', 'apppassword'],
  credentialLabels: { url: 'WordPress URL', user: 'WordPress user name', apppassword: 'WordPress application password' },
  authHeaders: (credentials) => ({ authorization: basicAuth(credentials['user'] ?? '', credentials['apppassword'] ?? '') }),
  tools: [
    {
      name: 'get_site',
      kind: 'read',
      title: 'Get the WordPress site and the connected user',
      description:
        'The connected WordPress site (name, tagline, address, time zone) and the user the application password belongs to, with '
        + 'its roles and what it may do: publish posts, edit others\' posts, publish pages, upload files, manage categories. It also says '
        + 'whether the Rank Math SEO plugin\'s API is there (for set_seo_meta). Use it to check the connection.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data: user } = await rest(h, '/wp/v2/users/me', { query: { context: 'edit', _fields: 'id,username,name,slug,roles,capabilities' } });
        const { data: index } = await rest(h, '/', { query: { _fields: 'name,description,url,home,gmt_offset,timezone_string,namespaces' } });
        const namespaces: string[] = Array.isArray(index?.namespaces) ? index.namespaces.map(String) : [];
        const caps = typeof user?.capabilities === 'object' && user.capabilities !== null ? user.capabilities : {};
        const can = (cap: string): boolean => caps[cap] === true;
        const offset = typeof index?.gmt_offset === 'number' || typeof index?.gmt_offset === 'string' ? Number(index.gmt_offset) : undefined;
        return compact({
          site: compact({
            name: typeof index?.name === 'string' ? decodeEntities(index.name) : undefined,
            tagline: typeof index?.description === 'string' ? decodeEntities(index.description) : undefined,
            url: index?.home ?? index?.url,
            wordpress_address: index?.url !== index?.home ? index?.url : undefined,
            timezone: index?.timezone_string || (offset !== undefined && Number.isFinite(offset) ? `UTC${offset >= 0 ? '+' : ''}${offset}` : undefined),
          }),
          rest_url: `${siteAddress(h)}/wp-json/`,
          user: compact({
            id: user?.id,
            username: user?.username,
            name: user?.name,
            roles: Array.isArray(user?.roles) ? user.roles : undefined,
            can: {
              publish_posts: can('publish_posts'),
              edit_others_posts: can('edit_others_posts'),
              publish_pages: can('publish_pages'),
              upload_files: can('upload_files'),
              manage_categories: can('manage_categories'),
            },
          }),
          rank_math: namespaces.includes('rankmath/v1'),
        });
      },
    },
    {
      name: 'list_posts',
      kind: 'read',
      title: 'List WordPress posts or pages',
      description:
        'Lists the site\'s posts (or pages), newest first by default: drafts, scheduled and published ones, or one status. Each has its '
        + 'id, status, title, dates, link, editor link, excerpt, categories, tags and featured image id. Search words find posts on a '
        + 'topic (to avoid writing the same post twice). Pass nextCursor back as cursor for more.',
      inputSchema: LIST_POSTS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_POSTS_SCHEMA, args);
        const f = position.filters as Record<string, any>;
        const type = (f['type'] ?? 'post') as ItemType;
        if (type === 'page' && (f['categories'] || f['tags'])) throw new ToolFailure('categories and tags are for posts only. Nothing was sent.');
        const response = await rest(h, TYPE_ROUTES[type], {
          query: {
            context: 'view',
            _fields: LIST_FIELDS,
            status: f['status'] ?? 'any',
            search: f['search'],
            categories: f['categories']?.join(','),
            tags: f['tags']?.join(','),
            author: f['author'],
            after: f['after'],
            before: f['before'],
            orderby: f['orderby'] ?? 'date',
            order: f['order'] ?? 'desc',
            per_page: f['per_page'] ?? 20,
            page: position.page,
          },
        });
        const posts: unknown[] = Array.isArray(response.data) ? response.data : [];
        const perPage = Number(f['per_page'] ?? 20);
        return h.page({
          key: type === 'page' ? 'pages' : 'posts',
          items: posts.map((post) => trimPost(h, post)).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, posts.length, perPage)),
        });
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Get a WordPress post or page',
      description:
        'One post (or page) by id, with its raw title, HTML content, excerpt, status, slug, dates, categories, tags, featured image, link '
        + 'and editor link: what update_post needs to edit it. Long content comes in parts of about 20 KB: pass next_content_offset '
        + 'as content_offset for the next part.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The post or page id.' },
          type: TYPE_SCHEMA,
          content_offset: { type: 'integer', minimum: 0, default: 0, description: 'Where the content part starts (default 0).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: { id: number; type: ItemType; content_offset: number }, h) {
        const route = `${TYPE_ROUTES[args.type]}/${args.id}`;
        let post: any;
        try {
          ({ data: post } = await rest(h, route, { query: { context: 'edit' } }));
        } catch (error) {
          // A user who may read a post but not edit it gets the published version.
          if (!(error instanceof ToolFailure) || error.details.status !== 403) throw error;
          ({ data: post } = await rest(h, route, { query: { context: 'view' } }));
        }
        const content: string = typeof post?.content?.raw === 'string' ? post.content.raw : String(post?.content?.rendered ?? '');
        const points = Array.from(content);
        const start = Math.min(args.content_offset, points.length);
        const end = chunkEnd(points, start, CONTENT_BYTES);
        return compact({
          ...trimPost(h, post),
          title: fieldText(post?.title),
          excerpt: fieldText(post?.excerpt),
          date_gmt: post?.date_gmt,
          comment_status: post?.comment_status,
          format: post?.format && post.format !== 'standard' ? post.format : undefined,
          template: post?.template || undefined,
          password_protected: post?.password ? true : undefined,
          content: points.slice(start, end).join(''),
          content_length: points.length,
          content_offset: start > 0 ? start : undefined,
          next_content_offset: end < points.length ? end : undefined,
        });
      },
    },
    {
      name: 'create_post',
      kind: 'create',
      check: 'list_posts',
      title: 'Create a WordPress post or page',
      description:
        'Creates a post (or page). It is a draft unless status says otherwise: publish puts it live at once, future at date. Body as '
        + 'HTML; categories and tags by id (list_terms, create_term); featured_media is a media id from upload_media. Returns the id, '
        + 'link and editor link. Not retried: after an unclear outcome, look for it with list_posts before trying again.',
      inputSchema: {
        type: 'object',
        properties: { type: TYPE_SCHEMA, ...POST_FIELDS, status: { ...POST_FIELDS['status'], default: 'draft' } as JsonSchema },
        required: ['title'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const body = postBody(args);
        const { data } = await rest(h, TYPE_ROUTES[args.type], { method: 'POST', json: body, write: true });
        return savedPost(h, data);
      },
    },
    {
      name: 'update_post',
      kind: 'update',
      check: 'get_post',
      title: 'Update or publish a WordPress post or page',
      description:
        'Changes a post (or page): only the fields given change. status publish puts a draft live; draft takes a post back offline; '
        + 'featured_media sets or replaces the cover (0 removes it). Editing a published post changes it live. Returns the saved post.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1, description: 'The post or page id.' }, type: TYPE_SCHEMA, ...POST_FIELDS },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: PostArgs & { id: number }, h) {
        const body = postBody(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one field besides id and type. Nothing was sent.');
        const { data } = await rest(h, `${TYPE_ROUTES[args.type]}/${args.id}`, { method: 'POST', json: body, write: true });
        return savedPost(h, data);
      },
    },
    {
      name: 'upload_media',
      kind: 'create',
      check: 'list_media',
      title: 'Upload a file to the WordPress media library',
      description:
        `Downloads a file from a public https URL and uploads it to the media library, with alt text, title and caption. Takes ${MEDIA_TYPES_TEXT}, `
        + 'told by the file\'s bytes; the site\'s own upload limit applies. Returns the media id (for featured_media) and its source_url '
        + '(for <img> tags in content).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public https URL of the file.' },
          filename: { type: 'string', maxLength: 120, description: 'The file name to give it (the extension follows the file type). Default: from the URL.' },
          alt_text: { type: 'string', maxLength: 300, description: 'Alt text for an image: what it shows.' },
          title: { type: 'string', maxLength: 200, description: 'The title in the media library.' },
          caption: { type: 'string', maxLength: 500, description: 'A caption.' },
          description: { type: 'string', maxLength: 1000, description: 'A description.' },
          post_id: { type: 'integer', minimum: 1, description: 'Attach the file to this post or page id.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async run(args: { url: string; filename?: string; alt_text?: string; title?: string; caption?: string; description?: string; post_id?: number }, h) {
        const file = await h.media(args.url, { what: 'file', maxBytes: MAX_MEDIA_BYTES });
        const type = sniffFile(file.bytes);
        if (!type) {
          throw new ToolFailure(`The file is not a type the media library takes by default (${MEDIA_TYPES_TEXT}), judging by its content. Nothing was sent to WordPress.`);
        }
        const name = uploadName(args.filename, args.url, type.ext);
        const { data } = await rest(h, '/wp/v2/media', {
          method: 'POST',
          // WordPress reads these from the query string when the body is the file itself.
          query: { alt_text: args.alt_text, title: args.title, caption: args.caption, description: args.description, post: args.post_id },
          headers: { 'content-disposition': `attachment; filename="${name}"` },
          body: file.bytes,
          contentType: type.mime,
          write: true,
          errors: { 413: 'The site refused the file as larger than its upload limit' },
        });
        return trimMedia(data);
      },
    },
    {
      name: 'update_media',
      kind: 'update',
      check: 'list_media',
      title: 'Update a WordPress media item',
      description: 'Changes a media item\'s alt text, title, caption or description, or the post it is attached to. Only the fields given change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The media id.' },
          alt_text: { type: 'string', maxLength: 1000, description: 'Alt text: what the image shows.' },
          title: { type: 'string', maxLength: 500, description: 'The title.' },
          caption: { type: 'string', maxLength: 5000, description: 'The caption.' },
          description: { type: 'string', maxLength: 20000, description: 'The description.' },
          post_id: { type: 'integer', minimum: 0, description: 'Attach it to this post or page id (0 detaches it).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: { id: number; alt_text?: string; title?: string; caption?: string; description?: string; post_id?: number }, h) {
        const body = compact({ alt_text: args.alt_text, title: args.title, caption: args.caption, description: args.description, post: args.post_id });
        if (args.alt_text === '') body['alt_text'] = '';
        if (args.post_id === 0) body['post'] = 0;
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one field besides id. Nothing was sent.');
        const { data } = await rest(h, `/wp/v2/media/${args.id}`, { method: 'POST', json: body, write: true });
        return trimMedia(data);
      },
    },
    {
      name: 'list_media',
      kind: 'read',
      title: 'List the WordPress media library',
      description:
        'Lists files in the media library, newest first: id, title, source URL, type, alt text, size in pixels and bytes, and the post '
        + 'each is attached to. Search words or a type narrow it. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_MEDIA_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_MEDIA_SCHEMA, args);
        const f = position.filters as Record<string, any>;
        const perPage = Number(f['per_page'] ?? 20);
        const response = await rest(h, '/wp/v2/media', {
          query: {
            _fields: MEDIA_FIELDS,
            search: f['search'],
            media_type: f['media_type'],
            mime_type: f['mime_type'],
            parent: f['attached_to'],
            orderby: f['orderby'] ?? 'date',
            order: f['order'] ?? 'desc',
            per_page: perPage,
            page: position.page,
          },
        });
        const media: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: 'media',
          items: media.map(trimMedia).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, media.length, perPage)),
        });
      },
    },
    {
      name: 'list_terms',
      kind: 'read',
      title: 'List WordPress categories or tags',
      description:
        'Lists the site\'s categories or tags with their ids, names, slugs, post counts and parents. Search for a name before '
        + 'creating a term, so none is made twice. Pass nextCursor back as cursor for more.',
      inputSchema: LIST_TERMS_SCHEMA,
      async run(args: Record<string, unknown>, h) {
        const position = listPosition(h, LIST_TERMS_SCHEMA, args);
        const f = position.filters as Record<string, any>;
        const taxonomy = String(f['taxonomy'] ?? 'categories');
        if (taxonomy === 'tags' && f['parent'] !== undefined) throw new ToolFailure('parent is for categories only. Nothing was sent.');
        const perPage = Number(f['per_page'] ?? 100);
        const response = await rest(h, `/wp/v2/${taxonomy}`, {
          query: {
            _fields: 'id,name,slug,count,parent,description,link',
            search: f['search'],
            slug: f['slug'],
            parent: f['parent'],
            hide_empty: f['hide_empty'] ? true : undefined,
            orderby: f['orderby'] ?? 'name',
            per_page: perPage,
            page: position.page,
          },
        });
        const terms: unknown[] = Array.isArray(response.data) ? response.data : [];
        return h.page({
          key: taxonomy,
          items: terms.map(trimTerm).slice(position.skip),
          extra: compact({ total: totalItems(response), page: position.page }),
          ...pageCursors(h, position, hasMore(response, position.page, terms.length, perPage)),
        });
      },
    },
    {
      name: 'create_term',
      kind: 'create',
      check: 'list_terms',
      title: 'Create a WordPress category or tag',
      description:
        'Creates a category or tag and returns its id for create_post. When one with that name (or slug) already exists, WordPress '
        + 'keeps it and this returns the existing one with existing: true, so it is never made twice.',
      inputSchema: {
        type: 'object',
        properties: {
          taxonomy: TAXONOMY_SCHEMA,
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The name.' },
          slug: { type: 'string', pattern: '^[A-Za-z0-9%_-]{1,200}$', description: 'The slug (default: made from the name).' },
          parent: { type: 'integer', minimum: 0, description: 'Categories only: the parent category id.' },
          description: { type: 'string', maxLength: 2000, description: 'A description.' },
        },
        required: ['taxonomy', 'name'],
        additionalProperties: false,
      },
      async run(args: { taxonomy: string; name: string; slug?: string; parent?: number; description?: string }, h) {
        if (args.taxonomy === 'tags' && args.parent !== undefined) throw new ToolFailure('parent is for categories only. Nothing was sent.');
        try {
          const { data } = await rest(h, `/wp/v2/${args.taxonomy}`, {
            method: 'POST',
            json: compact({ name: args.name, slug: args.slug, parent: args.parent, description: args.description }),
            write: true,
          });
          return { ...trimTerm(data), existing: false };
        } catch (error) {
          if (!(error instanceof ToolFailure) || error.details.vendorCode !== 'term_exists') throw error;
        }
        const existing = await findTerm(h, args.taxonomy, args.name, args.slug, args.taxonomy === 'categories' ? args.parent ?? 0 : undefined);
        if (!existing) {
          throw new ToolFailure(`WordPress says this ${args.taxonomy === 'tags' ? 'tag' : 'category'} already exists, but it was not found by name: look for it with list_terms. Nothing was changed.`);
        }
        return { ...trimTerm(existing), existing: true };
      },
    },
    {
      name: 'set_seo_meta',
      kind: 'update',
      check: 'get_post',
      title: 'Set a WordPress post\'s SEO title, description and focus keyword',
      description:
        'Writes the SEO title, meta description and focus keyword of a post or page through the Rank Math SEO plugin\'s own API, the '
        + 'way its editor saves them. When the site does not run Rank Math (or its API), nothing is written and the result says so with '
        + 'applied: false; that is not an error. Only the fields given change.',
      inputSchema: {
        type: 'object',
        properties: {
          post_id: { type: 'integer', minimum: 1, description: 'The post or page id.' },
          focus_keyword: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description: 'The focus keyword; several as one comma-separated text, the main one first ("main keyword,second term").',
          },
          seo_title: { type: 'string', minLength: 1, maxLength: 300, description: 'The title for search results.' },
          meta_description: { type: 'string', minLength: 1, maxLength: 1000, description: 'The meta description for search results (about 120 to 160 characters).' },
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { post_id: number; focus_keyword?: string; seo_title?: string; meta_description?: string }, h) {
        const meta = compact({
          rank_math_focus_keyword: args.focus_keyword,
          rank_math_title: args.seo_title,
          rank_math_description: args.meta_description,
        });
        if (!Object.keys(meta).length) throw new ToolFailure('Nothing to set: give focus_keyword, seo_title or meta_description. Nothing was sent.');
        const skipped = (reason: string) => ({ applied: false, post_id: args.post_id, reason });
        try {
          await rest(h, '/rankmath/v1', { query: { _fields: 'namespace' } });
        } catch (error) {
          if (error instanceof ToolFailure && error.details.status === 404) return skipped('The site does not run the Rank Math SEO plugin (its API is not there), so nothing was written.');
          throw error;
        }
        try {
          await rest(h, '/rankmath/v1/updateMeta', {
            method: 'POST',
            json: { objectType: 'post', objectID: args.post_id, meta },
            write: true,
          });
        } catch (error) {
          if (error instanceof ToolFailure && error.details.status === 404 && error.details.vendorCode === 'rest_no_route') {
            return skipped('The site\'s Rank Math version has no API for saving SEO fields, so nothing was written.');
          }
          throw error;
        }
        return { applied: true, post_id: args.post_id, fields: Object.keys(meta) };
      },
    },
    // The rest of the REST API: comments, revisions, pages' templates, plugin routes, and more.
    ...apiTools({
      label: 'WordPress',
      description:
        'The REST API of the connected WordPress site, as the connected user: a path is a REST route after /wp-json, such as '
        + '/wp/v2/comments, /wp/v2/posts/12/revisions, /wp/v2/media/34 or a plugin\'s own namespace; _fields and context=edit go in '
        + 'query; bodies are JSON (json, or body with a JSON content_type). DELETE moves posts to the trash unless force is true. '
        + 'Application passwords, plugins, themes, users, site settings and batch requests are out of reach. Reference: '
        + 'https://developer.wordpress.org/rest-api/reference/.',
      guard: restGuard,
      send: async (request, h) => {
        if (!isJsonBody(request)) {
          refuseRequest('The body must be JSON: give it as json, or as body with a JSON content_type. A form body is refused, since WordPress could read a route from it.');
        }
        try {
          return await h.api({ ...request, origin: h.originOf('url'), path: `${installPath(h.credentials['url'])}/wp-json${request.path}` });
        } catch (error) {
          throw withHint(error);
        }
      },
      responseHeaders: ['x-wp-total', 'x-wp-totalpages'],
    }),
  ],
});

export = connector;
