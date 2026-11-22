# Facebook Pages (`facebook-pages`)

Publish to the Facebook Pages you manage and read how they do, through the Graph API v26.0: text and link posts, photos (one or up to ten in a post), videos, Reels and stories, now or scheduled; comments as the Page, with an image, GIF or link sample; post and Page insights; and the rest of the Graph API as one of your Pages.

The connection's token (from a sign-in or a system user) only lists your Pages and fetches each Page's own access token; every Page call is made with that Page token. Page tokens are kept in memory for 15 minutes, keyed by a hash of the credential and the Page, and never returned by a tool.

## Credentials

The connector needs one of two credentials: `access_token` (a sign-in with your own Facebook app) or `systemusertoken` (a Meta Business system user token). A connection has one way in: when both are given, the system user token is used and no app secret proof is sent. A connection made with an older setup may have only `accesstoken` instead: see below.

### `access_token`: a sign-in with your own Facebook app

The host signs you in with your own Meta app (Facebook Login) and passes the current user access token on every call, with `appsecret_proof` when it computes one (the HMAC-SHA256 of the token keyed with your app secret; the secret itself stays with the host). The connector never refreshes or stores the token.

1. Open [Meta for Developers → My Apps](https://developers.facebook.com/apps/) and click **Create App**; choose **Other**, then the **Business** type.
2. Add the **Facebook Login** product and, under **Facebook Login → Settings**, add your host's OAuth callback URL as a **Valid OAuth Redirect URI**.
3. If your app uses use cases, open **Use cases → Manage everything on your Page** and add the permissions the sign-in asks for: `pages_show_list`, `pages_manage_posts`, `publish_video`, `pages_manage_engagement`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_metadata`, `pages_messaging` and `read_insights`. Facebook refuses the sign-in with an **Invalid Scopes** error for a permission the app lacks.
4. Keep **App settings → Advanced → Require App Secret** off: Page calls are made with Page tokens, which carry no app secret proof.
5. Give the host the **App ID** and **App Secret** (App settings → Basic), then sign in with a Facebook account that has a task on each Page.

To revoke: remove the app in Facebook under **Settings & privacy → Settings → Business integrations** (or **Apps and websites**), or reset the app secret in your app's settings.

### `systemusertoken`: a Meta Business system user token

1. Open [Meta Business Settings → Users → System users](https://business.facebook.com/latest/settings/system_users) and create or select a system user.
2. Assign every Page the agent may use: **CREATE_CONTENT** to post, **MODERATE** to comment, **ANALYZE** to read insights.
3. Click **Generate new token**, choose the Business app that owns the integration and, at **Set expiration**, choose **Never** where Meta offers it (an expiring token has to be replaced before it expires).
4. Grant `business_management`, `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`; add `pages_manage_engagement` for comments, `publish_video` for videos and Reels, and `read_insights` for insights.
5. Copy the token: Meta shows it once. The app behind it must not require the app secret proof on every call (**App settings → Advanced → Require App Secret** off), since a system user token carries no proof.

To revoke: in **System users**, select the system user and click **Revoke tokens**, or remove its Page assignments.

### `accesstoken`: the Page tokens an older setup kept

An older setup of this connection kept no user or system user token: it kept each chosen Page's own access token, as a JSON list such as `["EAA...", "EAA..."]`. When neither `access_token` nor `systemusertoken` is set, the connector uses those Page tokens as they are. It reads the Page each one belongs to from Facebook (`/me` with that token) once, keeps that in memory for 15 minutes keyed by a hash of the token, and never returns a token. `list_pages` then lists those Pages; a token Facebook refuses (expired, or revoked by a password change) is named in a note, and its Page cannot be reached until you sign in again. Nothing new is set up this way: to renew such a connection, sign in again or use a system user token. A host that moves such a connection over passes the list as JSON text in `accesstoken`, never as `access_token` (the list is not a token), and the Pages it chose (kept in `pageid`) under the `pages` picker.

To revoke: remove the app in Facebook under **Settings & privacy → Settings → Business integrations**, which ends its Page tokens too.

### Environment variables (CLI)

| Variable | Credential |
| --- | --- |
| `FACEBOOK_PAGES_ACCESS_TOKEN` | A current user access token from your own app's sign-in (alternative 1). |
| `FACEBOOK_PAGES_APPSECRET_PROOF` | Optional: the app secret proof of that token, when your app requires it. |
| `FACEBOOK_PAGES_SYSTEMUSERTOKEN` | A system user token (alternative 2). |
| `FACEBOOK_PAGES_ACCESSTOKEN` | The Page tokens an older setup kept, as a JSON list (alternative 3). |

## Account picker

| Key | Lists | Tool |
| --- | --- | --- |
| `pages` | The Pages the agent may post to, comment on and read insights of (several may be chosen). An older setup kept this choice in `pageid`. | `list_pages` |

Every tool takes an optional `page_id`; it may be left out when only one Page is chosen. A Page outside the chosen ones is refused before anything is sent.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_pages` | read | The Pages this connection can use, with each Page's tasks; the account picker's tool. |
| `list_posts` | read | A Page's published posts, scheduled posts, live stories or Reels, newest first, with links. |
| `create_post` | create | A text post, optionally with a link preview, now or scheduled. |
| `post_photos` | create | One photo, or a post of 2 to 10 photos, from public https URLs, with a caption, now or scheduled. |
| `post_video` | create | A video from a public https URL, with a description and title, now or scheduled. |
| `post_reel` | create | A Reel from a public https URL of a vertical MP4: Facebook fetches the file, then it is published. |
| `post_story` | create | A Page story from an image or a vertical video URL. |
| `list_comments` | read | The comments on a post, photo or video, or the replies to a comment. |
| `add_comment` | create | A comment as the Page, or a reply, with an optional image, GIF or link sample. |
| `get_post_insights` | read | Views, unique viewers, reactions, comments and shares, and clicks of chosen or recent posts. |
| `get_page_insights` | read | Page views, engagements, follows, unfollows, follower change and 28-day unique viewers over a range of days. |
| `api_get` | read | Any other Graph API GET under `/v26.0/`, as one of the chosen Pages. |
| `api_request` | write | A POST or DELETE under `/v26.0/` as one of the chosen Pages, such as hiding or deleting a comment or deleting a post. Sent once, never retried. |

## Limits

- Media is fetched by Facebook from public https URLs; files behind a sign-in do not work. Reels: MP4, 9:16, 3 to 90 seconds, at least 540x960, 30 per Page in 24 hours. Video stories: up to 60 seconds. Image stories: up to 10 MB.
- A scheduled time must be at least 10 minutes ahead; Facebook sets the furthest date it accepts.
- Insights need `read_insights` and the ANALYZE task. Page insights cover at most 90 days per call; a missing value is returned as `null` (no data yet), never as 0. Facebook has no saves metric for Page posts, and Page insights leave out Reel interactions.
- Writes are never retried. When a post's outcome is unclear, check `list_posts` before trying again.
- Facebook throttles with HTTP 400 or 403 and a rate limit code (4, 17, 32, 613, or 80001 for Page calls), not with HTTP 429. Such an error says "rate limit reached"; wait before trying again, since the limit counts calls over a rolling hour. Facebook's estimate of the wait comes in a usage header that the result does not carry yet.
- `api_get` and `api_request` send one request per call, with parameters in `query`, or for `api_request` in `json` or a form `body` (`application/x-www-form-urlencoded`); other bodies are refused. Batch requests (`batch`) and method overrides (`method`) are refused, and so is any request that names a token or an app secret in its path, its parameters or its body, at any depth and however it is encoded, as are `/oauth` endpoints. A reply never carries a token or an app secret proof back.

## Repository README rows

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `facebook-pages` | [Facebook Pages](https://www.facebook.com): posts, photos, videos, Reels and stories, now or scheduled; comments as the Page; post and Page insights; and the rest of the Graph API as one of your Pages | Your own app's sign-in, or a system user token | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `facebook-pages` | `FACEBOOK_PAGES_ACCESS_TOKEN` (with `FACEBOOK_PAGES_APPSECRET_PROOF` when your app requires it), or `FACEBOOK_PAGES_SYSTEMUSERTOKEN`, or `FACEBOOK_PAGES_ACCESSTOKEN` (an older setup's Page tokens) | A user token from your own Meta app's sign-in, or a system user token from Meta Business Settings → Users → System users. Account key: `pages`. |
