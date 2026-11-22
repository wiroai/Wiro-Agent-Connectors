import { truncate, utf8Decode } from '../../core/index.js';

// Post references and link cards. A post is named by its bsky.app link or its
// at:// URI; a link card takes its title, description and picture from the
// page's own Open Graph tags, never from guesses.

export interface PostRef {
  /** The handle or DID in the reference, e.g. "alice.bsky.social" or "did:plc:...". */
  actor: string;
  rkey: string;
}

const ACTOR = '(did:[a-z]+:[A-Za-z0-9._:%-]+|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)';
const RKEY = '([A-Za-z0-9._:~-]{1,512})';
const WEB_LINK = new RegExp(`^https://(?:www\\.)?bsky\\.app/profile/${ACTOR}/post/${RKEY}/?(?:[?#].*)?$`);
const AT_URI = new RegExp(`^at://${ACTOR}/app\\.bsky\\.feed\\.post/${RKEY}$`);

/** A post's actor and record key from https://bsky.app/profile/<actor>/post/<rkey> or at://<actor>/app.bsky.feed.post/<rkey>. */
export function parsePostRef(value: string): PostRef | undefined {
  const text = value.trim();
  const match = WEB_LINK.exec(text) ?? AT_URI.exec(text);
  if (!match) return undefined;
  const actor = match[1] as string;
  return { actor: actor.startsWith('did:') ? actor : actor.toLowerCase(), rkey: match[2] as string };
}

export function postUri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function clean(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const line = decodeEntities(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? truncate(line, max) : undefined;
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = (match[1] as string).toLowerCase();
    if (!(name in found)) found[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return found;
}

export interface PageCard {
  title?: string;
  description?: string;
  /** An absolute https URL of the page's picture. */
  image?: string;
}

/** The title, description and picture a page names in its Open Graph (or Twitter, or plain) tags. */
export function readPageCard(bytes: Uint8Array, pageUrl: string): PageCard {
  const html = utf8Decode(bytes.subarray(0, 512 * 1024));
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const meta: Record<string, string> = {};
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs['property'] ?? attrs['name'] ?? '').toLowerCase();
    if (key && attrs['content'] !== undefined && !(key in meta)) meta[key] = attrs['content'];
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  let image: string | undefined;
  const imageValue = meta['og:image'] ?? meta['og:image:url'] ?? meta['og:image:secure_url'] ?? meta['twitter:image'];
  if (imageValue) {
    try {
      const url = new URL(decodeEntities(imageValue.trim()), pageUrl);
      if (url.protocol === 'https:') image = url.toString();
    } catch {
      // no usable picture
    }
  }
  const card: PageCard = {};
  const title = clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 300);
  const description = clean(meta['og:description'] ?? meta['twitter:description'] ?? meta['description'], 1000);
  if (title) card.title = title;
  if (description) card.description = description;
  if (image) card.image = image;
  return card;
}
