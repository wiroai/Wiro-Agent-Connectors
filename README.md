<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/Wiro-Agent-Connectors/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro Agent Connectors

MCP connectors for services that have no official MCP server. One small, dependency-free module per service, ready for Claude, Cursor and any other MCP client.

[![npm](https://img.shields.io/npm/v/@wiro-ai/wiro-agent-connectors?style=for-the-badge&color=111111)](https://www.npmjs.com/package/@wiro-ai/wiro-agent-connectors) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-111111?style=for-the-badge&color=111111)](#quick-start) [![MCP server](https://img.shields.io/badge/MCP-server-111111?style=for-the-badge&color=111111)](https://modelcontextprotocol.io/) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge&color=111111)](./LICENSE)

[Website](https://wiro.ai) · [Add your connector](./CONTRIBUTING.md) · [Wiro MCP](https://github.com/wiroai/Wiro-MCP) · [All Wiro AI open source](https://wiroai.github.io)

<img src="https://wiro.ai/images/koala/accent-heavy-koala.png" alt="Wiro AI koala mascot" width="60" />

</div>

Many services an AI agent should work with, such as a blog platform, a social network or a search API, have a good HTTP API and no MCP server. This repository closes that gap with one connector per service. Each connector is a single file with a list of tools and a `call` function, and it has no dependencies: every request goes through a `fetch` that the host hands it, so the host decides where it may connect. Run any connector locally over stdio with `npx`, or load the modules into your own MCP host. Your credentials stay with you: they come from your environment on each call, and a connector never stores or logs them.

## Connectors

Each connector links to its own page: what it does, every credential step by step (where to get it and how to revoke it), its tools and its limits.

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| [`adapty`](./src/vendors/adapty/README.md) | [Adapty](https://adapty.io) subscription analytics for one app: revenue, MRR, ARR, subscriptions, trials, refunds, conversion, funnel, retention, LTV and install cohorts, with filters, groupings and comparison periods. Aggregate numbers only, read-only | Adapty secret API key | Available |
| [`adjust`](./src/vendors/adjust/README.md) | [Adjust](https://www.adjust.com) attribution reports: creative, campaign and network ROAS, installs, cost, cohort revenue and SKAdNetwork, with the metric catalogue and events. Read-only | Adjust API token | Available |
| [`apollo`](./src/vendors/apollo/README.md) | [Apollo](https://www.apollo.io) prospecting: people and company search, enrichment (credits), contacts and accounts, sequences and outreach emails, deals, tasks and calls | Apollo API key and/or master API key | Available |
| [`apple-appstore`](./src/vendors/apple-appstore/README.md) | [App Store Connect](https://appstoreconnect.apple.com): read and answer customer reviews, create and localize in-app events and send them to App Review (their images are added in App Store Connect where the host refuses uploads to Apple), read app details, live listing, subscriptions and in-app purchases with prices, and call the rest of the App Store Connect API | App Store Connect API key (key ID, issuer ID, .p8 private key) | Available |
| [`beehiiv`](./src/vendors/beehiiv/README.md) | [beehiiv](https://www.beehiiv.com) newsletters: posts with opens, clicks and web views and totals over posts, drafts and test emails, sending or scheduling, subscribers with tags and custom fields, segments and their members, automation enrollment, and the rest of the API | beehiiv API key | Available |
| [`blogger`](./src/vendors/blogger/README.md) | [Blogger](https://www.blogger.com) blogs: save posts and pages as drafts, publish or schedule them, edit titles, HTML bodies and labels, list draft, scheduled and live posts, search, count labels, and call the rest of the Blogger API | Google OAuth access token | Available |
| [`bluesky`](./src/vendors/bluesky/README.md) | [Bluesky](https://bsky.app): read profiles and posts, post text with clickable links, mentions and hashtags, up to 4 images or a link card, reply and thread, delete your posts, and call any other XRPC method | Handle and app password | Available |
| [`brevo`](./src/vendors/brevo/README.md) | [Brevo](https://www.brevo.com) email: contacts, folders and lists, email campaigns (draft, test, send, schedule) with statistics, templates, transactional email and its events, and the rest of the Brevo API | Brevo API key | Available |
| [`calendarific`](./src/vendors/calendarific/README.md) | Holidays and observances for 230+ countries from [Calendarific](https://calendarific.com): by year, month or day, the holidays coming up in the next days, by kind, region and language. Read-only | Calendarific API key | Available |
| [`devto`](./src/vendors/devto/README.md) | [dev.to](https://dev.to) articles: list your articles with their stats, read an article's Markdown, save drafts, publish and edit, analytics by date, and call the rest of the dev.to API | dev.to API key | Available |
| [`facebook-pages`](./src/vendors/facebook-pages/README.md) | [Facebook Pages](https://www.facebook.com): posts, photos, videos, Reels and stories, now or scheduled; comments as the Page; post and Page insights; and the rest of the Graph API as one of your Pages | Your own app's sign-in, or a system user token | Available |
| [`firebase`](./src/vendors/firebase/README.md) | [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging): push notifications to topics, topic conditions or one device, with images, data and Android and iOS options; validation without delivery; several projects with their apps and topics | Service account key per project | Available |
| [`ga4`](./src/vendors/ga4/README.md) | [Google Analytics 4](https://analytics.google.com): reports on any metrics and dimensions over up to four date ranges, realtime reports, several reports in one call, the dimensions and metrics a property offers, and property settings, key events, custom definitions, data streams and audiences through the Admin API | Google OAuth access token | Available |
| [`gmail`](./src/vendors/gmail/README.md) | A [Gmail](https://mail.google.com) mailbox: search and read mail and threads, mark read, label, archive and trash, save drafts, send mail and replies, and call the rest of the Gmail API | Google OAuth access token | Available |
| [`google-ads`](./src/vendors/google-ads/README.md) | [Google Ads](https://ads.google.com): Google Ads Query Language reports, grouped mutates of budgets, campaigns, ad groups, ads, keywords, audiences, assets and conversion actions with a dry run, image assets from a URL, Keyword Planner ideas, Customer Match uploads, and the rest of the API | Google OAuth access token | Available |
| [`google-business`](./src/vendors/google-business/README.md) | [Google Business Profile](https://business.google.com): list accounts and locations, read reviews, reply to them and follow the reply's moderation, delete a reply, and call the rest of the Business Profile APIs | Google OAuth access token | Available |
| [`google-calendar`](./src/vendors/google-calendar/README.md) | [Google Calendar](https://calendar.google.com): free slots inside opening hours from the calendar's busy times, list and read events, create, change and delete events (appointments), and call the rest of the Calendar API on the connected calendar | Service account key and calendar ID | Available |
| [`google-drive`](./src/vendors/google-drive/README.md) | [Google Drive](https://drive.google.com) with Sheets and Docs: list shared folders and files, read Docs, Sheets and text files as text, upload files from a URL or text (resumable above 5 MB), create Docs and Sheets, rename, move, trash and share files (download and export links for services that fetch by URL, with a warning when a link cannot work), find files shared with anyone, read, append, overwrite and clear sheet ranges, add text to a Doc, and call the rest of the Drive, Sheets and Docs APIs | Service account key | Available |
| [`google-merchant-center`](./src/vendors/google-merchant-center/README.md) | [Google Merchant Center](https://merchants.google.com): products with their status and issues, product writes through API data sources, data sources, account issues, Merchant Center Query Language reports (performance, price competitiveness, best sellers), and the rest of the Merchant API | Google OAuth access token | Available |
| [`google-play`](./src/vendors/google-play/README.md) | [Google Play](https://play.google.com/console): reviews from the last week and replies, store listings (the live one from the public store page, and changes through an edit), subscriptions with base plans, prices, offers and free trials, in-app and one-time products, and the rest of the Android Developer API for the chosen apps | Service account key | Available |
| [`google-search-console`](./src/vendors/google-search-console/README.md) | [Google Search Console](https://search.google.com/search-console): search analytics by query, page, country, device, date and more, period comparisons with the biggest losses and gains, sitemaps and URL inspection. Read-only | Google OAuth access token | Available |
| [`hashnode`](./src/vendors/hashnode/README.md) | [Hashnode](https://hashnode.com) blogs on Hashnode Pro: drafts first, publishing, edits to drafts and live posts, posts with views, reactions and comments, series, and any other GraphQL query or mutation | Personal access token and blog address | Available |
| [`hubspot`](./src/vendors/hubspot/README.md) | [HubSpot](https://www.hubspot.com) CRM: contacts, companies, deals, tickets, notes, tasks and other records (search, create, update, delete, associate), pipelines, owners, lists, marketing emails, transactional sends and files | HubSpot OAuth access token | Available |
| [`instagram`](./src/vendors/instagram/README.md) | [Instagram](https://www.instagram.com) professional accounts: images, carousels, Reels and stories through processed containers; post, story and account insights; comment moderation; the publishing limit; and the rest of the API | Instagram Login with your own app, or a system user token | Available |
| [`kaggle`](./src/vendors/kaggle/README.md) | [Kaggle](https://www.kaggle.com): your notebooks and datasets, notebooks pushed and run on CPU, GPU or TPU with their status, logs and output files, datasets and new versions, quota, competitions, leaderboards and submissions | Username and API token | Available |
| [`keepa`](./src/vendors/keepa/README.md) | Amazon price and sales rank history from [Keepa](https://keepa.com): prices now, averages, lows and highs, dated price and rank tables, product search, best sellers, categories and the product finder on 11 marketplaces. Read-only, with the tokens left after every call | Keepa API key | Available |
| [`linkedin`](./src/vendors/linkedin/README.md) | [LinkedIn](https://www.linkedin.com): publish text, image, multi-image and article posts as a company Page or as the member, list, read and delete posts, and call the rest of the REST API | OAuth access token | Available |
| [`mailchimp`](./src/vendors/mailchimp/README.md) | [Mailchimp](https://mailchimp.com) email marketing: audiences and members, campaigns (draft, content, checklist, test, send, schedule), templates, segments and tags, reports and automations | Mailchimp sign-in (access token and data center) or API key | Available |
| [`mastodon`](./src/vendors/mastodon/README.md) | [Mastodon](https://joinmastodon.org) on your own server: posts within its limits with visibility, content warnings, polls and media with alt text, replies and threads, scheduled posts, deletes, your posts with their numbers, and the rest of the Mastodon API | Server address and access token | Available |
| [`meta-ads`](./src/vendors/meta-ads/README.md) | [Meta Ads](https://www.facebook.com/business/ads): insights with breakdowns; campaigns, ad sets and ads created paused, turned on, re-budgeted or deleted; image, video and carousel creatives with uploads; audiences and targeting; and the rest of the Marketing API inside your chosen ad accounts | Your own app's sign-in, or a system user token | Available |
| [`notion`](./src/vendors/notion/README.md) | [Notion](https://www.notion.com) pages and databases: search, read pages as Markdown or blocks, query databases with filters, create pages and rows, add and edit content, update properties, move to the trash and restore, and the rest of the API | Notion API token | Available |
| [`pinterest`](./src/vendors/pinterest/README.md) | [Pinterest](https://www.pinterest.com) organic Pins: image and video Pins on boards and sections with title, description, link and alt text, boards and sections, Pin and account analytics, and the rest of the API v5 (no ads) | OAuth access token of your own Pinterest app | Available |
| [`qiita`](./src/vendors/qiita/README.md) | [Qiita](https://qiita.com) articles: saved as limited-share articles for review and made public when asked, updates and deletes, your articles with likes, stocks, comments and page views, tags, and a search of Qiita | Personal access token | Available |
| [`reddit`](./src/vendors/reddit/README.md) | [Reddit](https://www.reddit.com): the account and its communities, a community's rules, one text or link post or comment at a time, and edits and deletes of the account's own posts and comments, inside Reddit's rate window and with no duplicates | OAuth access token and developer profile username | Available |
| [`revenuecat`](./src/vendors/revenuecat/README.md) | [RevenueCat](https://www.revenuecat.com) subscription metrics: overview cards, revenue by date range, every chart with its filters and segments, and the project's apps, products, offerings and entitlements. Aggregate numbers only, read-only | RevenueCat V2 secret API key | Available |
| [`roasit`](./src/vendors/roasit/README.md) | [Roasit](https://roasit.com) attribution reports: creative, campaign and network ROAS, cohort revenue, retention, spend and installs, SKAdNetwork, install reconciliation and data freshness. Read-only | Roasit API token | Available |
| [`sendgrid`](./src/vendors/sendgrid/README.md) | [SendGrid](https://sendgrid.com) email: send with templates and attachments, Marketing Campaigns contacts, lists and Single Sends (draft, schedule, send, stats), dynamic templates, senders, statistics and suppressions | SendGrid API key | Available |
| [`serper`](./src/vendors/serper/README.md) | Google search results through [Serper](https://serper.dev): the web (answer box, knowledge graph, related questions), news, images, videos, places, maps and place reviews, shopping, scholar, patents, autocomplete and image matches | Serper API key | Available |
| [`shopify`](./src/vendors/shopify/README.md) | [Shopify](https://www.shopify.com) through the GraphQL Admin API: products, variants and images, publishing, collections, stock per location, orders and fulfillments, customers, discount codes, and any other query or mutation | Store address and Admin API access token | Available |
| [`threads`](./src/vendors/threads/README.md) | [Threads](https://www.threads.com): text, image, video and carousel posts with reply controls, quotes, link previews and topic tags; replies and reply moderation; deletes; post and profile insights; publishing limits; and the rest of the API | Your own Threads app's sign-in | Available |
| [`tiktok`](./src/vendors/tiktok/README.md) | [TikTok](https://www.tiktok.com): post videos (chunked upload, or pulled from a verified URL) and photo posts (from a verified URL), with the creator's privacy and interaction options checked first, follow each post's status, and read the creator's videos | OAuth access token | Available |
| [`tumblr`](./src/vendors/tumblr/README.md) | [Tumblr](https://www.tumblr.com) blogs: posts with text, images with alt text, links and tags as drafts first, publishing, the queue and scheduling, edits, published posts with note counts, drafts and the queue, deletes, and the rest of the API v2 | OAuth access token of your own Tumblr app | Available |
| [`twitter`](./src/vendors/twitter/README.md) | [X](https://x.com): publish posts with images, GIFs, video or polls, replies, quotes and threads, delete posts, and read the account and its posts | OAuth access token | Available |
| [`woocommerce`](./src/vendors/woocommerce/README.md) | [WooCommerce](https://woocommerce.com) on your own store: products and variations, prices, stock checked before it changes, orders, notes and refunds, coupons, customers, sales reports, categories and attributes, and the rest of the REST API v3 | Store URL and REST API key | Available |
| [`wordpress`](./src/vendors/wordpress/README.md) | [WordPress](https://wordpress.org) on your own site: draft, schedule and publish posts and pages with categories, tags and a featured image, upload media from a URL with alt text, create categories and tags, set Rank Math SEO fields, and call the rest of the REST API | Site URL, user name and application password | Available |
| [`youtube`](./src/vendors/youtube/README.md) | [YouTube](https://www.youtube.com) channels: upload videos and Shorts from a URL, publish or schedule them, edit their details and thumbnails, manage playlists, list and search videos, read Analytics reports, screen videos for ads, and call the rest of the YouTube APIs | Google OAuth access token | Available |

Missing a service? [Add your connector](#add-your-connector) or [ask for one](https://github.com/wiroai/Wiro-Agent-Connectors/issues/new?template=new_connector.yml).

## Quick start

Requires Node.js 22 or later. Start a connector by name; it reads its credentials from environment variables named `<VENDOR>_<CREDENTIAL>`:

```bash
DEVTO_APIKEY=your-key npx -y @wiro-ai/wiro-agent-connectors devto
```

`npx -y @wiro-ai/wiro-agent-connectors --list` prints every connector with its tools and variables, and, where a connector has them, the alternatives it accepts and its [account keys](#account-pickers-and-the-account-lock).

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `adapty` | `ADAPTY_APIKEY` | The app's secret key (`secret_live_...`): Adapty Dashboard → App settings → General → API keys. One key reads one app. |
| `adjust` | `ADJUST_USERAPITOKEN` | Adjust dashboard → settings icon (bottom left) → Account settings → My profile → API Token. One token covers every app of the account. |
| `apollo` | `APOLLO_APIKEY`, or `APOLLO_MASTERAPIKEY` (alternatives; with both, the master key is used) | Apollo → Settings → Integrations → API → Create new key: pick its endpoints, or set it as the master key (admins). |
| `apple-appstore` | `APPLE_APPSTORE_KEYID`, `APPLE_APPSTORE_ISSUERID`, `APPLE_APPSTORE_PRIVATEKEY` | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys: the key ID, the issuer ID above the keys, and the text of the key's `.p8` file (its base64 works too). |
| `beehiiv` | `BEEHIIV_APIKEY`, optional `BEEHIIV_PUBLICATIONID` | beehiiv → Settings → Workspace Settings → API → Create New API Key (workspace Owner or Admin); the default publication's ID is in the Publication ID section of the same page. |
| `blogger` | `BLOGGER_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/blogger`, from your own Google Cloud OAuth client ([step by step](./src/vendors/blogger/README.md)). |
| `bluesky` | `BLUESKY_HANDLE`, `BLUESKY_APPPASSWORD` | Your handle (such as `alice.bsky.social`) and an app password from Bluesky → Settings → Privacy and security → App passwords. Never your account password. Accounts hosted by Bluesky only. |
| `brevo` | `BREVO_APIKEY` | Brevo → your profile menu → SMTP & API → API Keys → Generate a new API key. |
| `calendarific` | `CALENDARIFIC_APIKEY` | The API key on your [Calendarific](https://calendarific.com) account dashboard (free plan available). |
| `devto` | `DEVTO_APIKEY` | dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key. |
| `facebook-pages` | `FACEBOOK_PAGES_ACCESS_TOKEN` (with `FACEBOOK_PAGES_APPSECRET_PROOF` when your app requires it), or `FACEBOOK_PAGES_SYSTEMUSERTOKEN`, or `FACEBOOK_PAGES_ACCESSTOKEN` (an older setup's Page tokens) | A user token from your own Meta app's sign-in, or a system user token from Meta Business Settings → Users → System users ([step by step](./src/vendors/facebook-pages/README.md)). |
| `firebase` | `FIREBASE_ACCOUNTS` | The service account key file of a Firebase project (Firebase console → Project settings → Service accounts), or a JSON list of projects with their keys, apps and topics ([step by step](./src/vendors/firebase/README.md)). |
| `ga4` | `GA4_ACCESS_TOKEN` | An OAuth access token with the scopes `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/analytics.edit`, from your own Google Cloud OAuth client ([step by step](./src/vendors/ga4/README.md)). |
| `gmail` | `GMAIL_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/gmail.modify`, from your own Google Cloud OAuth client ([step by step](./src/vendors/gmail/README.md)). |
| `google-ads` | `GOOGLE_ADS_ACCESS_TOKEN`, optional `GOOGLE_ADS_MANAGERCUSTOMERID` (`GOOGLE_ADS_DEVELOPERTOKEN` is accepted from older setups and never sent) | An OAuth access token with the scope `https://www.googleapis.com/auth/adwords`, from your own Google Cloud OAuth client in a project with Google Ads API access, and the manager account ID when you reach accounts through one ([step by step](./src/vendors/google-ads/README.md)). |
| `google-business` | `GOOGLE_BUSINESS_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/business.manage`, from your own Google Cloud OAuth client in a project Google approved for the Business Profile APIs ([step by step](./src/vendors/google-business/README.md)). |
| `google-calendar` | `GOOGLE_CALENDAR_SERVICEACCOUNTJSON`, `GOOGLE_CALENDAR_CALENDARID`; optional `GOOGLE_CALENDAR_TIMEZONE`, `GOOGLE_CALENDAR_SLOTDURATIONMINUTES` | A service account key (the JSON file, or its base64 text) from Google Cloud console, and the ID of a calendar shared with that service account ([step by step](./src/vendors/google-calendar/README.md)). |
| `google-drive` | `GOOGLE_DRIVE_SERVICEACCOUNTJSON` | A service account key (the JSON file, or its base64 text) from Google Cloud console; share each folder with the service account's email ([step by step](./src/vendors/google-drive/README.md)). |
| `google-merchant-center` | `GOOGLE_MERCHANT_CENTER_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/content`, from your own Google Cloud OAuth client whose project you register with your Merchant Center account once ([step by step](./src/vendors/google-merchant-center/README.md)). |
| `google-play` | `GOOGLE_PLAY_SERVICEACCOUNTJSON` | A service account key (the JSON file, or its base64 text) from Google Cloud console, invited in Play Console ([step by step](./src/vendors/google-play/README.md)). |
| `google-search-console` | `GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN` | An OAuth access token with the scope `https://www.googleapis.com/auth/webmasters.readonly`, from your own Google Cloud OAuth client ([step by step](./src/vendors/google-search-console/README.md)). |
| `hashnode` | `HASHNODE_TOKEN`, `HASHNODE_PUBLICATIONHOST` | Hashnode → Account Settings → Developer → Generate new token, and the blog's host, such as `yourname.hashnode.dev`. Hashnode's API answers only for blogs on Hashnode Pro. |
| `hubspot` | `HUBSPOT_ACCESS_TOKEN`, optionally `HUBSPOT_PORTALID` | An access token of your own HubSpot app, installed in the account by its OAuth sign-in (an existing private app's token works too). The portal ID is the account's Hub ID. |
| `instagram` | `INSTAGRAM_ACCESS_TOKEN` (with `INSTAGRAM_ACCOUNTID` and `INSTAGRAM_IGUSERNAME`), or `INSTAGRAM_SYSTEMUSERTOKEN` | An Instagram user token from Instagram Login with your own Meta app, or a system user token from Meta Business Settings → Users → System users whose Pages are linked to the accounts ([step by step](./src/vendors/instagram/README.md)). |
| `kaggle` | `KAGGLE_USERNAME`, `KAGGLE_APITOKEN` | Your username (the last part of your profile address) and a token from Kaggle → Settings → API → Generate New Token. |
| `keepa` | `KEEPA_APIKEY` | The 64-character private API access key on the [Keepa API page](https://keepa.com/api), on a paid Keepa API plan. |
| `linkedin` | `LINKEDIN_ACCESS_TOKEN`, optional `LINKEDIN_ORGANIZATIONID` (to post as a Page) and `LINKEDIN_LINKEDINNAME` | An OAuth access token from your own LinkedIn app ([step by step](./src/vendors/linkedin/README.md)), and the number in your Page's admin URL. |
| `mailchimp` | `MAILCHIMP_APIKEY`, or `MAILCHIMP_ACCESS_TOKEN` with `MAILCHIMP_SERVER` (alternatives) | An API key from Mailchimp → Profile → Extras → API keys → Create A Key (the whole key, with its last part such as `-us19`); or an access token from your own registered Mailchimp app with its data center (such as `us19`). |
| `mastodon` | `MASTODON_INSTANCEURL`, `MASTODON_TOKEN` | Your server's address (such as `https://mastodon.social`) and the access token of an application you create under Preferences → Development with the scopes `read:accounts`, `read:statuses`, `write:media`, `write:statuses`. |
| `meta-ads` | `META_ADS_ACCESS_TOKEN` (with `META_ADS_APPSECRET_PROOF` when your app requires it), or `META_ADS_SYSTEMUSERTOKEN`; optional `META_ADS_PAGEMAPPINGS` | A user token from your own Meta app's sign-in, or a system user token from Meta Business Settings → Users → System users with the ad accounts assigned ([step by step](./src/vendors/meta-ads/README.md)). |
| `notion` | `NOTION_TOKEN` | An internal connection's API token from Notion's Developer portal (Workspace Owners; then share pages with the connection), or a personal access token from notion.so/developers/tokens. |
| `pinterest` | `PINTEREST_ACCESS_TOKEN` | A current access token of your own Pinterest app (developers.pinterest.com → My apps), with the scopes `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read`. Creating Pins needs Standard access. |
| `qiita` | `QIITA_TOKEN` | qiita.com → Settings → Applications → Personal access tokens → Generate new token, with `read_qiita` and `write_qiita`. |
| `reddit` | `REDDIT_ACCESS_TOKEN`, `REDDIT_DEVELOPERPROFILEUSERNAME`, optional `REDDIT_REDDITUSERNAME` | An OAuth access token from your own Reddit web app, and the username of the account that owns the app ([step by step](./src/vendors/reddit/README.md)). |
| `revenuecat` | `REVENUECAT_APIKEY` | RevenueCat → Project settings → API keys → + New secret API key, version V2, read-only for Charts & Metrics and Project configuration. |
| `roasit` | `ROASIT_APITOKEN` | Roasit → Account → API tokens → name it → Create; the `roapi_...` token is shown once. |
| `sendgrid` | `SENDGRID_APIKEY` | SendGrid → Settings → API Keys → Create API Key (Full Access, or Restricted Access with the permissions the tools need). |
| `serper` | `SERPER_APIKEY` | The API key on your [serper.dev](https://serper.dev) dashboard. |
| `shopify` | `SHOPIFY_SHOPDOMAIN`, `SHOPIFY_ACCESS_TOKEN` | The store's `<shop>.myshopify.com` address, and an Admin API access token of your own app installed on it (OAuth, or client credentials for a store in the app's organization). |
| `threads` | `THREADS_ACCESS_TOKEN` (optional `THREADS_THREADSUSERID`, `THREADS_THREADSUSERNAME`) | A Threads user token from your own Meta app with the Access the Threads API use case ([step by step](./src/vendors/threads/README.md)). |
| `tiktok` | `TIKTOK_ACCESS_TOKEN`, optional `TIKTOK_TIKTOKUSERNAME` and `TIKTOK_OPENID` | A user access token from your own TikTok app with `video.publish` ([step by step](./src/vendors/tiktok/README.md)). |
| `tumblr` | `TUMBLR_ACCESS_TOKEN` | A current OAuth 2 access token of your own Tumblr app (tumblr.com/oauth/apps), with the scopes `basic`, `write` and `offline_access`. |
| `twitter` | `TWITTER_ACCESS_TOKEN`, optional `TWITTER_XUSERNAME` | An OAuth 2.0 user access token from your own X app, with `media.write` for media ([step by step](./src/vendors/twitter/README.md)). |
| `woocommerce` | `WOOCOMMERCE_STOREURL`, `WOOCOMMERCE_CONSUMERKEY`, `WOOCOMMERCE_CONSUMERSECRET` | The store's WordPress address (with its subdirectory, if any), and a REST API key from WooCommerce → Settings → Advanced → REST API (Read, or Read/Write for changes). |
| `wordpress` | `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APPPASSWORD` | The site's address (with its subdirectory, if any), the connector user's login name, and an application password from Users → Profile → Application Passwords. |
| `youtube` | `YOUTUBE_ACCESS_TOKEN` | An OAuth access token with the scopes `https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/yt-analytics.readonly`, from your own Google Cloud OAuth client ([step by step](./src/vendors/youtube/README.md)). |

A connector without its variables (or, for one that accepts [alternatives](#required-credentials), without one complete set of them) still starts and lists its tools; each call then answers with the variables to set. A connector whose service signs in with OAuth reads a current access token from `<VENDOR>_ACCESS_TOKEN`: get one from your own OAuth app, as the CLI does not refresh it. To limit a connector whose tools act on one of several accounts (Pages, ad accounts, channels) to the ones you choose, set `CONNECTOR_ACCOUNTS`, keyed by the account keys its [Tools](#tools) section names.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "devto": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@wiro-ai/wiro-agent-connectors", "devto"],
      "env": {
        "DEVTO_APIKEY": "your-dev-to-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio bluesky \
  --env BLUESKY_HANDLE=alice.bsky.social \
  --env BLUESKY_APPPASSWORD=xxxx-xxxx-xxxx-xxxx \
  -- npx -y @wiro-ai/wiro-agent-connectors bluesky
```

### Cursor

Add to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "serper": {
      "command": "npx",
      "args": ["-y", "@wiro-ai/wiro-agent-connectors", "serper"],
      "env": {
        "SERPER_APIKEY": "your-serper-api-key"
      }
    }
  }
}
```

Run several connectors side by side by adding one entry per connector.

## Tools

Every tool carries honest MCP annotations, derived from what it does: a read tool can only send GET requests (or a request that changes nothing, such as a sign-in or a search sent by POST), and each write tool says whether it adds, overwrites or removes. `api_request`, which can do any of these, claims neither read-only nor idempotent.

### adapty

[Credentials, setup and limits](./src/vendors/adapty/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_chart` | read | One analytics chart (default `revenue`): each metric's total for the period, its points by period or group, comparison values, unit and Adapty's definition. Long point lists come in pages. |
| `get_conversion` | read | A conversion rate between two subscription periods, such as paid to more than 6 months (`1` → `6+`). |
| `get_funnel` | read | Install → paywall → trial → paid, with the users who reached and left each stage. |
| `get_retention` | read | Subscriber retention period by period, from the first paid period or the trial. |
| `get_ltv` | read | Realized LTV on revenue, proceeds and net revenue, with cohort sizes. |
| `get_cohorts` | read | Install cohorts: installs, subscribers, revenue, proceeds and net revenue in USD per period, with predictions. |

### adjust

[Credentials, setup and limits](./src/vendors/adjust/README.md). Account key: `apps` (Adjust apps, listed by `list_apps`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_apps` | read | The account's apps: app token (12 characters) and name, with `selected: true` on the apps chosen for the connection. Lists the candidates of the `apps` account picker. |
| `get_report` | read | A report by dimensions and metrics over a date period, with app tokens, filters (`<field>__<operator>`), ad spend mode, attribution source and types, cohort maturity, currency, time zone and sort; rows, totals and warnings, in pages. |
| `get_filter_values` | read | The values a report may use: metric catalogues (overview, cohort, event, cost, SKAdNetwork), dimensions, networks, partners, countries and more, with search. |
| `list_events` | read | The apps' events by slug, for per-event metrics, and whether each is a SKAdNetwork event. |
| `api_get` | read | Any other GET of the Report Service API under `/reports-service/`, such as the pivot or CSV report. |

### apollo

[Credentials, setup and limits](./src/vendors/apollo/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The key's user and team, and the user's credits: allowance and use per kind, lead credits left. Connection check. |
| `get_usage` | read | API calls and rate limits left per endpoint, or credits used. |
| `search_people` | read | Prospects by title, seniority, location, company and keywords (free; no emails or phones). |
| `enrich_people` | read | Full profiles of 1 to 10 people with work email (credits); phones later, by request id while Apollo's lookup is pending. |
| `get_enrichment_result` | read | The phones of an earlier enrichment, by its request id (a signed number, passed exactly as given). |
| `enrich_organizations` | read | Profiles of 1 to 10 companies by domain (credits). |
| `search_organizations` | read | Companies by name, domain, size, location, keywords, technologies, funding (credits per page). |
| `list_job_postings` | read | A company's open jobs (credits per page). |
| `search_news` | read | News about companies (credits per page). |
| `create_contacts` | create | Saves 1 to 100 contacts, without deduplication. |
| `upsert_contacts` | update | Saves 1 to 100 contacts without duplicates: one contact updates its match in place; in bulk, matches come back unchanged for `update_contact`. |
| `update_contact` | update | Changes a contact. |
| `search_contacts` | read | Your contacts by keywords, stages or lists. |
| `get_contact` | read | One contact. |
| `create_accounts` | create | Saves 1 to 100 companies as accounts. |
| `update_account` | update | Changes an account. |
| `search_accounts` | read | Your accounts by name, stages or lists. |
| `get_account` | read | One account. |
| `search_sequences` | read | Sequences with their activity and rates. |
| `add_contacts_to_sequence` | create | Adds contacts (or lists) to a sequence, sending from an email account. |
| `update_sequence_contacts` | update | Stops, finishes or removes contacts in sequences. |
| `set_sequence_active` | update | Activates or deactivates a sequence. |
| `search_outreach_emails` | read | Sequence emails by sequence, status, reply class (replies), user, or a range of due or sent dates. |
| `get_outreach_email_activities` | read | One outreach email's deliveries, opens, clicks and reply. |
| `create_deal` | create | A deal with amount, stage, owner, account and close date. |
| `search_deals` | read | Deals by name, account, owner, stage, open or closed. |
| `update_deal` | update | Changes a deal's stage, amount, close date. |
| `get_deal` | read | One deal. |
| `create_tasks` | create | A task for a user about 1 to 100 contacts. |
| `search_tasks` | read | Tasks by due date or priority. |
| `log_call` | create | Logs a call made outside Apollo. |
| `search_calls` | read | Calls by date, direction, user or keywords. |
| `list_team_data` | read | Users, email accounts, contact, account and deal stages, lists and custom fields, with their ids. |
| `api_get` | read | Any other GET under `/api/v1/`, such as `/api/v1/notes`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/api/v1/`, such as completing a task. Sent once, never retried. |

### apple-appstore

[Credentials, setup and limits](./src/vendors/apple-appstore/README.md). Account key: `apps` (App Store apps, listed by `list_apps`).

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
| `upload_app_event_image` | create | Adds the event card (16:9, 1920x1080 to 3840x2160) or event details page image (9:16, 1080x1920 to 2160x3840) from a public https URL: checks the JPEG or PNG first, reserves it, uploads it to the address App Store Connect gives, commits it and waits for processing. A host that lets a connector send only downloads outside its API refuses that upload; the reservation is then removed again, and the images are added in App Store Connect. See [its limits](./src/vendors/apple-appstore/README.md#limits). |
| `delete_app_event_image` | delete | Deletes one event image, to replace it or after a failed processing. |
| `submit_app_event_for_review` | create | Sends an event to App Review: reuses the app's open review submission when it holds nothing else, else starts one, adds the event and sends it. A submission that holds other items (an app version, another event) is left alone. Sent once, never retried. |
| `api_get` | read | Any other GET of the App Store Connect API (`/v1/`, `/v2/`, `/v3/`), signed with the key. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the App Store Connect API. Sent once, never retried. |

### beehiiv

[Credentials, setup and limits](./src/vendors/beehiiv/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_publications` | read | The publications the key reaches, with active subscriptions, beehiiv's average open and click rates and emails sent. |
| `get_publication` | read | One publication's numbers. |
| `list_posts` | read | Posts (sent or scheduled by default, or drafts, archived, all) with email numbers, unique opens and clicks as a share of delivered emails, and web views. |
| `list_drafts` | read | Draft posts, newest created first: where a draft `create_draft_post` saved shows up. |
| `get_post` | read | One post with its numbers, its ten best links, and one version of its body (free or premium, web, email or RSS) in windows with a cursor. |
| `get_posts_aggregate_stats` | read | Email and web totals over all posts that match the filters. |
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

### blogger

[Credentials, setup and limits](./src/vendors/blogger/README.md). Account key: `blogs` (Blogger blogs, listed by `list_blogs`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_blogs` | read | The blogs the account owns or writes for: id, name, URL and the number of posts and pages. The `blogs` picker. |
| `list_posts` | read | Draft, scheduled and live posts, newest first, with status, labels, times, URL, editor link and comment count. Filters for labels and a time range. |
| `get_post` | read | One post with its HTML body; a long body comes in parts (`content_offset`). |
| `search_posts` | read | Live posts that match some words, newest first (by published time, or by last update). |
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

### bluesky

[Credentials, setup and limits](./src/vendors/bluesky/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | A profile with its counts; the connected account by default. |
| `list_my_posts` | read | Your recent posts and replies with likes, reposts, replies, quotes and views; or posts without replies, with your own threads, or with media only. |
| `get_posts` | read | Up to 25 posts, yours or anyone's, by their bsky.app links or at:// URIs, with their numbers; posts that are gone are listed as not found. |
| `create_post` | create | Posts right away: up to 300 characters with links, mentions and hashtags made clickable, up to 4 JPEG, PNG or WebP images from public https URLs with alt text, or a link card whose title, text and picture come from the page. `reply_to` makes it a reply or the next post of a thread. |
| `delete_post` | delete | Deletes one of your own posts by link or at:// URI; other accounts' posts are refused before anything is sent. |
| `api_get` | read | Any XRPC query (GET) with your session, such as `app.bsky.feed.getTimeline`, `app.bsky.feed.getPostThread` or `app.bsky.notification.listNotifications`. |
| `api_request` | write | Any XRPC procedure (POST with a JSON body), such as `com.atproto.repo.createRecord` for a like. Sent once, never retried. Account, session and identity methods are left out. |

### brevo

[Credentials, setup and limits](./src/vendors/brevo/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account: email, company, plan and remaining credits. Connection check. |
| `list_senders` | read | Senders with their ids and whether they are verified (active). |
| `list_contacts` | read | Contacts with attributes, lists and blocklist flags; filter by lists, segment, dates or an attribute. |
| `get_contact` | read | One contact by email, id, own id or phone, with campaign event counts (or the events). |
| `upsert_contact` | update | Creates a contact or updates the one with that email: attributes, lists, blocklist flags. |
| `update_contact` | update | Changes a contact's attributes, adds it to or removes it from lists, blocks or unblocks it. |
| `delete_contact` | delete | Deletes a contact for good. |
| `list_folders` | read | Contact folders with subscriber counts. |
| `create_folder` | create | A folder for lists. |
| `list_lists` | read | Lists with folder and subscriber counts, all or one folder's. |
| `create_list` | create | A list in a folder. |
| `list_list_contacts` | read | The contacts of a list. |
| `add_contacts_to_list` | update | Adds up to 150 contacts to a list, by email or id. |
| `remove_contacts_from_list` | delete | Removes up to 150 contacts from a list; the contacts stay. |
| `list_email_campaigns` | read | Campaigns with status, schedule and optionally their statistics. |
| `get_email_campaign` | read | One campaign with global, per-list and per-link statistics, optionally its HTML. |
| `create_email_campaign` | create | A draft campaign (or a scheduled one with `scheduled_at`) to lists or segments. |
| `update_email_campaign` | update | Changes a draft or scheduled campaign, or its schedule. |
| `send_test_email` | create | Sends a test of a campaign to given addresses or the test list. |
| `send_campaign_now` | create | Sends a campaign to all its recipients now. |
| `delete_email_campaign` | delete | Deletes a campaign that is not being sent. |
| `list_templates` | read | Email templates. |
| `get_template` | read | One template with its HTML. |
| `create_template` | create | A template for campaigns and transactional email. |
| `update_template` | update | Changes a template. |
| `send_transactional_email` | create | One email to up to 50 recipients, with HTML or text or a template with params, cc, bcc, reply-to, attachments by URL, optionally scheduled. |
| `get_transactional_stats` | read | Transactional totals for a period: delivered, opens, clicks, bounces, spam, unsubscribes. |
| `list_transactional_events` | read | Transactional events by recipient, event, message id, template or tag; shows whether an email went out. |
| `api_get` | read | Any other GET under `/v3/`, such as `/v3/contacts/attributes`, `/v3/contacts/segments` or `/v3/smsCampaigns`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/v3/`, such as creating or sending an SMS campaign or changing a campaign's status. Sent once, never retried. Changes to organization users and sub-accounts are left out (reading them works). |

### calendarific

[Credentials, setup and limits](./src/vendors/calendarific/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_holidays` | read | A country's holidays and observances in a year, a month or on a day: name, date, description, kinds, where it applies (the whole country or its states) and its Calendarific page. Filters for kind (national, local, religious, observance), region (ISO 3166-2, such as `us-ny`) and language. |
| `list_upcoming_holidays` | read | The holidays of a country in a window of up to 366 days from a date (today by default), by date, with the same filters: for planning around the next weeks. One or two requests. |
| `list_countries` | read | Every country covered, with its ISO 3166-1 code, number of holidays and number of languages. |
| `list_languages` | read | The languages names and descriptions can be translated into (paid plans), with code, English and native name. |

### devto

[Credentials, setup and limits](./src/vendors/devto/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_my_articles` | read | Your drafts and published articles, newest first, with URLs, edit links, tags, page views, reactions and comments. |
| `get_article` | read | One article with its Markdown body (one of your drafts, or a published article by id), to read or edit it; a long body comes in parts. |
| `create_draft_article` | create | Saves an unpublished draft: title, Markdown body, up to 4 tags, cover image, canonical URL, series, organization, and the AI disclosure dev.to asks for. Nothing becomes public. |
| `update_article` | update | Publishes a draft, turns an article back into a draft, or changes its fields. Only the fields given change. |
| `get_analytics` | read | Page views, reactions, comments, new followers and average read time per day over a range, with totals; or lifetime totals. For one article or an organization too. |
| `api_get` | read | Any other GET of the dev.to API under `/api/`: followers, comments, reading list, an organization's id and more. |
| `api_request` | write | A POST, PUT or DELETE to the dev.to API under `/api/`. Sent once, never retried. |

### facebook-pages

[Credentials, setup and limits](./src/vendors/facebook-pages/README.md). Account key: `pages` (Facebook Pages, listed by `list_pages`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_pages` | read | The Pages this connection can use, with each Page's tasks; the account picker's tool. |
| `list_posts` | read | A Page's published posts, scheduled posts, live stories or Reels, newest first, with links. |
| `create_post` | create | A text post, optionally with a link preview, now or scheduled. |
| `post_photos` | create | One photo, or a post of 2 to 10 photos, from public https URLs, with a caption, now or scheduled. |
| `post_video` | create | A video from a public https URL, with a description and title, now or scheduled. |
| `post_reel` | create | A Reel from a public https URL of a vertical MP4: Facebook fetches the file, then it is published. |
| `post_story` | create | A Page story from an image or a vertical video URL. |
| `list_comments` | read | The comments on a post, photo or video, or the replies to a comment. |
| `add_comment` | create | A comment as the Page, or a reply, with an optional image, GIF or link sample. |
| `get_post_insights` | read | Views, unique viewers, reactions, comments and shares, and clicks of chosen or recent posts. |
| `get_page_insights` | read | Page views, engagements, follows, unfollows, follower change and 28-day unique viewers over a range of days. |
| `api_get` | read | Any other Graph API GET under `/v26.0/`, as one of the chosen Pages. |
| `api_request` | write | A POST or DELETE under `/v26.0/` as one of the chosen Pages, such as hiding or deleting a comment or deleting a post. Sent once, never retried. |

### firebase

[Credentials, setup and limits](./src/vendors/firebase/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_projects` | read | The connected projects from the settings, without calling Firebase: project id, app name, service account, apps and topics with their audiences. |
| `check_projects` | read | Signs in to every project and has Firebase validate a test message without delivering it; names the first project that fails and why. |
| `validate_message` | read | Has Firebase check a message (the same arguments as `send_message`) without delivering it, and shows it as it would be sent. |
| `send_message` | create | Sends a push to a topic, a condition of up to 5 topics, or one device token: title, text, image, data, Android channel, click action, sound, iOS badge, priority, time to live, collapse key, analytics label, and raw Android, iOS and web options. Returns the message id. |

### ga4

[Credentials, setup and limits](./src/vendors/ga4/README.md). Account key: `properties` (Google Analytics properties, listed by `list_properties`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_properties` | read | The GA4 properties the connected Google account can open, with their account; the ones chosen for the connection are marked `selected: true`. The `properties` picker's list. |
| `run_report` | read | A report on one property: metrics by dimensions over up to 4 date ranges (YYYY-MM-DD, today, yesterday, NdaysAgo), with filters, ordering, totals and paging. Rows come back keyed by dimension and metric names. Sent by POST, changes nothing. |
| `run_realtime_report` | read | A realtime report of the last 30 minutes, e.g. active users by country, with optional minute ranges. |
| `batch_run_reports` | read | Up to 5 reports on one property in one call, each in the API's own RunReportRequest JSON. |
| `get_metadata` | read | The dimensions and metrics the property can report on, custom ones included, filtered by kind or text. |
| `check_compatibility` | read | Whether dimensions and metrics can go in one report, or every field that can or cannot join them. |
| `api_get` | read | Any other GET of the Admin API (`origin: "https://analyticsadmin.googleapis.com"`): property settings, `keyEvents`, `customDimensions`, `customMetrics`, `dataStreams`, `googleAdsLinks`, and `audiences` on `/v1alpha/`; or of the Data API (the default origin). |
| `api_request` | write | A POST, PATCH or DELETE with a JSON body to the same APIs, such as marking an event as a key event (`POST /v1beta/properties/{id}/keyEvents`) or adding a custom dimension. Sent once, never retried. Deleting a whole property or account and changing user access are left out. |

### gmail

[Credentials, setup and limits](./src/vendors/gmail/README.md).

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

### google-ads

[Credentials, setup and limits](./src/vendors/google-ads/README.md). Account key: `customers` (Google Ads accounts, listed by `list_customers`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_customers` | read | The Google Ads accounts the Google account can open, with client accounts of managers, status, currency, time zone and login ID; the chosen ones are marked `selected: true`. The `customers` picker's list. |
| `search` | read | A GAQL query on one account. Rows come back flat, named like the query's fields (`metrics.cost_micros`); money is in micros. Sent by POST, changes nothing. |
| `mutate` | write | Creates, updates or removes resources in one atomic request (GoogleAdsService.Mutate), with optional partial failure and `validate_only`. Sent once, never retried. |
| `upload_image_asset` | create | Downloads a JPEG, PNG or GIF from a public https URL (up to 5,120 KB) and creates an image asset. |
| `generate_keyword_ideas` | read | Keyword Planner ideas from keywords, a URL, both, or a site, with average monthly searches, competition and top-of-page bids. |
| `upload_customer_match` | write | Adds people to or removes them from a Customer Match list by email or phone: normalized and hashed with SHA-256 in the connector, then an offline user data job is created, filled and run. |
| `hash_user_identifiers` | read | Normalizes and hashes emails and phone numbers the way Google Ads requires, for enhanced conversions sent with `api_request`. Sends nothing. |
| `api_get` | read | Any GET of the API under `/v26/`, such as field metadata. |
| `api_request` | write | Any POST with a JSON body under `/v26/customers/{customer_id}`, such as `recommendations:apply`, `recommendations:dismiss`, `:uploadClickConversions`, `:uploadConversionAdjustments` or `offlineUserDataJobs:create`. Sent once, never retried; check with `search`. Changing user access and manager links is left out. |

### google-business

[Credentials, setup and limits](./src/vendors/google-business/README.md). Account keys: `accounts` (Business Profile accounts, listed by `list_accounts`), `locations` (Business locations, listed by `list_locations`).

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

### google-calendar

[Credentials, setup and limits](./src/vendors/google-calendar/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_calendar` | read | The connected calendar: name, description and time zone, with the connection's time zone and slot length. A quick check that the key works and the calendar is shared. |
| `find_free_slots` | read | Free slots of a given length (default: the connection's slot length) inside opening hours (default Monday to Friday 09:00 to 18:00), from the calendar's busy times, with buffers, minimum notice and the busy blocks. Up to 62 days per call, with a cursor. |
| `list_events` | read | Events from a time on, in start order, repeating events expanded, filtered by text or change time, with a cursor. |
| `get_event` | read | One event with its guests, reminders, status and link. |
| `create_event` | create | Books an event: title, start and end (or a duration), description, location, reminders, repeat rules, color, visibility and private tags. It picks the event's id itself, so an unclear outcome can be checked with `get_event`. Guests are not taken (see [its limits](./src/vendors/google-calendar/README.md#limits)). |
| `update_event` | update | Changes the fields given: times, title, description, location, reminders, status (cancelled cancels it). Guests added in Google Calendar stay. |
| `delete_event` | delete | Deletes an event (a whole series for a repeating event); an event already deleted counts as deleted. |
| `api_get` | read | Any other GET of the Calendar API under `/calendar/v3/`, such as event instances, the calendar's sharing (`acl`) or colors. Calendar paths must name the connected calendar; the service account's calendar list is reachable for that calendar's entry only. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/calendar/v3/`, such as `events/quickAdd` or sharing changes, on the connected calendar only: creating calendars, moving events to another calendar and free/busy queries of other calendars are left out. Sent once, never retried. |

### google-drive

[Credentials, setup and limits](./src/vendors/google-drive/README.md). Account key: `folders` (Google Drive folders, listed by `list_folders`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_folders` | read | The chosen folders, or every folder the service account can reach (labeled with its parent folder's name) and its shared drives, or the subfolders of a folder; the `folders` picker's list. |
| `list_files` | read | The files in a folder, newest change first (full-text matches by relevance), filtered by name, full text, type (such as `image/*`), change time, or whether anyone with the link can open them (`shared_with_anyone`, to find links left open), with a cursor. |
| `get_file` | read | A file's details, links (`webViewLink`, `webContentLink`), export formats and sharing. |
| `read_file` | read | A file's text in pages: a Google Doc as Markdown, text or HTML, a Sheet's first sheet as CSV or TSV, Slides as text, and text files up to 4 MB. A binary file returns its details and links instead, with a `warning` when it is too large to download by link (see [Handing a file to another service](./src/vendors/google-drive/README.md#handing-a-file-to-another-service)). |
| `upload_file` | create | Uploads a file from a public https URL (up to 50 MB) or from text, typed from its bytes; `convert_to` makes it a Google Doc, Sheet or Slides file. Over 5 MB it uses a resumable upload. A local file has to be at a public https URL first. |
| `create_document` | create | A new Google Doc, empty or from Markdown, plain text or HTML, in one request. |
| `create_spreadsheet` | create | A new Google Sheet, empty or from rows or CSV, in one request. |
| `update_file` | update | Renames a file, changes its description or star, moves it to another folder, or trashes and restores it. |
| `replace_file_content` | update | Replaces a file's content (from a URL or text) and keeps its id and links. |
| `share_file` | create | Shares a file or folder with a person, a group, a domain or anyone with the link, as reader, commenter or writer. Shared with anyone, the result carries `downloadUrl` (the file itself) or, for a Google Doc, Sheet or Slides file, `exportUrls` by format (`pdf`, `docx`, `xlsx`, `pptx` and more), for a service that downloads files by URL, and a `warning` when a service could not fetch it (downloads off for viewers, or a file over 100 MB). A sharing that a sharing setting forbids is refused with what to do. |
| `unshare_file` | delete | Removes one sharing by its permission id; `anyoneWithLink` takes back a link shared with anyone, in the same run that shared it. |
| `get_spreadsheet` | read | A Google Sheet's title, locale, time zone and sheets (tabs) with their sizes. |
| `read_sheet` | read | The cells of an A1 range, as shown, raw or as formulas, with a cursor for long ranges. |
| `append_rows` | create | Adds rows after a sheet's table. |
| `update_range` | update | Overwrites the cells of a range. |
| `clear_range` | delete | Clears the values of a range. |
| `add_document_text` | create | Inserts text at the end or the start of a Google Doc. |
| `api_get` | read | Any other GET of the Drive API (`/drive/v3/` on `https://www.googleapis.com`), the Sheets API (`/v4/spreadsheets` on `https://sheets.googleapis.com`) or the Docs API (`/v1/documents` on `https://docs.googleapis.com`), within the chosen folders. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the same APIs, such as Sheets or Docs `batchUpdate`, a permission change or a comment, within the chosen folders. Sent once, never retried. |

### google-merchant-center

[Credentials, setup and limits](./src/vendors/google-merchant-center/README.md). Account key: `accounts` (Merchant Center accounts, listed by `list_accounts`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_accounts` | read | The Merchant Center accounts the Google account can open; the chosen ones are marked `selected: true`. The `accounts` picker's list. |
| `list_products` | read | Processed products of an account: offer ID, language, feed label, title, link, price, availability, brand, status per destination and item issues. |
| `get_product` | read | One product by offer ID, language and feed label, with every attribute and each issue's detail and help link. |
| `insert_product` | update | Inserts a product input into an API data source, or replaces the input with the same offer ID, language and feed label there. |
| `update_product` | update | Changes some attributes of a product input (and clears the ones named in `remove_attributes`), with an update mask so nothing else changes. |
| `delete_product` | delete | Deletes a product input from an API data source. |
| `list_data_sources` | read | The account's data sources with their input type (API, file, UI, autofeed), kind, feed label and language. |
| `create_data_source` | create | A primary product data source of input type API, for `insert_product`. |
| `list_account_issues` | read | Account-level issues with severity, affected destinations and regions, and help links. |
| `summarize_product_statuses` | read | Active, pending, disapproved and expiring counts per destination and country, with each issue and how many products it affects. |
| `search_reports` | read | A Merchant Center Query Language report, rows returned flat with snake_case fields. Sent by POST, changes nothing. |
| `api_get` | read | Any other GET of the Merchant API, such as `/accounts/v1/accounts/{id}/shippingSettings` or `/promotions/v1/accounts/{id}/promotions`. |
| `api_request` | write | A POST, PATCH or DELETE with a JSON body to the Merchant API, such as `homepage:claim`, `shippingSettings:insert` or `promotions:insert`. Sent once, never retried. Left out: deleting a whole account, managing its users, proposing, approving or rejecting its services (a service can hand another account control of it), and registering or unregistering the Cloud project. |

### google-play

[Credentials, setup and limits](./src/vendors/google-play/README.md). Account key: `apps` (Google Play apps, listed by `list_apps`).

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

### google-search-console

[Credentials, setup and limits](./src/vendors/google-search-console/README.md). Account key: `sites` (Search Console properties, listed by `list_sites`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_sites` | read | The properties the Google account has verified access to, with their permission level; the chosen ones are marked `selected: true`. The `sites` picker's list. |
| `query_search_analytics` | read | Clicks, impressions, CTR and position grouped by up to six dimensions, with filters, search type (web, image, video, news, discover, googleNews), fresh or final data, and paging. Dates or `last_days`, which ends on the latest day with data. Sent by POST, changes nothing. |
| `compare_periods` | read | Two periods of the same length side by side: totals with the change, and with a dimension the top losers and gainers by clicks or impressions. |
| `list_sitemaps` | read | The submitted sitemaps, or those inside a sitemap index, with errors, warnings, pending state and whether Google downloaded them since the last submission. |
| `inspect_url` | read | How Google indexed one URL: verdict, coverage, robots.txt, fetch state, canonicals, last crawl, rich results and a link to the report. |
| `api_get` | read | Any other GET of the API under `/webmasters/v3/`, such as one property or one sitemap, with the ids percent-encoded. |

### hashnode

[Credentials, setup and limits](./src/vendors/hashnode/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_blog` | read | The blog at the saved address: its ID, title, URL and whether it is a team blog; also tells whether it is on Pro. |
| `list_my_blogs` | read | The token's account and the blogs it owns, to find the right address. |
| `list_posts` | read | The blog's published posts, newest first, with views, reactions, comments and replies. |
| `list_drafts` | read | Your drafts on the blog, with their editor links. |
| `get_draft` | read | One draft with its Markdown (in windows with a cursor), tags, cover, series and SEO fields. |
| `get_post` | read | One published post by its slug or ID, with stats and its Markdown. |
| `list_series` | read | The blog's series, for `series_id`. |
| `create_draft` | create | Saves a draft; nothing becomes public. Returns its editor link. |
| `update_draft` | update | Changes a draft's fields or body. |
| `publish_draft` | update | Publishes a draft: it becomes a live post and the draft is removed. |
| `publish_post` | create | Publishes a new post at once, with no draft. |
| `update_post` | update | Changes a live post at once. |
| `submit_draft_for_review` | update | Hands a contributor's draft to a team blog's editors. |
| `graphql_query` | read | Any other GraphQL query, such as a tag, a user, scheduled drafts or a post's comments. One query per call, with the fragments it uses. |
| `graphql_mutation` | write | Any other GraphQL mutation, such as rejecting a submitted draft. One mutation per call, sent once, never retried. Deleting posts and drafts is not offered. |

### hubspot

[Credentials, setup and limits](./src/vendors/hubspot/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account: portal ID, type, time zone, currencies, data hosting location. Connection check. |
| `list_objects` | read | Records of a type with chosen properties and associated record ids. |
| `get_object` | read | One record by id or by a unique property (a contact by email), with property history if asked. |
| `search_objects` | read | Records by filter groups, a text query and a sort, with the total. |
| `create_object` | create | A record with its properties and associations: contacts, companies, deals, and engagements such as notes and tasks. |
| `update_object` | update | Sets properties of a record (owner, lifecycle stage, deal stage...). |
| `delete_object` | delete | Deletes a record (HubSpot keeps it in its recycling bin for 90 days). |
| `list_properties` | read | Properties of a record type with labels, types and dropdown options. |
| `list_pipelines` | read | Deal, ticket or other pipelines with their stages. |
| `list_owners` | read | Users who can own records, with their owner ids. |
| `list_associations` | read | A record's associated records of one type, with association types and labels. |
| `create_associations` | create | Associates up to 100 pairs of records, with the default type or a label. |
| `remove_associations` | delete | Removes associations between up to 100 pairs, all or one label. |
| `search_lists` | read | Lists (segments) by name, with their processing type and size. |
| `list_list_members` | read | The members of a list, optionally with their properties. |
| `add_to_list` | update | Adds up to 1,000 records to a manual or snapshot list. |
| `remove_from_list` | delete | Removes up to 1,000 records from a list. |
| `list_marketing_emails` | read | Marketing emails with state and, if asked, statistics. |
| `get_marketing_email` | read | One marketing email with its lists, statistics and, if asked, content. |
| `create_marketing_email` | create | A draft marketing email. |
| `update_marketing_email` | update | Changes a marketing email. |
| `publish_marketing_email` | create | Sends or schedules a marketing email (Marketing Hub Enterprise or the transactional email add-on). |
| `send_single_email` | create | Sends a published transactional or marketing email to one address, at most once per `send_id`. |
| `get_send_status` | read | The status and result of a single send. |
| `list_files` | read | Files in the file manager. |
| `upload_file` | create | Uploads a file from a public https URL to a folder. |
| `api_get` | read | Any other GET of the HubSpot API, such as association labels or a draft. |
| `api_request` | write | Any POST, PUT, PATCH or DELETE of the HubSpot API, such as merging two contacts. Sent once, never retried. OAuth endpoints are left out. |

### instagram

[Credentials, setup and limits](./src/vendors/instagram/README.md). Account key: `accounts` (Instagram accounts, listed by `list_accounts`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_accounts` | read | The accounts this connection can use, with their linked Page; the account picker's tool. |
| `get_account` | read | An account's profile with its follower, following and post counts. |
| `list_media` | read | An account's posts and Reels, newest first, or its live stories (for an account reached through its Facebook Page). |
| `publish_image` | create | One JPEG image as a feed post, with caption, alt text, people tags, place and collaborators. |
| `publish_carousel` | create | A carousel of 2 to 20 images and videos with one caption; a refused slide is left out while 2 remain. |
| `publish_reel` | create | A Reel from a video URL, with caption, cover, audio name, place and collaborators. |
| `publish_story` | create | A story from an image or a video URL. |
| `publish_container` | create | Publishes a container an earlier call left processing, once it is ready; never twice. |
| `get_publishing_limit` | read | The posts published through the API in the current 24-hour window and the quota. |
| `get_media_insights` | read | Reach, views, saves, shares, comments, likes and interactions of posts and Reels, or of stories (live ones, or by their media ids). |
| `get_account_insights` | read | Reach, views, interactions, accounts engaged, follows and unfollows over a range of days, and the follower count. |
| `list_comments` | read | The comments on a post, or the replies to a comment. |
| `add_comment` | create | A comment as the account on its post, or a reply to a comment. |
| `hide_comment` | update | Hides a comment from other people, or shows it again. |
| `delete_comment` | delete | Deletes a comment. |
| `api_get` | read | Any other Instagram Graph API GET under `/v26.0/`, for a chosen account. |
| `api_request` | write | A POST or DELETE under `/v26.0/` for a chosen account, such as turning comments off on a post. Sent once, never retried. |

### kaggle

[Credentials, setup and limits](./src/vendors/kaggle/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_quota` | read | The weekly GPU and TPU hours: used, held by running sessions, left, the weekly total and when it refreshes. |
| `list_notebooks` | read | Your notebooks (or someone's public ones), last run first, with language, type, visibility, accelerator, internet, votes and version. |
| `get_notebook` | read | One notebook's settings and data sources, and its code in windows with a cursor. |
| `push_notebook` | create | Creates a notebook or saves a new version, and runs it unless asked not to: private, CPU and no internet by default; a T4 or L4 GPU or a TPU v5e-8 on request. |
| `get_notebook_status` | read | The latest run's status (queued, running, complete, error, cancelled) and Kaggle's failure message. |
| `get_notebook_output` | read | The latest run's output files with their signed download links, and the last lines of its log. |
| `read_notebook_output_file` | read | A text output file's contents (a results CSV, a JSON file), in windows with a cursor; up to 8 MB. |
| `list_datasets` | read | Your datasets (or public ones, or one user's), last updated first, with size, visibility, downloads, votes, version and usability. |
| `list_dataset_files` | read | A dataset's files with their sizes and dates. |
| `get_dataset_status` | read | Whether a dataset is still processing or ready. |
| `create_dataset` | create | Creates a dataset from files given by public https URL or as text, private unless asked; a public one needs a license. The slug takes 6 to 50 lowercase letters, digits and dashes. |
| `create_dataset_version` | write | Uploads a new version from files: send every file the dataset should keep. With `delete_old_versions` it also deletes every earlier version for good, so it is marked destructive. |
| `list_competitions` | read | Competitions by words, category or group (the main list, the ones you entered, community competitions or the ones you host), with reward, deadline, teams and whether they take notebook submissions only. |
| `get_leaderboard` | read | The top of a competition's public leaderboard. |
| `list_submissions` | read | Your submissions to a competition with their status and scores. |
| `submit_to_competition` | create | Submits a file (by public https URL or as text) to a competition you joined; it uses one of the day's submissions. |
| `submit_notebook_to_competition` | create | Submits a notebook version and its output file to a code competition. |
| `api_get` | read | Any other GET of the Kaggle API under `/api/v1/`, such as dataset metadata, competition data files or models. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to the Kaggle API under `/api/v1/`. Sent once, never retried. Deleting notebooks, datasets or models is not offered: a path with a delete segment, in any case, is refused. |

### keepa

[Credentials, setup and limits](./src/vendors/keepa/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_token_status` | read | The token balance: tokens left (negative after a large call), refill rate, seconds to the next refill and, when the balance is below 1, when the next call can run. Free. |
| `get_products` | read | Up to 100 products by ASIN or by UPC, EAN or ISBN-13: title, brand, category, Amazon's bought-in-past-month bracket, then per series (Amazon, Buy Box, lowest New, FBA, FBM, Used, Warehouse, list price, sales rank, offers, rating, reviews) the value now, 30 and 90 day averages, the lowest and highest in the range and the lowest ever, with sales rank drops and the Buy Box now. Paid options add the live offers in Amazon's order (seller, condition, price, shipping, FBA, Prime, stock), stock levels (Amazon's and the Buy Box offer's) and the variations no longer listed. Or one short row per product (`brief`). 1 token per product, plus the paid options. |
| `get_price_history` | read | Dated tables of up to 4 series of one product (one row per day, week or month: lowest, highest and last value, gaps marked), with the lowest and highest point and the product summary (with `offers`, its first 10 live offers). 1 token, plus the option a series needs. |
| `search_products` | read | Up to 20 products for search words, in Amazon's order without sponsored results, with prices now and sales rank. 10 tokens. |
| `get_best_sellers` | read | A category's best sellers list, by current rank, a 30, 90 or 180 day average, a past month, or the subcategory rank: ranked ASINs from an offset, with the list's size. 50 tokens (an empty list too), nothing when Keepa has no list. |
| `search_categories` | read | Categories by name, largest first, with path, product count and average Buy Box price. 1 token. |
| `get_categories` | read | Up to 10 categories by id, or the root categories. 1 token. |
| `find_products` | read | The product finder: ASINs matching filters on category, price, sales rank, drops, monthly sales and more, with the total count, up to 2,000 per page. 10 tokens plus 1 per 100 ASINs. |
| `api_get` | read | Any other GET of the Keepa API, such as `/seller`, `/deal`, `/topseller` or `/lightningdeal`, with the key added. `/tracking` is not reachable. |

### linkedin

[Credentials, setup and limits](./src/vendors/linkedin/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The member who signed in: id, person URN, name, photo, locale, and the Page the connection posts for. |
| `list_posts` | read | The Page's posts, newest first, with URN, link, text, content type, visibility and times; the member's own posts with `author: "member"` (LinkedIn allows that only to apps approved for `r_member_social`, which it rarely grants). Paged with a cursor, where LinkedIn's next link says: a page can hold fewer posts than asked while more follow. |
| `get_post` | read | One post by its URN, as its author sees it. |
| `create_post` | create | Publishes right away, as the Page or the member (`w_member_social`): text up to 3,000 characters, optionally up to 20 images (JPEG, PNG or GIF from public https URLs, with alt text) or an article card. Every image is uploaded before the post is made. Returns the post URN and link. |
| `delete_post` | delete | Deletes one post by its URN, for good. |
| `api_get` | read | Any other GET under `/rest/` or `/v2/`, with the version headers, such as `/rest/organizationAcls?q=roleAssignee`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/rest/` or `/v2/`; PATCH is sent as a Rest.li partial update, and a create returns the new id from LinkedIn's `x-restli-id` header. Sent once, never retried. |

### mailchimp

[Credentials, setup and limits](./src/vendors/mailchimp/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The account, plan, total subscribers, its data center and how it is connected. Connection check. |
| `list_audiences` | read | Audiences with member, unsubscribe and cleaned counts, rates and campaign defaults. |
| `create_audience` | create | An audience with its contact address, permission reminder and defaults. |
| `list_members` | read | Members of an audience, most recently changed first; filter by status, change time or VIP. |
| `get_member` | read | One member by email. |
| `search_members` | read | Members by email or name, in all audiences or one. |
| `upsert_member` | update | Adds a person (with `status_if_new`, `pending` for double opt-in) or updates the member. |
| `batch_upsert_members` | update | Adds or updates up to 500 members in one call, with counts and errors. |
| `update_member_tags` | update | Adds and removes a member's tags. |
| `remove_member` | delete | Archives a member, or deletes the member and their data for good. |
| `list_campaigns` | read | Campaigns with status, audience, recipients and, once sent, opens and clicks. |
| `get_campaign` | read | One campaign, optionally with its HTML and plain text. |
| `create_campaign` | create | A draft campaign (regular, plain text, RSS or A/B test) to an audience or a segment. |
| `update_campaign` | update | Changes a draft's audience, segment or settings. |
| `set_campaign_content` | update | Sets a draft's HTML, plain text, imported page or template sections. |
| `get_send_checklist` | read | Whether a campaign is ready to send, item by item. |
| `send_test_email` | create | Sends a test to up to 10 addresses. |
| `send_campaign` | create | Sends a campaign now. |
| `schedule_campaign` | update | Schedules a campaign on a quarter hour, optionally in each subscriber's time zone. |
| `unschedule_campaign` | update | Stops a scheduled campaign. |
| `list_templates` | read | Templates (yours, base or gallery). |
| `create_template` | create | An HTML template with editable sections. |
| `list_segments` | read | Segments and tags of an audience with member counts. |
| `create_segment` | create | A static segment (tag) of emails, or a saved segment of conditions. |
| `update_segment_members` | update | Adds and removes up to 500 members of a static segment or tag. |
| `list_reports` | read | Results of sent campaigns. |
| `get_campaign_report` | read | One campaign's results: sends, opens, clicks, bounces, unsubscribes. |
| `get_report_details` | read | Per link clicks, who opened, unsubscribes, per recipient activity, domains, locations, abuse reports or advice. |
| `list_automations` | read | Classic automations with status and results. |
| `set_automation_state` | update | Pauses or starts all emails of a classic automation. |
| `api_get` | read | Any other GET under `/3.0/` at the account's data center, such as merge fields or interest categories. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/3.0/`, such as replicating a campaign. Sent once, never retried. Authorized apps are left out, in batches too. |

### mastodon

[Credentials, setup and limits](./src/vendors/mastodon/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The connected account: handle, link, counts, bot or locked, default visibility and language. |
| `get_instance_limits` | read | Your server's limits: characters per post and what a link counts as, media per post, alt text length, file sizes and types, poll limits. |
| `list_my_posts` | read | Your posts without boosts, newest first, with favourites, boosts, replies and quotes; narrow with replies left out, media only, pinned, or a hashtag. |
| `get_post` | read | One post by id or link on your server, and with `include_replies` the replies under it. |
| `list_scheduled_posts` | read | Your scheduled posts with their times. |
| `create_post` | create | Posts now or at `scheduled_at`, checked against your server's limits first: text, visibility, content warning, language, a poll, or media from public https URLs with alt text (uploaded and waited for). `reply_to` makes it a reply or the next post of a thread. The same post sent again within an hour is not posted twice (Idempotency-Key). |
| `reschedule_post` | update | Moves a scheduled post to another time. |
| `cancel_scheduled_post` | delete | Cancels a scheduled post. |
| `delete_post` | delete | Deletes one of your own posts with its media and returns its text for the record. |
| `api_get` | read | Any other GET of the Mastodon API under `/api/` on your server, such as `/api/v1/notifications`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/api/`, such as a favourite or an edit (PUT `/api/v1/statuses/<id>`). Sent once, never retried. What it may do depends on the token's scopes. |

### meta-ads

[Credentials, setup and limits](./src/vendors/meta-ads/README.md). Account keys: `ad_accounts` (Meta ad accounts, listed by `list_ad_accounts`), `pages` (Facebook Pages for ads, listed by `list_pages`).

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

### notion

[Credentials, setup and limits](./src/vendors/notion/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_connection` | read | Checks the token: the connection's name, workspace, and whether it sees only shared pages or acts as a person. |
| `search` | read | Pages and databases (data sources) by title, most recently edited first; everything the connection sees when no query is given. |
| `get_page` | read | One page or database row: title, link, parent, trash state and every property with its type and value. |
| `read_page_markdown` | read | A page's body as Notion-flavored Markdown, in windows of about 24 KB with a cursor; names the blocks Notion left out. |
| `list_block_children` | read | One level of a page's or block's blocks with their IDs, types and text, to append after a block, edit one or trash one. |
| `get_block` | read | One block by its ID. |
| `get_database` | read | A database's title, link and the data sources inside it (queries and rows use a data source ID). |
| `get_data_source` | read | A data source's schema: property names, types, IDs, select and status options, relation targets and computed properties. |
| `query_data_source` | read | Rows of a data source with a Notion filter and sorts, each with its title, link and property values. |
| `list_users` | read | Workspace members and bots with their IDs, to fill a person property (needs a user information capability). |
| `create_page` | create | A page under a page, a database row with its properties, or a private top-level page (personal access tokens only), with a Markdown body or up to 100 blocks. An unclear outcome is checked with `list_block_children` on the parent page (a row with `query_data_source`), since search lags behind. |
| `append_markdown` | create | Adds Markdown at the end or the start of a page. |
| `append_blocks` | create | Adds up to 100 blocks to a page or inside a block, at the end, at the start or after a given block. |
| `update_page_text` | write | Replaces exact passages of a page's Markdown in place. Sending the same edit twice can change the page twice, so it is marked destructive and not idempotent. |
| `replace_page_markdown` | update | Replaces a page's whole body; child pages and databases are never deleted. |
| `update_page` | update | Renames a page or changes a row's properties, icon or cover; optionally without notifications. |
| `update_block` | update | Changes one block, such as ticking a to-do or rewriting a paragraph. |
| `trash_page` | delete | Moves a page or a row to Notion's Trash. |
| `restore_page` | update | Takes a page or a row out of the Trash. |
| `trash_block` | delete | Moves one block to Notion's Trash. |
| `api_get` | read | Any other GET of the Notion API under `/v1/`, such as comments or file uploads. |
| `api_request` | write | A POST, PATCH or DELETE to the Notion API under `/v1/`, such as adding a comment, changing a data source or erasing a page's content (`erase_content`, which cannot be undone through the API). Sent once, never retried. |

### pinterest

[Credentials, setup and limits](./src/vendors/pinterest/README.md).

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

### qiita

[Credentials, setup and limits](./src/vendors/qiita/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_my_account` | read | The account: ID, name, article and follower counts, whether it is team-only, the image upload allowance of Qiita's editor, and the requests left this hour. |
| `list_my_articles` | read | Your articles, limited-share ones included, with likes, stocks, comments and tags, newest first, or ranked by likes, stocks, comments or last update across all of them (up to 1,000). |
| `get_article` | read | One article with its status, tags and counts, its page views when it is yours, and its Markdown on request (in windows with a cursor). |
| `search_articles` | read | Public Qiita articles by Qiita's search terms (`title:`, `tag:`, `user:`, `stocks:>50`, ...), with their authors and counts. |
| `get_tag` | read | One tag as Qiita spells it, with its article and follower counts (tags such as `C#` included). |
| `list_tags` | read | Qiita's tags, the most used first or by name. |
| `create_article` | create | Saves an article: limited share by default; `public: true` posts it publicly at once, with an Organization link or a tweet from the linked account if asked. |
| `update_article` | update | Changes an article's title, body, tags or slide mode, keeping the rest; never switches limited share or public. |
| `make_article_public` | update | Makes a limited-share article public, keeping its text and tags. Final: Qiita cannot make it limited again. |
| `delete_article` | delete | Deletes an article for good, with its likes, stocks and comments. |
| `api_get` | read | Any other GET of Qiita API v2 under `/api/v2/`, such as comments, stocks or followers, with the paging and rate headers. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to Qiita API v2 under `/api/v2/`, such as stocking an article or posting a comment. Sent once, never retried. |

### reddit

[Credentials, setup and limits](./src/vendors/reddit/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_me` | read | The connected account: username, id, karma, age, whether its email is verified, and the rate window. |
| `list_my_subreddits` | read | The communities the account subscribes to, or where it is an approved contributor. Paged with a cursor. |
| `get_subreddit_rules` | read | One community's rules and Reddit's site-wide rules. Read them before posting there. |
| `submit_post` | create | One text or link post to one community, with `nsfw` and `spoiler` set on purpose and an optional flair. Refuses duplicates and the same text in another community. Returns the post id and link. |
| `add_comment` | create | One comment on a post (`t3_...`) or reply to a comment (`t1_...`). Refuses duplicates and the same text on another thread. |
| `edit_text` | update | Replaces the text of one of the account's own text posts or comments, after checking with Reddit that it is the account's own. |
| `delete_item` | delete | Deletes one of the account's own posts or comments, after the same check. |
| `list_my_posts` | read | The account's own posts, newest first. Paged with a cursor. |
| `list_my_comments` | read | The account's own comments, newest first. Paged with a cursor. |
| `get_items` | read | Up to 25 posts or comments by their fullnames, and which were not found. |
| `api_get` | read | Any other documented GET on `https://oauth.reddit.com`, such as `/r/{name}/about`, inside the same rate window. |

### revenuecat

[Credentials, setup and limits](./src/vendors/revenuecat/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_projects` | read | The projects the key sees (a secret key normally sees one). |
| `list_apps` | read | The project's apps with their store type and bundle ID or package name. |
| `get_overview` | read | The overview cards: active trials and subscriptions (now), MRR, revenue, new and active customers (last 28 days), with update times. |
| `get_revenue` | read | Revenue, revenue net of taxes or proceeds for a date range. |
| `get_chart_options` | read | A chart's resolutions, filters (with values), segments and selectors; a filter whose values do not fit shows its value count, and `filter_id` lists its values in pages. |
| `get_chart` | read | A chart's measures, segments, dated points (partial periods marked; points RevenueCat sends as arrays of numbers stay as they came) and summary, in pages. |
| `list_products` | read | Products with store identifier, type, duration and trial duration. |
| `list_offerings` | read | Offerings, and which one is current. |
| `get_offering` | read | One offering with its packages and their products. |
| `list_entitlements` | read | Entitlements. |
| `list_entitlement_products` | read | The products attached to an entitlement. |
| `api_get` | read | Any other GET on the aggregate routes under `/v2/projects`. |

### roasit

[Credentials, setup and limits](./src/vendors/roasit/README.md). Account key: `apps` (Roasit apps, listed by `list_apps`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | The Roasit account behind the token and the token's name. |
| `list_apps` | read | The apps the token sees: app token, name, reporting currency, platforms, store ids, with `selected: true` on the apps chosen for the connection. Lists the candidates of the `apps` account picker. |
| `get_report` | read | One app's report, on one platform (`platform`) or the whole app: rows by day, platform, country, network, campaign, ad group or ad, with the metrics asked for, filters, sort, totals, currency, notes, spend freshness and spend depth, in pages. |
| `list_metrics` | read | The metric catalogue, with each metric's kind and the dimensions and filters it is allowed with. |
| `list_networks` | read | Network slugs, labels and whether each is paid. |
| `get_skan_report` | read | An app's SKAdNetwork postback status and rows by day and network, with unmapped sources. |
| `get_reconciliation` | read | Store installs against what each network claimed, for iOS or Android. |
| `get_data_freshness` | read | Whether an app's data is current: pull errors per source, SDK events, last verified SKAN postback. |
| `list_dimension_values` | read | The exact networks, campaigns, ad groups and ads an app's filters take. |
| `list_events` | read | An app's SDK events and their conversion mapping. |
| `api_get` | read | Any other GET of the Roasit API under `/api/`. |

### sendgrid

[Credentials, setup and limits](./src/vendors/sendgrid/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_account` | read | What the API key may do (its scopes), plus account type and reputation. Connection check. |
| `send_email` | create | One email to up to 1,000 recipients (own copies or one shared email with cc and bcc), text, HTML or a dynamic template, attachments from public URLs, optional schedule or sandbox check. |
| `search_email_activity` | read | Recent emails by an activity query (recipient, subject, status); needs the Email Activity history add-on. |
| `upsert_contacts` | update | Adds or updates up to 1,000 contacts, optionally into lists; returns a job id. |
| `get_import_status` | read | The status and counts of a contacts import or delete job. |
| `search_contacts` | read | Contacts by an SGQL query (up to 50 returned, with the total). |
| `get_contacts_by_email` | read | Contacts by email address, up to 100 at a time. |
| `delete_contacts` | delete | Deletes up to 100 contacts by id; returns a job id. |
| `list_custom_fields` | read | Custom and reserved contact fields with their ids. |
| `list_lists` | read | Lists with their contact counts. |
| `create_list` | create | A list. |
| `delete_list` | delete | Deletes a list, keeping its contacts unless asked. |
| `list_single_sends` | read | Single Sends with status and send time. |
| `get_single_send` | read | One Single Send with recipients, sender, unsubscribe setting and bodies. |
| `create_single_send` | create | A draft Single Send. |
| `update_single_send` | update | Changes a draft Single Send. |
| `schedule_single_send` | update | Schedules a Single Send, or sends it now. |
| `unschedule_single_send` | update | Cancels a scheduled Single Send; it becomes a draft. |
| `delete_single_send` | delete | Deletes a Single Send. |
| `get_single_send_stats` | read | Delivered, opens, clicks, bounces, spam reports and unsubscribes of a Single Send. |
| `list_templates` | read | Dynamic or legacy templates with their versions. |
| `get_template` | read | One template with the active version's subject and bodies. |
| `create_template` | create | An empty template. |
| `create_template_version` | create | A version (subject, HTML, text) of a template, active by default. |
| `list_senders` | read | Verified senders with their ids. |
| `create_sender` | create | A sender identity; SendGrid emails a verification link. |
| `list_unsubscribe_groups` | read | Unsubscribe groups with their ids and counts. |
| `get_stats` | read | Statistics for a date range, in total and per period, for the account or per category. |
| `list_suppressions` | read | Bounces, blocks, spam reports, invalid emails or global unsubscribes. |
| `delete_suppression` | delete | Removes one address from a suppression list. |
| `api_get` | read | Any other GET under `/v3/`, such as `/v3/marketing/segments/2.0` or `/v3/marketing/contacts/count`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/v3/`. Sent once, never retried. API keys are left out, and so are changes to teammates and their access requests, subusers, access settings, single sign-on and the account's email, username or password. |

### serper

[Credentials, setup and limits](./src/vendors/serper/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `web_search` | read | Google results for a query: title, link, snippet, position and date of each result, plus the answer box, knowledge graph, related questions and related searches. Options for country, language, location, freshness (past hour to past year) and the page. |
| `news_search` | read | Google News articles: title, link, snippet, source, date and image link, with the same options. |
| `image_search` | read | Google Images: each image's URL, size, thumbnail, title and the page it is on, up to 100 a page. |
| `video_search` | read | Google Videos: title, link, snippet, duration, source, channel, date and thumbnail. |
| `places_search` | read | Google's local results, such as "coffee shops in Austin": address, coordinates, rating and review count, category, phone, website and cid. |
| `maps_search` | read | Google Maps around a point (`ll`) or one place by place ID or cid: address, rating, price level, types, opening hours, phone, website and the cid, fid and placeId that `place_reviews` takes. Its cursor keeps the map position that pages after the first need. |
| `place_reviews` | read | The Google reviews of one place, by cid, fid or place ID: rating, date, text, likes, reviewer and owner reply, newest or most relevant first, plus the topics Google groups them by. |
| `shopping_search` | read | Google Shopping: products with price, shop, delivery, rating, offers and link, up to 40 a page. |
| `scholar_search` | read | Google Scholar: papers with publication, snippet, year, citation count and PDF link. |
| `patent_search` | read | Google Patents: publication number, priority, filing, grant and publication dates, inventor, assignee and PDF link. |
| `autocomplete` | read | The searches Google suggests for the start of a query, for keyword research. |
| `lens_search` | read | Pages and products that show an image, or look like it, by the image's public URL (Google Lens). |
| `find_locations` | read | The exact place names the `location` option takes, such as "Austin,TX,Texas,United States". Free. |

### shopify

[Credentials, setup and limits](./src/vendors/shopify/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_shop` | read | The shop (name, domains, currency, time zone, plan) and the access scopes the app was granted. |
| `list_products` | read | Products, most recently updated first, by Shopify search syntax: id, title, handle, status, vendor, type, tags, price range, variants, stock and image. |
| `get_product` | read | One product by id or handle: description, SEO, options, media, collections, and its variants (100 at a time) with prices, SKUs, stock and inventory item ids. |
| `create_product` | create | A product with options, variants (price, compare-at price, SKU, barcode, stock per location) and images from public URLs, in one request; a draft by default. Refuses a handle or SKU in use unless `allow_duplicates`. |
| `update_product` | update | Title, description, vendor, type, tags, handle (the old URL redirects), status, SEO, and manual collections to join or leave. |
| `add_product_images` | create | Adds images to a product from public URLs (Shopify fetches and processes them); returns the media count and the newest media with their status. Each call adds the images again. |
| `update_variants` | update | Prices, compare-at prices, SKUs, barcodes, inventory policy, tracking, cost and shipping of one product's variants, all or nothing. |
| `list_publications` | read | The sales channels (Online Store, Point of Sale, ...) with their ids, or where one product is published. |
| `publish_product` | update | Publishes a product on sales channels, or takes it off them. |
| `list_collections` | read | Collections with product counts and, for smart collections, their rules. |
| `list_locations` | read | The shop's locations with their ids. |
| `get_inventory` | read | One variant's stock at each location: available, on hand, committed, incoming, reserved. |
| `set_inventory_quantity` | update | Sets a variant's available (or on-hand) quantity at a location only if the stock is still what was seen; the same call within 15 minutes is applied once. |
| `list_orders` | read | Orders, newest first, by search syntax: name, date, payment and fulfillment status, total, refunds, items, returns, tags. No customer details. |
| `get_order` | read | One order by id or name: totals, line items, fulfillment orders with what is left to ship, fulfillments with tracking, refunds; customer, email, phone and addresses on request. |
| `fulfill_order` | create | Ships what is left of a fulfillment order, or given items, with tracking; optionally emails the customer. |
| `list_customers` | read | Customers by search syntax: name, state, orders, amount spent, tags, and email and phone on request. |
| `list_discounts` | read | Code and automatic discounts with their codes, dates, usage and summary, or one by exact code. |
| `create_discount_code` | create | A percentage or fixed-amount code for all items or some products, variants or collections, with dates, usage limits, a minimum and combinations. |
| `graphql_query` | read | Any GraphQL query of the Admin API, with its cost. |
| `graphql_mutation` | write | Any GraphQL mutation (customers, cancels, refunds, collections, variants, deletes, ...). Sent once, never retried. |

### threads

[Credentials, setup and limits](./src/vendors/threads/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | The connected profile: id, handle, name, bio and picture. |
| `list_posts` | read | The profile's posts, newest first, with permalinks. |
| `publish_post` | create | A text, image, video or carousel post (or a reply in one of the profile's threads), with reply controls, quote, topic tag, link preview, text attachment, AI label and country limits; waits for processing and publishes once. |
| `publish_container` | create | Publishes a container an earlier call left processing, once it is ready; never twice. |
| `get_publishing_limit` | read | What the profile used of its 24-hour limits: 250 posts, 1,000 replies, 100 deletions. |
| `list_replies` | read | The direct replies to a post, or the whole conversation. |
| `hide_reply` | update | Hides a reply in one of the profile's threads, or shows it again. |
| `delete_post` | delete | Deletes one of the profile's posts or replies. |
| `get_post_insights` | read | Views, likes, replies, reposts, quotes and shares of chosen or recent posts. |
| `get_profile_insights` | read | Profile views, likes, replies, reposts, quotes and link clicks over a range of days, the follower count, or follower demographics. |
| `api_get` | read | Any other Threads API GET under `/v1.0/`. |
| `api_request` | write | A POST or DELETE under `/v1.0/`. Sent once, never retried. |

### tiktok

[Credentials, setup and limits](./src/vendors/tiktok/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_creator_info` | read | What the creator can post right now: name, the privacy levels they may choose, whether comments, duets and stitches are off on their account, and the longest video they may post. |
| `get_profile` | read | Open id, union id, display name and avatar; profile and stats fields with the `user.info.profile` and `user.info.stats` scopes. |
| `post_video` | create | One video from a public https URL, by FILE_UPLOAD (MP4, MOV or WebM within the host's download limit, sent in chunks) or PULL_FROM_URL (from a verified host), with a caption up to 2,200 characters, privacy level, interaction settings, cover frame and the branded-content and AI labels; or as an inbox draft (`MEDIA_UPLOAD`, the file only: the creator adds the caption and settings in the app). Waits a little for TikTok, then returns the `publish_id`. |
| `post_photos` | create | A photo post of 1 to 35 photos that TikTok downloads from their URLs, which must be on a domain or URL prefix verified for the app, with a title up to 90 characters, a description up to 4,000, cover, music and labels; or as an inbox draft with its title and description. Waits a little for TikTok, then returns the `publish_id`. |
| `get_post_status` | read | Where a post stands by its `publish_id`: processing, sent to the inbox, published (with the public post ids) or failed (with the reason). Can wait up to 30 seconds for TikTok to finish. |
| `list_videos` | read | The creator's public videos, newest first, with their link, length and view, like, comment and share counts (needs `video.list`). Paged with a cursor. |
| `get_videos` | read | Up to 20 of the creator's videos by id, such as the post ids `get_post_status` returns (needs `video.list`). |
| `api_get` | read | Any other GET under `/v2/`, such as `/v2/user/info/`. |
| `api_request` | write | A POST under `/v2/` for the writes the tools above do not cover. Sent once, never retried. |

### tumblr

[Credentials, setup and limits](./src/vendors/tumblr/README.md). Account key: `blogs` (Tumblr blogs, listed by `list_blogs`).

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

### twitter

[Credentials, setup and limits](./src/vendors/twitter/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_me` | read | The connected account: id, username, name, bio, follower, following and post counts, verification and X Premium subscription type. |
| `list_my_posts` | read | The account's own posts, newest first, with link, text, time, counts and media; replies and reposts can be left out. Paged with a cursor. |
| `get_post` | read | One post by its id, with its counts, the post it replies to or quotes, and its media. |
| `upload_media` | create | Uploads one image, GIF or video from a public https URL with the chunked upload, adds alt text, waits a little for processing, and returns the `media_id` for later posts (with `ready: false` while X is still processing it). Nothing is posted. The way to post a video. |
| `get_media_status` | read | The processing state of an upload by its `media_id`. |
| `create_post` | create | Publishes a post: text, up to 4 images or one GIF or video (by URL or `media_id`), or a poll; optionally a reply, a quote, reply settings and the AI and paid-partnership labels. Returns the post id and link. |
| `create_thread` | create | Publishes 2 to 25 posts, each replying to the one before (the first optionally replying to an existing post). All media is uploaded first; if a post fails, or the call is 45 seconds in before the next post, the result names the posts already published and how to go on. |
| `delete_post` | delete | Deletes one of the account's posts, for good. |
| `api_get` | read | Any other GET under `/2/`, such as `/2/tweets/search/recent`. |
| `api_request` | write | A POST, PUT or DELETE under `/2/`. Sent once, never retried. |

### woocommerce

[Credentials, setup and limits](./src/vendors/woocommerce/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_products` | read | Products, newest first: id, name, type, status, SKU, prices, sale, stock, variation count, categories, sales and link; by search words, exact SKU, status, type, category, tag, stock status or sale. |
| `get_product` | read | One product with prices, stock and who manages it, description, images, categories, tags, attributes, shipping and tax fields, and a variable product's variations, page by page. |
| `create_product` | create | A product, a draft by default: prices, SKU, stock, description, images from public URLs, categories, tags, attributes, and for a variable product its variations, created right after it (failures are listed). Other API fields go in `more_fields`. |
| `update_product` | update | Changes a product or one of its variations: prices, sale, stock, status, text, images, categories and other fields. With `expected_stock_quantity` it reads the stock first and changes nothing if it moved; stock a parent product manages is not changed on the variation. |
| `list_orders` | read | Orders, newest first: number, status, dates, total, customer id, payment method, items and refunds; by status, customer, product, dates (a day counts whole) or search words. No contact details. |
| `get_order` | read | One order with line items, shipping, fees, coupons, totals and refunds; notes and the billing and shipping details on request. |
| `update_order` | update | Changes an order's status, customer note, or billing and shipping details. |
| `add_order_note` | create | Adds a private note, or a note emailed to the customer. |
| `create_refund` | write | Records a refund of an amount, optionally per line item; it refunds through the payment gateway and restocks the items only when asked. A gateway refund moves money and cannot be undone. |
| `list_coupons` | read | Coupons with discount, expiry, usage and restrictions, or one by exact code. |
| `create_coupon` | create | A coupon: percent, fixed cart or fixed product discount, expiry, usage limits, minimum and maximum spend, products, categories and allowed emails. |
| `list_customers` | read | Customers with id, email, name, user name, role and whether they have paid; by search words or exact email. |
| `get_report` | read | Sales for a period or date range with a line per day or month, top sellers, or the counts of orders, products, customers, coupons and reviews. |
| `list_terms` | read | Product categories, tags, global attributes, an attribute's values, or shipping classes. |
| `create_term` | create | A category, tag, attribute value or shipping class; an existing one with that name or slug comes back with `existing: true`. |
| `api_get` | read | Any other GET under `/wc/v3/` (or the `/wc-analytics/` reports), such as `/wc/v3/customers/12` or `/wc/v3/settings/general`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE under `/wc/v3/`, with a JSON body, such as a batch update, a customer change or a deletion (products, orders and coupons go to the trash; `force=true` deletes for good). Sent once, never retried. |

### wordpress

[Credentials, setup and limits](./src/vendors/wordpress/README.md).

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_site` | read | The site (name, tagline, address, time zone), the connected user with its roles and what it may do, and whether the Rank Math SEO plugin's API is there. |
| `list_posts` | read | Posts or pages, newest first, of any status or one: id, status, title, dates, link, editor link, excerpt, categories, tags, featured image. Search words find posts on a topic. |
| `get_post` | read | One post or page with its raw title and HTML content (in parts of about 20 KB for long posts), excerpt, slug, terms, featured image and links. |
| `create_post` | create | A post or page: a draft by default, or published at once, pending review, private, or scheduled at a date. HTML body, excerpt, slug, categories, tags, featured image, author, comments. |
| `update_post` | update | Changes the given fields of a post or page: publish a draft, take a post offline, replace the cover, edit the text. |
| `upload_media` | create | Downloads a file from a public https URL and adds it to the media library with alt text, title, caption and description, optionally attached to a post. Returns its id and URL. |
| `update_media` | update | Changes a media item's alt text, title, caption, description or attachment. |
| `list_media` | read | The media library, newest first, by search words or type: id, title, URL, type, alt text, pixel size and file size. |
| `list_terms` | read | Categories or tags with ids, names, slugs, post counts and parents. |
| `create_term` | create | A category or tag; when one with that name or slug exists, returns it with `existing: true` instead of making a second. |
| `set_seo_meta` | update | The SEO title, meta description and focus keyword of a post or page through the Rank Math SEO plugin's own endpoint; `applied: false` when the site does not run it. |
| `api_get` | read | Any other GET of the site's REST API, by route after `/wp-json`, such as `/wp/v2/comments` or `/wp/v2/posts/12/revisions`. |
| `api_request` | write | A POST, PUT, PATCH or DELETE to a REST route, with a JSON body, such as a comment reply or moving a post to the trash. Sent once, never retried. |

### youtube

[Credentials, setup and limits](./src/vendors/youtube/README.md). Account key: `channels` (YouTube channels, listed by `list_channels`).

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_channels` | read | The account's channels with handle, subscribers, views, videos and uploads playlist. The `channels` picker. |
| `get_channel` | read | A channel's details: description, country, statistics, keywords, audience setting, upload limits. |
| `list_videos` | read | The channel's uploads, newest first, with visibility, schedule, duration, views, likes and comments. |
| `get_videos` | read | Up to 50 videos in full: description, tags, category, languages, status, labels, statistics, thumbnail. |
| `search_videos` | read | Searches the channel's public videos by words, in an order and a time range (100 quota units a search). |
| `upload_video` | create | Uploads a video or Short from a public https URL with its details, visibility or scheduled release, audience setting and synthetic-media label, through the resumable upload, in parts read by byte range. A large video takes several calls: pass `nextCursor` back as `cursor` until `done` is true. |
| `update_video` | update | Changes a video's details or visibility (publish, unlist, schedule); the fields not given are kept. |
| `set_thumbnail` | update | Sets a custom thumbnail from a JPEG or PNG URL (verified channels). |
| `list_playlists` | read | The channel's playlists, private ones included for the connected channel. |
| `list_playlist_items` | read | The videos of a playlist in order. |
| `create_playlist` | create | Creates a playlist (private unless told otherwise). |
| `add_to_playlist` | create | Adds a video to a playlist, at the end or at a position. |
| `get_analytics_report` | read | An Analytics report: daily figures (the default), top videos, retention for a video, traffic sources, countries, devices, demographics, or your own metrics, dimensions, filters and sort. |
| `screen_videos_for_ads` | read | Checks uploads for video ads: visibility, audience, views, length for the ad format, average view percentage. |
| `api_get` | read | Any other GET under `/youtube/v3/` or the Analytics `/v2/` API, such as video categories or a channel's branding settings. |
| `api_request` | write | A POST, PUT or DELETE under `/youtube/v3/`, such as deleting a video or taking it out of a playlist. Sent once, never retried. |

## How it works

A connector is one CommonJS file, `dist/vendors/<vendor>.js`, built from `src/vendors/<vendor>/`. It uses web-standard globals only (no `require`, no Node APIs), so a host can load it without `node_modules`:

```js
module.exports = {
  vendor: 'devto',                 // ^[a-z][a-z0-9-]{1,29}$
  origins: ['https://dev.to'],     // the fixed API origins it calls
  originFields: [],                // credentials that hold a site or instance URL, e.g. ['instanceurl']
  credentials: ['apikey'],         // the names it reads from ctx.credentials
  requiredCredentials: [['apikey']], // what a call needs: every credential of one of these lists
  accountPickers: [],              // the accounts a host lets the user choose, e.g. [{ key: 'pages', ... }]
  tools: [{ name, title, description, inputSchema, annotations }],
  async call(toolName, args, ctx) {} // returns an MCP CallToolResult
};
// ctx = { credentials, accounts, fetch, signal, log }
```

`ctx.fetch` is the host's guarded fetch. A request to one of the module's `origins` is an API call, and so is a request to a [credential origin](#credential-origins). Any other URL is a media download (for example an image to post), which the host allows only as a GET to a public https address. A host refuses anything else before sending it and rejects with `code: "URL_REFUSED"`, which tells the module nothing was sent.

The stdio CLI is one such host. You can be another: the package exports the modules and the CLI's building blocks.

```js
const { loadConnector, createGuardedFetch, originsFromCredentials } = require('@wiro-ai/wiro-agent-connectors');

const devto = loadConnector('devto'); // or require('@wiro-ai/wiro-agent-connectors/vendors/devto')
const credentials = { apikey: process.env.DEVTO_APIKEY };
const result = await devto.call('list_my_articles', { per_page: 5 }, {
  credentials,
  accounts: null, // no account lock
  // The module's origins, plus the sites its originFields credentials name (none for dev.to).
  fetch: createGuardedFetch({ origins: devto.origins, credentialOrigins: originsFromCredentials(devto, credentials) }),
  log: (line) => console.error(line),
});
```

Results are a single JSON text block, trimmed to the fields an agent needs and kept under 32 KB. A longer list comes back in pages: pass `nextCursor` back as `cursor`. Errors come back as results with `isError: true` and a sentence that says what happened, plus the vendor's HTTP `status` and, for a rate limit, `retryAfter` in seconds.

### Credential origins

Some services live at an address the user chooses: a Mastodon instance, a WordPress site, a shop. A module names the credentials that hold such an address in `originFields`. On every call, the module and the host turn each of those values into an https origin with the same rule, `parseSiteUrl`: a bare host such as `mastodon.social` gets `https://`, a path is ignored, and a value that is not https or that carries a user name or password is refused (the module then answers with the reason and sends nothing). The module may send API requests to that origin, for that call only. Because the user, not the module, chose the address, the host checks it like a media URL before anything is sent:

- https only, and no user name or password in the URL;
- every address the host name resolves to must be public: no loopback, private, link-local, carrier-grade NAT or reserved ranges, IPv4 and IPv6 alike;
- the connection goes to the address that was checked, so DNS cannot change it in between;
- redirects are not followed: a 3xx reply goes back to the module as it is;
- the usual timeout and size cap.

The CLI's guarded fetch does all of this. Every other host must do the same, whether it runs connectors for an agent or on a server; with this package, resolve the origins from the call's credentials and pass them in, as above: `createGuardedFetch({ origins: module.origins, credentialOrigins: originsFromCredentials(module, credentials) })`. A host may refuse more than this, for example its own public addresses.

### OAuth access tokens

A connector whose service signs in with OAuth declares the credential `access_token`. The host passes its current access token there on every call and refreshes it on its own; a module never refreshes, stores or logs it, and an expired token comes back as a plain 401 error. In the CLI, `access_token` comes from `<VENDOR>_ACCESS_TOKEN`, as it is; when set, the CLI passes it along even to a connector that does not require it. Facebook Pages and Meta Ads also take `appsecret_proof`, the HMAC-SHA256 of the token keyed with the app secret, for an app that requires it: the host computes it, and the app secret never reaches the connector.

### Required credentials

`requiredCredentials` says which credentials a call needs, as alternatives: a call goes ahead when every credential of at least one list has a value. By default there is one list with every credential, so all of them are required. A service that takes either an OAuth access token or a long-lived token from its settings declares both lists, as Meta Ads does with `[["access_token"], ["systemusertoken"]]`, and a credential that is in no list, such as a value only some calls use, is optional. Without a complete list, a call sends nothing and answers that the connector is not connected, naming what each alternative still lacks: "Meta Ads is not connected: it needs the Meta Ads access token, or the Meta Ads system user token." A host can read the lists to tell whether a connection is complete before it calls anything. The CLI reads every declared variable and needs one complete list; `--list` prints the alternatives of a connector that has them.

### Generic API tools

A connector's own tools do the common jobs; the rest of a vendor's API is reachable through two generic tools that the core builds for a module:

- `api_get` (read) sends one GET to a path of the API, with query parameters, and returns the HTTP status and the reply, JSON or text, cut to fit 32 KB.
- `api_request` (write) sends one POST, PUT, PATCH or DELETE with a JSON or a raw body, and returns the same. It is never retried: an unclear outcome comes back as unknown, with `api_get` to check.

Both send the connection's credentials, keep to the module's origins and its base path (checked after `.` and `..` are resolved), and, when the host applies an account lock, only reach paths that name a chosen account. Their descriptions name the vendor's API, its base path and its reference.

### Account pickers and the account lock

Tools that act on one of several accounts (pages, ad accounts, channels) check the account against `ctx.accounts`, for example `{ "pages": ["123"] }`, before sending anything. A connector describes each such choice in `accountPickers`, so a host can let the user make it after connecting:

```js
accountPickers: [{
  key: 'pages',             // the ctx.accounts key the choice goes under
  label: 'Facebook Pages',
  description: 'The Pages the agent may post to.', // optional
  multiple: true,           // several may be chosen; false for one
  tool: 'list_pages',       // the read tool that lists the candidates
  idField: 'id',            // dot paths into each item it returns, such as 'id' or 'owner.name'
  nameField: 'name',
  legacyField: 'pageid',    // optional: the field an older setup kept this choice in, for a host that migrates it
}]
```

A host runs the picker's tool with no arguments, and again with `cursor` set to the result's `nextCursor` while there is one. The tool returns one list, such as `{ "pages": [...] }`: the host reads each item's id and name at `idField` and `nameField`, lets the user choose, and passes the chosen ids on every call as `ctx.accounts[key]`. The module's tools then refuse any other account before sending anything. A picker's tool is always a read tool that takes no required argument, and its key, label and description name only the service.

In the CLI, set `CONNECTOR_ACCOUNTS` to that JSON, keyed by the account keys `--list` prints, to apply a lock; without it there is none. The [Tools](#tools) section names the account keys of every connector that has them.

## Security

- **Credentials are never stored or logged.** They arrive with each call, from your environment in the CLI. What a connector keeps in memory is short-lived and keyed by a SHA-256 hash of the credentials, never the credentials themselves: a Bluesky session for up to 10 minutes, because Bluesky allows only 30 sign-ins per 5 minutes and 300 per day; for a connector that signs in with a Google service account (Google Calendar, Google Drive, Google Play, Firebase), its access token until 5 minutes before it expires; the Page tokens Facebook Pages and Instagram fetch for 15 minutes, never returned by a tool; the connected profile or channel id of Threads (15 minutes) and YouTube (10 minutes); and, for Reddit, the rate window of each connection and, for 48 hours, a SHA-256 digest of each post and comment (never its text), so the same one is not sent twice. Keys that sign their own tokens (Google service accounts, App Store Connect) are used with WebCrypto in memory and never leave the call. Log lines carry the connector, tool, HTTP method, status and duration, never arguments, credentials or content.
- **Origin lock.** A connector only reaches its declared origins and, for a service at an address the user chooses, the https origin of that address; the host refuses any other API URL.
- **SSRF guard on media and user-chosen sites.** A media URL must be https, must resolve to public addresses only (no loopback, private, link-local, carrier-grade NAT or reserved ranges, IPv4 and IPv6 alike), and every redirect is checked the same way, at most 5; no credential header is sent with it. An API request to a [credential origin](#credential-origins) passes the same address checks, and its redirects are never followed. Either way, the connection goes to the address that was checked.
- **Limits.** Requests time out after 30 seconds, API replies are capped at 8 MiB by the CLI and at 4 MiB by the modules (8 MiB for the few calls that need it, such as a long post or a large report), and media downloads at 25 MiB by the CLI. Each connector also keeps to its service's own file limits, which may be lower (Bluesky images: 2,000,000 bytes).
- **Writes are never retried.** When a write gets no clear answer (a timeout, a broken connection, a 5xx), the result is `{ "outcome": "unknown", "check": "<read tool>" }`, so the agent checks before trying again instead of posting twice. Rate limits are passed back with `retryAfter`, never queued.
- **White-label.** Tool names, descriptions and messages name only the service.

Found a vulnerability? Please report it privately, see [SECURITY.md](./SECURITY.md).

## Add your connector

New connectors are welcome. Copy `src/vendors/_template/`, declare the service's origins and credentials, write the tools, and test them against recorded responses; the template and [CONTRIBUTING.md](./CONTRIBUTING.md) walk you through it, and the build checks the rest. A good connector is one file, has no runtime dependencies, sends every request through `ctx.fetch`, and has honest annotations.

**[Read the contributing guide →](./CONTRIBUTING.md)**

## Development

```bash
npm ci
npm run typecheck
npm test                          # builds, then runs every test with mocked HTTP
npm run build
npm run smoke -- devto            # one live read with your own account (credentials from the environment or .env)
npm run smoke -- devto --write    # plus one live write
```

`npm run build` writes the CLI to `dist/` and each connector to `dist/vendors/<vendor>.js`.

## License

MIT, see [LICENSE](./LICENSE).
