// The fields an agent needs from each kind of Serper result. Serper passes
// on what Google shows, so every field is optional; anything that is not the
// expected type is left out, and long texts are cut. Inline images (data:
// URIs, often tens of kilobytes) are never passed on.

import { truncate } from '../../core/index.js';

export type Item = Record<string, unknown>;

export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** An http(s) URL of a sensible length; data: URIs and anything else are left out. */
export function url(value: unknown): string | undefined {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && value.length <= 2000 ? value : undefined;
}

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function record(value: unknown): Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Item) : {};
}

/** A list in a Serper reply, e.g. data.news; [] when absent. */
export function listOf(data: unknown, key: string): Item[] {
  const list = record(data)[key];
  return Array.isArray(list) ? list.map(record) : [];
}

function texts(value: unknown, max: number, count: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((item) => text(item, max)).filter((item): item is string => item !== undefined).slice(0, count);
  return list.length ? list : undefined;
}

export function trimOrganic(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    link: url(item['link']),
    snippet: text(item['snippet'], 600),
    date: text(item['date'], 40),
  });
}

export function trimAnswerBox(value: unknown) {
  const box = record(value);
  const trimmed = compact({
    title: text(box['title'], 300),
    answer: text(box['answer'], 600),
    snippet: text(box['snippet'], 1000),
    link: url(box['link']),
  });
  return Object.keys(trimmed).length ? trimmed : undefined;
}

export function trimKnowledgeGraph(value: unknown) {
  const graph = record(value);
  const rawAttributes = record(graph['attributes']);
  const attributes = Object.keys(rawAttributes).length
    ? Object.fromEntries(Object.entries(rawAttributes).slice(0, 12).map(([key, item]) => [truncate(key, 80), text(item, 200) ?? '']))
    : undefined;
  const trimmed = compact({
    title: text(graph['title'], 300),
    type: text(graph['type'], 120),
    description: text(graph['description'], 1000),
    website: url(graph['website']),
    attributes,
  });
  return Object.keys(trimmed).length ? trimmed : undefined;
}

export function trimNews(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    link: url(item['link']),
    snippet: text(item['snippet'], 600),
    date: text(item['date'], 60),
    source: text(item['source'], 120),
    imageUrl: url(item['imageUrl']),
  });
}

export function trimImage(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    imageUrl: url(item['imageUrl']),
    imageWidth: num(item['imageWidth']),
    imageHeight: num(item['imageHeight']),
    thumbnailUrl: url(item['thumbnailUrl']),
    source: text(item['source'], 120),
    domain: text(item['domain'], 200),
    link: url(item['link']),
  });
}

export function trimVideo(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    link: url(item['link']),
    snippet: text(item['snippet'], 600),
    date: text(item['date'], 60),
    duration: text(item['duration'], 30),
    source: text(item['source'], 120),
    channel: text(item['channel'], 200),
    imageUrl: url(item['imageUrl']),
  });
}

export function trimPlace(item: Item) {
  const hours = record(item['openingHours']);
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    address: text(item['address'], 300),
    latitude: num(item['latitude']),
    longitude: num(item['longitude']),
    rating: num(item['rating']),
    ratingCount: num(item['ratingCount']),
    priceLevel: text(item['priceLevel'], 20),
    category: text(item['category'], 120),
    type: text(item['type'], 120),
    types: texts(item['types'], 80, 10),
    description: text(item['description'], 600),
    phoneNumber: text(item['phoneNumber'], 60),
    website: url(item['website']),
    openingHours: Object.keys(hours).length
      ? Object.fromEntries(Object.entries(hours).slice(0, 7).map(([day, value]) => [truncate(day, 20), text(value, 100) ?? '']))
      : undefined,
    cid: text(item['cid'], 40),
    fid: text(item['fid'], 80),
    placeId: text(item['placeId'], 120),
  });
}

export function trimShopping(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    source: text(item['source'], 120),
    link: url(item['link']),
    price: text(item['price'], 60),
    delivery: text(item['delivery'], 120),
    rating: num(item['rating']),
    ratingCount: num(item['ratingCount']),
    offers: text(item['offers'], 60),
    productId: text(item['productId'], 80),
    imageUrl: url(item['imageUrl']),
  });
}

export function trimScholar(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    link: url(item['link']),
    publicationInfo: text(item['publicationInfo'], 300),
    snippet: text(item['snippet'], 600),
    year: num(item['year']),
    citedBy: num(item['citedBy']),
    pdfUrl: url(item['pdfUrl']),
    id: text(item['id'], 80),
  });
}

export function trimPatent(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    snippet: text(item['snippet'], 600),
    link: url(item['link']),
    publicationNumber: text(item['publicationNumber'], 60),
    priorityDate: text(item['priorityDate'], 20),
    filingDate: text(item['filingDate'], 20),
    grantDate: text(item['grantDate'], 20),
    publicationDate: text(item['publicationDate'], 20),
    inventor: text(item['inventor'], 300),
    assignee: text(item['assignee'], 300),
    language: text(item['language'], 20),
    pdfUrl: url(item['pdfUrl']),
  });
}

export function trimReview(item: Item) {
  const user = record(item['user']);
  const response = record(item['response']);
  const reply = compact({
    date: text(response['date'], 60),
    snippet: text(response['snippet'] ?? response['text'], 1000),
  });
  return compact({
    rating: num(item['rating']),
    date: text(item['date'], 60),
    isoDate: text(item['isoDate'], 40),
    snippet: text(item['snippet'], 1500),
    likes: num(item['likes']),
    user: Object.keys(user).length ? compact({ name: text(user['name'], 120), reviews: num(user['reviews']), photos: num(user['photos']) }) : undefined,
    response: Object.keys(reply).length ? reply : undefined,
  });
}

export function trimTopic(item: Item) {
  return compact({ id: text(item['id'], 120), keyword: text(item['keyword'], 120), count: num(item['count']) });
}

export function trimLensMatch(item: Item) {
  return compact({
    position: num(item['position']),
    title: text(item['title'], 300),
    source: text(item['source'], 120),
    link: url(item['link']),
    price: text(item['price'], 60),
    inStock: typeof item['inStock'] === 'boolean' ? item['inStock'] : undefined,
    imageUrl: url(item['imageUrl']),
    thumbnailUrl: url(item['thumbnailUrl']),
  });
}

export function trimLocation(item: Item) {
  return compact({
    name: text(item['name'], 200),
    canonicalName: text(item['canonicalName'], 300),
    countryCode: text(item['countryCode'], 4),
    targetType: text(item['targetType'], 60),
  });
}
