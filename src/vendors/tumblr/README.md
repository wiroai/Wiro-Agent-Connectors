# Tumblr connector

Posting to [Tumblr](https://www.tumblr.com) blogs through the Tumblr API v2 and the Neue Post Format, with the OAuth 2 access token of your own Tumblr app: posts with text, images with alt text (by URL or uploaded), a link and tags, saved as drafts by default; publishing, queueing and scheduling; edits; a blog's published posts with their note counts, its drafts and its queue; deletes; and the rest of the API, on the blogs you choose.

Credential check: `list_blogs` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `access_token` | `TUMBLR_ACCESS_TOKEN` | The current OAuth 2 access token of your own Tumblr app, signed in with the account that owns the blog or is a member of it. |

The host signs in with your app and refreshes the token (it lasts about 42 minutes, and Tumblr hands out a new refresh token at each renewal); the connector only uses it. The app's consumer key and secret stay with the host and never reach the connector.

### Setting up your own Tumblr app

1. Sign in to Tumblr with the account that owns the blog or is a member of it, open [tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps) and click **Register application**.
2. Fill in the name, website, description and contact email. In **OAuth2 redirect URLs** (and **Default callback URL**), enter the redirect URI of the host that signs you in: Tumblr turns on OAuth 2 for an app only when it has one.
3. The app shows its **OAuth Consumer Key**; **Show secret key** shows the secret. Give both to the host.
4. Sign in through the host and allow `basic`, `write` and `offline_access`. Tumblr does not review apps: yours works for your own account right away.

**Revoke it:** open Tumblr [Settings, Apps](https://www.tumblr.com/settings/apps) and click the **X** next to your app.

## Account picker

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `blogs` | The blogs the connector may post to and read (one or more, group blogs included), each by its Tumblr id (`t:...`), or by its name for a blog Tumblr lists without one. | `list_blogs` |

With blogs chosen, every tool refuses any other blog before sending anything, and `blog_id` may be left out when exactly one blog is chosen. A chosen blog's name works too: it is looked up by its id. In the CLI, set `CONNECTOR_ACCOUNTS` to `{"blogs":["t:..."]}`; without it there is no lock.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_blogs` | read | The blogs the account can post to, with their ids, names, titles and addresses. The `blogs` picker's tool. |
| `list_posts` | read | A blog's published posts (newest first, with link, note count and tags, optionally by tag), its drafts, or its queue with each post's time. |
| `get_post` | read | One post in the Neue Post Format: state, tags, a scheduled post's time, layout and content blocks. A long post comes in parts, block by block, with a cursor; no block is ever cut. |
| `create_post` | create | A post, as a draft by default: text in paragraphs, images with alt text (by URL, or downloaded and uploaded with `upload_images`), a link block, or Neue Post Format content blocks, with tags. `state` publishes it, queues it (at `publish_on` or the blog's queue times) or keeps it private. |
| `update_post` | update | Publishes, queues or edits a post: reads it first and keeps what is not given, since Tumblr replaces a post whole. `replace_blocks` changes single blocks by their index; `content` replaces them all, and must have as many blocks as the post unless `replace_all` is set. A scheduled post keeps its time and a queued post its place; a missing state is never guessed. Tumblr gives a published draft or queued post a new id: the tool returns it, with the post's link. |
| `delete_post` | delete | Deletes a post. Tumblr has no trash. |
| `api_get` | read | Any other GET of the API under `/v2/`, such as a blog's notes or followers. While blogs are chosen, a path must name one of them by its id. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/v2/`, such as shuffling the queue. Sent once, never retried. |

## Limits

- One account may publish 250 posts a day (reblogs included) and upload 250 images a day; a blog's queue holds up to 1,000 posts. One app may make 1,000 requests an hour and 5,000 a day.
- A text block (a paragraph) holds up to 4,096 characters; a post up to 30 images (20 MB each, GIFs 10 MB) and 10 link blocks. Every image needs alt text.
- With `upload_images`, one post downloads and uploads up to 50 MB of images in all; images given by URL are fetched by Tumblr itself.
- A refusal (HTTP 403) means the account may not use the blog, or a daily limit or the queue's limit was reached; the message names each cause.
- Tags: no `#` and no commas, up to 140 characters each; Tumblr search reads the first 30.
- Only posts made in the Neue Post Format (and older text posts) can be edited here; Tumblr answers 400 for other older posts, which are edited on Tumblr.
- Published posts are read with the access token alone, without the app's consumer key.
- Videos and audio are not uploaded: put a link block to them instead.

<!--
Rows for the main README.

Connectors table:
| `tumblr` | [Tumblr](https://www.tumblr.com) blogs: posts with text, images with alt text, links and tags as drafts first, publishing, the queue and scheduling, edits, published posts with note counts, drafts and the queue, deletes, and the rest of the API v2 | OAuth access token of your own Tumblr app | Available |

Quick start table:
| `tumblr` | `TUMBLR_ACCESS_TOKEN` | A current OAuth 2 access token of your own Tumblr app (tumblr.com/oauth/apps), with the scopes `basic`, `write` and `offline_access`. Account key: `blogs`. |

Tools: the table above; the `blogs` picker key is listed under Account picker.
-->
