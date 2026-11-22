import { truncate } from '../../core/index.js';
import { compact } from './catalog.js';

// The live store listing as Google Play shows it to people, read from the
// app's public store page: the app's structured data (name, short
// description, category, developer, rating, price) and its full description.
// Reading it changes nothing, and needs no permission in Play Console.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function character(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : fallback;
}

/** HTML character references as text: &amp; &#39; &#x27; ... */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,6});/g, (whole, name: string) => {
    if (name[0] === '#') return character(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10), whole);
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** A piece of store page HTML as plain text: line breaks kept, tags dropped. */
function htmlText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** The app's details from its store page, or undefined when the page has none. */
export function parseStorePage(html: string): Record<string, unknown> | undefined {
  let app: any;
  for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data: unknown = JSON.parse(match[1] as string);
      const type = (data as { '@type'?: unknown } | null)?.['@type'];
      if (type === 'SoftwareApplication' || type === 'MobileApplication' || type === 'VideoGame') {
        app = data;
        break;
      }
    } catch {
      // another block, or not JSON
    }
  }
  const description = /<div[^>]*\bdata-g-id="description"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (!app && description === undefined) return undefined;
  const offers: any[] = Array.isArray(app?.offers) ? app.offers : app?.offers ? [app.offers] : [];
  const price = numberOf(offers[0]?.price);
  const rating = numberOf(app?.aggregateRating?.ratingValue);
  return compact({
    title: typeof app?.name === 'string' ? app.name : undefined,
    shortDescription: typeof app?.description === 'string' ? app.description : undefined,
    fullDescription: description !== undefined ? truncate(htmlText(description), 6000) : undefined,
    category: app?.applicationCategory,
    contentRating: app?.contentRating,
    developer: app?.author?.name,
    developerWebsite: app?.author?.url,
    rating: rating !== undefined ? Math.round(rating * 100) / 100 : undefined,
    ratingCount: numberOf(app?.aggregateRating?.ratingCount),
    price: price === undefined ? undefined : price === 0 ? 'free' : { amount: price.toFixed(2), currency: offers[0]?.priceCurrency },
    icon: typeof app?.image === 'string' ? app.image : undefined,
  });
}
