# beehiiv connector

Your [beehiiv](https://www.beehiiv.com) newsletter through the [beehiiv API v2](https://developers.beehiiv.com/api-reference) with an API key from your own workspace: publications, posts with opens, clicks and web views, totals over posts, new posts saved as drafts and test emails, sending or scheduling, subscribers with tags and custom fields, segments, and automation enrollment.

| | |
| --- | --- |
| What it can do | Post stats and totals, drafts, test emails, send or schedule, subscribers (find, add, tag, update, unsubscribe), segments and their members, automations |
| Auth | A beehiiv API key; a default publication ID is optional |
| Environment variables | `BEEHIIV_APIKEY`, and optionally `BEEHIIV_PUBLICATIONID` |
| Where to get them | beehiiv → Settings → Workspace Settings → API → Create New API Key; the Publication ID section of the same page |

## Credentials

| Credential | Environment variable | Required |
| --- | --- | --- |
| `apikey` | `BEEHIIV_APIKEY` | Yes |
| `publicationid` | `BEEHIIV_PUBLICATIONID` | No: the publication the tools use when `publication_id` is not given |

The key goes only to `https://api.beehiiv.com/v2/`, as `Authorization: Bearer <key>`. Without a saved publication ID, every tool but `list_publications` takes `publication_id`.

### The API key

1. Sign in at [app.beehiiv.com](https://app.beehiiv.com) as the workspace Owner or an Admin: only those roles can create API keys. beehiiv first asks the workspace to finish its identity check with Stripe.
2. In the left menu click **Settings**, then under **Workspace Settings** choose **API**.
3. In the **API Keys** section click **Create New API Key**, give it a name you will recognize, and click **Create New Key**. On a paid plan the **Publications** field can limit the key to some publications; a limited key answers `404` for the others.
4. Copy the key and click **I've saved the key**: beehiiv shows it only once.

### The publication ID (optional)

On the same **API** page, scroll to the **Publication ID** section, pick the publication with the arrows icon and copy its API V2 ID: `pub_` followed by 36 letters, digits and dashes. `list_publications` lists the publications the key reaches, too.

### How to revoke it

Open the same **API** page, click the three dots next to the key and choose **Delete**.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_publications` | read | The publications the key reaches, with active subscriptions, beehiiv's average open and click rates and emails sent. |
| `get_publication` | read | One publication's numbers. |
| `list_posts` | read | Posts (sent or scheduled by default, or drafts, archived, all) with email numbers, unique opens and clicks as a share of delivered emails, and web views. |
| `get_post` | read | One post with its numbers, its ten best links, and one version of its body (free or premium, web, email or RSS) in windows with a cursor. |
| `get_posts_aggregate_stats` | read | Email and web totals over all posts that match the filters. |
| `list_drafts` | read | Draft posts, newest created first: where a draft `create_draft_post` saved shows up. |
| `create_draft_post` | create | Saves a post as a draft that reaches no one, then reads it back while beehiiv finishes it; returns a preview link. |
| `update_draft_post` | update | Changes a draft's fields or body; it reads the post first and changes finished drafts only. |
| `send_test_email` | create | Sends a test of a post to the given addresses only; says how many tests are left today. |
| `send_post` | update | Sends a draft to its recipients now, or schedules it. The one tool that reaches subscribers; it reads the post first, sends finished drafts only, and cannot be undone through the API. |
| `list_subscriptions` | read | Finds a subscriber by email, or lists subscribers by status and tier, with custom fields and email numbers. |
| `get_subscription` | read | One subscription with its tags, custom fields, tier and email numbers. |
| `create_subscription` | create | Adds a subscriber who agreed to receive the newsletter; no welcome email, reactivation, premium tier or automation unless asked. |
| `add_subscription_tags` | update | Adds tags to a subscription. |
| `update_subscription` | update | Sets or removes custom field values, changes the tier, or unsubscribes. |
| `list_resources` | read | Segments, automations (with their Add by API trigger), custom fields, tiers or post templates. |
| `list_segment_members` | read | The subscriptions in a segment. |
| `list_automation_journeys` | read | Who an automation was started for, with each journey's status and dates: whether someone is already enrolled. |
| `enroll_in_automation` | create | Starts an automation for an existing subscriber (the automation emails them). |
| `api_get` | read | Any other GET of the beehiiv API under `/v2/`, such as the referral program or authors. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the beehiiv API under `/v2/`. Sent once, never retried. Webhooks (in any spelling of the path, such as `/webhooks.json`) and deleting posts or subscriptions are not offered. |

## Limits

- Plans: every plan, Free included, can read posts, stats and subscribers and add subscribers. Creating or changing posts (beehiiv's Send API: `create_draft_post`, `update_draft_post`, `send_post`) needs the Pro or Enterprise plan and is not part of a Pro trial. Automations start on the Lite plan; Free keeps 3 segments, Lite 10.
- beehiiv allows 30 requests a minute on Free, 180 on Lite, 500 on Pro and 800 on Enterprise. A `429` comes back with `retryAfter`; nothing is retried, and a write without a clear answer is reported as unknown, with the read tool to check.
- beehiiv finishes a new post in the background: `create_draft_post` reads it back up to three times, honoring `Retry-After`, then says it is still pending. Until it is done, beehiiv answers `202` and takes no change: `update_draft_post` and `send_post` then report that nothing was changed or sent, with `retryAfter`, and are called again later. A `404` for the ID beehiiv just gave means the creation failed (`POST_CREATION_FAILED`): no draft exists. Drafts cannot be scheduled; `send_post` with `scheduled_at` confirms and schedules in one step, and a scheduled post is unscheduled in beehiiv itself.
- Post bodies are HTML with inline styles only: beehiiv removes `<style>` and `<link>` tags, and the publication's email template adds the layout and the footer. Test sends are capped per publication per day.
- Posts and subscriptions are never deleted through the connector: beehiiv deletes them for good, so that stays in beehiiv itself.
