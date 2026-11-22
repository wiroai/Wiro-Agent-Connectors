# Google Business Profile connector

The Google reviews of your [Google Business Profile](https://business.google.com) locations through the [Business Profile APIs](https://developers.google.com/my-business/reference/rest): list accounts and locations, read new and unanswered reviews (the reviewer's own words and Google's translation), post or replace the owner's reply and follow Google's moderation of it, delete a reply, and call the rest of the APIs (location details, local posts, performance metrics).

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `google-business` | [Google Business Profile](https://business.google.com): list accounts and locations, read reviews, reply to them and follow the reply's moderation, delete a reply, and call the rest of the Business Profile APIs | Google OAuth access token | Available |

## Credentials

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `google-business` | `GOOGLE_BUSINESS_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/business.manage`, from your own Google Cloud OAuth client in a project Google approved for the Business Profile APIs (see below). |

`access_token` (`GOOGLE_BUSINESS_ACCESS_TOKEN` in the CLI) is an OAuth 2.0 access token of a Google account that owns or manages the business, with the scope `https://www.googleapis.com/auth/business.manage`. A host that signs in with your OAuth app passes its current token on every call and refreshes it; the connector never stores it. Google access tokens last one hour, and the CLI does not refresh them.

### Get one, step by step

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one) and copy its **Project number** from the project dashboard.
2. Ask Google for Business Profile API access for that project: open the [Business Profile API contact form](https://support.google.com/business/contact/api_default), choose **Application for Basic API Access** and apply with an email that is an owner or manager of the Business Profile. Google asks for a profile verified and active for 60 days or more, with a website, and reviews requests within about 14 days.
3. Check the answer in [IAM & Admin → Quotas](https://console.cloud.google.com/iam-admin/quotas): 0 requests per minute means not approved yet, 300 means approved. Until then Google answers every call with HTTP 429.
4. After approval, enable the [Google My Business API](https://console.cloud.google.com/apis/library/mybusiness.googleapis.com), the [My Business Account Management API](https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com) and the [My Business Business Information API](https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com); for metrics through `api_get`, also the [Business Profile Performance API](https://console.cloud.google.com/apis/library/businessprofileperformance.googleapis.com).
5. In [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience), choose **External** and set the publishing status to **In production** (in *Testing*, Google ends the sign-in after 7 days). In [Data Access](https://console.cloud.google.com/auth/scopes), add the scope `https://www.googleapis.com/auth/business.manage`.
6. In [Clients](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application** and add the redirect URI of the host that signs in with it. For a token by hand, add `https://developers.google.com/oauthplayground`.
7. A host that signs in with your app gets the token itself. By hand: open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials** and paste the client ID and secret; in step 1 enter `https://www.googleapis.com/auth/business.manage` and click **Authorize APIs**, signing in with the account that manages the business; in step 2 click **Exchange authorization code for tokens** and copy the **Access token**. When Google warns that the app is unverified, it is your own app: open **Advanced** and continue.

### Revoke it

Open the Google account's [third-party connections](https://myaccount.google.com/connections), pick your app and choose **Delete all connections** (or **Remove access**). Deleting the OAuth client in [Clients](https://console.cloud.google.com/auth/clients) ends every sign-in made with it.

## Account pickers

| Key | What is chosen | Listed by |
| --- | --- | --- |
| `accounts` | The Business Profile accounts (your own, or a business group) the agent may read account-wide; with exactly one chosen, review tools use it when no account id is given | `list_accounts` |
| `locations` | The locations whose reviews the agent may read and answer | `list_locations` |

The two are chosen separately, and the location choice is the lock. With a choice in place (`CONNECTOR_ACCOUNTS={"accounts":["111"],"locations":["9001"]}` in the CLI), review tools and the generic tools work only on chosen locations, whichever account holds them, and `list_locations` shows only those (it goes through every account to find them). `account_id` may be left out when exactly one account is chosen and it holds the location; otherwise `list_locations` gives it. In the generic tools, a change always names a chosen location (a `locations/ID` path, or `locationNames`), an account-wide read (such as `/v1/accounts/111`) needs a chosen account, an account's location list is read with `list_locations`, and the shared category, attribute and chain lists need neither. Without a choice, review tools take `account_id` with `location_id`; `list_locations` gives both.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_accounts` | read | The accounts the Google account can use, with type and role. The `accounts` picker. |
| `list_locations` | read | Locations with id, name, account id, address, phone, website, main category, open status, Maps link and review link. The `locations` picker. |
| `list_reviews` | read | A location's reviews, newest edits first, with average rating and review count; filters for reviews after a time (`since`) and unanswered ones. |
| `get_review` | read | One review with the owner's reply and its moderation state. |
| `reply_to_review` | update | Posts or replaces the owner's reply, up to 4,096 bytes. Google checks it before showing it. |
| `delete_review_reply` | delete | Deletes the owner's reply; the review stays. |
| `api_get` | read | Any other GET on the Business Profile APIs, such as a location's details, local posts or daily metrics. |
| `api_request` | write | A POST, PUT, PATCH or DELETE on those APIs, such as a local post. Admins, invitations, transfers and notification settings are never changed. Sent once, never retried. |

## Limits

- Google answers only for a Cloud project it approved for the Business Profile APIs; until then every call gets HTTP 429 (a quota of 0 requests per minute).
- Replies are at most 4,096 bytes (letters such as ç or é count as two). Google moderates them: `get_review` shows `pending`, `approved` or `rejected` with the policy problem. The API cannot report a review or reply to it as anyone but the owner.
- Google's terms allow keeping review content for at most 30 days, and ask for the business's consent before replies are posted automatically.
- `list_reviews` reads 50 reviews per call; `since` stops at older ones. Every result stays under 32 KB, with a cursor for more.
- Changes to who manages an account or a location (admins, invitations, transfers) and to where its notifications go are never sent: make them in Business Profile Manager. A body given as text (`body`) must be JSON.
- Nothing is retried: a reply or deletion with an unclear outcome comes back as unknown, with `get_review` to check.
