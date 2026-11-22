// Trimming helpers for the HubSpot connector: results keep HubSpot's own
// field names, minus empty property values and paging links.

import { truncate, utf8Bytes } from '../../core/index.js';

/** Drops undefined, null and empty-string values. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/** A CRM record: its id, non-empty properties, dates, and associated record ids by type. */
export function trimRecord(record: any): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries((record?.properties ?? {}) as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '' || name === 'hs_object_id') continue;
    properties[name] = typeof value === 'string' ? truncate(value, 4000) : value;
  }
  const associations: Record<string, string[]> = {};
  for (const [type, value] of Object.entries((record?.associations ?? {}) as Record<string, any>)) {
    const results: any[] = Array.isArray(value?.results) ? value.results : [];
    const ids = [...new Set(results.map((item) => String(item?.id ?? item?.toObjectId)).filter((id) => id !== 'undefined'))];
    if (ids.length) associations[type] = ids;
  }
  const history = record?.propertiesWithHistory && Object.keys(record.propertiesWithHistory).length ? record.propertiesWithHistory : undefined;
  return compact({
    id: record?.id,
    properties,
    propertiesWithHistory: history,
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    archived: record?.archived === true ? true : undefined,
    associations: Object.keys(associations).length ? associations : undefined,
  });
}

export function trimProperty(property: any): Record<string, unknown> {
  const options: any[] = Array.isArray(property?.options) ? property.options : [];
  return compact({
    name: property?.name,
    label: property?.label,
    type: property?.type,
    fieldType: property?.fieldType,
    groupName: property?.groupName,
    description: typeof property?.description === 'string' && property.description ? truncate(property.description, 200) : undefined,
    options: options.length ? options.slice(0, 100).map((option) => compact({ label: option?.label, value: option?.value, hidden: option?.hidden === true ? true : undefined })) : undefined,
    moreOptions: options.length > 100 ? options.length - 100 : undefined,
    calculated: property?.calculated === true ? true : undefined,
    readOnly: property?.modificationMetadata?.readOnlyValue === true ? true : undefined,
    hasUniqueValue: property?.hasUniqueValue === true ? true : undefined,
    referencedObjectType: property?.referencedObjectType,
  });
}

export function trimEmail(email: any, options: { content?: boolean } = {}): Record<string, unknown> {
  const contactLists = email?.to?.contactLists ?? email?.to?.contactIlsLists;
  return compact({
    id: email?.id,
    name: email?.name,
    subject: email?.subject,
    state: email?.state,
    type: email?.type,
    subcategory: email?.subcategory,
    isPublished: email?.isPublished,
    publishDate: email?.publishDate,
    createdAt: email?.createdAt,
    updatedAt: email?.updatedAt,
    from: email?.from && Object.keys(email.from).length ? email.from : undefined,
    to: contactLists ? compact({ include: contactLists.include, exclude: contactLists.exclude }) : undefined,
    subscriptionDetails: email?.subscriptionDetails && Object.keys(email.subscriptionDetails).length ? email.subscriptionDetails : undefined,
    campaign: email?.campaign,
    stats: email?.stats && Object.keys(email.stats).length ? email.stats : undefined,
    content: options.content && email?.content ? truncateJson(email.content, 16_000) : undefined,
  });
}

/** A JSON value that stays readable when cut: the value itself when small, its text cut to `max` otherwise. */
function truncateJson(value: unknown, max: number): unknown {
  const text = JSON.stringify(value);
  return text.length <= max ? value : truncate(text, max);
}

export function trimFile(file: any): Record<string, unknown> {
  return compact({
    id: file?.id,
    name: file?.name,
    extension: file?.extension,
    type: file?.type,
    size: file?.size,
    access: file?.access,
    path: file?.path,
    url: file?.url ?? file?.defaultHostingUrl,
    createdAt: file?.createdAt,
    updatedAt: file?.updatedAt,
  });
}

/** One multipart/form-data body: text fields and one file. */
export function multipart(fields: Record<string, string>, file: { field: string; name: string; type: string; bytes: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----connector${crypto.randomUUID().replace(/-/g, '')}`;
  const safe = (text: string) => text.replace(/["\r\n\\]/g, '_');
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}\r\n`));
  }
  parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(file.field)}"; filename="${safe(file.name)}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.bytes);
  parts.push(utf8Bytes(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  txt: 'text/plain',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export function typeFromName(name: string): string {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return TYPES[extension] ?? 'application/octet-stream';
}

/** A file name from a URL's last path segment, or a fallback. */
export function nameFromUrl(url: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return /^[^/\\]{1,200}\.[A-Za-z0-9]{1,8}$/.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}
