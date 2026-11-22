# Hashnode connector

Your [Hashnode](https://hashnode.com) blog through Hashnode's GraphQL API at `https://gql-beta.hashnode.com`: drafts first, published when you say so (or straight away when asked), edits to drafts and live posts, the blog's posts with views, reactions and comments, your drafts, tags, cover images, canonical links for cross-posts, series and SEO fields.

**Hashnode Pro is required.** Since May 13, 2026, Hashnode's API answers only for blogs on [Hashnode Pro](https://hashnode.com/pro) ($5 a month or $50 a year per seat), for reads and writes alike. A blog without it gets `FORBIDDEN` ("Publication does not have an active Pro plan"); the connector says so and nothing is retried.

| | |
| --- | --- |
| What it can do | Save drafts and publish them, publish posts directly, edit drafts and live posts, list posts with views, reactions and comments, list drafts, series, and any other GraphQL query or mutation |
| Auth | A Hashnode Personal Access Token and the blog's address |
| Environment variables | `HASHNODE_TOKEN`, `HASHNODE_PUBLICATIONHOST` |
| Where to get them | Hashnode → Account Settings → Developer → Generate new token; the blog address is the bare host, such as `yourname.hashnode.dev` |

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `token` | `HASHNODE_TOKEN` | Yes |
| `publicationhost` | `HASHNODE_PUBLICATIONHOST` | Yes |

The token goes only to `https://gql-beta.hashnode.com/`, in the `Authorization` header with no scheme (a pasted `Bearer ` prefix is removed).

### The Personal Access Token

1. Sign in at [hashnode.com](https://hashnode.com) with the account that writes on the blog.
2. Open your profile menu → **Account Settings** → **Developer** ([hashnode.com/settings/developer](https://hashnode.com/settings/developer)).
3. Click **Generate new token** and copy it. It looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

The token acts as your account on every blog you belong to: it can publish and edit posts, so keep it private.

### The blog address

The blog's host exactly as your browser shows it, without `https://` and without a trailing slash: `yourname.hashnode.dev`, or a custom domain such as `blog.example.com` (a full URL is reduced to its host). The account behind the token must be a member of the blog. On a team blog, publishing needs the Owner or Editor role; a Contributor's drafts go to the editors with `submit_draft_for_review`.

### How to revoke it

Revoke the token on the same **Developer** page: access stops at once. Generate a new one to reconnect.

## Tools

Every read is a GraphQL query sent by POST, which changes nothing.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_blog` | read | The blog at the saved address: its ID, title, URL and whether it is a team blog; also tells whether it is on Pro. |
| `list_my_blogs` | read | The token's account and the blogs it owns, to find the right address. |
| `list_posts` | read | The blog's published posts, newest first, with views, reactions, comments and replies. |
| `list_drafts` | read | Your drafts on the blog, with their editor links. |
| `get_draft` | read | One draft with its Markdown (in windows with a cursor), tags, cover, series and SEO fields. |
| `get_post` | read | One published post by its slug or ID, with stats and its Markdown. |
| `list_series` | read | The blog's series, for `series_id`. |
| `create_draft` | create | Saves a draft; nothing becomes public. Returns its editor link. |
| `update_draft` | update | Changes a draft's fields or body. |
| `publish_draft` | update | Publishes a draft: it becomes a live post and the draft is removed. |
| `publish_post` | create | Publishes a new post at once, with no draft. |
| `update_post` | update | Changes a live post at once. |
| `submit_draft_for_review` | update | Hands a contributor's draft to a team blog's editors. |
| `graphql_query` | read | Any other GraphQL query, such as a tag, a user, scheduled drafts or a post's comments. One query per call, with the fragments it uses. |
| `graphql_mutation` | write | Any other GraphQL mutation, such as rejecting a submitted draft. One mutation per call, sent once, never retried. Deleting posts and drafts is not offered. |

`create_draft` and `update_draft` take `send_newsletter`, which emails the blog's newsletter subscribers when the post goes live, and `delist`, which keeps a post out of Hashnode's feeds: both stay off unless asked for. `published_at` only backdates a post moved from another blog; it does not schedule.

## Limits

- Requests up to 100 KB (the connector refuses a bigger one before sending it); queries at most 10 levels deep; `first` at most 100 for posts and 50 for drafts.
- Hashnode publishes targets of 20,000 queries and 500 changes a minute. Nothing is retried; a write without a clear answer is reported as unknown, with the read tool to check.
- Views are lifetime numbers and can be missing for a post (left out, never shown as 0); there are no stats by date. A list can be up to about 25 seconds old right after a write.
- Covers and images go in by public https URL; the connector uploads no files. The API cannot create a series, and the connector never deletes posts or drafts: do that in Hashnode.
