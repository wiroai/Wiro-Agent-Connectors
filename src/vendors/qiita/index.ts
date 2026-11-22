// Qiita (qiita.com), through Qiita API v2 (https://qiita.com/api/v2/docs).
//
// Credential: `token`, a personal access token from qiita.com → Settings →
// Applications → Personal access tokens, with the read_qiita and write_qiita
// scopes. It is sent as a Bearer token to https://qiita.com/api/v2/ only.
// Qiita's API has no drafts: a limited-share article (private: true) is the
// draft, and a public article can never go back to limited share. Qiita Team
// (team sites) is not covered.

import { apiTools, defineConnector, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';

const BASE = '/api/v2';
const MAX_SCAN_PAGES = 10;
/** Lists carry every article's body: read up to the 8 MiB a host allows for an API reply. */
const LIST_REPLY_BYTES = 8 * 1024 * 1024;

const ITEM_ID = {
  type: 'string' as const,
  minLength: 20,
  maxLength: 300,
  description: 'The article ID (20 hexadecimal characters), or the article\'s qiita.com link.',
};
const TAGS_SCHEMA = {
  type: 'array' as const,
  minItems: 1,
  maxItems: 5,
  items: {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, minLength: 1, maxLength: 100, description: 'The tag as Qiita spells it, e.g. Python.' },
      versions: { type: 'array' as const, maxItems: 10, items: { type: 'string' as const, minLength: 1, maxLength: 50 }, description: 'Optional versions, e.g. ["3.12"].' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  description: '1 to 5 tags, as Qiita spells them (get_tag shows how many articles and followers a tag has before you pick it).',
};
const BODY_HELP =
  'Qiita Markdown, without front matter and without repeating the title: code blocks may name a file (```python:main.py), :::note info / '
  + 'warn / alert blocks, ```math, ```mermaid (up to 2,000 characters a block), <details>, footnotes, tables and task lists. Images only by a '
  + 'lasting public https URL with alt text: Qiita\'s API cannot upload images.';
const LIMITED_NOTE =
  'Saved as a limited-share article: only you and people with its link can open it, and search engines do not list it. make_article_public publishes it.';
const PUBLIC_NOTE =
  'Public now. Qiita cannot turn it back into a limited-share article, and every revision saved while it was limited is visible in its edit history.';

/** Drops undefined and null fields. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/** A Qiita article ID from an ID or a qiita.com article link. */
function itemId(value: string): string {
  const text = String(value ?? '').trim();
  const last = text.split(/[?#]/)[0]?.split('/').filter(Boolean).pop() ?? '';
  if (!/^[0-9a-f]{20}$/.test(last)) {
    throw new ToolFailure('item_id is not a Qiita article ID: use the 20 hexadecimal characters at the end of the article\'s link, or the link. Nothing was sent.');
  }
  return last;
}

function tagsOf(item: any): Array<{ name: string; versions: string[] }> {
  return Array.isArray(item?.tags)
    ? item.tags.map((tag: any) => ({ name: String(tag?.name ?? ''), versions: Array.isArray(tag?.versions) ? tag.versions.map(String) : [] }))
    : [];
}

function tagsInput(tags: Array<{ name: string; versions?: string[] }>): Array<{ name: string; versions: string[] }> {
  return tags.map((tag) => ({ name: tag.name, versions: tag.versions ?? [] }));
}

/** The fields an agent needs from an article; the body only on request. */
function trimItem(item: any): Record<string, unknown> {
  return compact({
    id: item?.id,
    title: typeof item?.title === 'string' ? truncate(item.title, 300) : undefined,
    url: item?.url,
    status: item?.private === true ? 'limited_share' : 'public',
    author: item?.user?.id,
    created_at: item?.created_at,
    updated_at: item?.updated_at,
    likes: item?.likes_count,
    stocks: item?.stocks_count,
    comments: item?.comments_count,
    page_views: typeof item?.page_views_count === 'number' ? item.page_views_count : undefined,
    tags: tagsOf(item),
    organization: item?.organization_url_name ?? undefined,
    slide: item?.slide === true ? true : undefined,
    body_length: typeof item?.body === 'string' ? item.body.length : undefined,
  });
}

/** Qiita's hourly allowance after this request: what is left and when the hour resets. */
function rateLimit(headers: Headers): Record<string, unknown> | undefined {
  const remaining = Number(headers.get('rate-remaining'));
  const reset = Number(headers.get('rate-reset'));
  if (!Number.isFinite(remaining) || headers.get('rate-remaining') === null) return undefined;
  return compact({
    remaining,
    resets_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined,
  });
}

function totalCount(headers: Headers): number | undefined {
  const value = Number(headers.get('total-count'));
  return headers.get('total-count') !== null && Number.isFinite(value) ? value : undefined;
}

async function getItem(h: ToolHelpers, id: string) {
  return h.api({ path: `${BASE}/items/${id}`, errors: { 404: 'Qiita found no article with that ID: it may have been deleted' } });
}

const SORTS: Record<string, (a: any, b: any) => number> = {
  likes: (a, b) => (b?.likes_count ?? 0) - (a?.likes_count ?? 0),
  stocks: (a, b) => (b?.stocks_count ?? 0) - (a?.stocks_count ?? 0),
  comments: (a, b) => (b?.comments_count ?? 0) - (a?.comments_count ?? 0),
  updated: (a, b) => String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')),
};

const WRITE_ERRORS = {
  403: 'Qiita refused the change: the token may lack the write_qiita scope, or the article is not this account\'s',
  404: 'Qiita found no article with that ID: it may have been deleted',
};

const connector = defineConnector({
  vendor: 'qiita',
  label: 'Qiita',
  origins: ['https://qiita.com'],
  credentials: ['token'],
  credentialLabels: { token: 'Qiita access token' },
  normalizeCredentials: (credentials) => ({ ...credentials, token: (credentials['token'] ?? '').replace(/^Bearer\s+/i, '') }),
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['token']}` }),
  tools: [
    {
      name: 'get_my_account',
      kind: 'read',
      title: 'Get my Qiita account',
      description:
        'Checks the token and returns the account: its ID and name, article, follower and following counts, whether it is a team-only '
        + 'account (set up for Qiita Team, which this connector does not cover), the image upload allowance of Qiita\'s editor this month, '
        + 'and the API requests left this hour.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data, headers } = await h.api({ path: `${BASE}/authenticated_user` });
        return compact({
          id: data?.id,
          name: data?.name || undefined,
          articles: data?.items_count,
          followers: data?.followers_count,
          following: data?.followees_count,
          team_only: data?.team_only === true,
          image_uploads_left_bytes: data?.image_monthly_upload_remaining,
          image_upload_limit_bytes: data?.image_monthly_upload_limit,
          rate_limit: rateLimit(headers),
        });
      },
    },
    {
      name: 'list_my_articles',
      kind: 'read',
      title: 'List my Qiita articles with likes and stocks',
      description:
        'The account\'s own articles, limited-share ones included, with likes, stocks, comments and tags, newest first. sort ranks them by '
        + 'likes, stocks, comments or last update across all of the account\'s articles (up to 1,000, read 100 per request). Lists carry no page '
        + 'views: get_article gives them for one article. Counts are as of the call. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['newest', 'likes', 'stocks', 'comments', 'updated'], default: 'newest', description: 'newest (default), likes, stocks, comments or updated.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Articles per page, 1 to 100 (default 20).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result; pass the same sort.' },
        },
        additionalProperties: false,
      },
      async run(args: { sort: string; per_page: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const perPage = typeof state?.['n'] === 'number' ? state['n'] : args.per_page;
        if (args.sort === 'newest') {
          const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
          const { data, headers } = await h.api({ path: `${BASE}/authenticated_user/items`, query: { page, per_page: perPage }, maxBytes: LIST_REPLY_BYTES });
          const items: any[] = Array.isArray(data) ? data : [];
          const total = totalCount(headers);
          const more = total !== undefined ? page * perPage < total : items.length >= perPage;
          return h.page({
            key: 'articles',
            items: items.map(trimItem).slice(skip),
            extra: compact({ total_count: total, page, rate_limit: rateLimit(headers) }),
            resumeAt: (index) => h.makeCursor({ p: page, o: skip + index, n: perPage }),
            ...(more && page < 100 ? { nextPage: h.makeCursor({ p: page + 1, o: 0, n: perPage }) } : {}),
          });
        }
        // A ranking reads every article (up to 1,000) and sorts them.
        const all: any[] = [];
        let total: number | undefined;
        let headers: Headers | undefined;
        for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
          const response = await h.api({ path: `${BASE}/authenticated_user/items`, query: { page, per_page: 100 }, maxBytes: LIST_REPLY_BYTES });
          headers = response.headers;
          total = totalCount(response.headers) ?? total;
          const items: any[] = Array.isArray(response.data) ? response.data : [];
          all.push(...items);
          if (items.length < 100 || (total !== undefined && all.length >= total)) break;
        }
        const sorted = [...all].sort(SORTS[args.sort]);
        const shown = sorted.slice(skip, skip + perPage).map(trimItem);
        return h.page({
          key: 'articles',
          items: shown,
          extra: compact({ sorted_by: args.sort, total_count: total, ranked: all.length, rate_limit: headers ? rateLimit(headers) : undefined }),
          resumeAt: (index) => h.makeCursor({ o: skip + index, n: perPage }),
          ...(skip + perPage < sorted.length ? { nextPage: h.makeCursor({ o: skip + perPage, n: perPage }) } : {}),
        });
      },
    },
    {
      name: 'get_article',
      kind: 'read',
      title: 'Get a Qiita article',
      description:
        'One article: title, status (limited share or public), link, tags, likes, stocks, comments, and its page views when it is the '
        + 'account\'s own (Qiita gives them only to the author, one article at a time). include_body returns its Markdown, in windows of about '
        + '24 KB: pass nextCursor back as cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: ITEM_ID,
          include_body: { type: 'boolean', default: false, description: 'Return the Markdown body too (default false).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
      async run(args: { item_id: string; include_body: boolean; cursor?: string }, h) {
        const id = itemId(args.item_id);
        const { data, headers } = await getItem(h, id);
        const result: Record<string, unknown> = { ...trimItem(data), rate_limit: rateLimit(headers) };
        if (args.include_body || args.cursor) {
          const body = typeof data?.body === 'string' ? data.body : '';
          const state = h.cursor(args.cursor);
          const window = bodyWindow(body, typeof state?.['o'] === 'number' ? state['o'] : 0);
          result['body'] = window.text;
          if (window.offset) result['body_offset'] = window.offset;
          if (window.next !== undefined) result['nextCursor'] = h.makeCursor({ o: window.next });
        }
        return compact(result);
      },
    },
    {
      name: 'search_articles',
      kind: 'read',
      title: 'Search Qiita articles',
      description:
        'Searches public Qiita articles, to see what exists on a topic and pick tags before writing. query takes Qiita\'s search terms: '
        + 'title:, body:, code:, tag: (tag:Ruby,Rails is either), -tag:, user:, org:, stocks:>3, created:>=2026-01-01, updated:>=2026-01 and OR. '
        + 'Each result has its author, likes, stocks, comments and tags. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500, description: 'Search terms, e.g. "tag:Python title:pandas stocks:>50".' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Articles per page, 1 to 100 (default 20).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result; pass the same query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; per_page: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const perPage = typeof state?.['n'] === 'number' ? state['n'] : args.per_page;
        const { data, headers } = await h.api({ path: `${BASE}/items`, query: { page, per_page: perPage, query: args.query }, maxBytes: LIST_REPLY_BYTES });
        const items: any[] = Array.isArray(data) ? data : [];
        const total = totalCount(headers);
        const more = total !== undefined ? page * perPage < total : items.length >= perPage;
        return h.page({
          key: 'articles',
          items: items.map((item) => {
            const { body_length: _length, status: _status, ...rest } = trimItem(item);
            return rest;
          }).slice(skip),
          extra: compact({ total_count: total, page, rate_limit: rateLimit(headers) }),
          resumeAt: (index) => h.makeCursor({ p: page, o: skip + index, n: perPage }),
          ...(more && page < 100 ? { nextPage: h.makeCursor({ p: page + 1, o: 0, n: perPage }) } : {}),
        });
      },
    },
    {
      name: 'get_tag',
      kind: 'read',
      title: 'Get a Qiita tag',
      description: 'One tag as Qiita spells it, with how many articles carry it and how many people follow it. Works for tags such as C# or 初心者 too.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 100, description: 'The tag name, e.g. Python.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string }, h) {
        const { data } = await h.api({ path: `${BASE}/tags/${encodeURIComponent(args.name)}`, errors: { 404: 'Qiita has no tag with that name' } });
        return compact({ name: data?.id, articles: data?.items_count, followers: data?.followers_count, icon_url: data?.icon_url ?? undefined });
      },
    },
    {
      name: 'list_tags',
      kind: 'read',
      title: 'List Qiita tags',
      description: 'Qiita\'s tags, the most used first (or by name), with their article and follower counts. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['count', 'name'], default: 'count', description: 'count (most used first, default) or name.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Tags per page, 1 to 100 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { sort: string; per_page: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const perPage = typeof state?.['n'] === 'number' ? state['n'] : args.per_page;
        const { data, headers } = await h.api({ path: `${BASE}/tags`, query: { page, per_page: perPage, sort: args.sort } });
        const tags: any[] = Array.isArray(data) ? data : [];
        return h.page({
          key: 'tags',
          items: tags.map((tag) => compact({ name: tag?.id, articles: tag?.items_count, followers: tag?.followers_count })).slice(skip),
          extra: compact({ page, rate_limit: rateLimit(headers) }),
          resumeAt: (index) => h.makeCursor({ p: page, o: skip + index, n: perPage }),
          ...(tags.length >= perPage && page < 100 ? { nextPage: h.makeCursor({ p: page + 1, o: 0, n: perPage }) } : {}),
        });
      },
    },
    {
      name: 'create_article',
      kind: 'create',
      check: 'list_my_articles',
      title: 'Save a Qiita article',
      description:
        'Saves a new article. By default it is a limited-share article, Qiita\'s draft: only you and people with its link can open it. '
        + 'public: true posts it publicly at once, and a public article can never go back to limited share. An Organization link and tweet '
        + '(a share from the social account linked to Qiita) go with public articles only. @mentions notify people only once the article is public.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255, description: 'A concrete, searchable title naming the technology and the result.' },
          body: { type: 'string', minLength: 1, maxLength: 500000, description: BODY_HELP },
          tags: TAGS_SCHEMA,
          public: { type: 'boolean', default: false, description: 'false (default): limited share. true: public at once, for good.' },
          organization_url_name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: 'Link the article to an Organization the account belongs to (public articles only).' },
          tweet: { type: 'boolean', default: false, description: 'Share the article from the social account linked to Qiita (public articles only). Only when asked.' },
          slide: { type: 'boolean', default: false, description: 'Show the article in slide mode.' },
        },
        required: ['title', 'body', 'tags'],
        additionalProperties: false,
      },
      async run(args: { title: string; body: string; tags: Array<{ name: string; versions?: string[] }>; public: boolean; organization_url_name?: string; tweet: boolean; slide: boolean }, h) {
        if (!args.public && (args.organization_url_name !== undefined || args.tweet)) {
          throw new ToolFailure('A limited-share article cannot be linked to an Organization or shared with tweet: those go with public: true. Nothing was sent.');
        }
        const { data, headers } = await h.api({
          method: 'POST',
          path: `${BASE}/items`,
          json: compact({
            title: args.title,
            body: args.body,
            tags: tagsInput(args.tags),
            private: !args.public,
            organization_url_name: args.organization_url_name,
            tweet: args.tweet ? true : undefined,
            slide: args.slide ? true : undefined,
          }),
          write: true,
          errors: { 403: WRITE_ERRORS[403] },
        });
        return compact({ ...trimItem(data), note: args.public ? PUBLIC_NOTE : LIMITED_NOTE, rate_limit: rateLimit(headers) });
      },
    },
    {
      name: 'update_article',
      kind: 'update',
      check: 'get_article',
      title: 'Update a Qiita article',
      description:
        'Changes an article\'s title, body, tags or slide mode; what is left out stays as Qiita has it (the tool reads the article first). '
        + 'It never changes limited share or public. A public article changes for its readers at once. body replaces the whole body: read it '
        + 'with get_article (include_body) first.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: ITEM_ID,
          title: { type: 'string', minLength: 1, maxLength: 255, description: 'A new title.' },
          body: { type: 'string', minLength: 1, maxLength: 500000, description: `The whole new body. ${BODY_HELP}` },
          tags: { ...TAGS_SCHEMA, description: 'The new tags (they replace all tags), 1 to 5.' },
          organization_url_name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: 'Link a public article to an Organization the account belongs to.' },
          slide: { type: 'boolean', description: 'Turn slide mode on or off.' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
      async run(args: { item_id: string; title?: string; body?: string; tags?: Array<{ name: string; versions?: string[] }>; organization_url_name?: string; slide?: boolean }, h) {
        const id = itemId(args.item_id);
        if ([args.title, args.body, args.tags, args.organization_url_name, args.slide].every((value) => value === undefined)) {
          throw new ToolFailure('Nothing to change: give title, body, tags, organization_url_name or slide. Nothing was changed.');
        }
        const { data: current } = await getItem(h, id);
        if (current?.private === true && args.organization_url_name !== undefined) {
          throw new ToolFailure('A limited-share article cannot be linked to an Organization: link it when it goes public (make_article_public). Nothing was changed.');
        }
        const { data, headers } = await h.api({
          method: 'PATCH',
          path: `${BASE}/items/${id}`,
          json: compact({
            title: args.title ?? current?.title,
            body: args.body ?? current?.body,
            tags: args.tags ? tagsInput(args.tags) : tagsOf(current),
            organization_url_name: args.organization_url_name,
            slide: args.slide,
          }),
          write: true,
          errors: WRITE_ERRORS,
        });
        return compact({ ...trimItem(data), updated: true, rate_limit: rateLimit(headers) });
      },
    },
    {
      name: 'make_article_public',
      kind: 'update',
      check: 'get_article',
      title: 'Make a Qiita article public',
      description:
        'Publishes a limited-share article: it becomes public, search engines can list it, and @mentions notify people. This is final: Qiita '
        + 'cannot turn a public article back into a limited-share one (only deleting takes it down), and every revision saved while it was '
        + 'limited becomes visible in its edit history. The tool reads the article first and keeps its title, body and tags.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: ITEM_ID,
          organization_url_name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$', description: 'Link it to an Organization the account belongs to.' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
      async run(args: { item_id: string; organization_url_name?: string }, h) {
        const id = itemId(args.item_id);
        const { data: current } = await getItem(h, id);
        if (current?.private !== true && args.organization_url_name === undefined) {
          return compact({ ...trimItem(current), already_public: true });
        }
        const { data, headers } = await h.api({
          method: 'PATCH',
          path: `${BASE}/items/${id}`,
          json: compact({
            title: current?.title,
            body: current?.body,
            tags: tagsOf(current),
            private: false,
            organization_url_name: args.organization_url_name,
          }),
          write: true,
          errors: WRITE_ERRORS,
        });
        return compact({ ...trimItem(data), note: PUBLIC_NOTE, rate_limit: rateLimit(headers) });
      },
    },
    {
      name: 'delete_article',
      kind: 'delete',
      check: 'get_article',
      title: 'Delete a Qiita article',
      description: 'Deletes an article for good, with its likes, stocks and comments. The API cannot bring it back.',
      inputSchema: {
        type: 'object',
        properties: { item_id: ITEM_ID },
        required: ['item_id'],
        additionalProperties: false,
      },
      async run(args: { item_id: string }, h) {
        const id = itemId(args.item_id);
        const { headers } = await h.api({ method: 'DELETE', path: `${BASE}/items/${id}`, write: true, errors: WRITE_ERRORS });
        return compact({ deleted: true, id, rate_limit: rateLimit(headers) });
      },
    },
    // The rest of Qiita API v2: comments, stocks, likes, followers, users, organizations.
    ...apiTools({
      label: 'Qiita',
      description:
        'Qiita API v2 at https://qiita.com/api/v2, with the connected token: paths start with /api/v2/, such as /api/v2/items/{id}/comments, '
        + '/api/v2/users/{user}/stocks or /api/v2/items/{id}/stock (PUT to stock, DELETE to unstock). Reference: https://qiita.com/api/v2/docs.',
      basePath: '/api/v2/',
      responseHeaders: ['total-count', 'rate-remaining', 'rate-reset'],
    }),
  ],
});

/** A window of a long body that fits about 24 KB once JSON-encoded, ending at a line break when one is near. */
function bodyWindow(text: string, offset: number): { text: string; offset: number; next?: number } {
  const budget = 24_000;
  const encoder = new TextEncoder();
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const rest = text.length - start;
  const size = (count: number): number => encoder.encode(JSON.stringify(text.slice(start, start + count))).length;
  let count = Math.min(rest, budget);
  if (size(count) > budget) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(middle) <= budget) low = middle;
      else high = middle - 1;
    }
    count = low;
  }
  if (count < rest) {
    const lineBreak = text.lastIndexOf('\n', start + count - 1);
    if (lineBreak >= start + Math.floor(count / 2)) count = lineBreak + 1 - start;
    const code = text.charCodeAt(start + count - 1);
    if (code >= 0xd800 && code <= 0xdbff) count -= 1;
  }
  const end = start + Math.max(count, 0);
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { next: end } : {}) };
}

export = connector;
