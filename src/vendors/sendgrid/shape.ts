// Trimming and paging helpers for the SendGrid connector.

import { truncate, type ToolHelpers } from '../../core/index.js';

/** Drops undefined, null and empty-string values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

const HTML_LIMIT = 20_000;

export function html(text: unknown): string | undefined {
  return typeof text === 'string' && text ? truncate(text, HTML_LIMIT) : undefined;
}

/** A Unix time in seconds as an ISO date-time. */
export function isoFromUnix(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

export function trimContact(contact: any): Record<string, unknown> {
  const custom = contact?.custom_fields && typeof contact.custom_fields === 'object' && Object.keys(contact.custom_fields).length ? contact.custom_fields : undefined;
  return compact({
    id: contact?.id,
    email: contact?.email,
    first_name: contact?.first_name,
    last_name: contact?.last_name,
    phone_number: contact?.phone_number,
    external_id: contact?.external_id,
    alternate_emails: Array.isArray(contact?.alternate_emails) && contact.alternate_emails.length ? contact.alternate_emails : undefined,
    city: contact?.city,
    state_province_region: contact?.state_province_region,
    country: contact?.country,
    postal_code: contact?.postal_code,
    list_ids: Array.isArray(contact?.list_ids) && contact.list_ids.length ? contact.list_ids : undefined,
    segment_ids: Array.isArray(contact?.segment_ids) && contact.segment_ids.length ? contact.segment_ids : undefined,
    custom_fields: custom,
    created_at: contact?.created_at,
    updated_at: contact?.updated_at,
  });
}

export function trimSingleSend(send: any, options: { html?: boolean } = {}): Record<string, unknown> {
  const config = send?.email_config;
  return compact({
    id: send?.id,
    name: send?.name,
    status: send?.status,
    categories: Array.isArray(send?.categories) && send.categories.length ? send.categories : undefined,
    send_at: send?.send_at,
    send_to: send?.send_to,
    is_abtest: send?.is_abtest,
    created_at: send?.created_at,
    updated_at: send?.updated_at,
    email_config: config
      ? compact({
        subject: config.subject,
        sender_id: config.sender_id,
        suppression_group_id: config.suppression_group_id,
        custom_unsubscribe_url: config.custom_unsubscribe_url,
        design_id: config.design_id,
        editor: config.editor,
        ip_pool: config.ip_pool,
        generate_plain_content: config.generate_plain_content,
        html_content: options.html ? html(config.html_content) : undefined,
        plain_content: options.html ? html(config.plain_content) : undefined,
      })
      : undefined,
    warnings: Array.isArray(send?.warnings) && send.warnings.length ? send.warnings : undefined,
  });
}

export function trimTemplate(template: any, options: { html?: boolean } = {}): Record<string, unknown> {
  const versions: any[] = Array.isArray(template?.versions) ? template.versions : [];
  return compact({
    id: template?.id,
    name: template?.name,
    generation: template?.generation,
    updated_at: template?.updated_at,
    versions: versions.map((version) => compact({
      id: version?.id,
      name: version?.name,
      active: version?.active,
      subject: version?.subject,
      editor: version?.editor,
      updated_at: version?.updated_at,
      // The HTML of the version in use, when asked for: other versions are summarized.
      html_content: options.html && version?.active === 1 ? html(version?.html_content) : undefined,
      plain_content: options.html && version?.active === 1 ? html(version?.plain_content) : undefined,
    })),
  });
}

/** The page_token of a SendGrid `_metadata.next` link, if there is one. */
export function nextToken(next: unknown): string | undefined {
  if (typeof next !== 'string' || !next) return undefined;
  try {
    return new URL(next).searchParams.get('page_token') ?? undefined;
  } catch {
    return undefined;
  }
}

export interface TokenListOptions {
  key: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  pageSize: number;
  /** SendGrid's field that holds the list (default "result"). */
  listField?: string;
  trim(item: any): unknown;
}

/** One page of a SendGrid list that pages with page_size and page_token. */
export async function tokenList(h: ToolHelpers, cursor: string | undefined, options: TokenListOptions): Promise<Record<string, unknown>> {
  const state = h.cursor(cursor);
  // "t" is the cursor's own field (the tool), so the page token goes under "p".
  const token = typeof state?.['p'] === 'string' ? state['p'] : undefined;
  const size = typeof state?.['n'] === 'number' ? state['n'] : options.pageSize;
  const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
  const { data } = await h.api({ path: options.path, query: { ...options.query, page_size: size, page_token: token } });
  const items: unknown[] = Array.isArray(data?.[options.listField ?? 'result']) ? data[options.listField ?? 'result'] : [];
  const next = nextToken(data?._metadata?.next);
  const count = typeof data?._metadata?.count === 'number' ? data._metadata.count : undefined;
  return h.page({
    key: options.key,
    items: items.map(options.trim).slice(skip),
    extra: count !== undefined ? { total: count } : {},
    resumeAt: (index) => h.makeCursor({ ...(token ? { p: token } : {}), n: size, s: skip + index }),
    ...(next && items.length ? { nextPage: h.makeCursor({ p: next, n: size, s: 0 }) } : {}),
  });
}

export interface OffsetListOptions {
  key: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  limit: number;
  /** The list in SendGrid's reply: the reply itself by default. */
  list?(data: any): unknown[];
  trim(item: any): unknown;
}

/** One page of a SendGrid list that pages with limit and offset and has no total. */
export async function offsetList(h: ToolHelpers, cursor: string | undefined, options: OffsetListOptions): Promise<Record<string, unknown>> {
  const state = h.cursor(cursor);
  const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const limit = typeof state?.['n'] === 'number' ? state['n'] : options.limit;
  const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
  const { data } = await h.api({ path: options.path, query: { ...options.query, limit, offset } });
  const items: unknown[] = options.list ? options.list(data) : Array.isArray(data) ? data : [];
  return h.page({
    key: options.key,
    items: items.map(options.trim).slice(skip),
    resumeAt: (index) => h.makeCursor({ o: offset, n: limit, s: skip + index }),
    ...(items.length >= limit ? { nextPage: h.makeCursor({ o: offset + limit, n: limit, s: 0 }) } : {}),
  });
}

/** Standard base64 of some bytes (SendGrid attachments). */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  ics: 'text/calendar',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

/** A file's media type from its name's extension. */
export function typeFromName(name: string): string {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return TYPES[extension] ?? 'application/octet-stream';
}
