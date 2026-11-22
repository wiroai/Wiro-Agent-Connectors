// The connected site's REST API: where it lives (a WordPress install may sit
// in a subdirectory, such as https://example.com/blog), how requests are signed
// (HTTP Basic auth with the user name and an application password), and the
// hints added to WordPress's own error codes.

import { parseSiteUrl, ToolFailure, utf8Bytes, type ApiRequest, type ApiResponse, type ToolHelpers } from '../../core/index.js';

/** "Basic <base64 of user:password>", from the UTF-8 bytes. */
export function basicAuth(user: string, password: string): string {
  let binary = '';
  for (const byte of utf8Bytes(`${user}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * The path of the WordPress install, "" or "/blog": the path of the url
 * credential, without an admin, REST or login part pasted with it.
 */
export function installPath(value: string | undefined): string {
  const site = parseSiteUrl(value ?? '');
  if (!site.ok) return '';
  return site.url.pathname.replace(/\/(?:wp-admin|wp-json|wp-login\.php)(?:\/.*)?$/i, '').replace(/\/+$/, '');
}

/** The site's address with its install path, such as https://example.com/blog. */
export function siteAddress(h: ToolHelpers): string {
  return `${h.originOf('url')}${installPath(h.credentials['url'])}`;
}

/** The link that opens a post or page in the WordPress editor. */
export function editLink(h: ToolHelpers, id: unknown): string | undefined {
  return typeof id === 'number' ? `${siteAddress(h)}/wp-admin/post.php?post=${id}&action=edit` : undefined;
}

const NOT_FOUND =
  'Check that the WordPress URL is the site\'s address (with its subdirectory when WordPress is installed in one) '
  + 'and that its REST API answers at <address>/wp-json/ (permalinks other than Plain).';

const HINTS: Record<string, string> = {
  rest_not_logged_in:
    'WordPress did not see the sign-in: the site\'s server may drop the Authorization header (some hosting setups do), '
    + 'or a security plugin may block application passwords.',
  incorrect_password: 'Check the application password (WordPress → Users → Profile → Application Passwords): it is not the account password.',
  invalid_username: 'Check the WordPress user name: it is the login name, not the display name or email address.',
  invalid_email: 'Check the WordPress user name: it is the login name, not the display name or email address.',
  application_passwords_disabled: 'Application passwords are turned off on this site (by a plugin or the site\'s settings, or because it is not served over https).',
  rest_cannot_create: 'The WordPress user may not do this: it needs the Author, Editor or Administrator role.',
  rest_cannot_edit: 'The WordPress user may not edit this item: an Author can edit only their own posts, an Editor any post.',
  rest_cannot_publish: 'The WordPress user may not publish: save a draft instead, or give the user the Author, Editor or Administrator role.',
  rest_no_route: NOT_FOUND,
};

/** A WordPress error with a sentence on what to check next, when its code has one. */
export function withHint(error: unknown): unknown {
  if (!(error instanceof ToolFailure)) return error;
  const { vendorCode, status } = error.details;
  const hint = (vendorCode !== undefined ? HINTS[vendorCode] : undefined) ?? (status === 404 && vendorCode === undefined ? NOT_FOUND : undefined);
  return hint ? new ToolFailure(`${error.message} ${hint}`, error.details) : error;
}

/** One request to a REST route of the site, such as "/wp/v2/posts". */
export async function rest(h: ToolHelpers, route: string, request: Omit<ApiRequest, 'path' | 'origin'> = {}): Promise<ApiResponse> {
  try {
    return await h.api({ ...request, origin: h.originOf('url'), path: `${installPath(h.credentials['url'])}/wp-json${route}` });
  } catch (error) {
    throw withHint(error);
  }
}

/** The page count WordPress sends with a list, or undefined when a proxy dropped it. */
export function totalPages(response: ApiResponse): number | undefined {
  const value = Number(response.headers.get('x-wp-totalpages'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The item count WordPress sends with a list. */
export function totalItems(response: ApiResponse): number | undefined {
  const value = Number(response.headers.get('x-wp-total'));
  return response.headers.has('x-wp-total') && Number.isFinite(value) ? value : undefined;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Text with HTML entities (&amp;, &#8217;, &#x2019;) turned back into characters. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** The text of an HTML fragment, on one line. */
export function plainText(html: unknown, max: number): string | undefined {
  if (typeof html !== 'string') return undefined;
  const text = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${Array.from(text).slice(0, max - 1).join('')}…` : text;
}

/** A rendered or raw field ({ raw, rendered }, or a plain string), as text. */
export function fieldText(value: any): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value?.raw === 'string') return value.raw;
  if (typeof value?.rendered === 'string') return decodeEntities(value.rendered);
  return undefined;
}

/**
 * A date argument as WordPress takes it: with Z or an offset it is a fixed
 * moment, sent as date_gmt; without one it is the site's own local time, sent
 * as date.
 */
export function dateFields(value: string, argument: string): Record<string, string> {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!match) {
    throw new ToolFailure(
      `${argument} must look like 2026-12-01T09:00:00, with Z or an offset such as +03:00 for a fixed moment, `
        + 'or without one for the site\'s own time zone. Nothing was sent.',
    );
  }
  const local = `${match[1]}T${match[2]}${match[3] ?? ':00'}`;
  if (!match[4]) return { date: local };
  const offset = match[4].toUpperCase() === 'Z' ? 'Z' : match[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const moment = Date.parse(`${local}${offset}`);
  if (Number.isNaN(moment)) throw new ToolFailure(`${argument} is not a valid date and time. Nothing was sent.`);
  return { date_gmt: new Date(moment).toISOString().slice(0, 19) };
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

/**
 * A query or form field name as PHP reads it into $_GET or $_POST: cut at a
 * NUL, leading spaces dropped, and " ", "." and "[" read as "_". So
 * "rest.route" and "rest[route" arrive as rest_route, and an array field such
 * as "rest_route[a]" starts with it.
 */
export function phpFieldName(name: string): string {
  return (name.split('\0')[0] ?? '').replace(/^ +/, '').replace(/[ .[]/g, '_');
}

/** Whether a request body is JSON: PHP reads form bodies into $_POST, where WordPress also takes rest_route from. */
export function isJsonBody(request: ApiRequest): boolean {
  if (request.body === undefined) return true;
  const media = (request.contentType ?? '').trim().toLowerCase().split(/[;,\s]/)[0] ?? '';
  return media === 'application/json' || /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(media);
}

/** The text to search terms by: WordPress stores &, < and > in term names as entities, which a search for the name would miss. */
export function termSearch(name: string): string | undefined {
  const parts = name.split(/[&<>]/).map((part) => part.trim()).filter(Boolean);
  return parts.sort((a, b) => b.length - a.length)[0];
}

/** A term name compared the way WordPress saves it: entities decoded, spaces collapsed, any case. */
export function termKey(name: string): string {
  return decodeEntities(name).replace(/\s+/g, ' ').trim().toLowerCase();
}
