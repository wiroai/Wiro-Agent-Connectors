# Keepa (`keepa`)

Amazon price, sales rank and offer history from [Keepa](https://keepa.com), with your own Keepa API key: prices now, 30 and 90 day averages, lows and highs, dated price and rank tables, product search, best sellers lists, categories and the product finder, on the 11 Amazon marketplaces Keepa covers. Read-only: nothing on Keepa or Amazon changes. Every call spends tokens from your Keepa plan, and every result reports the tokens left.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `keepa` | Amazon price and sales rank history from [Keepa](https://keepa.com): prices now, averages, lows and highs, dated price and rank tables, product search, best sellers, categories and the product finder on 11 marketplaces. Read-only, with the tokens left after every call | Keepa API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `keepa` | `KEEPA_APIKEY` | The 64-character private API access key on the [Keepa API page](https://keepa.com/api), on a paid Keepa API plan. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_token_status` | read | The token balance: tokens left (negative after a large call), refill rate, seconds to the next refill and, when the balance is below 1, when the next call can run. Free. |
| `get_products` | read | Up to 100 products by ASIN or by UPC, EAN or ISBN-13: title, brand, category, Amazon's bought-in-past-month bracket, then per series (Amazon, Buy Box, lowest New, FBA, FBM, Used, Warehouse, list price, sales rank, offers, rating, reviews) the value now, 30 and 90 day averages, the lowest and highest in the range and the lowest ever, with sales rank drops and the Buy Box now. Or one short row per product (`brief`). 1 token per product, plus the paid options. |
| `get_price_history` | read | Dated tables of up to 4 series of one product (one row per day, week or month: lowest, highest and last value, gaps marked), with the lowest and highest point and the product summary. 1 token, plus the option a series needs. |
| `search_products` | read | Up to 20 products for search words, in Amazon's order without sponsored results, with prices now and sales rank. 10 tokens. |
| `get_best_sellers` | read | A category's best sellers list, by current rank, a 30, 90 or 180 day average, or a past month: ranked ASINs from an offset. 50 tokens, nothing when Keepa has no list. |
| `search_categories` | read | Categories by name, largest first, with path, product count and average Buy Box price. 1 token. |
| `get_categories` | read | Up to 10 categories by id, or the root categories. 1 token. |
| `find_products` | read | The product finder: ASINs matching filters on category, price, sales rank, drops, monthly sales and more, with the total count. 10 tokens plus 1 per 100 ASINs. |
| `api_get` | read | Any other GET of the Keepa API, such as `/seller`, `/deal`, `/topseller` or `/lightningdeal`, with the key added. `/tracking` is not reachable. |

Marketplaces: `amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.fr`, `amazon.co.jp`, `amazon.ca`, `amazon.it`, `amazon.es`, `amazon.in`, `amazon.com.mx` and `amazon.com.br`. Keepa covers no other (not Amazon Türkiye, Australia, the Netherlands, Sweden, Poland, Belgium, the UAE, Saudi Arabia, Singapore or Egypt).

Connection check: `get_token_status` with no arguments (free).

## Credentials

**`apikey`: the Keepa API access key**

1. Sign in at [keepa.com](https://keepa.com) and open the [API page](https://keepa.com/api).
2. Subscribe to an API plan on that page. Keepa bills it monthly; plans differ in the tokens added per minute, and unused tokens expire after 60 minutes.
3. Copy your **private API access key** (64 letters and digits) from the API page and set it as `apikey`.

The key spends your plan's tokens, so keep it private. Keepa takes it only as the `key` query parameter of each request, so it is part of the request URL.

**Revoking it:** Keepa refuses a key whose account has no active API plan (HTTP 402): cancel the plan on keepa.com to cut it off, or ask Keepa support for a new access key.

## Limits

- Token costs: product 1 per product (`offers` 6 per 10 offers found instead, `buybox` 2 more, `stock` 2 more, `rating` up to 1 more, `historical_variations` 1 more for a product with a parent, `update_hours` 0 one more); search 10; best sellers 50 (0 without a list); category search or lookup 1; product finder 10 plus 1 per 100 ASINs; token status 0. Keepa runs a call while the balance is above zero and then charges its full cost, so the balance can go negative.
- Out of tokens, Keepa answers HTTP 429: the error says when the next call can run (from the free token status) and carries it as `retryAfter`. Nothing is retried.
- Prices come in the marketplace currency (yen without decimals), "no offer" when nothing was on offer, "no rank" without a sales rank. A sales rank is the rank in the product's main category, lower is better; a rating is in stars. Dates are UTC.
- New and Used: until 2026-02-22 the lowest listing price, from 2026-02-23 the lowest price with shipping; a history table that spans that day says so.
- A history call returns at most 250 rows over all its series; a `get_products` result over 32 KB is cut, and `nextCursor` loads the products left out again (charged again): ask for about 20 full summaries per call, or use `brief`.
- Keepa searches its own database, not Amazon's live catalog; the product finder covers products updated in the last 6 months unless `lastUpdate` is set.
- Keepa always compresses its replies; hosts must unpack them (as `fetch` does).
