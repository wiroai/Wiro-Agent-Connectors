// Blogger, through the Blogger API v3
// (https://developers.google.com/blogger/docs/3.0/reference).
//
// Credential: `access_token`, an OAuth 2.0 access token of the Google account
// that owns the blog or writes for it, with the scope
// https://www.googleapis.com/auth/blogger. The host refreshes it; the module
// sends it to https://www.googleapis.com/blogger/v3/ only.
//
// Account picker `blogs` (list_blogs): the blogs the agent may work on. New
// posts and pages are saved as drafts; publish_post makes a post live or
// schedules it. The API has no image upload: images go into the HTML by URL.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  jsonSize,
  requireAccounts,
  ToolFailure,
  truncate,
  type ApiRequest,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { compact, count, cursorNumber, fitTextPart, googleApi, utcTime } from './google.js';

type Schema = ToolDefinition['inputSchema'];
type Kind = 'post' | 'page';

const BASE = '/blogger/v3';
/** The most room the fields besides the body take in a get_post or get_page result, so every part carries at least 16 KB of body. */
const REST_BYTES = 16 * 1024;
/** The most image URLs get_post lists (with the first part of the body). */
const MAX_IMAGES = 20;
/** The highest offset a list cursor may carry. */
const MAX_OFFSET = 100_000;
const ID = '^[0-9]{1,30}$';
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$';
const POST_STATUSES = { draft: 'DRAFT', scheduled: 'SCHEDULED', live: 'LIVE' } as const;
const PAGE_STATUSES = { draft: 'DRAFT', live: 'LIVE' } as const;
const POST_FIELDS = 'id,title,status,labels,published,updated,url,replies/totalItems,author/displayName';
const PAGE_FIELDS = 'id,title,status,published,updated,url,author/displayName';
const VIEW_HELP =
  'Blogger refused the request. A Google account that is only an author on this blog must use view "author"; '
  + 'otherwise check that the account still has access to the blog and that the Blogger API is enabled for the app';

const BLOG_ID: Schema = {
  type: 'string',
  pattern: ID,
  description: 'The blog id, a long number from list_blogs. Leave out when the connection has one blog.',
};
const VIEW: Schema = {
  type: 'string',
  enum: ['admin', 'author'],
  default: 'admin',
  description: 'admin (default) shows every status; a Google account that is only an author on the blog uses author.',
};
const CURSOR: Schema = { type: 'string', description: 'nextCursor from the previous result (send the same filters with it).' };
const TITLE: Schema = { type: 'string', minLength: 1, maxLength: 500, description: 'The title, plain text.' };
const CONTENT: Schema = {
  type: 'string',
  maxLength: 1_000_000,
  description:
    'The body as HTML: <p>, <h2>, <h3>, lists, <a href>, <blockquote>, <table>, <figure> and <img src="https://..." alt="..."> '
    + '(images by public https URL only; the API has no upload). Do not repeat the title in the body.',
};
const LABELS: Schema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^,]+$' },
  maxItems: 50,
  uniqueItems: true,
  description: "Labels (Blogger's tags), replacing the post's list: a few short ones. Blogger refuses labels that together run past about 200 characters.",
};
const CONTENT_OFFSET: Schema = {
  type: 'integer',
  minimum: 0,
  default: 0,
  description: 'Where to start reading the body: 0, or next_content_offset from the previous result for a long body.',
};

interface EntryArgs {
  blog_id?: string;
  title?: string;
  content?: string;
  labels?: string[];
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

function blogPath(blogId: string): string {
  return `${BASE}/blogs/${encodeURIComponent(blogId)}`;
}

function collection(kind: Kind): 'posts' | 'pages' {
  return kind === 'post' ? 'posts' : 'pages';
}

function editUrl(kind: Kind, blogId: string, id: unknown): string | undefined {
  return typeof id === 'string' && /^[0-9]+$/.test(id) ? `https://www.blogger.com/blog/${kind}/edit/${blogId}/${id}` : undefined;
}

/** The fields an agent needs from a post or a page, without the body. */
function trimEntry(entry: any, blogId: string, kind: Kind): Record<string, unknown> {
  const id = typeof entry?.id === 'string' ? entry.id : entry?.id !== undefined ? String(entry.id) : undefined;
  return compact({
    id,
    title: text(entry?.title, 300),
    status: typeof entry?.status === 'string' ? entry.status.toLowerCase() : undefined,
    labels: kind === 'post' && Array.isArray(entry?.labels) ? entry.labels.map((label: unknown) => String(label)) : undefined,
    published: entry?.published,
    updated: entry?.updated,
    url: entry?.url,
    comments: count(entry?.replies?.totalItems),
    author: text(entry?.author?.displayName, 200),
    edit_url: editUrl(kind, blogId, id),
  });
}

/** The blogs of the connected Google account, from Blogger. */
async function userBlogs(h: ToolHelpers): Promise<any[]> {
  const { data } = await googleApi(h, {
    path: `${BASE}/users/self/blogs`,
    query: { fields: 'items(id,name,description,url,published,updated,posts/totalItems,pages/totalItems)' },
  });
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * The blog a call works on: blog_id when given (it must be a chosen blog),
 * else the only blog chosen for the connection, or with no account lock the
 * only blog of the account.
 */
async function resolveBlog(h: ToolHelpers, blogId: string | undefined): Promise<string> {
  if (blogId) {
    requireAccounts(h.ctx.accounts, 'blogs', blogId, 'blog');
    return blogId;
  }
  const allowed = allowedAccounts(h.ctx.accounts, 'blogs');
  if (allowed !== null) {
    if (allowed.length === 1) return allowed[0] as string;
    if (!allowed.length) throw new ToolFailure('No Blogger blog is chosen for this connection yet. Nothing was sent.');
    throw new ToolFailure(`Several blogs are chosen for this connection (${allowed.join(', ')}): give blog_id. Nothing was sent.`);
  }
  const blogs = await userBlogs(h);
  if (blogs.length === 1 && blogs[0]?.id !== undefined) return String(blogs[0].id);
  if (!blogs.length) throw new ToolFailure('The connected Google account owns or writes for no Blogger blog. Nothing was sent.');
  throw new ToolFailure(`The connected account has ${blogs.length} blogs: give blog_id (list_blogs lists them). Nothing was sent.`);
}

/** The body fields of a create or an update, from the arguments given. */
function entryBody(args: EntryArgs, kind: Kind): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body['title'] = args.title;
  if (args.content !== undefined) body['content'] = args.content;
  if (kind === 'post' && args.labels !== undefined) body['labels'] = args.labels;
  return body;
}

function listTool(kind: Kind): ToolDefinition {
  const statuses = kind === 'post' ? POST_STATUSES : PAGE_STATUSES;
  const names = Object.keys(statuses);
  return {
    name: `list_${collection(kind)}`,
    kind: 'read',
    title: kind === 'post' ? 'List Blogger posts' : 'List Blogger pages',
    description: kind === 'post'
      ? 'Lists the posts of a Blogger blog, newest first: drafts, scheduled and live posts (status picks which), with each '
        + "post's id, title, status, labels, times (a scheduled post's published time is when it goes live), public URL, editor "
        + 'link and comment count, without the body. Filter by labels or a time range. Pass nextCursor back as cursor for more.'
      : 'Lists the pages of a Blogger blog (About, Contact and the like): drafts and live pages, with each page\'s id, title, '
        + 'status, times, public URL and editor link, without the body. Pass nextCursor back as cursor for more.',
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        status: {
          type: 'array',
          items: { type: 'string', enum: names },
          minItems: 1,
          uniqueItems: true,
          default: names,
          description: `Which ${collection(kind)}: ${names.join(', ')} (default all of them).`,
        },
        ...(kind === 'post'
          ? {
            labels: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^,]+$' },
              maxItems: 20,
              uniqueItems: true,
              description: 'Only posts with these labels.',
            },
            order_by: { type: 'string', enum: ['published', 'updated'], default: 'published', description: 'Sort by published time (default) or last update.' },
            ascending: { type: 'boolean', default: false, description: 'Oldest first instead of newest first.' },
            start_date: { type: 'string', pattern: TIME, description: 'Only posts published at or after this RFC 3339 time.' },
            end_date: { type: 'string', pattern: TIME, description: 'Only posts published before this RFC 3339 time.' },
          }
          : {}),
        max_results: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: `${kind === 'post' ? 'Posts' : 'Pages'} per page, 1 to 50 (default 20).` },
        view: VIEW,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    async run(args: {
      blog_id?: string;
      status: string[];
      labels?: string[];
      order_by?: string;
      ascending?: boolean;
      start_date?: string;
      end_date?: string;
      max_results: number;
      view: string;
      cursor?: string;
    }, h) {
      const state = h.cursor(args.cursor);
      const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
      const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
      const max = cursorNumber(state, 'n', args.max_results, 1, 50);
      const blogId = await resolveBlog(h, args.blog_id);
      const query: ApiRequest['query'] = {
        status: args.status.map((status) => (statuses as Record<string, string>)[status] as string),
        view: args.view.toUpperCase(),
        fetchBodies: false,
        maxResults: max,
        pageToken,
        fields: `nextPageToken,items(${kind === 'post' ? POST_FIELDS : PAGE_FIELDS})`,
      };
      if (kind === 'post') {
        Object.assign(query, {
          fetchImages: false,
          labels: args.labels?.length ? args.labels.join(',') : undefined,
          orderBy: (args.order_by ?? 'published').toUpperCase(),
          sortOption: args.ascending ? 'ASCENDING' : 'DESCENDING',
          startDate: args.start_date ? utcTime(args.start_date, 'start_date') : undefined,
          endDate: args.end_date ? utcTime(args.end_date, 'end_date') : undefined,
        });
      }
      const { data } = await googleApi(h, { path: `${blogPath(blogId)}/${collection(kind)}`, query, errors: { 403: VIEW_HELP } });
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      return h.page({
        key: collection(kind),
        items: items.map((item) => trimEntry(item, blogId, kind)).slice(skip),
        extra: { blog_id: blogId },
        resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: max }),
        ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: max }) } : {}),
      });
    },
  };
}

function getTool(kind: Kind): ToolDefinition {
  return {
    name: `get_${kind}`,
    kind: 'read',
    title: kind === 'post' ? 'Get a Blogger post' : 'Get a Blogger page',
    description:
      `Reads one ${kind} of a Blogger blog with its HTML body: id, title, status, ${kind === 'post' ? 'labels, ' : ''}times, public URL, `
      + `editor link${kind === 'post' ? ', the image URLs (with the first part)' : ''} and the body. A long body comes in parts: when `
      + 'next_content_offset is set, call again with content_offset set to it and join the parts before editing the body.',
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        [`${kind}_id`]: { type: 'string', pattern: ID, description: `The ${kind} id, from list_${collection(kind)}.` },
        include_body: { type: 'boolean', default: true, description: 'Return the body (default true).' },
        content_offset: CONTENT_OFFSET,
        view: VIEW,
      },
      required: [`${kind}_id`],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, h) {
      const blogId = await resolveBlog(h, args['blog_id']);
      const id = String(args[`${kind}_id`]);
      const includeBody = args['include_body'] !== false;
      const query: ApiRequest['query'] = { view: String(args['view']).toUpperCase() };
      if (kind === 'post') Object.assign(query, { fetchBody: includeBody, fetchImages: true });
      const { data } = await googleApi(h, {
        path: `${blogPath(blogId)}/${collection(kind)}/${encodeURIComponent(id)}`,
        query,
        errors: { 403: VIEW_HELP, 404: `Blogger found no ${kind} ${id} on this blog` },
      });
      const entry: Record<string, unknown> = { blog_id: blogId, ...trimEntry(data, blogId, kind) };
      const offset = Number(args['content_offset'] ?? 0);
      let images: string[] = kind === 'post' && offset === 0 && Array.isArray(data?.images)
        ? data.images.map((image: any) => image?.url).filter((url: unknown): url is string => typeof url === 'string').slice(0, MAX_IMAGES)
        : [];
      const content = includeBody && typeof data?.content === 'string' ? data.content as string : undefined;
      const build = (part: string, next: number | undefined): Record<string, unknown> => ({
        ...entry,
        ...(images.length ? { images } : {}),
        ...(content !== undefined
          ? { content_length: content.length, content: part, ...(next !== undefined ? { next_content_offset: next } : {}) }
          : {}),
      });
      if (content === undefined) return build('', undefined);
      // The fields besides the body keep to REST_BYTES (fewer image URLs if need be); the body part gets the rest of
      // the 32 KB, counted as JSON, so the parts join up to the whole body.
      while (images.length && jsonSize(build('', content.length)) > REST_BYTES) images = images.slice(0, -1);
      return fitTextPart(content, offset, build);
    },
  };
}

function createTool(kind: Kind): ToolDefinition {
  return {
    name: `create_draft_${kind}`,
    kind: 'create',
    check: `list_${collection(kind)}`,
    title: kind === 'post' ? 'Save a Blogger post as a draft' : 'Save a Blogger page as a draft',
    description:
      `Saves a new ${kind} on a Blogger blog as a draft: nothing becomes public. Returns its id and its editor link. `
      + (kind === 'post'
        ? 'Publish it later with publish_post, now or at a set time. '
        : 'Publish it later with publish_page. ')
      + 'Sent once: when the outcome is unclear, look for the draft before trying again.',
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        title: TITLE,
        content: { ...CONTENT, minLength: 1 },
        ...(kind === 'post' ? { labels: LABELS } : {}),
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    async run(args: EntryArgs, h) {
      const blogId = await resolveBlog(h, args.blog_id);
      const { data } = await googleApi(h, {
        method: 'POST',
        path: `${blogPath(blogId)}/${collection(kind)}`,
        query: { isDraft: true, ...(kind === 'post' ? { fetchBody: false, fetchImages: false } : {}) },
        json: { kind: `blogger#${kind}`, ...entryBody(args, kind) },
        write: true,
        errors: { 403: VIEW_HELP },
      });
      return {
        blog_id: blogId,
        ...trimEntry(data, blogId, kind),
        // Blogger answers with the draft; the status of an insert is DRAFT.
        status: typeof data?.status === 'string' ? data.status.toLowerCase() : 'draft',
      };
    },
  };
}

function updateTool(kind: Kind): ToolDefinition {
  return {
    name: `update_${kind}`,
    kind: 'update',
    check: `get_${kind}`,
    title: kind === 'post' ? 'Update a Blogger post' : 'Update a Blogger page',
    description:
      `Changes a ${kind} of a Blogger blog: only the fields given change. content replaces the whole body${kind === 'post' ? ' and labels the whole list' : ''}: `
      + `to change part of the body, read it with get_${kind} first and send the edited text. A draft can be changed freely; `
      + `changing a live ${kind} changes the public page at once.`,
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        [`${kind}_id`]: { type: 'string', pattern: ID, description: `The ${kind} id.` },
        title: TITLE,
        content: CONTENT,
        ...(kind === 'post' ? { labels: LABELS } : {}),
      },
      required: [`${kind}_id`],
      additionalProperties: false,
    },
    async run(args: EntryArgs & Record<string, any>, h) {
      const body = entryBody(args, kind);
      if (!Object.keys(body).length) {
        throw new ToolFailure(`Nothing to change: give title, content${kind === 'post' ? ' or labels' : ''}. Nothing was changed.`);
      }
      const blogId = await resolveBlog(h, args.blog_id);
      const id = String(args[`${kind}_id`]);
      const { data } = await googleApi(h, {
        method: 'PATCH',
        path: `${blogPath(blogId)}/${collection(kind)}/${encodeURIComponent(id)}`,
        query: kind === 'post' ? { fetchBody: false, fetchImages: false } : {},
        json: body,
        write: true,
        errors: { 403: VIEW_HELP, 404: `Blogger found no ${kind} ${id} on this blog` },
      });
      return { blog_id: blogId, ...trimEntry(data, blogId, kind) };
    },
  };
}

/** publish and revert: a POST without a body to /<id>/publish or /<id>/revert. */
function stateTool(kind: Kind, action: 'publish' | 'revert'): ToolDefinition {
  const scheduling = kind === 'post' && action === 'publish';
  return {
    name: `${action}_${kind}`,
    kind: 'update',
    check: `get_${kind}`,
    title: action === 'publish'
      ? (kind === 'post' ? 'Publish or schedule a Blogger post' : 'Publish a Blogger page')
      : (kind === 'post' ? 'Turn a Blogger post back into a draft' : 'Turn a Blogger page back into a draft'),
    description: action === 'publish'
      ? (scheduling
        ? 'Publishes a draft post on the blog, right away or, with publish_at, at that time (it is then scheduled and goes live on '
          + 'its own; a past time back-dates it). Returns its status and public URL. It becomes public: publish only what was approved.'
        : 'Publishes a draft page on the blog, right away. Returns its status and public URL. It becomes public: publish only what was approved.')
      : `Takes a live${kind === 'post' ? ' or scheduled' : ''} ${kind} off the blog and keeps it as a draft. Readers no longer see it.`,
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        [`${kind}_id`]: { type: 'string', pattern: ID, description: `The ${kind} id.` },
        ...(scheduling
          ? { publish_at: { type: 'string', pattern: TIME, description: 'When the post goes live, as an RFC 3339 time such as 2026-12-01T09:00:00Z. Leave out to publish now.' } }
          : {}),
      },
      required: [`${kind}_id`],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, h) {
      const publishAt = scheduling && typeof args['publish_at'] === 'string' ? utcTime(args['publish_at'], 'publish_at') : undefined;
      const blogId = await resolveBlog(h, args['blog_id']);
      const id = String(args[`${kind}_id`]);
      const { data } = await googleApi(h, {
        method: 'POST',
        path: `${blogPath(blogId)}/${collection(kind)}/${encodeURIComponent(id)}/${action}`,
        query: { publishDate: publishAt },
        write: true,
        errors: { 403: VIEW_HELP, 404: `Blogger found no ${kind} ${id} on this blog` },
      });
      const result: Record<string, unknown> = { blog_id: blogId, ...trimEntry(data, blogId, kind) };
      if (publishAt && Date.parse(publishAt) > Date.now()) {
        result['note'] = `Scheduled: Blogger publishes it at ${publishAt} (UTC). Read it with get_post to see status "scheduled".`;
      }
      return result;
    },
  };
}

function deleteTool(kind: Kind): ToolDefinition {
  return {
    name: `delete_${kind}`,
    kind: 'delete',
    check: `get_${kind}`,
    title: kind === 'post' ? 'Delete a Blogger post' : 'Delete a Blogger page',
    description:
      `Deletes a ${kind} of a Blogger blog. A live${kind === 'post' ? ' or scheduled' : ''} ${kind} goes to the blog's trash, where it can be `
      + 'restored in Blogger; a draft cannot go to the trash and is deleted for good. Check its status with '
      + `get_${kind} first and delete only what was approved.`,
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: BLOG_ID,
        [`${kind}_id`]: { type: 'string', pattern: ID, description: `The ${kind} id.` },
      },
      required: [`${kind}_id`],
      additionalProperties: false,
    },
    async run(args: Record<string, any>, h) {
      const blogId = await resolveBlog(h, args['blog_id']);
      const id = String(args[`${kind}_id`]);
      await googleApi(h, {
        method: 'DELETE',
        path: `${blogPath(blogId)}/${collection(kind)}/${encodeURIComponent(id)}`,
        query: { useTrash: true },
        write: true,
        errors: { 403: VIEW_HELP, 404: `Blogger found no ${kind} ${id} on this blog` },
      });
      return { deleted: true, blog_id: blogId, [`${kind}_id`]: id };
    },
  };
}

/** The blog a generic request acts on: the path segment after "blogs". */
function blogIds(request: ApiToolRequest): string[] {
  const at = request.segments.indexOf('blogs');
  const id = at === -1 ? undefined : request.segments[at + 1];
  return id ? [id] : [];
}

const connector = defineConnector({
  vendor: 'blogger',
  label: 'Blogger',
  origins: ['https://www.googleapis.com'],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Blogger access token' },
  accountPickers: [
    {
      key: 'blogs',
      label: 'Blogger blogs',
      description: 'The blogs the agent may write for.',
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
      title: 'List Blogger blogs',
      description:
        'Lists the Blogger blogs the connected Google account owns or writes for (only the ones chosen for this connection, '
        + 'when a choice was made): id, name, public URL and the number of posts and pages.',
      inputSchema: {
        type: 'object',
        properties: { cursor: { type: 'string', description: 'nextCursor from the previous result.' } },
        additionalProperties: false,
      },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const allowed = allowedAccounts(h.ctx.accounts, 'blogs');
        const blogs = (await userBlogs(h))
          .map((blog) => compact({
            id: blog?.id !== undefined ? String(blog.id) : undefined,
            name: text(blog?.name, 300),
            url: blog?.url,
            description: text(blog?.description, 300),
            posts: count(blog?.posts?.totalItems),
            pages: count(blog?.pages?.totalItems),
            updated: blog?.updated,
          }))
          .filter((blog) => allowed === null || allowed.includes(String(blog['id'])));
        return h.page({
          key: 'blogs',
          items: blogs.slice(skip),
          ...(allowed !== null && !allowed.length ? { extra: { note: 'No blog is chosen for this connection yet.' } } : {}),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    listTool('post'),
    getTool('post'),
    {
      name: 'search_posts',
      kind: 'read',
      title: 'Search Blogger posts',
      description:
        'Finds live posts of a Blogger blog by words in their title or text, with each post\'s id, title, labels, times, public URL '
        + 'and editor link (no body). Blogger returns the best matches only; there are no further pages.',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ID,
          query: { type: 'string', minLength: 1, maxLength: 500, description: 'The words to search for.' },
          order_by: { type: 'string', enum: ['published', 'updated'], description: 'Sort by published time (default) or last update, newest first.' },
          cursor: CURSOR,
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { blog_id?: string; query: string; order_by?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const blogId = await resolveBlog(h, args.blog_id);
        const { data } = await googleApi(h, {
          path: `${blogPath(blogId)}/posts/search`,
          query: {
            q: args.query,
            fetchBodies: false,
            orderBy: args.order_by?.toUpperCase(),
            fields: `items(${POST_FIELDS})`,
          },
        });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        return h.page({
          key: 'posts',
          items: items.map((item) => trimEntry(item, blogId, 'post')).slice(skip),
          extra: { blog_id: blogId },
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'list_labels',
      kind: 'read',
      title: 'List the labels of a Blogger blog',
      description:
        "Counts the labels of the blog's live posts, most used first, so new posts can reuse them. It reads the newest posts "
        + '(posts_to_scan, default 200).',
      inputSchema: {
        type: 'object',
        properties: {
          blog_id: BLOG_ID,
          posts_to_scan: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: 'How many of the newest live posts to read, 1 to 500 (default 200).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { blog_id?: string; posts_to_scan: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = cursorNumber(state, 'o', 0, 0, MAX_OFFSET);
        const blogId = await resolveBlog(h, args.blog_id);
        const { data } = await googleApi(h, {
          path: `${blogPath(blogId)}/posts`,
          query: { fetchBodies: false, fetchImages: false, maxResults: args.posts_to_scan, fields: 'items(labels)' },
        });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        const counts = new Map<string, number>();
        for (const item of items) {
          for (const label of Array.isArray(item?.labels) ? item.labels : []) {
            const name = String(label);
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
        }
        const labels = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, posts]) => ({ label: truncate(label, 200), posts }));
        return h.page({
          key: 'labels',
          items: labels.slice(skip),
          extra: { blog_id: blogId, posts_scanned: items.length },
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    createTool('post'),
    updateTool('post'),
    stateTool('post', 'publish'),
    stateTool('post', 'revert'),
    deleteTool('post'),
    listTool('page'),
    getTool('page'),
    createTool('page'),
    updateTool('page'),
    stateTool('page', 'publish'),
    stateTool('page', 'revert'),
    deleteTool('page'),
    // The rest of the Blogger API: comments, page views, posts by path.
    ...apiTools({
      label: 'Blogger',
      description:
        'The Blogger API v3 at https://www.googleapis.com/blogger/v3, with the connected Google account: paths start with /blogger/v3/, '
        + 'such as /blogger/v3/blogs/BLOG_ID/comments, /blogger/v3/blogs/BLOG_ID/pageviews (range in query: 7DAYS, 30DAYS or all), '
        + '/blogger/v3/blogs/BLOG_ID/posts/POST_ID/comments or /blogger/v3/blogs/BLOG_ID/posts/POST_ID/comments/COMMENT_ID/approve. '
        + 'With a blog choice in place, a path must name a chosen blog. Reference: https://developers.google.com/blogger/docs/3.0/reference.',
      basePath: '/blogger/v3/',
      accounts: { key: 'blogs', label: 'blog', ids: blogIds },
      send: (request, h) => googleApi(h, request),
    }),
  ],
});

export = connector;
