# Mailchimp (`mailchimp`)

Email marketing through the [Mailchimp Marketing API 3.0](https://mailchimp.com/developer/marketing/api/): the account, audiences and their members (add, update, tag, archive, delete for good, bulk add, search), campaigns from draft to content to checklist to test to send or schedule, templates, segments and tags, campaign reports with clicks, opens and unsubscribes, and classic automations. `api_get` and `api_request` reach the rest of the API, such as merge fields, interest groups, audience activity and the file manager.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `mailchimp` | [Mailchimp](https://mailchimp.com) email marketing: audiences and members, campaigns (draft, content, checklist, test, send, schedule), templates, segments and tags, reports and automations | Mailchimp sign-in (access token and data center) or API key | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `mailchimp` | `MAILCHIMP_APIKEY`, or `MAILCHIMP_ACCESS_TOKEN` with `MAILCHIMP_SERVER` (alternatives) | An API key from Mailchimp → Profile → Extras → API keys → Create A Key (the whole key, with its last part such as `-us19`); or an access token from your own registered Mailchimp app with its data center (such as `us19`). |

## Tools

Members are named by email; the connector computes Mailchimp's subscriber hash (the MD5 of the lower-cased address) itself.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account, plan, total subscribers, its data center and how it is connected. Connection check. |
| `list_audiences` | read | Audiences with member, unsubscribe and cleaned counts, rates and campaign defaults. |
| `create_audience` | create | An audience with its contact address, permission reminder and defaults. |
| `list_members` | read | Members of an audience, most recently changed first; filter by status, change time or VIP. |
| `get_member` | read | One member by email. |
| `search_members` | read | Members by email or name, in all audiences or one. |
| `upsert_member` | update | Adds a person (with `status_if_new`, `pending` for double opt-in) or updates the member. |
| `batch_upsert_members` | update | Adds or updates up to 500 members in one call, with counts and errors. |
| `update_member_tags` | update | Adds and removes a member's tags. |
| `remove_member` | delete | Archives a member, or deletes the member and their data for good. |
| `list_campaigns` | read | Campaigns with status, audience, recipients and, once sent, opens and clicks. |
| `get_campaign` | read | One campaign, optionally with its HTML and plain text. |
| `create_campaign` | create | A draft campaign (regular, plain text, RSS or A/B test) to an audience or a segment. |
| `update_campaign` | update | Changes a draft's audience, segment or settings. |
| `set_campaign_content` | update | Sets a draft's HTML, plain text, imported page or template sections. |
| `get_send_checklist` | read | Whether a campaign is ready to send, item by item. |
| `send_test_email` | create | Sends a test to up to 10 addresses. |
| `send_campaign` | create | Sends a campaign now. |
| `schedule_campaign` | update | Schedules a campaign on a quarter hour, optionally in each subscriber's time zone. |
| `unschedule_campaign` | update | Stops a scheduled campaign. |
| `list_templates` | read | Templates (yours, base or gallery). |
| `create_template` | create | An HTML template with editable sections. |
| `list_segments` | read | Segments and tags of an audience with member counts. |
| `create_segment` | create | A static segment (tag) of emails, or a saved segment of conditions. |
| `update_segment_members` | update | Adds and removes up to 500 members of a static segment or tag. |
| `list_reports` | read | Results of sent campaigns. |
| `get_campaign_report` | read | One campaign's results: sends, opens, clicks, bounces, unsubscribes. |
| `get_report_details` | read | Per link clicks, who opened, unsubscribes, per recipient activity, domains, locations, abuse reports or advice. |
| `list_automations` | read | Classic automations with status and results. |
| `set_automation_state` | update | Pauses or starts all emails of a classic automation. |
| `api_get` | read | Any other GET under `/3.0/` at the account's data center, such as merge fields or interest categories. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/3.0/`, such as replicating a campaign. Sent once, never retried. Authorized apps are left out, in batches too. |

Connection check: `get_account` with no arguments.

## Credentials

The connector takes either a Mailchimp sign-in or an API key; with both, the sign-in is used. Requests go only to `https://<data center>.api.mailchimp.com/3.0/`, where the data center is one Mailchimp names (`us1` to `us30`): a sign-in's `server`, or the API key's last part.

**`access_token` and `server`: a Mailchimp sign-in**

A host that signs people in to Mailchimp passes the access token and the data center (`server`) Mailchimp reports for it. For your own use:

1. Register an app in Mailchimp → **Profile** → **Extras** → **Registered apps** → **Register An App**, with your redirect URI.
2. Send the person to `https://login.mailchimp.com/oauth2/authorize?response_type=code&client_id=<id>&redirect_uri=<uri>`, then exchange the code at `https://login.mailchimp.com/oauth2/token`.
3. Read the data center (`dc`, such as `us19`) from `https://login.mailchimp.com/oauth2/metadata` with the header `Authorization: OAuth <token>`.

Mailchimp access tokens do not expire; they last until the person removes the app.

**Revoking a sign-in:** Mailchimp → **Integrations** → **Manage** → **Other connections** → the **X** next to the app → type `DELETE` → **Delete**.

**`apikey`: a Mailchimp API key**

1. In Mailchimp, click your profile icon → **Profile** → **Extras** → **API keys** (Manager permission or higher).
2. Under **Your API Keys**, click **Create A Key**, name it (for example `AI agent`) and click **Generate Key**.
3. Copy the whole key, including its last part after the dash (such as `-us19`): that part is the account's data center. Mailchimp shows the key only once.

Keys made on or after June 22, 2026 expire one year after they were created. A key gives full access to the account.

**Revoking it:** Profile → Extras → API keys → **Revoke** next to the key → type `REVOKE` → **Revoke**. A revoked key cannot be turned back on.

## Limits

- Mailchimp allows 10 simultaneous connections per account; a 429 comes back as an error, and nothing is queued or retried.
- Sending cannot be undone; run `get_send_checklist` first. Schedule times are in UTC on a quarter hour, at least 15 minutes ahead; time zone sending needs a paid plan.
- A bulk member call takes 500 members; a static segment change 500 additions and 500 removals. Permanently deleted members cannot be re-imported.
- Free plans have one audience. The automation tools cover classic automations; a customer journey can only be started at an API trigger step, with `api_request` (`POST /3.0/customer-journeys/journeys/{journey_id}/steps/{step_id}/actions/trigger`).
- HTML in results is cut at 20,000 characters.
