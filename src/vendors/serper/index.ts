// Serper: Google search results as JSON (https://serper.dev): the web, news,
// images, videos, places and maps with their reviews, shopping, scholar,
// patents, autocomplete suggestions and visual matches for an image.
//
// Credential: `apikey`, a Serper API key from the serper.dev dashboard. It is
// sent in the X-API-KEY header to https://google.serper.dev only. The location
// lookup on https://api.serper.dev is public and gets no key.

import { defineConnector, ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import {
  compact,
  listOf,
  num,
  text,
  trimAnswerBox,
  trimImage,
  trimKnowledgeGraph,
  trimLensMatch,
  trimLocation,
  trimNews,
  trimOrganic,
  trimPatent,
  trimPlace,
  trimReview,
  trimScholar,
  trimShopping,
  trimTopic,
  trimVideo,
  type Item,
} from './trim.js';

type JsonSchema = ToolDefinition['inputSchema'];

const SEARCH_ORIGIN = 'https://google.serper.dev';
const LOCATIONS_ORIGIN = 'https://api.serper.dev';
/** The last result page a cursor goes on to. */
const MAX_PAGE = 10;
/** A map position, "@latitude,longitude,zoomz" (Serper takes it without the zoom too). */
const LL_PATTERN = '^@-?\\d{1,3}(\\.\\d+)?,-?\\d{1,3}(\\.\\d+)?(,\\d{1,2}(\\.\\d+)?z)?$';
const LL = new RegExp(LL_PATTERN);

const ERRORS = {
  400: 'Serper could not run this search: check the query and the options.',
  403: 'Serper refused the API key: it may be wrong, disabled, or out of credits.',
};

type Option = 'num' | 'gl' | 'hl' | 'location' | 'tbs' | 'autocorrect';

interface SearchArgs {
  q: string;
  num?: number;
  page?: number;
  gl?: string;
  hl?: string;
  location?: string;
  tbs?: string;
  autocorrect?: boolean;
  cursor?: string;
}

const QUERY: JsonSchema = { type: 'string', minLength: 1, maxLength: 2048, description: 'The search query, as you would type it into Google.' };
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result, for the next page.' };
const PAGE: JsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_PAGE,
  description: `The result page to start at, 1 to ${MAX_PAGE} (default 1). nextCursor goes on from there.`,
};
/** Results per page: Google shows at most 10 web, news, video or patent results a page. */
const NUM_10: JsonSchema = { type: 'integer', minimum: 1, maximum: 10, default: 10, description: 'Results per page, 1 to 10 (default 10): Google shows at most 10 a page.' };
const OPTIONS: Record<Option, JsonSchema> = {
  num: NUM_10,
  gl: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Two-letter country code to search from, e.g. "us" or "de".' },
  hl: { type: 'string', pattern: '^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$', description: 'Interface language code, e.g. "en" or "pt-br".' },
  location: {
    type: 'string',
    minLength: 2,
    maxLength: 200,
    description: 'A place to search from, as Google names it, e.g. "Austin,Texas,United States" (find_locations gives the exact names).',
  },
  tbs: {
    type: 'string',
    enum: ['qdr:h', 'qdr:d', 'qdr:w', 'qdr:m', 'qdr:y'],
    description: 'Only results from the past hour (qdr:h), day (qdr:d), week (qdr:w), month (qdr:m) or year (qdr:y).',
  },
  autocorrect: { type: 'boolean', description: 'Let Google correct the spelling of the query (default true).' },
};

/** The request body of a Serper search, from the arguments that were given. */
function searchBody(args: SearchArgs, page: number): Record<string, unknown> {
  return compact({
    q: args.q,
    num: args.num,
    page,
    gl: args.gl?.toLowerCase(),
    hl: args.hl?.toLowerCase(),
    location: args.location,
    tbs: args.tbs,
    autocorrect: args.autocorrect,
  });
}

async function search(h: ToolHelpers, path: string, body: Record<string, unknown>): Promise<any> {
  // A search changes nothing: POST is only how Serper takes the query.
  const { data } = await h.api({ method: 'POST', origin: SEARCH_ORIGIN, path, json: body, safe: true, errors: ERRORS });
  return data;
}

/** The page to ask Serper for and how many of its results were already returned, from the cursor or the arguments. */
function position(h: ToolHelpers, args: { cursor?: string; page?: number }): { page: number; skip: number } {
  const state = h.cursor(args.cursor);
  return {
    page: typeof state?.['p'] === 'number' ? state['p'] : args.page ?? 1,
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
  };
}

function notEmpty(item: Record<string, unknown>): boolean {
  return Object.keys(item).length > 0;
}

interface ListSearch {
  name: string;
  title: string;
  description: string;
  /** The Serper endpoint, e.g. "/news". */
  path: string;
  /** The list in Serper's reply, e.g. "news". */
  listKey: string;
  /** The list in the result. */
  resultKey: string;
  trim(item: Item): Record<string, unknown>;
  options: Option[];
  /** The num option when this search's pages hold another number of results than 10. */
  num?: JsonSchema;
  /** How many results a full page has when the tool takes no num. */
  pageSize: number;
}

/** A search that returns one list of results, paged by Serper's page number. */
function listSearch(spec: ListSearch): ToolDefinition {
  const properties: Record<string, JsonSchema> = { q: QUERY };
  if (spec.options.includes('num')) properties['num'] = spec.num ?? OPTIONS.num;
  properties['page'] = PAGE;
  for (const option of spec.options) if (option !== 'num') properties[option] = OPTIONS[option];
  properties['cursor'] = CURSOR;
  return {
    name: spec.name,
    kind: 'read',
    title: spec.title,
    description: spec.description,
    inputSchema: { type: 'object', properties, required: ['q'], additionalProperties: false },
    async run(args: SearchArgs, h) {
      const { page, skip } = position(h, args);
      const data = await search(h, spec.path, searchBody(args, page));
      const items = listOf(data, spec.listKey);
      const full = items.length >= (args.num ?? spec.pageSize);
      return h.page({
        key: spec.resultKey,
        items: items.map(spec.trim).filter(notEmpty).slice(skip),
        extra: compact({ query: args.q, page, creditsUsed: num(data?.credits) }),
        resumeAt: (index) => h.makeCursor({ p: page, o: skip + index }),
        ...(full && page < MAX_PAGE ? { nextPage: h.makeCursor({ p: page + 1, o: 0 }) } : {}),
      });
    },
  };
}

const webSearch: ToolDefinition = {
  name: 'web_search',
  kind: 'read',
  title: 'Search the web (Google results via Serper)',
  description:
    'Searches Google through Serper and returns the organic results (title, link, snippet, position, date), '
    + 'plus the answer box, knowledge graph, related questions and related searches when Google shows them. '
    + 'Options for country, language, location, freshness and the page. Read the pages themselves with a fetch tool. '
    + 'Each call uses one Serper credit. Pass nextCursor back as cursor for the next page.',
  inputSchema: {
    type: 'object',
    properties: {
      q: QUERY,
      num: OPTIONS.num,
      page: PAGE,
      gl: OPTIONS.gl,
      hl: OPTIONS.hl,
      location: OPTIONS.location,
      tbs: OPTIONS.tbs,
      autocorrect: OPTIONS.autocorrect,
      cursor: CURSOR,
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args: SearchArgs & { num: number }, h) {
    const { page, skip } = position(h, args);
    const data = await search(h, '/search', searchBody(args, page));
    const organic = listOf(data, 'organic');
    const firstPage = page === 1 && skip === 0;
    return h.page({
      key: 'results',
      items: organic.map(trimOrganic).filter(notEmpty).slice(skip),
      extra: compact({
        query: args.q,
        page,
        answerBox: firstPage ? trimAnswerBox(data?.answerBox) : undefined,
        knowledgeGraph: firstPage ? trimKnowledgeGraph(data?.knowledgeGraph) : undefined,
        peopleAlsoAsk: firstPage && Array.isArray(data?.peopleAlsoAsk)
          ? listOf(data, 'peopleAlsoAsk').slice(0, 5).map((item) => compact({ question: text(item['question'], 300), snippet: text(item['snippet'], 600), link: text(item['link'], 2000) }))
          : undefined,
        relatedSearches: firstPage && Array.isArray(data?.relatedSearches)
          ? listOf(data, 'relatedSearches').slice(0, 8).map((item) => text(item['query'], 200)).filter(Boolean)
          : undefined,
      }),
      resumeAt: (index) => h.makeCursor({ p: page, o: skip + index }),
      ...(organic.length >= args.num && page < MAX_PAGE ? { nextPage: h.makeCursor({ p: page + 1, o: 0 }) } : {}),
    });
  },
};

const mapsSearch: ToolDefinition = {
  name: 'maps_search',
  kind: 'read',
  title: 'Search Google Maps via Serper',
  description:
    'Searches Google Maps through Serper: places with address, coordinates, rating and review count, price level, type, '
    + 'opening hours, phone, website, and the cid, fid and placeId that place_reviews takes. Search around a point with ll, '
    + 'or look up one place by place_id or cid. Each call uses three Serper credits. Pass nextCursor back as cursor for the '
    + 'next page: it keeps the map position (ll) that pages after the first need.',
  inputSchema: {
    type: 'object',
    properties: {
      q: QUERY,
      ll: {
        type: 'string',
        pattern: LL_PATTERN,
        description: 'The map position and zoom to search around, as "@latitude,longitude,zoomz" (zoom 3 to 21, optional), e.g. "@40.7128,-74.0060,14z". '
          + 'Needed for a page after the first (each result gives the ll it used); not used by a place_id or cid lookup.',
      },
      place_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Look up one place by its Google place ID.' },
      cid: { type: 'string', pattern: '^[0-9]{1,25}$', description: 'Look up one place by its Google cid (a number).' },
      page: PAGE,
      gl: OPTIONS.gl,
      hl: OPTIONS.hl,
      cursor: CURSOR,
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args: { q: string; ll?: string; place_id?: string; cid?: string; page?: number; gl?: string; hl?: string; cursor?: string }, h) {
    const state = h.cursor(args.cursor);
    const page = typeof state?.['p'] === 'number' ? state['p'] : args.page ?? 1;
    const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
    // Serper needs the map position for every page after the first; a cursor carries the one the search used.
    const ll = typeof state?.['l'] === 'string' ? state['l'] : args.ll;
    const lookup = args.place_id !== undefined || args.cid !== undefined;
    if (lookup && page > 1) throw new ToolFailure('A lookup by place_id or cid has one page only. Nothing was sent to Serper.');
    if (page > 1 && !ll) {
      throw new ToolFailure(
        'Google Maps pages after the first need ll, the map position: give the ll of the first page\'s result, or pass its nextCursor, '
          + 'which carries it. Nothing was sent to Serper.',
      );
    }
    const data = await search(h, '/maps', compact({
      q: args.q,
      ll,
      placeId: args.place_id,
      cid: args.cid,
      page,
      gl: args.gl?.toLowerCase(),
      hl: args.hl?.toLowerCase(),
    }));
    const places = listOf(data, 'places');
    // The position the next page searches around: the one given, else the one Serper chose for the query.
    const replyLl = text(data?.ll, 60);
    const nextLl = ll ?? (replyLl && LL.test(replyLl) ? replyLl : undefined);
    return h.page({
      key: 'places',
      items: places.map(trimPlace).filter(notEmpty).slice(skip),
      extra: compact({ query: args.q, page, ll: replyLl, creditsUsed: num(data?.credits) }),
      resumeAt: (index) => h.makeCursor({ p: page, o: skip + index, ...(ll ? { l: ll } : {}) }),
      ...(!lookup && nextLl && places.length >= 10 && page < MAX_PAGE ? { nextPage: h.makeCursor({ p: page + 1, o: 0, l: nextLl }) } : {}),
    });
  },
};

const placeReviews: ToolDefinition = {
  name: 'place_reviews',
  kind: 'read',
  title: 'Read the Google reviews of a place via Serper',
  description:
    'The Google reviews of one place, found by the cid, fid or place_id that maps_search and places_search return: rating, date, '
    + 'text, likes, the reviewer\'s name and the owner\'s reply, newest or most relevant first, plus the topics Google groups them by '
    + '(pass a topic id as topic_id to read only those). Each call uses one Serper credit. Pass nextCursor back as cursor for more.',
  inputSchema: {
    type: 'object',
    properties: {
      cid: { type: 'string', pattern: '^[0-9]{1,25}$', description: 'The place\'s Google cid.' },
      fid: { type: 'string', minLength: 1, maxLength: 100, description: 'The place\'s Google feature id, e.g. "0x89c25a197c06b7cb:0x40a06c78f79e5de6".' },
      place_id: { type: 'string', minLength: 1, maxLength: 200, description: 'The place\'s Google place ID.' },
      sort_by: {
        type: 'string',
        enum: ['mostRelevant', 'newest', 'highestRating', 'lowestRating'],
        description: 'The order: mostRelevant (Google\'s default), newest, highestRating or lowestRating.',
      },
      topic_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Only the reviews of one topic, from the topics of an earlier result.' },
      gl: OPTIONS.gl,
      hl: OPTIONS.hl,
      cursor: CURSOR,
    },
    additionalProperties: false,
  },
  async run(args: { cid?: string; fid?: string; place_id?: string; sort_by?: string; topic_id?: string; gl?: string; hl?: string; cursor?: string }, h) {
    if (!args.cid && !args.fid && !args.place_id) {
      throw new ToolFailure('Give the place\'s cid, fid or place_id (maps_search and places_search return them). Nothing was sent to Serper.');
    }
    const state = h.cursor(args.cursor);
    // "t" is taken: a cursor keeps its tool's name there.
    const token = typeof state?.['n'] === 'string' ? state['n'] : undefined;
    const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
    const data = await search(h, '/reviews', compact({
      cid: args.cid,
      fid: args.fid,
      placeId: args.place_id,
      sortBy: args.sort_by,
      topicId: args.topic_id,
      nextPageToken: token,
      gl: args.gl?.toLowerCase(),
      hl: args.hl?.toLowerCase(),
    }));
    const topics = !token && skip === 0 ? listOf(data, 'topics').slice(0, 20).map(trimTopic).filter(notEmpty) : [];
    const next = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
    return h.page({
      key: 'reviews',
      items: listOf(data, 'reviews').map(trimReview).filter(notEmpty).slice(skip),
      extra: compact({ topics: topics.length ? topics : undefined, creditsUsed: num(data?.credits) }),
      resumeAt: (index) => h.makeCursor({ ...(token ? { n: token } : {}), o: skip + index }),
      ...(next ? { nextPage: h.makeCursor({ n: next, o: 0 }) } : {}),
    });
  },
};

const autocomplete: ToolDefinition = {
  name: 'autocomplete',
  kind: 'read',
  title: 'Get Google autocomplete suggestions via Serper',
  description:
    'The searches Google suggests as someone types a query, in Google\'s order: what people look for around a topic, for keyword '
    + 'and content research. Each call uses one Serper credit.',
  inputSchema: {
    type: 'object',
    properties: { q: { ...QUERY, description: 'The start of a query, e.g. "best running shoes for".' }, gl: OPTIONS.gl, hl: OPTIONS.hl, location: OPTIONS.location },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args: SearchArgs, h) {
    const data = await search(h, '/autocomplete', compact({ q: args.q, gl: args.gl?.toLowerCase(), hl: args.hl?.toLowerCase(), location: args.location }));
    const suggestions = listOf(data, 'suggestions').map((item) => text(item['value'], 300)).filter((item): item is string => item !== undefined);
    return compact({ query: args.q, suggestions, creditsUsed: num(data?.credits) });
  },
};

const lensSearch: ToolDefinition = {
  name: 'lens_search',
  kind: 'read',
  title: 'Find an image on the web (Google Lens via Serper)',
  description:
    'Searches the web for an image by its public URL, as Google Lens does: pages and products that show it or look like it, with '
    + 'title, source, link, price and stock when Google has them. Serper downloads the image itself. Each call uses three Serper credits. '
    + 'Pass nextCursor back as cursor when the result was cut.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2000, description: 'The public http(s) URL of the image.' },
      gl: OPTIONS.gl,
      hl: OPTIONS.hl,
      cursor: CURSOR,
    },
    required: ['url'],
    additionalProperties: false,
  },
  async run(args: { url: string; gl?: string; hl?: string; cursor?: string }, h) {
    const { skip } = position(h, args);
    const data = await search(h, '/lens', compact({ url: args.url, gl: args.gl?.toLowerCase(), hl: args.hl?.toLowerCase() }));
    const matches = listOf(data, 'organic').length ? listOf(data, 'organic') : listOf(data, 'visualMatches');
    return h.page({
      key: 'matches',
      items: matches.map(trimLensMatch).filter(notEmpty).slice(skip),
      extra: compact({ creditsUsed: num(data?.credits) }),
      resumeAt: (index) => h.makeCursor({ o: skip + index }),
    });
  },
};

const findLocations: ToolDefinition = {
  name: 'find_locations',
  kind: 'read',
  title: 'Find Serper location names',
  description:
    'Looks up the place names the location option of the searches takes, e.g. "austin" gives "Austin,TX,Texas,United States": '
    + 'the canonical name to pass as location, with the country code and the kind of place (country, state, city, region). '
    + 'Free: it uses no Serper credits.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 100, description: 'A place name or its start, e.g. "austin" or "berlin".' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'How many places to return, 1 to 100 (default 10).' },
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(args: { q: string; limit: number }, h) {
    // A public list: the key is not needed, so it is not sent.
    const { data } = await h.api({ origin: LOCATIONS_ORIGIN, path: '/locations', query: { q: args.q, limit: args.limit }, auth: false });
    const locations = (Array.isArray(data) ? data : []).map((item: unknown) => trimLocation(typeof item === 'object' && item !== null ? (item as Item) : {})).filter(notEmpty);
    return { query: args.q, locations };
  },
};

const connector = defineConnector({
  vendor: 'serper',
  label: 'Serper',
  origins: [SEARCH_ORIGIN, LOCATIONS_ORIGIN],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'Serper API key' },
  authHeaders: (credentials) => ({ 'x-api-key': credentials['apikey'] as string }),
  tools: [
    webSearch,
    listSearch({
      name: 'news_search',
      title: 'Search the news (Google News via Serper)',
      description:
        'Searches Google News through Serper: articles with title, link, snippet, source, date and image link, newest stories first '
        + 'when you set tbs. Each call uses one Serper credit. Pass nextCursor back as cursor for the next page.',
      path: '/news',
      listKey: 'news',
      resultKey: 'news',
      trim: trimNews,
      options: ['num', 'gl', 'hl', 'location', 'tbs', 'autocorrect'],
      pageSize: 10,
    }),
    listSearch({
      name: 'image_search',
      title: 'Search images (Google Images via Serper)',
      description:
        'Searches Google Images through Serper: each image with its URL, size, thumbnail, title and the page it is on, up to 100 a page. '
        + 'Each call uses one Serper credit, two when num is over 10. Pass nextCursor back as cursor for the next page.',
      path: '/images',
      listKey: 'images',
      resultKey: 'images',
      trim: trimImage,
      options: ['num', 'gl', 'hl', 'location', 'tbs', 'autocorrect'],
      num: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Results per page, 1 to 100 (default 10). Serper counts more than 10 as two searches.' },
      pageSize: 10,
    }),
    listSearch({
      name: 'video_search',
      title: 'Search videos (Google Videos via Serper)',
      description:
        'Searches Google Videos through Serper: each video with title, link, snippet, duration, source, channel, date and thumbnail. '
        + 'Each call uses one Serper credit. Pass nextCursor back as cursor for the next page.',
      path: '/videos',
      listKey: 'videos',
      resultKey: 'videos',
      trim: trimVideo,
      options: ['num', 'gl', 'hl', 'location', 'tbs', 'autocorrect'],
      pageSize: 10,
    }),
    listSearch({
      name: 'places_search',
      title: 'Search local places (Google Places via Serper)',
      description:
        'Searches Google\'s local results through Serper, such as "coffee shops in Austin": each place with address, coordinates, '
        + 'rating and review count, category, phone, website and the cid that place_reviews takes. Each call uses one Serper credit. '
        + 'Pass nextCursor back as cursor for the next page.',
      path: '/places',
      listKey: 'places',
      resultKey: 'places',
      trim: trimPlace,
      options: ['gl', 'hl', 'location'],
      pageSize: 10,
    }),
    mapsSearch,
    placeReviews,
    listSearch({
      name: 'shopping_search',
      title: 'Search products (Google Shopping via Serper)',
      description:
        'Searches Google Shopping through Serper: products with price, shop, delivery, rating and review count, offers and link, '
        + 'up to 40 a page. Each call uses two Serper credits. Pass nextCursor back as cursor for the next page.',
      path: '/shopping',
      listKey: 'shopping',
      resultKey: 'products',
      trim: trimShopping,
      options: ['num', 'gl', 'hl', 'location', 'autocorrect'],
      num: { type: 'integer', minimum: 1, maximum: 40, default: 40, description: 'Results per page, 1 to 40 (default 40): a Google Shopping page holds up to 40.' },
      pageSize: 40,
    }),
    listSearch({
      name: 'scholar_search',
      title: 'Search papers (Google Scholar via Serper)',
      description:
        'Searches Google Scholar through Serper: papers with title, link, publication, snippet, year, citation count and PDF link. '
        + 'Each call uses one Serper credit. Pass nextCursor back as cursor for the next page.',
      path: '/scholar',
      listKey: 'organic',
      resultKey: 'papers',
      trim: trimScholar,
      options: ['gl', 'hl', 'location', 'autocorrect'],
      pageSize: 10,
    }),
    listSearch({
      name: 'patent_search',
      title: 'Search patents (Google Patents via Serper)',
      description:
        'Searches Google Patents through Serper: patents with title, snippet, publication number, priority, filing, grant and '
        + 'publication dates, inventor, assignee and PDF link. Each call uses one Serper credit. '
        + 'Pass nextCursor back as cursor for the next page.',
      path: '/patents',
      listKey: 'organic',
      resultKey: 'patents',
      trim: trimPatent,
      options: ['num'],
      pageSize: 10,
    }),
    autocomplete,
    lensSearch,
    findLocations,
  ],
});

export = connector;
