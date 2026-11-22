# Blogger connector

[Blogger](https://www.blogger.com) blogs through the [Blogger API v3](https://developers.google.com/blogger/docs/3.0/reference): write posts and pages as drafts, publish them now or schedule them, change their title, body and labels, take them back to draft or delete them, list draft, scheduled and live posts, search posts, count the labels a blog uses, and call the rest of the API (comments, page views).

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `blogger` | [Blogger](https://www.blogger.com) blogs: save posts and pages as drafts, publish or schedule them, edit titles, HTML bodies and labels, list draft, scheduled and live posts, search, count labels, and call the rest of the Blogger API | Google OAuth access token | Available |

## Credentials

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `blogger` | `BLOGGER_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/blogger`, from your own Google Cloud OAuth client (see below). |

`access_token` (`BLOGGER_ACCESS_TOKEN` in the CLI) is an OAuth 2.0 access token of the Google account that owns the blog or writes for it, with the scope `https://www.googleapis.com/auth/blogger`. A host that signs in with your OAuth app passes its current token on every call and refreshes it; the connector never stores it. Google access tokens last one hour, and the CLI does not refresh them.

### Get one, step by step

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one), open the [Blogger API v3](https://console.cloud.google.com/apis/library/blogger.googleapis.com) in the API Library and click **Enable**.
2. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). If the project has no app yet, click **Get started**: an app name, your support email, **External** as the audience, your contact email, then **Create**.
3. In [Audience](https://console.cloud.google.com/auth/audience), a new app is in *Testing*: only the test users you list can sign in, and Google ends their sign-in after 7 days. Add the Google account that owns the blog under **Test users**, or click **Publish app** to keep sign-ins.
4. In [Data Access](https://console.cloud.google.com/auth/scopes), click **Add or remove scopes**, tick `https://www.googleapis.com/auth/blogger`, click **Update**, then **Save**.
5. In [Clients](https://console.cloud.google.com/auth/clients), click **Create client**, choose **Web application**, and under **Authorized redirect URIs** add the redirect URI of the host that signs in with it. For a token by hand, add `https://developers.google.com/oauthplayground`. Click **Create** and copy the client ID and secret.
6. A host that signs in with your app gets the token itself. By hand: open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials** and paste the client ID and secret; in step 1 enter `https://www.googleapis.com/auth/blogger` and click **Authorize APIs**, signing in with the account that owns or writes for the blog; in step 2 click **Exchange authorization code for tokens** and copy the **Access token**.

### Revoke it

Open your Google Account's [third-party connections](https://myaccount.google.com/connections), pick your app and choose **Delete all connections** (or **Remove access**). Deleting the OAuth client in [Clients](https://console.cloud.google.com/auth/clients) ends every sign-in made with it.

## Account picker

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `blogs` | The blogs the agent may write for (one or more) | `list_blogs` |

With a choice in place (`CONNECTOR_ACCOUNTS={"blogs":["4967929378133675647"]}` in the CLI), every tool refuses any other blog before sending anything, and `blog_id` may be left out when one blog is chosen. Without one, `blog_id` may be left out for an account with a single blog.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_blogs` | read | The blogs the account owns or writes for: id, name, URL and the number of posts and pages. The `blogs` picker. |
| `list_posts` | read | Draft, scheduled and live posts, newest first, with status, labels, times, URL, editor link and comment count. Filters for labels and a time range. |
| `get_post` | read | One post with its HTML body; a long body comes in parts (`content_offset`). |
| `search_posts` | read | Live posts that match some words. |
| `list_labels` | read | The labels of the newest live posts, most used first. |
| `create_draft_post` | create | Saves a new post as a draft (title, HTML body, labels). Nothing becomes public. |
| `update_post` | update | Changes the title, the body or the labels; only the fields given change. |
| `publish_post` | update | Publishes a draft now, or schedules it with `publish_at`. |
| `revert_post` | update | Takes a live or scheduled post back to draft. |
| `delete_post` | delete | Deletes a post: a live or scheduled one goes to the blog's trash, a draft is deleted for good. |
| `list_pages` | read | The blog's draft and live pages. |
| `get_page` | read | One page with its HTML body, in parts when it is long. |
| `create_draft_page` | create | Saves a new page as a draft. |
| `update_page` | update | Changes a page's title or body. |
| `publish_page` | update | Publishes a draft page. |
| `revert_page` | update | Takes a live page back to draft. |
| `delete_page` | delete | Deletes a page (live pages go to the trash). |
| `api_get` | read | Any other GET under `/blogger/v3/`, such as comments or page views. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/blogger/v3/`, such as approving a comment. Sent once, never retried. |

## Limits

- Bodies are HTML. The Blogger API has no image upload: images go into the body as `<img src="https://...">` with a public address.
- Labels replace the post's whole list, and Blogger refuses labels that together run past about 200 characters. The search description and a custom permalink are set in Blogger's editor; the API has no field for them.
- Times are RFC 3339; the connector sends them in UTC. A `publish_at` in the past back-dates the post and publishes it at once.
- A Google account that is only an author on a blog gets HTTP 403 on admin reads: pass `view: "author"`.
- Lists return at most 50 items per call; bodies come in parts of about 24 KB. Every result stays under 32 KB.
- Google applies the Blogger API quota of the Cloud project behind the OAuth client. Nothing is retried: a write with an unclear outcome comes back as unknown, with the read tool to check.
