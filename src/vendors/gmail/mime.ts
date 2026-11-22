import { base64UrlDecode, truncate, utf8Bytes, utf8Decode, utf8Length } from '../../core/index.js';

// Reading the MIME parts the Gmail API returns, and writing the RFC 2822
// message that messages.send and drafts.create take as `raw`.

export interface MessageHeader {
  name?: string;
  value?: string;
}

/** The first header of that name (any case), or undefined. */
export function header(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const item of headers as MessageHeader[]) {
    if (typeof item?.name === 'string' && item.name.toLowerCase() === wanted && typeof item.value === 'string') return item.value;
  }
  return undefined;
}

/** A header value on one line, safe to write into another message. */
export function oneLine(value: string | undefined): string | undefined {
  const line = value?.replace(/[\r\n]+/g, ' ').trim();
  return line ? line : undefined;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', euro: '€', bull: '•', middot: '·',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** The most HTML htmlToText reads; text after it is left out. */
export const MAX_HTML_CHARS = 1_000_000;
/** Elements whose content is not text. */
const HIDDEN = new Set(['script', 'style', 'head', 'title']);
/** Closing tags that end a line. */
const BLOCKS = new Set(['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'table', 'ul', 'ol', 'section', 'article', 'header', 'footer']);

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 0x30 && code <= 0x39);
}

/** The tag name at `from` (lower case), or '' when none starts there. */
function tagName(html: string, from: number, end: number): string {
  let at = from;
  while (at < end && isNameChar(html.charCodeAt(at))) at++;
  return at > from && isLetter(html.charCodeAt(from)) ? html.slice(from, at).toLowerCase() : '';
}

/** Where the text after `</name>` starts, searching from `from`; -1 when the element is never closed. */
function afterClosing(html: string, from: number, name: string): number {
  let at = from;
  for (;;) {
    const open = html.indexOf('</', at);
    if (open === -1) return -1;
    const end = open + 2 + name.length;
    if (html.slice(open + 2, end).toLowerCase() === name && !isNameChar(html.charCodeAt(end))) {
      const close = html.indexOf('>', end);
      return close === -1 ? -1 : close + 1;
    }
    at = open + 2;
  }
}

/** A link's address, from its tag (at most its first 2,000 characters). */
function hrefOf(tag: string): string | undefined {
  const match = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  const href = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return href || undefined;
}

/**
 * Readable text from an HTML mail body: paragraphs and line breaks kept, links
 * as "text (url)". One pass from start to end, so its time grows with the
 * length of the HTML only (mail HTML is anyone's input); an element left open
 * at the end (a comment, a tag, a script) ends the text there. It reads at
 * most MAX_HTML_CHARS characters.
 */
export function htmlToText(html: string): string {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const pieces: string[] = [];
  let link: { href: string; at: number } | undefined;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      pieces.push(source.slice(index));
      break;
    }
    if (open > index) pieces.push(source.slice(index, open));
    const next = source.charCodeAt(open + 1);
    // As in browsers, a "<" before anything but a letter, "/", "!" or "?" is text.
    if (!isLetter(next) && next !== 0x2f && next !== 0x21 && next !== 0x3f) {
      pieces.push('<');
      index = open + 1;
      continue;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    const close = source.indexOf('>', open + 1);
    if (close === -1) break;
    index = close + 1;
    const closing = next === 0x2f;
    const name = tagName(source, closing ? open + 2 : open + 1, close);
    if (!name) continue;
    if (closing) {
      if (name === 'a' && link) {
        const words = pieces.slice(link.at).join('').trim();
        const { href } = link;
        pieces.length = link.at;
        pieces.push(!words || words === href || /^mailto:/i.test(href) ? words || href : `${words} (${href})`);
        link = undefined;
      } else if (BLOCKS.has(name)) {
        pieces.push('\n');
      }
      continue;
    }
    if (HIDDEN.has(name)) {
      const after = afterClosing(source, index, name);
      if (after === -1) break;
      index = after;
      continue;
    }
    if (name === 'br') pieces.push('\n');
    else if (name === 'li') pieces.push('- ');
    else if (name === 'a') {
      const href = hrefOf(source.slice(open, Math.min(close, open + 2000)));
      if (href) link = { href, at: pieces.length };
    }
  }
  return decodeEntities(pieces.join(''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function charsetOf(part: any): string {
  const type = header(part?.headers, 'Content-Type') ?? '';
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(type);
  return match?.[1] ?? 'utf-8';
}

/** The text of a part's base64url body, decoded with the part's charset (UTF-8 when unknown). */
export function decodeData(data: string, charset = 'utf-8'): string {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(data.replace(/=+$/, '').replace(/\s+/g, ''));
  } catch {
    return '';
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return utf8Decode(bytes);
  }
}

export interface Attachment {
  filename?: string;
  mime_type?: string;
  size?: number;
  attachment_id?: string;
  part_id?: string;
}

export interface MessageBody {
  plain: string[];
  html: string[];
  attachments: Attachment[];
}

/** The text parts and the attachments of a message payload (format=full). */
export function readPayload(payload: unknown): MessageBody {
  const out: MessageBody = { plain: [], html: [], attachments: [] };
  const walk = (part: any, depth: number): void => {
    if (!part || typeof part !== 'object' || depth > 20) return;
    if (Array.isArray(part.parts) && part.parts.length) {
      for (const child of part.parts) walk(child, depth + 1);
      return;
    }
    const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const disposition = header(part.headers, 'Content-Disposition') ?? '';
    const isText = mime === 'text/plain' || mime === 'text/html';
    if (filename || /^\s*attachment/i.test(disposition) || (!isText && part.body?.attachmentId)) {
      out.attachments.push({
        ...(filename ? { filename: truncate(filename, 300) } : {}),
        ...(mime ? { mime_type: mime } : {}),
        ...(typeof part.body?.size === 'number' ? { size: part.body.size } : {}),
        ...(typeof part.body?.attachmentId === 'string' ? { attachment_id: part.body.attachmentId } : {}),
        ...(typeof part.partId === 'string' ? { part_id: part.partId } : {}),
      });
      return;
    }
    if (isText && typeof part.body?.data === 'string') {
      (mime === 'text/plain' ? out.plain : out.html).push(decodeData(part.body.data, charsetOf(part)));
    }
  };
  walk(payload, 0);
  return out;
}

/**
 * A message's body as text: the plain-text parts, or the HTML parts made
 * readable (cut: the HTML was longer than htmlToText reads).
 */
export function bodyText(body: MessageBody): { text: string; from: 'text' | 'html' | 'none'; cut?: boolean } {
  if (body.plain.some((part) => part.trim())) return { text: body.plain.join('\n\n').trim(), from: 'text' };
  if (body.html.length) {
    const html = body.html.join('\n');
    return { text: htmlToText(html), from: 'html', ...(html.length > MAX_HTML_CHARS ? { cut: true } : {}) };
  }
  return { text: '', from: 'none' };
}

/** Standard base64 (as MIME bodies use it). */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const ASCII = /^[\x20-\x7e]*$/;

/** A header value, as RFC 2047 encoded words when it is not plain ASCII. */
export function encodeHeader(value: string): string {
  if (ASCII.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (chunk && utf8Length(chunk + char) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(utf8Bytes(word))}?=`).join('\r\n ');
}

const BARE_ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;
const NAMED_ADDRESS = /^(.*?)\s*<([^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+)>$/;

/** "Name <a@example.com>" or "a@example.com" as a header item, or undefined when it is neither. */
export function formatAddress(value: string): string | undefined {
  const text = value.trim();
  if (BARE_ADDRESS.test(text)) return text;
  const match = NAMED_ADDRESS.exec(text);
  if (!match) return undefined;
  const name = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  const address = match[2] as string;
  if (!name) return address;
  if (ASCII.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${encodeHeader(name)} <${address}>`;
}

function lines76(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 76) out.push(text.slice(i, i + 76));
  return out;
}

function textPart(body: string, subtype: 'plain' | 'html'): string[] {
  return [`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', ...lines76(base64(utf8Bytes(body)))];
}

export interface Outgoing {
  /** Header items already formatted (formatAddress). */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * The RFC 2822 message: UTF-8 bodies in base64, a text part and, with HTML,
 * a multipart/alternative of both (the text made from the HTML when only
 * HTML is given). Gmail adds From, Date and Message-ID itself.
 */
export function buildMessage(mail: Outgoing, boundary: string): string {
  const lines: string[] = [];
  if (mail.to.length) lines.push(`To: ${mail.to.join(',\r\n ')}`);
  if (mail.cc.length) lines.push(`Cc: ${mail.cc.join(',\r\n ')}`);
  if (mail.bcc.length) lines.push(`Bcc: ${mail.bcc.join(',\r\n ')}`);
  lines.push(`Subject: ${encodeHeader(mail.subject)}`);
  if (mail.inReplyTo) lines.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references) lines.push(`References: ${mail.references}`);
  lines.push('MIME-Version: 1.0');
  const text = mail.text ?? (mail.html !== undefined ? htmlToText(mail.html) : '');
  if (mail.html !== undefined) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      ...textPart(text, 'plain'),
      `--${boundary}`,
      ...textPart(mail.html, 'html'),
      `--${boundary}--`,
      '',
    );
  } else {
    lines.push(...textPart(text, 'plain'));
  }
  return lines.join('\r\n');
}
