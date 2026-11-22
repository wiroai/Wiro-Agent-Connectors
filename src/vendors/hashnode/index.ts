// Hashnode, through its GraphQL API at https://gql-beta.hashnode.com
// (https://github.com/Hashnode/gql-skill has the schema).
//
// Credentials: `token`, a Personal Access Token from Hashnode → Account
// Settings → Developer (https://hashnode.com/settings/developer), sent as is in
// the Authorization header to the GraphQL endpoint only; and `publicationhost`,
// the address of the blog to publish to (yourname.hashnode.dev or a custom
// domain). Since May 13, 2026 Hashnode's API answers only for blogs on
// Hashnode Pro, reads and writes alike. Every read is a GraphQL query sent by
// POST, which changes nothing; posts and drafts are never deleted here.

import { defineConnector, OutcomeUnknown, ToolFailure, type ToolHelpers } from '../../core/index.js';
import {
  compact,
  documentWords,
  failFromErrors,
  fitAnswer,
  gql,
  type GqlResult,
  operationTypes,
  rootField,
  TEXT_WINDOW_BYTES,
  textWindow,
  warningsOf,
} from './graphql.js';

const DRAFT_FIELDS = 'id title subtitle slug updatedAt canonicalUrl coverImage { url } tags { slug } series { name }';
const POST_FIELDS = 'id title slug url publishedAt';

const PUBLICATION = 'query Publication($host: String!) { publication(host: $host) { id title url isTeam } }';
const ME = 'query Me { me { id username publications(first: 50) { edges { node { id title url } } } } }';
const POSTS = `query Posts($host: String!, $first: Int!, $after: String) { publication(host: $host) { id title
  posts(first: $first, after: $after) { totalDocuments pageInfo { hasNextPage endCursor } edges { node {
    id title slug url publishedAt updatedAt views reactionCount responseCount replyCount readTimeInMinutes tags { slug } series { name } } } } } }`;
const DRAFTS = `query Drafts($host: String!, $first: Int!, $after: String) { publication(host: $host) { id title
  drafts(first: $first, after: $after) { totalDocuments pageInfo { hasNextPage endCursor } edges { node {
    id title subtitle updatedAt scheduledDate readTimeInMinutes canonicalUrl coverImage { url } tags { slug } series { name } } } } } }`;
const DRAFT = `query Draft($id: ObjectId!) { draft(id: $id) { id title subtitle slug updatedAt readTimeInMinutes canonicalUrl isSubmittedForReview
  content { markdown } coverImage { url } tags { slug name } series { id name } seo { title description } } }`;
const POST_DETAIL = `id title subtitle slug url publishedAt updatedAt canonicalUrl views reactionCount responseCount replyCount readTimeInMinutes
  content { markdown } coverImage { url } tags { slug name } series { id name } seo { title description }`;
const POST_BY_SLUG = `query Post($host: String!, $slug: String!) { publication(host: $host) { id post(slug: $slug) { ${POST_DETAIL} } } }`;
const POST_BY_ID = `query PostById($id: ID!) { post(id: $id) { ${POST_DETAIL} publication { id title url } } }`;
const SERIES = 'query Series($host: String!) { publication(host: $host) { id seriesList(first: 50) { edges { node { id name slug } } } } }';
const CREATE_DRAFT = `mutation CreateDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { ${DRAFT_FIELDS} } } }`;
const UPDATE_DRAFT = `mutation UpdateDraft($input: UpdateDraftInput!) { updateDraft(input: $input) { draft { ${DRAFT_FIELDS} } } }`;
const PUBLISH_DRAFT = `mutation PublishDraft($input: PublishDraftInput!) { publishDraft(input: $input) { post { ${POST_FIELDS} } } }`;
const PUBLISH_POST = `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { ${POST_FIELDS} } } }`;
const UPDATE_POST = 'mutation UpdatePost($input: UpdatePostInput!) { updatePost(input: $input) { post { id title slug url updatedAt } } }';
const SUBMIT_DRAFT = 'mutation SubmitDraft($input: SubmitDraftForReviewInput!) { submitDraftForReview(input: $input) { draft { id title isSubmittedForReview } } }';

/** Mutations this connector never sends: Hashnode deletes posts and drafts for good. */
const DELETING_FIELDS = ['removePost', 'deleteDraft'];

const OBJECT_ID = { type: 'string' as const, pattern: '^[0-9a-fA-F]{24}$', description: 'A Hashnode ID: 24 hexadecimal characters.' };
const CURSOR_SCHEMA = { type: 'string' as const, description: 'nextCursor from the previous result.' };
const TAG_SCHEMA = {
  type: 'array' as const,
  maxItems: 15,
  items: {
    type: 'object' as const,
    properties: {
      slug: { type: 'string' as const, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100, description: 'Lowercase words joined by hyphens, e.g. web-development.' },
      name: { type: 'string' as const, minLength: 1, maxLength: 100, description: 'The display name, e.g. Web Development (default: the slug).' },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  description: 'Up to 15 tags (about 5 that fit is best). An unknown slug creates a new tag, so prefer common ones such as javascript or ai. When given, they replace all tags.',
};

const COMMON_FIELDS = {
  title: { type: 'string' as const, minLength: 1, maxLength: 250, description: 'The title.' },
  subtitle: { type: 'string' as const, maxLength: 250, description: 'A subtitle.' },
  content_markdown: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 100000,
    description: 'The body in Markdown. Start sections at ##: the title is the page heading. Hashnode takes requests up to 100 KB.',
  },
  tags: TAG_SCHEMA,
  cover_image_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'The cover, as a public https image URL.' },
  original_article_url: {
    type: 'string' as const,
    format: 'uri' as const,
    maxLength: 2000,
    description: 'The original post\'s URL when the article first appeared elsewhere (a cross-post), so search engines credit it.',
  },
  series_id: { ...OBJECT_ID, description: 'A series of the blog, from list_series. The API cannot create a series.' },
  slug: { type: 'string' as const, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 250, description: 'The URL slug (default: made from the title).' },
  meta_title: { type: 'string' as const, maxLength: 250, description: 'An SEO title, when it should differ from the title.' },
  meta_description: { type: 'string' as const, maxLength: 500, description: 'An SEO description for search results.' },
  meta_image_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'A social image URL, when it should differ from the cover.' },
  table_of_contents: { type: 'boolean' as const, description: 'true adds a table of contents.' },
  delist: { type: 'boolean' as const, description: 'true keeps the post out of Hashnode\'s feeds (still reachable by its URL). Only when asked.' },
  published_at: {
    type: 'string' as const,
    maxLength: 40,
    description: 'Only to backdate a post moved from another blog to its original date (ISO 8601). It does not schedule.',
  },
};

interface PostArgs {
  title?: string;
  subtitle?: string;
  content_markdown?: string;
  tags?: Array<{ slug: string; name?: string }>;
  cover_image_url?: string;
  original_article_url?: string;
  series_id?: string;
  slug?: string;
  meta_title?: string;
  meta_description?: string;
  meta_image_url?: string;
  table_of_contents?: boolean;
  delist?: boolean;
  published_at?: string;
  send_newsletter?: boolean;
}

function tagsInput(tags: PostArgs['tags']): Array<{ slug: string; name: string }> | undefined {
  return tags?.map((tag) => ({ slug: tag.slug, name: tag.name ?? tag.slug }));
}

/** CreateDraftInput and UpdateDraftInput fields from the tool arguments that were given. */
function draftInput(args: PostArgs): Record<string, unknown> {
  const meta = compact({ title: args.meta_title, description: args.meta_description, image: args.meta_image_url });
  const settings = compact({ enableTableOfContent: args.table_of_contents, delist: args.delist, activateNewsletter: args.send_newsletter });
  return compact({
    title: args.title,
    subtitle: args.subtitle,
    contentMarkdown: args.content_markdown,
    tags: tagsInput(args.tags),
    coverImageOptions: args.cover_image_url !== undefined ? { coverImageURL: args.cover_image_url } : undefined,
    originalArticleURL: args.original_article_url,
    seriesId: args.series_id,
    slug: args.slug,
    metaTags: Object.keys(meta).length ? meta : undefined,
    settings: Object.keys(settings).length ? settings : undefined,
    publishedAt: args.published_at,
  });
}

/** PublishPostInput and UpdatePostInput fields: the same values under a published post's names. */
function postInput(args: PostArgs): Record<string, unknown> {
  return compact({
    title: args.title,
    subtitle: args.subtitle,
    contentMarkdown: args.content_markdown,
    tags: tagsInput(args.tags),
    coverImage: args.cover_image_url,
    originalArticleURL: args.original_article_url,
    seriesId: args.series_id,
    slug: args.slug,
    metaTitle: args.meta_title,
    metaDescription: args.meta_description,
    ogImage: args.meta_image_url,
    enableToc: args.table_of_contents,
    isDelisted: args.delist,
    publishedAt: args.published_at,
  });
}

function editorUrl(id: unknown): string | undefined {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id) ? `https://hashnode.com/draft/${id}` : undefined;
}

function trimDraft(draft: any): Record<string, unknown> {
  return compact({
    id: draft?.id,
    title: draft?.title ?? undefined,
    subtitle: draft?.subtitle ?? undefined,
    slug: draft?.slug ?? undefined,
    updated_at: draft?.updatedAt ?? undefined,
    scheduled_date: draft?.scheduledDate ?? undefined,
    read_time_minutes: draft?.readTimeInMinutes ?? undefined,
    canonical_url: draft?.canonicalUrl ?? undefined,
    cover_image: draft?.coverImage?.url ?? undefined,
    tags: Array.isArray(draft?.tags) ? draft.tags.map((tag: any) => tag?.slug) : undefined,
    series: draft?.series?.name ?? undefined,
    submitted_for_review: draft?.isSubmittedForReview === true ? true : undefined,
    editor_url: editorUrl(draft?.id),
  });
}

function trimPost(post: any): Record<string, unknown> {
  return compact({
    id: post?.id,
    title: post?.title,
    subtitle: post?.subtitle ?? undefined,
    slug: post?.slug,
    url: post?.url,
    published_at: post?.publishedAt ?? undefined,
    updated_at: post?.updatedAt ?? undefined,
    canonical_url: post?.canonicalUrl ?? undefined,
    views: typeof post?.views === 'number' ? post.views : undefined,
    reactions: post?.reactionCount ?? undefined,
    comments: post?.responseCount ?? undefined,
    replies: post?.replyCount ?? undefined,
    read_time_minutes: post?.readTimeInMinutes ?? undefined,
    cover_image: post?.coverImage?.url ?? undefined,
    tags: Array.isArray(post?.tags) ? post.tags.map((tag: any) => tag?.slug) : undefined,
    series: post?.series?.name ?? undefined,
  });
}

/** The blog behind the saved address, or a failure that says the address is wrong. */
async function findBlog(h: ToolHelpers): Promise<any> {
  const host = h.credentials['publicationhost'] as string;
  const result = await gql(h, PUBLICATION, { host });
  const publication = rootField(result, 'publication', false);
  if (!publication?.id) {
    throw new ToolFailure(
      `Hashnode has no blog at ${host}. The blog address must be the bare host the browser shows, such as yourname.hashnode.dev or `
        + 'blog.example.com; list_my_blogs lists the blogs this account owns. Nothing was changed.',
    );
  }
  return publication;
}

function cursorState(h: ToolHelpers, cursor: string | undefined): { after?: string; skip: number } {
  const state = h.cursor(cursor);
  return {
    ...(typeof state?.['a'] === 'string' && state['a'] ? { after: state['a'] } : {}),
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
  };
}

function connectionPage(h: ToolHelpers, key: string, connection: any, items: unknown[], after: string | undefined, skip: number, extra: Record<string, unknown>) {
  const next = connection?.pageInfo?.hasNextPage === true && typeof connection?.pageInfo?.endCursor === 'string' ? connection.pageInfo.endCursor : undefined;
  return h.page({
    key,
    items: items.slice(skip),
    extra,
    resumeAt: (index) => h.makeCursor({ ...(after ? { a: after } : {}), o: skip + index }),
    ...(next ? { nextPage: h.makeCursor({ a: next, o: 0 }) } : {}),
  });
}

function withMarkdown(h: ToolHelpers, base: Record<string, unknown>, markdown: unknown, cursor: string | undefined): Record<string, unknown> {
  const text = typeof markdown === 'string' ? markdown : '';
  const state = h.cursor(cursor);
  const window = textWindow(text, typeof state?.['o'] === 'number' ? state['o'] : 0, TEXT_WINDOW_BYTES);
  return compact({
    ...base,
    markdown: window.text,
    markdown_offset: window.offset || undefined,
    markdown_length: text.length,
    nextCursor: window.next !== undefined ? h.makeCursor({ o: window.next }) : undefined,
  });
}

/** What a mutation returned, e.g. createDraft.draft; an answer without it leaves the outcome unknown. */
function mutationResult(result: GqlResult, field: string, inner: string): any {
  const value = rootField(result, field, true)?.[inner];
  if (!value || typeof value !== 'object') {
    throw new OutcomeUnknown(`Hashnode answered without the ${inner}, so it is not known whether the change was made.`);
  }
  return value;
}

/** An answer with errors and no data at all: every top-level field null, or no data. */
function failedWhole(result: GqlResult): boolean {
  if (!result.errors.length) return false;
  const data = result.data;
  if (data === null || typeof data !== 'object') return true;
  const values = Object.values(data);
  return values.length === 0 || values.every((value) => value === null);
}

function needSomething(input: Record<string, unknown>, idField: string): void {
  if (Object.keys(input).filter((key) => key !== idField).length === 0) {
    throw new ToolFailure('Nothing to change: give at least one field besides the ID. Nothing was changed.');
  }
}

const connector = defineConnector({
  vendor: 'hashnode',
  label: 'Hashnode',
  origins: ['https://gql-beta.hashnode.com'],
  credentials: ['token', 'publicationhost'],
  credentialLabels: { token: 'Hashnode Personal Access Token', publicationhost: 'Hashnode blog address' },
  normalizeCredentials: (credentials) => ({
    ...credentials,
    token: (credentials['token'] ?? '').replace(/^Bearer\s+/i, ''),
    publicationhost: (credentials['publicationhost'] ?? '')
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split(/[/?#]/)[0]!
      .replace(/\.$/, ''),
  }),
  authHeaders: (credentials) => ({ authorization: credentials['token'] as string }),
  tools: [
    {
      name: 'get_blog',
      kind: 'read',
      title: 'Get the Hashnode blog',
      description:
        'Finds the blog at the saved address: its ID, title, URL and whether it is a team blog. It also tells whether the blog is on '
        + 'Hashnode Pro, which Hashnode\'s API needs for every call on a blog.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const blog = await findBlog(h);
        return compact({ id: blog.id, title: blog.title, url: blog.url ?? undefined, is_team: blog.isTeam === true, host: h.credentials['publicationhost'] });
      },
    },
    {
      name: 'list_my_blogs',
      kind: 'read',
      title: 'List my Hashnode blogs',
      description: 'The token\'s own account and the blogs it owns, with their IDs and URLs: to find the right blog address when the saved one is not found.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const me = rootField(await gql(h, ME, undefined), 'me', false);
        if (!me) throw new ToolFailure('Hashnode returned no account for this token: check that the Hashnode Personal Access Token is correct.');
        const blogs = Array.isArray(me?.publications?.edges) ? me.publications.edges.map((edge: any) => compact({ id: edge?.node?.id, title: edge?.node?.title, url: edge?.node?.url ?? undefined })) : [];
        return { account: compact({ id: me.id, username: me.username }), blogs };
      },
    },
    {
      name: 'list_posts',
      kind: 'read',
      title: 'List Hashnode posts with stats',
      description:
        'The blog\'s published posts, newest first, with views, reactions, comments and replies (lifetime numbers; views may be missing '
        + 'when Hashnode does not report them, which is not zero). Hashnode may serve a list up to about 25 seconds old. Pass nextCursor '
        + 'back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          first: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Posts per page, 1 to 100 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { first: number; cursor?: string }, h) {
        const { after, skip } = cursorState(h, args.cursor);
        const result = await gql(h, POSTS, compact({ host: h.credentials['publicationhost'], first: args.first, after }));
        const publication = rootField(result, 'publication', false);
        if (!publication) throw new ToolFailure(`Hashnode has no blog at ${h.credentials['publicationhost']}: check the blog address (list_my_blogs lists your blogs).`);
        const connection = publication.posts;
        const posts: unknown[] = Array.isArray(connection?.edges) ? connection.edges.map((edge: any) => trimPost(edge?.node)) : [];
        return connectionPage(h, 'posts', connection, posts, after, skip, compact({ blog: publication.title, total: connection?.totalDocuments, warnings: warningsOf(result) }));
      },
    },
    {
      name: 'list_drafts',
      kind: 'read',
      title: 'List my Hashnode drafts',
      description:
        'The token account\'s own drafts on the blog, newest first, with their editor links (they open for a signed-in member of the blog). '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          first: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Drafts per page, 1 to 50 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { first: number; cursor?: string }, h) {
        const { after, skip } = cursorState(h, args.cursor);
        const result = await gql(h, DRAFTS, compact({ host: h.credentials['publicationhost'], first: args.first, after }));
        const publication = rootField(result, 'publication', false);
        if (!publication) throw new ToolFailure(`Hashnode has no blog at ${h.credentials['publicationhost']}: check the blog address (list_my_blogs lists your blogs).`);
        const connection = publication.drafts;
        const drafts: unknown[] = Array.isArray(connection?.edges) ? connection.edges.map((edge: any) => trimDraft(edge?.node)) : [];
        return connectionPage(h, 'drafts', connection, drafts, after, skip, compact({ blog: publication.title, total: connection?.totalDocuments, warnings: warningsOf(result) }));
      },
    },
    {
      name: 'get_draft',
      kind: 'read',
      title: 'Read a Hashnode draft',
      description:
        'One draft with its Markdown, tags, cover, series, SEO fields and editor link: to show it before publishing or to edit it. A long body '
        + 'comes in windows: pass nextCursor back as cursor. A draft this account may not see answers NOT_FOUND.',
      inputSchema: {
        type: 'object',
        properties: { draft_id: { ...OBJECT_ID, description: 'The draft ID, from create_draft or list_drafts.' }, cursor: CURSOR_SCHEMA },
        required: ['draft_id'],
        additionalProperties: false,
      },
      async run(args: { draft_id: string; cursor?: string }, h) {
        const result = await gql(h, DRAFT, { id: args.draft_id });
        const draft = rootField(result, 'draft', false);
        if (!draft) throw new ToolFailure('Hashnode found no draft with that ID that this account can see.');
        const base = compact({
          ...trimDraft(draft),
          tags: Array.isArray(draft.tags) ? draft.tags.map((tag: any) => compact({ slug: tag?.slug, name: tag?.name })) : undefined,
          series: draft.series ? compact({ id: draft.series.id, name: draft.series.name }) : undefined,
          seo: draft.seo && (draft.seo.title || draft.seo.description) ? compact({ title: draft.seo.title, description: draft.seo.description }) : undefined,
          published: false,
        });
        return withMarkdown(h, base, draft.content?.markdown, args.cursor);
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Read a Hashnode post',
      description:
        'One published post, by its slug on the blog (the last part of its URL) or by its ID: stats, tags, cover, series and its Markdown. '
        + 'A long body comes in windows: pass nextCursor back as cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', minLength: 1, maxLength: 250, description: 'The post\'s slug on the blog.' },
          post_id: { ...OBJECT_ID, description: 'The post ID instead of the slug.' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { slug?: string; post_id?: string; cursor?: string }, h) {
        if ((args.slug === undefined) === (args.post_id === undefined)) throw new ToolFailure('Give slug or post_id (one of them). Nothing was sent.');
        let post: any;
        if (args.post_id !== undefined) {
          post = rootField(await gql(h, POST_BY_ID, { id: args.post_id }), 'post', false);
        } else {
          const publication = rootField(await gql(h, POST_BY_SLUG, { host: h.credentials['publicationhost'], slug: args.slug }), 'publication', false);
          if (!publication) throw new ToolFailure(`Hashnode has no blog at ${h.credentials['publicationhost']}: check the blog address.`);
          post = publication.post;
        }
        if (!post) throw new ToolFailure('Hashnode found no post there: check the slug or the ID.');
        const base = compact({
          ...trimPost(post),
          tags: Array.isArray(post.tags) ? post.tags.map((tag: any) => compact({ slug: tag?.slug, name: tag?.name })) : undefined,
          series: post.series ? compact({ id: post.series.id, name: post.series.name }) : undefined,
          seo: post.seo && (post.seo.title || post.seo.description) ? compact({ title: post.seo.title, description: post.seo.description }) : undefined,
          blog: post.publication ? compact({ id: post.publication.id, title: post.publication.title, url: post.publication.url }) : undefined,
        });
        return withMarkdown(h, base, post.content?.markdown, args.cursor);
      },
    },
    {
      name: 'list_series',
      kind: 'read',
      title: 'List the Hashnode blog\'s series',
      description: 'The blog\'s series with their IDs, for series_id on a draft or a post. The API cannot create a series: that is done in the blog dashboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const publication = rootField(await gql(h, SERIES, { host: h.credentials['publicationhost'] }), 'publication', false);
        if (!publication) throw new ToolFailure(`Hashnode has no blog at ${h.credentials['publicationhost']}: check the blog address.`);
        const series = Array.isArray(publication.seriesList?.edges)
          ? publication.seriesList.edges.map((edge: any) => compact({ id: edge?.node?.id, name: edge?.node?.name, slug: edge?.node?.slug }))
          : [];
        return { series };
      },
    },
    {
      name: 'create_draft',
      kind: 'create',
      check: 'list_drafts',
      title: 'Save a Hashnode draft',
      description:
        'Saves a post as a draft on the blog; nothing becomes public. Returns the draft ID and its editor link. publish_draft publishes it '
        + 'later. send_newsletter emails the blog\'s newsletter subscribers when the post goes live: set it only when asked to.',
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON_FIELDS,
          send_newsletter: { type: 'boolean', description: 'true emails the blog\'s newsletter subscribers when the post is published. Only when asked.' },
        },
        required: ['title', 'content_markdown'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const blog = await findBlog(h);
        const result = await gql(h, CREATE_DRAFT, { input: { publicationId: blog.id, ...draftInput(args) } }, { write: true });
        const draft = mutationResult(result, 'createDraft', 'draft');
        return compact({ saved: 'draft, not published', ...trimDraft(draft), blog: blog.title, warnings: warningsOf(result) });
      },
    },
    {
      name: 'update_draft',
      kind: 'update',
      check: 'get_draft',
      title: 'Edit a Hashnode draft',
      description:
        'Changes a draft: only the fields given change; tags, when given, replace all tags, and content_markdown replaces the whole body '
        + '(read it with get_draft first). Nothing becomes public.',
      inputSchema: {
        type: 'object',
        properties: {
          draft_id: { ...OBJECT_ID, description: 'The draft ID.' },
          ...COMMON_FIELDS,
          send_newsletter: { type: 'boolean', description: 'true emails the blog\'s newsletter subscribers when the post is published. Only when asked.' },
        },
        required: ['draft_id'],
        additionalProperties: false,
      },
      async run(args: PostArgs & { draft_id: string }, h) {
        const input = { draftId: args.draft_id, ...draftInput(args) };
        needSomething(input, 'draftId');
        const result = await gql(h, UPDATE_DRAFT, { input }, { write: true });
        const draft = mutationResult(result, 'updateDraft', 'draft');
        return compact({ saved: 'draft, not published', ...trimDraft(draft), warnings: warningsOf(result) });
      },
    },
    {
      name: 'publish_draft',
      kind: 'update',
      check: 'list_posts',
      title: 'Publish a Hashnode draft',
      description: 'Publishes a saved draft: Hashnode turns it into a live post on the blog and removes the draft. Returns the post\'s URL on the blog.',
      inputSchema: {
        type: 'object',
        properties: { draft_id: { ...OBJECT_ID, description: 'The draft ID.' } },
        required: ['draft_id'],
        additionalProperties: false,
      },
      async run(args: { draft_id: string }, h) {
        const result = await gql(h, PUBLISH_DRAFT, { input: { draftId: args.draft_id } }, { write: true });
        const post = mutationResult(result, 'publishDraft', 'post');
        return compact({ published: true, ...trimPost(post), warnings: warningsOf(result) });
      },
    },
    {
      name: 'publish_post',
      kind: 'create',
      check: 'list_posts',
      title: 'Publish a Hashnode post now',
      description:
        'Publishes a new post on the blog in one step, with no draft: it is live at once. Use create_draft when the post should be reviewed '
        + 'first. Returns the post\'s URL on the blog.',
      inputSchema: {
        type: 'object',
        properties: COMMON_FIELDS,
        required: ['title', 'content_markdown'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const blog = await findBlog(h);
        const result = await gql(h, PUBLISH_POST, { input: { publicationId: blog.id, ...postInput(args) } }, { write: true });
        const post = mutationResult(result, 'publishPost', 'post');
        return compact({ published: true, ...trimPost(post), warnings: warningsOf(result) });
      },
    },
    {
      name: 'update_post',
      kind: 'update',
      check: 'get_post',
      title: 'Edit a published Hashnode post',
      description:
        'Changes a published post live, at once: only the fields given change; tags, when given, replace all tags, and content_markdown '
        + 'replaces the whole body (read it with get_post first).',
      inputSchema: {
        type: 'object',
        properties: { post_id: { ...OBJECT_ID, description: 'The post ID, from list_posts.' }, ...COMMON_FIELDS },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: PostArgs & { post_id: string }, h) {
        const input = { id: args.post_id, ...postInput(args) };
        needSomething(input, 'id');
        const result = await gql(h, UPDATE_POST, { input }, { write: true });
        const post = mutationResult(result, 'updatePost', 'post');
        return compact({ updated: true, ...trimPost(post), warnings: warningsOf(result) });
      },
    },
    {
      name: 'submit_draft_for_review',
      kind: 'update',
      check: 'get_draft',
      title: 'Send a Hashnode draft for review',
      description: 'On a team blog where this account is a contributor (it cannot publish), hands a draft to the blog\'s editors for review.',
      inputSchema: {
        type: 'object',
        properties: { draft_id: { ...OBJECT_ID, description: 'The draft ID.' } },
        required: ['draft_id'],
        additionalProperties: false,
      },
      async run(args: { draft_id: string }, h) {
        const result = await gql(h, SUBMIT_DRAFT, { input: { draftId: args.draft_id } }, { write: true });
        const draft = mutationResult(result, 'submitDraftForReview', 'draft');
        return compact({ submitted_for_review: draft?.isSubmittedForReview !== false, id: draft?.id, title: draft?.title ?? undefined, warnings: warningsOf(result) });
      },
    },
    {
      name: 'graphql_query',
      kind: 'read',
      title: 'Run a Hashnode GraphQL query',
      description:
        'Any other read of Hashnode\'s GraphQL API at https://gql-beta.hashnode.com, with the connected token, such as a tag, a user, '
        + 'searchPostsOfPublication, scheduled drafts or a post\'s comments. Queries only; the endpoint serves its schema by introspection. '
        + 'Returns data, and errors when some fields failed, cut to fit 32 KB (use first to page).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 20000, description: 'The GraphQL document: one or more queries, no mutation.' },
          variables: { type: 'object', description: 'The variables, e.g. {"host": "yourname.hashnode.dev"}.' },
          operation_name: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]*$', maxLength: 100, description: 'Which operation to run, when the document has several.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; variables?: Record<string, unknown>; operation_name?: string }, h) {
        const types = operationTypes(args.query);
        if (types.includes('mutation') || types.includes('subscription')) {
          throw new ToolFailure('graphql_query runs queries only: send a mutation with graphql_mutation. Nothing was sent.');
        }
        if (!types.includes('query')) throw new ToolFailure('The document has no query operation. Nothing was sent.');
        const result = await gql(h, args.query, args.variables, { ...(args.operation_name ? { operationName: args.operation_name } : {}) });
        if (failedWhole(result)) failFromErrors(result.errors, false);
        return fitAnswer(compact({ data: result.data, errors: warningsOf(result) }));
      },
    },
    {
      name: 'graphql_mutation',
      kind: 'write',
      check: 'graphql_query',
      title: 'Run a Hashnode GraphQL mutation',
      description:
        'Any other change through Hashnode\'s GraphQL API, with the connected token, such as rejecting a submitted draft. Sent once, never '
        + 'retried. Deleting posts and drafts (removePost, deleteDraft) is not offered: delete them in Hashnode.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 120000, description: 'The GraphQL document with one mutation.' },
          variables: { type: 'object', description: 'The variables, e.g. {"input": {...}}.' },
          operation_name: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]*$', maxLength: 100, description: 'Which operation to run, when the document has several.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; variables?: Record<string, unknown>; operation_name?: string }, h) {
        const types = operationTypes(args.query);
        if (types.includes('subscription')) throw new ToolFailure('Subscriptions are not supported. Nothing was sent.');
        if (!types.includes('mutation')) throw new ToolFailure('The document has no mutation: run queries with graphql_query. Nothing was sent.');
        const words = documentWords(args.query);
        const deleting = DELETING_FIELDS.find((field) => new RegExp(`\\b${field}\\b`).test(words));
        if (deleting) throw new ToolFailure(`${deleting} is not offered here: Hashnode deletes for good, so delete it in Hashnode itself. Nothing was sent.`);
        const result = await gql(h, args.query, args.variables, { write: true, ...(args.operation_name ? { operationName: args.operation_name } : {}) });
        if (failedWhole(result)) failFromErrors(result.errors, true);
        return fitAnswer(compact({ data: result.data, errors: warningsOf(result) }));
      },
    },
  ],
});

export = connector;
