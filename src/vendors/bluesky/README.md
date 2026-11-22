# Bluesky connector

Posting and reading on [Bluesky](https://bsky.app) through the AT Protocol on `https://bsky.social`, with your handle and an app password: posts with clickable links, mentions and hashtags, up to 4 images with alt text or a link card, replies and threads, deleting your own posts, your recent posts with their numbers, any posts by link, and any other XRPC method.

Credential check: `get_profile` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `handle` | `BLUESKY_HANDLE` | The account's handle, such as `yourname.bsky.social` or your own domain (a DID works too). A leading `@` and capital letters are fine. |
| `apppassword` | `BLUESKY_APPPASSWORD` | An app password, four groups of four letters and digits: `xxxx-xxxx-xxxx-xxxx`. Never the account password. |

Only accounts hosted by Bluesky can connect: every account made on bsky.app with the default hosting provider. An account on a self-hosted or another provider's server cannot connect yet.

### Getting the handle

1. Sign in at [bsky.app](https://bsky.app) (or in the Bluesky app) with the account that should post.
2. Open your profile. The handle is the name under your display name, such as `yourname.bsky.social`.

### Getting an app password

1. Open **Settings**, then **Privacy and security**, then **App passwords** ([bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)).
2. Click **Add App Password** and name it, for example `Social posting`.
3. Leave **Allow access to your direct messages** unticked: the connector never reads or sends direct messages.
4. Click **Next**, copy the password (Bluesky shows it only once) and click **Done**.

An app password can post, delete posts and read for the account, but it cannot delete the account or create other app passwords. It works when email sign-in codes are on.

**Revoke it:** open **App passwords** again and delete it. The connector stops at once.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | A profile with its counts; the connected account by default. |
| `list_my_posts` | read | Your recent posts with likes, reposts, replies and quotes; with or without replies, your own threads, or media only. |
| `get_posts` | read | Up to 25 posts, yours or anyone's, by their bsky.app links or at:// URIs, with their numbers. |
| `create_post` | create | Posts right away: up to 300 characters with links, mentions and hashtags made clickable, up to 4 JPEG, PNG or WebP images from public https URLs with alt text, or a link card whose title, text and picture come from the page. `reply_to` makes it a reply or the next post of a thread. |
| `delete_post` | delete | Deletes one of your own posts by link or at:// URI; other accounts' posts are refused before anything is sent. |
| `api_get` | read | Any XRPC query (GET) with your session, such as `app.bsky.feed.getTimeline`, `app.bsky.feed.getPostThread` or `app.bsky.notification.listNotifications`. |
| `api_request` | write | Any XRPC procedure (POST with a JSON body), such as `com.atproto.repo.createRecord` for a like. Sent once, never retried. Account, session and identity methods are left out. |

## Limits

- Text: 300 characters (Bluesky counts graphemes: an emoji is one) and 3,000 bytes. A link counts with its full length.
- Images: up to 4 per post, each up to 2,000,000 bytes; JPEG, PNG or WebP, told by their bytes. Every image needs alt text. A link card goes only on a post without images; its picture is up to 1,000,000 bytes.
- Up to 3 language codes per post. Bluesky has no scheduling and no edits.
- Sign-ins: Bluesky allows 30 per 5 minutes and 300 per day for one account. The connector keeps a session in memory for up to 10 minutes and counts its own sign-ins, so it stops before Bluesky's limit.
- Writes: 5,000 points per hour and 35,000 per day; a post costs 3 and a delete 1.

<!--
Rows for the main README.

Connectors table:
| `bluesky` | [Bluesky](https://bsky.app): read profiles and posts, post text with clickable links, mentions and hashtags, up to 4 images or a link card, reply and thread, delete your posts, and call any other XRPC method | Handle and app password | Available |

Quick start table:
| `bluesky` | `BLUESKY_HANDLE`, `BLUESKY_APPPASSWORD` | Your handle (such as `alice.bsky.social`) and an app password from Bluesky → Settings → Privacy and security → App passwords. Never your account password. Accounts hosted by Bluesky only. |

Claude Code example: --env BLUESKY_HANDLE=alice.bsky.social --env BLUESKY_APPPASSWORD=xxxx-xxxx-xxxx-xxxx

Tools: the table above.
-->
