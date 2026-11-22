// Calendarific: public, local, religious and bank holidays and observances
// for 230+ countries (https://calendarific.com), through its REST API v2 at
// https://calendarific.com/api/v2. Read only.
//
// Credential: `apikey`, the API key shown on the Calendarific account
// dashboard. Calendarific takes it only as the `api_key` query parameter.
// Every request counts toward the plan's monthly limit, errors included.

import { defineConnector, ToolFailure, truncate, type ApiRequest, type ToolDefinition, type ToolHelpers } from '../../core/index.js';

type JsonSchema = ToolDefinition['inputSchema'];
type Item = Record<string, any>;

const ORIGIN = 'https://calendarific.com';
const DAY_MS = 86_400_000;

const ERRORS = {
  401: 'Calendarific rejected the API key: check it on your Calendarific account dashboard',
  403: 'The Calendarific subscription of this API key has expired: renew it on calendarific.com',
  503: 'Calendarific is down for planned maintenance: try again later',
};

const TYPES = ['national', 'local', 'religious', 'observance'] as const;

const COUNTRY: JsonSchema = { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'The ISO 3166-1 alpha-2 country code, e.g. "US", "TR", "DE" or "JP" (list_countries has them all).' };
const LOCATION: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$',
  description: 'Only holidays of one state or region, as its ISO 3166-2 code, e.g. "us-ny" for New York.',
};
const HOLIDAY_TYPES: JsonSchema = {
  type: 'array',
  items: { type: 'string', enum: [...TYPES] },
  minItems: 1,
  maxItems: 4,
  uniqueItems: true,
  description: 'Only these kinds: national (public and bank holidays), local (regional), religious, observance (awareness days, seasons, cultural days). Default: all of them.',
};
const LANGUAGE: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z]{2}$',
  description: 'The ISO 639-1 language of names and descriptions, e.g. "fr" (list_languages). Paid plans only: the free plan answers in English.',
};
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result.' };

function apiKey(h: ToolHelpers): string {
  return h.credentials['apikey'] as string;
}

/** One GET of the API with the key added; a body whose meta code is not 200 is an error too. */
async function calendarificGet(h: ToolHelpers, endpoint: string, query: ApiRequest['query']): Promise<Item> {
  let data: unknown;
  try {
    ({ data } = await h.api({ origin: ORIGIN, path: `/api/v2/${endpoint}`, query: { ...query, api_key: apiKey(h) }, errors: ERRORS }));
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 429) {
      throw new ToolFailure(
        'The Calendarific request limit of this API key is used up for the month (HTTP 429). It resets when the plan\'s month starts again; '
          + 'a larger plan raises it. Every request counts, errors included.',
        error.details,
      );
    }
    throw error;
  }
  const meta = (data as Item | null)?.['meta'];
  if (typeof meta?.['code'] === 'number' && meta['code'] !== 200) {
    const detail = typeof meta['error_detail'] === 'string' ? truncate(meta['error_detail'].replace(/\s+/g, ' ').trim(), 300) : undefined;
    throw new ToolFailure(`Calendarific refused the request (code ${meta['code']})${detail ? `: ${detail}` : '.'}`, { status: meta['code'] });
  }
  const response = (data as Item | null)?.['response'];
  return typeof response === 'object' && response !== null && !Array.isArray(response) ? response : {};
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

/** "All", or the regions a holiday applies to as ISO 3166-2 codes (names where a code is missing). */
function regions(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return text(value, 300);
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((state: Item) => text(state?.['iso'], 20) ?? text(state?.['name'], 80))
    .filter((item): item is string => item !== undefined);
  return list.length ? (list.length > 80 ? [...list.slice(0, 80), `and ${list.length - 80} more`] : list) : undefined;
}

/** The fields an agent needs from one holiday. */
function trimHoliday(holiday: Item): Record<string, unknown> {
  const types = Array.isArray(holiday['type']) ? holiday['type'].map((type: unknown) => text(type, 60)).filter(Boolean) : [];
  return compact({
    name: text(holiday['name'], 200),
    date: text(holiday['date']?.['iso'], 40),
    description: text(holiday['description'], 400),
    types: types.length ? types : undefined,
    primaryType: text(holiday['primary_type'], 80),
    locations: text(holiday['locations'], 300),
    states: regions(holiday['states']),
    url: text(holiday['canonical_url'], 300),
    id: holiday['id'] ?? undefined,
    uuid: text(holiday['uuid'], 80),
  });
}

function holidaysOf(response: Item): Item[] {
  return Array.isArray(response['holidays']) ? response['holidays'].filter((item: unknown): item is Item => typeof item === 'object' && item !== null) : [];
}

interface Filters {
  country: string;
  location?: string;
  types?: string[];
  language?: string;
}

function filterQuery(args: Filters): Record<string, string | undefined> {
  return {
    country: args.country.toUpperCase(),
    location: args.location?.toLowerCase(),
    type: args.types?.join(','),
    language: args.language?.toLowerCase(),
  };
}

function skipOf(h: ToolHelpers, cursor: string | undefined): number {
  const state = h.cursor(cursor);
  return typeof state?.['o'] === 'number' ? state['o'] : 0;
}

const listHolidays: ToolDefinition = {
  name: 'list_holidays',
  kind: 'read',
  title: 'List the holidays of a country from Calendarific',
  description:
    'The holidays and observances of one country in a year, a month or on a day: name, date (YYYY-MM-DD, with a time for '
    + 'astronomical events), description, kinds (national, religious, observance, local), where it applies (all of the country, or '
    + 'its states as ISO 3166-2 codes) and its Calendarific page. Filter by kind, region and language. One request of the plan\'s '
    + 'monthly limit; a long list comes in parts, and nextCursor asks again (another request).',
  inputSchema: {
    type: 'object',
    properties: {
      country: COUNTRY,
      year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'The year, e.g. 2026.' },
      month: { type: 'integer', minimum: 1, maximum: 12, description: 'Only this month, 1 to 12.' },
      day: { type: 'integer', minimum: 1, maximum: 31, description: 'Only this day of the month, 1 to 31 (with month: one date).' },
      location: LOCATION,
      types: HOLIDAY_TYPES,
      language: LANGUAGE,
      cursor: CURSOR,
    },
    required: ['country', 'year'],
    additionalProperties: false,
  },
  async run(args: Filters & { year: number; month?: number; day?: number; cursor?: string }, h) {
    const skip = skipOf(h, args.cursor);
    const response = await calendarificGet(h, 'holidays', { ...filterQuery(args), year: args.year, month: args.month, day: args.day });
    const holidays = holidaysOf(response).map(trimHoliday);
    return h.page({
      key: 'holidays',
      items: holidays.slice(skip),
      extra: compact({ country: args.country.toUpperCase(), year: args.year, month: args.month, day: args.day, count: holidays.length }),
      resumeAt: (index) => h.makeCursor({ o: skip + index }),
    });
  },
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const listUpcomingHolidays: ToolDefinition = {
  name: 'list_upcoming_holidays',
  kind: 'read',
  title: 'List the coming holidays of a country from Calendarific',
  description:
    'The holidays and observances of one country in a window of days, by date: from a day (today in UTC by default) for up to 366 '
    + 'days, with the same fields and filters as list_holidays. Made for planning ahead, e.g. the next 21 days. It asks for whole '
    + 'months, or whole years when the window spans more than a month of a year: one or two requests of the plan\'s monthly limit, '
    + 'twice that when nextCursor asks again.',
  inputSchema: {
    type: 'object',
    properties: {
      country: COUNTRY,
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The first day, YYYY-MM-DD (default today, UTC).' },
      days: { type: 'integer', minimum: 1, maximum: 366, default: 30, description: 'How many days, 1 to 366 (default 30), the first day included.' },
      location: LOCATION,
      types: HOLIDAY_TYPES,
      language: LANGUAGE,
      cursor: CURSOR,
    },
    required: ['country'],
    additionalProperties: false,
  },
  async run(args: Filters & { from?: string; days: number; cursor?: string }, h) {
    const start = args.from ? Date.parse(`${args.from}T00:00:00Z`) : Math.floor(Date.now() / DAY_MS) * DAY_MS;
    if (Number.isNaN(start) || (args.from !== undefined && isoDay(start) !== args.from)) {
      throw new ToolFailure(`from must be a real date as YYYY-MM-DD, such as 2026-12-01. Nothing was sent to Calendarific.`);
    }
    const end = start + (args.days - 1) * DAY_MS;
    const [first, last] = [isoDay(start), isoDay(end)];

    // The months the window touches, by year: one request for a single month, one for the whole year otherwise.
    const months = new Map<number, Set<number>>();
    for (let day = start; day <= end; day += DAY_MS) {
      const date = new Date(day);
      const year = date.getUTCFullYear();
      months.set(year, (months.get(year) ?? new Set()).add(date.getUTCMonth() + 1));
    }
    const holidays: Item[] = [];
    for (const [year, inYear] of months) {
      const month = inYear.size === 1 ? [...inYear][0] : undefined;
      holidays.push(...holidaysOf(await calendarificGet(h, 'holidays', { ...filterQuery(args), year, month })));
    }

    const skip = skipOf(h, args.cursor);
    const inWindow = holidays
      .map(trimHoliday)
      .filter((holiday) => {
        const day = String(holiday['date'] ?? '').slice(0, 10);
        return day >= first && day <= last;
      })
      .sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
    return h.page({
      key: 'holidays',
      items: inWindow.slice(skip),
      extra: { country: args.country.toUpperCase(), from: first, to: last, count: inWindow.length },
      resumeAt: (index) => h.makeCursor({ o: skip + index }),
    });
  },
};

const listCountries: ToolDefinition = {
  name: 'list_countries',
  kind: 'read',
  title: 'List the countries Calendarific covers',
  description:
    'Every country Calendarific has holidays for, with its ISO 3166-1 alpha-2 code (the country of the holiday tools), name, number of '
    + 'holidays and number of supported languages. One request of the plan\'s monthly limit.',
  inputSchema: { type: 'object', properties: { cursor: CURSOR }, additionalProperties: false },
  async run(args: { cursor?: string }, h) {
    const skip = skipOf(h, args.cursor);
    const response = await calendarificGet(h, 'countries', {});
    const countries = (Array.isArray(response['countries']) ? response['countries'] : [])
      .filter((item: unknown): item is Item => typeof item === 'object' && item !== null)
      .map((country: Item) => compact({
        code: text(country['iso-3166'] ?? country['iso_3166'] ?? country['code'], 10),
        name: text(country['country_name'] ?? country['name'], 120),
        holidays: typeof country['total_holidays'] === 'number' ? country['total_holidays'] : undefined,
        languages: typeof country['supported_languages'] === 'number' ? country['supported_languages'] : undefined,
      }));
    return h.page({
      key: 'countries',
      items: countries.slice(skip),
      extra: { count: countries.length },
      resumeAt: (index) => h.makeCursor({ o: skip + index }),
    });
  },
};

const listLanguages: ToolDefinition = {
  name: 'list_languages',
  kind: 'read',
  title: 'List the languages Calendarific translates holidays into',
  description:
    'The languages the language option of the holiday tools takes: ISO 639-1 code, English name and native name. Translations need a '
    + 'paid plan. One request of the plan\'s monthly limit.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args: Record<string, never>, h) {
    const response = await calendarificGet(h, 'languages', {});
    const languages = (Array.isArray(response['languages']) ? response['languages'] : [])
      .filter((item: unknown): item is Item => typeof item === 'object' && item !== null)
      .map((language: Item) => compact({
        code: text(language['code'] ?? language['iso-639'] ?? language['iso_639'], 10),
        name: text(language['name'], 80),
        nativeName: text(language['nativeName'] ?? language['native_name'], 80),
      }));
    return { count: languages.length, languages };
  },
};

const connector = defineConnector({
  vendor: 'calendarific',
  label: 'Calendarific',
  origins: [ORIGIN],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'Calendarific API key' },
  tools: [listHolidays, listUpcomingHolidays, listCountries, listLanguages],
});

export = connector;
