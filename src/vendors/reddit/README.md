# Reddit connector (`reddit`)

Works with [Reddit](https://www.reddit.com) through the Reddit Data API, within the scope Reddit's terms give an app like this: the connected account, its communities, one community's rules, one text or link post at a time, one comment or reply at a time, and edits and deletes of the account's own posts and comments. There is no voting, messaging, moderation, crossposting or bulk posting, and no generic write tool: every change goes through a tool that checks it first.

It keeps Reddit's rules for automated posting in the connector itself:

- **Rate window.** Requests of one app go out one at a time. The connector reads Reddit's `X-Ratelimit-Used`, `-Remaining` and `-Reset` headers on every reply, stops sending when the window is spent or Reddit answers 429, holds writes back for the delay Reddit states in a `RATELIMIT` reply, and keeps the last request of a window for a write. Results carry the current window as `rateLimit`.
- **No duplicates.** Each post and comment is remembered by a SHA-256 digest of the operation, the account, the target and the normalized text (case, spacing and tracking parameters do not matter; the text itself is never kept). An identical post or comment that went through in the last 48 hours is not sent again; the same text is not repeated in another community or thread; and after an unclear outcome the same request needs a check and `allow_repeat_after_check: true`. A deleted post or comment is forgotten, so it may be written again.
- **Own content only.** `edit_text` and `delete_item` ask Reddit who is connected and who wrote the item right before they change it.

This memory lives as long as the connector is loaded; nothing is stored anywhere else.

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `access_token` | `REDDIT_ACCESS_TOKEN` | yes |
| `developerprofileusername` | `REDDIT_DEVELOPERPROFILEUSERNAME` | yes |
| `redditusername` | `REDDIT_REDDITUSERNAME` | no |

**`access_token`**: an OAuth access token of the account, from your own Reddit **web app**. A host that connects Reddit for you runs this sign-in and refreshes the token (it lasts an hour); the connector never refreshes or stores it. To get one yourself:

1. Open [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) while signed in to the account that will own the app, and choose **create another app**.
2. Pick **web app**, add your redirect URI, and create it. The client id is under the app's name, the secret next to **secret**.
3. Send the account to `https://www.reddit.com/api/v1/authorize` with `response_type=code`, `duration=permanent` and the scopes `identity read mysubreddits submit edit history`, and exchange the code at `https://www.reddit.com/api/v1/access_token` with HTTP Basic auth (client id and secret).
4. Reddit's [Data API terms](https://redditinc.com/policies/data-api-terms) apply: commercial use needs Reddit's approval.

To revoke it, the account owner opens [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) and chooses **revoke access** next to the app under the authorized applications. The app owner can delete the app on the same page, which ends all of its tokens.

**`developerprofileusername`**: the username of the Reddit account that owns the app, without `u/` (shown on the app's **developers** line at reddit.com/prefs/apps). Reddit asks every request to name it in the User-Agent, which the connector sends as `server:agent-connectors:1.0 (by /u/<name>)`.

**`redditusername`**: the connected account's username, which a host writes after the sign-in. With it, posts and comments are listed without asking Reddit who is connected first; ownership checks always ask Reddit.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_me` | read | The connected account: username, id, karma, age, whether its email is verified, and the rate window. |
| `list_my_subreddits` | read | The communities the account subscribes to, or where it is an approved contributor. Paged with a cursor. |
| `get_subreddit_rules` | read | One community's rules and Reddit's site-wide rules. Read them before posting there. |
| `submit_post` | create | One text or link post to one community, with `nsfw` and `spoiler` set on purpose and an optional flair. Refuses duplicates and the same text in another community. Returns the post id and link. |
| `add_comment` | create | One comment on a post (`t3_...`) or reply to a comment (`t1_...`). Refuses duplicates and the same text on another thread. |
| `edit_text` | update | Replaces the text of one of the account's own text posts or comments, after checking with Reddit that it is the account's own. |
| `delete_item` | delete | Deletes one of the account's own posts or comments, after the same check. |
| `list_my_posts` | read | The account's own posts, newest first. Paged with a cursor. |
| `list_my_comments` | read | The account's own comments, newest first. Paged with a cursor. |
| `get_items` | read | Up to 25 posts or comments by their fullnames, and which were not found. |
| `api_get` | read | Any other documented GET on `https://oauth.reddit.com`, such as `/r/{name}/about`, inside the same rate window. |

## Limits

- Reddit allows about 100 requests a minute per app, averaged over 10 minutes (the rate headers are the authority); its own per-account write limits come back as `RATELIMIT` with the delay.
- Titles up to 300 characters (never cut: write a shorter one), text posts up to 40,000, comments up to 10,000. Reddit edits bodies only, never titles or link posts.
- The duplicate and rate memory lasts as long as the connector is loaded: a restart forgets it.
- Writes are never retried: an unclear outcome comes back as unknown, with `list_my_posts`, `list_my_comments` or `get_items` to check.

## README rows

For the repository README: the Tools table above goes under `### reddit` in its Tools section, and these rows go in the Connectors and Quick start tables.

```markdown
| `reddit` | [Reddit](https://www.reddit.com): the account and its communities, a community's rules, one text or link post or comment at a time, and edits and deletes of the account's own posts and comments, inside Reddit's rate window and with no duplicates | OAuth access token and developer profile username | Available |
```

```markdown
| `reddit` | `REDDIT_ACCESS_TOKEN`, `REDDIT_DEVELOPERPROFILEUSERNAME`, optional `REDDIT_REDDITUSERNAME` | An OAuth access token from your own Reddit web app, and the username of the account that owns the app (see `src/vendors/reddit/README.md`). |
```
