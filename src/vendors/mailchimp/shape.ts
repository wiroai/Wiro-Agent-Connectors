// Trimming and paging helpers for the Mailchimp connector. Mailchimp replies
// carry `_links` everywhere; results leave them out and keep Mailchimp's own
// field names otherwise.

import { truncate, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

/** Drops undefined, null and empty-string values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/** A copy without Mailchimp's `_links` lists, at any depth. */
export function stripLinks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLinks);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (key !== '_links') out[key] = stripLinks(item);
    return out;
  }
  return value;
}

const HTML_LIMIT = 20_000;

export function html(text: unknown): string | undefined {
  return typeof text === 'string' && text ? truncate(text, HTML_LIMIT) : undefined;
}

function nonEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value : undefined;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length ? value : undefined;
  return value;
}

export function trimAudience(list: any): Record<string, unknown> {
  const stats = list?.stats ?? {};
  return compact({
    id: list?.id,
    web_id: list?.web_id,
    name: list?.name,
    date_created: list?.date_created,
    double_optin: list?.double_optin,
    subscribe_url_short: list?.subscribe_url_short,
    campaign_defaults: list?.campaign_defaults,
    stats: compact({
      member_count: stats.member_count,
      unsubscribe_count: stats.unsubscribe_count,
      cleaned_count: stats.cleaned_count,
      member_count_since_send: stats.member_count_since_send,
      campaign_count: stats.campaign_count,
      campaign_last_sent: stats.campaign_last_sent,
      open_rate: stats.open_rate,
      click_rate: stats.click_rate,
      avg_sub_rate: stats.avg_sub_rate,
      avg_unsub_rate: stats.avg_unsub_rate,
      last_sub_date: stats.last_sub_date,
      last_unsub_date: stats.last_unsub_date,
    }),
  });
}

export function trimMember(member: any): Record<string, unknown> {
  return compact({
    id: member?.id,
    email_address: member?.email_address,
    status: member?.status,
    full_name: member?.full_name,
    merge_fields: nonEmpty(member?.merge_fields),
    tags: Array.isArray(member?.tags) && member.tags.length ? member.tags.map((tag: any) => tag?.name) : undefined,
    interests: nonEmpty(member?.interests),
    vip: member?.vip,
    language: member?.language,
    member_rating: member?.member_rating,
    source: member?.source,
    timestamp_signup: member?.timestamp_signup,
    timestamp_opt: member?.timestamp_opt,
    last_changed: member?.last_changed,
    unsubscribe_reason: member?.unsubscribe_reason,
    avg_open_rate: member?.stats?.avg_open_rate,
    avg_click_rate: member?.stats?.avg_click_rate,
    country_code: member?.location?.country_code,
    list_id: member?.list_id,
  });
}

export function trimCampaign(campaign: any): Record<string, unknown> {
  const settings = campaign?.settings ?? {};
  const recipients = campaign?.recipients ?? {};
  const summary = campaign?.report_summary;
  return compact({
    id: campaign?.id,
    web_id: campaign?.web_id,
    type: campaign?.type,
    status: campaign?.status,
    create_time: campaign?.create_time,
    send_time: campaign?.send_time,
    emails_sent: campaign?.emails_sent,
    content_type: campaign?.content_type,
    archive_url: campaign?.long_archive_url ?? campaign?.archive_url,
    recipients: compact({
      list_id: recipients.list_id,
      list_name: recipients.list_name,
      segment_text: typeof recipients.segment_text === 'string' && recipients.segment_text ? truncate(recipients.segment_text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 300) : undefined,
      recipient_count: recipients.recipient_count,
      saved_segment_id: recipients.segment_opts?.saved_segment_id,
    }),
    settings: compact({
      subject_line: settings.subject_line,
      preview_text: settings.preview_text,
      title: settings.title,
      from_name: settings.from_name,
      reply_to: settings.reply_to,
      to_name: settings.to_name,
      template_id: settings.template_id,
    }),
    report_summary: summary
      ? compact({
        opens: summary.opens,
        unique_opens: summary.unique_opens,
        open_rate: summary.open_rate,
        clicks: summary.clicks,
        subscriber_clicks: summary.subscriber_clicks,
        click_rate: summary.click_rate,
      })
      : undefined,
  });
}

export function trimReport(report: any): Record<string, unknown> {
  return compact({
    id: report?.id,
    campaign_title: report?.campaign_title,
    type: report?.type,
    list_id: report?.list_id,
    list_name: report?.list_name,
    subject_line: report?.subject_line,
    preview_text: report?.preview_text,
    send_time: report?.send_time,
    emails_sent: report?.emails_sent,
    abuse_reports: report?.abuse_reports,
    unsubscribed: report?.unsubscribed,
    bounces: report?.bounces,
    forwards: report?.forwards,
    opens: report?.opens,
    clicks: report?.clicks,
    list_stats: report?.list_stats,
    ecommerce: report?.ecommerce && Object.values(report.ecommerce).some((value) => value) ? report.ecommerce : undefined,
  });
}

export interface OffsetListOptions {
  /** The result field that holds the list, and Mailchimp's field for it unless listField says otherwise. */
  key: string;
  listField?: string;
  path: string;
  query?: ApiRequest['query'];
  count: number;
  trim(item: any): unknown;
  extra?(data: any): Record<string, unknown>;
}

/**
 * One page of a Mailchimp list (count, offset and total_items). The cursor
 * carries the offset, the page size and how many items of the page were
 * already returned when the 32 KB limit cut it.
 */
export async function offsetList(
  h: ToolHelpers,
  send: (request: ApiRequest) => Promise<ApiResponse>,
  cursor: string | undefined,
  options: OffsetListOptions,
): Promise<Record<string, unknown>> {
  const state = h.cursor(cursor);
  const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const count = typeof state?.['n'] === 'number' ? state['n'] : options.count;
  const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
  const field = options.listField ?? options.key;
  const { data } = await send({ path: options.path, query: { ...options.query, count, offset, exclude_fields: `_links,${field}._links` } });
  const items: unknown[] = Array.isArray(data?.[field]) ? data[field] : [];
  const total = typeof data?.total_items === 'number' ? data.total_items : undefined;
  const more = total !== undefined ? offset + items.length < total : items.length >= count;
  return h.page({
    key: options.key,
    items: items.map(options.trim).slice(skip),
    extra: { ...(total !== undefined ? { total_items: total } : {}), ...options.extra?.(data) },
    resumeAt: (index) => h.makeCursor({ o: offset, n: count, s: skip + index }),
    ...(more && items.length ? { nextPage: h.makeCursor({ o: offset + count, n: count, s: 0 }) } : {}),
  });
}
