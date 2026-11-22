# Pinterest connector

Organic Pins on [Pinterest](https://www.pinterest.com) through the Pinterest API v5, with the OAuth access token of your own Pinterest app: image Pins and video Pins (uploaded to Pinterest for you) on a board or a board section, with title, description, link and alt text; boards and sections listed and created; Pins listed, read and deleted; Pin and account analytics; and the rest of the API for organic content. Never ads, catalogs or billing.

Credential check: `get_account` (a read tool that needs no arguments).

## Credentials

| Credential | Environment variable (CLI) | What it is |
| --- | --- | --- |
| `access_token` | `PINTEREST_ACCESS_TOKEN` | The current OAuth access token of your own Pinterest app, signed in with the account (it starts with `pina_`). |

The host signs in with your app and refreshes the token (an access token lasts 30 days, and each refresh extends the 60-day refresh token); the connector only uses it. The app's ID and secret key stay with the host and never reach the connector.

### Setting up your own Pinterest app

1. Use a Pinterest business account (free; a personal account can be converted in its settings). Apps registered on or after September 14, 2026 cannot read the boards and Pins of personal accounts.
2. Sign in, open [developers.pinterest.com, My apps](https://developers.pinterest.com/apps/), accept the developer terms and click **Connect app**. Fill in the form: an app name, what it does, your website and a privacy policy page. Pinterest reviews the request for **Trial access** and emails you.
3. Once approved, click **Manage** on the app. On the **Configure** tab, add the redirect URI of the host that signs you in under **Redirect URIs**, and note the **App ID** and **App secret key** for that host.
4. Sign in through the host and allow the scopes `boards:read`, `boards:write`, `pins:read`, `pins:write` and `user_accounts:read`.

**Trial and Standard access.** With Trial access the app can read your boards, Pins and analytics (1,000 requests a day), but Pinterest refuses to create Pins or boards on your profile (error code 29); the connector says so and how to upgrade. To publish, upgrade the app to **Standard access**: in **My apps**, click **Upgrade** on the app card, check the description and privacy policy link, upload a short screen recording of the sign-in and a working call, and submit. Pinterest answers by email.

**Revoke it:** open Pinterest **Settings**, then **Security**, find the app among your connected apps and remove it.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The connected account: username, business or personal, board and Pin counts, followers, monthly views. |
| `list_boards` | read | Your boards with their ids, privacy and Pin counts. |
| `list_board_sections` | read | The sections of a board. |
| `list_pins` | read | Pins on a board, in a section, or all of yours, newest first, optionally with their 90-day and lifetime numbers. |
| `get_pin` | read | One Pin, optionally with its numbers. |
| `create_pin` | create | An image Pin from a public https URL of a PNG or JPEG, on a board or section, with title (100), description (800), link and alt text (500), and Pinterest's AI disclosure when it applies. |
| `create_video_pin` | create | A video Pin: downloads the MP4 or MOV, uploads it to Pinterest, waits while it is processed, then creates the Pin with a cover image or a frame. When processing takes longer it returns the `media_id` to finish with later, without uploading again. |
| `create_board` | create | A public board. |
| `create_board_section` | create | A section in a board. |
| `delete_pin` | delete | Deletes one of your Pins. |
| `get_pin_analytics` | read | A Pin's impressions, saves, Pin clicks, outbound clicks and save rate (video metrics too) over up to 90 days, with lifetime comments and reactions and how many days are final. |
| `get_account_analytics` | read | The account's impressions, saves, clicks and engagement over up to 90 days. |
| `api_get` | read | Any other GET of the API under `/v5/`, such as top Pins. Ad accounts, catalogs and OAuth endpoints are left out. |
| `api_request` | write | A POST, PATCH or DELETE under `/v5/`, such as PATCH `/v5/pins/<id>` to change a Pin. Sent once, never retried. |

## Limits

- Creating Pins and boards needs Standard access (see above). Trial apps have 1,000 requests a day; Standard apps have per-minute limits.
- Pins: title up to 100 characters, description 800, alt text 500, link 2,048. Images up to 20 MB, PNG or JPEG; 2:3 (1000 x 1500) shows best. Videos up to 2 GB as Pinterest allows, or less where the host caps downloads.
- Pinterest publishes at once: there is no scheduling. A Pin on a public board is public. An account can have up to 2,000 boards; boards created here are public.
- Analytics: dates are UTC; the start can be at most 90 days back and a range at most 90 days long (default: the last 30 days ending yesterday). A metric Pinterest leaves out has no data yet, which is not zero, and the newest days can still change.

<!--
Rows for the main README.

Connectors table:
| `pinterest` | [Pinterest](https://www.pinterest.com) organic Pins: image and video Pins on boards and sections with title, description, link and alt text, boards and sections, Pin and account analytics, and the rest of the API v5 (no ads) | OAuth access token of your own Pinterest app | Available |

Quick start table:
| `pinterest` | `PINTEREST_ACCESS_TOKEN` | A current access token of your own Pinterest app (developers.pinterest.com → My apps), with the scopes `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read`. Creating Pins needs Standard access. |

Tools: the table above.
-->
