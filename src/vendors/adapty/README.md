# Adapty (`adapty`)

One app's subscription analytics, through Adapty's [Analytics Export API](https://adapty.io/docs/api-export-analytics): the charts of the Adapty Dashboard (revenue, proceeds and net revenue, MRR, ARR, ARPU, ARPPU, active and new subscriptions and trials, cancellations, expirations, grace period, billing issues, refunds, one-time purchases, installs), conversion rates, the install-to-paid funnel, retention, realized LTV and install cohorts with predictions, by date range with a comparison period, filters (country, store, product, offer, attribution, segment, audience, paywall, placement, flow) and one grouping.

Aggregate numbers only: the connector calls Adapty's six analytics endpoints and nothing else, never the server-side API or a user profile, and it has no write tool.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `adapty` | [Adapty](https://adapty.io) subscription analytics for one app: revenue, MRR, ARR, subscriptions, trials, refunds, conversion, funnel, retention, LTV and install cohorts, with filters, groupings and comparison periods. Aggregate numbers only, read-only | Adapty secret API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `adapty` | `ADAPTY_APIKEY` | The app's secret key (`secret_live_...`): Adapty Dashboard → App settings → General → API keys. One key reads one app. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_chart` | read | One analytics chart (default `revenue`): each metric's total for the period, its points by period or group, comparison values, unit and Adapty's definition. Long point lists come in pages. |
| `get_conversion` | read | A conversion rate between two subscription periods, such as paid to more than 6 months (`1` → `6+`). |
| `get_funnel` | read | Install → paywall → trial → paid, with the users who reached and left each stage. |
| `get_retention` | read | Subscriber retention period by period, from the first paid period or the trial. |
| `get_ltv` | read | Realized LTV on revenue, proceeds and net revenue, with cohort sizes. |
| `get_cohorts` | read | Install cohorts: installs, subscribers, revenue, proceeds and net revenue in USD per period, with predictions. |

Every tool takes `date_from` and `date_to` (default: the last 28 full days, ending yesterday, UTC), an optional comparison period, `filters`, and `timezone` (an IANA name sent as Adapty's `Adapty-Tz` header). `get_chart` with no arguments also serves as a connection check.

## Credentials

**`apikey`: the app's secret API key**

1. Sign in to the [Adapty Dashboard](https://app.adapty.io) and pick the app.
2. Open **App settings** and stay on the **General** tab.
3. Under **API keys**, copy the **Secret key**; it starts with `secret_live_`.

Adapty keys belong to one app, so the connector reports on that app; connect another app with that app's key.

**Revoking it:** Adapty Dashboard → App settings → General → API keys → **Generate new key**, then delete the old key. Calls with the old key fail with a 401 at once.

## Limits

- Adapty allows 2 requests a second per app, shared by all of the app's keys, and sends no `Retry-After`: after a 429, wait about a minute.
- Every filter takes exact values; Adapty does not publish all values for `store`, `duration`, `offer_type` and the attribution fields. Run the same call with that field as `segmentation` first and filter with the values it shows.
- Money is in USD, rates in percent. Revenue in `get_chart` counts on the purchase day; `get_cohorts` counts it on each user's install date, as ad reports do.
- Adapty reports a refused request with the field and reason in its own error list; the tool error gives the status and a hint.
