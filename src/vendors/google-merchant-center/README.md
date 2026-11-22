# Google Merchant Center (`google-merchant-center`)

Product catalogs and feed health in [Google Merchant Center](https://merchants.google.com), through the Merchant API v1:

- the processed products with their status per destination and item issues, one product in full, and counts of issues across the catalog;
- product writes through API data sources: insert or replace a product input, change some of its attributes, delete it; list and create data sources;
- account-level issues (an unclaimed website, missing settings);
- Merchant Center Query Language reports: product performance (clicks, impressions, CTR, conversions), price competitiveness and insights, best sellers, competitive visibility;
- the rest of the API through `api_get` and `api_request`: business info, homepage and its claim, shipping settings, promotions, local and regional inventories, sub-accounts.

Typical uses: a daily feed health check, fixing a disapproved product's GTIN or price, pausing a product by marking it out of stock, a weekly report of the products with the most clicks.

## Credentials

| Credential | CLI variable | What it is |
| --- | --- | --- |
| `access_token` | `GOOGLE_MERCHANT_CENTER_ACCESS_TOKEN` | A Google OAuth access token for a Google account with access to the Merchant Center accounts, with the scope `https://www.googleapis.com/auth/content`. |

The token comes from an OAuth client in your own Google Cloud project. A host that runs this connector signs in with that client, refreshes the token and passes the current one on every call; the connector never stores or refreshes it.

### Where to get it

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one) and enable the [Merchant API](https://console.cloud.google.com/apis/library/merchantapi.googleapis.com).
2. In [Google Auth Platform, Audience](https://console.cloud.google.com/auth/audience), choose **External**. While the app is in **Testing**, only its test users can sign in, and Google ends their sign-in after 7 days: add your Google account as a test user, or set the publishing status to **In production**.
3. In [Data Access](https://console.cloud.google.com/auth/scopes), add the scope `https://www.googleapis.com/auth/content`.
4. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI your host gives you. Copy the client ID and the client secret into your host, which then signs you in.
5. Register the Cloud project with your Merchant Center account once (the API answers HTTP 401 "GCP project ... is not registered with the merchant account" until you do). With a token of an admin of the account, call `api_request` with `{"method": "POST", "path": "/accounts/v1/accounts/<ACCOUNT_ID>/developerRegistration:registerGcp", "json": {"developerEmail": "you@example.com"}}`, then wait about five minutes. The account needs a verified website; test accounts cannot be registered. Registering adds the email as an API developer user of the account.
6. For the CLI, get a token with the same client, for example in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with **Use your own OAuth credentials** (add `https://developers.google.com/oauthplayground` as a redirect URI first) and the scope above. It lasts one hour, and the CLI does not refresh it.

### How to revoke it

- In your Google Account, open [Third-party apps and services](https://myaccount.google.com/connections), pick your app and choose **Delete all connections**.
- Or delete the OAuth client in the Google Cloud console (Google Auth Platform, Clients).
- To unlink the Cloud project from Merchant Center as well, call `developerRegistration:unregisterGcp` on the account, or remove the API developer user in Merchant Center, Settings, People and access.

## Account picker

| Key | What is chosen | Tool that lists the candidates | Older field |
| --- | --- | --- | --- |
| `accounts` | The Merchant Center accounts the agent may read and change (several) | `list_accounts` | `merchantid` |

With a selection, every tool refuses another account before sending anything, and `api_get` and `api_request` only reach paths (and `dataSource` names) of a chosen account. In the CLI, set `CONNECTOR_ACCOUNTS='{"accounts":["123456789"]}'`.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_accounts` | read | The Merchant Center accounts the Google account can open. The `accounts` picker's list. |
| `list_products` | read | Processed products of an account: offer ID, language, feed label, title, link, price, availability, brand, status per destination and item issues. |
| `get_product` | read | One product by offer ID, language and feed label, with every attribute and each issue's detail and help link. |
| `insert_product` | update | Inserts a product input into an API data source, or replaces the input with the same offer ID, language and feed label there. |
| `update_product` | update | Changes some attributes of a product input (and clears the ones named in `remove_attributes`), with an update mask so nothing else changes. |
| `delete_product` | delete | Deletes a product input from an API data source. |
| `list_data_sources` | read | The account's data sources with their input type (API, file, UI, autofeed), kind, feed label and language. |
| `create_data_source` | create | A primary product data source of input type API, for `insert_product`. |
| `list_account_issues` | read | Account-level issues with severity, affected destinations and regions, and help links. |
| `summarize_product_statuses` | read | Active, pending, disapproved and expiring counts per destination and country, with each issue and how many products it affects. |
| `search_reports` | read | A Merchant Center Query Language report, rows returned flat with snake_case fields. Sent by POST, changes nothing. |
| `api_get` | read | Any other GET of the Merchant API, such as `/accounts/v1/accounts/{id}/shippingSettings` or `/promotions/v1/accounts/{id}/promotions`. |
| `api_request` | write | A POST, PATCH or DELETE to the Merchant API, such as `homepage:claim`, `shippingSettings:insert` or `promotions:insert`. Sent once, never retried. Deleting a whole account and managing its users are left out. |

## Limits

- Prices are micros: 19.99 is `"19990000"`. Enums are upper case (`IN_STOCK`, `NEW`).
- Product writes need an API data source, and a product input takes a few minutes to show up in `get_product` and `list_products`.
- `summarize_product_statuses` works on standalone and sub-accounts; `list_account_issues` on an advanced account returns the parent's own issues only.
- The Merchant API has per-method quotas; a refused request comes back with HTTP 429 and is never retried on its own. Every result is cut to 32 KB with a `nextCursor`.

<!--
Rows for the repository README.
Connectors: | `google-merchant-center` | [Google Merchant Center](https://merchants.google.com): products with status and issues, product inserts, updates and deletes through API data sources, feed health counts, account issues, reports, and the rest of the Merchant API | Google OAuth access token | Available |
Quick start: | `google-merchant-center` | `GOOGLE_MERCHANT_CENTER_ACCESS_TOKEN` | A Google OAuth access token from your own Google Cloud OAuth client with the Merchant API enabled and the scope `content`; the Cloud project registered once with the account. Account key: `accounts`. |
-->
