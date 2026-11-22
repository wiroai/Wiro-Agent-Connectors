# Mastodon connector

Posting and reading on your own [Mastodon](https://joinmastodon.org) server with an access token: posts checked against your server's own limits, with visibility, content warnings, language and polls, images, videos or audio with alt text, replies and threads, scheduled posts (list, move, cancel), deleting your own posts, your recent posts with their favourites, boosts, replies and quotes, and the rest of the Mastodon API on your server.

Credential check: `get_account` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `instanceurl` | `MASTODON_INSTANCEURL` | The address of the server your account is on, such as `https://mastodon.social`. A profile link such as `https://fosstodon.org/@name` works too: only the server's address is used. It must be https. |
| `token` | `MASTODON_TOKEN` | The access token of an application you create in your own account. |

The connector sends requests to that server only. The address is a [credential origin](../../../README.md#credential-origins): hosts check it like a media URL (https, public addresses only) and never follow its redirects.

### Getting the server address

1. Sign in to your Mastodon account in a web browser.
2. Copy the start of the address bar, up to the first `/` after the domain, such as `https://mastodon.social`. Your full handle shows it too: `@name@fosstodon.org` is on `https://fosstodon.org`.

### Getting an access token

1. On your server's website, open **Preferences** (the gear icon), then **Development** (`https://your-server/settings/applications`).
2. Click **New application**. Use a name you are happy for followers to see; **Application website** can stay empty, and leave **Redirect URI** as it is.
3. Under **Scopes**, tick `read:accounts`, `read:statuses`, `write:media` and `write:statuses`. The `profile` box can stay; leave the broad `read`, `write` and `follow` boxes unticked.
4. Click **Submit**, open the new application, and copy **Your access token**.

The token does not expire. The steps are Mastodon's own; servers that run other software may differ.

**Revoke it:** in **Development**, delete the application, or click **Regenerate access token** on its page (the old token stops working). **Account**, then **Authorized apps**, lists it too, with a **Revoke** button.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The connected account: handle, link, counts, bot or locked, default visibility and language. |
| `get_instance_limits` | read | Your server's limits: characters per post and what a link counts as, media per post, alt text length, file sizes and types, poll limits. |
| `list_my_posts` | read | Your posts without boosts, newest first, with favourites, boosts, replies and quotes; narrow with replies left out, media only, pinned, or a hashtag. |
| `get_post` | read | One post by id or link on your server, and with `include_replies` the replies under it. |
| `list_scheduled_posts` | read | Your scheduled posts with their times. |
| `create_post` | create | Posts now or at `scheduled_at`, checked against your server's limits first: text, visibility, content warning, language, a poll, or media from public https URLs with alt text (uploaded and waited for). `reply_to` makes it a reply or the next post of a thread. The same post sent again within an hour is not posted twice (Idempotency-Key). |
| `reschedule_post` | update | Moves a scheduled post to another time. |
| `cancel_scheduled_post` | delete | Cancels a scheduled post. |
| `delete_post` | delete | Deletes one of your own posts with its media and returns its text for the record. |
| `api_get` | read | Any other GET of the Mastodon API under `/api/` on your server, such as `/api/v1/notifications`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/api/`, such as a favourite or an edit (PUT `/api/v1/statuses/<id>`). Sent once, never retried. What it may do depends on the token's scopes. |

## Limits

- Each server sets its own limits; `create_post` reads them before every post. Mastodon's defaults: 500 characters (a link counts as 23, `@name@server` as `@name`), 4 media per post, alt text up to 1,500 characters, images up to 16 MB and 33,177,600 pixels, videos up to 99 MB, polls of 2 to 4 options of up to 50 characters, open 5 minutes to a month.
- A post has media or a poll, never both, and a poll needs text. Media files are told apart by their bytes and must be a type the server lists.
- Scheduled posts: more than 5 minutes ahead; up to 25 per day and 300 in all for an account. A thread cannot be scheduled.
- Replies: the post must be given by its id or by the link your own server shows (for a post from another server, open it through your server's search first).
- Rate limits by default: 300 requests per 5 minutes, 30 media uploads and 30 deletes per 30 minutes for an account. A server can set others.
- Media that the server is still processing after 90 seconds stops the post before it is sent.

<!--
Rows for the main README.

Connectors table:
| `mastodon` | [Mastodon](https://joinmastodon.org) on your own server: posts within its limits with visibility, content warnings, polls and media with alt text, replies and threads, scheduled posts, deletes, your posts with their numbers, and the rest of the Mastodon API | Server address and access token | Available |

Quick start table:
| `mastodon` | `MASTODON_INSTANCEURL`, `MASTODON_TOKEN` | Your server's address (such as `https://mastodon.social`) and the access token of an application you create under Preferences → Development with the scopes `read:accounts`, `read:statuses`, `write:media`, `write:statuses`. |

Tools: the table above.
-->
