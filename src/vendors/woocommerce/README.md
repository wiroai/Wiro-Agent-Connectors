# WooCommerce connector (`woocommerce`)

Runs your own [WooCommerce](https://woocommerce.com) store through its REST API v3: products (simple and variable, with their variations, images from public URLs, categories, tags and attributes), prices and sales, stock that is checked before it is changed, orders (status, notes, refunds), coupons, customers, sales and top-seller reports, categories, tags, attribute values and shipping classes (never created twice), and the rest of the API with `api_get` and `api_request`.

Credential check: `list_products` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `storeurl` | `WOOCOMMERCE_STOREURL` | The store's WordPress address, such as `https://store.example.com`, with its subdirectory when WordPress is installed in one (`https://example.com/shop`). It must be https. |
| `consumerkey` | `WOOCOMMERCE_CONSUMERKEY` | The consumer key of a WooCommerce REST API key (`ck_…`). |
| `consumersecret` | `WOOCOMMERCE_CONSUMERSECRET` | The consumer secret of that key (`cs_…`). |

All three are required. The connector sends requests to that store only, signed with HTTP Basic auth over https; the key never goes in a URL. The address is a [credential origin](../../../README.md#credential-origins): hosts check it like a media URL (https, public addresses only) and never follow its redirects.

### The store address

1. In the WordPress admin, open **Settings → General**.
2. Copy **WordPress Address (URL)**. It is not the address of the shop page: for a store whose shop page is `https://example.com/shop/` and whose WordPress runs at `https://example.com`, use `https://example.com`.

The REST API needs permalinks other than **Plain** (**Settings → Permalinks**).

### A REST API key

1. Create a WordPress user just for the connector with the **Shop manager** role (**Users → Add New User**), so the key can do only what a shop manager can.
2. Open **WooCommerce → Settings → Advanced → REST API** and click **Add key** (or **Create an API key**).
3. Enter a description (for example `AI agent`), choose that user, and set **Permissions** to **Read** to only look, or **Read/Write** to change products, orders, coupons and the rest.
4. Click **Generate API key** and copy the consumer key and consumer secret. The secret is shown only once.

If WooCommerce answers that it cannot list resources although the key is right, the site's server is dropping the Authorization header: your host can pass it through.

**Revoke it:** **WooCommerce → Settings → Advanced → REST API**, hover over the key and click **Revoke**. Requests fail with a 401 at once.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_products` | read | Products, newest first: id, name, type, status, SKU, prices, sale, stock, variation count, categories, sales and link; by search words, exact SKU, status, type, category, tag, stock status or sale. |
| `get_product` | read | One product with prices, stock and who manages it, description, images, categories, tags, attributes, shipping and tax fields, and a variable product's variations, page by page. |
| `create_product` | create | A product, a draft by default: prices, SKU, stock, description, images from public URLs, categories, tags, attributes, and for a variable product its variations, created right after it (failures are listed). Other API fields go in `more_fields`. |
| `update_product` | update | Changes a product or one of its variations: prices, sale, stock, status, text, images, categories and other fields. With `expected_stock_quantity` it reads the stock first and changes nothing if it moved; stock a parent product manages is not changed on the variation. |
| `list_orders` | read | Orders, newest first: number, status, dates, total, customer id, payment method, items and refunds; by status, customer, product, dates or search words. No contact details. |
| `get_order` | read | One order with line items, shipping, fees, coupons, totals and refunds; notes and the billing and shipping details on request. |
| `update_order` | update | Changes an order's status, customer note, or billing and shipping details. |
| `add_order_note` | create | Adds a private note, or a note emailed to the customer. |
| `create_refund` | create | Records a refund of an amount, optionally per line item; it refunds through the payment gateway and restocks the items only when asked. |
| `list_coupons` | read | Coupons with discount, expiry, usage and restrictions, or one by exact code. |
| `create_coupon` | create | A coupon: percent, fixed cart or fixed product discount, expiry, usage limits, minimum and maximum spend, products, categories and allowed emails. |
| `list_customers` | read | Customers with id, email, name, user name, role and whether they have paid; by search words or exact email. |
| `get_report` | read | Sales for a period or date range with a line per day or month, top sellers, or the counts of orders, products, customers, coupons and reviews. |
| `list_terms` | read | Product categories, tags, global attributes, an attribute's values, or shipping classes. |
| `create_term` | create | A category, tag, attribute value or shipping class; an existing one with that name or slug comes back with `existing: true`. |
| `api_get` | read | Any other GET under `/wc/v3/` (or the `/wc-analytics/` reports), such as `/wc/v3/customers/12` or `/wc/v3/settings/general`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/wc/v3/`, such as a batch update, a customer change or a deletion (`force=true`). Sent once, never retried. |

## Limits

- What the key may do follows its permissions (Read or Read/Write) and its user's role.
- `create_refund` only records the refund unless `refund_payment` is true, and restocks only with `restock_items`; a refund cannot be undone. `update_order` cannot set the refunded status: use `create_refund`.
- Batch endpoints take at most 100 items per request in all, and answer item by item: check every result.
- `api_get` and `api_request` refuse paths outside `/wc/v3/` (the `/wc-analytics/` reports are read-only), changes to webhooks, payment gateways and system status tools, and the `_method` and `rest_route` query parameters, which would change a request's method or route.
- WooCommerce itself sets no rate limit; a host or security plugin may, and its 429 comes back with `retryAfter`.
- Writes are never retried: one whose outcome is unclear comes back as unknown, with the read tool to check first.

## README rows

Connectors table:

```markdown
| `woocommerce` | [WooCommerce](https://woocommerce.com) on your own store: products and variations, prices, stock checked before it changes, orders, notes and refunds, coupons, customers, sales reports, categories and attributes, and the rest of the REST API v3 | Store URL and REST API key | Available |
```

Quick start table:

```markdown
| `woocommerce` | `WOOCOMMERCE_STOREURL`, `WOOCOMMERCE_CONSUMERKEY`, `WOOCOMMERCE_CONSUMERSECRET` | The store's WordPress address (with its subdirectory, if any), and a REST API key from WooCommerce → Settings → Advanced → REST API (Read, or Read/Write for changes). |
```

Tools: the table above, under `### woocommerce`.
