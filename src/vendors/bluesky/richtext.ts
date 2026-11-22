import { utf8Length } from '../../core/index.js';

// Bluesky makes links, mentions and hashtags clickable only through "facets":
// each one names its place in the text in UTF-8 bytes. Bluesky counts the text
// limit in graphemes (an emoji is one).

export const MAX_GRAPHEMES = 300;
export const MAX_TEXT_BYTES = 3000;
export const MAX_TAG_GRAPHEMES = 64;
const MAX_MENTIONS = 10;

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

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, string>>;
}

interface Span {
  start: number;
  end: number;
}

interface Found extends Span {
  kind: 'link' | 'mention' | 'tag';
  value: string;
}

const LINK = /(^|[\s(\[])(https?:\/\/[^\s<>"]+)/gu;
const MENTION = /(^|[\s(\[])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)/gu;
const TAG = /(^|\s)[#＃]([^\s#＃]+)/gu;

function trimLink(url: string): string {
  let trimmed = url.replace(/[.,;:!?'"’”]+$/u, '');
  // Keep a closing parenthesis that belongs to the URL, e.g. a Wikipedia link.
  while (trimmed.endsWith(')') && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)) {
    trimmed = trimmed.slice(0, -1).replace(/[.,;:!?'"’”]+$/u, '');
  }
  return trimmed;
}

export function findLinks(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(LINK)) {
    const url = trimLink(match[2] as string);
    try {
      new URL(url);
    } catch {
      continue;
    }
    const start = (match.index as number) + (match[1] as string).length;
    found.push({ kind: 'link', value: url, start, end: start + url.length });
  }
  return found;
}

export function findMentions(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = match[2] as string;
    const tld = handle.slice(handle.lastIndexOf('.') + 1);
    if (!/^[a-zA-Z]/.test(tld)) continue;
    const start = (match.index as number) + (match[1] as string).length;
    found.push({ kind: 'mention', value: handle.toLowerCase(), start, end: start + 1 + handle.length });
  }
  return found;
}

export function findTags(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(TAG)) {
    const tag = (match[2] as string).replace(/\p{P}+$/u, '');
    if (!tag || /^\d+$/.test(tag) || graphemeLength(tag) > MAX_TAG_GRAPHEMES) continue;
    const start = (match.index as number) + (match[1] as string).length;
    found.push({ kind: 'tag', value: tag, start, end: start + 1 + tag.length });
  }
  return found;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface FacetResult {
  facets: Facet[];
  links: number;
  mentions: number;
  tags: number;
  unresolvedMentions: string[];
}

/**
 * The facets of a post text. `resolveHandle` turns a handle into a DID, or
 * undefined when it does not exist; such a mention stays plain text.
 */
export async function buildFacets(text: string, resolveHandle: (handle: string) => Promise<string | undefined>): Promise<FacetResult> {
  const candidates = [...findLinks(text), ...findMentions(text), ...findTags(text)].sort((a, b) => a.start - b.start);
  const chosen: Found[] = [];
  for (const candidate of candidates) {
    if (!chosen.some((other) => overlaps(other, candidate))) chosen.push(candidate);
  }

  const handles = [...new Set(chosen.filter((item) => item.kind === 'mention').map((item) => item.value))].slice(0, MAX_MENTIONS);
  const dids = new Map<string, string | undefined>();
  for (const handle of handles) dids.set(handle, await resolveHandle(handle));

  const result: FacetResult = { facets: [], links: 0, mentions: 0, tags: 0, unresolvedMentions: [] };
  for (const item of chosen) {
    let feature: Record<string, string>;
    if (item.kind === 'link') {
      feature = { $type: 'app.bsky.richtext.facet#link', uri: item.value };
      result.links++;
    } else if (item.kind === 'tag') {
      feature = { $type: 'app.bsky.richtext.facet#tag', tag: item.value };
      result.tags++;
    } else {
      const did = dids.get(item.value);
      if (!did) {
        if (!result.unresolvedMentions.includes(item.value)) result.unresolvedMentions.push(item.value);
        continue;
      }
      feature = { $type: 'app.bsky.richtext.facet#mention', did };
      result.mentions++;
    }
    const byteStart = utf8Length(text.slice(0, item.start));
    result.facets.push({
      index: { byteStart, byteEnd: byteStart + utf8Length(text.slice(item.start, item.end)) },
      features: [feature],
    });
  }
  return result;
}
