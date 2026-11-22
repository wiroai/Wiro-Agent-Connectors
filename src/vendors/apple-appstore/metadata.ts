// What an app is and sells: its App Store Connect record, app info and version
// texts, its live listing from the public lookup, and its subscriptions with
// their introductory offers.

import { ToolFailure, type ToolHelpers } from '../../core/index.js';
import { compact, includedMap, LOOKUP_ORIGIN, nextAppleCursor, text, type Asc } from './client.js';

/** Version states that mean the version is the one on the App Store. */
const LIVE_STATES = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
const MAX_GROUPS = 10;

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

  const infos = await api.get(`/v1/apps/${appId}/appInfos`, {
    include: 'appInfoLocalizations,primaryCategory,secondaryCategory',
    'fields[appInfos]': 'appStoreState,state,appStoreAgeRating,appInfoLocalizations,primaryCategory,secondaryCategory',
    'fields[appInfoLocalizations]': 'locale,name,subtitle,privacyPolicyUrl',
    'limit[appInfoLocalizations]': 50,
    limit: 5,
  });
  const infoLocalizations = includedMap(infos, 'appInfoLocalizations');
  const appInfos = (Array.isArray(infos?.data) ? infos.data : []).map((item: any) => trimAppInfo(item, infoLocalizations, locale));

  const versionsReply = await api.get(`/v1/apps/${appId}/appStoreVersions`, {
    'fields[appStoreVersions]': 'platform,versionString,appStoreState,appVersionState,releaseType,createdDate',
    limit: 5,
  });
  const versionItems: any[] = Array.isArray(versionsReply?.data) ? versionsReply.data : [];
  const versions = versionItems.map(trimVersion);
  const shown = versionItems.find((item) => LIVE_STATES.has(item?.attributes?.appVersionState) || LIVE_STATES.has(item?.attributes?.appStoreState))
    ?? versionItems[0];
  let versionLocalization: Record<string, unknown> | undefined;
  if (shown?.id) {
    const localizations = await api.get(`/v1/appStoreVersions/${encodeURIComponent(shown.id)}/appStoreVersionLocalizations`, {
      'filter[locale]': locale,
      'fields[appStoreVersionLocalizations]': 'locale,description,keywords,promotionalText,whatsNew,marketingUrl,supportUrl',
      limit: 1,
    });
    const l = (Array.isArray(localizations?.data) ? localizations.data[0] : undefined)?.attributes;
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

export async function subscriptions(api: Asc, appId: string): Promise<Record<string, unknown>> {
  const groupsReply = await api.get(`/v1/apps/${appId}/subscriptionGroups`, { 'fields[subscriptionGroups]': 'referenceName', limit: 50 });
  const groupItems: any[] = Array.isArray(groupsReply?.data) ? groupsReply.data : [];
  const groups: Array<Record<string, unknown>> = [];
  let freeTrial = false;
  for (const group of groupItems.slice(0, MAX_GROUPS)) {
    const reply = await api.get(`/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions`, {
      'fields[subscriptions]': 'name,productId,subscriptionPeriod,state,groupLevel,familySharable,introductoryOffers',
      include: 'introductoryOffers',
      'fields[subscriptionIntroductoryOffers]': 'duration,offerMode,numberOfPeriods',
      'limit[introductoryOffers]': 50,
      limit: 50,
    });
    const offers = includedMap(reply, 'subscriptionIntroductoryOffers');
    const items = (Array.isArray(reply?.data) ? reply.data : []).map((item: any) => {
      const s = item?.attributes ?? {};
      const refs: any[] = Array.isArray(item?.relationships?.introductoryOffers?.data) ? item.relationships.introductoryOffers.data : [];
      const introductoryOffers = summarizeOffers(refs, offers);
      if (introductoryOffers.some((offer) => offer['offerMode'] === 'FREE_TRIAL')) freeTrial = true;
      return compact({
        id: item?.id,
        name: s.name,
        productId: s.productId,
        period: s.subscriptionPeriod,
        state: s.state,
        groupLevel: s.groupLevel,
        familySharable: s.familySharable,
        introductoryOffers,
      });
    });
    groups.push(compact({
      id: group.id,
      referenceName: group?.attributes?.referenceName,
      subscriptions: items,
      ...(nextAppleCursor(reply) ? { note: 'The group has more than 50 subscriptions; the first 50 are shown.' } : {}),
    }));
  }
  return compact({
    appId,
    hasFreeTrial: freeTrial,
    groups,
    note: groupItems.length > MAX_GROUPS || nextAppleCursor(groupsReply)
      ? `The app has more than ${MAX_GROUPS} subscription groups; the first ${MAX_GROUPS} are shown. Read the others with api_get.`
      : undefined,
  });
}
