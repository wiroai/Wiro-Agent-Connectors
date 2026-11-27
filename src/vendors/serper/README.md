# Serper (`serper`)

Google search results as clean JSON through [Serper](https://serper.dev): the web with the answer box, knowledge graph and related questions, news, images, videos, local places, Google Maps with a place's reviews, shopping, scholar, patents, autocomplete suggestions and visual matches for an image. Read-only: every tool runs a search and changes nothing. Read the pages themselves with a fetch tool.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `serper` | Google search results through [Serper](https://serper.dev): the web (answer box, knowledge graph, related questions), news, images, videos, places, maps and place reviews, shopping, scholar, patents, autocomplete and image matches | Serper API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `serper` | `SERPER_APIKEY` | The API key on your [serper.dev](https://serper.dev) dashboard. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `web_search` | read | Google results for a query: title, link, snippet, position and date of each result, plus, on the first page, the answer box, knowledge graph, related questions and related searches. Options for country, language, location, freshness (past hour to past year) and the page. |
| `news_search` | read | Google News articles: title, link, snippet, source, date and image link, with the same options. |
| `image_search` | read | Google Images: each image's URL, size, thumbnail, title and the page it is on, up to 100 a page. |
| `video_search` | read | Google Videos: title, link, snippet, duration, source, channel, date and thumbnail. |
| `places_search` | read | Google's local results, such as "coffee shops in Austin": address, coordinates, rating and review count, category, phone, website and cid. |
| `maps_search` | read | Google Maps around a point (`ll`) or one place by place ID or cid: address, rating, price level, types, opening hours, phone, website and the cid, fid and placeId that `place_reviews` takes. Its cursor keeps the map position that pages after the first need. |
| `place_reviews` | read | The Google reviews of one place, by cid, fid or place ID: rating, date, text, likes, reviewer and owner reply, newest or most relevant first, plus the topics Google groups them by. |
| `shopping_search` | read | Google Shopping: products with price, shop, delivery, rating, offers and link, up to 40 a page. |
| `scholar_search` | read | Google Scholar: papers with publication, snippet, year, citation count and PDF link. |
| `patent_search` | read | Google Patents: publication number, priority, filing, grant and publication dates, inventor, assignee and PDF link. |
| `autocomplete` | read | The searches Google suggests for the start of a query, for keyword research. |
| `lens_search` | read | Pages and products that show an image, or look like it, by the image's public URL (Google Lens). |
| `find_locations` | read | The exact place names the `location` option takes, such as "Austin,TX,Texas,United States". Free. |

Every list pages with a cursor: pass `nextCursor` back as `cursor` for the next result page (or the rest of a page cut to fit 32 KB). `page` starts at a later page (1 to 10); for `maps_search` a later page also needs `ll`, which the cursor carries.

Connection check: no Serper call checks the key for free; `web_search` with `{"q": "test", "num": 1}` checks it for one credit.

## Credentials

**`apikey`: the Serper API key**

1. Sign up at [serper.dev](https://serper.dev). No credit card is needed, and new accounts start with free searches (2,500 at the time of writing).
2. Open the dashboard and copy your key from the **API Key** section.
3. Set it as `apikey`. There is no Google Cloud project, search engine id or key restriction to set up.

The key spends the account's credits, so keep it private. After the free searches, Serper sells credits in packs (about 1 US dollar per 1,000 searches, cheaper in larger packs).

**Revoking it:** the key lives on your serper.dev dashboard: change or remove it there, or ask Serper support to rotate it. A key whose credits are used up is refused too (HTTP 403).

## Limits

- Credits per call, as Serper counts them: 1 for a web, news, video, places, scholar, patent, reviews or autocomplete search; images 1, or 2 when `num` is over 10; shopping 2; maps 3; lens 3. `find_locations` is free. A refused key or an account out of credits answers HTTP 403.
- A page holds what Google shows on one: at most 10 web, news, video or patent results (`num` 1 to 10), up to 100 images, up to 40 shopping products. A full page offers `nextCursor` for the next one, up to page 10.
- Google Maps pages after the first need the map position (`ll`): `maps_search` refuses `page` over 1 without it, before sending, and its `nextCursor` carries the position the search used. A lookup by place ID or cid has one page.
- Results come as Google shows them at the time of the call: fields such as dates are Google's own text ("2 hours ago").
- Images that Google inlines in the page (data: URIs) are left out; linked images stay.
- Results are trimmed to the fields an agent needs and kept under 32 KB; a cut page continues with `nextCursor` (a new request, so new credits).
- A rate limit comes back as HTTP 429 with `retryAfter` when Serper sends it. Nothing is retried.
