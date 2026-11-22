# Google Ads (`google-ads`)

Reporting and campaign management in [Google Ads](https://ads.google.com), through the Google Ads API v26 (REST):

- Google Ads Query Language reports on anything the API exposes: campaign, ad group, ad, keyword, search term, device, location, audience, auction insights, impression share, conversion action, recommendation and asset data;
- grouped mutates in one atomic request: campaign budgets (shared or not), campaigns of every type (Search, Display, Performance Max, App, Video, Shopping), bidding strategies, geo target type, ad schedules, ad groups, responsive search and display ads, keywords and negative keywords, audiences and user lists, assets and their links, conversion actions and attribution models, value rules, seasonality adjustments, shared negative keyword sets, with a dry run (`validate_only`);
- image assets from a public URL, Keyword Planner ideas, Customer Match uploads with hashing done in the connector;
- the rest of the API through `api_get` and `api_request`: applying or dismissing Google's recommendations, click and call conversion uploads and adjustments, batch jobs.

## Credentials

| Credential | CLI variable | Required | What it is |
| --- | --- | --- | --- |
| `access_token` | `GOOGLE_ADS_ACCESS_TOKEN` | yes | A Google OAuth access token for a Google account with access to the Google Ads accounts, with the scope `https://www.googleapis.com/auth/adwords`. |
| `developertoken` | `GOOGLE_ADS_DEVELOPERTOKEN` | no | A Google Ads developer token, from an older setup. Google sunset developer tokens on September 9, 2026, ignores them since and has said it will refuse them in a later major version of the API, so the connector accepts a value but never sends it. Leave it empty. |
| `managercustomerid` | `GOOGLE_ADS_MANAGERCUSTOMERID` | no | A manager account (MCC) ID, sent as `login-customer-id` on every request, for accounts you reach through that manager. Dashes are fine. A tool's `login_customer_id` argument overrides it per call. |

The access token comes from an OAuth client in your own Google Cloud project, and that project's Google Ads API access level decides which accounts and how many operations a day you can use. A host that runs this connector signs in with that client, refreshes the token and passes the current one on every call; the connector never stores or refreshes it.

### Where to get them

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one) and enable the [Google Ads API](https://console.cloud.google.com/apis/library/googleads.googleapis.com). This gives the project Test access (test accounts only).
2. To reach real accounts, apply for Explorer access (or Basic or Standard) on the Google Ads API **Overview** page of the same project. New Basic and Standard applications need the project's brand verified first.
3. In [Google Auth Platform, Audience](https://console.cloud.google.com/auth/audience), choose **External**. While the app is in **Testing**, only its test users can sign in, and Google ends their sign-in after 7 days: add your Google account as a test user, or set the publishing status to **In production**.
4. In [Data Access](https://console.cloud.google.com/auth/scopes), add the scope `https://www.googleapis.com/auth/adwords`.
5. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI your host gives you. Copy the client ID and the client secret into your host, which then signs you in with a Google account that can open your Google Ads accounts.
6. If you manage accounts through a manager account, copy its 10-digit ID from the top of Google Ads (e.g. `123-456-7890`) into `managercustomerid`, or pass it as `login_customer_id` (`list_customers` tells you which manager each client account sits under).
7. For the CLI, get a token with the same client, for example in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with **Use your own OAuth credentials** (add `https://developers.google.com/oauthplayground` as a redirect URI first) and the scope above. It lasts one hour, and the CLI does not refresh it.

### How to revoke them

- In your Google Account, open [Third-party apps and services](https://myaccount.google.com/connections), pick your app and choose **Delete all connections**.
- Or delete the OAuth client in the Google Cloud console (Google Auth Platform, Clients).
- To take the Google account's access to a Google Ads account away altogether, remove it in Google Ads, Admin, Access and security.

## Account picker

| Key | What is chosen | Tool that lists the candidates | Older field |
| --- | --- | --- | --- |
| `customers` | The Google Ads accounts the agent may report on and change (several) | `list_customers` | `customerid` |

`list_customers` lists the accounts the Google account can open directly, and the client accounts (two levels deep) of each manager account among them, with the `login_customer_id` to act through; the chosen ones are marked `selected: true`. With a selection, every tool refuses another account before sending anything, a mutate may only name resources of the chosen account, and `api_get` and `api_request` only reach paths of a chosen account (field metadata at `/v26/googleAdsFields` aside) and refuse any other account a query value or the JSON body names as `customers/<id>`. In the CLI, set `CONNECTOR_ACCOUNTS='{"customers":["1234567890"]}'`.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_customers` | read | The Google Ads accounts the Google account can open, with client accounts of managers, status, currency, time zone and login ID; the chosen ones are marked `selected: true`. The `customers` picker's list. |
| `search` | read | A GAQL query on one account. Rows come back flat, named like the query's fields (`metrics.cost_micros`); money is in micros. Sent by POST, changes nothing. |
| `mutate` | write | Creates, updates or removes resources in one atomic request (GoogleAdsService.Mutate), with optional partial failure and `validate_only`. Sent once, never retried. |
| `upload_image_asset` | create | Downloads a JPEG, PNG or GIF from a public https URL (up to 5,120 KB) and creates an image asset. |
| `generate_keyword_ideas` | read | Keyword Planner ideas from keywords, a URL, both, or a site, with average monthly searches, competition and top-of-page bids. |
| `upload_customer_match` | write | Adds people to or removes them from a Customer Match list by email or phone: normalized and hashed with SHA-256 in the connector, then an offline user data job is created, filled and run. |
| `hash_user_identifiers` | read | Normalizes and hashes emails and phone numbers the way Google Ads requires, for enhanced conversions sent with `api_request`. Sends nothing. |
| `api_get` | read | Any GET of the API under `/v26/`, such as field metadata. |
| `api_request` | write | Any POST with a JSON body under `/v26/customers/{customer_id}`, such as `recommendations:apply`, `recommendations:dismiss`, `:uploadClickConversions`, `:uploadConversionAdjustments` or `offlineUserDataJobs:create`. Sent once, never retried; check with `search`. Changing user access and manager links is left out. |

## Limits

- Money is in micros: 1 unit of the account's currency is `1000000`. Ad text limits: headlines 30 characters, descriptions 90, display paths 15.
- `search` reads Google's pages of 10,000 rows (Google has no smaller page size) and returns them cut to 32 KB with a `nextCursor`. A page larger than 8 MB cannot be read, which a keyword or search-term report reaches at a few thousand rows: bound such queries with `ORDER BY` and `LIMIT`, or split them by `segments.date` or `campaign.id`. `mutate` takes up to 1,000 operations per call.
- When Google Ads refuses a request with HTTP 400, its top message is often generic ("Request contains an invalid argument"), and the connector passes on only that message for now. With `partial_failure: true`, the reason and field of each failing operation of a `mutate` come back, while the valid ones are applied; for a refused query, `api_get` on `/v26/googleAdsFields/<field>` tells whether a field exists and what it can be selected with.
- `upload_image_asset` names an asset after the image's file name and the time when no `name` is given: Google Ads wants unique names for image assets and adds a suffix to a repeated one.
- Google only lets Cloud projects that used them recently upload Customer Match lists (`OfflineUserDataJobService`, since April 1, 2026) and click conversions (`UploadClickConversions`, since June 15, 2026); other projects get `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`. Google's replacement, the Data Manager API, needs another scope and is not part of this connector.
- Daily operation quotas follow the project's access level (Basic: 15,000 operations a day). A refused request comes back with HTTP 429 and `retryAfter`; nothing is retried or queued.

<!--
Rows for the repository README.
Connectors: | `google-ads` | [Google Ads](https://ads.google.com): GAQL reports, atomic mutates for campaigns, budgets, ad groups, ads, keywords, audiences and conversion settings, image assets, Keyword Planner ideas, Customer Match uploads, and the rest of the API | Google OAuth access token (optional manager account ID) | Available |
Quick start: | `google-ads` | `GOOGLE_ADS_ACCESS_TOKEN`; optional `GOOGLE_ADS_MANAGERCUSTOMERID` and `GOOGLE_ADS_DEVELOPERTOKEN` | A Google OAuth access token from your own Google Cloud OAuth client with the Google Ads API enabled (and Explorer or higher access for real accounts) and the scope `adwords`. The developer token is optional and never sent: Google ignores it since September 2026. Account key: `customers`. |
-->
