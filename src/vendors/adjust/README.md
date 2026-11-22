# Adjust (`adjust`)

Mobile attribution reports from [Adjust](https://www.adjust.com), through the [Report Service API](https://dev.adjust.com/en/api/rs-api/): creative-level ROAS with the networks' own campaign and creative ids (the keys to match them with Google Ads, Meta and other ad accounts), campaign and network rollups, cohort revenue, iOS SKAdNetwork reports, the metric catalogue and the apps' events. Read-only, like the Report Service API.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `adjust` | [Adjust](https://www.adjust.com) attribution reports: creative, campaign and network ROAS, installs, cost, cohort revenue and SKAdNetwork, with the metric catalogue and events. Read-only | Adjust API token | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `adjust` | `ADJUST_USERAPITOKEN` | Adjust dashboard → settings icon (bottom left) → Account settings → My profile → API Token. One token covers every app of the account. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_apps` | read | The account's apps: app token (12 characters) and name, with `selected: true` on the apps chosen for the connection. Lists the candidates of the `apps` account picker. |
| `get_report` | read | A report by dimensions and metrics over a date period, with app tokens, filters (`<field>__<operator>`), ad spend mode, attribution source and types, cohort maturity, currency, time zone and sort; rows, totals and warnings, in pages. |
| `get_filter_values` | read | The values a report may use: metric catalogues (overview, cohort, event, cost, SKAdNetwork), dimensions, networks, partners, countries and more, with search. |
| `list_events` | read | The apps' events by slug, for per-event metrics, and whether each is a SKAdNetwork event. |
| `api_get` | read | Any other GET of the Report Service API under `/reports-service/`, such as the pivot or CSV report. |

Account picker `apps` (Adjust apps, one or more, listed by `list_apps`): a connection reports only on the apps chosen for it, so a host that offers the picker needs at least one app chosen. With none chosen, `get_report`, `list_events` and `api_get` refuse before anything is sent (`list_apps` and `get_filter_values` still answer). To report on the whole account, choose every app; an app added to the account later is covered once it is chosen too. A report covers all the chosen apps by default, app tokens outside them are refused before anything is sent, and `api_get` must list only chosen apps in `app_token__in`. `list_apps` marks the chosen apps `selected: true`. The platform is not part of the choice: a report takes it per call (`os_names`). Without a lock (the CLI without `CONNECTOR_ACCOUNTS`), a report without `app_tokens` covers the whole account.

Connection check: `list_apps` with no arguments.

## Credentials

**`userapitoken`: the Adjust API token**

1. Sign in to your [Adjust dashboard](https://suite.adjust.com).
2. Click the **settings** icon at the bottom left, then **Account settings**.
3. Open the **My profile** tab and copy your **API Token**.

The token acts as your Adjust user and sees every app your user can see.

**Revoking it:** Account settings → My profile → reset the API token. The old token stops working at once; copy the new one to connect again.

## Limits

- Adjust allows 50 simultaneous requests per token; a 429 comes back with `retryAfter` when Adjust sends it. A query too heavy to finish answers 504: split the date range or drop a dimension.
- Row values come as text, as Adjust sends them; totals are numbers.
- SKAdNetwork postbacks arrive 24 to 72 hours late: use `-9d:-2d` or `last_week` for SKAdNetwork reports, and never add `installs` and `skad_installs` together.
- `cohort_maturity` `mature` (Adjust's default) shows zero for cohorts that have not matured yet.
