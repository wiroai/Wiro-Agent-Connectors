# Google Analytics 4 (`ga4`)

Reports and settings of [Google Analytics 4](https://analytics.google.com) properties, through the Google Analytics Data API v1beta and the Admin API v1beta and v1alpha:

- reports on any metrics and dimensions over up to four date ranges, with filters, ordering and totals; realtime reports of the last 30 minutes; several reports in one call;
- the dimensions and metrics a property offers, its custom definitions included, and whether a set of them can go in one report;
- property settings, key events (conversions), custom dimensions and metrics, data streams, Google Ads links and audiences, read and changed through `api_get` and `api_request`.

Typical uses: a weekly traffic and revenue report, sessions and key events by source and medium to set beside an ad platform's clicks and conversions, marking an event as a key event, adding a custom dimension.

## Credentials

| Credential | CLI variable | What it is |
| --- | --- | --- |
| `access_token` | `GA4_ACCESS_TOKEN` | A Google OAuth access token for a Google account that can open the properties, with the scopes `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/analytics.edit`. |

The token comes from an OAuth client in your own Google Cloud project. A host that runs this connector signs in with that client, refreshes the token and passes the current one on every call; the connector never stores or refreshes it.

### Where to get it

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project, or pick one.
2. Enable the [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com) and the [Google Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com) in it.
3. In [Google Auth Platform, Audience](https://console.cloud.google.com/auth/audience), choose **External**. While the app is in **Testing**, only the test users listed there can sign in, and Google ends their sign-in after 7 days: add the Google account you will use as a test user, or set the publishing status to **In production** to keep it. Google may warn that the app is unverified: it is your own app, so open **Advanced** and continue.
4. In [Data Access](https://console.cloud.google.com/auth/scopes), add the scopes `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/analytics.edit`.
5. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI your host gives you. Copy the client ID and the client secret (shown once) into your host, which then signs you in.
6. For the CLI, get a token with the same client, for example in the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/): open the settings (gear icon), check **Use your own OAuth credentials**, enter the client ID and secret (add `https://developers.google.com/oauthplayground` as a redirect URI of the client first), authorize the two scopes above and exchange the code. The access token lasts one hour, and the CLI does not refresh it.

The Google account must have at least the Viewer role on a property to report on it, and the Editor role to change its settings.

### How to revoke it

- In your Google Account, open [Third-party apps and services](https://myaccount.google.com/connections), pick your app and choose **Delete all connections**: every token it holds stops working.
- Or, in the Google Cloud console, delete the OAuth client (Google Auth Platform, Clients), which ends every sign-in made with it.

## Account picker

| Key | What is chosen | Tool that lists the candidates | Older field |
| --- | --- | --- | --- |
| `properties` | The GA4 properties the agent may report on and configure (several) | `list_properties` | `propertyid` |

With a selection, every tool refuses a property outside it before sending anything, and `api_get` and `api_request` only reach paths that name a chosen property, and refuse any other property named in a query value or the JSON body (account-wide paths such as `/v1beta/accountSummaries` are refused; `list_properties` lists the properties and marks the chosen ones `selected: true`). In the CLI, set `CONNECTOR_ACCOUNTS='{"properties":["123456789"]}'` to apply a selection; without it there is none.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_properties` | read | The GA4 properties the connected Google account can open, with their account; the ones chosen for the connection are marked `selected: true`. The `properties` picker's list. |
| `run_report` | read | A report on one property: metrics by dimensions over up to 4 date ranges (YYYY-MM-DD, today, yesterday, NdaysAgo), with filters, ordering, totals and paging. Rows come back keyed by dimension and metric names. Sent by POST, changes nothing. |
| `run_realtime_report` | read | A realtime report of the last 30 minutes, e.g. active users by country, with optional minute ranges. |
| `batch_run_reports` | read | Up to 5 reports on one property in one call, each in the API's own RunReportRequest JSON. |
| `get_metadata` | read | The dimensions and metrics the property can report on, custom ones included, filtered by kind or text. |
| `check_compatibility` | read | Whether dimensions and metrics can go in one report, or every field that can or cannot join them. |
| `api_get` | read | Any other GET of the Admin API (`origin: "https://analyticsadmin.googleapis.com"`): property settings, `keyEvents`, `customDimensions`, `customMetrics`, `dataStreams`, `googleAdsLinks`, and `audiences` on `/v1alpha/`; or of the Data API (the default origin). |
| `api_request` | write | A POST, PATCH or DELETE with a JSON body to the same APIs, such as marking an event as a key event (`POST /v1beta/properties/{id}/keyEvents`) or adding a custom dimension. Sent once, never retried. Deleting a whole property or account and changing user access are left out. |

## Limits

- The Data API has quotas per property (tokens per hour and per day, and concurrent requests). A refused request comes back with HTTP 429 and, when Google says, `retryAfter`; nothing is queued or retried.
- Reports return up to 10,000 rows per page (100 by default, 50 per report in `batch_run_reports`), and every result is cut to 32 KB with a `nextCursor` to continue. Realtime reports cover the last 30 minutes (60 on Analytics 360) and have no paging of their own: a continuation runs the report again.
- `keyEvents` replaced the `conversions` metric; a report that mixes incompatible fields is refused with HTTP 400 (`check_compatibility` tells which ones).
- Changes need the `analytics.edit` scope and the Editor role on the property.

<!--
Rows for the repository README.
Connectors: | `ga4` | [Google Analytics 4](https://analytics.google.com): reports, realtime reports, metadata and compatibility checks, and the Admin API (key events, custom dimensions and metrics, data streams, Google Ads links, audiences) | Google OAuth access token | Available |
Quick start: | `ga4` | `GA4_ACCESS_TOKEN` | A Google OAuth access token from your own Google Cloud OAuth client with the Analytics Data and Admin APIs enabled and the scopes `analytics.readonly` and `analytics.edit`. Account key: `properties`. |
-->
