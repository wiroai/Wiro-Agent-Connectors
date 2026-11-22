// Serper: Google search results as JSON (https://serper.dev).
//
// Credential: `api_key`, a Serper API key from the serper.dev dashboard. It is
// sent in the X-API-KEY header to https://google.serper.dev only.

import { defineConnector, truncate } from '../../core/index.js';

interface SearchArgs {
  q: string;
  num: number;
  gl?: string;
  hl?: string;
  tbs?: string;
  autocorrect?: boolean;
  cursor?: string;
}

interface OrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

const MAX_PAGE = 10;

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function trimOrganic(item: OrganicResult) {
  return compact({
    position: typeof item.position === 'number' ? item.position : undefined,
    title: text(item.title, 300),
    link: text(item.link, 2000),
    snippet: text(item.snippet, 600),
    date: text(item.date, 40),
  });
}

function trimAnswerBox(box: any) {
  if (!box || typeof box !== 'object') return undefined;
  const trimmedBox = compact({
    title: text(box.title, 300),
    answer: text(box.answer, 600),
    snippet: text(box.snippet, 1000),
    link: text(box.link, 2000),
  });
  return Object.keys(trimmedBox).length ? trimmedBox : undefined;
}

function trimKnowledgeGraph(graph: any) {
  if (!graph || typeof graph !== 'object') return undefined;
  const attributes = graph.attributes && typeof graph.attributes === 'object'
    ? Object.fromEntries(Object.entries(graph.attributes).slice(0, 12).map(([key, value]) => [truncate(key, 80), text(value, 200) ?? '']))
    : undefined;
  const trimmedGraph = compact({
    title: text(graph.title, 300),
    type: text(graph.type, 120),
    description: text(graph.description, 1000),
    website: text(graph.website, 2000),
    attributes,
  });
  return Object.keys(trimmedGraph).length ? trimmedGraph : undefined;
}

const connector = defineConnector({
  vendor: 'serper',
  label: 'Serper',
  origins: ['https://google.serper.dev'],
  credentials: ['api_key'],
  credentialLabels: { api_key: 'Serper API key' },
  authHeaders: (credentials) => ({ 'x-api-key': credentials['api_key'] as string }),
  tools: [
    {
      name: 'web_search',
      kind: 'read',
      title: 'Search the web (Google results via Serper)',
      description:
        'Searches Google through Serper and returns the organic results (title, link, snippet, position, date), '
        + 'plus the answer box, knowledge graph, related questions and related searches when Google shows them. '
        + 'Read the pages themselves with a fetch tool. Each call uses one Serper search credit, two when num is over 10. '
        + 'Pass nextCursor back as cursor for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 2048, description: 'The search query, as you would type it into Google.' },
          num: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Results per page, 1 to 20 (default 10).' },
          gl: { type: 'string', pattern: '^[a-z]{2}$', description: 'Two-letter country code to search from, e.g. "us" or "de".' },
          hl: { type: 'string', pattern: '^[a-z]{2,3}(-[a-z]{2,4})?$', description: 'Interface language code, e.g. "en" or "pt-br".' },
          tbs: {
            type: 'string',
            enum: ['qdr:h', 'qdr:d', 'qdr:w', 'qdr:m', 'qdr:y'],
            description: 'Only results from the past hour (qdr:h), day (qdr:d), week (qdr:w), month (qdr:m) or year (qdr:y).',
          },
          autocorrect: { type: 'boolean', description: 'Let Google correct the spelling of the query (default true).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result, for the next page.' },
        },
        required: ['q'],
        additionalProperties: false,
      },
      async run(args: SearchArgs, h) {
        const state = h.cursor(args.cursor);
        const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;

        const { data } = await h.api({
          method: 'POST',
          path: '/search',
          json: compact({ q: args.q, num: args.num, page, gl: args.gl, hl: args.hl, tbs: args.tbs, autocorrect: args.autocorrect }),
          // A search changes nothing: POST is only how Serper takes the query.
          safe: true,
          errors: {
            400: 'Serper could not run this search: check the query and the options.',
            403: 'Serper refused the API key: it may be wrong, disabled, or out of credits.',
          },
        });

        const organic: OrganicResult[] = Array.isArray(data?.organic) ? data.organic : [];
        const results = organic.map(trimOrganic).slice(skip);
        const firstPage = page === 1 && skip === 0;
        return h.page({
          key: 'results',
          items: results,
          extra: compact({
            query: args.q,
            page,
            answerBox: firstPage ? trimAnswerBox(data?.answerBox) : undefined,
            knowledgeGraph: firstPage ? trimKnowledgeGraph(data?.knowledgeGraph) : undefined,
            peopleAlsoAsk: firstPage && Array.isArray(data?.peopleAlsoAsk)
              ? data.peopleAlsoAsk.slice(0, 5).map((item: any) => compact({ question: text(item?.question, 300), snippet: text(item?.snippet, 600), link: text(item?.link, 2000) }))
              : undefined,
            relatedSearches: firstPage && Array.isArray(data?.relatedSearches)
              ? data.relatedSearches.slice(0, 8).map((item: any) => text(item?.query, 200)).filter(Boolean)
              : undefined,
          }),
          resumeAt: (index) => h.makeCursor({ p: page, o: skip + index }),
          ...(organic.length >= args.num && page < MAX_PAGE ? { nextPage: h.makeCursor({ p: page + 1, o: 0 }) } : {}),
        });
      },
    },
  ],
});

export = connector;
