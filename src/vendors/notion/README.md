# Notion connector

[Notion](https://www.notion.com) pages and databases through the [Notion API](https://developers.notion.com/reference), Notion-Version `2026-03-11`: search what the connection can see, read pages as Markdown or as blocks, read database schemas and query them with filters, create pages and database rows, add and edit content, update properties, and move pages and blocks to the trash.

| | |
| --- | --- |
| What it can do | Search pages and databases, read pages as Markdown or blocks, query databases, create pages and rows, add and edit content, update properties, move to the trash |
| Auth | A Notion API token: an internal connection's token or a personal access token |
| Environment variable | `NOTION_TOKEN` |
| Where to get it | Notion's Developer portal → New connection → API token (Workspace Owners), or a personal access token from notion.so/developers/tokens |

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `token` | `NOTION_TOKEN` | Yes |

The token goes only to `https://api.notion.com/v1/`, as `Authorization: Bearer <token>`.

### An internal connection's token (Workspace Owners)

1. Sign in to Notion as a Workspace Owner and open the Developer portal at [app.notion.com/developers/connections](https://app.notion.com/developers/connections) (in Notion: **Settings → Connections → Develop or manage connections**). Switch to the right workspace first: a connection belongs to one workspace.
2. On the **Developer connections** tab, select **New connection**, give it a name, choose **API token** as the authentication method and select **Create connection**.
3. On the connection's **Configuration** tab, tick **Read content**, **Update content** and **Insert content**. **User information without email addresses** lets the connector look people up by name (`list_users`); comment capabilities are not used by the tools.
4. Select **Show** next to the **API token** and copy it. It starts with `ntn_` (tokens made before September 25, 2024 start with `secret_`).
5. Share pages with the connection, since a new connection sees nothing: open a page or database, click **•••** → **Connections** → **+ Add connection** and pick the connection. Sub-pages are shared with their parent. The connection's **Content access** tab does the same.

### A personal access token (any member, where allowed)

1. Open [notion.so/developers/tokens](https://www.notion.so/developers/tokens) and select **New token**.
2. Name it, tick the **Notion API** capability, choose an expiry (7, 30, 90 or 180 days, or 1 year) and select **Create token**.
3. Copy it at once: Notion shows it only once. It acts as you, reaches every page you can open without the sharing step, and stops working when it expires. On the Free plan only Workspace Owners can create one, on Plus every member can, and on Business and Enterprise an admin decides.

### How to revoke it

Remove the connection from a page's **Connections** menu, or delete the connection in the Developer portal. If a token leaks, select **Refresh** on the connection's **Configuration** tab: the old token stops working. A personal access token is revoked on the same tokens page, or by a workspace admin under **Settings → Connections**.

## Tools

IDs can be given as the 32 hexadecimal characters at the end of a page's link, with or without dashes, or as the whole link.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_connection` | read | Checks the token: the connection's name, workspace, and whether it sees only shared pages or acts as a person. |
| `search` | read | Pages and databases (data sources) by title, most recently edited first; everything the connection sees when no query is given. |
| `get_page` | read | One page or database row: title, link, parent, trash state and every property with its type and value. |
| `read_page_markdown` | read | A page's body as Notion-flavored Markdown, in windows of about 24 KB with a cursor; names the blocks Notion left out. |
| `list_block_children` | read | One level of a page's or block's blocks with their IDs, types and text, to append after a block, edit one or trash one. |
| `get_block` | read | One block by its ID. |
| `get_database` | read | A database's title, link and the data sources inside it (queries and rows use a data source ID). |
| `get_data_source` | read | A data source's schema: property names, types, IDs, select and status options, relation targets and computed properties. |
| `query_data_source` | read | Rows of a data source with a Notion filter and sorts, each with its title, link and property values. |
| `list_users` | read | Workspace members and bots with their IDs, to fill a person property (needs a user information capability). |
| `create_page` | create | A page under a page, a database row with its properties, or a private top-level page (personal access tokens only), with a Markdown body or up to 100 blocks. An unclear outcome is checked with `list_block_children` on the parent page (a row with `query_data_source`), since search lags behind. |
| `append_markdown` | create | Adds Markdown at the end or the start of a page. |
| `append_blocks` | create | Adds up to 100 blocks to a page or inside a block, at the end, at the start or after a given block. |
| `update_page_text` | write | Replaces exact passages of a page's Markdown in place. Sending the same edit twice can change the page twice, so it is marked destructive and not idempotent. |
| `replace_page_markdown` | update | Replaces a page's whole body; child pages and databases are never deleted. |
| `update_page` | update | Renames a page or changes a row's properties, icon or cover; optionally without notifications. |
| `update_block` | update | Changes one block, such as ticking a to-do or rewriting a paragraph. |
| `trash_page` | delete | Moves a page or a row to Notion's Trash. |
| `restore_page` | update | Takes a page or a row out of the Trash. |
| `trash_block` | delete | Moves one block to Notion's Trash. |
| `api_get` | read | Any other GET of the Notion API under `/v1/`, such as comments or file uploads. |
| `api_request` | write | A POST, PATCH or DELETE to the Notion API under `/v1/`, such as adding a comment, changing a data source or erasing a page's content (`erase_content`, which cannot be undone through the API). Sent once, never retried. |

## Limits

- Notion allows a connection 180 requests a minute, or 600 on Business and Enterprise plans, and limits a whole workspace too; queries about 3 a second. A `429` comes back with `retryAfter`; nothing is queued or retried.
- One request carries at most 100 blocks in a list, two levels of nesting and 500 KB; a text item holds at most 2,000 characters. A Markdown create or edit may produce up to 5,000 blocks.
- A Free workspace with more than one member can create 1,000 blocks in its lifetime; after that (and a three-day grace period) writes answer `403` until an owner upgrades. Personal access tokens are not limited this way.
- Notion's API cannot delete anything for good: trashed pages and blocks stay in Notion's Trash. Images go in by public https URL; the connector uploads no files.
- A Markdown read stops at about 20,000 blocks; the blocks left out are named so they can be read on their own.
