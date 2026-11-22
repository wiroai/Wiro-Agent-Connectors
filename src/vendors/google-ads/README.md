# Google Ads (`google-ads`)

Reporting and campaign management in [Google Ads](https://ads.google.com), through the Google Ads API v26 (REST), and first-party data uploads through Google's [Data Manager API](https://developers.google.com/data-manager/api):

- Google Ads Query Language reports on anything the API exposes: campaign, ad group, ad, keyword, search term, device, location, audience, auction insights, impression share, conversion action, recommendation and asset data;
- grouped mutates in one atomic request: campaign budgets (shared or not), campaigns of every type (Search, Display, Performance Max, App, Video, Shopping), bidding strategies, geo target type, ad schedules, ad groups, responsive search and display ads, keywords and negative keywords, audiences and user lists, assets and their links, conversion actions and attribution models, value rules, seasonality adjustments, shared negative keyword sets, with a dry run (`validate_only`);
- image assets from a public URL, and Keyword Planner ideas;
- Customer Match members in and out of a list, and offline conversions (click conversions by GCLID, GBRAID or WBRAID, and enhanced conversions for leads by email or phone), through the Data Manager API, which takes them from every Google Cloud project, with the normalizing and hashing done in the connector; the upload's status afterwards;
- Customer Match uploads through the Google Ads API as well, for the projects Google still takes them from;
- the rest of the API through `api_get` and `api_request`: applying or dismissing Google's recommendations, conversion adjustments, call conversions, batch jobs.

## Credentials

| Credential | CLI variable | Required | What it is |
| --- | --- | --- | --- |
| `access_token` | `GOOGLE_ADS_ACCESS_TOKEN` | yes | A Google OAuth access token for a Google account with access to the Google Ads accounts, with the scope `https://www.googleapis.com/auth/adwords`, and `https://www.googleapis.com/auth/datamanager` for the Data Manager tools (`add_audience_members`, `remove_audience_members`, `upload_conversions`, `get_upload_status`). |
| `developertoken` | `GOOGLE_ADS_DEVELOPERTOKEN` | no | A Google Ads developer token, from an older setup. Google sunset developer tokens on September 9, 2026, ignores them since and has said it will refuse them in a later major version of the API, so the connector accepts a value but never sends it. Leave it empty: no developer token is needed. |
| `managercustomerid` | `GOOGLE_ADS_MANAGERCUSTOMERID` | no | A manager account (MCC) ID, sent as `login-customer-id` with every Google Ads request, for accounts you reach through that manager. Dashes are fine. Usually not needed: without it the connector finds the manager account of each account itself (see [Accounts reached through a manager account](#accounts-reached-through-a-manager-account)). A tool's `login_customer_id` argument overrides both per call. |

The access token comes from an OAuth client in your own Google Cloud project. That project's Google Ads API access level decides which accounts and how many operations a day you can use; no developer token and no manager account are needed to get it. A host that runs this connector signs in with that client, refreshes the token and passes the current one on every call; the connector never stores or refreshes it.

### Where to get them

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one) and enable the [Google Ads API](https://console.cloud.google.com/apis/library/googleads.googleapis.com). This gives the project Test access (test accounts only).
2. To reach real accounts, open the [Google Ads API Overview page](https://console.cloud.google.com/google/ads-apis/overview) of the same project, expand **Upgrade access level** and apply for **Explorer** access (Google reviews it automatically and grants it in most cases), or for Basic or Standard. New Basic and Standard applications need the project's brand verified first.
3. Enable the [Data Manager API](https://console.cloud.google.com/apis/library/datamanager.googleapis.com) in the same project, for Customer Match members and offline conversions. It needs no access level.
4. In [Google Auth Platform, Audience](https://console.cloud.google.com/auth/audience), choose **External**. While the app is in **Testing**, only its test users can sign in, and Google ends their sign-in after 7 days: add your Google account as a test user, or set the publishing status to **In production**.
5. In [Data Access](https://console.cloud.google.com/auth/scopes), add the scopes `https://www.googleapis.com/auth/adwords` and `https://www.googleapis.com/auth/datamanager`.
6. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI your host gives you. Copy the client ID and the client secret into your host, which then signs you in with a Google account that can open your Google Ads accounts. A sign-in made before the `datamanager` scope was added has to be made again for the Data Manager tools: Google keeps a token to the scopes it was granted with.
7. Optional: to send one manager account with every request, copy its 10-digit ID from the top of Google Ads (e.g. `123-456-7890`) into `managercustomerid`.
8. For the CLI, get a token with the same client, for example in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with **Use your own OAuth credentials** (add `https://developers.google.com/oauthplayground` as a redirect URI first) and both scopes. It lasts one hour, and the CLI does not refresh it.

### How to revoke them

- In your Google Account, open [Third-party apps and services](https://myaccount.google.com/connections), pick your app and choose **Delete all connections**.
- Or delete the OAuth client in the Google Cloud console (Google Auth Platform, Clients).
- To take the Google account's access to a Google Ads account away altogether, remove it in Google Ads, Admin, Access and security.

## Accounts reached through a manager account

Google Ads needs the manager account's ID (`login-customer-id`, the Data Manager API's `loginAccount`) for an account the Google account reaches through a manager account, and none for an account it opens directly. Each tool takes it from, in order: its `login_customer_id` argument, the `managercustomerid` credential, or what the connector finds. To find it, the connector lists the accounts the Google account opens directly (`customers:listAccessibleCustomers`); an account among them needs none, and for any other account it asks those accounts, at most 25 and manager accounts first, whether the account sits anywhere below them (`customer_client`, which lists every level). It reads nothing else of them. What it finds is kept in memory for an hour, keyed by a hash of the access token, and `list_customers` adds what it reads, so a call usually costs no extra request. An account that no manager account leads to goes without one, and Google Ads then answers for itself (HTTP 403: give `login_customer_id`).

## Account picker

| Key | What is chosen | Tool that lists the candidates | Older field |
| --- | --- | --- | --- |
| `customers` | The Google Ads accounts the agent may report on and change (several) | `list_customers` | `customerid` |

`list_customers` lists the accounts the Google account can open directly, and the client accounts (two levels deep) of each manager account among them, with the `login_customer_id` to act through; the chosen ones are marked `selected: true`. With a selection, every tool refuses another account before sending anything, a mutate may only name resources of the chosen account, the Data Manager tools only send to a list or conversion action of a chosen account, `get_upload_status` only shows the chosen accounts, and `api_get` and `api_request` only reach paths of a chosen account (field metadata at `/v26/googleAdsFields` aside) and refuse any other account a query value or the JSON body names as `customers/<id>`. In the CLI, set `CONNECTOR_ACCOUNTS='{"customers":["1234567890"]}'`.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_customers` | read | The Google Ads accounts the Google account can open, with client accounts of managers, status, currency, time zone and login ID; the chosen ones are marked `selected: true`. The `customers` picker's list. |
| `search` | read | A GAQL query on one account. Rows come back flat, named like the query's fields (`metrics.cost_micros`); money is in micros. Sent by POST, changes nothing. |
| `mutate` | write | Creates, updates or removes resources in one atomic request (GoogleAdsService.Mutate), with optional partial failure and `validate_only`. Sent once, never retried. |
| `upload_image_asset` | create | Downloads a JPEG, PNG or GIF from a public https URL (up to 5,120 KB) and creates an image asset. |
| `generate_keyword_ideas` | read | Keyword Planner ideas from keywords, a URL, both, or a site, with average monthly searches, competition and top-of-page bids. |
| `upload_customer_match` | write | Adds people to or removes them from a Customer Match list by email or phone through the Google Ads API: normalized and hashed with SHA-256 in the connector, then an offline user data job is created, filled and run. Only for projects Google allowlisted; `add_audience_members` and `remove_audience_members` work for every project. |
| `add_audience_members` | create | Adds people to a Customer Match list by email or phone through the Data Manager API (up to 10,000 a call), normalized and hashed with SHA-256 in the connector, with consent and the confirmed Customer Match terms; `validate_only` has Google check the request. Returns a `request_id`. |
| `remove_audience_members` | delete | Removes people from a Customer Match list by email or phone through the Data Manager API (up to 10,000 a call). Returns a `request_id`. |
| `upload_conversions` | write | Sends up to 2,000 offline conversions to a conversion action through the Data Manager API: click conversions by GCLID, GBRAID or WBRAID, enhanced conversions for leads by email or phone (hashed in the connector), session attributes, value, currency, transaction ID. A repeated transaction ID updates that conversion. Returns a `request_id`. |
| `get_upload_status` | read | How Google processed a Data Manager upload, by its `request_id`: processing, success, partial success or failure, record counts, an audience upload's match rate range, and the reasons and record indices of the records that failed or got warnings. |
| `hash_user_identifiers` | read | Normalizes and hashes emails and phone numbers the way Google requires, for user identifiers sent with `api_request`, such as enhanced conversion adjustments. Sends nothing. |
| `api_get` | read | Any GET of the API under `/v26/`, such as field metadata. |
| `api_request` | write | Any POST with a JSON body under `/v26/customers/{customer_id}`, such as `recommendations:apply`, `recommendations:dismiss`, `:uploadConversionAdjustments` or `:uploadCallConversions`. Sent once, never retried; check with `search`. Changing user access and manager links is left out. |

## Limits

- Money is in micros: 1 unit of the account's currency is `1000000`. Ad text limits: headlines 30 characters, descriptions 90, display paths 15. `upload_conversions` takes values in currency units, not micros.
- `search` reads Google's pages of 10,000 rows (Google has no smaller page size) and returns them cut to 32 KB with a `nextCursor`. A page larger than 8 MB cannot be read, which a keyword or search-term report reaches at a few thousand rows: bound such queries with `ORDER BY` and `LIMIT`, or split them by `segments.date` or `campaign.id`. `mutate` takes up to 1,000 operations per call.
- When Google refuses a request with HTTP 400, its top message is often generic ("Request contains an invalid argument", "There was a problem with the request"), and the connector passes on only that message for now. With `partial_failure: true`, the reason and field of each failing operation of a `mutate` come back, while the valid ones are applied; for a refused query, `api_get` on `/v26/googleAdsFields/<field>` tells whether a field exists and what it can be selected with; the Data Manager tools take `validate_only: true` to have a request checked first.
- `upload_image_asset` names an asset after the image's file name and the time when no `name` is given: Google Ads wants unique names for image assets and adds a suffix to a repeated one.
- Google Ads takes Customer Match lists (`OfflineUserDataJobService`, since April 1, 2026) and click conversions (`UploadClickConversions`, since June 15, 2026) only from Cloud projects that sent them in the months before; other projects get `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`, and the connector's error then points to the Data Manager tools. Those take the same data from every project, with the `datamanager` scope and the Data Manager API enabled.
- Customer Match needs the account to accept Google's [Customer Match terms](https://support.google.com/adspolicy/answer/6299717): `add_audience_members` asks for `accept_customer_match_terms: true` on every call and sends it with the people. Each email or phone goes as one member; Google matches them within 48 hours, and a list needs at least 100 members to be used for targeting.
- Data Manager requests: up to 10,000 audience members or 2,000 conversions, and 10 emails and phones per conversion; Google processes them in the background, and `get_upload_status` tells the outcome. Its record indices count the records in the order they were sent: for an audience upload the plain emails, the hashed emails, the plain phones, then the hashed phones (the result's `sent` gives each count), without the skipped ones. Google allows 300 Data Manager requests a minute per project.
- Daily operation quotas follow the project's access level (Basic: 15,000 operations a day). A refused request comes back with HTTP 429 and `retryAfter`; nothing is retried or queued.

<!--
Rows for the repository README.
Connectors: | `google-ads` | [Google Ads](https://ads.google.com): GAQL reports, atomic mutates for campaigns, budgets, ad groups, ads, keywords, audiences and conversion settings, image assets, Keyword Planner ideas, Customer Match members and offline conversions through the Data Manager API (with upload status), and the rest of the API | Google OAuth access token (optional manager account ID) | Available |
Quick start: | `google-ads` | `GOOGLE_ADS_ACCESS_TOKEN`; optional `GOOGLE_ADS_MANAGERCUSTOMERID` and `GOOGLE_ADS_DEVELOPERTOKEN` | A Google OAuth access token from your own Google Cloud OAuth client with the Google Ads API (Explorer or higher access for real accounts) and the Data Manager API enabled, and the scopes `adwords` and `datamanager`. No developer token or manager account is needed: the developer token is never sent (Google ignores it since September 2026), and the connector finds the manager account of a client account itself. Account key: `customers`. |
Tools rows (section "### google-ads"): the Tools table above, with the four Data Manager tools `add_audience_members`, `remove_audience_members`, `upload_conversions` and `get_upload_status`.
-->
