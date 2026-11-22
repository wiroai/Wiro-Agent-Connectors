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

| Connector | What it can do | Auth | Status |
| --- | --- | --- | --- |
| `serper` | Google search results through [Serper](https://serper.dev): organic results, answer box, knowledge graph, related questions | Serper API key | Available |
| `devto` | [dev.to](https://dev.to) articles: list your articles with their stats, save drafts, publish and edit, and call the rest of the dev.to API | dev.to API key | Available |
| `bluesky` | [Bluesky](https://bsky.app): read profiles, list your recent posts, post text with clickable links, mentions and hashtags and an optional image, and call any other XRPC method | Handle and app password | Available |

Missing a service? [Add your connector](#add-your-connector) or [ask for one](https://github.com/wiroai/Wiro-Agent-Connectors/issues/new?template=new_connector.yml).

## Quick start

Requires Node.js 22 or later. Start a connector by name; it reads its credentials from environment variables named `<VENDOR>_<CREDENTIAL>`:

```bash
DEVTO_API_KEY=your-key npx -y @wiro-ai/wiro-agent-connectors devto
```

`npx -y @wiro-ai/wiro-agent-connectors --list` prints every connector with its tools and variables, and, where a connector has them, the alternatives it accepts and its [account keys](#account-pickers-and-the-account-lock).

| Connector | Environment variables | Where to get them |
| --- | --- | --- |
| `serper` | `SERPER_API_KEY` | The API key on your [serper.dev](https://serper.dev) dashboard. |
| `devto` | `DEVTO_API_KEY` | dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key. |
| `bluesky` | `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD` | Your handle (such as `alice.bsky.social`) and an app password from Bluesky → Settings → Privacy and security → App passwords. Never your account password. Accounts hosted by Bluesky only. |

A connector without its variables (or, for one that accepts [alternatives](#required-credentials), without one complete set of them) still starts and lists its tools; each call then answers with the variables to set. A connector whose service signs in with OAuth reads a current access token from `<VENDOR>_ACCESS_TOKEN`: get one from your own OAuth app, as the CLI does not refresh it.

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
        "DEVTO_API_KEY": "your-dev-to-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio bluesky \
  --env BLUESKY_IDENTIFIER=alice.bsky.social \
  --env BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
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
        "SERPER_API_KEY": "your-serper-api-key"
      }
    }
  }
}
```

Run several connectors side by side by adding one entry per connector.

## Tools

Every tool carries honest MCP annotations, derived from what it does: a read tool can only send GET requests (or a request that changes nothing, such as a sign-in or a search sent by POST), and each write tool says whether it adds, overwrites or removes. `api_request`, which can do any of these, claims neither read-only nor idempotent.

### serper

| Tool | Kind | What it does |
| --- | --- | --- |
| `web_search` | read | Google results for a query: title, link, snippet, position and date of each result, plus the answer box, knowledge graph, related questions and related searches. Options for country, language and freshness (past hour to past year). |

### devto

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_my_articles` | read | Your drafts and published articles, newest first, with URLs, edit links, tags, page views, reactions and comments. |
| `create_draft_article` | create | Saves an unpublished draft: title, Markdown body, up to 4 tags, cover image, canonical URL, series, organization, and the AI disclosure dev.to asks for. Nothing becomes public. |
| `update_article` | update | Publishes a draft, turns an article back into a draft, or changes its fields. Only the fields given change. |
| `api_get` | read | Any other GET of the dev.to API under `/api/`: followers, comments, reading list, organizations and more. |
| `api_request` | write | A POST, PUT or DELETE to the dev.to API under `/api/`, such as a reaction. Sent once, never retried. |

### bluesky

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_profile` | read | A profile with its counts; the connected account by default. |
| `list_my_posts` | read | Your recent posts with likes, reposts, replies and quotes. |
| `create_post` | create | Posts right away: up to 300 characters, with links, mentions and hashtags made clickable, and optionally one JPEG, PNG or WebP image from a public https URL with alt text. |
| `api_get` | read | Any XRPC query (GET) with your session, such as `app.bsky.feed.getTimeline` or `app.bsky.notification.listNotifications`. |
| `api_request` | write | Any XRPC procedure (POST with a JSON body), such as `com.atproto.repo.deleteRecord`. Sent once, never retried. Account, session and identity methods are left out. |

## How it works

A connector is one CommonJS file, `dist/vendors/<vendor>.js`, built from `src/vendors/<vendor>/`. It uses web-standard globals only (no `require`, no Node APIs), so a host can load it without `node_modules`:

```js
module.exports = {
  vendor: 'devto',                 // ^[a-z][a-z0-9-]{1,29}$
  origins: ['https://dev.to'],     // the fixed API origins it calls
  originFields: [],                // credentials that hold a site or instance URL, e.g. ['instance_url']
  credentials: ['api_key'],        // the names it reads from ctx.credentials
  requiredCredentials: [['api_key']], // what a call needs: every credential of one of these lists
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
const credentials = { api_key: process.env.DEVTO_API_KEY };
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

A connector whose service signs in with OAuth declares the credential `access_token`. The host passes its current access token there on every call and refreshes it on its own; a module never refreshes, stores or logs it, and an expired token comes back as a plain 401 error. In the CLI, `access_token` comes from `<VENDOR>_ACCESS_TOKEN`, as it is; when set, the CLI passes it along even to a connector that does not require it.

### Required credentials

`requiredCredentials` says which credentials a call needs, as alternatives: a call goes ahead when every credential of at least one list has a value. By default there is one list with every credential, so all of them are required. A service that takes either an OAuth access token or a long-lived token from its settings declares both lists, `[["access_token"], ["system_user_token"]]`, and a credential that is in no list, such as a value only some calls use, is optional. Without a complete list, a call sends nothing and answers that the connector is not connected, naming what each alternative still lacks: "Example is not connected: it needs the Example access token, or the Example system user token." A host can read the lists to tell whether a connection is complete before it calls anything. The CLI reads every declared variable and needs one complete list; `--list` prints the alternatives of a connector that has them.

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

In the CLI, set `CONNECTOR_ACCOUNTS` to that JSON, keyed by the account keys `--list` prints, to apply a lock; without it there is none. None of the current connectors takes an account argument yet.

## Security

- **Credentials are never stored or logged.** They arrive with each call, from your environment in the CLI. The only things kept in memory are short-lived tokens, keyed by a SHA-256 hash of the credentials: a Bluesky session for up to 10 minutes, because Bluesky allows only 30 sign-ins per 5 minutes and 300 per day, and, for a connector that signs in with a Google service account, its access token until 5 minutes before it expires. Keys that sign their own tokens (Google service accounts, App Store Connect) are used with WebCrypto in memory and never leave the call. Log lines carry the connector, tool, HTTP method, status and duration, never arguments, credentials or content.
- **Origin lock.** A connector only reaches its declared origins and, for a service at an address the user chooses, the https origin of that address; the host refuses any other API URL.
- **SSRF guard on media and user-chosen sites.** A media URL must be https, must resolve to public addresses only (no loopback, private, link-local, carrier-grade NAT or reserved ranges, IPv4 and IPv6 alike), and every redirect is checked the same way, at most 5; no credential header is sent with it. An API request to a [credential origin](#credential-origins) passes the same address checks, and its redirects are never followed. Either way, the connection goes to the address that was checked.
- **Limits.** Requests time out after 30 seconds, API replies are capped at 8 MiB by the CLI and 4 MiB by the modules, and media downloads at 25 MiB (Bluesky images at 2,000,000 bytes).
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
