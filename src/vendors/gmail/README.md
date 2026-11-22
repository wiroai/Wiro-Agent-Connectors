# Gmail connector

A [Gmail](https://mail.google.com) mailbox through the [Gmail API v1](https://developers.google.com/gmail/api/reference/rest): find mail with Gmail's search (such as unread inbox mail), read messages and whole threads as text, mark them read or unread, label, archive or trash them, keep drafts, send mail and replies in their thread, and call the rest of the API (history, attachments). One connection is one mailbox.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `gmail` | A [Gmail](https://mail.google.com) mailbox: search and read mail and threads, mark read, label, archive and trash, save drafts, send mail and replies, and call the rest of the Gmail API | Google OAuth access token | Available |

## Credentials

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `gmail` | `GMAIL_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/gmail.modify`, from your own Google Cloud OAuth client (see below). |

`access_token` (`GMAIL_ACCESS_TOKEN` in the CLI) is an OAuth 2.0 access token of the mailbox's Google account with the scope `https://www.googleapis.com/auth/gmail.modify`: it reads, labels, drafts and sends mail and moves it to the trash. It cannot delete messages or threads for good; it can delete drafts and labels for good (a DELETE through `api_request`). A host that signs in with your OAuth app passes its current token on every call and refreshes it; the connector never stores it. Google access tokens last one hour, and the CLI does not refresh them.

### Get one, step by step

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one), open the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in the API Library and click **Enable**.
2. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). If the project has no app yet, click **Get started**: an app name, your support email, the audience (**Internal** for a Google Workspace organization's own mailboxes, otherwise **External**), your contact email, then **Create**.
3. In [Data Access](https://console.cloud.google.com/auth/scopes), click **Add or remove scopes**, enter `https://www.googleapis.com/auth/gmail.modify`, click **Update**, then **Save**. Google treats this scope as restricted: an External app that other people sign in to needs Google's verification, while your own mailboxes can use it unverified. In [Audience](https://console.cloud.google.com/auth/audience), click **Publish app** so the status is **In production**; when you sign in, Google warns that the app is unverified: it is your own app, so open **Advanced** and continue. Keep an External app in *Testing* (with the mailbox's account under **Test users**) only for a short trial: Google ends a test user's sign-in after 7 days. An **Internal** app, for a Google Workspace organization's own mailboxes, needs neither.
4. In [Clients](https://console.cloud.google.com/auth/clients), click **Create client**, choose **Web application**, and under **Authorized redirect URIs** add the redirect URI of the host that signs in with it. For a token by hand, add `https://developers.google.com/oauthplayground`. Click **Create** and copy the client ID and secret.
5. A host that signs in with your app gets the token itself. By hand: open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials** and paste the client ID and secret; in step 1 enter `https://www.googleapis.com/auth/gmail.modify` and click **Authorize APIs**, signing in with the mailbox's account; in step 2 click **Exchange authorization code for tokens** and copy the **Access token**.

### Revoke it

Open the mailbox account's [third-party connections](https://myaccount.google.com/connections), pick your app and choose **Delete all connections** (or **Remove access**). Deleting the OAuth client in [Clients](https://console.cloud.google.com/auth/clients) ends every sign-in made with it.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The mailbox's address and its numbers of messages and threads. |
| `list_messages` | read | Messages that match a Gmail search (such as `in:inbox is:unread`) or labels, newest first: sender, recipients, subject, date, snippet, labels and unread state. |
| `get_message` | read | One message: headers, the body as text (HTML-only mail made readable, or the HTML itself) and, with the first part, up to 20 attachments with their ids; a long body comes in parts that join up (`content_offset`). |
| `get_thread` | read | A whole conversation, oldest first, each body cut at 3,000 characters. |
| `list_labels` | read | System and user labels with their ids. |
| `list_drafts` | read | The drafts, with recipients, subject and snippet. |
| `mark_as_read` | update | Marks messages read, or unread with `read: false`. |
| `modify_labels` | update | Adds and removes labels by id: archive (remove `INBOX`), star, file under a label. |
| `trash_message` | delete | Moves a message to the trash (Gmail deletes it after 30 days). |
| `create_label` | create | Creates a label. |
| `create_draft` | create | Saves a new mail or a reply (in its thread) as a draft, in plain text or HTML. Nothing is sent. |
| `send_draft` | create | Sends a saved draft. |
| `send_message` | create | Sends a new mail or a reply in its thread right away. |
| `api_get` | read | Any other GET under `/gmail/v1/users/me/`, such as history or an attachment. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/gmail/v1/users/me/`, such as modifying a whole thread or deleting a draft (for good). Settings are never changed. Sent once, never retried. |

## Limits

- Searches use Gmail's own syntax. A list reads each message's headers with one more request per message (five at a time), so it returns at most 50 messages per call.
- A long body comes in parts, each as large as the 32 KB result allows (about 16 KB or more), and the parts join up to the whole body. HTML-only mail is made readable from its first 1,000,000 characters of HTML; `body_format: "html"` returns all of it. The first part lists up to 20 attachments with their ids (`attachment_count` is the total); `api_get` can fetch a small one, as base64 text cut to fit. Every result stays under 32 KB.
- Sending takes plain text or HTML (sent with a plain-text copy), with To, Cc and Bcc, and replies in their thread. Attachments cannot be sent.
- Gmail settings (forwarding, filters, delegates, send-as addresses, vacation replies) are read only here. Messages and threads are never deleted for good (the scope does not allow it; `trash_message` moves one to the trash), but a DELETE through `api_request` deletes a draft or a label for good.
- Google applies the Gmail API quota of the Cloud project behind the OAuth client and a per-mailbox rate limit; a rate limit comes back with `retryAfter`. Nothing is retried: a write with an unclear outcome comes back as unknown, with the read tool to check.
