# HubSpot (`hubspot`)

CRM and marketing through the [HubSpot API](https://developers.hubspot.com/docs/api-reference): records of every type (contacts, companies, deals, tickets, products, line items, quotes, leads, custom objects, and engagements: notes, calls, tasks, meetings and emails) to list, read, search, create with associations, update and delete; properties, pipelines and owners; associations with their labels; lists (segments) and their members; marketing emails from draft to publish, transactional and single sends with their status; and the file manager, with uploads from a public URL. `api_get` and `api_request` reach the rest of the API, such as merges, batch updates, workflows and CMS pages.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `hubspot` | [HubSpot](https://www.hubspot.com) CRM: contacts, companies, deals, tickets, notes, tasks and other records (search, create, update, delete, associate), pipelines, owners, lists, marketing emails, transactional sends and files | HubSpot OAuth access token | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `hubspot` | `HUBSPOT_ACCESS_TOKEN`, optionally `HUBSPOT_PORTALID` | An access token of your own HubSpot app, installed in the account by its OAuth sign-in (an existing private app's token works too). The portal ID is the account's Hub ID. |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account: portal ID, type, time zone, currencies, data hosting location. Connection check. |
| `list_objects` | read | Records of a type with chosen properties and associated record ids. |
| `get_object` | read | One record by id or by a unique property (a contact by email), with property history if asked. |
| `search_objects` | read | Records by filter groups, a text query and a sort, with the total. |
| `create_object` | create | A record with its properties and associations: contacts, companies, deals, and engagements such as notes and tasks. |
| `update_object` | update | Sets properties of a record (owner, lifecycle stage, deal stage...). |
| `delete_object` | delete | Deletes a record (HubSpot keeps it in its recycling bin for 90 days). |
| `list_properties` | read | Properties of a record type with labels, types and dropdown options. |
| `list_pipelines` | read | Deal, ticket or other pipelines with their stages. |
| `list_owners` | read | Users who can own records, with their owner ids. |
| `list_associations` | read | A record's associated records of one type, with association types and labels. |
| `create_associations` | create | Associates up to 100 pairs of records, with the default type or a label. |
| `remove_associations` | delete | Removes associations between up to 100 pairs, all or one label. |
| `search_lists` | read | Lists (segments) by name, with their processing type and size. |
| `list_list_members` | read | The members of a list, optionally with their properties. |
| `add_to_list` | update | Adds up to 1,000 records to a manual or snapshot list. |
| `remove_from_list` | delete | Removes up to 1,000 records from a list. |
| `list_marketing_emails` | read | Marketing emails with state and, if asked, statistics. |
| `get_marketing_email` | read | One marketing email with its lists, statistics and, if asked, content. |
| `create_marketing_email` | create | A draft marketing email. |
| `update_marketing_email` | update | Changes a marketing email. |
| `publish_marketing_email` | create | Sends or schedules a marketing email (Marketing Hub Enterprise or the transactional email add-on). |
| `send_single_email` | create | Sends a published transactional or marketing email to one address, at most once per `send_id`. |
| `get_send_status` | read | The status and result of a single send. |
| `list_files` | read | Files in the file manager. |
| `upload_file` | create | Uploads a file from a public https URL to a folder. |
| `api_get` | read | Any other GET of the HubSpot API, such as association labels or a draft. |
| `api_request` | write | Any POST, PUT, PATCH or DELETE of the HubSpot API, such as merging two contacts. Sent once, never retried. OAuth endpoints are left out. |

Connection check: `get_account` with no arguments.

## Credentials

**`access_token`: a HubSpot access token**

A host that signs people in to HubSpot passes the current token on every call and refreshes it (HubSpot tokens last 30 minutes). For your own use:

1. In a HubSpot developer account, create an app with OAuth (**Development** → **Apps**), add your redirect URL, and choose its scopes: `crm.objects.contacts.read` and `.write`, `crm.objects.companies.read` and `.write`, `crm.objects.deals.read` and `.write`, `crm.objects.owners.read`, `crm.lists.read` and `.write`, `crm.schemas.contacts.read`, `content`, `files`, `transactional-email`, and `tickets` or `marketing-email` where you need them.
2. Send the account's user to `https://app.hubspot.com/oauth/authorize?client_id=<id>&redirect_uri=<uri>&scope=<scopes>`; they pick the account and grant access.
3. Exchange the code at `https://api.hubapi.com/oauth/v1/token` for an access token and a refresh token, and refresh the access token before it expires.

A token of an existing private app (HubSpot no longer lets you create new ones) is also a Bearer token and works here as it is.

**`portalid` (optional): the HubSpot account's ID**

The Hub ID shown in HubSpot's account menu, or `hub_id` of `https://api.hubapi.com/oauth/v1/access-tokens/<token>`. With it, `get_account` warns when a token belongs to another account.

The token goes only to `https://api.hubapi.com`, as `Authorization: Bearer <token>`.

**Revoking it:** in HubSpot, **Settings** → **Integrations** → **Connected Apps** → the app → **Uninstall**. Its tokens stop working at once.

## Limits

- HubSpot allows an app 110 requests every 10 seconds per account, and searches 5 a second; a 429 comes back as an error, and nothing is queued or retried. A search returns at most 10,000 results, 200 a page.
- A tool on a record type whose scope the sign-in did not grant answers 403 with the scopes HubSpot names.
- Publishing marketing emails needs Marketing Hub Enterprise or the transactional email add-on; transactional sends need that add-on, marketing single sends Marketing Hub Enterprise. HubSpot's API has no test send of a marketing email.
- One call associates or unlinks up to 100 pairs of records and changes up to 1,000 list members; a search takes up to 18 filters. Uploads are up to 20 MB, from public https addresses only.
- Text property values in results are cut at 4,000 characters, and email content at 16,000.
