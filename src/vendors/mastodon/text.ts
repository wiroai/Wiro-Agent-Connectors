import { truncate } from '../../core/index.js';

// How Mastodon counts a post, and its HTML as plain text. A server counts the
// content warning plus the text in graphemes (an emoji is one), every link as
// a fixed number of characters (23 by default), and a mention of an account on
// another server, @name@server, as @name.

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined;

/** Graphemes in the text; without Intl.Segmenter, code points (never fewer than graphemes). */
export function graphemeLength(text: string): number {
  if (!segmenter) return Array.from(text).length;
  let count = 0;
  for (const _segment of segmenter.segment(text)) count++;
  return count;
}

const LINK = /(^|[\s(])(https?:\/\/[^\s]+)/gu;
const REMOTE_MENTION = /(^|[^\w@/])@([A-Za-z0-9_]+)@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/gu;

/** A link without the punctuation that ends a sentence after it. */
function trimLink(url: string): string {
  let trimmed = url;
  for (;;) {
    if (/[.,;:!?"']$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    else if (trimmed.endsWith(')') && !trimmed.includes('(')) trimmed = trimmed.slice(0, -1);
    else return trimmed;
  }
}

/** The length of a post as the server counts it: content warning plus text. */
export function countCharacters(text: string, spoiler: string, charactersPerUrl: number): number {
  const countable = text
    .replace(LINK, (_whole, before: string, url: string) => {
      const link = trimLink(url);
      return `${before}${'x'.repeat(charactersPerUrl)}${url.slice(link.length)}`;
    })
    .replace(REMOTE_MENTION, (_whole, before: string, name: string) => `${before}@${name}`);
  return graphemeLength(spoiler) + graphemeLength(countable);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A status's HTML content as one line of plain text, at most `max` characters. */
export function plainText(html: unknown, max = 500): string {
  if (typeof html !== 'string') return '';
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}
