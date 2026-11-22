# RevenueCat (`revenuecat`)

A RevenueCat project's aggregate subscription numbers, through the [RevenueCat REST API v2](https://www.revenuecat.com/docs/api-v2): the dashboard's overview cards (MRR, active subscriptions and trials, revenue, new and active customers), revenue for any date range, every chart (revenue, MRR, ARR, churn, trials, trial and paid conversion, retention, LTV, refunds, cohorts) with its resolutions, filters, segments and selectors, and the project's apps, products, offerings and entitlements.

Aggregate numbers only: the connector never reaches a customer, subscription, purchase, invoice, audience, collaborator, audit log, webhook or key route, has no write tool, and its `api_get` is limited to the aggregate routes, whatever the key's permissions.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `revenuecat` | [RevenueCat](https://www.revenuecat.com) subscription metrics: overview cards, revenue by date range, every chart with its filters and segments, and the project's apps, products, offerings and entitlements. Aggregate numbers only, read-only | RevenueCat V2 secret API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `revenuecat` | `REVENUECAT_APIKEY` | RevenueCat → Project settings → API keys → + New secret API key, version V2, read-only for Charts & Metrics and Project configuration. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_projects` | read | The projects the key sees (a secret key normally sees one). |
| `list_apps` | read | The project's apps with their store type and bundle ID or package name. |
| `get_overview` | read | The overview cards: active trials and subscriptions (now), MRR, revenue, new and active customers (last 28 days), with update times. |
| `get_revenue` | read | Revenue, revenue net of taxes or proceeds for a date range. |
| `get_chart_options` | read | A chart's resolutions, filters (with values), segments and selectors. |
| `get_chart` | read | A chart's measures, segments, dated points (partial periods marked) and summary, in pages. |
| `list_products` | read | Products with store identifier, type, duration and trial duration. |
| `list_offerings` | read | Offerings, and which one is current. |
| `get_offering` | read | One offering with its packages and their products. |
| `list_entitlements` | read | Entitlements. |
| `list_entitlement_products` | read | The products attached to an entitlement. |
| `api_get` | read | Any other GET on the aggregate routes under `/v2/projects`. |

Connection check: `list_projects` with no arguments.

Every tool but `list_projects` takes an optional `project_id`; without it, the key's only project is used (one extra request), and a key that sees several projects is asked which one.

## Credentials

**`apikey`: a V2 secret API key**

1. Sign in to [RevenueCat](https://app.revenuecat.com) and open the project.
2. Open **Project settings** → **API keys**.
3. Click **+ New secret API key**, name it (for example `AI agent`) and choose version **V2**.
4. Set its permissions: **Charts & Metrics** read-only (overview, revenue, charts), **Project configuration** read-only (projects, apps, products, offerings, entitlements), and **Customer information** no access.
5. Create the key and copy it; it starts with `sk_`. A v1 key does not work with this API.

**Revoking it:** RevenueCat → Project settings → API keys → delete the key. Calls fail with a 401 at once; create a new key to connect again.

## Limits

- RevenueCat allows 25 requests a minute per key for Charts & Metrics (overview, revenue, charts) and 60 for Project configuration; a 429 comes back with `retryAfter`.
- Charts count days in UTC; a period marked `incomplete` is still running (or starts before the range) and should be left out of trends.
- Chart filter values must not contain a comma, and a chart needs its option ids from `get_chart_options`.
- `get_chart_options` shows at most 200 values per filter.
