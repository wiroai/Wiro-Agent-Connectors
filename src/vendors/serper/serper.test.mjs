import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'serper-test-key-0123456789';
const credentials = { apikey: KEY };
const search = fixture(import.meta.url, 'search.json');

/** A value from the module's sandbox, as plain JSON of this realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

test('the module reads one credential, apikey, and reaches only the two Serper origins', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.origins), ['https://google.serper.dev', 'https://api.serper.dev']);
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.accountPickers), []);
  assert.deepEqual(plain(module.tools.map((tool) => tool.name)), [
    'web_search', 'news_search', 'image_search', 'video_search', 'places_search', 'maps_search', 'place_reviews',
    'shopping_search', 'scholar_search', 'patent_search', 'autocomplete', 'lens_search', 'find_locations',
  ]);
  // Every tool only reads.
  for (const tool of module.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
});

test('web_search posts the query to Serper with the key header and returns trimmed results', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const { payload, isError } = await callTool(module, 'web_search', { q: 'model context protocol', num: 3, gl: 'US', hl: 'en', tbs: 'qdr:w' }, ctx);

  assert.equal(isError, false);
  assert.equal(fetch.calls.length, 1);
  const [request] = fetch.calls;
  assert.equal(request.url, 'https://google.serper.dev/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], KEY);
  assert.equal(request.headers['content-type'], 'application/json');
  // Country and language codes go out in lower case.
  assert.deepEqual(request.json, { q: 'model context protocol', num: 3, page: 1, gl: 'us', hl: 'en', tbs: 'qdr:w' });

  assert.equal(payload.query, 'model context protocol');
  assert.deepEqual(payload.results[0], {
    position: 1,
    title: 'Introduction - Model Context Protocol',
    link: 'https://modelcontextprotocol.io/introduction',
    snippet: 'MCP is an open protocol that standardizes how applications provide context to LLMs.',
  });
  assert.equal(payload.results[1].date, 'Jun 18, 2025');
  assert.equal(payload.results.length, 3);
  assert.equal(payload.answerBox.title, 'What is the Model Context Protocol?');
  assert.equal(payload.knowledgeGraph.attributes.License, 'MIT');
  assert.equal(payload.peopleAlsoAsk[0].question, 'What is MCP used for?');
  assert.deepEqual(payload.relatedSearches, ['model context protocol server', 'mcp specification']);
  // Fields an agent does not need are left out.
  assert.equal('sitelinks' in payload.results[0], false);
  assert.equal('credits' in payload, false);
  // A full page means there may be more: the cursor asks for page 2.
  assert.equal(typeof payload.nextCursor, 'string');
});

test('location and a starting page go to Serper; the cursor goes on from that page', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const first = await callTool(module, 'web_search', { q: 'pizza', num: 3, page: 3, location: 'Austin,Texas,United States' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { q: 'pizza', num: 3, page: 3, location: 'Austin,Texas,United States' });
  assert.equal(first.payload.page, 3);
  assert.equal(first.payload.answerBox, undefined, 'the extras come with page 1 only');
  await callTool(module, 'web_search', { q: 'pizza', num: 3, page: 3, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 4);
});

test('the cursor fetches the next page, without the first page extras', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const first = await callTool(module, 'web_search', { q: 'model context protocol', num: 3 }, ctx);
  const second = await callTool(module, 'web_search', { q: 'model context protocol', num: 3, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 2);
  assert.equal(second.payload.page, 2);
  assert.equal(second.payload.answerBox, undefined);
  assert.equal(second.payload.relatedSearches, undefined);
});

test('a short page has no cursor, and page 10 is the last a cursor goes to', async () => {
  const { module, ctx } = setup(() => jsonResponse(200, { organic: search.organic.slice(0, 1) }));
  const { payload } = await callTool(module, 'web_search', { q: 'x' }, ctx);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.nextCursor, undefined);

  const full = setup(() => jsonResponse(200, search));
  const last = await callTool(full.module, 'web_search', { q: 'x', num: 3, page: 10 }, full.ctx);
  assert.equal(last.payload.nextCursor, undefined);
});

test('a result over 32 KB is cut, and the cursor continues on the same page after the last result returned', async () => {
  const organic = Array.from({ length: 20 }, (_, index) => ({
    position: index + 1,
    title: `Result ${index + 1} `.padEnd(300, 't'),
    link: `https://example.com/${index + 1}/`.padEnd(1900, 'l'),
    snippet: 's'.repeat(600),
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { organic }));
  const first = await callTool(module, 'web_search', { q: 'long', num: 20 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024, `result is ${textBytes(first.result)} bytes`);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.results.length;
  assert.ok(shown > 0 && shown < 20);

  const second = await callTool(module, 'web_search', { q: 'long', num: 20, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 1, 'same Serper page');
  assert.equal(second.payload.results[0].position, shown + 1);
});

// Each search tab: the endpoint, the body, and the first trimmed result.
const tabs = [
  {
    tool: 'news_search',
    args: { q: 'electric bikes', num: 3, tbs: 'qdr:d', gl: 'us' },
    path: '/news',
    body: { q: 'electric bikes', num: 3, page: 1, tbs: 'qdr:d', gl: 'us' },
    file: 'news.json',
    key: 'news',
    first: {
      position: 1,
      title: 'City expands its e-bike rebate program',
      link: 'https://news.example.com/2026/11/ebike-rebate',
      snippet: 'The rebate now covers cargo bikes and adaptive models for residents of every district.',
      date: '2 hours ago',
      source: 'Example News',
    },
  },
  {
    tool: 'image_search',
    args: { q: 'red panda', num: 2 },
    path: '/images',
    body: { q: 'red panda', num: 2, page: 1 },
    file: 'images.json',
    key: 'images',
    first: {
      position: 1,
      title: 'Red panda resting on a branch',
      imageUrl: 'https://photos.example.com/red-panda-branch.jpg',
      imageWidth: 1920,
      imageHeight: 1280,
      thumbnailUrl: 'https://encrypted-tbn0.example.com/images?q=tbn:red-panda-1',
      source: 'Example Photos',
      domain: 'photos.example.com',
      link: 'https://photos.example.com/animals/red-panda',
    },
  },
  {
    tool: 'video_search',
    args: { q: 'sourdough starter', num: 2, hl: 'en' },
    path: '/videos',
    body: { q: 'sourdough starter', num: 2, page: 1, hl: 'en' },
    file: 'videos.json',
    key: 'videos',
    first: {
      position: 1,
      title: 'How to make a sourdough starter from scratch',
      link: 'https://video.example.com/watch?v=abc123',
      snippet: 'Day by day: flour, water and patience.',
      date: 'Mar 3, 2026',
      duration: '12:41',
      source: 'Example Video',
      channel: 'Example Bakery',
      imageUrl: 'https://img.example.com/vi/abc123/default.jpg',
    },
  },
  {
    tool: 'places_search',
    args: { q: 'coffee shops in Austin', location: 'Austin,Texas,United States' },
    path: '/places',
    body: { q: 'coffee shops in Austin', page: 1, location: 'Austin,Texas,United States' },
    file: 'places.json',
    key: 'places',
    first: {
      position: 1,
      title: 'Example Coffee Roasters',
      address: '100 Example St, Austin, TX 78701',
      latitude: 30.2672,
      longitude: -97.7431,
      rating: 4.6,
      ratingCount: 1284,
      category: 'Coffee shop',
      phoneNumber: '(512) 555-0100',
      website: 'https://coffee.example.com/',
      cid: '1234567890123456789',
    },
  },
  {
    tool: 'shopping_search',
    args: { q: 'trail running shoes', num: 2, autocorrect: false },
    path: '/shopping',
    body: { q: 'trail running shoes', num: 2, page: 1, autocorrect: false },
    file: 'shopping.json',
    key: 'products',
    first: {
      position: 1,
      title: 'Example Trail Runner 3',
      source: 'Example Outdoors',
      link: 'https://shop.example.com/trail-runner-3',
      price: '$129.99',
      delivery: 'Free delivery',
      rating: 4.5,
      ratingCount: 862,
      offers: '12 offers',
      productId: '1234567890987654321',
      imageUrl: 'https://images.example.com/trail-runner-3.jpg',
    },
  },
  {
    tool: 'scholar_search',
    args: { q: 'retrieval augmented generation' },
    path: '/scholar',
    body: { q: 'retrieval augmented generation', page: 1 },
    file: 'scholar.json',
    key: 'papers',
    first: {
      position: 1,
      title: 'Retrieval methods for language models: a survey',
      link: 'https://papers.example.org/abs/2601.00001',
      publicationInfo: 'A Author, B Author - Journal of Examples, 2026 - papers.example.org',
      snippet: 'We survey retrieval methods that ground language model answers in documents.',
      year: 2026,
      citedBy: 154,
      pdfUrl: 'https://papers.example.org/pdf/2601.00001',
      id: 'AbCdEfGhIjKl',
    },
  },
  {
    tool: 'patent_search',
    args: { q: 'foldable bicycle frame', num: 1 },
    path: '/patents',
    body: { q: 'foldable bicycle frame', num: 1, page: 1 },
    file: 'patents.json',
    key: 'patents',
    first: {
      position: 1,
      title: 'Folding frame for a bicycle',
      snippet: 'A bicycle frame with a hinge that locks in the riding position.',
      link: 'https://patents.example.com/patent/US0000001B2/en',
      publicationNumber: 'US0000001B2',
      priorityDate: '2021-04-02',
      filingDate: '2022-03-30',
      grantDate: '2024-08-13',
      publicationDate: '2024-08-13',
      inventor: 'C. Inventor',
      assignee: 'Example Cycles Inc',
      language: 'en',
      pdfUrl: 'https://patentimages.example.com/pdfs/US0000001.pdf',
    },
  },
];

for (const tab of tabs) {
  test(`${tab.tool} posts to ${tab.path} and returns trimmed ${tab.key}`, async () => {
    const reply = fixture(import.meta.url, tab.file);
    const { module, fetch, ctx } = setup(() => jsonResponse(200, reply));
    const { payload, isError } = await callTool(module, tab.tool, tab.args, ctx);
    assert.equal(isError, false, JSON.stringify(payload));
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, `https://google.serper.dev${tab.path}`);
    assert.equal(fetch.calls[0].method, 'POST');
    assert.equal(fetch.calls[0].headers['x-api-key'], KEY);
    assert.deepEqual(fetch.calls[0].json, tab.body);
    assert.deepEqual(payload[tab.key][0], tab.first);
    assert.equal(payload.query, tab.args.q);
    assert.equal(payload.creditsUsed, 1);
  });
}

test('inline data: images are left out; linked images stay', async () => {
  const news = setup(() => jsonResponse(200, fixture(import.meta.url, 'news.json')));
  const { payload } = await callTool(news.module, 'news_search', { q: 'electric bikes', num: 3 }, news.ctx);
  assert.equal('imageUrl' in payload.news[0], false);
  assert.equal(payload.news[1].imageUrl, 'https://images.example.org/ebike-battery.jpg');
  assert.ok(!JSON.stringify(payload).includes('base64'));

  for (const [tool, file, key] of [['image_search', 'images.json', 'images'], ['shopping_search', 'shopping.json', 'products']]) {
    const { module, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, file)));
    const result = await callTool(module, tool, { q: 'x', num: 2 }, ctx);
    assert.ok(!JSON.stringify(result.payload).includes('data:image'), tool);
    assert.equal(result.payload[key].length, 2);
  }
});

test('a tab whose page is full offers the next page; one that is not, does not', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'news.json')));
  const full = await callTool(module, 'news_search', { q: 'electric bikes', num: 3 }, ctx);
  assert.equal(typeof full.payload.nextCursor, 'string');
  await callTool(module, 'news_search', { q: 'electric bikes', num: 3, cursor: full.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 2);

  const short = await callTool(module, 'news_search', { q: 'electric bikes', num: 10 }, ctx);
  assert.equal(short.payload.nextCursor, undefined);

  // Places take no num: a page of 10 counts as full.
  const places = setup(() => jsonResponse(200, fixture(import.meta.url, 'places.json')));
  const two = await callTool(places.module, 'places_search', { q: 'coffee' }, places.ctx);
  assert.equal(two.payload.nextCursor, undefined);
});

test('maps_search sends ll, place_id as placeId and cid, and returns the ids place_reviews takes', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'maps.json')));
  const { payload } = await callTool(module, 'maps_search', { q: 'bookstore', ll: '@40.7128,-74.006,14z', place_id: 'ChIJExampleBooks0001', cid: '1122334455667788990' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://google.serper.dev/maps');
  assert.deepEqual(fetch.calls[0].json, { q: 'bookstore', ll: '@40.7128,-74.006,14z', placeId: 'ChIJExampleBooks0001', cid: '1122334455667788990', page: 1 });
  assert.equal(payload.ll, '@40.7128,-74.006,14z');
  assert.equal(payload.creditsUsed, 3);
  const [place] = payload.places;
  assert.deepEqual(place.openingHours, { Monday: '10 AM–8 PM', Tuesday: '10 AM–8 PM', Sunday: '11 AM–6 PM' });
  assert.deepEqual(place.types, ['Book store', 'Cafe']);
  assert.equal(place.priceLevel, '$$');
  assert.equal(place.fid, '0x89c25a197c06b7cb:0x40a06c78f79e5de6');
  assert.equal(place.placeId, 'ChIJExampleBooks0001');
  assert.equal('thumbnailUrl' in place, false);

  const bad = await callTool(module, 'maps_search', { q: 'bookstore', ll: '40.7,-74.0' }, ctx);
  assert.match(bad.payload.error, /`ll` does not have the expected format/);
  assert.equal(fetch.calls.length, 1);
});

test('place_reviews needs a place id, pages with Serper\'s token, and gives the topics with the first page only', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'reviews.json')));
  const none = await callTool(module, 'place_reviews', { sort_by: 'newest' }, ctx);
  assert.equal(none.isError, true);
  assert.match(none.payload.error, /Give the place's cid, fid or place_id .*Nothing was sent to Serper\./);
  assert.equal(fetch.calls.length, 0);

  const first = await callTool(module, 'place_reviews', { fid: '0x89c25a197c06b7cb:0x40a06c78f79e5de6', sort_by: 'newest' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://google.serper.dev/reviews');
  assert.deepEqual(fetch.calls[0].json, { fid: '0x89c25a197c06b7cb:0x40a06c78f79e5de6', sortBy: 'newest' });
  assert.deepEqual(first.payload.reviews[0], {
    rating: 5,
    date: 'a week ago',
    isoDate: '2026-11-14T18:22:05.000Z',
    snippet: 'Great selection of new fiction and a quiet reading room upstairs.',
    likes: 3,
    user: { name: 'A. Reader', reviews: 41, photos: 12 },
    response: { date: '6 days ago', snippet: 'Thank you for visiting! See you at the next author talk.' },
  });
  assert.deepEqual(first.payload.topics, [
    { id: '/m/0examplereading', keyword: 'reading room', count: 58 },
    { id: '/m/0exampleevents', keyword: 'author talks', count: 21 },
  ]);

  const second = await callTool(module, 'place_reviews', { fid: '0x89c25a197c06b7cb:0x40a06c78f79e5de6', sort_by: 'newest', cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.nextPageToken, 'CAESY0NBRVFBUnBmQ2hVSWF4RVNaWGhoYlhCc1pTMXdZV2RsTFhSdmEyVnU');
  assert.equal(second.payload.topics, undefined);

  const last = setup(() => jsonResponse(200, { reviews: [] }));
  const end = await callTool(last.module, 'place_reviews', { cid: '1122334455667788990' }, last.ctx);
  assert.deepEqual(end.payload.reviews, []);
  assert.equal(end.payload.nextCursor, undefined);
});

test('autocomplete returns the suggestions in order', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'autocomplete.json')));
  const { payload } = await callTool(module, 'autocomplete', { q: 'best running shoes for', gl: 'us' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://google.serper.dev/autocomplete');
  assert.deepEqual(fetch.calls[0].json, { q: 'best running shoes for', gl: 'us' });
  assert.deepEqual(payload, {
    query: 'best running shoes for',
    suggestions: ['best running shoes for flat feet', 'best running shoes for women', 'best running shoes for knee pain'],
    creditsUsed: 1,
  });
});

test('lens_search sends the image URL and returns the matches', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'lens.json')));
  const { payload } = await callTool(module, 'lens_search', { url: 'https://images.example.com/lamp.jpg' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://google.serper.dev/lens');
  assert.deepEqual(fetch.calls[0].json, { url: 'https://images.example.com/lamp.jpg' });
  assert.deepEqual(payload.matches[0], {
    position: 1,
    title: 'Example brass desk lamp',
    source: 'Example Home',
    link: 'https://home.example.com/brass-desk-lamp',
    price: '$89.00',
    inStock: true,
    imageUrl: 'https://home.example.com/media/brass-desk-lamp.jpg',
    thumbnailUrl: 'https://encrypted-tbn1.example.com/images?q=tbn:lamp-1',
  });
  // Serper names the list visualMatches in some replies.
  const other = setup(() => jsonResponse(200, { visualMatches: [{ title: 'Lamp', link: 'https://shop.example.com/lamp' }] }));
  const matches = await callTool(other.module, 'lens_search', { url: 'https://images.example.com/lamp.jpg' }, other.ctx);
  assert.deepEqual(matches.payload.matches, [{ title: 'Lamp', link: 'https://shop.example.com/lamp' }]);

  const notUrl = await callTool(module, 'lens_search', { url: 'file:///etc/passwd' }, ctx);
  assert.match(notUrl.payload.error, /`url` must be an absolute http\(s\) URL/);
});

test('find_locations reads the public list without the key', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, fixture(import.meta.url, 'locations.json')));
  const { payload } = await callTool(module, 'find_locations', { q: 'austin', limit: 3 }, ctx);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, 'https://api.serper.dev/locations?q=austin&limit=3');
  assert.equal(fetch.calls[0].headers['x-api-key'], undefined, 'the key is not sent where it is not needed');
  assert.deepEqual(payload.locations[0], { name: 'Austin, TX', canonicalName: 'Austin,TX,Texas,United States', countryCode: 'US', targetType: 'DMA Region' });
  assert.equal(payload.locations.length, 3);
});

test('Serper errors become clear tool errors; a 429 carries retryAfter', async () => {
  const cases = [
    [() => jsonResponse(401, { message: 'Unauthorized.' }), 401, /Serper rejected the credentials \(HTTP 401\): Unauthorized\. Check that the Serper API key/],
    [() => jsonResponse(403, fixture(import.meta.url, 'error-403.json')), 403, /Serper refused the API key: it may be wrong, disabled, or out of credits \(HTTP 403\)\. Serper said: "Unauthorized\. Sign up for a free account\."/],
    [() => jsonResponse(403, { message: 'Not enough credits' }), 403, /out of credits \(HTTP 403\)\. Serper said: "Not enough credits"/],
    [() => jsonResponse(400, { message: 'Query is required' }), 400, /could not run this search/],
    [() => textResponse(429, 'Too many requests', { 'retry-after': '30' }), 429, /Serper rate limit reached \(HTTP 429\)\. Retry after 30 seconds\./],
    [() => jsonResponse(503, { message: 'Service unavailable' }), 503, /Serper had a server error \(HTTP 503\)/],
  ];
  for (const tool of ['web_search', 'image_search', 'autocomplete']) {
    for (const [respond, status, message] of cases) {
      const { module, ctx } = setup(respond);
      const { payload, isError } = await callTool(module, tool, { q: 'x' }, ctx);
      assert.equal(isError, true, `${tool} ${status}`);
      assert.equal(payload.status, status);
      assert.match(payload.error, message);
      if (status === 429) assert.equal(payload.retryAfter, 30);
    }
  }
});

test('a network failure says Serper could not be reached', async () => {
  const { module, ctx } = setup(() => {
    throw new TypeError('fetch failed');
  });
  const { payload, isError } = await callTool(module, 'web_search', { q: 'x' }, ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /Serper could not be reached \(fetch failed\)/);
});

test('bad arguments and a missing key are refused before any request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, search));
  const missing = await callTool(module, 'web_search', {}, ctx);
  assert.match(missing.payload.error, /`q` is required\. Nothing was sent to Serper\./);
  const unknown = await callTool(module, 'web_search', { query: 'x' }, ctx);
  assert.match(unknown.payload.error, /unknown argument "query" \(expected: q, num, page, gl, hl, location, tbs, autocorrect, cursor\)/);
  const range = await callTool(module, 'web_search', { q: 'x', num: 50 }, ctx);
  assert.match(range.payload.error, /`num` must be at most 20/);
  const page = await callTool(module, 'news_search', { q: 'x', page: 11 }, ctx);
  assert.match(page.payload.error, /`page` must be at most 10/);
  const tbs = await callTool(module, 'scholar_search', { q: 'x', tbs: 'qdr:d' }, ctx);
  assert.match(tbs.payload.error, /unknown argument "tbs"/);
  const badCursor = await callTool(module, 'web_search', { q: 'x', cursor: 'not-a-cursor' }, ctx);
  assert.match(badCursor.payload.error, /cursor is not valid/);
  const otherCursor = await callTool(module, 'news_search', { q: 'x', cursor: (await callTool(module, 'web_search', { q: 'x', num: 3 }, ctx)).payload.nextCursor }, ctx);
  assert.match(otherCursor.payload.error, /cursor is not valid for this tool/);
  assert.equal(fetch.calls.length, 1);

  const noKey = makeContext({ credentials: {}, fetch });
  const unconnected = await callTool(module, 'web_search', { q: 'x' }, noKey.ctx);
  assert.equal(unconnected.payload.error, 'Serper is not connected: the Serper API key is missing.');
  // The 0.1.0 name of the credential is not read any more.
  const oldName = makeContext({ credentials: { api_key: KEY }, fetch });
  assert.equal((await callTool(module, 'web_search', { q: 'x' }, oldName.ctx)).payload.error, 'Serper is not connected: the Serper API key is missing.');
  assert.equal(fetch.calls.length, 1);
});

test('log lines name the vendor, tool, status and duration, never the key or the query', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, search));
  await callTool(module, 'web_search', { q: 'very private query' }, ctx);
  await callTool(module, 'places_search', { q: 'very private place' }, ctx);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^serper web_search POST 200 \d+ms$/);
  assert.match(logs[1], /^serper places_search POST 200 \d+ms$/);
  assert.equal(logs.some((line) => line.includes(KEY) || line.includes('private')), false);
});
