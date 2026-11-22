# Apollo (`apollo`)

Sales prospecting and engagement through the [Apollo REST API](https://docs.apollo.io/reference): search Apollo's people and company database, enrich people and companies (emails, phones, firmographics), company job postings and news; your saved contacts and accounts (create, upsert, update, search, read); sequences (search, add contacts, stop or finish them, activate or deactivate) and their outreach emails; deals, tasks and call logs; and the team's users, email accounts, stages, lists and custom fields. `api_get` and `api_request` reach the rest of the API.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `apollo` | [Apollo](https://www.apollo.io) prospecting: people and company search, enrichment (credits), contacts and accounts, sequences and outreach emails, deals, tasks and calls | Apollo API key and/or master API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `apollo` | `APOLLO_APIKEY`, or `APOLLO_MASTERAPIKEY` (alternatives; with both, the master key is used) | Apollo → Settings → Integrations → API → Create new key: pick its endpoints, or set it as the master key (admins). |

## Tools

People search and everything about your own records is free; enrichment, company search, job postings and news use Apollo credits, as each tool says.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The key's user and team, and the user's credits: allowance and use per kind, lead credits left. Connection check. |
| `get_usage` | read | API calls and rate limits left per endpoint, or credits used. |
| `search_people` | read | Prospects by title, seniority, location, company and keywords (free; no emails or phones). |
| `enrich_people` | read | Full profiles of 1 to 10 people with work email (credits); phones later, by request id while Apollo's lookup is pending. |
| `get_enrichment_result` | read | The phones of an earlier enrichment, by its request id (a signed number, passed exactly as given). |
| `enrich_organizations` | read | Profiles of 1 to 10 companies by domain (credits). |
| `search_organizations` | read | Companies by name, domain, size, location, keywords, technologies, funding (credits per page). |
| `list_job_postings` | read | A company's open jobs (credits per page). |
| `search_news` | read | News about companies (credits per page). |
| `create_contacts` | create | Saves 1 to 100 contacts, without deduplication. |
| `upsert_contacts` | update | Saves 1 to 100 contacts without duplicates: one contact updates its match in place; in bulk, matches come back unchanged for `update_contact`. |
| `update_contact` | update | Changes a contact. |
| `search_contacts` | read | Your contacts by keywords, stages or lists. |
| `get_contact` | read | One contact. |
| `create_accounts` | create | Saves 1 to 100 companies as accounts. |
| `update_account` | update | Changes an account. |
| `search_accounts` | read | Your accounts by name, stages or lists. |
| `get_account` | read | One account. |
| `search_sequences` | read | Sequences with their activity and rates. |
| `add_contacts_to_sequence` | create | Adds contacts (or lists) to a sequence, sending from an email account. |
| `update_sequence_contacts` | update | Stops, finishes or removes contacts in sequences. |
| `set_sequence_active` | update | Activates or deactivates a sequence. |
| `search_outreach_emails` | read | Sequence emails by sequence, status, reply class (replies), user, or a range of due or sent dates. |
| `get_outreach_email_activities` | read | One outreach email's deliveries, opens, clicks and reply. |
| `create_deal` | create | A deal with amount, stage, owner, account and close date. |
| `search_deals` | read | Deals by name, account, owner, stage, open or closed. |
| `update_deal` | update | Changes a deal's stage, amount, close date. |
| `get_deal` | read | One deal. |
| `create_tasks` | create | A task for a user about 1 to 100 contacts. |
| `search_tasks` | read | Tasks by due date or priority. |
| `log_call` | create | Logs a call made outside Apollo. |
| `search_calls` | read | Calls by date, direction, user or keywords. |
| `list_team_data` | read | Users, email accounts, contact, account and deal stages, lists and custom fields, with their ids. |
| `api_get` | read | Any other GET under `/api/v1/`, such as `/api/v1/notes`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/api/v1/`, such as completing a task. Sent once, never retried. |

Connection check: `get_profile` with no arguments.

## Credentials

Either key connects; with both, every call uses the master key. A master key reaches every endpoint, another key only the endpoints chosen for it (a 403 says when a key lacks one).

**`apikey`: an Apollo API key**

1. Sign in to [Apollo](https://app.apollo.io) and open **Settings** → **Integrations** → **API** ([app.apollo.io/#/settings/integrations/api](https://app.apollo.io/#/settings/integrations/api)).
2. Click **Create new key** (API keys tab), name it (for example `AI agent`).
3. Choose the endpoints it may use: for every tool here, the people, organization, contact, account, sequence, outreach email, deal, task, call, label, user, email account and usage endpoints.
4. Click **Create** and copy the key.

**`masterapikey` (optional): an Apollo master API key**

The same steps, with **Set as master key** turned on instead of choosing endpoints. Only admins can make one.

The key goes only to `https://api.apollo.io/api/v1/`, in the `x-api-key` header.

**Revoking it:** Settings → Integrations → API → the key's menu → **Delete**. Calls with it fail with a 401 at once.

## Limits

- Credits: people and company enrichment 1 per record found (8 more for a mobile phone), company search, job postings and news 1 per page; people search is free. `get_profile` shows the credits left.
- Apollo limits each endpoint per minute, hour and day by plan (`get_usage` shows them); a 429 comes back with `retryAfter`, and nothing is queued or retried.
- People search shows at most 50,000 people (500 pages of 100). Enrichment takes 10 people or companies a call; contacts, accounts and tasks are created 100 at a time.
- Phone numbers come later: `enrich_people` with `reveal_phone_number` returns a `request_id` for `get_enrichment_result` only while `phone_enrichment` is `pending` (`skipped` or `not_attempted` means there is nothing to fetch). Apollo keeps the result for 30 days.
- `upsert_contacts` needs an email, or a first and last name with a company, for each contact. Apollo's bulk endpoint never overwrites a contact it matches: with several contacts the matches come back in `unchanged_existing_contacts`, to change with `update_contact`.
- Apollo's API cannot delete contacts, accounts or deals.
