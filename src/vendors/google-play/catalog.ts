import { truncate } from '../../core/index.js';

// Trimming of Google Play reviews, store listings, subscriptions and in-app
// products: the fields an agent needs, prices in one region, free trials.

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/** A Google Timestamp ({ seconds, nanos }) as ISO text. */
export function isoTime(stamp: any): string | undefined {
  const seconds = Number(stamp?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/^\t+/, '').trim() : undefined;
}

export function trimReview(review: any): Record<string, unknown> {
  const comments: any[] = Array.isArray(review?.comments) ? review.comments : [];
  const user = comments.find((comment) => comment?.userComment)?.userComment;
  const developer = comments.find((comment) => comment?.developerComment)?.developerComment;
  return compact({
    reviewId: review?.reviewId,
    author: review?.authorName,
    rating: user?.starRating,
    text: cleanText(user?.text),
    originalText: cleanText(user?.originalText),
    language: user?.reviewerLanguage,
    modifiedAt: isoTime(user?.lastModified),
    appVersion: user?.appVersionName,
    appVersionCode: user?.appVersionCode,
    device: user?.deviceMetadata?.productName ?? user?.device,
    androidOsVersion: user?.androidOsVersion,
    thumbsUp: user?.thumbsUpCount,
    thumbsDown: user?.thumbsDownCount,
    replied: Boolean(developer),
    reply: developer ? compact({ text: cleanText(developer.text), modifiedAt: isoTime(developer.lastModified) }) : undefined,
  });
}

export function trimListing(listing: any): Record<string, unknown> {
  return compact({
    language: listing?.language,
    title: listing?.title,
    shortDescription: listing?.shortDescription,
    fullDescription: listing?.fullDescription,
    video: listing?.video,
  });
}

/** A Google Money ({ currencyCode, units, nanos }) as { amount: "8.99", currency: "USD" }. */
export function money(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || typeof value.currencyCode !== 'string') return undefined;
  const amount = Number(value.units ?? 0) + Number(value.nanos ?? 0) / 1e9;
  return Number.isFinite(amount) ? { amount: amount.toFixed(2), currency: value.currencyCode } : undefined;
}

/** The price in one region of a list of regional configs, else the first one's. */
function regionalPrice(configs: unknown, region: string, priceKey = 'price'): Record<string, unknown> | undefined {
  const list: any[] = Array.isArray(configs) ? configs : [];
  const config = list.find((item) => item?.regionCode === region) ?? list[0];
  const price = money(config?.[priceKey]);
  return price ? { region: config?.regionCode, ...price } : undefined;
}

function phaseOf(phase: any, region: string): Record<string, unknown> {
  const configs: any[] = Array.isArray(phase?.regionalConfigs) ? phase.regionalConfigs : [];
  const config = configs.find((item) => item?.regionCode === region) ?? configs[0];
  const free = Boolean(config?.free) || Boolean(phase?.otherRegionsConfig?.free);
  return compact({
    duration: phase?.duration,
    recurrenceCount: phase?.recurrenceCount,
    free: free ? true : undefined,
    price: free ? undefined : money(config?.price),
    relativeDiscount: free ? undefined : config?.relativeDiscount,
  });
}

/** Offers of the app grouped by "productId/basePlanId". */
export function offersByBasePlan(offers: any[], region: string): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const offer of offers) {
    const key = `${offer?.productId}/${offer?.basePlanId}`;
    const phases: any[] = Array.isArray(offer?.phases) ? offer.phases : [];
    const trimmed = phases.map((phase) => phaseOf(phase, region));
    const trial = trimmed.find((phase) => phase['free'] === true);
    const list = grouped.get(key) ?? [];
    list.push(compact({
      offerId: offer?.offerId,
      state: offer?.state,
      offerTags: Array.isArray(offer?.offerTags) ? offer.offerTags.map((tag: any) => tag?.tag).filter(Boolean) : undefined,
      phases: trimmed,
      freeTrial: trial ? trial['duration'] : undefined,
    }));
    grouped.set(key, list);
  }
  return grouped;
}

function basePlanType(plan: any): string | undefined {
  if (plan?.autoRenewingBasePlanType) return 'auto_renewing';
  if (plan?.prepaidBasePlanType) return 'prepaid';
  if (plan?.installmentsBasePlanType) return 'installments';
  return undefined;
}

export function trimSubscription(subscription: any, region: string, offers?: Map<string, Array<Record<string, unknown>>>): Record<string, unknown> {
  const listings: any[] = Array.isArray(subscription?.listings) ? subscription.listings : [];
  const plans: any[] = Array.isArray(subscription?.basePlans) ? subscription.basePlans : [];
  let hasFreeTrial = false;
  const basePlans = plans.map((plan) => {
    const kind = plan?.autoRenewingBasePlanType ?? plan?.prepaidBasePlanType ?? plan?.installmentsBasePlanType;
    const planOffers = offers?.get(`${subscription?.productId}/${plan?.basePlanId}`);
    if (plan?.state === 'ACTIVE' && planOffers?.some((offer) => offer['state'] === 'ACTIVE' && offer['freeTrial'])) hasFreeTrial = true;
    return compact({
      basePlanId: plan?.basePlanId,
      state: plan?.state,
      type: basePlanType(plan),
      billingPeriod: kind?.billingPeriodDuration,
      gracePeriod: plan?.autoRenewingBasePlanType?.gracePeriodDuration,
      offerTags: Array.isArray(plan?.offerTags) ? plan.offerTags.map((tag: any) => tag?.tag).filter(Boolean) : undefined,
      price: regionalPrice(plan?.regionalConfigs, region),
      regions: Array.isArray(plan?.regionalConfigs) ? plan.regionalConfigs.length : undefined,
      offers: planOffers,
    });
  });
  return compact({
    productId: subscription?.productId,
    listings: listings.slice(0, 8).map((listing) => compact({
      language: listing?.languageCode,
      title: listing?.title,
      description: typeof listing?.description === 'string' ? truncate(listing.description, 300) : undefined,
      benefits: Array.isArray(listing?.benefits) ? listing.benefits.slice(0, 4) : undefined,
    })),
    languages: listings.length > 8 ? listings.length : undefined,
    basePlans,
    hasFreeTrial: offers ? hasFreeTrial : undefined,
  });
}

export function trimInAppProduct(product: any, region: string): Record<string, unknown> {
  const listings = product?.listings && typeof product.listings === 'object' ? product.listings : {};
  const languages = Object.keys(listings);
  const listing = listings[product?.defaultLanguage] ?? listings[languages[0] as string];
  const micros = Number(product?.defaultPrice?.priceMicros);
  const regional = product?.prices?.[region];
  const regionalMicros = Number(regional?.priceMicros);
  return compact({
    sku: product?.sku,
    status: product?.status,
    purchaseType: product?.purchaseType,
    title: listing?.title,
    description: typeof listing?.description === 'string' ? truncate(listing.description, 300) : undefined,
    defaultLanguage: product?.defaultLanguage,
    languages: languages.length,
    price: Number.isFinite(micros) ? { amount: (micros / 1e6).toFixed(2), currency: product?.defaultPrice?.currency } : undefined,
    regionPrice: Number.isFinite(regionalMicros) ? { region, amount: (regionalMicros / 1e6).toFixed(2), currency: regional?.currency } : undefined,
  });
}

export function trimOneTimeProduct(product: any, region: string): Record<string, unknown> {
  const listings: any[] = Array.isArray(product?.listings) ? product.listings : [];
  const options: any[] = Array.isArray(product?.purchaseOptions) ? product.purchaseOptions : [];
  return compact({
    productId: product?.productId,
    title: listings[0]?.title,
    description: typeof listings[0]?.description === 'string' ? truncate(listings[0].description, 300) : undefined,
    languages: listings.length,
    offerTags: Array.isArray(product?.offerTags) ? product.offerTags.map((tag: any) => tag?.tag).filter(Boolean) : undefined,
    purchaseOptions: options.slice(0, 10).map((option) => compact({
      purchaseOptionId: option?.purchaseOptionId,
      state: option?.state,
      type: option?.buyOption ? 'buy' : option?.rentOption ? 'rent' : undefined,
      price: regionalPrice(option?.regionalPricingAndAvailabilityConfigs, region),
    })),
  });
}
