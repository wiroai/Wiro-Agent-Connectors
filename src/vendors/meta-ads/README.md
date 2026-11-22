# Meta Ads (`meta-ads`)

Report on and manage Facebook and Instagram ads through the Marketing API v26.0: ad account status and spend; insights at account, campaign, ad set and ad level with date presets or ranges, daily rows, breakdowns (age, gender, country, placement, device) and filters; campaigns, ad sets and ads created paused, then turned on, paused, archived, re-budgeted or deleted; ad creatives (image, video, carousel) for chosen Facebook Pages, with images uploaded from a URL and videos fetched by Meta and checked until processed; custom audiences, targeting search and audience estimates; and the rest of the Marketing API inside the chosen ad accounts.

Campaigns, ad sets and ads are always created paused, so nothing spends until `update_status` turns them on. Budgets, bids and spend caps are in the minor unit of the ad account's currency (5000 is 50.00 USD); money in insights is in the currency itself.

## Credentials

The connector needs one of two credentials: `access_token` (a sign-in with your own Meta app) or `systemusertoken` (a Meta Business system user token).

### `access_token`: a sign-in with your own Meta app

The host signs you in with your own Meta app (Facebook Login) and passes the current user access token on every call, with `appsecret_proof` when it computes one (the HMAC-SHA256 of the token keyed with your app secret; the secret stays with the host). The proof goes with every call. The connector never refreshes or stores the token: a long-lived Meta token lasts about 60 days, then you sign in again.

1. Open [Meta for Developers → My Apps](https://developers.facebook.com/apps/), select your app or create one of the **Business** type.
2. Under **App Review → Permissions** (or the app's use cases), add `ads_management`, `ads_read` and `business_management`; for Page discovery and Page-backed creatives also `pages_show_list`, `pages_manage_ads` and `pages_read_engagement`.
3. Under **Facebook Login → Settings**, add your host's OAuth callback URL as a **Valid OAuth Redirect URI**.
4. Give the host the **App ID** and **App Secret** (App settings → Basic), then sign in with a person who has the ADVERTISE and ANALYZE tasks on the ad accounts.

To revoke: remove the app in Facebook under **Settings & privacy → Settings → Business integrations**, or reset the app secret.

### `systemusertoken`: a Meta Business system user token

1. Open [Meta Business Settings → Users → System users](https://business.facebook.com/latest/settings/system_users) and create or select a system user (not a personal login).
2. Assign the ad accounts with the **ADVERTISE** and **ANALYZE** tasks; for Page-backed creatives, also assign each Page with its advertising task.
3. Click **Generate new token**, choose the Business app of the integration and, at **Set expiration**, choose **Never** where Meta offers it.
4. Grant `ads_management`, `ads_read` and `business_management`; add `pages_show_list`, `pages_read_engagement` and `pages_manage_ads` for Page-backed creatives.
5. Copy the token: Meta shows it once, and it is used unchanged. The app must not require the app secret proof on every call (**App settings → Advanced → Require App Secret** off), since a system user token carries none.

To revoke: in **System users**, select the system user and click **Revoke tokens**, or remove its ad account assignments.

### `pagemappings`

The Pages an older setup chose for each ad account, as JSON text such as `[{"adaccountid": "1234567890", "pageid": "1001", "pagename": "Example"}]`. It is optional: the `pages` account picker replaces it, and it is only read when no Pages are chosen there.

### Environment variables (CLI)

| Variable | Credential |
| --- | --- |
| `META_ADS_ACCESS_TOKEN` | A current user access token from your own app's sign-in (alternative 1). |
| `META_ADS_APPSECRET_PROOF` | Optional: the app secret proof of that token, when your app requires it. |
| `META_ADS_SYSTEMUSERTOKEN` | A system user token (alternative 2). |
| `META_ADS_PAGEMAPPINGS` | Optional: an older setup's Page choice per ad account, as JSON. |

## Account pickers

| Key | Lists | Tool |
| --- | --- | --- |
| `ad_accounts` | The ad accounts the agent may report on and manage (several may be chosen; by default the list shows the active ones with ADVERTISE and ANALYZE). An older setup kept this choice in `adaccountid`. | `list_ad_accounts` |
| `pages` | The Facebook Pages the agent may use in ad creatives. An older setup kept this choice per ad account in `pagemappings`. | `list_pages` |

Tools take an optional `ad_account_id` (with or without `act_`), which may be left out when one ad account is chosen; campaigns, ad sets and ads named by id are checked against the chosen ad accounts before any change, and a Page named in a creative, an ad set's `promoted_object` or a generic request's body must be one of the chosen Pages.

For app campaigns, `promoted_object` takes the app's Meta app ID as `application_id` (the Meta app registered for the mobile app: `api_get` on `/v26.0/act_<id>/advertisable_applications` lists them, and the app's Meta dashboard shows it) and its store link as `object_store_url`, such as `https://apps.apple.com/app/id<App Store id>` or `https://play.google.com/store/apps/details?id=<package>`. The store connectors give only the App Store id or the package name that the link is built from, never the Meta app ID.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_ad_accounts` | read | The ad accounts the connection can use, with status, currency, time zone and tasks; the `ad_accounts` picker's tool. |
| `get_ad_account` | read | An ad account's status, disable reason, tasks, spend, balance, spend cap and minimum daily budget. |
| `list_pages` | read | The Pages for ad creatives, or the Pages an ad account can promote; the `pages` picker's tool. |
| `get_insights` | read | Performance at account, campaign, ad set or ad level, with presets or ranges, daily rows, breakdowns and filters. |
| `list_objects` | read | An ad account's campaigns, ad sets, ads or creatives with status, budgets, targeting and schedule. |
| `get_object` | read | One campaign, ad set, ad or creative with its settings. |
| `list_audiences` | read | Custom and lookalike audiences with size range and delivery status. |
| `list_ad_media` | read | Uploaded ad images (with their hash) or ad videos (with their processing status). |
| `search_targeting` | read | Targeting ids for interests, places, languages, employers, job titles and schools. |
| `estimate_audience` | read | The monthly active audience range for a targeting spec and optimization goal. |
| `create_campaign` | create | A paused campaign with an objective, special ad categories and an optional campaign budget. |
| `create_ad_set` | create | A paused ad set with targeting, optimization goal, budget, bid, schedule and promoted object. |
| `upload_image` | create | Downloads an image from a URL and adds it to the ad account's library; returns its hash. |
| `upload_video` | create | Adds a video from a URL (Meta fetches it) and waits while it is processed. |
| `create_creative` | create | An image, video or carousel creative for a chosen Page, with text, headline, link and call to action. |
| `create_ad` | create | A paused ad from an ad set and a creative. |
| `update_status` | update | Turns a campaign, ad set or ad on (ACTIVE), off (PAUSED) or archives it. |
| `update_budget` | update | Changes a campaign's or ad set's daily or lifetime budget, bid, spend cap or end time. |
| `delete_object` | delete | Deletes a campaign, ad set or ad (Meta keeps it as DELETED). |
| `api_get` | read | Any other Marketing API GET under `/v26.0/`, inside the chosen ad accounts. |
| `api_request` | write | A POST or DELETE under `/v26.0/` inside the chosen ad accounts, such as editing targeting or a name. Sent once, never retried. |

## Limits

- Writes are never retried: duplicates are worse than failures. When a create's outcome is unclear, check `list_objects` (or `get_object` after an update) before trying again.
- Images: JPEG, PNG or GIF up to 30 MB (a host may cap downloads lower), downloaded from a public https URL and sent to Meta. Videos are fetched by Meta from a public https URL; a call waits at most 45 seconds for processing. Files behind a sign-in (such as a private cloud drive) need a public URL first.
- `api_get` and `api_request` send one request per call, with parameters in `query`, or for `api_request` in `json` or a form `body` (`application/x-www-form-urlencoded`); other bodies are refused. Batch requests (`batch`) and method overrides (`method`) are refused. Lead forms and lead data (by path or in `fields`), the `accounts` edge (Pages with their tokens), and any request that names a token or an app secret anywhere, however it is encoded, are out of reach, as are `/oauth` endpoints; a reply never carries a token or an app secret proof back.
- With ad accounts chosen, generic calls must name one of them (`act_<id>`) or one of their objects (`/v26.0/search` is allowed), may not reach businesses, agencies or other ad accounts through the path or nested `fields` (such as `business{owned_ad_accounts}`), and may not look objects up by `ids`. A Page they name in a body or the query (`page_id`, `actor_id`, `object_story_id`) must be one of the chosen Pages.
- Meta removed the Instagram explore placement and some delivery estimate fields in v26; Housing, Employment and Financial Products ad sets with detailed targeting must set `targeting_automation.advantage_audience` in `targeting`.
- Meta throttles with HTTP 400 or 403 and a rate limit code (4, 17, 613, or 80000 to 80014 for business use cases, such as 80004 for ads management), not with HTTP 429. Such an error says "rate limit reached"; wait before trying again, since Meta counts calls over a rolling hour. Meta's estimate of the wait comes in the `X-Business-Use-Case-Usage` header, which the result does not carry yet. Nothing is queued or retried.

## Repository README rows

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `meta-ads` | [Meta Ads](https://www.facebook.com/business/ads): insights with breakdowns; campaigns, ad sets and ads created paused, turned on, re-budgeted or deleted; image, video and carousel creatives with uploads; audiences and targeting; and the rest of the Marketing API inside your chosen ad accounts | Your own app's sign-in, or a system user token | Available |

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `meta-ads` | `META_ADS_ACCESS_TOKEN` (with `META_ADS_APPSECRET_PROOF` when your app requires it), or `META_ADS_SYSTEMUSERTOKEN`; optional `META_ADS_PAGEMAPPINGS` | A user token from your own Meta app's sign-in, or a system user token from Meta Business Settings → Users → System users with the ad accounts assigned. Account keys: `ad_accounts`, `pages`. |
