# Threads (`threads`)

Publish to a Threads profile and read how it does, through the Threads API v1.0: text, image, video and carousel posts (2 to 20 items) through a media container that is checked until Threads has processed it and then published once; reply controls, quote posts, link previews, topic tags, long text attachments, AI labels and country limits; replies in the profile's own threads; reading and hiding replies; deleting a post; post and profile insights; the daily publishing limits; and the rest of the API.

## Credentials

### `access_token`: a sign-in with your own Threads app

The host signs the profile in with your own Meta app that has the **Access the Threads API** use case, and passes the current Threads user token on every call; the token goes in the `Authorization` header only, never in a URL. The host also writes the profile's numeric id (`threadsuserid`) and handle (`threadsusername`) at the sign-in; without them the connector reads them from `/me` once. The connector never refreshes or stores the token (Threads tokens last 60 days and the host renews them).

1. Sign in to [Meta for Developers → My Apps](https://developers.facebook.com/apps/), click **Create App** and, on **Use cases**, select **Access the Threads API**.
2. In **Use cases → Access the Threads API → Customize → Permissions**, add `threads_content_publish`, `threads_manage_insights`, `threads_manage_replies`, `threads_read_replies` and `threads_delete` (`threads_basic` is included).
3. In the use case's **Settings**, add your host's OAuth callback URL under **Redirect Callback URLs**, fill in the uninstall and delete callback URLs (a page of your own site works for both) and save.
4. Give the host the **Threads App ID** and **Threads App Secret** from that page (not the app's main App ID and secret), then sign in with the Threads profile the agent should post as.
5. Until Meta approves the app, only profiles with a role on it can connect: add yours under **App roles → Roles → Add People → Threads Tester** and accept the invite in Threads (**Settings → Account → Website permissions → Invites**).

To revoke: in Threads, open **Settings → Account → Website permissions** and remove the app, or reset the Threads app secret. A private profile has to sign in again every 90 days.

### Environment variables (CLI)

| Variable | Credential |
| --- | --- |
| `THREADS_ACCESS_TOKEN` | A current Threads user token. |
| `THREADS_THREADSUSERID` | Optional: the profile's numeric id (read from `/me` when missing). |
| `THREADS_THREADSUSERNAME` | Optional: the profile's handle, shown in results. |

One profile per connection; there is no account picker.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The connected profile: id, handle, name, bio and picture. |
| `list_posts` | read | The profile's posts, newest first, with permalinks. |
| `publish_post` | create | A text, image, video or carousel post (or a reply in one of the profile's threads), with reply controls, quote, topic tag, link preview, text attachment, AI label and country limits; waits for processing and publishes once. |
| `publish_container` | create | Publishes a container an earlier call left processing, once it is ready; never twice. |
| `get_publishing_limit` | read | What the profile used of its 24-hour limits: 250 posts, 1,000 replies, 100 deletions. |
| `list_replies` | read | The direct replies to a post, or the whole conversation. |
| `hide_reply` | update | Hides a reply in one of the profile's threads, or shows it again. |
| `delete_post` | delete | Deletes one of the profile's posts or replies. |
| `get_post_insights` | read | Views, likes, replies, reposts, quotes and shares of chosen or recent posts. |
| `get_profile_insights` | read | Profile views, likes, replies, reposts, quotes and link clicks over a range of days, the follower count, or follower demographics. |
| `api_get` | read | Any other Threads API GET under `/v1.0/`. |
| `api_request` | write | A POST or DELETE under `/v1.0/`. Sent once, never retried. |

## Limits

- Text: 500 characters, with an emoji counted by its UTF-8 bytes (usually 4); at most 5 links; one topic tag; a text attachment of up to 10,000 characters on text-only posts.
- Media is fetched by Threads from public https URLs that must still work when the post is published. Images: JPEG or PNG, up to 8 MB. Videos: MP4 or MOV (H.264 or HEVC, AAC audio), 23 to 60 fps, up to 1920 px wide, 5 minutes and 1 GB. Carousels: 2 to 20 items; a refused item is left out while 2 remain.
- Threads publishes at once, with no scheduling. A call waits up to `wait_seconds` (at most 45) for processing; when the post is not ready by then, it returns a `container_id` (or, for a carousel, `child_container_ids`) to publish later. Containers expire after 24 hours.
- Replies go only inside threads the profile started. Each profile may publish 250 posts, 1,000 replies and 100 deletions in any 24 hours.
- Insights: a missing value is returned as `null` (no data yet), never as 0; there are no profile insights before 2024-04-13, and follower demographics need at least 100 followers.
- Writes are never retried. When a publish's outcome is unclear, check `list_posts` before trying again.

## Repository README rows

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `threads` | [Threads](https://www.threads.com): text, image, video and carousel posts with reply controls, quotes, link previews and topic tags; replies and reply moderation; deletes; post and profile insights; publishing limits; and the rest of the API | Your own Threads app's sign-in | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `threads` | `THREADS_ACCESS_TOKEN` (optional `THREADS_THREADSUSERID`, `THREADS_THREADSUSERNAME`) | A Threads user token from your own Meta app with the Access the Threads API use case. |
