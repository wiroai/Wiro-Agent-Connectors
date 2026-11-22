// Trimming and paging helpers for the Brevo connector: results keep Brevo's
// own field names, minus what an agent does not need (long HTML, empty values).

import { truncate, type ToolHelpers } from '../../core/index.js';

/** Drops undefined, null and empty-string values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

const HTML_LIMIT = 20_000;

/** An HTML body, cut to a size that leaves room for the rest of a result. */
export function html(text: unknown): string | undefined {
  return typeof text === 'string' && text ? truncate(text, HTML_LIMIT) : undefined;
}

export function trimContact(contact: any): Record<string, unknown> {
  return compact({
    id: contact?.id,
    email: contact?.email,
    attributes: contact?.attributes && Object.keys(contact.attributes).length ? contact.attributes : undefined,
    listIds: Array.isArray(contact?.listIds) && contact.listIds.length ? contact.listIds : undefined,
    listUnsubscribed: Array.isArray(contact?.listUnsubscribed) && contact.listUnsubscribed.length ? contact.listUnsubscribed : undefined,
    emailBlacklisted: contact?.emailBlacklisted,
    smsBlacklisted: contact?.smsBlacklisted,
    createdAt: contact?.createdAt,
    modifiedAt: contact?.modifiedAt,
  });
}

/** A contact's statistics as counts per kind (each kind is a list of events in Brevo's reply). */
export function statisticCounts(statistics: any): Record<string, number> | undefined {
  if (typeof statistics !== 'object' || statistics === null) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(statistics)) {
    if (Array.isArray(value)) counts[key] = value.length;
    else if (typeof value === 'object' && value !== null) counts[key] = Object.keys(value).length;
  }
  return Object.keys(counts).length ? counts : undefined;
}

export function trimCampaign(campaign: any, options: { html?: boolean } = {}): Record<string, unknown> {
  const statistics = campaign?.statistics;
  return compact({
    id: campaign?.id,
    name: campaign?.name,
    subject: campaign?.subject,
    previewText: campaign?.previewText,
    status: campaign?.status,
    type: campaign?.type,
    tag: campaign?.tag,
    scheduledAt: campaign?.scheduledAt,
    sentDate: campaign?.sentDate,
    createdAt: campaign?.createdAt,
    modifiedAt: campaign?.modifiedAt,
    sender: campaign?.sender,
    replyTo: campaign?.replyTo,
    toField: campaign?.toField,
    recipients: campaign?.recipients,
    testSent: campaign?.testSent,
    shareLink: campaign?.shareLink,
    globalStats: statistics?.globalStats && Object.keys(statistics.globalStats).length ? statistics.globalStats : undefined,
    htmlContent: options.html ? html(campaign?.htmlContent) : undefined,
  });
}

export function trimTemplate(template: any, options: { html?: boolean } = {}): Record<string, unknown> {
  return compact({
    id: template?.id,
    name: template?.name,
    subject: template?.subject,
    isActive: template?.isActive,
    testSent: template?.testSent,
    tag: template?.tag,
    sender: template?.sender,
    replyTo: template?.replyTo,
    toField: template?.toField,
    doiTemplate: template?.doiTemplate,
    createdAt: template?.createdAt,
    modifiedAt: template?.modifiedAt,
    htmlContent: options.html ? html(template?.htmlContent) : undefined,
  });
}

export interface OffsetListOptions {
  /** The result field that holds the list, e.g. "contacts". */
  key: string;
  path: string;
  query?: Record<string, string | number | boolean | ReadonlyArray<string | number> | undefined>;
  /** Items per page as the tool's arguments asked. */
  limit: number;
  /** Brevo's field that holds the list, when it differs from key. */
  listField?: string;
  trim(item: any): unknown;
  extra?(data: any): Record<string, unknown>;
}

/**
 * One page of a Brevo list that pages with limit and offset and reports a
 * total in `count`. The cursor carries the offset, the page size and how many
 * items of the page were already returned when the 32 KB limit cut it.
 */
export async function offsetList(h: ToolHelpers, cursor: string | undefined, options: OffsetListOptions): Promise<Record<string, unknown>> {
  const state = h.cursor(cursor);
  const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const limit = typeof state?.['n'] === 'number' ? state['n'] : options.limit;
  const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
  const { data } = await h.api({ path: options.path, query: { ...options.query, limit, offset } });
  const items: unknown[] = Array.isArray(data?.[options.listField ?? options.key]) ? data[options.listField ?? options.key] : [];
  const total = typeof data?.count === 'number' ? data.count : undefined;
  const more = total !== undefined ? offset + items.length < total : items.length >= limit;
  return h.page({
    key: options.key,
    items: items.map(options.trim).slice(skip),
    extra: { ...(total !== undefined ? { total } : {}), ...options.extra?.(data) },
    resumeAt: (index) => h.makeCursor({ o: offset, n: limit, s: skip + index }),
    ...(more && items.length ? { nextPage: h.makeCursor({ o: offset + limit, n: limit, s: 0 }) } : {}),
  });
}
