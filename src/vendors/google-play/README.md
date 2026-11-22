# Google Play

Your Android apps on [Google Play](https://play.google.com/console), through the Google Play Android Developer API v3 and the Google Play Developer Reporting API with a Google Cloud service account: read reviews and reply to them, read the live store listing from the public store page and change it through an edit, read subscriptions with their base plans, offers and free trials, read in-app products, and call the rest of the Android Developer API for the chosen apps.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `google-play` | [Google Play](https://play.google.com/console): reviews from the last week and replies, store listings (the live one from the public store page, and changes through an edit), subscriptions with base plans, prices, offers and free trials, in-app and one-time products, and the rest of the Android Developer API for the chosen apps | Service account key | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `google-play` | `GOOGLE_PLAY_SERVICEACCOUNTJSON` | A service account key (the JSON file, or its base64 text) from Google Cloud console, invited in Play Console. See below. |

## Credentials

| Credential | Variable | Required | What it is |
| --- | --- | --- | --- |
| `serviceaccountjson` | `GOOGLE_PLAY_SERVICEACCOUNTJSON` | yes | The service account key file, as JSON text (or its base64 text). |

### Service account key (`serviceaccountjson`)

1. Open [Google Cloud console](https://console.cloud.google.com/) and pick or create a project.
2. Go to **APIs & Services → Library** and enable the **Google Play Android Developer API**, and the **Google Play Developer Reporting API** (it lists your apps for `list_apps`).
3. Go to **IAM & Admin → Service accounts → Create service account**, give it a name, click **Create and continue**, then **Done**. It needs no project role.
4. Open the new service account, go to **Keys → Add key → Create new key**, choose **JSON** and click **Create**. A JSON file downloads: its whole text is the credential.
5. In [Play Console](https://play.google.com/console), go to **Users and permissions → Invite new users**, paste the service account's email, add the apps under **App permissions**, and give the permissions the agent needs:
   - **View app information (read-only)** to read reviews and products (the store listing is read from the public store page);
   - **Reply to reviews** to reply;
   - **Manage store presence** to change store listings (Google may also ask for it to read in-app products and subscriptions).

   Click **Invite user**. A new service account can take a while, up to a day, before Google Play accepts its calls.

If Google Cloud refuses to create a key because of the organization policy `iam.disableServiceAccountKeyCreation`, an administrator of your organization has to allow keys for this project.

To revoke it: in Play Console go to **Users and permissions**, open the service account and remove its access; in Google Cloud console delete the key under **IAM & Admin → Service accounts → Keys** (or delete the service account).

## Account picker

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `apps` | The Android apps the agent works on, by package name. | `list_apps`: with no choice made, every app the service account can see (through the Reporting API). |

With a choice made, every tool keeps to those apps, and `package_name` may be left out when one app is chosen.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_apps` | read | The chosen apps, or every app the service account can see, with package and display names; the `apps` picker's list. |
| `list_reviews` | read | Reviews with text from the last week, newest first, with stars, language, app version, device and the developer reply; only unanswered ones on request; translated on request. |
| `get_review` | read | One review with its reply. |
| `reply_to_review` | update | Posts the reply to a review, or replaces the earlier one: up to 350 characters of plain text. |
| `get_store_listing` | read | The live store listing as people see it, from the app's public store page in one language and country: title, short and full description, category, developer, content rating, star rating, price and icon. It opens no edit and needs no Play Console permission. |
| `update_store_listing` | update | Changes the listing in one language (title, short or full description, video) in an edit and commits it; Google Play reviews the change before it shows on the store page. |
| `list_subscriptions` | read | Subscriptions with listings, base plans (state, billing period, price in one country) and offers with their phases, and whether an active offer starts with a free trial. |
| `list_in_app_products` | read | In-app products (sku, status, name, default and regional price), or the newer one-time products with their purchase options. |
| `api_get` | read | Any other GET of the Android Developer API under `/androidpublisher/v3/applications/{packageName}/` for a chosen app, such as tracks in an edit or a purchase. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under the same paths, for a chosen app. User and permission management (`/androidpublisher/v3/developers/`) is left out. Sent once, never retried. |

## Limits

- Google Play returns only reviews with text written or changed in the last 7 days, of production versions; older ones are in Play Console's review exports.
- Google Play allows 200 review reads per hour and 2,000 replies per day per app.
- `get_store_listing` reads the public store page, so it shows a published app's live listing only: not a draft, not a change still in review, and one language per call (an app without that translation shows its default language). Other languages and drafts are in Play Console, or behind an edit through `api_request`.
- `update_store_listing` opens an edit. Google Play keeps one open edit per account, so it ends any other edit the same service account has open: do not change listings while a release made with the same key is in progress.
- Listing changes go live after Google Play's review; when Google Play answers that the changes cannot be sent for review automatically, set `changes_not_sent_for_review` and send them from Play Console.
- What `api_request` may do follows the service account's permissions in Play Console, refunds and subscription changes included: grant only what the agent needs.
- The access token is kept in memory until 5 minutes before it expires; the key itself is never stored or logged.
