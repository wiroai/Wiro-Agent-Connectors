import { jsonSize, ToolFailure, truncate } from '../../core/index.js';

// File helpers for Google Drive: kinds, trimming, file types from bytes,
// multipart bodies, CSV, Drive query literals and text pages.

export const FOLDER_TYPE = 'application/vnd.google-apps.folder';
export const GOOGLE_TYPES = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
} as const;

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/** folder, document, spreadsheet, presentation, form, shortcut or file. */
export function kindOf(mimeType: unknown): string {
  if (typeof mimeType !== 'string') return 'file';
  const match = /^application\/vnd\.google-apps\.(folder|document|spreadsheet|presentation|form|shortcut|drawing|site)$/.exec(mimeType);
  return match ? (match[1] as string) : 'file';
}

function person(value: any): string | undefined {
  return typeof value?.displayName === 'string' && value.displayName ? value.displayName : value?.emailAddress;
}

/** The fields an agent needs from a Drive file. */
export function trimFile(file: any): Record<string, unknown> {
  const owners: any[] = Array.isArray(file?.owners) ? file.owners : [];
  return compact({
    id: file?.id,
    name: file?.name,
    kind: kindOf(file?.mimeType),
    mimeType: file?.mimeType,
    size: file?.size !== undefined && Number.isFinite(Number(file.size)) ? Number(file.size) : undefined,
    modifiedTime: file?.modifiedTime,
    createdTime: file?.createdTime,
    parents: Array.isArray(file?.parents) ? file.parents : undefined,
    driveId: file?.driveId,
    description: typeof file?.description === 'string' ? truncate(file.description, 500) : undefined,
    owner: owners.length ? person(owners[0]) : undefined,
    lastModifiedBy: file?.lastModifyingUser ? person(file.lastModifyingUser) : undefined,
    starred: file?.starred === true ? true : undefined,
    trashed: file?.trashed === true ? true : undefined,
    shortcutTarget: file?.shortcutDetails?.targetId,
    webViewLink: file?.webViewLink,
    webContentLink: file?.webContentLink,
  });
}

/** A Drive query string literal: 'it\'s'. */
export function queryLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** The file type the bytes show, for common media and documents, or undefined. */
export function sniffType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  return undefined;
}

const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function typeByName(name: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? BY_EXTENSION[(match[1] as string).toLowerCase()] : undefined;
}

/** The type to upload bytes as: given, then seen in the bytes, then the server's, then the name's. */
export function uploadType(bytes: Uint8Array, name: string, given?: string, served?: string | null): string {
  if (given) return given;
  const byName = typeByName(name);
  const sniffed = sniffType(bytes);
  // Office files are zip files: their name tells which.
  if (sniffed === 'application/zip' && byName && byName !== 'application/zip') return byName;
  if (sniffed) return sniffed;
  const header = served?.split(';')[0]?.trim().toLowerCase();
  if (header && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(header) && header !== 'application/octet-stream' && header !== 'binary/octet-stream') return header;
  return byName ?? 'application/octet-stream';
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|x-ndjson|ld\+json|sql|x-sh|x-httpd-php|csv)\b|image\/svg\+xml)/i;

export function isTextType(mimeType: string): boolean {
  return TEXT_TYPES.test(mimeType) || /\+(json|xml)$/i.test(mimeType);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A multipart/related body: the JSON metadata, then the file. */
export function multipartBody(metadata: Record<string, unknown>, bytes: Uint8Array, mimeType: string): { body: Uint8Array; contentType: string } {
  const boundary = `upload_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export type Cell = string | number | boolean | null;

/** Checks that rows hold only text, numbers, true/false or null. */
export function checkRows(rows: unknown[], field: string): Cell[][] {
  const problem = new ToolFailure(`${field} must be a list of rows, each a list of cells: text, numbers, true/false or null. Nothing was sent.`);
  for (const row of rows) {
    if (!Array.isArray(row)) throw problem;
    for (const cell of row) {
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) throw problem;
      if (typeof cell === 'number' && !Number.isFinite(cell)) throw problem;
    }
  }
  return rows as Cell[][];
}

/** Rows as CSV text (RFC 4180). */
export function toCsv(rows: Cell[][]): string {
  return rows
    .map((row) => row
      .map((cell) => {
        const text = cell === null ? '' : typeof cell === 'boolean' ? (cell ? 'TRUE' : 'FALSE') : String(cell);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      })
      .join(','))
    .join('\r\n');
}

/** The most UTF-8 bytes one page of text takes in a result's JSON (the result stays under 32 KB). */
const TEXT_BUDGET = 26_000;

/** The part of `text` from `offset` that fits a result, and where the next part starts. */
export function textPage(text: string, offset: number): { piece: string; next?: number } {
  let low = offset;
  let high = Math.min(text.length, offset + TEXT_BUDGET);
  if (jsonSize(text.slice(offset, high)) <= TEXT_BUDGET) low = high;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonSize(text.slice(offset, middle)) <= TEXT_BUDGET) low = middle;
    else high = middle - 1;
  }
  // Never split a surrogate pair.
  if (low > offset && low < text.length && /[\ud800-\udbff]/.test(text.charAt(low - 1))) low -= 1;
  return { piece: text.slice(offset, low), ...(low < text.length ? { next: low } : {}) };
}
