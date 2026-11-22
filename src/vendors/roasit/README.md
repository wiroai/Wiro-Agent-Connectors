# Roasit (`roasit`)

Mobile attribution numbers from [Roasit](https://roasit.com), through its report API: installs, spend, CPI, cohort revenue, ROAS (to date and day N) and retention by network, campaign, ad group and creative, with the ad networks' own campaign, ad group and ad ids (the keys to match them with the networks' own reports), iOS SKAdNetwork, install reconciliation against the stores, data freshness, the metric catalogue and each app's filter values and events. Every value equals the Roasit dashboard's Reports screen. Read-only, like the token.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `roasit` | [Roasit](https://roasit.com) attribution reports: creative, campaign and network ROAS, cohort revenue, retention, spend and installs, SKAdNetwork, install reconciliation and data freshness. Read-only | Roasit API token | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `roasit` | `ROASIT_APITOKEN` | Roasit → Account → API tokens → name it → Create; the `roapi_...` token is shown once. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The Roasit account behind the token and the token's name. |
| `list_apps` | read | The apps the token sees: app token, name, reporting currency, platforms, store ids, with `selected: true` on the apps chosen for the connection. Lists the candidates of the `apps` account picker. |
| `get_report` | read | One app's report, on one platform (`platform`) or the whole app: rows by day, platform, country, network, campaign, ad group or ad, with the metrics asked for, filters, sort, totals, currency, notes, spend freshness and spend depth, in pages. |
| `list_metrics` | read | The metric catalogue, with each metric's kind and the dimensions and filters it is allowed with. |
| `list_networks` | read | Network slugs, labels and whether each is paid. |
| `get_skan_report` | read | An app's SKAdNetwork postback status and rows by day and network, with unmapped sources. |
| `get_reconciliation` | read | Store installs against what each network claimed, for iOS or Android. |
| `get_data_freshness` | read | Whether an app's data is current: pull errors per source, SDK events, last verified SKAN postback. |
| `list_dimension_values` | read | The exact networks, campaigns, ad groups and ads an app's filters take. |
| `list_events` | read | An app's SDK events and their conversion mapping. |
| `api_get` | read | Any other GET of the Roasit API under `/api/`. |

Account picker `apps` (Roasit apps, one or more, listed by `list_apps`): a connection reports only on the apps chosen for it, so a host that offers the picker needs at least one app chosen. With none chosen, every app-level tool and `api_get` refuse before anything is sent (`get_account`, `list_apps`, `list_metrics` and `list_networks` without an app still answer); an app added to the account later is covered once it is chosen too. `list_apps` marks the chosen apps `selected: true`; every app-level tool refuses an app token outside the selection before anything is sent, and `api_get` must name a chosen app (`/api/apps/<app_token>/...` or `app_token`). A selection is a whole app, never one platform of it: one Roasit app token covers all of the app's platforms (`list_apps` shows them), and the platform goes with each call: `get_report`'s `platform` (`ios`, `android`, `web`; without it, the whole app), `get_reconciliation`'s `platform`, and `get_skan_report` for iOS.

Connection check: `get_account` with no arguments.

## Credentials

**`apitoken`: a Roasit API token**

1. Sign in to [Roasit](https://roasit.com).
2. Open your **Account** page and go to **API tokens**.
3. Give the token a name (for example `AI agent`) and click **Create**.
4. Copy the token; it starts with `roapi_` and is shown only once.

The token is read-only: it sees the apps your Roasit account can see and cannot change anything.

**Revoking it:** Roasit → Account → API tokens → revoke the token. Calls fail with a 401 at once; create a new token to connect again.

## Limits

- Roasit allows 120 requests a minute; a 429 comes back with `retryAfter` when Roasit sends a `Retry-After` header.
- A report covers at most 366 days and returns at most 1,000 rows (`rowsTotal` says how many there are); the server may take up to 55 seconds, longer than some hosts wait.
- `null` means the dashboard shows "-": not available yet, never zero. Daily metrics (`store_installs`, `blended_*`, ...) work only by day, platform or country.
- Filter values are comma lists, so a value that contains a comma cannot be given: filter on the id instead.
- Some app routes (reconciliation, connections, dimensions, events) answer 403 until Roasit opens them to API tokens.
