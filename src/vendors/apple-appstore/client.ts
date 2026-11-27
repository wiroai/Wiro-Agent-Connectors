// The App Store Connect side of the module: the signed token, one request
// helper per call, Apple's cursors, the account checks that need a lookup, an
// event localization's media, and the trimmed shapes the tools return.

import {
  appStoreConnectToken,
  base64Decode,
  ToolFailure,
  truncate,
  utf8Decode,
  type ApiRequest,
  type ApiResponse,
  type QueryValue,
  type ToolHelpers,
} from '../../core/index.js';

export const ORIGIN = 'https://api.appstoreconnect.apple.com';
export const LOOKUP_ORIGIN = 'https://itunes.apple.com';
/** How many pages of an app's newest reviews a write looks through to find a review (200 reviews a page). */
export const REVIEW_SCAN_PAGES = 5;

type Query = Record<string, QueryValue | ReadonlyArray<QueryValue> | undefined | null>;

/**
 * The key as PEM text. App Store Connect hands out a .p8 file, which is PEM;
 * some setups keep its text in base64, or only the base64 of the key itself.
 * Anything else is passed on unchanged, and signing then says what is wrong.
 */
export function privateKeyPem(value: string): string {
  const text = value.replace(/\\r\\n|\\n/g, '\n').trim();
  if (text.includes('-----BEGIN')) return text;
  const packed = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) return text;
  try {
    const bytes = base64Decode(packed);
    const decoded = utf8Decode(bytes);
    if (decoded.includes('-----BEGIN')) return decoded.trim();
    // A DER key starts with an ASN.1 SEQUENCE.
    if (bytes[0] === 0x30) return `-----BEGIN PRIVATE KEY-----\n${packed}\n-----END PRIVATE KEY-----`;
  } catch {
    // not base64 after all
  }
  return text;
}

export interface Asc {
  /** One request to App Store Connect with this call's token. */
  send(request: ApiRequest): Promise<ApiResponse>;
  /** A GET, returning the parsed reply. */
  get(path: string, query?: Query, errors?: ApiRequest['errors']): Promise<any>;
}

/** The App Store Connect helpers for one tool call: the token is signed once, on first use. */
export function asc(h: ToolHelpers): Asc {
  let token: Promise<string> | undefined;
  const authorization = (): Promise<string> => {
    token ??= appStoreConnectToken({
      issuerId: h.credentials['issuerid'] as string,
      keyId: h.credentials['keyid'] as string,
      privateKey: h.credentials['privatekey'] as string,
    }).then((jwt) => `Bearer ${jwt}`);
    return token;
  };
  const send = async (request: ApiRequest): Promise<ApiResponse> => h.api({
    ...request,
    origin: ORIGIN,
    headers: { ...request.headers, authorization: await authorization() },
  });
  return {
    send,
    async get(path, query, errors) {
      const { data } = await send({ path, ...(query ? { query } : {}), ...(errors ? { errors } : {}) });
      return data;
    },
  };
}

/** The cursor parameter of a reply's links.next, if there is a next page. */
export function nextAppleCursor(data: any): string | undefined {
  const next = data?.links?.next;
  if (typeof next !== 'string') return undefined;
  try {
    return new URL(next).searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Included resources of a reply by type and id. */
export function includedMap(data: any, type: string): Map<string, any> {
  const map = new Map<string, any>();
  for (const item of Array.isArray(data?.included) ? data.included : []) {
    if (item?.type === type && typeof item.id === 'string') map.set(item.id, item);
  }
  return map;
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value, max) : undefined;
}

/**
 * One page of an App Store Connect list: Apple's cursor continues the list,
 * and the size limit may cut a page, which then continues after the last item
 * returned. `enrich` may add to the items of the page before it is cut, with
 * more requests (one per item at most).
 */
export async function applePage<T>(
  h: ToolHelpers,
  api: Asc,
  options: {
    key: string;
    path: string;
    query: Query;
    cursor?: string;
    /** Sentences for the list read's failures by status, as in h.api. */
    errors?: ApiRequest['errors'];
    map(item: any, data: any): T;
    enrich?(items: T[]): Promise<void>;
    extra?(data: any): Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const state = h.cursor(options.cursor);
  const appleCursor = typeof state?.['c'] === 'string' ? state['c'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const data = await api.get(options.path, { ...options.query, ...(appleCursor ? { cursor: appleCursor } : {}) }, options.errors);
  const items: T[] = (Array.isArray(data?.data) ? data.data : []).map((item: any) => options.map(item, data)).slice(skip);
  if (options.enrich) await options.enrich(items);
  const next = nextAppleCursor(data);
  return h.page({
    key: options.key,
    items,
    ...(options.extra ? { extra: options.extra(data) } : {}),
    resumeAt: (index) => h.makeCursor({ ...(appleCursor ? { c: appleCursor } : {}), o: skip + index }),
    ...(next ? { nextPage: h.makeCursor({ c: next, o: 0 }) } : {}),
  });
}

/** True when the host applies an account lock: the write tools then check that what they change belongs to a chosen app. */
export function locked(h: ToolHelpers): boolean {
  return h.ctx.accounts !== null;
}

/** Waits, unless the call is cancelled first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolFailure('The call was cancelled while waiting for App Store Connect.'));
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(new ToolFailure('The call was cancelled while waiting for App Store Connect.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * The app's in-app event with the given fields, or a refusal when the app has
 * no such event. App Store Connect does not say which app an event belongs
 * to, so the app's own list is asked.
 */
export async function appEventOf(api: Asc, appId: string, eventId: string, fields = 'referenceName'): Promise<any> {
  const data = await api.get(`/v1/apps/${appId}/appEvents`, { 'filter[id]': eventId, 'fields[appEvents]': fields, limit: 1 });
  const event = (Array.isArray(data?.data) ? data.data : []).find((item: any) => item?.id === eventId);
  if (!event) throw new ToolFailure(`App ${appId} has no in-app event ${eventId}. Use list_app_events to find the event's id. Nothing was sent.`);
  return event;
}

/** Refuses an in-app event that is not one of the app's. */
export async function assertEventInApp(api: Asc, appId: string, eventId: string): Promise<void> {
  await appEventOf(api, appId, eventId);
}

/** An in-app event localization with what it shows: its event, images, videos and asset library placements. */
export interface EventLocalization {
  id: string;
  eventId: string;
  locale?: string;
  images: any[];
  videos: any[];
  placements: any[];
}

/** Reads a localization with its media in one request. */
export async function eventLocalizationMedia(api: Asc, localizationId: string): Promise<EventLocalization> {
  const data = await api.get(
    `/v1/appEventLocalizations/${encodeURIComponent(localizationId)}`,
    {
      include: 'appEvent,appEventScreenshots,appEventVideoClips,placements',
      'fields[appEventLocalizations]': 'locale,appEvent,appEventScreenshots,appEventVideoClips,placements',
      'fields[appEventScreenshots]': 'fileName,fileSize,appEventAssetType,assetDeliveryState,imageAsset',
      'fields[appEventVideoClips]': 'fileName,fileSize,appEventAssetType,assetDeliveryState,videoDeliveryState',
      'fields[appAssetLibraryPlacements]': 'placementType,mediaType,state',
      'limit[appEventScreenshots]': 10,
      'limit[appEventVideoClips]': 10,
      'limit[placements]': 10,
    },
    { 404: 'App Store Connect has no in-app event localization with that id' },
  );
  const eventId = data?.data?.relationships?.appEvent?.data?.id;
  if (typeof eventId !== 'string' || !eventId) throw new ToolFailure('App Store Connect did not say which event the localization belongs to. Nothing was sent.');
  const related = (name: string, type: string): any[] => {
    const included = includedMap(data, type);
    const refs: any[] = Array.isArray(data?.data?.relationships?.[name]?.data) ? data.data.relationships[name].data : [];
    return refs.map((ref) => included.get(ref?.id) ?? { type, id: ref?.id }).filter((item) => typeof item?.id === 'string');
  };
  return {
    id: localizationId,
    eventId,
    locale: data?.data?.attributes?.locale,
    images: related('appEventScreenshots', 'appEventScreenshots'),
    videos: related('appEventVideoClips', 'appEventVideoClips'),
    placements: related('placements', 'appAssetLibraryPlacements'),
  };
}

/** The errors and warnings of an asset's delivery state, as short texts. */
function deliveryNotes(list: unknown): string[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.slice(0, 10).map((item: any) => text([item?.code, item?.description].filter(Boolean).join(': '), 300)).filter((item): item is string => Boolean(item));
}

export function trimEventImage(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  const asset = a.imageAsset ?? {};
  return compact({
    id: item?.id,
    assetType: a.appEventAssetType,
    fileName: a.fileName,
    fileSize: a.fileSize,
    state: a.assetDeliveryState?.state,
    errors: deliveryNotes(a.assetDeliveryState?.errors),
    warnings: deliveryNotes(a.assetDeliveryState?.warnings),
    width: asset.width,
    height: asset.height,
    templateUrl: text(asset.templateUrl, 1000),
  });
}

export function trimEventVideo(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({
    id: item?.id,
    assetType: a.appEventAssetType,
    fileName: a.fileName,
    fileSize: a.fileSize,
    state: a.assetDeliveryState?.state,
    videoState: a.videoDeliveryState?.state,
  });
}

export function trimPlacement(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({ id: item?.id, placementType: a.placementType, mediaType: a.mediaType, state: a.state });
}

/** The id of the event a localization belongs to. */
export async function eventOfLocalization(api: Asc, localizationId: string): Promise<string> {
  const data = await api.get(
    `/v1/appEventLocalizations/${encodeURIComponent(localizationId)}`,
    { include: 'appEvent', 'fields[appEventLocalizations]': 'locale,appEvent' },
    { 404: 'App Store Connect has no in-app event localization with that id' },
  );
  const eventId = data?.data?.relationships?.appEvent?.data?.id;
  if (typeof eventId !== 'string' || !eventId) throw new ToolFailure('App Store Connect did not say which event the localization belongs to. Nothing was sent.');
  return eventId;
}

/**
 * Refuses a review that is not one of the app's. A review does not name its
 * app, so the app's newest reviews are searched, 200 at a time.
 */
export async function assertReviewInApp(api: Asc, appId: string, reviewId: string): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < REVIEW_SCAN_PAGES; page++) {
    const data = await api.get(`/v1/apps/${appId}/customerReviews`, {
      sort: '-createdDate',
      limit: 200,
      'fields[customerReviews]': 'createdDate',
      ...(cursor ? { cursor } : {}),
    });
    if ((Array.isArray(data?.data) ? data.data : []).some((review: any) => review?.id === reviewId)) return;
    cursor = nextAppleCursor(data);
    if (!cursor) break;
  }
  throw new ToolFailure(
    `The review ${reviewId} is not among the newest ${REVIEW_SCAN_PAGES * 200} reviews of app ${appId}. `
      + 'Use list_reviews for that app to find the review\'s id. Nothing was sent.',
  );
}

export function trimApp(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({ id: item?.id, name: a.name, bundleId: a.bundleId, sku: a.sku, primaryLocale: a.primaryLocale });
}

export function trimResponse(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({ id: item?.id, body: text(a.responseBody, 6000), state: a.state, lastModifiedDate: a.lastModifiedDate });
}

export function trimReview(item: any, responses: Map<string, any>): Record<string, unknown> {
  const a = item?.attributes ?? {};
  const responseId = item?.relationships?.response?.data?.id;
  const response = typeof responseId === 'string' ? responses.get(responseId) : undefined;
  return compact({
    id: item?.id,
    rating: a.rating,
    title: text(a.title, 300),
    body: text(a.body, 6000),
    reviewer: text(a.reviewerNickname, 100),
    territory: a.territory,
    createdDate: a.createdDate,
    responded: Boolean(response),
    response: response ? trimResponse(response) : undefined,
  });
}

function trimSchedule(schedule: any): Record<string, unknown> {
  return compact({
    territories: Array.isArray(schedule?.territories) ? schedule.territories.map(String) : undefined,
    publishStart: schedule?.publishStart,
    eventStart: schedule?.eventStart,
    eventEnd: schedule?.eventEnd,
  });
}

export function trimEventLocalization(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({ id: item?.id, locale: a.locale, name: a.name, shortDescription: a.shortDescription, longDescription: a.longDescription });
}

export function trimEvent(item: any, localizations?: Map<string, any>): Record<string, unknown> {
  const a = item?.attributes ?? {};
  const ids: string[] = (Array.isArray(item?.relationships?.localizations?.data) ? item.relationships.localizations.data : [])
    .map((ref: any) => ref?.id)
    .filter((id: unknown): id is string => typeof id === 'string');
  return compact({
    id: item?.id,
    referenceName: a.referenceName,
    badge: a.badge,
    state: a.eventState,
    priority: a.priority,
    purpose: a.purpose,
    purchaseRequirement: a.purchaseRequirement,
    deepLink: a.deepLink,
    primaryLocale: a.primaryLocale,
    territorySchedules: Array.isArray(a.territorySchedules) ? a.territorySchedules.map(trimSchedule) : undefined,
    localizations: localizations
      ? ids.map((id) => localizations.get(id)).filter(Boolean).map(trimEventLocalization)
      : undefined,
  });
}
