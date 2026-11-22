# Brevo (`brevo`)

Email marketing and transactional email through the [Brevo API v3](https://developers.brevo.com/reference): the account and its senders, contacts (create, update, find, delete, blocklist), folders and lists, email campaigns from draft to test to send (now or scheduled) with their statistics, templates, transactional email with attachments, and transactional statistics and events. `api_get` and `api_request` reach the rest of the API: SMS campaigns, segments, contact attributes, webhooks and the CRM.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `brevo` | [Brevo](https://www.brevo.com) email: contacts, folders and lists, email campaigns (draft, test, send, schedule) with statistics, templates, transactional email and its events, and the rest of the Brevo API | Brevo API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `brevo` | `BREVO_APIKEY` | Brevo → your profile menu → SMTP & API → API Keys → Generate a new API key. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account: email, company, plan and remaining credits. Connection check. |
| `list_senders` | read | Senders with their ids and whether they are verified (active). |
| `list_contacts` | read | Contacts with attributes, lists and blocklist flags; filter by lists, segment, dates or an attribute. |
| `get_contact` | read | One contact by email, id, own id or phone, with campaign event counts (or the events). |
| `upsert_contact` | update | Creates a contact or updates the one with that email: attributes, lists, blocklist flags. |
| `update_contact` | update | Changes a contact's attributes, adds it to or removes it from lists, blocks or unblocks it. |
| `delete_contact` | delete | Deletes a contact for good. |
| `list_folders` | read | Contact folders with subscriber counts. |
| `create_folder` | create | A folder for lists. |
| `list_lists` | read | Lists with folder and subscriber counts, all or one folder's. |
| `create_list` | create | A list in a folder. |
| `list_list_contacts` | read | The contacts of a list. |
| `add_contacts_to_list` | update | Adds up to 150 contacts to a list, by email or id. |
| `remove_contacts_from_list` | delete | Removes up to 150 contacts from a list; the contacts stay. |
| `list_email_campaigns` | read | Campaigns with status, schedule and optionally their statistics. |
| `get_email_campaign` | read | One campaign with global, per-list and per-link statistics, optionally its HTML. |
| `create_email_campaign` | create | A draft campaign (or a scheduled one with `scheduled_at`) to lists or segments. |
| `update_email_campaign` | update | Changes a draft or scheduled campaign, or its schedule. |
| `send_test_email` | create | Sends a test of a campaign to given addresses or the test list. |
| `send_campaign_now` | create | Sends a campaign to all its recipients now. |
| `delete_email_campaign` | delete | Deletes a campaign that is not being sent. |
| `list_templates` | read | Email templates. |
| `get_template` | read | One template with its HTML. |
| `create_template` | create | A template for campaigns and transactional email. |
| `update_template` | update | Changes a template. |
| `send_transactional_email` | create | One email to up to 50 recipients, with HTML or text or a template with params, cc, bcc, reply-to, attachments by URL, optionally scheduled. |
| `get_transactional_stats` | read | Transactional totals for a period: delivered, opens, clicks, bounces, spam, unsubscribes. |
| `list_transactional_events` | read | Transactional events by recipient, event, message id, template or tag; shows whether an email went out. |
| `api_get` | read | Any other GET under `/v3/`, such as `/v3/contacts/attributes`, `/v3/contacts/segments` or `/v3/smsCampaigns`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/v3/`, such as creating or sending an SMS campaign or changing a campaign's status. Sent once, never retried. Organization users and sub-accounts are left out. |

Connection check: `get_account` with no arguments.

## Credentials

**`apikey`: a Brevo API key**

1. Sign in to [Brevo](https://app.brevo.com).
2. Open the profile menu at the top right and choose **SMTP & API**, then the **API Keys** tab (or go to [app.brevo.com/settings/keys/api](https://app.brevo.com/settings/keys/api)).
3. Click **Generate a new API key**, name it (for example `AI agent`) and click **Generate**.
4. Copy the key at once; it starts with `xkeysib-` and Brevo shows it only once.
5. If the account only accepts API calls from authorized IP addresses (**Security** → **Authorized IPs**), add the address the agent calls from, or Brevo answers 401 for every call.

The key goes only to `https://api.brevo.com/v3/`, in the `api-key` header.

**Revoking it:** Brevo → SMTP & API → API Keys → the key's menu → **Delete**. Calls fail with a 401 at once.

## Limits

- Brevo limits requests per endpoint and plan; a 429 comes back with `retryAfter`, and nothing is queued or retried.
- Campaigns and transactional email need a verified sender (see `list_senders`), and campaign HTML must contain `{{ unsubscribe }}`.
- Sending uses the plan's credits (the free plan sends 300 emails a day); without credits Brevo answers 402.
- A list call adds or removes at most 150 contacts; Brevo allows 50 campaign test emails a day.
- Campaign statistics in lists cover the last 6 months. HTML bodies in results are cut at 20,000 characters.
- `delete_contact` and `delete_email_campaign` cannot be undone; to stop emailing someone, set `email_blacklisted` with `upsert_contact` instead.
