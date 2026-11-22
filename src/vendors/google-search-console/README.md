# Google Search Console (`google-search-console`)

Read-only reports from [Google Search Console](https://search.google.com/search-console), through the Search Console API:

- Search Analytics: Google Search clicks, impressions, CTR and average position by query, page, country, device, date, hour, search appearance or branded classification, with filters, for given dates or the last N days with data;
- period comparisons: totals against the period before or the same dates a year earlier, and the queries, pages, countries or devices that lost and gained the most;
- sitemaps, with their errors, warnings and download state;
- URL Inspection: how Google indexed one page.

It never changes anything: the connection's scope is `webmasters.readonly`, so it adds or removes no property, submits or deletes no sitemap and requests no indexing. Those stay in Search Console itself.

## Credentials

| Credential | CLI variable | What it is |
| --- | --- | --- |
| `access_token` | `GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN` | A Google OAuth access token for a Google account with access to the properties, with the scope `https://www.googleapis.com/auth/webmasters.readonly`. |

The token comes from an OAuth client in your own Google Cloud project. A host that runs this connector signs in with that client, refreshes the token and passes the current one on every call; the connector never stores or refreshes it.

### Where to get it

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one) and enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com).
2. In [Google Auth Platform, Audience](https://console.cloud.google.com/auth/audience), choose **External**. While the app is in **Testing**, only the test users listed there can sign in, and Google ends their sign-in after 7 days: add the Google account you will use as a test user, or set the publishing status to **In production** to keep it. Google may warn that the app is unverified: it is your own app, so open **Advanced** and continue.
3. In [Data Access](https://console.cloud.google.com/auth/scopes), add the scope `https://www.googleapis.com/auth/webmasters.readonly`.
4. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI your host gives you. A client you already use for Google Analytics works too: add the redirect URI to it and enable the Search Console API in its project. Copy the client ID and the client secret into your host, which then signs you in.
5. For the CLI, get a token with the same client, for example in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with **Use your own OAuth credentials** (add `https://developers.google.com/oauthplayground` as a redirect URI of the client first) and the scope above. The access token lasts one hour, and the CLI does not refresh it.

Sign in with a Google account that has verified access to the property (Owner, Full or Restricted user); unverified properties have no data.

### How to revoke it

- In your Google Account, open [Third-party apps and services](https://myaccount.google.com/connections), pick your app and choose **Delete all connections**.
- Or delete the OAuth client in the Google Cloud console (Google Auth Platform, Clients), which ends every sign-in made with it.

## Account picker

| Key | What is chosen | Tool that lists the candidates | Older field |
| --- | --- | --- | --- |
| `sites` | The Search Console properties the agent may report on (several) | `list_sites` | `siteurl` |

A property id is `sc-domain:example.com` for a Domain property, or the address with its trailing slash for a URL-prefix property, `https://www.example.com/`. With a selection, every tool refuses another property before sending anything, and `api_get` only reaches paths whose property segment is a chosen one. In the CLI, set `CONNECTOR_ACCOUNTS='{"sites":["sc-domain:example.com"]}'`.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_sites` | read | The properties the Google account has verified access to, with their permission level. The `sites` picker's list. |
| `query_search_analytics` | read | Clicks, impressions, CTR and position grouped by up to six dimensions, with filters, search type (web, image, video, news, discover, googleNews), fresh or final data, and paging. Dates or `last_days`, which ends on the latest day with data. Sent by POST, changes nothing. |
| `compare_periods` | read | Two periods of the same length side by side: totals with the change, and with a dimension the top losers and gainers by clicks or impressions. |
| `list_sitemaps` | read | The submitted sitemaps, or those inside a sitemap index, with errors, warnings, pending state and whether Google downloaded them since the last submission. |
| `inspect_url` | read | How Google indexed one URL: verdict, coverage, robots.txt, fetch state, canonicals, last crawl, rich results and a link to the report. |
| `api_get` | read | Any other GET of the API under `/webmasters/v3/`, such as one property or one sitemap, with the ids percent-encoded. |

## Limits

- Data arrives 2 to 3 days late, in Pacific Time days; `final` data leaves out the last, partial days and `all` adds them.
- The API returns the top rows, at most 25,000 per request (100 by default here), sorted by clicks. A sum of query or page rows can be lower than the total: for totals, group by nothing or by date. Every result is cut to 32 KB with a `nextCursor`.
- URL Inspection: 2,000 inspections per property per day and 600 per minute. Search Analytics has short-term load quotas; a refused request comes back with HTTP 429 and is never retried on its own.
- Read-only by design: there is no `api_request`.

<!--
Rows for the repository README.
Connectors: | `google-search-console` | [Google Search Console](https://search.google.com/search-console), read-only: Search Analytics by query, page, country, device and date, period comparisons with losers and gainers, sitemaps and URL Inspection | Google OAuth access token | Available |
Quick start: | `google-search-console` | `GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN` | A Google OAuth access token from your own Google Cloud OAuth client with the Search Console API enabled and the scope `webmasters.readonly`. Account key: `sites`. |
-->
