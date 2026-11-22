// Google Business Profile, through the Business Profile APIs: reviews and
// replies on the My Business API v4, accounts on the Account Management API,
// locations on the Business Information API, and metrics on the Performance
// API (https://developers.google.com/my-business/reference/rest).
//
// Credential: `access_token`, an OAuth 2.0 access token of a Google account
// that owns or manages the business, with the scope
// https://www.googleapis.com/auth/business.manage. Google answers only for a
// Cloud project it has approved for these APIs. The host refreshes the token.
//
// Account pickers: `accounts` (list_accounts) and `locations`
// (list_locations). Review tools work on a chosen location of a chosen
// account; the generic tools only reach paths that name them.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  requireAccounts,
  ToolFailure,
  truncate,
  utf8Length,
  type ApiRequest,
  type ApiResponse,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { compact, googleApi } from './google.js';
import { trimReply, trimReview } from './reviews.js';

type Schema = ToolDefinition['inputSchema'];

const REVIEWS = 'https://mybusiness.googleapis.com';
const ACCOUNTS = 'https://mybusinessaccountmanagement.googleapis.com';
const INFO = 'https://mybusinessbusinessinformation.googleapis.com';
const PERFORMANCE = 'https://businessprofileperformance.googleapis.com';
const MAX_REPLY_BYTES = 4096;
/** Location pages one list_locations call may read while skipping accounts without locations. */
const MAX_LOCATION_READS = 10;
const LOCATION_FIELDS = 'name,title,storeCode,storefrontAddress,phoneNumbers,websiteUri,categories,openInfo,metadata';
const NOT_APPROVED =
  'If every call gets this, Google has not yet approved the Business Profile APIs for the Google Cloud project behind this '
  + 'connection (its quota is 0 requests per minute): apply through Google\'s Business Profile API contact form, then wait for the approval.';

const DIGITS = '^[0-9]{1,30}$';
const ACCOUNT_ID: Schema = {
  type: 'string',
  pattern: DIGITS,
  description: "The location's account id (list_locations gives it). Leave out when one account is chosen for this connection.",
};
const LOCATION_ID: Schema = { type: 'string', pattern: DIGITS, description: 'The location id, from list_locations.' };
const REVIEW_ID: Schema = { type: 'string', pattern: '^[A-Za-z0-9_\\-+=.]{1,512}$', description: 'The review id, from list_reviews.' };

interface LocationArgs {
  location_id: string;
  account_id?: string;
}

function digits(name: unknown): string | undefined {
  const last = typeof name === 'string' ? name.split('/').pop() : undefined;
  return last && /^[0-9]+$/.test(last) ? last : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

/** One request, with a hint on the HTTP 429 a project Google has not approved gets on every call. */
async function gbp(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await googleApi(h, request);
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 429) throw new ToolFailure(`${error.message} ${NOT_APPROVED}`, error.details);
    throw error;
  }
}

/** The account and location a review tool works on, after the account lock allowed both. */
function resolveLocation(h: ToolHelpers, args: LocationArgs): { accountId: string; locationId: string; path: string } {
  requireAccounts(h.ctx.accounts, 'locations', args.location_id, 'location');
  let accountId = args.account_id;
  if (accountId) {
    requireAccounts(h.ctx.accounts, 'accounts', accountId, 'account');
  } else {
    const allowed = allowedAccounts(h.ctx.accounts, 'accounts');
    if (allowed?.length === 1) accountId = allowed[0] as string;
    else if (allowed !== null && !allowed.length) throw new ToolFailure('No Business Profile account is chosen for this connection yet. Nothing was sent.');
    else throw new ToolFailure("Give account_id: the location's account id from list_locations. Nothing was sent.");
  }
  return {
    accountId,
    locationId: args.location_id,
    path: `/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(args.location_id)}`,
  };
}

function trimAccount(account: any): Record<string, unknown> {
  return compact({
    id: digits(account?.name),
    name: text(account?.accountName, 300),
    type: typeof account?.type === 'string' ? account.type.toLowerCase() : undefined,
    role: typeof account?.role === 'string' ? account.role.toLowerCase() : undefined,
    verification_state: typeof account?.verificationState === 'string' ? account.verificationState.toLowerCase() : undefined,
    vetted_state: typeof account?.vettedState === 'string' ? account.vettedState.toLowerCase() : undefined,
  });
}

function oneLineAddress(address: any): string | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const lines = Array.isArray(address.addressLines) ? address.addressLines.filter((line: unknown) => typeof line === 'string' && line.trim()) : [];
  const parts = [...lines, address.locality, address.administrativeArea, address.postalCode, address.regionCode]
    .filter((part) => typeof part === 'string' && part.trim());
  return parts.length ? truncate(parts.join(', '), 500) : undefined;
}

function trimLocation(location: any, accountId: string): Record<string, unknown> {
  return compact({
    id: digits(location?.name),
    title: text(location?.title, 300),
    account_id: accountId,
    store_code: text(location?.storeCode, 100),
    address: oneLineAddress(location?.storefrontAddress),
    phone: text(location?.phoneNumbers?.primaryPhone, 50),
    website: text(location?.websiteUri, 500),
    category: text(location?.categories?.primaryCategory?.displayName, 200),
    status: typeof location?.openInfo?.status === 'string' ? location.openInfo.status.toLowerCase() : undefined,
    maps_url: location?.metadata?.mapsUri,
    review_url: location?.metadata?.newReviewUri,
    place_id: location?.metadata?.placeId,
  });
}

async function accountsPage(h: ToolHelpers, pageToken: string | undefined): Promise<{ ids: string[]; next?: string; accounts: any[] }> {
  const { data } = await gbp(h, { origin: ACCOUNTS, path: '/v1/accounts', query: { pageSize: 20, pageToken } });
  const accounts: any[] = Array.isArray(data?.accounts) ? data.accounts : [];
  return {
    accounts,
    ids: accounts.map((account) => digits(account?.name)).filter((id): id is string => Boolean(id)),
    ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { next: data.nextPageToken } : {}),
  };
}

/** Ids a generic request names: the path segment after "accounts" or "locations", and batchGetReviews' locationNames. */
function namedIds(request: ApiToolRequest): { accounts: string[]; locations: string[] } {
  const accounts = new Set<string>();
  const locations = new Set<string>();
  request.segments.forEach((segment, index) => {
    const next = request.segments[index + 1];
    const id = next?.split(':')[0];
    if (!id || !/^[0-9]+$/.test(id)) return;
    if (segment === 'accounts') accounts.add(id);
    if (segment === 'locations') locations.add(id);
  });
  const names = request.json?.['locationNames'];
  for (const name of Array.isArray(names) ? names : []) {
    const match = typeof name === 'string' ? /^accounts\/([0-9]+)\/locations\/([0-9]+)$/.exec(name) : null;
    if (match) {
      accounts.add(match[1] as string);
      locations.add(match[2] as string);
    } else {
      // A name the lock cannot read is refused below as naming nothing chosen.
      locations.add(String(name));
    }
  }
  return { accounts: [...accounts], locations: [...locations] };
}

/** Reference data every account shares, which a GET may read without naming an account. */
const SHARED_READS = new Set(['categories', 'categories:batchGet', 'attributes', 'chains', 'chains:search']);

function guard(request: ApiToolRequest, h: ToolHelpers): void {
  const base = request.origin === REVIEWS ? '/v4/' : '/v1/';
  if (!request.path.startsWith(base)) throw new ToolFailure(`Paths on ${request.origin} start with ${base}. Nothing was sent.`);
  if (h.ctx.accounts === null) return;
  const named = namedIds(request);
  if (!named.accounts.length && !named.locations.length) {
    if (request.method === 'GET' && request.origin === INFO && SHARED_READS.has(request.segments[1] ?? '')) return;
    throw new ToolFailure('This request names none of the accounts or locations chosen for this connection (an accounts/ID or locations/ID path). Nothing was sent.');
  }
  if (named.accounts.length) requireAccounts(h.ctx.accounts, 'accounts', named.accounts, 'account');
  if (named.locations.length) requireAccounts(h.ctx.accounts, 'locations', named.locations, 'location');
}

const connector = defineConnector({
  vendor: 'google-business',
  label: 'Google Business Profile',
  origins: [REVIEWS, ACCOUNTS, INFO, PERFORMANCE],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Google Business Profile access token' },
  accountPickers: [
    {
      key: 'accounts',
      label: 'Business Profile accounts',
      description: 'The accounts (your own, or a business group) whose locations the agent may work on.',
      multiple: true,
      tool: 'list_accounts',
      idField: 'id',
      nameField: 'name',
      legacyField: 'accountid',
    },
    {
      key: 'locations',
      label: 'Business locations',
      description: 'The locations whose reviews the agent may read and answer.',
      multiple: true,
      tool: 'list_locations',
      idField: 'id',
      nameField: 'title',
      legacyField: 'locationmappings',
    },
  ],
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'list_accounts',
      kind: 'read',
      title: 'List Business Profile accounts',
      description:
        'Lists the Business Profile accounts the connected Google account can use (its own, and business groups), with id, name, '
        + 'type and role; only the chosen ones when a choice was made. Pass nextCursor back as cursor for more. Google answers HTTP 429 '
        + 'on every call until it has approved the Cloud project for the Business Profile APIs.',
      inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: 'nextCursor from the previous result.' } }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const page = await accountsPage(h, pageToken);
        const allowed = allowedAccounts(h.ctx.accounts, 'accounts');
        const accounts = page.accounts.map(trimAccount).filter((account) => allowed === null || allowed.includes(String(account['id'])));
        return h.page({
          key: 'accounts',
          items: accounts.slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(page.next ? { nextPage: h.makeCursor({ p: page.next, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'list_locations',
      kind: 'read',
      title: 'List Business Profile locations',
      description:
        'Lists business locations with their id, name, account id, address, phone, website, main category, open status, Maps link and '
        + 'review link: of one account (account_id), else of every account, or only the chosen accounts and locations when a choice '
        + 'was made. Review tools take a location id with its account id. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string', pattern: DIGITS, description: 'Only this account\'s locations.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { account_id?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        let accountsToken = typeof state?.['ap'] === 'string' ? state['ap'] : undefined;
        let index = typeof state?.['ai'] === 'number' ? state['ai'] : 0;
        let locationsToken = typeof state?.['lp'] === 'string' ? state['lp'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;

        if (args.account_id) requireAccounts(h.ctx.accounts, 'accounts', args.account_id, 'account');
        const chosenAccounts = allowedAccounts(h.ctx.accounts, 'accounts');
        const chosenLocations = allowedAccounts(h.ctx.accounts, 'locations');
        // A fixed list (one account, or the chosen ones), or every account page by page.
        const fixed = args.account_id ? [args.account_id] : chosenAccounts;
        let page = fixed ? { ids: fixed } as { ids: string[]; next?: string } : await accountsPage(h, accountsToken);

        const cursorAt = (ap: string | undefined, ai: number, lp: string | undefined, offset: number): string => h.makeCursor({
          ...(ap ? { ap } : {}), ai, ...(lp ? { lp } : {}), o: offset,
        });
        let first = true;
        for (let reads = 0; reads < MAX_LOCATION_READS; reads++) {
          if (index >= page.ids.length) {
            if (fixed || !page.next) break;
            accountsToken = page.next;
            page = await accountsPage(h, accountsToken);
            index = 0;
            locationsToken = undefined;
            continue;
          }
          const accountId = page.ids[index] as string;
          const { data } = await gbp(h, {
            origin: INFO,
            path: `/v1/accounts/${encodeURIComponent(accountId)}/locations`,
            query: { readMask: LOCATION_FIELDS, pageSize: 100, pageToken: locationsToken },
          });
          const all: any[] = Array.isArray(data?.locations) ? data.locations : [];
          const locations = all
            .map((location) => trimLocation(location, accountId))
            .filter((location) => chosenLocations === null || chosenLocations.includes(String(location['id'])));
          const nextLocations = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
          const here = { ap: accountsToken, ai: index, lp: locationsToken };
          const following = nextLocations
            ? cursorAt(accountsToken, index, nextLocations, 0)
            : (index + 1 < page.ids.length || (!fixed && page.next) ? cursorAt(accountsToken, index + 1, undefined, 0) : undefined);
          const offset = first ? skip : 0;
          first = false;
          const shown = locations.slice(offset);
          if (shown.length || reads === MAX_LOCATION_READS - 1) {
            return h.page({
              key: 'locations',
              items: shown,
              resumeAt: (at) => cursorAt(here.ap, here.ai, here.lp, offset + at),
              ...(following ? { nextPage: following } : {}),
            });
          }
          // Nothing to show here: go on to the next page or account.
          if (nextLocations) {
            locationsToken = nextLocations;
          } else {
            index += 1;
            locationsToken = undefined;
          }
        }
        const more = index < page.ids.length || (!fixed && page.next);
        return h.page({
          key: 'locations',
          items: [],
          ...(chosenAccounts !== null && !chosenAccounts.length && !args.account_id ? { extra: { note: 'No Business Profile account is chosen for this connection yet.' } } : {}),
          resumeAt: () => '',
          ...(more ? { nextPage: cursorAt(accountsToken, index, locationsToken, 0) } : {}),
        });
      },
    },
    {
      name: 'list_reviews',
      kind: 'read',
      title: 'List Google reviews of a location',
      description:
        "Lists a location's Google reviews, the most recently written or edited first, with the location's average rating and review "
        + 'count, and for each review its id, rating, reviewer\'s name, comment in the reviewer\'s own words (and Google\'s translation), '
        + 'times and the owner\'s reply with Google\'s moderation state. since keeps only reviews written or edited after a time and '
        + 'stops at it; only_unanswered keeps those without a reply. newest is the latest review time seen. Pass nextCursor back as cursor for older ones.',
      inputSchema: {
        type: 'object',
        properties: {
          location_id: LOCATION_ID,
          account_id: ACCOUNT_ID,
          since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T', maxLength: 40, description: 'Only reviews written or edited after this ISO time, such as 2026-10-17T09:00:00Z.' },
          only_unanswered: { type: 'boolean', default: false, description: 'Only reviews without an owner reply.' },
          page_size: { type: 'integer', minimum: 1, maximum: 50, default: 50, description: 'Reviews to read per page, 1 to 50 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['location_id'],
        additionalProperties: false,
      },
      async run(args: LocationArgs & { since?: string; only_unanswered: boolean; page_size: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const size = typeof state?.['n'] === 'number' ? state['n'] : args.page_size;
        const sinceText = typeof state?.['s'] === 'string' ? state['s'] : args.since;
        const unanswered = state ? state['u'] === 1 : args.only_unanswered;
        let since: number | undefined;
        if (sinceText !== undefined) {
          since = Date.parse(sinceText);
          if (!Number.isFinite(since)) throw new ToolFailure('since is not a valid time: give one like 2026-10-17T09:00:00Z. Nothing was sent.');
        }
        const target = resolveLocation(h, args);
        const { data } = await gbp(h, {
          path: `${target.path}/reviews`,
          query: { pageSize: size, pageToken, orderBy: 'updateTime desc' },
          errors: { 404: 'Google Business Profile found no such location under that account' },
        });
        const reviews: any[] = Array.isArray(data?.reviews) ? data.reviews : [];
        let newest: string | undefined;
        for (const review of reviews) {
          const time = Date.parse(review?.updateTime);
          if (Number.isFinite(time) && (newest === undefined || time > Date.parse(newest))) newest = review.updateTime;
        }
        const oldest = reviews.length ? Date.parse(reviews[reviews.length - 1]?.updateTime) : NaN;
        const passedSince = since !== undefined && Number.isFinite(oldest) && oldest <= since;
        const shown = reviews
          .filter((review) => since === undefined || Date.parse(review?.updateTime) > since)
          .filter((review) => !unanswered || !review?.reviewReply)
          .map(trimReview);
        const keep = { n: size, ...(sinceText !== undefined ? { s: sinceText } : {}), u: unanswered ? 1 : 0 };
        const nextToken = typeof data?.nextPageToken === 'string' && data.nextPageToken && !passedSince ? data.nextPageToken : undefined;
        return h.page({
          key: 'reviews',
          items: shown.slice(skip),
          extra: compact({
            location_id: target.locationId,
            account_id: target.accountId,
            average_rating: typeof data?.averageRating === 'number' ? data.averageRating : undefined,
            total_review_count: typeof data?.totalReviewCount === 'number' ? data.totalReviewCount : undefined,
            newest,
          }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, ...keep }),
          ...(nextToken ? { nextPage: h.makeCursor({ p: nextToken, o: 0, ...keep }) } : {}),
        });
      },
    },
    {
      name: 'get_review',
      kind: 'read',
      title: 'Get a Google review',
      description: "Reads one review of a location with the owner's reply and Google's moderation state of it (pending, approved or rejected, with the policy problem).",
      inputSchema: {
        type: 'object',
        properties: { location_id: LOCATION_ID, account_id: ACCOUNT_ID, review_id: REVIEW_ID },
        required: ['location_id', 'review_id'],
        additionalProperties: false,
      },
      async run(args: LocationArgs & { review_id: string }, h) {
        const target = resolveLocation(h, args);
        const { data } = await gbp(h, {
          path: `${target.path}/reviews/${encodeURIComponent(args.review_id)}`,
          errors: { 404: 'Google Business Profile found no such review: the location or the review no longer exists' },
        });
        return { location_id: target.locationId, account_id: target.accountId, ...trimReview(data) };
      },
    },
    {
      name: 'reply_to_review',
      kind: 'update',
      check: 'get_review',
      title: 'Reply to a Google review',
      description:
        "Posts the owner's public reply to a review, or replaces the reply it has. Up to 4,096 bytes (letters such as ç or é count as "
        + 'two). Google checks replies before showing them: the result gives the moderation state, usually pending at first. Post only '
        + 'a reply the business approved.',
      inputSchema: {
        type: 'object',
        properties: {
          location_id: LOCATION_ID,
          account_id: ACCOUNT_ID,
          review_id: REVIEW_ID,
          comment: { type: 'string', minLength: 1, maxLength: MAX_REPLY_BYTES, description: 'The reply text, in the reviewer\'s language.' },
        },
        required: ['location_id', 'review_id', 'comment'],
        additionalProperties: false,
      },
      async run(args: LocationArgs & { review_id: string; comment: string }, h) {
        const comment = args.comment.trim();
        const bytes = utf8Length(comment);
        if (!comment) throw new ToolFailure('The reply is empty. Nothing was changed.');
        if (bytes > MAX_REPLY_BYTES) {
          throw new ToolFailure(`The reply is ${bytes} bytes; Google allows ${MAX_REPLY_BYTES} (letters such as ç or é count as two bytes). Shorten it. Nothing was changed.`);
        }
        const target = resolveLocation(h, args);
        const { data } = await gbp(h, {
          method: 'PUT',
          path: `${target.path}/reviews/${encodeURIComponent(args.review_id)}/reply`,
          json: { comment },
          write: true,
          errors: { 404: 'Google Business Profile found no such review: the location or the review no longer exists' },
        });
        const reply = trimReply(data) ?? {};
        return compact({ posted: true, location_id: target.locationId, account_id: target.accountId, review_id: args.review_id, bytes, state: reply['state'], updated: reply['updated'] });
      },
    },
    {
      name: 'delete_review_reply',
      kind: 'delete',
      check: 'get_review',
      title: 'Delete the reply to a Google review',
      description: "Deletes the owner's reply to a review; the review itself stays. Only when the business asks for it.",
      inputSchema: {
        type: 'object',
        properties: { location_id: LOCATION_ID, account_id: ACCOUNT_ID, review_id: REVIEW_ID },
        required: ['location_id', 'review_id'],
        additionalProperties: false,
      },
      async run(args: LocationArgs & { review_id: string }, h) {
        const target = resolveLocation(h, args);
        await gbp(h, {
          method: 'DELETE',
          path: `${target.path}/reviews/${encodeURIComponent(args.review_id)}/reply`,
          write: true,
          errors: { 404: 'Google Business Profile found no such review or reply' },
        });
        return { deleted: true, location_id: target.locationId, account_id: target.accountId, review_id: args.review_id };
      },
    },
    // The rest of the Business Profile APIs: location details, local posts, media, metrics.
    ...apiTools({
      label: 'Google Business Profile',
      description:
        'The Business Profile APIs with the connected Google account: v4 on https://mybusiness.googleapis.com (such as '
        + '/v4/accounts/ACCOUNT_ID/locations/LOCATION_ID/localPosts), and v1 on https://mybusinessaccountmanagement.googleapis.com, '
        + 'https://mybusinessbusinessinformation.googleapis.com (such as /v1/locations/LOCATION_ID, readMask in query) and '
        + 'https://businessprofileperformance.googleapis.com (such as /v1/locations/LOCATION_ID:fetchMultiDailyMetricsTimeSeries). '
        + 'With a choice in place, a path names a chosen account or location. Reference: https://developers.google.com/my-business/reference/rest.',
      originArgument: 'The API host: https://mybusiness.googleapis.com (default), https://mybusinessaccountmanagement.googleapis.com, https://mybusinessbusinessinformation.googleapis.com or https://businessprofileperformance.googleapis.com.',
      guard,
      send: (request, h) => gbp(h, request),
    }),
  ],
});

export = connector;
