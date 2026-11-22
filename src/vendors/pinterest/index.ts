// Pinterest, through the Pinterest API v5 (https://developers.pinterest.com/docs/api/v5/):
// organic Pins and boards only, never ads, catalogs or billing.
//
// Credential: `access_token`, the current OAuth access token of the user's own
// Pinterest app (scopes boards:read, boards:write, pins:read, pins:write and
// user_accounts:read). The host refreshes it; the module never does. An app
// with Trial access reads the account but cannot create Pins or boards on it;
// that needs Standard access.

import {
  apiTools,
  defineConnector,
  formatNumber,
  ToolFailure,
  truncate,
  type ApiRequest,
  type ApiResponse,
  type ApiToolRequest,
  type ToolHelpers,
} from '../../core/index.js';
import { multipart, pause, sniffVideo } from './media.js';

const API = 'https://api.pinterest.com';
/** Where Pinterest's media registration sends video files (its upload_url). */
const UPLOAD = 'https://pinterest-media-upload.s3-accelerate.amazonaws.com';
const DAY = 86_400_000;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/** How long create_video_pin waits for Pinterest to process an upload before it hands back the media id. */
const VIDEO_WAIT_MS = 120_000;
const ID = { type: 'string' as const, pattern: '^\\d{1,30}$' };
const PIN_METRICS = ['IMPRESSION', 'OUTBOUND_CLICK', 'PIN_CLICK', 'SAVE', 'SAVE_RATE', 'TOTAL_COMMENTS', 'TOTAL_REACTIONS', 'USER_FOLLOW', 'PROFILE_VISIT',
  'VIDEO_MRC_VIEW', 'VIDEO_10S_VIEW', 'QUARTILE_95_PERCENT_VIEW', 'VIDEO_V50_WATCH_TIME', 'VIDEO_START', 'VIDEO_AVG_WATCH_TIME'] as const;
const ACCOUNT_METRICS = ['ENGAGEMENT', 'ENGAGEMENT_RATE', 'IMPRESSION', 'OUTBOUND_CLICK', 'OUTBOUND_CLICK_RATE', 'PIN_CLICK', 'PIN_CLICK_RATE', 'SAVE', 'SAVE_RATE'] as const;
const DEFAULT_PIN_METRICS = ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK', 'SAVE_RATE'];
const DEFAULT_ACCOUNT_METRICS = ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK', 'ENGAGEMENT'];
const AI_DISCLOSURES = ['AI_MODIFIED', 'SYNTHETIC_PERFORMER'] as const;
const MISSING_NOTE = 'A metric left out has no data yet: it is not zero. The newest days can still change. Dates are UTC.';

const PIN_FIELDS = {
  board_id: { ...ID, description: 'The board, from list_boards.' },
  board_section_id: { ...ID, description: 'A section of that board, from list_board_sections.' },
  title: { type: 'string' as const, maxLength: 100, description: 'Up to 100 characters; the first 40 or so show in feeds.' },
  description: { type: 'string' as const, maxLength: 800, description: 'Up to 800 characters: the plain words people search for.' },
  link: { type: 'string' as const, format: 'uri' as const, pattern: '^https?://', maxLength: 2048, description: 'The full address the Pin opens, up to 2,048 characters.' },
  alt_text: { type: 'string' as const, maxLength: 500, description: 'What the Pin shows, for people who cannot see it, up to 500 characters.' },
  ai_disclosures: {
    type: 'array' as const,
    items: { type: 'string' as const, enum: [...AI_DISCLOSURES] },
    uniqueItems: true,
    maxItems: 2,
    description: 'Pinterest\'s AI disclosure: AI_MODIFIED for media made or changed with AI, SYNTHETIC_PERFORMER for an AI-made person.',
  },
};

interface PinArgs {
  board_id: string;
  board_section_id?: string;
  title?: string;
  description?: string;
  link?: string;
  alt_text?: string;
  ai_disclosures?: string[];
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/** Pinterest's own words, plus what to do about the refusals people meet most. */
function explain(error: unknown): unknown {
  if (!(error instanceof ToolFailure) || error.details.status !== 403) return error;
  if (/trial access/i.test(error.message)) {
    return new ToolFailure(
      `${error.message} The Pinterest app has Trial access, which reads the account but cannot create Pins or boards on it: upgrade the app `
        + 'to Standard access (developers.pinterest.com, My apps, Upgrade on the app card) and try again.',
      error.details,
    );
  }
  if (/PINNER_DATA_ACCESS_DENIED|business account/i.test(error.message)) {
    return new ToolFailure(
      `${error.message} Pinterest lets newer apps read the boards and Pins of business accounts only: convert the Pinterest account to a `
        + 'free business account in its settings and connect again.',
      error.details,
    );
  }
  return error;
}

async function api(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await h.api(request);
  } catch (error) {
    throw explain(error);
  }
}

function pinUrl(id: unknown): string | undefined {
  return typeof id === 'string' && /^\d+$/.test(id) ? `https://www.pinterest.com/pin/${id}/` : undefined;
}

function pinImage(media: any): string | undefined {
  const images = media?.images ?? media?.items?.[0]?.images;
  if (images && typeof images === 'object') {
    for (const size of ['600x', '400x300', '1200x', '150x150']) {
      const url = images[size]?.url;
      if (typeof url === 'string') return url;
    }
  }
  return typeof media?.cover_image_url === 'string' ? media.cover_image_url : undefined;
}

function trimPin(pin: any): Record<string, unknown> {
  return compact({
    id: pin?.id,
    url: pinUrl(pin?.id),
    created_at: pin?.created_at,
    title: typeof pin?.title === 'string' && pin.title ? truncate(pin.title, 100) : undefined,
    description: typeof pin?.description === 'string' && pin.description ? truncate(pin.description, 300) : undefined,
    link: pin?.link || undefined,
    alt_text: typeof pin?.alt_text === 'string' && pin.alt_text ? truncate(pin.alt_text, 200) : undefined,
    board_id: pin?.board_id,
    board_section_id: pin?.board_section_id || undefined,
    media_type: pin?.media?.media_type,
    image: pinImage(pin?.media),
    is_owner: pin?.is_owner,
    metrics: pin?.pin_metrics && typeof pin.pin_metrics === 'object' ? pin.pin_metrics : undefined,
  });
}

function trimBoard(board: any): Record<string, unknown> {
  return compact({
    id: board?.id,
    name: board?.name,
    description: typeof board?.description === 'string' && board.description ? truncate(board.description, 300) : undefined,
    privacy: board?.privacy,
    pin_count: board?.pin_count,
    follower_count: board?.follower_count,
    created_at: board?.created_at,
    owner: board?.owner?.username,
  });
}

/** What a list cursor holds: Pinterest's bookmark, the place in its page, the page size, and the listing it pages. */
interface PageState {
  b?: string;
  o: number;
  n: number;
  /** The listing's own arguments (a board, a section, metrics), so a cursor passed back alone pages the same list. */
  keep: Record<string, string | number>;
}

/** One page of a Pinterest list, cut to 32 KB, with Pinterest's bookmark for the next page. */
function bookmarkPage(h: ToolHelpers, key: string, items: unknown[], data: any, state: PageState, extra?: Record<string, unknown>) {
  return h.page({
    key,
    items: items.slice(state.o),
    ...(extra ? { extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...state.keep, ...(state.b ? { b: state.b } : {}), o: state.o + index, n: state.n }),
    ...(typeof data?.bookmark === 'string' && data.bookmark ? { nextPage: h.makeCursor({ ...state.keep, b: data.bookmark, o: 0, n: state.n }) } : {}),
  });
}

/**
 * The paging state of a list call: from its cursor, or a first page. `listing`
 * names the arguments that pick the list; a cursor keeps them, and refuses a
 * call that gives other ones.
 */
function pageState(h: ToolHelpers, cursor: string | undefined, pageSize: number, listing: Record<string, string | number | undefined> = {}): PageState {
  const state = h.cursor(cursor);
  const keep: Record<string, string | number> = {};
  for (const [name, given] of Object.entries(listing)) {
    const carried = state ? state[`k_${name}`] : undefined;
    if (state && given !== undefined && carried !== given) {
      throw new ToolFailure(`The cursor belongs to another list (another ${name}). Pass the same arguments as in the previous call, or leave cursor out.`);
    }
    const value = state ? carried : given;
    if (typeof value === 'string' || typeof value === 'number') keep[`k_${name}`] = value;
  }
  return {
    ...(typeof state?.['b'] === 'string' ? { b: state['b'] } : {}),
    o: typeof state?.['o'] === 'number' ? state['o'] : 0,
    n: typeof state?.['n'] === 'number' ? state['n'] : pageSize,
    keep,
  };
}

/** A listing argument the cursor carried, or undefined. */
function kept(state: PageState, name: string): string | number | undefined {
  return state.keep[`k_${name}`];
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The analytics range: the given days, or the last 30 days ending yesterday (UTC), within Pinterest's 90 days. */
function analyticsRange(start?: string, end?: string): { start_date: string; end_date: string } {
  const today = Date.parse(`${day(Date.now())}T00:00:00Z`);
  const endDate = end ?? day(today - DAY);
  const startDate = start ?? day(Date.parse(`${endDate}T00:00:00Z`) - 29 * DAY);
  const startTime = Date.parse(`${startDate}T00:00:00Z`);
  const endTime = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) throw new ToolFailure('start_date and end_date are days written YYYY-MM-DD.');
  if (endTime < startTime) throw new ToolFailure('end_date is before start_date.');
  if (endTime > today) throw new ToolFailure('end_date is in the future.');
  if (startTime < today - 90 * DAY) throw new ToolFailure('Pinterest keeps analytics for 90 days: start_date can be at most 90 days back.');
  if (endTime - startTime > 90 * DAY) throw new ToolFailure('Pinterest takes a range of at most 90 days.');
  return { start_date: startDate, end_date: endDate };
}

function rounded(metrics: unknown): Record<string, number> | undefined {
  if (!metrics || typeof metrics !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  }
  return Object.keys(out).length ? out : undefined;
}

interface AnalyticsArgs {
  start_date?: string;
  end_date?: string;
  metric_types?: string[];
  include_daily: boolean;
  cursor?: string;
}

/** Totals, lifetime totals and how many days are final, for each group of an analytics answer ("all" without a split). */
function analyticsResult(h: ToolHelpers, data: any, base: Record<string, unknown>, args: AnalyticsArgs, state: Record<string, string | number>, skip: number) {
  const groups = data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data) : [];
  const summary: Record<string, unknown> = {};
  const daily: Array<Record<string, unknown>> = [];
  for (const [group, value] of groups as Array<[string, any]>) {
    const days: any[] = Array.isArray(value?.daily_metrics) ? value.daily_metrics : [];
    const statusOf = (entry: any): string => (typeof entry?.data_status === 'string' ? entry.data_status : '');
    summary[group] = compact({
      totals: rounded(value?.summary_metrics) ?? 'no data yet',
      lifetime: rounded(value?.lifetime_metrics),
      days: {
        final: days.filter((entry) => statusOf(entry) === 'READY').length,
        processing: days.filter((entry) => ['PROCESSING', 'ESTIMATE'].includes(statusOf(entry))).length,
        without_data: days.filter((entry) => !['READY', 'PROCESSING', 'ESTIMATE'].includes(statusOf(entry))).length,
      },
    });
    if (args.include_daily) {
      for (const entry of days) daily.push(compact({ group: groups.length > 1 ? group : undefined, date: entry?.date, status: statusOf(entry) || undefined, metrics: rounded(entry?.metrics) }));
    }
  }
  const extra = { ...base, ...(groups.length === 1 && groups[0]?.[0] === 'all' ? (summary['all'] as Record<string, unknown>) : { groups: summary }), note: MISSING_NOTE };
  if (!groups.length) return { ...base, totals: 'no data yet', note: MISSING_NOTE };
  if (!args.include_daily) return extra;
  return h.page({
    key: 'daily',
    items: daily.slice(skip),
    extra,
    resumeAt: (index) => h.makeCursor({ ...state, o: skip + index }),
  });
}

function analyticsState(h: ToolHelpers, args: AnalyticsArgs, defaults: string[]) {
  const state = h.cursor(args.cursor);
  if (state) {
    return {
      range: { start_date: String(state['s']), end_date: String(state['e']) },
      metrics: String(state['m']).split(','),
      skip: typeof state['o'] === 'number' ? state['o'] : 0,
      include_daily: true,
    };
  }
  return { range: analyticsRange(args.start_date, args.end_date), metrics: args.metric_types?.length ? args.metric_types : defaults, skip: 0, include_daily: args.include_daily };
}

const ANALYTICS_RANGE = {
  start_date: { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The first day (UTC), YYYY-MM-DD, at most 90 days back. Default: 30 days before end_date.' },
  end_date: { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The last day (UTC), YYYY-MM-DD. Default: yesterday.' },
  include_daily: { type: 'boolean' as const, default: false, description: 'Also list each day\'s numbers (default false).' },
  cursor: { type: 'string' as const, description: 'nextCursor from the previous result, for more days.' },
};

/** Registers a video upload with Pinterest, sends the file to its upload storage, and returns the media id. */
async function uploadVideo(h: ToolHelpers, videoUrl: string): Promise<string> {
  const { bytes } = await h.media(videoUrl, { what: 'video', maxBytes: MAX_VIDEO_BYTES, accept: 'video/mp4,video/quicktime' });
  const video = sniffVideo(bytes);
  if (!video) throw new ToolFailure('The video URL did not return an MP4 or MOV video, the formats Pinterest takes. Nothing was changed.');
  const { data } = await api(h, { method: 'POST', path: '/v5/media', json: { media_type: 'video' } });
  const mediaId = typeof data?.media_id === 'string' && /^\d+$/.test(data.media_id) ? data.media_id : undefined;
  if (!mediaId) throw new ToolFailure('Pinterest registered no media upload. Nothing was changed.');
  let target: URL | undefined;
  try {
    target = new URL(String(data?.upload_url));
  } catch {
    // reported below
  }
  if (!target || target.origin !== UPLOAD) throw new ToolFailure('Pinterest named an upload address this connector does not send files to. Nothing was changed.');
  const parameters = data?.upload_parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new ToolFailure('Pinterest sent no upload parameters. Nothing was changed.');
  const fields = Object.entries(parameters as Record<string, unknown>)
    .filter(([name, value]) => typeof value === 'string' && name.toLowerCase() !== 'file')
    .map(([name, value]) => ({ name, value: value as string }));
  const form = multipart([...fields, { name: 'file', filename: `video.${video.extension}`, contentType: video.type, bytes }]);
  await h.api({
    method: 'POST',
    origin: UPLOAD,
    path: target.pathname || '/',
    body: form.body,
    contentType: form.contentType,
    auth: false,
    errors: { 400: 'Pinterest\'s upload storage refused the video', 403: 'Pinterest\'s upload storage refused the video (the upload may have expired)' },
  });
  return mediaId;
}

/** Waits until Pinterest has processed an upload: "succeeded", or "processing" when the wait ran out. */
async function waitForVideo(h: ToolHelpers, mediaId: string): Promise<'succeeded' | 'processing'> {
  const deadline = Date.now() + VIDEO_WAIT_MS;
  const cancelled = `The call was cancelled while Pinterest was processing the video (media_id ${mediaId}). No Pin was created.`;
  for (let attempt = 0; ; attempt++) {
    const { data } = await api(h, { path: `/v5/media/${mediaId}`, errors: { 404: `Pinterest found no upload ${mediaId}` } });
    if (data?.status === 'succeeded') return 'succeeded';
    if (data?.status === 'failed') throw new ToolFailure(`Pinterest could not process the video (media_id ${mediaId}). No Pin was created: check the video's format and length.`);
    if (Date.now() >= deadline) return 'processing';
    await pause(Math.min(1000 * 2 ** attempt, 10_000), h.ctx.signal, cancelled);
  }
}

async function createPin(h: ToolHelpers, args: PinArgs, mediaSource: Record<string, unknown>) {
  if (args.board_section_id && !args.board_id) throw new ToolFailure('board_section_id needs its board_id. Nothing was changed.');
  const body = compact({
    board_id: args.board_id,
    board_section_id: args.board_section_id,
    title: args.title,
    description: args.description,
    link: args.link,
    alt_text: args.alt_text,
    ai_disclosures: args.ai_disclosures?.length ? { values: args.ai_disclosures } : undefined,
    media_source: mediaSource,
  });
  const { data } = await api(h, {
    method: 'POST',
    path: '/v5/pins',
    json: body,
    write: true,
    errors: { 400: 'Pinterest did not accept the Pin (check that the media URL is public and the board and section exist)' },
  });
  return compact({ ...trimPin(data), board_id: data?.board_id ?? args.board_id });
}

/** The generic tools stay with organic content: no ads, catalogs or OAuth endpoints. */
function organicGuard(request: ApiToolRequest): void {
  const area = request.segments[1] ?? '';
  if (['ad_accounts', 'catalogs', 'oauth'].includes(area)) {
    throw new ToolFailure('This Pinterest connection works with organic Pins and boards only: ad accounts, catalogs and OAuth endpoints are not available here. Nothing was sent.');
  }
}

const connector = defineConnector({
  vendor: 'pinterest',
  label: 'Pinterest',
  origins: [API, UPLOAD],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Pinterest access token' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get the connected Pinterest account',
      description:
        'Returns the connected Pinterest account: username, account type (BUSINESS or PINNER, a personal account), business name, '
        + 'board and Pin counts, followers, following and monthly views.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await api(h, { path: '/v5/user_account' });
        return compact({
          id: data?.id,
          username: data?.username,
          profile_url: typeof data?.username === 'string' ? `https://www.pinterest.com/${encodeURIComponent(data.username)}/` : undefined,
          account_type: data?.account_type,
          business_name: data?.business_name || undefined,
          board_count: data?.board_count,
          pin_count: data?.pin_count,
          follower_count: data?.follower_count,
          following_count: data?.following_count,
          monthly_views: data?.monthly_views,
          website_url: data?.website_url || undefined,
        });
      },
    },
    {
      name: 'list_boards',
      kind: 'read',
      title: 'List Pinterest boards',
      description:
        "Lists the account's boards in Pinterest's order: id, name, description, privacy, Pin and follower counts. Pins go on a board "
        + 'by its id. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 250, default: 100, description: 'Boards per page, 1 to 250 (default 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { page_size: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.page_size);
        const { data } = await api(h, { path: '/v5/boards', query: { page_size: state.n, bookmark: state.b } });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        return bookmarkPage(h, 'boards', items.map(trimBoard), data, state);
      },
    },
    {
      name: 'list_board_sections',
      kind: 'read',
      title: 'List the sections of a Pinterest board',
      description: 'Lists the sections of one board: id and name. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          board_id: { ...ID, description: 'The board, from list_boards.' },
          page_size: { type: 'integer', minimum: 1, maximum: 250, default: 100, description: 'Sections per page, 1 to 250 (default 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['board_id'],
        additionalProperties: false,
      },
      async run(args: { board_id: string; page_size: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.page_size, { board_id: args.board_id });
        const { data } = await api(h, { path: `/v5/boards/${args.board_id}/sections`, query: { page_size: state.n, bookmark: state.b }, errors: { 404: 'Pinterest found no board with that id' } });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        return bookmarkPage(h, 'sections', items.map((section) => compact({ id: section?.id, name: section?.name })), data, state, { board_id: args.board_id });
      },
    },
    {
      name: 'list_pins',
      kind: 'read',
      title: 'List Pinterest Pins',
      description:
        "Lists Pins, newest first: on one board, in one board section, or all of the account's Pins. Each has its id, link to the Pin, "
        + 'created time, title, description, destination link and image; with include_metrics, its 90-day and lifetime numbers '
        + '(not for a section). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          board_id: { ...ID, description: 'Only this board\'s Pins.' },
          board_section_id: { ...ID, description: 'Only this section\'s Pins (with its board_id).' },
          page_size: { type: 'integer', minimum: 1, maximum: 250, default: 25, description: 'Pins per page, 1 to 250 (default 25).' },
          include_metrics: { type: 'boolean', default: false, description: 'Add each Pin\'s 90-day and lifetime numbers (default false).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { board_id?: string; board_section_id?: string; page_size: number; include_metrics: boolean; cursor?: string }, h) {
        if (args.board_section_id && !args.board_id) throw new ToolFailure('board_section_id needs its board_id.');
        // A cursor pages the list it came from: its board, section and metrics come with it.
        const state = pageState(h, args.cursor, args.page_size, {
          board_id: args.board_id,
          board_section_id: args.board_section_id,
          include_metrics: args.include_metrics ? 1 : undefined,
        });
        const boardId = kept(state, 'board_id') as string | undefined;
        const sectionId = kept(state, 'board_section_id') as string | undefined;
        let path = '/v5/pins';
        if (boardId) path = `/v5/boards/${boardId}/pins`;
        if (boardId && sectionId) path = `/v5/boards/${boardId}/sections/${sectionId}/pins`;
        const metrics = kept(state, 'include_metrics') === 1 && !sectionId ? true : undefined;
        const { data } = await api(h, { path, query: { page_size: state.n, bookmark: state.b, pin_metrics: metrics }, errors: { 404: 'Pinterest found no such board or section' } });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        return bookmarkPage(h, 'pins', items.map(trimPin), data, state, compact({ board_id: boardId, board_section_id: sectionId }));
      },
    },
    {
      name: 'get_pin',
      kind: 'read',
      title: 'Get a Pinterest Pin',
      description: 'Returns one Pin: its link, title, description, destination link, alt text, board and image, and with include_metrics its 90-day and lifetime numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pin_id: { ...ID, description: 'The Pin id, the digits in https://www.pinterest.com/pin/<id>/.' },
          include_metrics: { type: 'boolean', default: false, description: 'Add the Pin\'s 90-day and lifetime numbers (default false).' },
        },
        required: ['pin_id'],
        additionalProperties: false,
      },
      async run(args: { pin_id: string; include_metrics: boolean }, h) {
        const { data } = await api(h, { path: `/v5/pins/${args.pin_id}`, query: { pin_metrics: args.include_metrics ? true : undefined }, errors: { 404: 'Pinterest found no Pin with that id' } });
        return trimPin(data);
      },
    },
    {
      name: 'create_pin',
      kind: 'create',
      check: 'list_pins',
      title: 'Create a Pinterest image Pin',
      description:
        'Creates an image Pin on a board (or a board section) right away, from a public https URL of a PNG or JPEG (up to 20 MB; 2:3, '
        + 'such as 1000 x 1500, shows best), with title, description, destination link and alt text. Pinterest has no scheduling, and '
        + 'a Pin on a public board is public. Returns the Pin and its link. Needs an app with Standard access.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PIN_FIELDS,
          image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, description: 'A public https URL of the PNG or JPEG image; Pinterest fetches it.' },
        },
        required: ['board_id', 'image_url'],
        additionalProperties: false,
      },
      async run(args: PinArgs & { image_url: string }, h) {
        return createPin(h, args, { source_type: 'image_url', url: args.image_url });
      },
    },
    {
      name: 'create_video_pin',
      kind: 'create',
      check: 'list_pins',
      title: 'Create a Pinterest video Pin',
      description:
        'Creates a video Pin on a board: downloads the MP4 or MOV video from a public https URL, uploads it to Pinterest, waits while '
        + 'Pinterest processes it, then creates the Pin with a cover (an image URL, or a moment of the video in seconds). When '
        + 'processing takes longer, it answers with the media_id: call again with media_id instead of video_url. Needs an app with '
        + `Standard access. Videos up to ${formatNumber(MAX_VIDEO_BYTES)} bytes as Pinterest allows, less where the host caps downloads.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...PIN_FIELDS,
          video_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, description: 'A public https URL of the MP4 or MOV video.' },
          media_id: { ...ID, description: 'A video already uploaded by an earlier call that was still processing, instead of video_url.' },
          cover_image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, description: 'A public https URL of the cover image.' },
          cover_image_key_frame_time: { type: 'integer', minimum: 0, description: 'Instead of cover_image_url: the second of the video to use as the cover.' },
        },
        required: ['board_id'],
        additionalProperties: false,
      },
      async run(args: PinArgs & { video_url?: string; media_id?: string; cover_image_url?: string; cover_image_key_frame_time?: number }, h) {
        if (!args.video_url === !args.media_id) throw new ToolFailure('Give video_url for a new video, or media_id for one uploaded before, not both. Nothing was changed.');
        if ((args.cover_image_url === undefined) === (args.cover_image_key_frame_time === undefined)) {
          throw new ToolFailure('A video Pin needs a cover: give cover_image_url or cover_image_key_frame_time (one of them). Nothing was changed.');
        }
        const mediaId = args.media_id ?? await uploadVideo(h, args.video_url as string);
        if (await waitForVideo(h, mediaId) === 'processing') {
          throw new ToolFailure(
            `Pinterest is still processing the video (media_id ${mediaId}). No Pin was created yet: call create_video_pin again in a minute `
              + `or two with media_id "${mediaId}" and the same Pin fields, instead of video_url.`,
          );
        }
        const pin = await createPin(h, args, compact({
          source_type: 'video_id',
          media_id: mediaId,
          cover_image_url: args.cover_image_url,
          cover_image_key_frame_time: args.cover_image_key_frame_time,
        }));
        return { ...pin, media_id: mediaId };
      },
    },
    {
      name: 'create_board',
      kind: 'create',
      check: 'list_boards',
      title: 'Create a Pinterest board',
      description: 'Creates a public board on the account (it shows on the profile right away). Returns its id. Needs an app with Standard access.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 180, description: 'The board name.' },
          description: { type: 'string', maxLength: 500, description: 'One sentence about the board.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string; description?: string }, h) {
        const { data } = await api(h, { method: 'POST', path: '/v5/boards', json: compact({ name: args.name, description: args.description, privacy: 'PUBLIC' }), write: true });
        return trimBoard(data);
      },
    },
    {
      name: 'create_board_section',
      kind: 'create',
      check: 'list_board_sections',
      title: 'Create a Pinterest board section',
      description: 'Adds a section to one of the account\'s boards. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          board_id: { ...ID, description: 'The board, from list_boards.' },
          name: { type: 'string', minLength: 1, maxLength: 180, description: 'The section name, 1 to 180 characters.' },
        },
        required: ['board_id', 'name'],
        additionalProperties: false,
      },
      async run(args: { board_id: string; name: string }, h) {
        const { data } = await api(h, { method: 'POST', path: `/v5/boards/${args.board_id}/sections`, json: { name: args.name }, write: true, errors: { 404: 'Pinterest found no board with that id' } });
        return compact({ id: data?.id, name: data?.name, board_id: args.board_id });
      },
    },
    {
      name: 'delete_pin',
      kind: 'delete',
      check: 'get_pin',
      title: 'Delete a Pinterest Pin',
      description: "Deletes one of the account's Pins. It cannot be undone.",
      inputSchema: {
        type: 'object',
        properties: {
          pin_id: { ...ID, description: 'The Pin id.' },
        },
        required: ['pin_id'],
        additionalProperties: false,
      },
      async run(args: { pin_id: string }, h) {
        await api(h, { method: 'DELETE', path: `/v5/pins/${args.pin_id}`, write: true, errors: { 404: 'Pinterest found no Pin with that id that this account owns' } });
        return { deleted: true, pin_id: args.pin_id };
      },
    },
    {
      name: 'get_pin_analytics',
      kind: 'read',
      title: 'Get a Pinterest Pin\'s analytics',
      description:
        'A Pin\'s numbers over a date range (UTC, within the last 90 days; default the last 30 days ending yesterday): impressions, saves, '
        + 'Pin clicks, outbound clicks and save rate by default, video metrics for a video Pin, plus lifetime comments and reactions when '
        + 'asked. A metric left out has no data yet, which is not zero.',
      inputSchema: {
        type: 'object',
        properties: {
          pin_id: { ...ID, description: 'The Pin id.' },
          ...ANALYTICS_RANGE,
          metric_types: {
            type: 'array',
            items: { type: 'string', enum: [...PIN_METRICS] },
            minItems: 1,
            uniqueItems: true,
            description: 'The metrics. Default: IMPRESSION, SAVE, PIN_CLICK, OUTBOUND_CLICK, SAVE_RATE. Video Pins add VIDEO_START, VIDEO_MRC_VIEW, VIDEO_AVG_WATCH_TIME and more.',
          },
        },
        required: ['pin_id'],
        additionalProperties: false,
      },
      async run(args: AnalyticsArgs & { pin_id: string }, h) {
        const { range, metrics, skip, include_daily: includeDaily } = analyticsState(h, args, DEFAULT_PIN_METRICS);
        const { data } = await api(h, {
          path: `/v5/pins/${args.pin_id}/analytics`,
          query: { ...range, metric_types: metrics.join(',') },
          errors: { 404: 'Pinterest found no Pin with that id that this account owns' },
        });
        return analyticsResult(h, data, { pin_id: args.pin_id, range, metric_types: metrics }, { ...args, include_daily: includeDaily }, { s: range.start_date, e: range.end_date, m: metrics.join(',') }, skip);
      },
    },
    {
      name: 'get_account_analytics',
      kind: 'read',
      title: 'Get Pinterest account analytics',
      description:
        "The whole account's numbers over a date range (UTC, within the last 90 days; default the last 30 days ending yesterday): "
        + 'impressions, saves, Pin clicks, outbound clicks and engagement by default, and their rates when asked. A metric left out has '
        + 'no data yet, which is not zero.',
      inputSchema: {
        type: 'object',
        properties: {
          ...ANALYTICS_RANGE,
          metric_types: {
            type: 'array',
            items: { type: 'string', enum: [...ACCOUNT_METRICS] },
            minItems: 1,
            uniqueItems: true,
            description: 'The metrics. Default: IMPRESSION, SAVE, PIN_CLICK, OUTBOUND_CLICK, ENGAGEMENT.',
          },
        },
        additionalProperties: false,
      },
      async run(args: AnalyticsArgs, h) {
        const { range, metrics, skip, include_daily: includeDaily } = analyticsState(h, args, DEFAULT_ACCOUNT_METRICS);
        const { data } = await api(h, { path: '/v5/user_account/analytics', query: { ...range, metric_types: metrics.join(',') } });
        return analyticsResult(h, data, { range, metric_types: metrics }, { ...args, include_daily: includeDaily }, { s: range.start_date, e: range.end_date, m: metrics.join(',') }, skip);
      },
    },
    // The rest of the Pinterest API v5 for organic content.
    ...apiTools({
      label: 'Pinterest',
      description:
        'The Pinterest API v5 at https://api.pinterest.com/v5, with the connected account\'s token: paths start with /v5/, such as '
        + '/v5/pins/<id> (PATCH changes a Pin\'s title, description, link or board), /v5/boards/<id> or /v5/user_account/analytics/top_pins; '
        + 'ad accounts, catalogs and OAuth endpoints are left out. Reference: https://developers.pinterest.com/docs/api/v5/.',
      basePath: '/v5/',
      methods: ['POST', 'PATCH', 'DELETE'],
      guard: organicGuard,
    }),
  ],
});

export = connector;
