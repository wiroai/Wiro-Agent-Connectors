# SendGrid (`sendgrid`)

Email through the [SendGrid Web API v3](https://docs.sendgrid.com/api-reference): send email with text, HTML or dynamic templates and attachments from public URLs; manage Marketing Campaigns contacts (add, update, search, delete), lists and custom fields; build, schedule, send and measure Single Sends; manage dynamic templates and their versions, verified senders and unsubscribe groups; read statistics, email activity and suppressions. `api_get` and `api_request` reach the rest of the API, such as segments, event webhooks and domain authentication.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `sendgrid` | [SendGrid](https://sendgrid.com) email: send with templates and attachments, Marketing Campaigns contacts, lists and Single Sends (draft, schedule, send, stats), dynamic templates, senders, statistics and suppressions | SendGrid API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `sendgrid` | `SENDGRID_APIKEY` | SendGrid → Settings → API Keys → Create API Key (Full Access, or Restricted Access with the permissions the tools need). |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | What the API key may do (its scopes), plus account type and reputation. Connection check. |
| `send_email` | create | One email to up to 1,000 recipients (own copies or one shared email with cc and bcc), text, HTML or a dynamic template, attachments from public URLs, optional schedule or sandbox check. |
| `search_email_activity` | read | Recent emails by an activity query (recipient, subject, status); needs the Email Activity history add-on. |
| `upsert_contacts` | update | Adds or updates up to 1,000 contacts, optionally into lists; returns a job id. |
| `get_import_status` | read | The status and counts of a contacts import or delete job. |
| `search_contacts` | read | Contacts by an SGQL query (up to 50 returned, with the total). |
| `get_contacts_by_email` | read | Contacts by email address, up to 100 at a time. |
| `delete_contacts` | delete | Deletes up to 100 contacts by id; returns a job id. |
| `list_custom_fields` | read | Custom and reserved contact fields with their ids. |
| `list_lists` | read | Lists with their contact counts. |
| `create_list` | create | A list. |
| `delete_list` | delete | Deletes a list, keeping its contacts unless asked. |
| `list_single_sends` | read | Single Sends with status and send time. |
| `get_single_send` | read | One Single Send with recipients, sender, unsubscribe setting and bodies. |
| `create_single_send` | create | A draft Single Send. |
| `update_single_send` | update | Changes a draft Single Send. |
| `schedule_single_send` | update | Schedules a Single Send, or sends it now. |
| `unschedule_single_send` | update | Cancels a scheduled Single Send; it becomes a draft. |
| `delete_single_send` | delete | Deletes a Single Send. |
| `get_single_send_stats` | read | Delivered, opens, clicks, bounces, spam reports and unsubscribes of a Single Send. |
| `list_templates` | read | Dynamic or legacy templates with their versions. |
| `get_template` | read | One template with the active version's subject and bodies. |
| `create_template` | create | An empty template. |
| `create_template_version` | create | A version (subject, HTML, text) of a template, active by default. |
| `list_senders` | read | Verified senders with their ids. |
| `create_sender` | create | A sender identity; SendGrid emails a verification link. |
| `list_unsubscribe_groups` | read | Unsubscribe groups with their ids and counts. |
| `get_stats` | read | Statistics for a date range, in total and per period, for the account or per category. |
| `list_suppressions` | read | Bounces, blocks, spam reports, invalid emails or global unsubscribes. |
| `delete_suppression` | delete | Removes one address from a suppression list. |
| `api_get` | read | Any other GET under `/v3/`, such as `/v3/marketing/segments/2.0` or `/v3/marketing/contacts/count`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/v3/`. Sent once, never retried. API keys, teammates, subusers and access settings are left out. |

Connection check: `get_account` with no arguments.

## Credentials

**`apikey`: a SendGrid API key**

1. Sign in to [SendGrid](https://app.sendgrid.com).
2. Open **Settings** → **API Keys** and click **Create API Key**.
3. Name it (for example `AI agent`) and pick **Full Access**, or **Restricted Access** with: Mail Send (full), Marketing (full), Template Engine (full), Suppressions (full), Sender Authentication (full, for verified senders), Stats (read), and Email Activity (read) if the account has that add-on.
4. Click **Create & View** and copy the key; it starts with `SG.` and SendGrid shows it only once.

The key goes only to `https://api.sendgrid.com/v3/`, as `Authorization: Bearer <key>`.

**Revoking it:** SendGrid → Settings → API Keys → the key's menu → **Delete**. Calls fail with a 401 at once.

## Limits

- An email takes at most 1,000 recipients and 30 MB; attachments here are up to 10 files and 20 MB in all, downloaded from public https addresses only. `send_at` can be at most 72 hours ahead.
- Contacts are added and deleted in the background; `get_import_status` follows the job. SGQL searches return at most 50 contacts.
- Scheduling a Single Send needs a sender, recipients, and an unsubscribe group or custom unsubscribe URL. Sending cannot be undone.
- SendGrid limits requests per endpoint; a 429 comes back with `retryAfter`, and nothing is queued or retried.
- `search_email_activity` needs SendGrid's Email Activity history add-on. Accounts on SendGrid's EU region (`api.eu.sendgrid.com`) are not supported.
- Bodies in results are cut at 20,000 characters.
