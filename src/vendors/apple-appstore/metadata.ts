// What an app is and sells: its App Store Connect record, app info and version
// texts, its live listing from the public lookup, its subscriptions with their
// prices and introductory offers, and the prices of its one-time purchases.

import { ToolFailure, type ToolHelpers } from '../../core/index.js';
import { compact, includedMap, LOOKUP_ORIGIN, nextAppleCursor, text, type Asc } from './client.js';

/** Version states that mean the version is the one on the App Store. */
const LIVE_STATES = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);

/**
 * The key that reads what the connected key's role does not. App Store Connect
 * answers such a read with HTTP 403 ("The API key in use does not allow this
 * request"): a Customer Support key, say, reads the app, its versions and its
 * reviews, but not its app info, subscriptions or in-app purchases.
 */
const ROLE_NEEDED = 'an App Store Connect key with the Admin or App Manager role';

/** The refusal of a read the key's role does not allow (the HTTP status and Apple's words follow it). */
export function roleRefusal(what: string): string {
  return `Reading ${what} needs ${ROLE_NEEDED}, and the connected key's role does not allow it`;
}

/**
 * One optional part of the app's details: a read the key's role does not
 * allow (HTTP 403) leaves the part out with a note, and the tool still returns
 * the rest. Any other failure fails the tool.
 */
async function optionalPart<T>(notes: string[], what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 403) {
      notes.push(`${what[0]?.toUpperCase()}${what.slice(1)} left out: reading it needs ${ROLE_NEEDED}, and the connected key's role does not allow it (HTTP 403).`);
      return undefined;
    }
    throw error;
  }
}

function trimAppInfo(item: any, localizations: Map<string, any>, locale: string): Record<string, unknown> {
  const a = item?.attributes ?? {};
  const refs: any[] = Array.isArray(item?.relationships?.appInfoLocalizations?.data) ? item.relationships.appInfoLocalizations.data : [];
  const all = refs.map((ref) => localizations.get(ref?.id)).filter(Boolean);
  const chosen = all.find((loc) => loc?.attributes?.locale === locale) ?? all[0];
  const l = chosen?.attributes ?? {};
  return compact({
    id: item?.id,
    state: a.state ?? a.appStoreState,
    ageRating: a.appStoreAgeRating,
    primaryCategory: item?.relationships?.primaryCategory?.data?.id,
    secondaryCategory: item?.relationships?.secondaryCategory?.data?.id,
    locale: l.locale,
    name: l.name,
    subtitle: l.subtitle,
    privacyPolicyUrl: l.privacyPolicyUrl,
    locales: all.map((loc) => loc?.attributes?.locale).filter(Boolean),
  });
}

function trimVersion(item: any): Record<string, unknown> {
  const a = item?.attributes ?? {};
  return compact({
    id: item?.id,
    platform: a.platform,
    versionString: a.versionString,
    state: a.appVersionState ?? a.appStoreState,
    releaseType: a.releaseType,
    createdDate: a.createdDate,
  });
}

function trimListing(result: any, country: string): Record<string, unknown> {
  return compact({
    country,
    available: true,
    url: result?.trackViewUrl,
    name: result?.trackName,
    seller: result?.sellerName,
    price: result?.price,
    formattedPrice: result?.formattedPrice,
    currency: result?.currency,
    primaryGenre: result?.primaryGenreName,
    genres: Array.isArray(result?.genres) ? result.genres : undefined,
    averageUserRating: result?.averageUserRating,
    userRatingCount: result?.userRatingCount,
    contentAdvisoryRating: result?.contentAdvisoryRating,
    version: result?.version,
    currentVersionReleaseDate: result?.currentVersionReleaseDate,
    releaseNotes: text(result?.releaseNotes, 2000),
    description: text(result?.description, 4000),
    minimumOsVersion: result?.minimumOsVersion,
    languages: Array.isArray(result?.languageCodesISO2A) ? result.languageCodesISO2A : undefined,
    fileSizeBytes: result?.fileSizeBytes,
  });
}

/** The live listing from the public lookup. It needs no credentials, and none are sent. */
async function storeListing(h: ToolHelpers, appId: string, country: string): Promise<Record<string, unknown>> {
  try {
    const { data } = await h.api({ origin: LOOKUP_ORIGIN, path: '/lookup', query: { id: appId, country }, auth: false });
    const result = Array.isArray(data?.results) ? data.results.find((item: any) => String(item?.trackId) === appId) ?? data.results[0] : undefined;
    if (!result) return { country, available: false, note: `The app is not on the App Store in this country (${country.toUpperCase()}), or not released yet.` };
    return trimListing(result, country);
  } catch (error) {
    // The listing is extra: the App Store Connect data is returned without it.
    if (error instanceof ToolFailure) return { country, error: error.message };
    throw error;
  }
}

export async function appMetadata(
  h: ToolHelpers,
  api: Asc,
  args: { app_id: string; locale?: string; country: string; include_store_listing: boolean },
): Promise<Record<string, unknown>> {
  const appId = args.app_id;
  const app = await api.get(`/v1/apps/${appId}`, {
    'fields[apps]': 'name,bundleId,sku,primaryLocale,contentRightsDeclaration,isOrEverWasMadeForKids',
  }, { 404: `App Store Connect has no app ${appId} that this key can see` });
  const a = app?.data?.attributes ?? {};
  const locale = args.locale ?? (typeof a.primaryLocale === 'string' ? a.primaryLocale : 'en-US');
  // The parts after the app's own record are each left out, with a note, when the key's role cannot read them.
  const notes: string[] = [];

  const infos = await optionalPart(notes, 'the app info (subtitle, categories, age rating, privacy policy URL)', () => api.get(`/v1/apps/${appId}/appInfos`, {
    include: 'appInfoLocalizations,primaryCategory,secondaryCategory',
    'fields[appInfos]': 'appStoreState,state,appStoreAgeRating,appInfoLocalizations,primaryCategory,secondaryCategory',
    'fields[appInfoLocalizations]': 'locale,name,subtitle,privacyPolicyUrl',
    'limit[appInfoLocalizations]': 50,
    limit: 5,
  }));
  const infoLocalizations = includedMap(infos, 'appInfoLocalizations');
  const appInfos = infos === undefined
    ? undefined
    : (Array.isArray(infos?.data) ? infos.data : []).map((item: any) => trimAppInfo(item, infoLocalizations, locale));

  const versionsReply = await optionalPart(notes, 'the versions and their texts', () => api.get(`/v1/apps/${appId}/appStoreVersions`, {
    'fields[appStoreVersions]': 'platform,versionString,appStoreState,appVersionState,releaseType,createdDate',
    limit: 5,
  }));
  const versionItems: any[] = Array.isArray(versionsReply?.data) ? versionsReply.data : [];
  const versions = versionsReply === undefined ? undefined : versionItems.map(trimVersion);
  const shown = versionItems.find((item) => LIVE_STATES.has(item?.attributes?.appVersionState) || LIVE_STATES.has(item?.attributes?.appStoreState))
    ?? versionItems[0];
  let versionLocalization: Record<string, unknown> | undefined;
  if (shown?.id) {
    const localizations = await optionalPart(notes, 'the version texts (description, keywords, promotional text, what\'s new)', () => api.get(
      `/v1/appStoreVersions/${encodeURIComponent(shown.id)}/appStoreVersionLocalizations`,
      {
        'filter[locale]': locale,
        'fields[appStoreVersionLocalizations]': 'locale,description,keywords,promotionalText,whatsNew,marketingUrl,supportUrl',
        limit: 1,
      },
    ));
    const l = (Array.isArray(localizations?.data) ? localizations.data[0] : undefined)?.attributes;
    if (localizations !== undefined) {
      versionLocalization = l
        ? compact({
          versionId: shown.id,
          versionString: shown.attributes?.versionString,
          locale: l.locale,
          description: text(l.description, 4000),
          keywords: l.keywords,
          promotionalText: l.promotionalText,
          whatsNew: text(l.whatsNew, 4000),
          marketingUrl: l.marketingUrl,
          supportUrl: l.supportUrl,
        })
        : { versionId: shown.id, locale, note: `The version has no ${locale} localization.` };
    }
  }

  return compact({
    app: compact({
      id: app?.data?.id ?? appId,
      name: a.name,
      bundleId: a.bundleId,
      sku: a.sku,
      primaryLocale: a.primaryLocale,
      contentRightsDeclaration: a.contentRightsDeclaration,
      madeForKids: a.isOrEverWasMadeForKids,
    }),
    appInfos,
    versions,
    versionLocalization,
    storeListing: args.include_store_listing ? await storeListing(h, appId, args.country) : undefined,
    notes: notes.length ? notes : undefined,
  });
}

/** Introductory offers grouped by kind: a free trial of one week in 175 territories is one entry. */
function summarizeOffers(refs: any[], offers: Map<string, any>): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown> & { territories: number }>();
  for (const ref of refs) {
    const offer = offers.get(ref?.id);
    const o = offer?.attributes ?? {};
    const key = [o.offerMode, o.duration, o.numberOfPeriods].join('|');
    const group = groups.get(key) ?? { ...compact({ offerMode: o.offerMode, duration: o.duration, numberOfPeriods: o.numberOfPeriods }), territories: 0 };
    group.territories += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A price list read, or undefined when App Store Connect has no price schedule there (404). */
async function priceList(api: Asc, path: string, query: Record<string, string | number>): Promise<any | undefined> {
  try {
    return await api.get(path, query);
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 404) return undefined;
    throw error;
  }
}

interface PriceRow extends Record<string, unknown> {
  startDate?: string;
  endDate?: string;
}

/** The price in effect today and the later ones already scheduled, from rows with start and end dates. */
function currentAndScheduled(rows: PriceRow[]): Record<string, unknown> | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const started = rows
    .filter((row) => (typeof row.startDate !== 'string' || row.startDate <= today) && (typeof row.endDate !== 'string' || row.endDate > today))
    .sort((a, b) => String(b.startDate ?? '').localeCompare(String(a.startDate ?? '')));
  const later = rows.filter((row) => typeof row.startDate === 'string' && row.startDate > today);
  if (!started.length && !later.length) return undefined;
  return compact({ ...(started[0] ?? {}), scheduled: later.length ? later : undefined });
}

/**
 * A subscription's price in one territory: the one in effect now and any
 * later one already scheduled. A subscription with plans billed differently
 * (planType UPFRONT and MONTHLY) gets the monthly plan's price beside it.
 */
async function subscriptionPrice(api: Asc, subscriptionId: string, territory: string): Promise<Record<string, unknown> | undefined> {
  const reply = await priceList(api, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/prices`, {
    'filter[territory]': territory,
    include: 'subscriptionPricePoint,territory',
    'fields[subscriptionPrices]': 'startDate,planType,subscriptionPricePoint,territory',
    'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
    'fields[territories]': 'currency',
    limit: 20,
  });
  if (!reply) return undefined;
  const points = includedMap(reply, 'subscriptionPricePoints');
  const territories = includedMap(reply, 'territories');
  const rows: PriceRow[] = (Array.isArray(reply?.data) ? reply.data : []).map((item: any) => {
    const point = points.get(item?.relationships?.subscriptionPricePoint?.data?.id);
    const place = territories.get(item?.relationships?.territory?.data?.id);
    return compact({
      customerPrice: point?.attributes?.customerPrice,
      proceeds: point?.attributes?.proceeds,
      currency: place?.attributes?.currency,
      territory: item?.relationships?.territory?.data?.id ?? territory,
      planType: item?.attributes?.planType,
      startDate: item?.attributes?.startDate ?? undefined,
    }) as PriceRow;
  });
  const monthly = rows.filter((row) => row['planType'] === 'MONTHLY');
  const price = currentAndScheduled(rows.filter((row) => row['planType'] !== 'MONTHLY'));
  const monthlyPrice = monthly.length ? currentAndScheduled(monthly) : undefined;
  if (!price && !monthlyPrice) return undefined;
  return compact({ ...(price ?? {}), monthlyPlan: monthlyPrice });
}

/**
 * A one-time purchase's price in one territory. A price set by hand is in the
 * purchase's manual prices; one App Store Connect derived from the base
 * territory (equalized) is in its automatic prices, read when there is none.
 */
export async function purchasePrice(api: Asc, purchaseId: string, territory: string): Promise<Record<string, unknown> | undefined> {
  for (const kind of ['manualPrices', 'automaticPrices'] as const) {
    const reply = await priceList(api, `/v1/inAppPurchasePriceSchedules/${encodeURIComponent(purchaseId)}/${kind}`, {
      'filter[territory]': territory,
      include: 'inAppPurchasePricePoint,territory',
      'fields[inAppPurchasePrices]': 'startDate,endDate,inAppPurchasePricePoint,territory',
      'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
      'fields[territories]': 'currency',
      limit: 20,
    });
    if (!reply) return undefined;
    const points = includedMap(reply, 'inAppPurchasePricePoints');
    const territories = includedMap(reply, 'territories');
    const rows: PriceRow[] = (Array.isArray(reply?.data) ? reply.data : []).map((item: any) => {
      const point = points.get(item?.relationships?.inAppPurchasePricePoint?.data?.id);
      const place = territories.get(item?.relationships?.territory?.data?.id);
      return compact({
        customerPrice: point?.attributes?.customerPrice,
        proceeds: point?.attributes?.proceeds,
        currency: place?.attributes?.currency,
        territory: item?.relationships?.territory?.data?.id ?? territory,
        startDate: item?.attributes?.startDate ?? undefined,
        endDate: item?.attributes?.endDate ?? undefined,
      }) as PriceRow;
    });
    const price = currentAndScheduled(rows);
    if (price) return compact({ ...price, automatic: kind === 'automaticPrices' ? true : undefined });
  }
  return undefined;
}

/** How many subscriptions App Store Connect returns per page of a group. */
const GROUP_PAGE = 50;
/** How many groups the result names. */
const GROUPS_SHOWN = 50;

interface Position extends Record<string, string | number> {
  /** The group's index. */
  g: number;
  /** The item's index on its page. */
  o: number;
}

export interface SubscriptionArgs {
  app_id: string;
  group_id?: string;
  price_territory: string;
  include_prices: boolean;
  limit: number;
  cursor?: string;
}

/**
 * An app's subscriptions, group after group, `limit` at a time with their
 * prices and introductory offers. The cursor names the group, Apple's page in
 * it and the place on that page, so a result cut to fit continues right after
 * its last subscription.
 */
export async function subscriptions(h: ToolHelpers, api: Asc, args: SubscriptionArgs): Promise<Record<string, unknown>> {
  const appId = args.app_id;
  const territory = args.include_prices ? args.price_territory : undefined;
  const groupsReply = await api.get(
    `/v1/apps/${appId}/subscriptionGroups`,
    { 'fields[subscriptionGroups]': 'referenceName', limit: 200 },
    { 403: roleRefusal("the app's subscriptions") },
  );
  const allGroups: Array<{ id: string; referenceName?: string }> = (Array.isArray(groupsReply?.data) ? groupsReply.data : [])
    .filter((group: any) => typeof group?.id === 'string')
    .map((group: any) => ({ id: group.id, referenceName: group?.attributes?.referenceName }));
  const moreGroups = Boolean(nextAppleCursor(groupsReply));
  const groups = args.group_id ? allGroups.filter((group) => group.id === args.group_id) : allGroups;
  if (args.group_id && !groups.length) {
    throw new ToolFailure(`App ${appId} has no subscription group ${args.group_id}${moreGroups ? ' among its first 200' : ''}. list_subscriptions without group_id names its groups.`);
  }

  const state = h.cursor(args.cursor);
  let g = typeof state?.['g'] === 'number' ? state['g'] : 0;
  let c = typeof state?.['c'] === 'string' ? state['c'] : undefined;
  let o = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const items: Array<Record<string, unknown>> = [];
  const positions: Position[] = [];
  let next: Position | undefined;
  let freeTrial = false;
  while (g < groups.length) {
    const group = groups[g] as { id: string; referenceName?: string };
    const reply = await api.get(`/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions`, {
      'fields[subscriptions]': 'name,productId,subscriptionPeriod,state,groupLevel,familySharable,introductoryOffers',
      include: 'introductoryOffers',
      'fields[subscriptionIntroductoryOffers]': 'duration,offerMode,numberOfPeriods',
      'limit[introductoryOffers]': 50,
      limit: GROUP_PAGE,
      ...(c ? { cursor: c } : {}),
    });
    const offers = includedMap(reply, 'subscriptionIntroductoryOffers');
    const page: any[] = Array.isArray(reply?.data) ? reply.data : [];
    const appleNext = nextAppleCursor(reply);
    let index = o;
    for (; index < page.length && items.length < args.limit; index++) {
      const item = page[index];
      const s = item?.attributes ?? {};
      const refs: any[] = Array.isArray(item?.relationships?.introductoryOffers?.data) ? item.relationships.introductoryOffers.data : [];
      const introductoryOffers = summarizeOffers(refs, offers);
      if (introductoryOffers.some((offer) => offer['offerMode'] === 'FREE_TRIAL')) freeTrial = true;
      positions.push({ g, ...(c ? { c } : {}), o: index });
      items.push(compact({
        groupId: group.id,
        id: item?.id,
        name: s.name,
        productId: s.productId,
        period: s.subscriptionPeriod,
        state: s.state,
        groupLevel: s.groupLevel,
        familySharable: s.familySharable,
        price: territory && typeof item?.id === 'string' ? await subscriptionPrice(api, item.id, territory) : undefined,
        introductoryOffers,
      }));
    }
    if (items.length >= args.limit) {
      if (index < page.length) next = { g, ...(c ? { c } : {}), o: index };
      else if (appleNext) next = { g, c: appleNext, o: 0 };
      else if (g + 1 < groups.length) next = { g: g + 1, o: 0 };
      break;
    }
    if (appleNext) {
      c = appleNext;
    } else {
      g += 1;
      c = undefined;
    }
    o = 0;
  }

  const notes = [
    moreGroups && !args.group_id ? 'The app has more than 200 subscription groups; the first 200 are read.' : undefined,
    groups.length > GROUPS_SHOWN ? `The first ${GROUPS_SHOWN} of ${groups.length} groups are named in groups.` : undefined,
    next ? 'hasFreeTrial covers the subscriptions on this page: pass nextCursor back as cursor for the rest.' : undefined,
  ].filter(Boolean);
  return h.page({
    key: 'subscriptions',
    items,
    extra: compact({
      appId,
      priceTerritory: territory,
      hasFreeTrial: freeTrial,
      groups: groups.slice(0, GROUPS_SHOWN).map((group) => compact({ id: group.id, referenceName: group.referenceName })),
      note: notes.length ? notes.join(' ') : undefined,
    }),
    resumeAt: (index) => h.makeCursor(positions[index] ?? { g: groups.length, o: 0 }),
    ...(next ? { nextPage: h.makeCursor(next) } : {}),
  });
}
