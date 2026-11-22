# Instagram (`instagram`)

Publish to Instagram professional accounts (Business and Creator) and read how they do, through the Instagram Graph API v26.0: image posts, carousels of 2 to 20 images and videos, Reels and stories, through media containers that are checked until Instagram has processed them and then published once; post, Reel, story and account insights; comment moderation (list, reply, hide, delete); the publishing limit; and the rest of the API for a chosen account.

## Credentials

The connector needs one of two credentials: `access_token` (Instagram Login with your own app) or `systemusertoken` (a Meta Business system user token). A connection has one way in: when both are given, the system user token is used, and the other token is never sent.

### `access_token`: Instagram Login with your own app

The host signs the account in with Instagram Login (Business Login for Instagram) through your own Meta app and passes the current Instagram user token on every call; it also writes the account's id (`accountid`) and username (`igusername`) at the sign-in. Calls go to `graph.instagram.com`, for that one account. The connector never refreshes or stores the token.

1. Open [Meta for Developers → My Apps](https://developers.facebook.com/apps/) and create a **Business** app, or open yours.
2. Add the **Instagram** product and open **API setup with Instagram business login**.
3. Under **Set up Instagram business login → Business login settings**, add your host's OAuth callback URL as a redirect URL.
4. The sign-in asks for `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_messages`, `instagram_business_manage_comments` and `instagram_business_manage_insights`. Until Meta reviews the app, only accounts with a role on it (Instagram testers) can connect.
5. Give the host the **Instagram app ID** and **Instagram app secret** shown on that page (not the Meta app's own ID and secret), then sign in with the Instagram professional account.

To revoke: in the Instagram app, open **Settings → Website permissions → Apps and websites** and remove the app, or reset the Instagram app secret.

### `systemusertoken`: a Meta Business system user token

The token reaches every Instagram account linked to a Facebook Page assigned to the system user. Calls go to `graph.facebook.com` with the linked Page's own token, which the connector fetches with the system user token and keeps in memory for 15 minutes, keyed by a hash of the token and the account; it is never returned by a tool.

1. Link each Instagram **Business or Creator** account to its Facebook Page.
2. Open [Meta Business Settings → Users → System users](https://business.facebook.com/latest/settings/system_users) and create or select a system user.
3. Assign every linked Page with **CREATE_CONTENT** (and **ANALYZE** for insights), and each Instagram account with its content task.
4. Click **Generate new token**, choose the Business app of the integration and, at **Set expiration**, choose **Never** where Meta offers it.
5. Grant `business_management`, `instagram_basic`, `instagram_content_publish`, `pages_show_list` and `pages_read_engagement`; Meta's Page-linked publishing also needs `ads_read` and `ads_management`. Add `instagram_manage_insights` for insights and `instagram_manage_comments` for comments.
6. Copy the token: Meta shows it once. The app must not require the app secret proof on every call (**App settings → Advanced → Require App Secret** off).

To revoke: in **System users**, select the system user and click **Revoke tokens**, or remove its Page and Instagram assignments.

### A connection from an older setup

An older setup kept the chosen accounts' ids in `accountId`, as a JSON list. The `accounts` picker's `legacyField` names it in lowercase (`accountid`), so a host that moves the choice over compares the name in any case. With Instagram Login it kept the account's id and username as JSON lists of one, which the connector reads as they are, and its token as a JSON list of one: pass the token itself as `access_token`. With a system user token it also kept a Page token per account; the connector fetches those itself, so pass only `systemusertoken`.

### Environment variables (CLI)

| Variable | Credential |
| --- | --- |
| `INSTAGRAM_ACCESS_TOKEN` | An Instagram user token from Instagram Login (alternative 1). |
| `INSTAGRAM_ACCOUNTID` | Optional, with Instagram Login: the account's id, used when no account is given or chosen (an older setup's JSON list of one id is read too). |
| `INSTAGRAM_IGUSERNAME` | Optional, with Instagram Login: the account's username. |
| `INSTAGRAM_SYSTEMUSERTOKEN` | A system user token (alternative 2). |

## Account picker

| Key | Lists | Tool |
| --- | --- | --- |
| `accounts` | The Instagram professional accounts the agent may publish to and read (several may be chosen). An older setup kept this choice in `accountId` (legacy field `accountid`; see above). | `list_accounts` |

Every tool takes an optional `account_id`; it may be left out when only one account is chosen, or, with Instagram Login, for the account that signed in. Any other account is refused before anything is sent.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_accounts` | read | The accounts this connection can use, with their linked Page; the account picker's tool. |
| `get_account` | read | An account's profile with its follower, following and post counts. |
| `list_media` | read | An account's posts and Reels, newest first, or its live stories (for an account reached through its Facebook Page). |
| `publish_image` | create | One JPEG image as a feed post, with caption, alt text, people tags, place and collaborators. |
| `publish_carousel` | create | A carousel of 2 to 20 images and videos with one caption; a refused slide is left out while 2 remain. |
| `publish_reel` | create | A Reel from a video URL, with caption, cover, audio name, place and collaborators. |
| `publish_story` | create | A story from an image or a video URL. |
| `publish_container` | create | Publishes a container an earlier call left processing, once it is ready; never twice. |
| `get_publishing_limit` | read | The posts published through the API in the current 24-hour window and the quota. |
| `get_media_insights` | read | Reach, views, saves, shares, comments, likes and interactions of posts and Reels, or of stories (live ones, or by their media ids). |
| `get_account_insights` | read | Reach, views, interactions, accounts engaged, follows and unfollows over a range of days, and the follower count. |
| `list_comments` | read | The comments on a post, or the replies to a comment. |
| `add_comment` | create | A comment as the account on its post, or a reply to a comment. |
| `hide_comment` | update | Hides a comment from other people, or shows it again. |
| `delete_comment` | delete | Deletes a comment. |
| `api_get` | read | Any other Instagram Graph API GET under `/v26.0/`, for a chosen account. |
| `api_request` | write | A POST or DELETE under `/v26.0/` for a chosen account, such as turning comments off on a post. Sent once, never retried. |

## Limits

- Instagram downloads every file from a public https URL, which must still work when the post is published. Images: JPEG, up to 8 MB, aspect ratio 4:5 to 1.91:1. Reels: MP4 or MOV (H.264 or HEVC, AAC audio), 3 seconds to 15 minutes, up to 300 MB and 1920 px wide. Captions: 2,200 characters, 30 hashtags, 20 @mentions; links in captions are not clickable.
- Instagram has no drafts through the API: a published post is public at once. A call waits up to `wait_seconds` (at most 45) for processing, checking one container about every 10 seconds and the slides of a carousel in one round about every 20 seconds; when the media is not ready by then, it returns a `container_id` (or, for a carousel, `child_container_ids`) to publish later. Containers expire after 24 hours.
- The API publishes a limited number of posts per account in 24 hours (see `get_publishing_limit`); a carousel counts as one.
- Insights need the insights permission. A missing value is returned as `null` (no data yet), never as 0; insights can be up to 48 hours behind, account metrics cover about the last 90 days, and accounts under 100 followers get no follow data. Story insights last 24 hours.
- Instagram lists live stories only for an account reached through its Facebook Page (a system user token). With Instagram Login, `list_media` and `get_media_insights` refuse `stories: true` without media ids, before anything is sent; a story's insights are still read by its media id (`publish_story` returns it).
- The app secret proof is not used: Instagram Login calls go to `graph.instagram.com`, and system user calls are made with Page tokens.
- Writes are never retried. When a publish's outcome is unclear, check `list_media` before trying again.
- Instagram throttles with HTTP 400 or 403 and a rate limit code (4, 17, 613, or 80002 for Instagram), not with HTTP 429. Such an error says "rate limit reached"; wait before trying again, since the limit counts calls over a rolling hour. Instagram's estimate of the wait comes in a usage header that the result does not carry yet.
- `api_get` and `api_request` send one request per call, with parameters in `query`, or for `api_request` in `json` or a form `body` (`application/x-www-form-urlencoded`); other bodies are refused. Batch requests (`batch`) and method overrides (`method`) are refused, and so is any request that names a token or an app secret in its path, its parameters or its body, at any depth and however it is encoded, as are `/oauth` and token refresh endpoints. A reply never carries a token or an app secret proof back.

## Repository README rows

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `instagram` | [Instagram](https://www.instagram.com) professional accounts: images, carousels, Reels and stories through processed containers; post, story and account insights; comment moderation; the publishing limit; and the rest of the API | Instagram Login with your own app, or a system user token | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `instagram` | `INSTAGRAM_ACCESS_TOKEN` (with `INSTAGRAM_ACCOUNTID` and `INSTAGRAM_IGUSERNAME`), or `INSTAGRAM_SYSTEMUSERTOKEN` | An Instagram user token from Instagram Login with your own Meta app, or a system user token from Meta Business Settings → Users → System users whose Pages are linked to the accounts. Account key: `accounts`. |
