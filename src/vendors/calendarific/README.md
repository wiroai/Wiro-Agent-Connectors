# Calendarific (`calendarific`)

Public, local, religious and bank holidays and observances for 230+ countries and their states and regions from [Calendarific](https://calendarific.com), with your own API key: a country's holidays in a year, a month or on a day, the holidays coming up in a window of days, and the countries and languages Calendarific covers. Read-only.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `calendarific` | Holidays and observances for 230+ countries from [Calendarific](https://calendarific.com): by year, month or day, the holidays coming up in the next days, by kind, region and language. Read-only | Calendarific API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `calendarific` | `CALENDARIFIC_APIKEY` | The API key on your [Calendarific](https://calendarific.com) account dashboard (free plan available). |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_holidays` | read | A country's holidays and observances in a year, a month or on a day: name, date, description, kinds, where it applies (the whole country or its states) and its Calendarific page. Filters for kind (national, local, religious, observance), region (ISO 3166-2, such as `us-ny`) and language. |
| `list_upcoming_holidays` | read | The holidays of a country in a window of up to 366 days from a date (today by default), by date, with the same filters: for planning around the next weeks. One or two requests. |
| `list_countries` | read | Every country covered, with its ISO 3166-1 code, number of holidays and number of languages. |
| `list_languages` | read | The languages names and descriptions can be translated into (paid plans), with code, English and native name. |

Connection check: `list_languages` with no arguments (one request of the monthly limit).

## Credentials

**`apikey`: the Calendarific API key**

1. Sign up at [calendarific.com](https://calendarific.com/register). The free plan is enough to start.
2. Sign in and copy the API key shown on your account dashboard.
3. Set it as `apikey`.

Anyone with the key can spend your plan's requests, so keep it private. Calendarific takes it only as the `api_key` query parameter of each request.

**Revoking it:** rotate the key on your Calendarific account dashboard. The old key stops working, and the new one is shown in its place.

## Limits

- Every request counts toward the plan's monthly limit, errors included: 500 a month on the free plan, more on paid plans. Once it is reached, Calendarific answers HTTP 429 until the plan's month starts again.
- `list_upcoming_holidays` asks for whole months, or the whole year when the window covers more than one month of a year: one request for a window within a month or within a year, two across a new year.
- The free plan answers in English only and has limited access to past and future years; translations (`language`) need a paid plan, and holiday `id` and `uuid` come with the Business and Enterprise plans. The free plan asks for attribution where the data is shown.
- An expired subscription answers HTTP 403; planned maintenance answers HTTP 503.
- A long list (a whole year of a large country) is cut to fit 32 KB; `nextCursor` asks again for the rest (another request).
