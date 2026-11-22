# TikTok connector (`tiktok`)

Posts videos and photo posts to [TikTok](https://www.tiktok.com) through the TikTok Content Posting API, and reads the creator's posting options, profile, post status and videos. A video goes either by FILE_UPLOAD (the connector downloads it from a public https URL and sends it to TikTok in chunks) or by PULL_FROM_URL (TikTok downloads it itself). TikTok has no upload for photos: it always downloads them itself, so photo URLs must be on a host verified for the app (see [Photos and PULL_FROM_URL](#photos-and-pull_from_url-need-a-verified-host)). Before every direct post the connector reads the creator's current options, as TikTok asks, refuses a privacy level the creator cannot use, and keeps comments, duets and stitches off where the creator turned them off.

After posting it follows TikTok's status for 20 seconds by default (`wait_seconds`, at most 30), and never past 35 seconds into the call, because hosts end a tool call after about a minute and drop a late result. TikTok often needs a minute or more, so a post can come back still processing, with its `publish_id`: follow it with `get_post_status`, which can wait too.

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `access_token` | `TIKTOK_ACCESS_TOKEN` | yes |
| `tiktokusername` | `TIKTOK_TIKTOKUSERNAME` | no |
| `openid` | `TIKTOK_OPENID` | no |

**`access_token`**: a user access token of the creator, from your own TikTok app. A host that connects TikTok for you runs this sign-in and refreshes the token (it lasts 24 hours, the refresh token a year); the connector never refreshes or stores it. To get one yourself:

1. Open [TikTok for Developers → Manage apps](https://developers.tiktok.com/apps/) and create an app (or open yours).
2. Add the **Login Kit** and **Content Posting API** products, and the scopes `user.info.basic` and `video.publish`; add `video.upload` to send drafts to the creator's inbox with `post_mode: "MEDIA_UPLOAD"`, and `video.list` for `list_videos` and `get_videos`. A token without one of these gets TikTok's refusal from the tools that need it.
3. Add your redirect URI, and submit the app for review. Until TikTok audits it, everything it posts is private (`SELF_ONLY`) and the creator's account must be private.
4. For photo posts and PULL_FROM_URL, verify the domain or URL prefix your media is served from in the app's URL properties, as the next section says.
5. Send the creator to `https://www.tiktok.com/v2/auth/authorize/` with those scopes, and exchange the returned code at `https://open.tiktokapis.com/v2/oauth/token/`.

To revoke it, the creator removes the app in the TikTok app: **Profile** → menu → **Settings and privacy** → **Security & permissions** → **Apps and services permissions**, taps the app, then **Remove all permissions** (some app versions say **Manage app permissions**). The app owner can revoke a token with `POST https://open.tiktokapis.com/v2/oauth/revoke/`.

**`tiktokusername`** and **`openid`**: the creator's display name and open id, which a host writes after the sign-in. They are only shown back.

## Photos and PULL_FROM_URL need a verified host

TikTok downloads every photo of a photo post, and every PULL_FROM_URL video, itself, and only from a domain or URL prefix verified in the TikTok app's URL properties. It refuses any other URL with HTTP 403 (`url_ownership_unverified`), before anything is posted, and the connector's refusal says so. There is no file upload for photos, so this holds for every photo post, drafts included.

The host must be one the app's owner controls, because verifying it means changing its DNS or putting a file on it: your own website (a WordPress media library, for example `https://example.com/wp-content/uploads/`), or a storage bucket or CDN served on your own domain. Links on a host you do not control, such as another service's file storage or CDN, cannot be verified, so TikTok refuses them: copy those files to your verified host first and pass its URLs.

To verify a host:

1. Open [TikTok for Developers → Manage apps](https://developers.tiktok.com/apps/) and select the app.
2. In the app's configuration, open **URL properties** and choose **Verify properties**.
3. Choose **Domain** to cover a domain and all of its subdomains: enter it, add the signature TikTok shows to the domain's DNS records as a TXT record, wait for the record to appear, then choose **Verify**. Or choose **URL prefix** to cover one path: enter the full prefix (`https://`, a host name, a path ending in `/`), download the signature file TikTok gives, put it at that prefix so it is served there, then choose **Verify**. A prefix that redirects cannot be verified.
4. Keep the DNS record or the file in place, so the property stays verified.

A verified subdomain does not cover its parent (verifying `media.example.com` does not cover `example.com`). Without a verified host, post photos as a video instead: make a slideshow video of them beforehand and post it with `post_video`, whose FILE_UPLOAD needs no verification. To remove a property, delete it in the same URL properties section and remove the DNS record or file.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_creator_info` | read | What the creator can post right now: name, the privacy levels they may choose, whether comments, duets and stitches are off on their account, and the longest video they may post. |
| `get_profile` | read | Open id, union id, display name and avatar; profile and stats fields with the `user.info.profile` and `user.info.stats` scopes. |
| `post_video` | create | One video from a public https URL, by FILE_UPLOAD (MP4, MOV or WebM within the host's download limit, sent in chunks) or PULL_FROM_URL (from a verified host), with a caption up to 2,200 characters, privacy level, interaction settings, cover frame and the branded-content and AI labels; or as an inbox draft (`MEDIA_UPLOAD`, the file only: the creator adds the caption and settings in the app). Waits a little for TikTok, then returns the `publish_id`. |
| `post_photos` | create | A photo post of 1 to 35 photos that TikTok downloads from their URLs, which must be on a domain or URL prefix verified for the app, with a title up to 90 characters, a description up to 4,000, cover, music and labels; or as an inbox draft with its title and description. Waits a little for TikTok, then returns the `publish_id`. |
| `get_post_status` | read | Where a post stands by its `publish_id`: processing, sent to the inbox, published (with the public post ids) or failed (with the reason). Can wait up to 30 seconds for TikTok to finish. |
| `list_videos` | read | The creator's public videos, newest first, with their link, length and view, like, comment and share counts (needs `video.list`). Paged with a cursor. |
| `get_videos` | read | Up to 20 of the creator's videos by id, such as the post ids `get_post_status` returns (needs `video.list`). |
| `api_get` | read | Any other GET under `/v2/`, such as `/v2/user/info/`. |
| `api_request` | write | A POST under `/v2/` for the writes the tools above do not cover. Sent once, never retried. |

## Limits

- One video per post: clips must be joined, and normalized to TikTok's formats (H.264 recommended, 23 to 60 FPS, 360 to 4096 pixels a side), before they are posted; the connector does not edit media.
- FILE_UPLOAD holds the whole video before sending it, so the file must fit the host's own download limit (each host sets its own, 25 MiB in this package's CLI; this connector takes at most 268,435,456 bytes), and the download and upload must finish within the host's time for one call (about a minute). A larger video is refused before the post is started, and the refusal says the way around it: PULL_FROM_URL from a verified host, where TikTok downloads up to 4 GB itself, or a smaller file. TikTok takes chunks of 5 to 64 MB; the connector sends 10 MB chunks with the rest in the last one.
- TikTok's upload addresses are on `open-upload.tiktokapis.com` or `upload.us.tiktokapis.com`, the hosts its media transfer guide shows. An upload address on any other host is refused before the file is sent, and nothing is posted.
- Photos: JPEG or WebP, up to 1080p and 20 MB each, only from a verified domain or URL prefix (see above).
- Captions and texts count UTF-16 units, as TikTok does. Links in them are not clickable.
- TikTok allows 6 post requests and 20 creator-info reads per minute per creator, a daily post limit per creator, and at most 5 pending inbox drafts a day.
- A post id beyond 2^53 cannot be read exactly from TikTok's JSON; it is then left out, with a note, rather than given wrong.
- `MEDIA_UPLOAD` sends the file only (and a photo post's title and description): a caption, privacy level or other post setting given with it is refused before anything is sent.
- Writes are never retried: a post whose outcome is unclear comes back as unknown. When TikTok had already given a `publish_id`, the result names it for `get_post_status`; when the request that starts the post got no clear answer, there is no `publish_id`, and the post can only be looked for in the TikTok app before posting again. The TikTok API cannot delete posts; delete them in the app.

## README rows

For the repository README: the Tools table above goes under `### tiktok` in its Tools section, and these rows go in the Connectors and Quick start tables.

```markdown
| `tiktok` | [TikTok](https://www.tiktok.com): post videos (chunked upload, or pulled from a verified URL) and photo posts (from a verified URL), with the creator's privacy and interaction options checked first, follow each post's status, and read the creator's videos | OAuth access token | Available |
```

```markdown
| `tiktok` | `TIKTOK_ACCESS_TOKEN`, optional `TIKTOK_TIKTOKUSERNAME` and `TIKTOK_OPENID` | A user access token from your own TikTok app with `video.publish` (see `src/vendors/tiktok/README.md`). |
```
