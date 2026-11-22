# YouTube connector

A [YouTube](https://www.youtube.com) channel through the [YouTube Data API v3](https://developers.google.com/youtube/v3/docs) and the [YouTube Analytics API v2](https://developers.google.com/youtube/analytics): upload videos and Shorts from a public URL with their title, description, tags, visibility or scheduled release, publish or edit them later, set thumbnails, manage playlists, list the channel's videos and statistics, search them, run Analytics reports (top videos, daily figures, audience retention, traffic sources, countries, devices, demographics), screen videos for video ads, and call the rest of both APIs.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `youtube` | [YouTube](https://www.youtube.com) channels: upload videos and Shorts from a URL, publish or schedule them, edit their details and thumbnails, manage playlists, list and search videos, read Analytics reports, screen videos for ads, and call the rest of the YouTube APIs | Google OAuth access token | Available |

## Credentials

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `youtube` | `YOUTUBE_ACCESS_TOKEN` | An OAuth access token with the scopes `https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/yt-analytics.readonly`, from your own Google Cloud OAuth client (see below). |

`access_token` (`YOUTUBE_ACCESS_TOKEN` in the CLI) is an OAuth 2.0 access token of the Google account, or the Brand Account, that owns the channel, with the scopes `https://www.googleapis.com/auth/youtube` (manage the channel; it includes reading) and `https://www.googleapis.com/auth/yt-analytics.readonly` (Analytics reports). Comments and captions take `https://www.googleapis.com/auth/youtube.force-ssl` instead, and revenue metrics `https://www.googleapis.com/auth/yt-analytics-monetary.readonly`: the steps below do not add them, and a token without them gets HTTP 403 on those calls. A host that signs in with your OAuth app passes its current token on every call and refreshes it; the connector never stores it. Google access tokens last one hour, and the CLI does not refresh them.

### Get one, step by step

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one), and enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) and the [YouTube Analytics API](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com).
2. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). If the project has no app yet, click **Get started**: an app name, your support email, **External** as the audience, your contact email, then **Create**. In [Audience](https://console.cloud.google.com/auth/audience), add the channel owner's account under **Test users**, or click **Publish app** (in *Testing*, Google ends the sign-in after 7 days).
3. In [Data Access](https://console.cloud.google.com/auth/scopes), add `https://www.googleapis.com/auth/youtube`, `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly`, then **Save**.
4. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI of the host that signs in with it. For a token by hand, add `https://developers.google.com/oauthplayground`.
5. A host that signs in with your app gets the token itself. By hand: open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials** and paste the client ID and secret; in step 1 enter the scopes above and click **Authorize APIs**, signing in with the channel's account (for a Brand Account channel, pick the channel when Google asks); in step 2 click **Exchange authorization code for tokens** and copy the **Access token**.
6. For public uploads, have the project audited: YouTube keeps every video uploaded through an unaudited project (created after 28 July 2020) private. Apply with the [YouTube API audit form](https://support.google.com/youtube/contact/yt_api_form).

### Revoke it

Open the channel account's [third-party connections](https://myaccount.google.com/connections), pick your app and choose **Delete all connections** (or **Remove access**). Deleting the OAuth client in [Clients](https://console.cloud.google.com/auth/clients) ends every sign-in made with it.

## Account picker

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `channels` | The channels the agent may work on (one or more) | `list_channels` |

A sign-in acts as one channel: every write lands on it, and it sees that channel's private and unlisted videos and private playlists. With a choice in place (`CONNECTOR_ACCOUNTS={"channels":["UC..."]}` in the CLI), tools refuse a channel outside it before sending anything; writes, `get_videos`, `list_playlist_items` and every `api_get` or `api_request` need the connected channel chosen (so nothing works until it is, or after a sign-in as another channel); and `channel_id` may be left out when one channel is chosen. Without one, channel tools use the connected channel.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_channels` | read | The account's channels with handle, subscribers, views, videos and uploads playlist. The `channels` picker. |
| `get_channel` | read | A channel's details: description, country, statistics, keywords, audience setting, upload limits. |
| `list_videos` | read | The channel's uploads, newest first, with visibility, schedule, duration, views, likes and comments. |
| `get_videos` | read | Up to 50 videos in full: description, tags, category, languages, status, labels, statistics, thumbnail. |
| `search_videos` | read | Searches the channel's public videos by words, in an order and a time range (100 quota units a search). |
| `upload_video` | create | Uploads a video or Short from a public https URL with its details, visibility or scheduled release, audience setting and synthetic-media label, through the resumable upload, in parts read by byte range. A large video takes several calls: pass `nextCursor` back as `cursor` until `done` is true. |
| `update_video` | update | Changes a video's details or visibility (publish, unlist, schedule); the fields not given are kept. |
| `set_thumbnail` | update | Sets a custom thumbnail from a JPEG or PNG URL (verified channels). |
| `list_playlists` | read | The channel's playlists, private ones included for the connected channel. |
| `list_playlist_items` | read | The videos of a playlist in order. |
| `create_playlist` | create | Creates a playlist (private unless told otherwise). |
| `add_to_playlist` | create | Adds a video to a playlist, at the end or at a position. |
| `get_analytics_report` | read | An Analytics report: daily figures (the default), top videos, retention for a video, traffic sources, countries, devices, demographics, or your own metrics, dimensions, filters and sort. |
| `screen_videos_for_ads` | read | Checks uploads for video ads: visibility, audience, views, length for the ad format, average view percentage. |
| `api_get` | read | Any other GET under `/youtube/v3/` or the Analytics `/v2/` API, such as video categories or a channel's branding settings. |
| `api_request` | write | A POST, PUT or DELETE under `/youtube/v3/`, such as deleting a video or taking it out of a playlist. Sent once, never retried. |

## Limits

- YouTube gives a project 10,000 quota units a day by default; a search costs 100 of them (YouTube's [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) lists the rest). A quota error comes back as HTTP 403 with YouTube's words.
- `upload_video` sends a video through YouTube's [resumable upload](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) in parts of `part_mb` MiB (default 8, at most 24), each read from the video URL with a byte-range request (the `Range` header) just before it is sent, so a call holds one part at a time. A call starts parts for about 35 seconds, then returns `done: false`, `bytes_uploaded` and a `nextCursor`: call `upload_video` again with the same arguments and that `cursor` until `done` is true. Each call first asks YouTube how far the upload got, so no byte YouTube confirmed is sent twice and the video is made once, by the part that carries its last byte; the cursor stays the same for the whole upload, so any `nextCursor` of it goes on. YouTube takes files up to 256 GB, and drops an upload that is not finished in time: go on soon. When a call stops for a problem (a download error, a rate limit), `stopped` says what happened and `next` what to do.
- Parts by byte range need a host that passes the `Range` header of a download on and hands back the `206 Partial Content` reply, and a server that honours it; the host's media download limit then applies to each part (at most 24 MiB), not to the video. Through a host that does not, or from a server that ignores the header, the download comes back whole: the parts are then cut from the whole file, which must fit the host's media download limit (25 MiB in the CLI, often 25 to 50 MB in other hosts). A larger video is refused before anything reaches YouTube.
- If the last part of an upload gets no clear answer, the tool asks YouTube once whether the video was made and returns it if so; only when YouTube cannot say either is the outcome unknown. Look for the video with `list_videos`, or go on with the cursor, which asks YouTube first and never makes a second video. If the file at the video URL changes during an upload (its size or its ETag), the rest is not sent: start a new upload without `cursor`.
- Comment threads, comments and captions need the `youtube.force-ssl` scope, and revenue metrics `yt-analytics-monetary.readonly`; the setup steps do not add them (see Credentials).
- Titles take at most 100 characters and descriptions 5,000 bytes, neither with `<` or `>`; tags take 500 characters in all. A scheduled release needs `privacy_status: "private"` and a future `publish_at`.
- Videos uploaded through a project that has not passed YouTube's audit stay private, whatever was asked; `update_video` warns when YouTube kept a video private.
- Thumbnails: JPEG or PNG under 2 MB, on a verified channel.
- Analytics data lags two or three days. Content-owner (`onBehalfOfContentOwner`) requests are not available.
- Every result stays under 32 KB, with a cursor for more. Nothing is retried: a write with an unclear outcome comes back as unknown, with the read tool to check.
