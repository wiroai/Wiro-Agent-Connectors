// Google Play, through the Google Play Android Developer API v3 (reviews and
// replies, store listings through edits, subscriptions, in-app products) and
// the Google Play Developer Reporting API (the apps the key can see), as a
// service account.
//
// Credential: `serviceaccountjson`, a service account key, the JSON file
// Google Cloud creates under IAM and admin -> Service accounts -> Keys (its
// base64 text works too). It signs a short-lived token (RS256) for the
// androidpublisher and playdeveloperreporting scopes; the key never leaves
// the call. Invite the service account's email in Play Console -> Users and
// permissions for the apps the agent works on. A host picks those apps with
// the `apps` account picker; every tool then keeps to them.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  OutcomeUnknown,
  requireAccounts,
  ToolFailure,
  truncate,
  type ApiRequest,
  type ApiResponse,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  compact,
  isoTime,
  offersByBasePlan,
  trimInAppProduct,
  trimListing,
  trimOneTimeProduct,
  trimReview,
  trimSubscription,
} from './catalog.js';
import { googleApi, KEY_CREDENTIAL, serviceAccountWords } from './service-account.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Google Play';
const PUBLISHER_ORIGIN = 'https://androidpublisher.googleapis.com';
const REPORTING_ORIGIN = 'https://playdeveloperreporting.googleapis.com';
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/androidpublisher', 'https://www.googleapis.com/auth/playdeveloperreporting'];
const PICKER = 'apps';
const MAX_REPLY = 350;
const PACKAGE_PATTERN = '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$';

const PACKAGE: JsonSchema = {
  type: 'string',
  pattern: PACKAGE_PATTERN,
  maxLength: 150,
  description: 'The app\'s package name, e.g. com.example.app. Optional when only one app is chosen for the connection.',
};
const REVIEW_ID: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9:_.\\-]{1,512}$', description: 'The review id, e.g. gp:AOqpTOE... from list_reviews.' };
const LANGUAGE: JsonSchema = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$', maxLength: 20, description: 'A language code as Play uses it, e.g. en-US, tr-TR or es-419.' };
const REGION: JsonSchema = { type: 'string', pattern: '^[A-Z]{2}$', default: 'US', description: 'The country whose prices to show, e.g. US (default) or TR.' };

function play(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  const who = serviceAccountWords(h);
  return googleApi(h, SCOPES, {
    ...request,
    errors: {
      401: `Google Play did not accept ${who}: check that it is invited in Play Console -> Users and permissions`,
      403: `Google Play refused the request: invite ${who} in Play Console -> Users and permissions with access to this app and the permission the action needs (View app information to read, Reply to reviews to reply, Manage store presence for listings and products), and check that the Google Play Android Developer API is enabled for the key's project`,
      404: 'Google Play found no such app or item: check the package name, and that the app is published on Google Play',
      ...request.errors,
    },
  });
}

/** The package a call works on: given and among the chosen apps, or the only chosen app. */
function packageFor(h: ToolHelpers, given: string | undefined): string {
  if (given !== undefined) {
    requireAccounts(h.ctx.accounts, PICKER, given, 'app');
    return given;
  }
  const allowed = allowedAccounts(h.ctx.accounts, PICKER);
  if (allowed?.length === 1) return allowed[0] as string;
  throw new ToolFailure(
    allowed?.length
      ? `Give package_name: one of ${allowed.join(', ')}. Nothing was sent.`
      : allowed
        ? 'No app is chosen for this Google Play connection yet. Nothing was sent.'
        : 'Give package_name, such as com.example.app (list_apps lists the apps). Nothing was sent.',
  );
}

function appPath(packageName: string, rest = ''): string {
  return `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}${rest}`;
}

/** apps:search of the Reporting API: the apps the service account can see. */
async function searchApps(h: ToolHelpers, pageToken: string | undefined, pageSize: number): Promise<{ apps: any[]; next?: string }> {
  const { data } = await play(h, {
    origin: REPORTING_ORIGIN,
    path: '/v1beta1/apps:search',
    query: { pageSize, pageToken },
    errors: {
      403: `Google Play did not list the apps: enable the Google Play Developer Reporting API for the key's project and invite ${serviceAccountWords(h)} in Play Console -> Users and permissions`,
    },
  });
  return {
    apps: Array.isArray(data?.apps) ? data.apps : [],
    ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { next: data.nextPageToken } : {}),
  };
}

function trimApp(app: any): Record<string, unknown> {
  const fromName = typeof app?.name === 'string' ? app.name.replace(/^apps\//, '') : undefined;
  return compact({ packageName: app?.packageName ?? fromName, displayName: app?.displayName ?? app?.packageName ?? fromName });
}

/**
 * Opens an edit (a draft copy of the app's store settings), runs `use`, and
 * deletes the edit again. Google Play keeps one open edit per account, so
 * opening one ends any other edit the same service account has open.
 */
async function readThroughEdit<T>(h: ToolHelpers, packageName: string, use: (editPath: string) => Promise<T>): Promise<T> {
  const { data } = await play(h, { method: 'POST', path: appPath(packageName, '/edits'), json: {}, safe: true });
  if (typeof data?.id !== 'string' || !data.id) throw new ToolFailure('Google Play opened no edit for the app.');
  const editPath = appPath(packageName, `/edits/${encodeURIComponent(data.id)}`);
  try {
    return await use(editPath);
  } finally {
    try {
      await play(h, { method: 'DELETE', path: editPath, safe: true });
    } catch {
      // An edit left open expires or is replaced by the next one; it changes nothing.
    }
  }
}

/** Account and permission management stays in Play Console. */
function playGuard(request: ApiToolRequest): void {
  if (request.segments[2] === 'developers') {
    throw new ToolFailure('Google Play user and permission management (/androidpublisher/v3/developers/...) is not available here: manage users in Play Console. Nothing was sent.');
  }
}

const connector = defineConnector({
  vendor: 'google-play',
  label: LABEL,
  origins: [PUBLISHER_ORIGIN, REPORTING_ORIGIN, TOKEN_ORIGIN],
  credentials: [KEY_CREDENTIAL],
  credentialLabels: { serviceaccountjson: 'Google Play service account key' },
  accountPickers: [
    {
      key: PICKER,
      label: 'Google Play apps',
      description: 'The Android apps the agent works on: their reviews, store listings and products.',
      multiple: true,
      tool: 'list_apps',
      idField: 'packageName',
      nameField: 'displayName',
      legacyField: 'apps',
    },
  ],
  tools: [
    {
      name: 'list_apps',
      kind: 'read',
      title: 'List Google Play apps',
      description:
        'Lists the Android apps: the apps chosen for this connection, or, with no choice made, every app the service account can see in Play '
        + 'Console (through the Google Play Developer Reporting API, which must be enabled for the key\'s project). Each has its package name '
        + 'and display name. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: 'nextCursor from the previous result.' } }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const allowed = allowedAccounts(h.ctx.accounts, PICKER);
        const state = h.cursor(args.cursor);
        if (allowed !== null) {
          // The chosen apps, named from the search when it answers.
          let names = new Map<string, string>();
          let note: string | undefined;
          try {
            const { apps } = await searchApps(h, undefined, 1000);
            names = new Map(apps.map((app) => trimApp(app)).map((app) => [String(app['packageName']), String(app['displayName'])]));
          } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
            note = `The app names could not be read: ${truncate(error.message, 300)}`;
          }
          const offset = typeof state?.['c'] === 'number' ? state['c'] : 0;
          return h.page({
            key: 'apps',
            items: allowed.slice(offset).map((packageName) => ({ packageName, displayName: names.get(packageName) ?? packageName })),
            extra: compact({ chosen: true, note }),
            resumeAt: (index) => h.makeCursor({ c: offset + index }),
          });
        }
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { apps, next } = await searchApps(h, pageToken, 100);
        return h.page({
          key: 'apps',
          items: apps.map(trimApp).slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(next ? { nextPage: h.makeCursor({ p: next, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'list_reviews',
      kind: 'read',
      title: 'List Google Play reviews',
      description:
        'Lists an app\'s reviews with text that were written or changed in the last week (all Google Play returns), newest first: id, author, '
        + 'stars, text, language, app version, device, and the developer reply if there is one. unanswered_only leaves out replied reviews. '
        + 'translation_language translates the texts. Google Play allows 200 review reads per hour per app. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: PACKAGE,
          max_results: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Reviews per page, 1 to 100 (default 50).' },
          unanswered_only: { type: 'boolean', default: false, description: 'Only reviews without a developer reply (default false).' },
          translation_language: { ...LANGUAGE, description: 'Translate the review texts into this language, e.g. en.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { package_name?: string; max_results: number; unanswered_only: boolean; translation_language?: string; cursor?: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const state = h.cursor(args.cursor);
        const token = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await play(h, {
          path: appPath(packageName, '/reviews'),
          query: { maxResults: args.max_results, token, translationLanguage: args.translation_language },
        });
        const reviews = (Array.isArray(data?.reviews) ? data.reviews : []).map(trimReview)
          .filter((review: Record<string, unknown>) => !args.unanswered_only || review['replied'] === false);
        const next = data?.tokenPagination?.nextPageToken;
        return h.page({
          key: 'reviews',
          items: reviews.slice(skip),
          extra: { packageName },
          resumeAt: (index) => h.makeCursor({ ...(token ? { p: token } : {}), o: skip + index }),
          ...(typeof next === 'string' && next ? { nextPage: h.makeCursor({ p: next, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_review',
      kind: 'read',
      title: 'Get a Google Play review',
      description: 'Returns one review of an app by its id, with the developer reply if there is one.',
      inputSchema: {
        type: 'object',
        properties: { package_name: PACKAGE, review_id: REVIEW_ID, translation_language: { ...LANGUAGE, description: 'Translate the review text into this language.' } },
        required: ['review_id'],
        additionalProperties: false,
      },
      async run(args: { package_name?: string; review_id: string; translation_language?: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const { data } = await play(h, { path: appPath(packageName, `/reviews/${args.review_id}`), query: { translationLanguage: args.translation_language } });
        return { packageName, ...trimReview(data) };
      },
    },
    {
      name: 'reply_to_review',
      kind: 'update',
      check: 'get_review',
      title: 'Reply to a Google Play review',
      description:
        `Posts the developer reply to a review, or replaces the earlier reply: plain text up to ${MAX_REPLY} characters. Google Play's policy `
        + 'allows no links, phone numbers or promotions in replies; the reviewer is notified of the first reply only. Returns the reply as saved.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: PACKAGE,
          review_id: REVIEW_ID,
          reply_text: { type: 'string', minLength: 1, maxLength: MAX_REPLY, description: `The reply, up to ${MAX_REPLY} characters.` },
        },
        required: ['review_id', 'reply_text'],
        additionalProperties: false,
      },
      async run(args: { package_name?: string; review_id: string; reply_text: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const { data } = await play(h, {
          method: 'POST',
          path: appPath(packageName, `/reviews/${args.review_id}:reply`),
          json: { replyText: args.reply_text },
          write: true,
          errors: { 400: `Google Play did not accept the reply (at most ${MAX_REPLY} characters of plain text)` },
        });
        return compact({ packageName, reviewId: args.review_id, replyText: data?.result?.replyText ?? args.reply_text, lastEdited: isoTime(data?.result?.lastEdited) });
      },
    },
    {
      name: 'get_store_listing',
      kind: 'read',
      title: 'Get a Google Play store listing',
      description:
        'Returns an app\'s store listing: title, short and full description and video for each language (or one), with the default language '
        + 'and contact details. It reads them through a temporary edit that it deletes again; Google Play keeps one open edit per account, '
        + 'so this ends any other edit the same service account has open (do not run it while a release made with the same key is in '
        + 'progress). Pass nextCursor back as cursor for more languages.',
      inputSchema: {
        type: 'object',
        properties: { package_name: PACKAGE, language: { ...LANGUAGE, description: 'Only this language, e.g. en-US.' }, cursor: { type: 'string', description: 'nextCursor from the previous result.' } },
        additionalProperties: false,
      },
      async run(args: { package_name?: string; language?: string; cursor?: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { listings, details } = await readThroughEdit(h, packageName, async (editPath) => {
          const listingRead = args.language !== undefined
            ? [(await play(h, { path: `${editPath}/listings/${encodeURIComponent(args.language)}` })).data]
            : (await play(h, { path: `${editPath}/listings` })).data?.listings;
          const detailRead = (await play(h, { path: `${editPath}/details` })).data;
          return { listings: Array.isArray(listingRead) ? listingRead : [], details: detailRead };
        });
        return h.page({
          key: 'listings',
          items: listings.map(trimListing).slice(skip),
          extra: compact({
            packageName,
            defaultLanguage: details?.defaultLanguage,
            contactEmail: details?.contactEmail,
            contactWebsite: details?.contactWebsite,
            contactPhone: details?.contactPhone,
          }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'update_store_listing',
      kind: 'update',
      check: 'get_store_listing',
      title: 'Update a Google Play store listing',
      description:
        'Changes an app\'s store listing in one language (adding the language if it is new): title (up to 30 characters), short description '
        + '(80), full description (4000) or promo video. Only the fields given change. It opens an edit, saves the listing and commits the '
        + 'edit; the change goes through Google Play\'s review before it shows. Needs the Manage store presence permission.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: PACKAGE,
          language: LANGUAGE,
          title: { type: 'string', minLength: 1, maxLength: 30, description: 'The app name on the listing, up to 30 characters.' },
          short_description: { type: 'string', minLength: 1, maxLength: 80, description: 'Up to 80 characters.' },
          full_description: { type: 'string', minLength: 1, maxLength: 4000, description: 'Up to 4000 characters.' },
          video: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 500, description: 'The URL of the promo video, as the listing\'s promo video field takes it.' },
          changes_not_sent_for_review: {
            type: 'boolean',
            default: false,
            description: 'true when Google Play answers that the changes cannot be sent for review automatically: they then wait in Play Console until someone sends them.',
          },
        },
        required: ['language'],
        additionalProperties: false,
      },
      async run(args: { package_name?: string; language: string; title?: string; short_description?: string; full_description?: string; video?: string; changes_not_sent_for_review: boolean }, h) {
        const packageName = packageFor(h, args.package_name);
        const listing = compact({ title: args.title, shortDescription: args.short_description, fullDescription: args.full_description, video: args.video });
        if (!Object.keys(listing).length) throw new ToolFailure('Give at least one field to change. Nothing was changed.');
        const { data: edit } = await play(h, { method: 'POST', path: appPath(packageName, '/edits'), json: {} });
        if (typeof edit?.id !== 'string' || !edit.id) throw new ToolFailure('Google Play opened no edit for the app. Nothing was changed.');
        const editPath = appPath(packageName, `/edits/${encodeURIComponent(edit.id)}`);
        try {
          const { data: saved } = await play(h, { method: 'PATCH', path: `${editPath}/listings/${encodeURIComponent(args.language)}`, json: listing });
          await play(h, {
            method: 'POST',
            path: `${editPath}:commit`,
            query: { changesNotSentForReview: args.changes_not_sent_for_review || undefined },
            write: true,
          });
          return compact({ packageName, committed: true, sentForReview: !args.changes_not_sent_for_review, listing: trimListing(saved) });
        } catch (error) {
          if (!(error instanceof OutcomeUnknown)) {
            // Nothing was committed: drop the draft.
            await play(h, { method: 'DELETE', path: editPath }).catch(() => undefined);
          }
          throw error;
        }
      },
    },
    {
      name: 'list_subscriptions',
      kind: 'read',
      title: 'List Google Play subscriptions',
      description:
        'Lists an app\'s subscriptions: product id, name and description per language, and each base plan with its state, billing period, '
        + 'price in one country and offers (with free trials and intro prices). hasFreeTrial says whether an active offer starts free. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: PACKAGE,
          region: REGION,
          include_offers: { type: 'boolean', default: true, description: 'Read the offers too (one more request; default true).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { package_name?: string; region: string; include_offers: boolean; cursor?: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await play(h, { path: appPath(packageName, '/subscriptions'), query: { pageSize: 100, pageToken } });
        const subscriptions: any[] = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
        let offers: ReturnType<typeof offersByBasePlan> | undefined;
        let note: string | undefined;
        if (args.include_offers && subscriptions.length) {
          try {
            const read = await play(h, { path: appPath(packageName, '/subscriptions/-/basePlans/-/offers'), query: { pageSize: 1000 } });
            offers = offersByBasePlan(Array.isArray(read.data?.subscriptionOffers) ? read.data.subscriptionOffers : [], args.region);
            if (read.data?.nextPageToken) note = 'The app has more than 1000 offers: only the first 1000 are shown.';
          } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
            note = `The offers could not be read: ${truncate(error.message, 300)}`;
          }
        }
        return h.page({
          key: 'subscriptions',
          items: subscriptions.map((subscription) => trimSubscription(subscription, args.region, offers)).slice(skip),
          extra: compact({ packageName, note }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'list_in_app_products',
      kind: 'read',
      title: 'List Google Play in-app products',
      description:
        'Lists an app\'s one-time in-app products: sku, status, name and description, default price and the price in one country. '
        + 'catalog one_time_products reads the newer one-time products API instead (purchase options). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          package_name: PACKAGE,
          catalog: { type: 'string', enum: ['in_app_products', 'one_time_products'], default: 'in_app_products', description: 'in_app_products (default) or one_time_products.' },
          region: REGION,
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { package_name?: string; catalog: string; region: string; cursor?: string }, h) {
        const packageName = packageFor(h, args.package_name);
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        let items: Record<string, unknown>[];
        let next: unknown;
        if (args.catalog === 'one_time_products') {
          const { data } = await play(h, { path: appPath(packageName, '/oneTimeProducts'), query: { pageSize: 100, pageToken } });
          items = (Array.isArray(data?.oneTimeProducts) ? data.oneTimeProducts : []).map((product: any) => trimOneTimeProduct(product, args.region));
          next = data?.nextPageToken;
        } else {
          const { data } = await play(h, { path: appPath(packageName, '/inappproducts'), query: { token: pageToken } });
          items = (Array.isArray(data?.inappproduct) ? data.inappproduct : []).map((product: any) => trimInAppProduct(product, args.region));
          next = data?.tokenPagination?.nextPageToken;
        }
        return h.page({
          key: 'products',
          items: items.slice(skip),
          extra: { packageName, catalog: args.catalog },
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof next === 'string' && next ? { nextPage: h.makeCursor({ p: next, o: 0 }) } : {}),
        });
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Google Play Android Developer API v3 at https://androidpublisher.googleapis.com/androidpublisher/v3, as the service account: '
        + 'paths start with /androidpublisher/v3/applications/{packageName}/, such as .../edits, .../monetization/subscriptions/{productId}:batchUpdateStates '
        + 'or .../purchases/subscriptionsv2/tokens/{token}, and must name a chosen app. What a call may do follows the service account\'s '
        + 'permissions in Play Console. Reference: https://developers.google.com/android-publisher/api-ref/rest.',
      basePath: '/androidpublisher/v3/',
      accounts: {
        key: PICKER,
        label: 'app',
        ids: (request) => (request.segments[2] === 'applications' && request.segments[3] ? [request.segments[3]] : []),
      },
      guard: playGuard,
      send: (request, h) => play(h, request),
    }),
  ],
});

export = connector;
