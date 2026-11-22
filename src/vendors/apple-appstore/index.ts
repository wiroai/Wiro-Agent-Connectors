// Apple App Store, through the App Store Connect API
// (https://developer.apple.com/documentation/appstoreconnectapi), plus the
// public lookup at https://itunes.apple.com for an app's live listing.
//
// Credentials: an App Store Connect API key, from App Store Connect -> Users
// and Access -> Integrations -> App Store Connect API (Team Keys):
// - keyid: the key ID shown next to the key;
// - issuerid: the issuer ID shown above the keys;
// - privatekey: the text of the key's .p8 file (its base64 works too).
// Each call signs a 20-minute ES256 token with WebCrypto and sends it to
// https://api.appstoreconnect.apple.com only; the public lookup gets no
// credentials. The key's role decides what it may do: in-app events need
// Admin, App Manager or Marketing, review responses Admin, App Manager or
// Customer Support.
//
// The apps picker (key "apps") limits the tools to the apps chosen for the
// connection. App Store Connect does not say which app an event or a review
// belongs to, so under that lock the write tools look it up first.

import { apiTools, defineConnector, requireAccounts, ToolFailure, type ApiToolRequest, type ToolHelpers } from '../../core/index.js';
import {
  applePage,
  asc,
  assertEventInApp,
  assertReviewInApp,
  compact,
  eventOfLocalization,
  includedMap,
  LOOKUP_ORIGIN,
  locked,
  ORIGIN,
  privateKeyPem,
  trimApp,
  trimEvent,
  trimEventLocalization,
  trimResponse,
  trimReview,
} from './client.js';
import { appMetadata, subscriptions } from './metadata.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BADGES = ['LIVE_EVENT', 'PREMIERE', 'CHALLENGE', 'COMPETITION', 'NEW_SEASON', 'MAJOR_UPDATE', 'SPECIAL_EVENT'];
const PURPOSES = ['APPROPRIATE_FOR_ALL_USERS', 'ATTRACT_NEW_USERS', 'KEEP_ACTIVE_USERS_INFORMED', 'BRING_BACK_LAPSED_USERS'];
const PURCHASE_REQUIREMENTS = ['NO_COST_ASSOCIATED', 'IN_APP_PURCHASE'];
const EVENT_STATES = ['DRAFT', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'REJECTED', 'ACCEPTED', 'APPROVED', 'PUBLISHED', 'PAST', 'ARCHIVED'];
const EVENT_FIELDS = 'referenceName,badge,eventState,deepLink,purchaseRequirement,primaryLocale,priority,purpose,territorySchedules,localizations';
const EVENT_LOCALIZATION_FIELDS = 'locale,name,shortDescription,longDescription';

const APP_ID = {
  type: 'string' as const,
  pattern: '^[0-9]{1,20}$',
  description: "The app's Apple ID, the number in its App Store URL (apps.apple.com/app/id1234567890), from list_apps.",
};
const RESOURCE_ID = { type: 'string' as const, pattern: '^[A-Za-z0-9_-]{1,128}$' };
const CURSOR = { type: 'string' as const, description: 'nextCursor from the previous result, with the same other arguments.' };
const DATE_TIME = {
  type: 'string' as const,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})$',
};
const LOCALE = { type: 'string' as const, pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$' };
const DEEP_LINK = {
  type: 'string' as const,
  pattern: '^[A-Za-z][A-Za-z0-9+.-]*:\\S+$',
  maxLength: 1000,
  description: 'A universal link or custom URL that opens the event in the app, e.g. https://example.com/events/spring or myapp://events/spring.',
};
const SCHEDULE = {
  type: 'object' as const,
  properties: {
    territories: {
      type: 'array' as const,
      items: { type: 'string' as const, pattern: '^[A-Z]{3}$' },
      minItems: 1,
      maxItems: 200,
      uniqueItems: true,
      description: 'ISO 3166-1 alpha-3 territory codes, e.g. ["USA", "GBR", "TUR"].',
    },
    publish_start: { ...DATE_TIME, description: 'When the event appears on the App Store, at most 14 days before event_start, e.g. 2026-12-20T00:00:00Z.' },
    event_start: { ...DATE_TIME, description: 'When the event starts.' },
    event_end: { ...DATE_TIME, description: 'When the event ends: 15 minutes to 31 days after event_start.' },
  },
  required: ['territories', 'publish_start', 'event_start', 'event_end'],
  additionalProperties: false,
};

interface ScheduleArgs {
  territories: string[];
  publish_start: string;
  event_start: string;
  event_end: string;
}

interface EventArgs {
  app_id: string;
  event_id?: string;
  reference_name?: string;
  badge?: string;
  purchase_requirement?: string;
  priority?: string;
  purpose?: string;
  deep_link?: string;
  primary_locale?: string;
  territory_schedules?: ScheduleArgs[];
}

/** Apple's schedule rules, checked before anything is sent. */
function checkSchedules(schedules: ScheduleArgs[]): void {
  schedules.forEach((schedule, index) => {
    const which = `territory_schedules[${index}]`;
    const publish = Date.parse(schedule.publish_start);
    const start = Date.parse(schedule.event_start);
    const end = Date.parse(schedule.event_end);
    const fail = (problem: string): never => {
      throw new ToolFailure(`${which}: ${problem}. Nothing was changed.`);
    };
    if ([publish, start, end].some(Number.isNaN)) fail('a date is not a valid date and time');
    if (publish > start) fail('publish_start must not be after event_start');
    if (start - publish > 14 * DAY_MS) fail('the App Store shows an event at most 14 days before it starts, so publish_start must be within 14 days of event_start');
    if (end - start < 15 * 60 * 1000) fail('an event lasts at least 15 minutes, so event_end must be at least 15 minutes after event_start');
    if (end - start > 31 * DAY_MS) fail('an event lasts at most 31 days, so event_end must be within 31 days of event_start');
  });
}

/** The event attributes of the App Store Connect API, from the tool arguments that were given. */
function eventAttributes(args: EventArgs): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (args.reference_name !== undefined) attributes['referenceName'] = args.reference_name;
  if (args.badge !== undefined) attributes['badge'] = args.badge;
  if (args.purchase_requirement !== undefined) attributes['purchaseRequirement'] = args.purchase_requirement;
  if (args.priority !== undefined) attributes['priority'] = args.priority;
  if (args.purpose !== undefined) attributes['purpose'] = args.purpose;
  if (args.deep_link !== undefined) attributes['deepLink'] = args.deep_link;
  if (args.primary_locale !== undefined) attributes['primaryLocale'] = args.primary_locale;
  if (args.territory_schedules !== undefined) {
    checkSchedules(args.territory_schedules);
    attributes['territorySchedules'] = args.territory_schedules.map((schedule) => ({
      territories: schedule.territories,
      publishStart: schedule.publish_start,
      eventStart: schedule.event_start,
      eventEnd: schedule.event_end,
    }));
  }
  return attributes;
}

const EVENT_WRITE_ERRORS = {
  403: "The App Store Connect key's role cannot manage in-app events (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused the event: a value is invalid, the reference name is already used, or the event can no longer be changed in its state',
  422: 'App Store Connect refused the event: a value is invalid',
};
const LOCALIZATION_WRITE_ERRORS = {
  403: "The App Store Connect key's role cannot manage in-app events (it needs Admin, App Manager or Marketing)",
  409: 'App Store Connect refused the localization: a text is too long or not allowed, the locale already has a localization (change it with update_app_event_localization), or the event can no longer be changed',
  422: 'App Store Connect refused the localization: a value is invalid',
};
const REVIEW_WRITE_ERRORS = {
  403: "The App Store Connect key's role cannot answer reviews (it needs Admin, App Manager or Customer Support)",
  404: 'App Store Connect found no such review or response',
  409: 'App Store Connect refused the response: the text is not allowed or too long',
};

const EVENT_EDIT_FIELDS = {
  badge: { type: 'string' as const, enum: BADGES, description: 'The badge on the event card: LIVE_EVENT, PREMIERE, CHALLENGE, COMPETITION, NEW_SEASON, MAJOR_UPDATE or SPECIAL_EVENT (holidays).' },
  purchase_requirement: {
    type: 'string' as const,
    enum: PURCHASE_REQUIREMENTS,
    description: 'NO_COST_ASSOCIATED, or IN_APP_PURCHASE when taking part needs an in-app purchase or a subscription.',
  },
  priority: { type: 'string' as const, enum: ['HIGH', 'NORMAL'], description: 'HIGH puts the event first on the product page; NORMAL otherwise.' },
  purpose: {
    type: 'string' as const,
    enum: PURPOSES,
    description: 'Who the event is for: APPROPRIATE_FOR_ALL_USERS, ATTRACT_NEW_USERS, KEEP_ACTIVE_USERS_INFORMED or BRING_BACK_LAPSED_USERS.',
  },
  deep_link: DEEP_LINK,
  primary_locale: { ...LOCALE, description: "The event's primary locale, e.g. en-US." },
  territory_schedules: {
    type: 'array' as const,
    items: SCHEDULE,
    minItems: 1,
    maxItems: 20,
    description: 'When and where the event runs: territories with publish_start, event_start and event_end each.',
  },
};

function requireApp(h: ToolHelpers, appId: string): void {
  requireAccounts(h.ctx.accounts, 'apps', appId, 'app');
}

/**
 * The app ids a generic request acts on, for the account lock: an app in the
 * path (/v1/apps/<id>/...), the app a new resource is created for (a POST to a
 * collection whose only relationship is the app), or filter[app] on a
 * collection read.
 */
function requestApps(request: ApiToolRequest): string[] {
  const [, collection, id] = request.segments;
  if (collection === 'apps' && id) return [id];
  if (request.segments.length !== 2) return [];
  if (request.method === 'POST') {
    // Another relationship (a review, an event) could point outside the app, so only the app may be named.
    const relationships = (request.json?.['data'] as any)?.relationships;
    if (typeof relationships !== 'object' || relationships === null || Object.keys(relationships).join() !== 'app') return [];
    const app = relationships.app?.data?.id;
    return typeof app === 'string' || typeof app === 'number' ? [String(app)] : [];
  }
  if (request.method === 'GET') return (request.query['filter[app]'] ?? []).flatMap((value) => value.split(',')).filter(Boolean);
  return [];
}

const connector = defineConnector({
  vendor: 'apple-appstore',
  label: 'App Store Connect',
  origins: [ORIGIN, LOOKUP_ORIGIN],
  credentials: ['keyid', 'issuerid', 'privatekey'],
  credentialLabels: {
    keyid: 'App Store Connect key ID',
    issuerid: 'App Store Connect issuer ID',
    privatekey: 'App Store Connect private key',
  },
  normalizeCredentials: (credentials) => ({
    ...credentials,
    ...(credentials['privatekey'] ? { privatekey: privateKeyPem(credentials['privatekey']) } : {}),
  }),
  accountPickers: [
    {
      key: 'apps',
      label: 'App Store apps',
      description: 'The apps the agent may read and manage in App Store Connect.',
      multiple: true,
      tool: 'list_apps',
      idField: 'id',
      nameField: 'name',
      legacyField: 'apps',
    },
  ],
  tools: [
    {
      name: 'list_apps',
      kind: 'read',
      title: 'List App Store Connect apps',
      description:
        'Lists the apps the App Store Connect key can see, by name: the Apple ID (id), name, bundle ID, SKU and primary locale of each. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100, description: 'Apps per page, 1 to 200 (default 100).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        return applePage(h, asc(h), {
          key: 'apps',
          path: '/v1/apps',
          query: { 'fields[apps]': 'name,bundleId,sku,primaryLocale', sort: 'name', limit: args.limit },
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: trimApp,
        });
      },
    },
    {
      name: 'get_app_metadata',
      kind: 'read',
      title: 'Get App Store app details',
      description:
        "What an app is: its App Store Connect record (name, bundle ID, primary locale), app info (subtitle, categories, age rating, privacy URL) for one locale, "
        + 'its latest versions, the description, keywords, promotional text and what\'s new of the live version (or the newest), and, from the public App Store '
        + 'listing of one country, its price, genre, rating, rating count and live description. Up to five requests.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          locale: { ...LOCALE, description: "The locale of the texts, e.g. en-US or tr. Default: the app's primary locale." },
          country: { type: 'string', pattern: '^[a-z]{2}$', default: 'us', description: 'The App Store country of the public listing, two lower-case letters (default us).' },
          include_store_listing: { type: 'boolean', default: true, description: 'false skips the public App Store listing.' },
        },
        required: ['app_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; locale?: string; country: string; include_store_listing: boolean }, h) {
        requireApp(h, args.app_id);
        return appMetadata(h, asc(h), args);
      },
    },
    {
      name: 'list_subscriptions',
      kind: 'read',
      title: 'List App Store subscriptions',
      description:
        "An app's auto-renewable subscriptions by subscription group: name, product ID, period, state and level of each, its current price in one "
        + 'territory (customer price, proceeds, currency, and any price change already scheduled), its introductory offers (free trial, pay as you go '
        + 'or pay up front, with the duration and the number of territories), and whether any subscription has a free trial. One request per group '
        + '(at most 10) and one per priced subscription (at most 30).',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          price_territory: { type: 'string', pattern: '^[A-Z]{3}$', default: 'USA', description: 'The territory of the prices, an ISO alpha-3 code (default USA).' },
          include_prices: { type: 'boolean', default: true, description: 'false skips the prices (one request less per subscription).' },
        },
        required: ['app_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; price_territory: string; include_prices: boolean }, h) {
        requireApp(h, args.app_id);
        return subscriptions(asc(h), args.app_id, args.include_prices ? args.price_territory : undefined);
      },
    },
    {
      name: 'list_in_app_purchases',
      kind: 'read',
      title: 'List App Store in-app purchases',
      description:
        "An app's in-app purchases (consumable, non-consumable and non-renewing subscriptions): name, product ID, type, state and family sharing. "
        + 'Auto-renewable subscriptions are in list_subscriptions. A purchase\'s price: api_get /v1/inAppPurchasePriceSchedules/<id>/manualPrices with '
        + 'include=inAppPurchasePricePoint and filter[territory]. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          type: { type: 'string', enum: ['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'], description: 'Only this type.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100, description: 'Items per page, 1 to 200 (default 100).' },
          cursor: CURSOR,
        },
        required: ['app_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; type?: string; limit: number; cursor?: string }, h) {
        requireApp(h, args.app_id);
        return applePage(h, asc(h), {
          key: 'inAppPurchases',
          path: `/v1/apps/${args.app_id}/inAppPurchasesV2`,
          query: {
            'fields[inAppPurchases]': 'name,productId,inAppPurchaseType,state,familySharable',
            'filter[inAppPurchaseType]': args.type,
            limit: args.limit,
          },
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: (item: any) => compact({
            id: item?.id,
            name: item?.attributes?.name,
            productId: item?.attributes?.productId,
            type: item?.attributes?.inAppPurchaseType,
            state: item?.attributes?.state,
            familySharable: item?.attributes?.familySharable,
          }),
        });
      },
    },
    {
      name: 'list_reviews',
      kind: 'read',
      title: 'List App Store customer reviews',
      description:
        "An app's customer reviews, newest first by default: rating, title, text, reviewer nickname, territory and date, and the developer response if there "
        + 'is one (its text and whether it is published yet). Filter by rating, territory, or whether a response is published. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          sort: { type: 'string', enum: ['-createdDate', 'createdDate', '-rating', 'rating'], default: '-createdDate', description: 'Order: -createdDate (newest first, default), createdDate, -rating or rating.' },
          ratings: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 5 },
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            description: 'Only these star ratings, e.g. [1, 2].',
          },
          territory: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Only reviews from this territory, an ISO alpha-3 code such as USA.' },
          has_published_response: {
            type: 'boolean',
            description: 'false: only reviews without a published response (to answer); true: only answered ones. Leave out for all.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Reviews per page, 1 to 200 (default 20).' },
          cursor: CURSOR,
        },
        required: ['app_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; sort: string; ratings?: number[]; territory?: string; has_published_response?: boolean; limit: number; cursor?: string }, h) {
        requireApp(h, args.app_id);
        return applePage(h, asc(h), {
          key: 'reviews',
          path: `/v1/apps/${args.app_id}/customerReviews`,
          query: {
            sort: args.sort,
            limit: args.limit,
            include: 'response',
            'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory,response',
            'fields[customerReviewResponses]': 'responseBody,lastModifiedDate,state',
            'filter[rating]': args.ratings?.join(','),
            'filter[territory]': args.territory,
            'exists[publishedResponse]': args.has_published_response,
          },
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: (item: any, data: any) => trimReview(item, includedMap(data, 'customerReviewResponses')),
          extra: () => ({ appId: args.app_id }),
        });
      },
    },
    {
      name: 'respond_to_review',
      kind: 'update',
      check: 'list_reviews',
      title: 'Respond to an App Store review',
      description:
        'Publishes the developer response to a customer review, replacing the earlier response if there is one. It shows on the App Store after Apple '
        + 'publishes it (state PENDING_PUBLISH until then). Up to 5,970 characters; a few personal sentences are best. Never sent twice.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          review_id: { ...RESOURCE_ID, description: 'The review id, from list_reviews.' },
          response_body: { type: 'string', minLength: 1, maxLength: 5970, description: 'The response text.' },
        },
        required: ['app_id', 'review_id', 'response_body'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; review_id: string; response_body: string }, h) {
        requireApp(h, args.app_id);
        const api = asc(h);
        if (locked(h)) await assertReviewInApp(api, args.app_id, args.review_id);
        const { data } = await api.send({
          method: 'POST',
          path: '/v1/customerReviewResponses',
          json: {
            data: {
              type: 'customerReviewResponses',
              attributes: { responseBody: args.response_body },
              relationships: { review: { data: { type: 'customerReviews', id: args.review_id } } },
            },
          },
          write: true,
          errors: REVIEW_WRITE_ERRORS,
        });
        return compact({ reviewId: args.review_id, ...trimResponse(data?.data) });
      },
    },
    {
      name: 'delete_review_response',
      kind: 'delete',
      check: 'list_reviews',
      title: 'Delete an App Store review response',
      description:
        'Deletes the developer response to a customer review; it leaves the App Store after a while. The response id is in list_reviews (response.id).',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          response_id: { ...RESOURCE_ID, description: 'The response id, from list_reviews (response.id).' },
        },
        required: ['app_id', 'response_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; response_id: string }, h) {
        requireApp(h, args.app_id);
        const api = asc(h);
        if (locked(h)) {
          const reply = await api.get(
            `/v1/customerReviewResponses/${encodeURIComponent(args.response_id)}`,
            { include: 'review', 'fields[customerReviewResponses]': 'review' },
            { 404: 'App Store Connect has no review response with that id' },
          );
          const reviewId = reply?.data?.relationships?.review?.data?.id;
          if (typeof reviewId !== 'string') throw new ToolFailure('App Store Connect did not say which review the response belongs to. Nothing was sent.');
          await assertReviewInApp(api, args.app_id, reviewId);
        }
        await api.send({ method: 'DELETE', path: `/v1/customerReviewResponses/${encodeURIComponent(args.response_id)}`, write: true, errors: REVIEW_WRITE_ERRORS });
        return { deleted: true, id: args.response_id };
      },
    },
    {
      name: 'list_app_events',
      kind: 'read',
      title: 'List App Store in-app events',
      description:
        "An app's in-app events with their state, badge, priority, purpose, purchase requirement, deep link, territory schedules and localizations "
        + '(name, short and long description per locale), plus how many are in each state. Apple allows 10 published, 15 approved and 50 draft events '
        + 'at a time. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          states: { type: 'array', items: { type: 'string', enum: EVENT_STATES }, minItems: 1, uniqueItems: true, description: 'Only events in these states, e.g. ["DRAFT", "PUBLISHED"].' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Events per page, 1 to 200 (default 50).' },
          cursor: CURSOR,
        },
        required: ['app_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; states?: string[]; limit: number; cursor?: string }, h) {
        requireApp(h, args.app_id);
        return applePage(h, asc(h), {
          key: 'events',
          path: `/v1/apps/${args.app_id}/appEvents`,
          query: {
            'fields[appEvents]': EVENT_FIELDS,
            include: 'localizations',
            'fields[appEventLocalizations]': EVENT_LOCALIZATION_FIELDS,
            'limit[localizations]': 50,
            'filter[eventState]': args.states?.join(','),
            limit: args.limit,
          },
          ...(args.cursor ? { cursor: args.cursor } : {}),
          map: (item: any, data: any) => trimEvent(item, includedMap(data, 'appEventLocalizations')),
          extra: (data: any) => {
            const counts: Record<string, number> = {};
            for (const item of Array.isArray(data?.data) ? data.data : []) {
              const state = String(item?.attributes?.eventState ?? 'UNKNOWN');
              counts[state] = (counts[state] ?? 0) + 1;
            }
            return { appId: args.app_id, countsOnThisPage: counts };
          },
        });
      },
    },
    {
      name: 'create_app_event',
      kind: 'create',
      check: 'list_app_events',
      title: 'Create an App Store in-app event',
      description:
        'Creates an in-app event as a draft (nothing is shown until it passes App Review). Add its texts with create_app_event_localization. '
        + 'Rules checked first: publish_start at most 14 days before event_start, events last 15 minutes to 31 days. Apple refuses a reference name '
        + 'the app already uses. Never sent twice: check list_app_events after an unclear outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          reference_name: { type: 'string', minLength: 1, maxLength: 64, description: 'An internal name, unique for the app, shown only in App Store Connect, e.g. lunar-new-year-2027.' },
          ...EVENT_EDIT_FIELDS,
        },
        required: ['app_id', 'reference_name', 'badge', 'purchase_requirement', 'priority', 'purpose', 'territory_schedules'],
        additionalProperties: false,
      },
      async run(args: EventArgs, h) {
        requireApp(h, args.app_id);
        const attributes = eventAttributes(args);
        const { data } = await asc(h).send({
          method: 'POST',
          path: '/v1/appEvents',
          json: { data: { type: 'appEvents', attributes, relationships: { app: { data: { type: 'apps', id: args.app_id } } } } },
          write: true,
          errors: EVENT_WRITE_ERRORS,
        });
        return { appId: args.app_id, event: trimEvent(data?.data) };
      },
    },
    {
      name: 'update_app_event',
      kind: 'update',
      check: 'list_app_events',
      title: 'Change an App Store in-app event',
      description:
        "Changes an in-app event's reference name, badge, purchase requirement, priority, purpose, deep link, primary locale or territory schedules: "
        + 'only the fields given change, and territory_schedules replaces all schedules. Apple allows changes only in some states (a draft always).',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          event_id: { ...RESOURCE_ID, description: 'The event id, from list_app_events.' },
          reference_name: { type: 'string', minLength: 1, maxLength: 64, description: 'A new internal name.' },
          ...EVENT_EDIT_FIELDS,
        },
        required: ['app_id', 'event_id'],
        additionalProperties: false,
      },
      async run(args: EventArgs & { event_id: string }, h) {
        requireApp(h, args.app_id);
        const attributes = eventAttributes(args);
        if (!Object.keys(attributes).length) throw new ToolFailure('Nothing to change: give at least one field besides app_id and event_id. Nothing was changed.');
        const api = asc(h);
        if (locked(h)) await assertEventInApp(api, args.app_id, args.event_id);
        const { data } = await api.send({
          method: 'PATCH',
          path: `/v1/appEvents/${encodeURIComponent(args.event_id)}`,
          json: { data: { type: 'appEvents', id: args.event_id, attributes } },
          write: true,
          errors: { ...EVENT_WRITE_ERRORS, 404: 'App Store Connect has no in-app event with that id' },
        });
        return { appId: args.app_id, event: trimEvent(data?.data) };
      },
    },
    {
      name: 'delete_app_event',
      kind: 'delete',
      check: 'list_app_events',
      title: 'Delete an App Store in-app event',
      description: 'Deletes an in-app event with its localizations and images. Apple refuses this for an event in review or on the App Store; archive those in App Store Connect.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          event_id: { ...RESOURCE_ID, description: 'The event id, from list_app_events.' },
        },
        required: ['app_id', 'event_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; event_id: string }, h) {
        requireApp(h, args.app_id);
        const api = asc(h);
        if (locked(h)) await assertEventInApp(api, args.app_id, args.event_id);
        await api.send({
          method: 'DELETE',
          path: `/v1/appEvents/${encodeURIComponent(args.event_id)}`,
          write: true,
          errors: { ...EVENT_WRITE_ERRORS, 404: 'App Store Connect has no in-app event with that id' },
        });
        return { deleted: true, appId: args.app_id, eventId: args.event_id };
      },
    },
    {
      name: 'create_app_event_localization',
      kind: 'create',
      check: 'list_app_events',
      title: 'Add texts to an App Store in-app event',
      description:
        "Adds an in-app event's texts in one locale: the name (30 characters, title case), short description (50, sentence case, on the event card) and long "
        + 'description (120, on the detail page). No prices, no ALL CAPS, no unverifiable claims. A locale that already has texts (Apple adds the primary '
        + 'locale itself) is changed with update_app_event_localization instead.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          event_id: { ...RESOURCE_ID, description: 'The event id, from list_app_events or create_app_event.' },
          locale: { ...LOCALE, description: 'The locale, e.g. en-US, zh-Hans, tr.' },
          name: { type: 'string', minLength: 1, maxLength: 30, description: 'The event name, up to 30 characters.' },
          short_description: { type: 'string', minLength: 1, maxLength: 50, description: 'Up to 50 characters, shown on the event card.' },
          long_description: { type: 'string', minLength: 1, maxLength: 120, description: 'Up to 120 characters, shown on the event page.' },
        },
        required: ['app_id', 'event_id', 'locale', 'name', 'short_description', 'long_description'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; event_id: string; locale: string; name: string; short_description: string; long_description: string }, h) {
        requireApp(h, args.app_id);
        const api = asc(h);
        if (locked(h)) await assertEventInApp(api, args.app_id, args.event_id);
        const { data } = await api.send({
          method: 'POST',
          path: '/v1/appEventLocalizations',
          json: {
            data: {
              type: 'appEventLocalizations',
              attributes: { locale: args.locale, name: args.name, shortDescription: args.short_description, longDescription: args.long_description },
              relationships: { appEvent: { data: { type: 'appEvents', id: args.event_id } } },
            },
          },
          write: true,
          errors: LOCALIZATION_WRITE_ERRORS,
        });
        return { appId: args.app_id, eventId: args.event_id, localization: trimEventLocalization(data?.data) };
      },
    },
    {
      name: 'update_app_event_localization',
      kind: 'update',
      check: 'list_app_events',
      title: 'Change the texts of an App Store in-app event',
      description:
        "Changes an in-app event's name (30 characters), short description (50) or long description (120) in one locale: only the texts given change. "
        + 'The localization id is in list_app_events.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: APP_ID,
          localization_id: { ...RESOURCE_ID, description: 'The localization id, from list_app_events (localizations[].id).' },
          name: { type: 'string', minLength: 1, maxLength: 30, description: 'The event name, up to 30 characters.' },
          short_description: { type: 'string', minLength: 1, maxLength: 50, description: 'Up to 50 characters.' },
          long_description: { type: 'string', minLength: 1, maxLength: 120, description: 'Up to 120 characters.' },
        },
        required: ['app_id', 'localization_id'],
        additionalProperties: false,
      },
      async run(args: { app_id: string; localization_id: string; name?: string; short_description?: string; long_description?: string }, h) {
        requireApp(h, args.app_id);
        const attributes = compact({ name: args.name, shortDescription: args.short_description, longDescription: args.long_description });
        if (!Object.keys(attributes).length) throw new ToolFailure('Nothing to change: give name, short_description or long_description. Nothing was changed.');
        const api = asc(h);
        if (locked(h)) await assertEventInApp(api, args.app_id, await eventOfLocalization(api, args.localization_id));
        const { data } = await api.send({
          method: 'PATCH',
          path: `/v1/appEventLocalizations/${encodeURIComponent(args.localization_id)}`,
          json: { data: { type: 'appEventLocalizations', id: args.localization_id, attributes } },
          write: true,
          errors: { ...LOCALIZATION_WRITE_ERRORS, 404: 'App Store Connect has no in-app event localization with that id' },
        });
        return { appId: args.app_id, localization: trimEventLocalization(data?.data) };
      },
    },
    // The rest of the App Store Connect API: version localizations, screenshots
    // sets, prices, analytics report requests, review submissions and more.
    ...apiTools({
      label: 'App Store Connect',
      description:
        'The App Store Connect API at https://api.appstoreconnect.apple.com, with a token signed from the connected key: paths start with /v1/ (some '
        + 'with /v2/ or /v3/), such as /v1/apps/1234567890/appStoreVersions or /v1/appStoreVersionLocalizations/<id>, and JSON:API bodies '
        + '({"data": {"type": ..., "attributes": ...}}). Under an account lock a request must name a chosen app: in the path (/v1/apps/<id>/...), '
        + 'in relationships.app of a POST, or in filter[app]. Reference: https://developer.apple.com/documentation/appstoreconnectapi.',
      accounts: { key: 'apps', label: 'app', ids: requestApps },
      guard(request) {
        if (!/^\/v[1-9]\//.test(request.path)) throw new ToolFailure('The path must start with /v1/, /v2/ or /v3/. Nothing was sent.');
      },
      send: (request, h) => asc(h).send(request),
    }),
  ],
});

export = connector;
