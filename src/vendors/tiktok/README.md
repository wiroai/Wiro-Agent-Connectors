# TikTok connector (`tiktok`)

Posts videos and photo posts to [TikTok](https://www.tiktok.com) through the TikTok Content Posting API, and reads the creator's posting options, profile and post status. A video goes either by FILE_UPLOAD (the connector downloads it from a public https URL and sends it to TikTok in chunks) or by PULL_FROM_URL (TikTok downloads it itself); photo posts are always pulled by TikTok. Before every direct post the connector reads the creator's current options, as TikTok asks, refuses a privacy level the creator cannot use, and keeps comments, duets and stitches off where the creator turned them off. After posting it follows TikTok's status for up to a minute (or as long as asked).

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `access_token` | `TIKTOK_ACCESS_TOKEN` | yes |
| `tiktokusername` | `TIKTOK_TIKTOKUSERNAME` | no |
| `openid` | `TIKTOK_OPENID` | no |

**`access_token`**: a user access token of the creator, from your own TikTok app. A host that connects TikTok for you runs this sign-in and refreshes the token (it lasts 24 hours, the refresh token a year); the connector never refreshes or stores it. To get one yourself:

1. Open [TikTok for Developers → Manage apps](https://developers.tiktok.com/apps/) and create an app (or open yours).
2. Add the **Login Kit** and **Content Posting API** products, and the scopes `user.info.basic` and `video.publish` (and `video.upload` to send drafts to the creator's inbox with `post_mode: "MEDIA_UPLOAD"`).
3. Add your redirect URI, and submit the app for review. Until TikTok audits it, everything it posts is private (`SELF_ONLY`) and the creator's account must be private.
4. For PULL_FROM_URL and photo posts, verify the domain or URL prefix your media is served from under **URL properties** in the app.
5. Send the creator to `https://www.tiktok.com/v2/auth/authorize/` with those scopes, and exchange the returned code at `https://open.tiktokapis.com/v2/oauth/token/`.

To revoke it, the creator removes the app in the TikTok app: **Profile** → menu → **Settings and privacy** → **Security & permissions** → **Apps and services permissions**, taps the app, then **Remove all permissions** (some app versions say **Manage app permissions**). The app owner can revoke a token with `POST https://open.tiktokapis.com/v2/oauth/revoke/`.

**`tiktokusername`** and **`openid`**: the creator's display name and open id, which a host writes after the sign-in. They are only shown back.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_creator_info` | read | What the creator can post right now: name, the privacy levels they may choose, whether comments, duets and stitches are off on their account, and the longest video they may post. |
| `get_profile` | read | Open id, union id, display name and avatar; profile and stats fields with the `user.info.profile` and `user.info.stats` scopes. |
| `post_video` | create | One video from a public https URL, by FILE_UPLOAD (MP4, MOV or WebM, sent in chunks) or PULL_FROM_URL, with a caption up to 2,200 characters, privacy level, interaction settings, cover frame and the branded-content and AI labels; or as an inbox draft (`MEDIA_UPLOAD`). Waits for TikTok to finish. |
| `post_photos` | create | A photo post of 1 to 35 photos that TikTok downloads from their URLs, with a title up to 90 characters, a description up to 4,000, cover, music and labels. Waits for TikTok to finish. |
| `get_post_status` | read | Where a post stands by its `publish_id`: processing, sent to the inbox, published (with the public post ids) or failed (with the reason). |
| `api_get` | read | Any other GET under `/v2/`, such as `/v2/user/info/`. |
| `api_request` | write | A POST under `/v2/`, such as `/v2/video/list/` (needs `video.list`). Many TikTok reads are POST. Sent once, never retried. |

## Limits

- One video per post: clips must be joined, and normalized to TikTok's formats (H.264 recommended, 23 to 60 FPS, 360 to 4096 pixels a side), before they are posted; the connector does not edit media.
- FILE_UPLOAD: up to 268,435,456 bytes, and within the host's own download limit (25 MiB in the CLI). Larger videos need PULL_FROM_URL from a verified domain. TikTok takes chunks of 5 to 64 MB; the connector sends 10 MB chunks with the rest in the last one.
- Photos: JPEG or WebP, up to 1080p and 20 MB each, from a verified domain or URL prefix.
- Captions and texts count UTF-16 units, as TikTok does. Links in them are not clickable.
- TikTok allows 6 post requests and 20 creator-info reads per minute per creator, a daily post limit per creator, and at most 5 pending inbox drafts a day.
- A post id beyond 2^53 cannot be read exactly from TikTok's JSON; it is then left out, with a note, rather than given wrong.
- Writes are never retried: a post whose outcome is unclear comes back as unknown, with `get_post_status` to check. The TikTok API cannot delete posts; delete them in the app.

## README rows

For the repository README: the Tools table above goes under `### tiktok` in its Tools section, and these rows go in the Connectors and Quick start tables.

```markdown
| `tiktok` | [TikTok](https://www.tiktok.com): post videos (chunked upload or pull from a URL) and photo posts, with the creator's privacy and interaction options checked first, and follow each post's status | OAuth access token | Available |
```

```markdown
| `tiktok` | `TIKTOK_ACCESS_TOKEN`, optional `TIKTOK_TIKTOKUSERNAME` and `TIKTOK_OPENID` | A user access token from your own TikTok app with `video.publish` (see `src/vendors/tiktok/README.md`). |
```
