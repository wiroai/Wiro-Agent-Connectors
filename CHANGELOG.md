# Changelog

## Unreleased

- Credential origins: a module may name, in `originFields`, the credentials that hold a site or instance URL (a Mastodon instance, a WordPress site, a shop). Each call may then reach the https origin of that value, resolved by `parseSiteUrl` the same way in the module and in the host, and the host checks it like a media URL: https only, public addresses only, connected to the checked address, redirects not followed. Modules export `originFields` (an empty list when unused) and may leave `origins` empty when `originFields` names the API's address; `h.origins` and `h.originOf()` give a tool the call's origins.
- Hosts: `createGuardedFetch` takes `credentialOrigins`, `originsFromCredentials` computes them for a call, and `parseSiteUrl` and `siteOrigin` are exported for hosts with their own fetch. The test hook `mediaTransport` is now `transport` (the old name still works), and it also carries API requests to credential origins.
- Generic API tools: `apiTools()` builds `api_get` (read, GET only) and `api_request` (POST, PUT, PATCH or DELETE, never retried, `check: "api_get"`) for a connector, with its auth headers, its origins and base path, an optional account lock (`accounts`), a `guard` and a `send` hook for session tokens. Replies come back as the status and the JSON or text, cut to fit 32 KB.
- A fifth tool kind, `write`, for a tool whose effect depends on its arguments: destructive and not idempotent, MCP's own defaults. `api_request` uses it.
- `h.api` takes lists as query values and repeats the parameter.
- `devto` and `bluesky` gain `api_get` and `api_request` for the rest of their APIs: dev.to under `/api/` (POST, PUT, DELETE), Bluesky any XRPC query or procedure with the account's session, its account, session and identity methods left out. `serper` has none: its one endpoint is `web_search`.
- JWT signing in the core, with WebCrypto only: `signJwt` (RS256 or ES256 from a PEM PKCS#8 key, ES256 as the raw r||s signature), `googleServiceAccountToken` (the jwt-bearer exchange at `https://oauth2.googleapis.com/token`, cached in memory until 5 minutes before expiry, keyed by a hash of the key) and `appStoreConnectToken` (ES256 with `kid`, `iss`, `aud: "appstoreconnect-v1"` and a 20-minute expiry).
- OAuth: a module that declares the credential `access_token` gets the host's current OAuth access token there on every call; hosts refresh it, modules never do. The CLI reads it from `<VENDOR>_ACCESS_TOKEN`, and when set passes it along even to a module that does not declare it.
- Required credentials: modules export `requiredCredentials`, the credentials a call needs as alternatives, such as `[["access_token"], ["system_user_token"]]` (by default one list of every credential). A call goes ahead when one list is complete; otherwise it sends nothing and names what each alternative still lacks. A 401 names the credentials the call went ahead with, and an origin field the call goes ahead without may be empty.
- Account pickers: modules export `accountPickers`, the account choices a host offers after connecting: `{ key, label, description?, multiple, tool, idField, nameField, legacyField? }`, where `tool` is a read tool that lists the candidates with no arguments and `idField` and `nameField` are dot paths into its items. Both new fields are checked when the module loads, and the template shows a picker.
- CLI: a connector needs one complete list of variables; `--list` prints a connector's alternatives and its account keys, which `CONNECTOR_ACCOUNTS` takes (no variable maps to a picker). `credentialsFromEnv` also returns `needed`, what each alternative lacks, and `assertConnectorModule` checks both fields while still loading modules built before them.

## 0.1.0

The first release: three connectors, and the stdio CLI that runs them.

- `serper`: `web_search`, Google results through Serper with the answer box, knowledge graph, related questions and related searches.
- `devto`: `list_my_articles`, `create_draft_article` and `update_article`, draft-first publishing on dev.to with the AI disclosure dev.to asks for.
- `bluesky`: `get_profile`, `list_my_posts` and `create_post`, with clickable links, mentions and hashtags and an optional image with alt text.
- Each connector is one dependency-free CommonJS file, `dist/vendors/<vendor>.js`, that exports `{ vendor, origins, credentials, tools, call }` and makes every request through the host's `ctx.fetch`.
- `npx @wiro-ai/wiro-agent-connectors <vendor>` serves a connector over stdio, with credentials from `<VENDOR>_<CREDENTIAL>` environment variables and a guarded fetch: origin lock, timeouts, size caps and an SSRF guard for media URLs.
- Results stay under 32 KB with a cursor for more, rate limits come back with `retryAfter`, and writes are never retried: an unclear outcome is reported as unknown, with the read tool to check.
