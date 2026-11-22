# Changelog

## 0.1.0

The first release: three connectors, and the stdio CLI that runs them.

- `serper`: `web_search`, Google results through Serper with the answer box, knowledge graph, related questions and related searches.
- `devto`: `list_my_articles`, `create_draft_article` and `update_article`, draft-first publishing on dev.to with the AI disclosure dev.to asks for.
- `bluesky`: `get_profile`, `list_my_posts` and `create_post`, with clickable links, mentions and hashtags and an optional image with alt text.
- Each connector is one dependency-free CommonJS file, `dist/vendors/<vendor>.js`, that exports `{ vendor, origins, credentials, tools, call }` and makes every request through the host's `ctx.fetch`.
- `npx @wiro-ai/wiro-agent-connectors <vendor>` serves a connector over stdio, with credentials from `<VENDOR>_<CREDENTIAL>` environment variables and a guarded fetch: origin lock, timeouts, size caps and an SSRF guard for media URLs.
- Results stay under 32 KB with a cursor for more, rate limits come back with `retryAfter`, and writes are never retried: an unclear outcome is reported as unknown, with the read tool to check.
