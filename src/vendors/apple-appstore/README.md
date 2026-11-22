# Apple App Store (`apple-appstore`)

Your apps on the App Store, through the [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi): read and answer customer reviews, plan in-app events (create, schedule, localize, change, delete), and read what an app is and sells (its record, subtitle and categories, version texts, live listing with price and rating, subscriptions with free trials, in-app purchases). Everything else in the API is reachable through `api_get` and `api_request`.

## README rows

Connectors table:

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `apple-appstore` | [App Store Connect](https://appstoreconnect.apple.com): read and answer customer reviews, create, localize and change in-app events, read app details, live listing, subscriptions and in-app purchases, and call the rest of the App Store Connect API | App Store Connect API key (key ID, issuer ID, .p8 private key) | Available |

Quick start table:

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `apple-appstore` | `APPLE_APPSTORE_KEYID`, `APPLE_APPSTORE_ISSUERID`, `APPLE_APPSTORE_PRIVATEKEY` | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys: the key ID, the issuer ID above the keys, and the text of the key's `.p8` file (its base64 works too). |

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_apps` | read | The apps the key can see: Apple ID, name, bundle ID, SKU, primary locale. Lists the candidates of the `apps` account picker. |
| `get_app_metadata` | read | What an app is: its record, app info for one locale (subtitle, categories, age rating, privacy URL), latest versions, the live version's description, keywords, promotional text and what's new, and the public App Store listing of one country (price, genre, rating, rating count, live description). |
| `list_subscriptions` | read | Auto-renewable subscriptions by group, with their current price in one territory (default USA), their introductory offers (free trial, pay as you go, pay up front) and whether any has a free trial. |
| `list_in_app_purchases` | read | Consumable, non-consumable and non-renewing purchases: name, product ID, type, state. Their prices are read with `api_get` (`/v1/inAppPurchasePriceSchedules/<id>/manualPrices`). |
| `list_reviews` | read | Customer reviews with rating, title, text, nickname, territory, date and the developer response; filters for rating, territory and answered or not. |
| `respond_to_review` | update | Publishes the developer response to a review, replacing an earlier one. Sent once, never retried. |
| `delete_review_response` | delete | Deletes a developer response. |
| `list_app_events` | read | In-app events with state, badge, schedules and localized texts, and counts by state. |
| `create_app_event` | create | Creates a draft in-app event: badge, purchase requirement, priority, purpose, deep link, territory schedules (checked against Apple's 14-day and 15-minute to 31-day rules first). |
| `update_app_event` | update | Changes an event's fields; only those given change. |
| `delete_app_event` | delete | Deletes an event. |
| `create_app_event_localization` | create | Adds an event's name (30), short description (50) and long description (120) in one locale. |
| `update_app_event_localization` | update | Changes those texts. |
| `api_get` | read | Any other GET of the App Store Connect API (`/v1/`, `/v2/`, `/v3/`), signed with the key. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the App Store Connect API, such as a review submission. Sent once, never retried. |

Account picker `apps` (App Store apps, one or more, listed by `list_apps`): every tool that names an app refuses one outside the selection. App Store Connect does not say which app an event or a review belongs to, so under the lock the write tools look it up first (an event in the app's event list, a review among the app's newest 1,000 reviews). `api_get` and `api_request` must name a chosen app in the path (`/v1/apps/<id>/...`), in `relationships.app` of a POST to a collection, or in `filter[app]`.

Connection check: `list_apps` with no arguments.

Submitting an in-app event for App Review has no tool of its own: with `api_request`, create a review submission for the app (`POST /v1/reviewSubmissions`), add the event to it (`POST /v1/reviewSubmissionItems` with `relationships.appEvent`), then send it (`PATCH /v1/reviewSubmissions/<id>` with `submitted: true`); or submit it in App Store Connect. A review submission can hold other items, such as an app version, so check what it contains first.

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
- In-app event images (event card and detail page) are not uploaded by this connector yet: App Store Connect returns upload URLs on hosts that change per upload, which the connector's fixed origins cannot name. Add them in App Store Connect.
- App Store Connect reports a refused change with its own reason in a JSON:API error list; the tool error gives the status and a sentence for the common cases.
