# X connector (`twitter`)

Publishes on [X](https://x.com) (formerly Twitter) through the X API v2: posts with text, up to 4 images or one GIF or video, polls, replies, quotes and threads, and deletes. Media comes from public https URLs and goes through X's v2 chunked upload (initialize, append in 4 MB segments, finalize), and the connector waits for X to process a GIF or video before it posts. It also reads the account, its posts and single posts, and reaches the rest of the API with `api_get` and `api_request`.

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `access_token` | `TWITTER_ACCESS_TOKEN` | yes |
| `xusername` | `TWITTER_XUSERNAME` | no |

**`access_token`**: an OAuth 2.0 user access token of the account, from your own X app. A host that connects X for you runs this sign-in and refreshes the token (it lasts 2 hours); the connector never refreshes or stores it. To get one yourself:

1. Open the [X Developer Portal → Projects & Apps](https://developer.x.com/en/portal/projects-and-apps) and select your app (or create one).
2. Under **User authentication settings**, turn on **OAuth 2.0**, choose **Web App**, and add your callback URL.
3. Run the authorization code flow with PKCE: send the account to `https://x.com/i/oauth2/authorize` with the scopes `tweet.read tweet.write users.read offline.access` and **`media.write`** (needed for any image, GIF or video), and exchange the code at `https://api.x.com/2/oauth2/token`.

To revoke it, the account owner opens X → **Settings and privacy** → **Security and account access** → **Apps and sessions** → **Connected apps**, selects the app and chooses **Revoke app permissions**. The app owner can revoke a token with `POST https://api.x.com/2/oauth2/revoke`, or regenerate the app's client secret.

**`xusername`**: the account's username, which a host writes after the sign-in. It is only shown back.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_me` | read | The connected account: id, username, name, bio, follower, following and post counts, verification and X Premium subscription type. |
| `list_my_posts` | read | The account's own posts, newest first, with link, text, time, counts and media; replies and reposts can be left out. Paged with a cursor. |
| `get_post` | read | One post by its id, with its counts, the post it replies to or quotes, and its media. |
| `upload_media` | create | Uploads one image, GIF or video from a public https URL with the chunked upload, adds alt text, waits for processing, and returns the `media_id` for later posts. Nothing is posted. |
| `get_media_status` | read | The processing state of an upload by its `media_id`. |
| `create_post` | create | Publishes a post: text, up to 4 images or one GIF or video (by URL or `media_id`), or a poll; optionally a reply, a quote, reply settings and the AI and paid-partnership labels. Returns the post id and link. |
| `create_thread` | create | Publishes 2 to 25 posts, each replying to the one before (the first optionally replying to an existing post). All media is uploaded first; if a post fails, the result names the posts already published. |
| `delete_post` | delete | Deletes one of the account's posts, for good. |
| `api_get` | read | Any other GET under `/2/`, such as `/2/tweets/search/recent`. |
| `api_request` | write | A POST, PUT or DELETE under `/2/`. Sent once, never retried. |

## Limits

- Text: 280 characters (X counts a link as 23 and some characters as 2), or up to 25,000 on an X Premium account; X refuses a duplicate of a recent post.
- Media: JPEG, PNG or WebP up to 5 MB, GIF up to 15 MB, MP4 or MOV video up to 512 MB, and within the host's own download limit (25 MiB in the CLI). Media uploads need the `media.write` scope: a token granted without it can post text but not media.
- A GIF or video still processing after `wait_seconds` (default 60) is not posted: check it with `get_media_status`, then post with `media_ids`.
- What each call may do depends on the app's X API plan, which sets its rate limits and monthly caps; a 429 comes back as a rate limit error.
- Writes are never retried: a post, thread post or delete whose outcome is unclear comes back as unknown, with `list_my_posts` (or `get_post`) to check.

## README rows

For the repository README: the Tools table above goes under `### twitter` in its Tools section, and these rows go in the Connectors and Quick start tables.

```markdown
| `twitter` | [X](https://x.com): publish posts with images, GIFs, video or polls, replies, quotes and threads, delete posts, and read the account and its posts | OAuth access token | Available |
```

```markdown
| `twitter` | `TWITTER_ACCESS_TOKEN`, optional `TWITTER_XUSERNAME` | An OAuth 2.0 user access token from your own X app, with `media.write` for media (see `src/vendors/twitter/README.md`). |
```
