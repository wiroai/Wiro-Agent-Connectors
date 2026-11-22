# Shopify connector (`shopify`)

Runs a [Shopify](https://www.shopify.com) store through the GraphQL Admin API, pinned to version 2026-07: products with their options, variants, images and SEO (created as drafts, never twice by handle or SKU), prices and SKUs, sales channel publishing, collections, stock per location set with a compare-and-swap check and an idempotency key, orders with their fulfillment orders, fulfillments with tracking, customers, discount codes, and any other query or mutation of the Admin API with `graphql_query` and `graphql_mutation`.

Credential check: `get_shop` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `shopdomain` | `SHOPIFY_SHOPDOMAIN` | The store's own `<shop>.myshopify.com` address, such as `example-shop.myshopify.com`. Not a custom domain. |
| `access_token` | `SHOPIFY_ACCESS_TOKEN` | An Admin API access token of an app installed on that store. |

Both are required. The token goes to that store only, in the `X-Shopify-Access-Token` header. The store address is a [credential origin](../../../README.md#credential-origins): hosts check it like a media URL (https, public addresses only) and never follow its redirects; the connector also refuses any host that is not `<shop>.myshopify.com`.

### The store address

In the Shopify admin, open **Settings → Domains**: the `myshopify.com` domain is listed there (it is also in the admin's address bar, `admin.shopify.com/store/<shop>`, as `<shop>.myshopify.com`).

### The access token

A host that connects Shopify for you gets the token itself and refreshes it: either by a sign-in with your own Shopify app (OAuth, for a store in any organization), or by exchanging your app's client ID and secret (client credentials, for a store in the same Shopify organization as the app). The connector only receives the current token; it never refreshes or stores it.

To get a token yourself (for the CLI), with an app in the Shopify Dev Dashboard:

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard), choose **Create app**, and name it (for example `AI agent`).
2. In the app's version settings, choose the Admin API access scopes the tools need: `read_products`, `write_products`, `read_publications`, `write_publications`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`, `write_orders`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`, `read_returns`, `read_customers`, `write_customers`, `read_discounts`, `write_discounts`. Leave out what you do not want the agent to do. Release the version.
3. Install the app on the store from its page in the Dev Dashboard, then copy its **Client ID** and **Client secret** from **Settings**.
4. If the store is in the same organization as the app, exchange them for a token: `POST https://<shop>.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`, `client_id` and `client_secret` as a form (`application/x-www-form-urlencoded`). The answer's `access_token` lasts 24 hours. For a store in another organization, run the app's OAuth sign-in instead.

Names, emails, phone numbers and addresses of customers are protected customer data: Shopify returns them only after the app is given that access (in the Partner or Dev Dashboard, under the app's API access settings). Until then the tools still work and report the withheld fields as warnings.

**Revoke it:** in the Shopify admin, **Settings → Apps**, open the app and **Uninstall** it: its tokens stop working at once. In the Dev Dashboard you can also rotate the app's client secret, which ends the tokens minted with the old one.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_shop` | read | The shop (name, domains, currency, time zone, plan) and the access scopes the app was granted. |
| `list_products` | read | Products, most recently updated first, by Shopify search syntax: id, title, handle, status, vendor, type, tags, price range, variants, stock and image. |
| `get_product` | read | One product by id or handle: description, SEO, options, media, collections, and its variants (100 at a time) with prices, SKUs, stock and inventory item ids. |
| `create_product` | create | A product with options, variants (price, compare-at price, SKU, barcode, stock per location) and images from public URLs, in one request; a draft by default. Refuses a handle or SKU in use unless `allow_duplicates`. |
| `update_product` | update | Title, description, vendor, type, tags, handle (the old URL redirects), status, SEO, manual collections to join or leave, and images to add. |
| `update_variants` | update | Prices, compare-at prices, SKUs, barcodes, inventory policy, tracking, cost and shipping of one product's variants, all or nothing. |
| `list_publications` | read | The sales channels (Online Store, Point of Sale, ...) with their ids, or where one product is published. |
| `publish_product` | update | Publishes a product on sales channels, or takes it off them. |
| `list_collections` | read | Collections with product counts and, for smart collections, their rules. |
| `list_locations` | read | The shop's locations with their ids. |
| `get_inventory` | read | One variant's stock at each location: available, on hand, committed, incoming, reserved. |
| `set_inventory_quantity` | update | Sets a variant's available (or on-hand) quantity at a location only if the stock is still what was seen; the same call within 15 minutes is applied once. |
| `list_orders` | read | Orders, newest first, by search syntax: name, date, payment and fulfillment status, total, refunds, items, returns, tags. No customer details. |
| `get_order` | read | One order by id or name: totals, line items, fulfillment orders with what is left to ship, fulfillments with tracking, refunds; customer, email, phone and addresses on request. |
| `fulfill_order` | create | Ships what is left of a fulfillment order, or given items, with tracking; optionally emails the customer. |
| `list_customers` | read | Customers by search syntax: name, state, orders, amount spent, tags, and email and phone on request. |
| `list_discounts` | read | Code and automatic discounts with their codes, dates, usage and summary, or one by exact code. |
| `create_discount_code` | create | A percentage or fixed-amount code for all items or some products, variants or collections, with dates, usage limits, a minimum and combinations. |
| `graphql_query` | read | Any GraphQL query of the Admin API, with its cost. |
| `graphql_mutation` | write | Any GraphQL mutation (customers, cancels, refunds, collections, variants, deletes, ...). Sent once, never retried. |

## Limits

- What each call may do follows the app's access scopes and, for fulfillments and some order changes, the staff permissions of the store.
- Shopify meters GraphQL by query cost: a query may cost at most 1,000 points, and a throttled call comes back with `retryAfter`. List tools ask for at most 100 items a page.
- Orders older than 60 days need the `read_all_orders` scope, which Shopify grants on request.
- `create_product` creates up to 100 variants; add more with `productVariantsBulkCreate` through `graphql_mutation`. Images come from public URLs that Shopify fetches itself; videos and 3D models need Shopify's staged uploads, which the connector does not do.
- `graphql_query` refuses mutations. `graphql_mutation` refuses webhook subscriptions and new access tokens, and requires `@idempotent(key: ...)` on the mutations that need it in this API version (inventory changes and `refundCreate`). Bulk operations can be started and checked through them, but the connector does not download their result file.
- Writes are never retried: one whose outcome is unclear comes back as unknown, with the read tool to check first.

## README rows

Connectors table:

```markdown
| `shopify` | [Shopify](https://www.shopify.com) through the GraphQL Admin API: products, variants and images, publishing, collections, stock per location, orders and fulfillments, customers, discount codes, and any other query or mutation | Store address and Admin API access token | Available |
```

Quick start table:

```markdown
| `shopify` | `SHOPIFY_SHOPDOMAIN`, `SHOPIFY_ACCESS_TOKEN` | The store's `<shop>.myshopify.com` address, and an Admin API access token of your own app installed on it (OAuth, or client credentials for a store in the app's organization). |
```

Tools: the table above, under `### shopify`.
