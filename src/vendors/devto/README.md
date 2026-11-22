# dev.to connector

Draft-first publishing on [dev.to](https://dev.to) (DEV Community) through the Forem API v1: list your articles with their page views, reactions and comments, read an article's Markdown, save drafts, publish, unpublish and edit them with the AI disclosure dev.to asks for, read your analytics over a date range or for all time, and call the rest of the dev.to API.

Credential check: `list_my_articles` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `apikey` | `DEVTO_APIKEY` | A DEV Community API key, 24 letters and digits. It acts as the account. |

### Getting the API key

1. Sign in at [dev.to](https://dev.to/enter) with the account the articles should appear under.
2. Open your avatar menu, then **Settings**, then **Extensions** ([dev.to/settings/extensions](https://dev.to/settings/extensions)), and scroll to **DEV Community API Keys**.
3. Under **Generate a new Key**, type a description such as "AI agent" and click **Generate API Key**.
4. Copy the key from **Active API keys** and set it as `apikey`.

The key has no scopes: it can create and edit the account's articles, so keep it private. An account can hold up to 10 keys. To post under an organization, the account must be a member of it.

**Revoke it:** on the same page, click **Revoke** next to the key. Access stops at once.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_my_articles` | read | Your drafts and published articles, newest first, with URLs, edit links, tags, page views, reactions and comments. |
| `get_article` | read | One article with its Markdown body (one of your drafts, or a published article by id), to read or edit it; a long body comes in parts. |
| `create_draft_article` | create | Saves an unpublished draft: title, Markdown body, up to 4 tags, cover image, canonical URL, series, organization, and the AI disclosure dev.to asks for. Nothing becomes public. |
| `update_article` | update | Publishes a draft, turns an article back into a draft, or changes its fields. Only the fields given change. |
| `get_analytics` | read | Page views, reactions, comments, new followers and average read time per day over a range, with totals; or lifetime totals. For one article or an organization too. |
| `api_get` | read | Any other GET of the dev.to API under `/api/`: followers, comments, reading list, an organization's id and more. |
| `api_request` | write | A POST, PUT or DELETE to the dev.to API under `/api/`. Sent once, never retried. |

## Limits

- Writes: about one per second per key. New articles: about 10 per 30 seconds, far fewer for accounts a few days old (about one per 5 minutes). Edits: 30 per 30 seconds. Reads with the key: 4 per second, 40 per minute.
- dev.to refuses a title the account used in the last 5 minutes; the error points at the drafts, since an earlier attempt may have saved it.
- Titles up to 128 characters, up to 4 tags of letters and digits. A body must not start with a YAML front matter block (dev.to would read it as settings, even `published: true`).
- Analytics: days older than 180 days come grouped by week. A 404 means the account has no analytics yet.
- The API cannot delete articles: delete them on dev.to.

<!--
Rows for the main README.

Connectors table:
| `devto` | [dev.to](https://dev.to) articles: list your articles with their stats, read an article's Markdown, save drafts, publish and edit, analytics by date, and call the rest of the dev.to API | dev.to API key | Available |

Quick start table:
| `devto` | `DEVTO_APIKEY` | dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key. |

Tools: the table above.
-->
