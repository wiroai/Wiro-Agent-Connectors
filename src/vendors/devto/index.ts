// dev.to (DEV Community), through the Forem API v1 (https://developers.forem.com/api/v1).
//
// Credential: `apikey`, a DEV Community API key from dev.to Settings ->
// Extensions -> "DEV Community API Keys". It is sent in the api-key header to
// https://dev.to/api/ only. dev.to's API cannot delete articles.

import { apiTools, defineConnector, jsonSize, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';

const DISCLOSURE_LEVELS = ['fully_autonomous', 'some_ai', 'no_ai'] as const;
const DISCLOSURE_HELP =
  "dev.to's AI disclosure for the article: fully_autonomous when an AI wrote it (even if a person asked for it or approved it), "
  + 'some_ai when a person wrote it and AI helped with drafting, editing, code or translation, no_ai only when a person wrote it with no AI help.';

const TAG_SCHEMA = { type: 'string' as const, pattern: '^[A-Za-z0-9]{1,30}$', description: 'Letters and digits only, up to 30.' };
const DATE_SCHEMA = { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

/** The most JSON bytes of an article body one get_article result carries; the rest follows with the cursor. */
const BODY_PART_BYTES = 20_000;
/** Drafts are looked up 100 at a time, at most this many pages. */
const MAX_DRAFT_PAGES = 10;

const ARTICLE_FIELDS = {
  title: { type: 'string' as const, minLength: 1, maxLength: 128, description: 'The article title, up to 128 characters.' },
  body_markdown: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 400000,
    description: 'The article body in Markdown, without a YAML front matter block (pass title, tags and the rest as arguments).',
  },
  tags: { type: 'array' as const, items: TAG_SCHEMA, maxItems: 4, uniqueItems: true, description: 'Up to 4 tags, letters and digits only, e.g. ["javascript", "webdev"].' },
  description: { type: 'string' as const, maxLength: 1000, description: 'A short summary shown in previews and search results.' },
  canonical_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'The original URL when the article first appeared elsewhere, so search engines credit it.' },
  cover_image_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'A public URL of the cover image (shown at 1000 x 420).' },
  series: { type: 'string' as const, minLength: 1, maxLength: 128, description: 'A series name; dev.to creates the series if it does not exist.' },
};

interface ArticleArgs {
  title?: string;
  body_markdown?: string;
  tags?: string[];
  description?: string;
  canonical_url?: string;
  cover_image_url?: string;
  series?: string;
  organization_id?: number;
  ai_disclosure_level?: (typeof DISCLOSURE_LEVELS)[number];
}

function assertNoFrontMatter(body: string | undefined): void {
  if (body !== undefined && /^﻿?\s*---[ \t]*\r?\n/.test(body)) {
    throw new ToolFailure(
      'body_markdown starts with a YAML front matter block, which dev.to would read as article settings (it can even publish the article). '
        + 'Remove the block and pass title, tags, series, cover_image_url and canonical_url as arguments. Nothing was changed.',
    );
  }
}

/** The article fields of the Forem API, from the tool arguments that were given. */
function articleBody(args: ArticleArgs): Record<string, unknown> {
  const article: Record<string, unknown> = {};
  if (args.title !== undefined) article['title'] = args.title;
  if (args.body_markdown !== undefined) article['body_markdown'] = args.body_markdown;
  if (args.tags !== undefined) article['tags'] = args.tags;
  if (args.description !== undefined) article['description'] = args.description;
  if (args.canonical_url !== undefined) article['canonical_url'] = args.canonical_url;
  if (args.cover_image_url !== undefined) article['main_image'] = args.cover_image_url;
  if (args.series !== undefined) article['series'] = args.series;
  if (args.organization_id !== undefined) article['organization_id'] = args.organization_id;
  if (args.ai_disclosure_level !== undefined) article['ai_disclosure_level'] = args.ai_disclosure_level;
  return article;
}

function tagsOf(article: any): string[] | undefined {
  if (Array.isArray(article?.tags)) return article.tags.map(String);
  if (Array.isArray(article?.tag_list)) return article.tag_list.map(String);
  if (typeof article?.tag_list === 'string') return article.tag_list.split(',').map((tag: string) => tag.trim()).filter(Boolean);
  return undefined;
}

function editUrl(article: any): string | undefined {
  try {
    const path = typeof article?.path === 'string' && article.path ? article.path : new URL(String(article?.url)).pathname;
    return path.startsWith('/') ? `https://dev.to${path}/edit` : undefined;
  } catch {
    return undefined;
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/** The fields an agent needs from one of the account's articles. */
function trimArticle(article: any): Record<string, unknown> {
  return compact({
    id: article?.id,
    title: typeof article?.title === 'string' ? truncate(article.title, 300) : undefined,
    published: typeof article?.published === 'boolean' ? article.published : Boolean(article?.published_at),
    published_at: article?.published_at || undefined,
    url: article?.url,
    edit_url: editUrl(article),
    tags: tagsOf(article),
    description: typeof article?.description === 'string' && article.description ? truncate(article.description, 300) : undefined,
    page_views_count: article?.page_views_count,
    public_reactions_count: article?.public_reactions_count,
    comments_count: article?.comments_count,
    reading_time_minutes: article?.reading_time_minutes,
    canonical_url: article?.canonical_url,
    organization: article?.organization?.username,
  });
}

/** The fields an agent needs after a create or an update. */
function trimSaved(article: any, args: ArticleArgs): Record<string, unknown> {
  const warnings: string[] = Array.isArray(article?.warnings) ? article.warnings.map((item: unknown) => truncate(String(item), 300)) : [];
  if (args.organization_id !== undefined && !article?.organization) {
    warnings.push(
      `dev.to saved the article under the account itself, not organization ${args.organization_id}: `
        + 'the account must be a member of that organization to post there.',
    );
  }
  return compact({
    ...trimArticle(article),
    ai_disclosure_level: article?.ai_disclosure_level,
    cover_image: article?.cover_image,
    series: article?.series ?? undefined,
    warnings: warnings.length ? warnings : undefined,
  });
}

async function saveArticle(h: ToolHelpers, method: 'POST' | 'PUT', path: string, article: Record<string, unknown>) {
  try {
    return await h.api({
      method,
      path,
      json: { article },
      write: true,
      errors: {
        404: 'dev.to found no article with that id that this API key may edit.',
        422: 'dev.to did not accept the article.',
      },
    });
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 422 && /already been used/i.test(error.message)) {
      throw new ToolFailure(
        `${error.message} An earlier attempt may already have saved this article: check list_my_articles (status unpublished) before trying again.`,
        error.details,
      );
    }
    throw error;
  }
}

/**
 * An article with its Markdown body: a published article by id, else one of
 * the account's drafts (dev.to serves drafts only in the account's own lists).
 */
async function findArticle(h: ToolHelpers, id: number): Promise<any> {
  try {
    const { data } = await h.api({ path: `/api/articles/${id}` });
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch (error) {
    if (!(error instanceof ToolFailure) || error.details.status !== 404) throw error;
  }
  for (let page = 1; page <= MAX_DRAFT_PAGES; page++) {
    const { data } = await h.api({ path: '/api/articles/me/unpublished', query: { page, per_page: 100 } });
    const drafts: any[] = Array.isArray(data) ? data : [];
    const found = drafts.find((article) => article?.id === id);
    if (found) return found;
    if (drafts.length < 100) break;
  }
  throw new ToolFailure(
    `dev.to has no published article ${id}, and it is not among the account's drafts. Check the id with list_my_articles.`,
    { status: 404 },
  );
}

/** The part of a body that starts at `offset` and fits BODY_PART_BYTES of JSON, ending at a line break where one is near. */
function bodyPart(body: string, offset: number): { text: string; end: number } {
  const rest = body.slice(offset, offset + BODY_PART_BYTES);
  if (offset + rest.length >= body.length && jsonSize(rest) <= BODY_PART_BYTES) return { text: rest, end: body.length };
  let low = 1;
  let high = rest.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonSize(rest.slice(0, middle)) <= BODY_PART_BYTES) low = middle;
    else high = middle - 1;
  }
  let end = low;
  // Never split a surrogate pair.
  if (/[\ud800-\udbff]/.test(rest[end - 1] ?? '')) end -= 1;
  const lineBreak = rest.lastIndexOf('\n', end - 1);
  if (lineBreak >= end * 0.7) end = lineBreak + 1;
  return { text: rest.slice(0, end), end: offset + end };
}

interface DayStats {
  date: string;
  page_views: number;
  reactions: number;
  comments: number;
  follows: number;
  average_read_time_seconds?: number;
  read_seconds?: number;
}

function total(entry: any, name: string): number {
  const value = entry?.[name]?.total;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function dayStats(date: string, entry: any): DayStats {
  const average = entry?.page_views?.average_read_time_in_seconds;
  const readSeconds = entry?.page_views?.total_read_time_in_seconds;
  return {
    date,
    page_views: total(entry, 'page_views'),
    reactions: total(entry, 'reactions'),
    comments: total(entry, 'comments'),
    follows: total(entry, 'follows'),
    ...(typeof average === 'number' ? { average_read_time_seconds: average } : {}),
    ...(typeof readSeconds === 'number' ? { read_seconds: readSeconds } : {}),
  };
}

const LIST_STATUSES = ['all', 'published', 'unpublished'];

const connector = defineConnector({
  vendor: 'devto',
  label: 'dev.to',
  origins: ['https://dev.to'],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'dev.to API key' },
  authHeaders: (credentials) => ({
    'api-key': credentials['apikey'] as string,
    accept: 'application/vnd.forem.api-v1+json',
  }),
  tools: [
    {
      name: 'list_my_articles',
      kind: 'read',
      title: 'List my dev.to articles',
      description:
        "Lists the account's own dev.to articles, newest first: drafts and published articles, or one of the two. "
        + 'Each has its id, title, URL, edit URL, tags, and for published articles the page views, reactions and comments '
        + '(dev.to shows page views to the author only). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...LIST_STATUSES],
            default: 'all',
            description: 'all (default), published, or unpublished (drafts).',
          },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 30, description: 'Articles per page, 1 to 100 (default 30).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { status: string; per_page: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const perPage = typeof state?.['n'] === 'number' ? state['n'] : args.per_page;
        // A cursor pages the list it came from, whatever status comes with it.
        const status = typeof state?.['s'] === 'string' && LIST_STATUSES.includes(state['s']) ? state['s'] : args.status;
        const { data } = await h.api({ path: `/api/articles/me/${status}`, query: { page, per_page: perPage } });
        const articles: unknown[] = Array.isArray(data) ? data : [];
        return h.page({
          key: 'articles',
          items: articles.map(trimArticle).slice(skip),
          extra: { status, page },
          resumeAt: (index) => h.makeCursor({ s: status, p: page, o: skip + index, n: perPage }),
          ...(articles.length >= perPage ? { nextPage: h.makeCursor({ s: status, p: page + 1, o: 0, n: perPage }) } : {}),
        });
      },
    },
    {
      name: 'get_article',
      kind: 'read',
      title: 'Get a dev.to article with its Markdown',
      description:
        'Returns one article with its Markdown body, to read it or to edit it with update_article: one of the account\'s drafts, '
        + 'or a published article by id. A long body comes in parts: pass nextCursor back as cursor for the rest.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The article id, from list_my_articles.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result, for the next part of the body.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: { id: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        if (state && state['i'] !== args.id) {
          throw new ToolFailure('The cursor belongs to another article. Pass the same id as in the previous call, or leave cursor out.');
        }
        const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const article = await findArticle(h, args.id);
        const body = typeof article?.body_markdown === 'string' ? article.body_markdown : '';
        const part = bodyPart(body, Math.min(offset, body.length));
        return compact({
          ...trimArticle(article),
          author: article?.user?.username,
          ai_disclosure_level: article?.ai_disclosure_level,
          cover_image: article?.cover_image,
          body_markdown: part.text,
          body_part: { start: Math.min(offset, body.length), end: part.end, length: body.length },
          nextCursor: part.end < body.length ? h.makeCursor({ i: args.id, o: part.end }) : undefined,
        });
      },
    },
    {
      name: 'create_draft_article',
      kind: 'create',
      check: 'list_my_articles',
      title: 'Create a dev.to draft article',
      description:
        'Saves a new article on dev.to as an unpublished draft; nothing becomes public. Returns its id, preview URL and edit URL. '
        + 'Publish it later with update_article and published: true. dev.to refuses a title the account already used in the last '
        + '5 minutes, and allows about one write per second.',
      inputSchema: {
        type: 'object',
        properties: {
          ...ARTICLE_FIELDS,
          organization_id: {
            type: 'integer',
            minimum: 1,
            description: 'Post under this dev.to organization (the account must be a member). Its id comes from api_get /api/organizations/<username>.',
          },
          ai_disclosure_level: { type: 'string', enum: [...DISCLOSURE_LEVELS], description: DISCLOSURE_HELP },
        },
        required: ['title', 'body_markdown', 'ai_disclosure_level'],
        additionalProperties: false,
      },
      async run(args: ArticleArgs, h) {
        assertNoFrontMatter(args.body_markdown);
        const { data } = await saveArticle(h, 'POST', '/api/articles', { ...articleBody(args), published: false });
        return trimSaved(data, args);
      },
    },
    {
      name: 'update_article',
      kind: 'update',
      check: 'list_my_articles',
      title: 'Publish or update a dev.to article',
      description:
        "Changes one of the account's dev.to articles: only the fields given are changed (tags, when given, replace all tags). "
        + 'published: true publishes a draft (it goes live and gets its final URL); published: false turns a published article back '
        + 'into a draft. Editing a published article changes it live. Read the current body first with get_article.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1, description: 'The article id, from list_my_articles or create_draft_article.' },
          published: { type: 'boolean', description: 'true to publish, false to turn it back into a draft. Leave out to keep it as it is.' },
          ...ARTICLE_FIELDS,
          ai_disclosure_level: { type: 'string', enum: [...DISCLOSURE_LEVELS], description: DISCLOSURE_HELP },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args: ArticleArgs & { id: number; published?: boolean }, h) {
        assertNoFrontMatter(args.body_markdown);
        const article = articleBody(args);
        if (args.published !== undefined) article['published'] = args.published;
        if (!Object.keys(article).length) {
          throw new ToolFailure('Nothing to change: give published or at least one article field besides id. Nothing was changed.');
        }
        const { data } = await saveArticle(h, 'PUT', `/api/articles/${args.id}`, article);
        return trimSaved(data, args);
      },
    },
    {
      name: 'get_analytics',
      kind: 'read',
      title: 'Get dev.to analytics',
      description:
        "The account's dev.to statistics: with start, page views, reactions, comments, new followers and the average read time per day "
        + '(dev.to groups days older than 180 days by week) and their totals; without start, the lifetime totals. For one article with '
        + "article_id, or an organization's articles with organization_id. Pass nextCursor back as cursor for more days.",
      inputSchema: {
        type: 'object',
        properties: {
          start: { ...DATE_SCHEMA, description: 'The first day, YYYY-MM-DD. Leave out for the lifetime totals.' },
          end: { ...DATE_SCHEMA, description: 'The last day, YYYY-MM-DD (default today); only with start.' },
          article_id: { type: 'integer', minimum: 1, description: 'Only this article of the account.' },
          organization_id: { type: 'integer', minimum: 1, description: "Only this organization's articles (one the account may see)." },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { start?: string; end?: string; article_id?: number; organization_id?: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const text = (key: string, fallback?: string): string | undefined => (state ? (typeof state[key] === 'string' ? (state[key] as string) : undefined) : fallback);
        const number = (key: string, fallback?: number): number | undefined => (state ? (typeof state[key] === 'number' ? (state[key] as number) : undefined) : fallback);
        const start = text('s', args.start);
        const end = text('e', args.end);
        const articleId = number('a', args.article_id);
        const organizationId = number('g', args.organization_id);
        const skip = number('o', 0) ?? 0;
        if (end !== undefined && start === undefined) throw new ToolFailure('end needs start: give the first day too, or leave both out for the lifetime totals.');
        if (start !== undefined && end !== undefined && end < start) throw new ToolFailure('end is before start.');
        if (articleId !== undefined && organizationId !== undefined) throw new ToolFailure('Give article_id or organization_id, not both.');
        const scope: Record<string, number> = {};
        if (articleId !== undefined) scope['article_id'] = articleId;
        if (organizationId !== undefined) scope['organization_id'] = organizationId;
        const errors = {
          404: "dev.to's analytics are not available here: the account may not have them yet, or the article or organization is not one it may see",
          422: 'dev.to did not accept the dates (use YYYY-MM-DD)',
        };

        if (start === undefined) {
          const { data } = await h.api({ path: '/api/analytics/totals', query: { ...scope }, errors });
          const stats = dayStats('', data);
          const { date: _date, read_seconds: _read, ...totals } = stats;
          return { scope: Object.keys(scope).length ? scope : 'account', period: 'lifetime', totals };
        }

        const { data } = await h.api({ path: '/api/analytics/historical', query: { start, end, ...scope }, errors });
        const rows = Object.entries(data && typeof data === 'object' && !Array.isArray(data) ? data : {})
          .filter(([date, entry]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && entry && typeof entry === 'object')
          .map(([date, entry]) => dayStats(date, entry))
          .sort((a, b) => a.date.localeCompare(b.date));
        const views = rows.reduce((sum, row) => sum + row.page_views, 0);
        const readSeconds = rows.reduce((sum, row) => sum + (row.read_seconds ?? 0), 0);
        const totals = compact({
          page_views: views,
          reactions: rows.reduce((sum, row) => sum + row.reactions, 0),
          comments: rows.reduce((sum, row) => sum + row.comments, 0),
          follows: rows.reduce((sum, row) => sum + row.follows, 0),
          average_read_time_seconds: views > 0 && readSeconds > 0 ? Math.round(readSeconds / views) : undefined,
        });
        const state0 = { s: start, ...(end ? { e: end } : {}), ...(articleId ? { a: articleId } : {}), ...(organizationId ? { g: organizationId } : {}) };
        return h.page({
          key: 'days',
          items: rows.slice(skip).map(({ read_seconds: _read, ...row }) => row),
          extra: {
            scope: Object.keys(scope).length ? scope : 'account',
            range: compact({ start, end: end ?? rows[rows.length - 1]?.date }),
            totals,
            days_count: rows.length,
          },
          resumeAt: (index) => h.makeCursor({ ...state0, o: skip + index }),
        });
      },
    },
    // The rest of the Forem API: followers, comments, reactions, reading list, organizations.
    ...apiTools({
      label: 'dev.to',
      description:
        'The dev.to (Forem) API v1 at https://dev.to/api, with the connected API key: paths start with /api/, such as '
        + '/api/articles/me/published, /api/followers/users, /api/readinglist, /api/organizations/<username> (an organization\'s id) '
        + 'or /api/comments (with a_id in query). Reference: https://developers.forem.com/api/v1.',
      basePath: '/api/',
      methods: ['POST', 'PUT', 'DELETE'],
    }),
  ],
});

export = connector;
