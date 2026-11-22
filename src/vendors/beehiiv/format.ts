// Trimming helpers for the beehiiv connector: dates from Unix seconds, posts
// with their email and web numbers, subscriptions, and the smaller lists.

import { truncate, utf8Length } from '../../core/index.js';

/** Drops undefined and null fields. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/** An ISO date from beehiiv's Unix seconds. */
export function isoDate(value: unknown): string | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** A share of delivered emails, in percent with one decimal. */
function share(part: unknown, whole: unknown): number | undefined {
  if (typeof part !== 'number' || typeof whole !== 'number' || whole <= 0) return undefined;
  return Math.round((part / whole) * 1000) / 10;
}

/** A post's email and web numbers, with unique opens and clicks as a share of delivered emails. */
export function postStats(stats: any): Record<string, unknown> | undefined {
  if (!stats || typeof stats !== 'object') return undefined;
  const email = stats.email ?? {};
  const web = stats.web ?? {};
  const out = compact({
    email: Object.keys(email).length
      ? compact({
        recipients: email.recipients,
        delivered: email.delivered,
        opens: email.opens,
        unique_opens: email.unique_opens,
        unique_open_share_pct: share(email.unique_opens, email.delivered),
        clicks: email.clicks,
        unique_clicks: email.unique_clicks,
        unique_click_share_pct: share(email.unique_clicks, email.delivered),
        unique_verified_clicks: email.unique_verified_clicks,
        unsubscribes: email.unsubscribes,
        spam_reports: email.spam_reports,
        beehiiv_open_rate: email.open_rate,
        beehiiv_click_rate: email.click_rate,
      })
      : undefined,
    web: Object.keys(web).length ? compact({ views: web.views, clicks: web.clicks }) : undefined,
    upgrades: stats.upgrades,
  });
  return Object.keys(out).length ? out : undefined;
}

/** The links with the most unique clicks, at most ten. */
export function topLinks(stats: any): Array<Record<string, unknown>> | undefined {
  const clicks: any[] = Array.isArray(stats?.clicks) ? stats.clicks : [];
  if (!clicks.length) return undefined;
  return [...clicks]
    .sort((a, b) => (b?.total_unique_clicks ?? 0) - (a?.total_unique_clicks ?? 0))
    .slice(0, 10)
    .map((link) => compact({
      url: typeof (link?.url ?? link?.base_url) === 'string' ? truncate(link.url ?? link.base_url, 500) : undefined,
      unique_clicks: link?.total_unique_clicks,
      email_unique_clicks: link?.email?.unique_clicks,
      web_unique_clicks: link?.web?.unique_clicks,
    }));
}

/** A post in a list or after a write. */
export function trimPost(post: any): Record<string, unknown> {
  return compact({
    id: post?.id,
    title: typeof post?.title === 'string' ? truncate(post.title, 300) : undefined,
    subtitle: typeof post?.subtitle === 'string' && post.subtitle ? truncate(post.subtitle, 300) : undefined,
    status: post?.status,
    audience: post?.audience,
    platform: post?.platform,
    publish_date: isoDate(post?.publish_date),
    created: isoDate(post?.created),
    subject_line: typeof post?.subject_line === 'string' && post.subject_line ? truncate(post.subject_line, 300) : undefined,
    preview_text: typeof post?.preview_text === 'string' && post.preview_text ? truncate(post.preview_text, 300) : undefined,
    web_url: post?.web_url || undefined,
    preview_url: post?.preview_url || undefined,
    content_tags: Array.isArray(post?.content_tags) && post.content_tags.length ? post.content_tags : undefined,
    hidden_from_feed: post?.hidden_from_feed === true ? true : undefined,
    stats: postStats(post?.stats),
  });
}

/** A subscription: who, its status and tier, tags, custom fields, UTM source and email numbers. */
export function trimSubscription(subscription: any): Record<string, unknown> {
  const fields = Array.isArray(subscription?.custom_fields)
    ? Object.fromEntries(subscription.custom_fields.map((item: any) => [String(item?.name ?? item?.display ?? ''), item?.value ?? null]))
    : undefined;
  return compact({
    id: subscription?.id,
    email: subscription?.email,
    status: subscription?.status,
    created: isoDate(subscription?.created),
    tier: subscription?.subscription_tier,
    premium_tiers: Array.isArray(subscription?.subscription_premium_tier_names) && subscription.subscription_premium_tier_names.length
      ? subscription.subscription_premium_tier_names
      : undefined,
    utm_source: subscription?.utm_source || undefined,
    utm_medium: subscription?.utm_medium || undefined,
    utm_campaign: subscription?.utm_campaign || undefined,
    referring_site: subscription?.referring_site || undefined,
    tags: Array.isArray(subscription?.tags) ? subscription.tags : undefined,
    custom_fields: fields && Object.keys(fields).length ? fields : undefined,
    stats: subscription?.stats && typeof subscription.stats === 'object'
      ? compact({ emails_received: subscription.stats.emails_received, open_rate: subscription.stats.open_rate, click_through_rate: subscription.stats.click_through_rate })
      : undefined,
  });
}

/** One item of a smaller list, by what the list holds. */
export function trimResource(kind: string, item: any): Record<string, unknown> {
  switch (kind) {
    case 'segments':
      return compact({
        id: item?.id,
        name: item?.name,
        type: item?.type,
        subscribers: item?.total_results,
        status: item?.status,
        active: item?.active,
        last_calculated: isoDate(item?.last_calculated),
      });
    case 'automations': {
      const triggers: string[] = Array.isArray(item?.trigger_events) ? item.trigger_events.map(String) : [];
      return compact({ id: item?.id, name: item?.name, status: item?.status, triggers, add_by_api: triggers.includes('api') });
    }
    case 'custom_fields':
      return compact({ id: item?.id, name: item?.display ?? item?.name, kind: item?.kind, options: Array.isArray(item?.options) && item.options.length ? item.options : undefined });
    case 'tiers':
      return compact({ id: item?.id, name: item?.name, status: item?.status, description: typeof item?.description === 'string' && item.description ? truncate(item.description, 300) : undefined });
    default:
      return compact({ id: item?.id, name: item?.name });
  }
}

/** The room a window of long text may take in a result, in UTF-8 bytes of its JSON form. */
export const TEXT_WINDOW_BYTES = 24_000;

/**
 * A window of a long text that fits `budget` bytes once JSON-encoded, starting
 * at `offset`. It ends at a line break when one is near, never inside a
 * character, and says where the next window starts.
 */
export function textWindow(text: string, offset: number, budget = TEXT_WINDOW_BYTES): { text: string; offset: number; next?: number } {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const rest = text.length - start;
  const size = (count: number): number => utf8Length(JSON.stringify(text.slice(start, start + count)));
  let count = Math.min(rest, budget);
  if (size(count) > budget) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(middle) <= budget) low = middle;
      else high = middle - 1;
    }
    count = low;
  }
  if (count < rest) {
    const lineBreak = text.lastIndexOf('\n', start + count - 1);
    if (lineBreak >= start + Math.floor(count / 2)) count = lineBreak + 1 - start;
    const code = text.charCodeAt(start + count - 1);
    if (code >= 0xd800 && code <= 0xdbff) count -= 1;
  }
  const end = start + Math.max(count, 0);
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { next: end } : {}) };
}
