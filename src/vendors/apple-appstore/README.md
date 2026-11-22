# Apple App Store (`apple-appstore`)

Your apps on the App Store, through the [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi): read and answer customer reviews, run in-app events (create, schedule, localize, check their images, change, delete, send to App Review), and read what an app is and sells (its record, subtitle and categories, version texts, live listing with price and rating, subscriptions with prices and free trials, in-app purchases with prices). Everything else in the API is reachable through `api_get` and `api_request`.

Event images go to Apple's upload servers, outside the API: the connector names them in `uploadHosts` (`.blobstore.apple.com` and `northamerica-1.object-storage.apple.com`), so a host sends each part of an image there, with no credentials; see [Limits](#limits).

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `apple-appstore` | [App Store Connect](https://appstoreconnect.apple.com): read and answer customer reviews, create and localize in-app events with their images and send them to App Review, read app details, live listing, subscriptions and in-app purchases with prices, and call the rest of the App Store Connect API | App Store Connect API key (key ID, issuer ID, .p8 private key) | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `apple-appstore` | `APPLE_APPSTORE_KEYID`, `APPLE_APPSTORE_ISSUERID`, `APPLE_APPSTORE_PRIVATEKEY` | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys: the key ID, the issuer ID above the keys, and the text of the key's `.p8` file (its base64 works too). |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_apps` | read | The apps the key can see: Apple ID, name, bundle ID, SKU, primary locale, with `selected: true` on the apps chosen for the connection. Lists the candidates of the `apps` account picker. |
| `get_app_metadata` | read | What an app is: its record, app info for one locale (subtitle, categories, age rating, privacy URL), latest versions, the live version's description, keywords, promotional text and what's new, and the public App Store listing of one country (price, genre, rating, rating count, live description). |
| `list_subscriptions` | read | Auto-renewable subscriptions, group by group (or one group), with their current price in one territory (default USA), their introductory offers (free trial, pay as you go, pay up front) and whether one on the page has a free trial; pages with a cursor. |
| `list_in_app_purchases` | read | Consumable, non-consumable and non-renewing purchases: name, product ID, type, state, and the current price in one territory (manual, or the automatic equalized one); up to 20 a page with prices. |
| `list_reviews` | read | Customer reviews with rating, title, text, nickname, territory, date and the developer response; filters for rating, territory and answered or not. |
| `respond_to_review` | update | Publishes the developer response to a review, replacing an earlier one. Sent once, never retried. |
| `delete_review_response` | delete | Deletes a developer response. |
| `list_app_events` | read | In-app events with state, badge, schedules and localized texts, and counts by state. |
| `create_app_event` | create | Creates a draft in-app event: badge, purchase requirement, priority, purpose, deep link, territory schedules (checked against Apple's 14-day and 15-minute to 31-day rules first). |
| `update_app_event` | update | Changes an event's fields; only those given change. |
| `delete_app_event` | delete | Deletes an event. |
| `create_app_event_localization` | create | Adds an event's name (30), short description (50) and long description (120) in one locale. |
| `update_app_event_localization` | update | Changes those texts. |
| `list_app_event_images` | read | One localization's images (event card, event details page) with their processing state and Apple's reasons for a failure, its videos and any asset library placements. |
| `upload_app_event_image` | create | Adds the event card (16:9, 1920x1080 to 3840x2160) or event details page image (9:16, 1080x1920 to 2160x3840) from a public https URL: checks the JPEG or PNG first, reserves it, uploads it to the address App Store Connect gives on Apple's upload servers, commits it and waits for processing. An upload that fails removes the reservation again. See Limits. |
| `delete_app_event_image` | delete | Deletes one event image, to replace it or after a failed processing. |
| `submit_app_event_for_review` | create | Sends an event to App Review: reuses the app's open review submission when it holds nothing else, else starts one, adds the event and sends it. A submission that holds other items (an app version, another event) is left alone. Sent once, never retried. |
| `api_get` | read | Any other GET of the App Store Connect API (`/v1/`, `/v2/`, `/v3/`), signed with the key. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the App Store Connect API. Sent once, never retried. |

Account picker `apps` (App Store apps, one or more, listed by `list_apps`, which marks the chosen ones `selected: true`): every tool that names an app refuses one outside the selection. App Store Connect does not say which app an event, an event image or a review belongs to, so under the lock the tools look it up first (an event in the app's event list, a localization's or an image's event, a review among the app's newest 1,000 reviews); prices are read only for subscriptions and purchases from the app's own lists. `api_get` and `api_request` must name a chosen app in the path (`/v1/apps/<id>/...`), in `relationships.app` of a POST to a collection that names nothing else, or in `filter[app]`; a resource read or changed by its own id (such as `/v1/appStoreVersions/<id>`) is refused under the lock.

Connection check: `list_apps` with no arguments.

An in-app event goes to App Review with its texts and both images: `create_app_event`, `create_app_event_localization` per locale, the `EVENT_CARD` and `EVENT_DETAILS_PAGE` images with `upload_app_event_image` (`list_app_event_images` shows them), then `submit_app_event_for_review`.

## Credentials

All three come from one App Store Connect API key. Each call signs a 20-minute ES256 token from them with WebCrypto, in memory; the key is never sent anywhere.

**`keyid`, `issuerid`, `privatekey`: getting them**

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com) as the Account Holder or an Admin.
2. Open **Users and Access** → **Integrations** → **App Store Connect API**, and stay on **Team Keys**. (The first time, request access to the API.)
3. Click **Generate API Key** (or **+**), give it a name, and choose its access: **App Manager** covers everything here; **Customer Support** is enough for reviews only, **Marketing** for in-app events and metadata only.
4. Copy the **Issuer ID** shown above the list of keys: that is `issuerid`.
5. Copy the **Key ID** of the new key: that is `keyid`.
6. Click **Download** next to the key to get `AuthKey_<KEYID>.p8`. Apple lets you download it only once. Its whole text, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`, is `privatekey`; the file's text in base64 is accepted too.

**Revoking it:** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **Revoke** next to the key. Calls fail with a 401 from then on; generate a new key to connect again.

## Limits

- App Store Connect allows about 3,600 requests an hour per key; a 429 comes back with `retryAfter` when Apple sends it.
- Apple allows 10 published, 15 approved and 50 draft in-app events per app at a time; events are shown at most 14 days before they start and last 15 minutes to 31 days. Event texts: name 30, short description 50, long description 120 characters.
- Review responses are up to 5,970 characters and appear on the App Store after Apple publishes them (state `PENDING_PUBLISH` until then).
- Event images are uploaded to the addresses App Store Connect returns for each upload: pre-signed, time-limited, on Apple's upload servers (such as `store-030.blobstore.apple.com` or `northamerica-1.object-storage.apple.com`), which change per upload. The connector declares them in `uploadHosts` as `.blobstore.apple.com` (every host under it) and `northamerica-1.object-storage.apple.com`, the HTTP upload hosts Apple lists for its own uploads: a host sends each part there with a PUT, Apple's request headers and no credentials, after the checks of an upload (this package's CLI does, within its 25 MiB upload limit), and the connector refuses an upload address on any other host before anything is sent. A host built before upload hosts existed refuses the upload; `upload_app_event_image` then removes the reservation again and says so, and the images can still be added in App Store Connect: **Apps** → the app → **In-App Events** → the event, then its event card and event details page media in each locale. The image is downloaded with a 25 MB cap.
- Apple has deprecated the in-app event screenshot resource that `upload_app_event_image` and `delete_app_event_image` use, in favor of the App Asset Library and its placements; it still works, and `list_app_event_images` also shows placements.
- `submit_app_event_for_review` looks into the app's three newest open review submissions for the event. Apple may refuse a new submission while one is waiting for or in review on the same platform.
- App Store Connect reports a refused change with its own reason in a JSON:API error list; the tool error gives the status and a sentence for the common cases.
