# Contributing

Thanks for helping! The most useful contribution is a new connector: one service that has no official MCP server, made reachable for every agent. Fixes, tests and docs are just as welcome.

By contributing you agree that your work is released under the [MIT License](./LICENSE), and to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- Check that the service has no official MCP server, or say in your pull request what its server lacks.
- For a larger change, or if you are not sure a connector fits, open a [new connector request](https://github.com/wiroai/Wiro-Agent-Connectors/issues/new?template=new_connector.yml) first.
- Never put a real key, password, token or personal data in code, fixtures, issues or pull requests.

## Adding a connector, step by step

1. **Set up.** Fork the repository, then:

   ```bash
   git clone https://github.com/<you>/Wiro-Agent-Connectors.git
   cd Wiro-Agent-Connectors
   npm ci
   npm test
   ```

2. **Copy the template.** The folder name is the connector's name (`^[a-z][a-z0-9-]{1,29}$`, e.g. `acme`):

   ```bash
   cp -r src/vendors/_template src/vendors/acme
   mv src/vendors/acme/template.test.mjs src/vendors/acme/acme.test.mjs
   ```

3. **Describe the service** at the top of `src/vendors/acme/index.ts`: what it is, which credentials it needs and where a user gets them. Then fill in the definition:
   - `vendor`: the folder name.
   - `label`: the service's own name. Every message uses it.
   - `origins`: the exact https origins of its API, e.g. `["https://api.acme.com"]`. The host refuses every other API URL.
   - `originFields`, only when the API lives at an address the user gives (a Mastodon instance, a WordPress site, a shop): the credentials that hold it, e.g. `["instance_url"]`. Each call may then reach the https origin of that value, with `h.api({ origin: h.originOf("instance_url"), path })`, or with `h.api({ path })` when `origins` is empty. The core and every host resolve the value the same way (`parseSiteUrl`), and hosts check the address like a media URL and never follow its redirects. Leave these values alone in `normalizeCredentials`: the origin is read from the value as given.
   - `credentials`: the names the module reads, in snake_case. The CLI reads each one from `<VENDOR>_<CREDENTIAL>`, e.g. `ACME_API_KEY`. Add `credentialLabels` for the messages.
   - `authHeaders`: how the credentials go on each API request.

4. **Write the tools.** Each tool is one API call, or a short fixed sequence such as upload then publish.
   - Pick its `kind`: `read`, `create` (adds something; twice adds two), `update` (overwrites; twice changes nothing more) or `delete`. The MCP annotations follow from it, so they are true.
   - Give it an `inputSchema` with `additionalProperties: false`, a clear title, and a description that says what it does, what it returns, and any limit or cost the user should know.
   - In `run(args, h)`, send requests with `h.api({ method, path, query, json })`. Errors become clear tool errors on their own (a 429 carries `retryAfter`); `errors: { 404: "..." }` gives a status a better sentence.
   - On a write tool, mark the one request that makes the change with `write: true` and name a read tool in `check`. When that request gets no clear answer, the result says the outcome is unknown and points at `check`.
   - Return only the fields an agent needs. Return lists with `h.page({ key, items, resumeAt, nextPage })` and take a `cursor` argument: results stay under 32 KB and continue where they were cut.
   - Files by URL (an image to post) come through `h.media(url, { what, maxBytes })`. Check the vendor's own type and size limits, and tell file types from the bytes, not the server's Content-Type.
   - Arguments that pick one of several accounts (a page, an ad account) go through `requireAccounts(h.ctx.accounts, key, id)` before any request.
   - If the service needs a sign-in, keep the session in memory for a short time, keyed by a hash of the credentials, and respect its sign-in limits. `src/vendors/bluesky/session.ts` does this.

5. **Record responses.** Save real responses of the service under `src/vendors/acme/fixtures/`, with personal data, ids and tokens replaced by examples.

6. **Write the tests** in `acme.test.mjs`, with the helpers from `tests/helpers.mjs` and a fake `ctx.fetch`; tests never touch the network. Cover at least:
   - the request each tool sends: method, URL, headers, body;
   - how each result is trimmed, and paging with the cursor;
   - the error mapping, a 429 with `retryAfter` included;
   - for each write tool, the unknown outcome, with exactly one request sent;
   - that log lines carry no credentials and no arguments.

7. **Add a smoke plan**, `src/vendors/acme/smoke.json`: one read step, and a write step with a note on how to undo it. Maintainers run it against the real service with `npm run smoke -- acme`.

8. **Document it** in the README: a row in the Connectors table, its environment variables in the Quick start table, and a Tools table. A test checks that every variable and tool name appears there.

9. **Check everything:**

   ```bash
   npm run typecheck
   npm test
   npm run smoke -- acme   # optional, with your own test account
   ```

10. **Open a pull request** and fill in its checklist.

## Rules for connector modules

The build and the tests enforce most of these, so `npm test` tells you early.

- **No runtime dependencies.** A module imports only from `src/core` and its own folder: no npm package and no Node module. The build bundles it into one file, `dist/vendors/<vendor>.js`, and fails on anything else.
- **All HTTP goes through `ctx.fetch`**, by way of `h.api` and `h.media`. Never call `fetch` yourself, and use no `console`, `process` or `Buffer`: stdout belongs to the MCP protocol, and modules run on web-standard globals only. Tests run every module in a sandbox that has none of them.
- **Declare origins and credentials.** `origins` lists exactly the fixed API origins the module calls, `originFields` the credentials that hold an API address the user chooses, and `credentials` every credential it reads.
- **Honest annotations.** Choose the kind that matches what the tool does. A read tool can only send GET requests; a non-GET request that changes nothing (a sign-in, a search sent by POST) is marked `safe: true`.
- **No write retries.** Nothing is retried, writes least of all; an unclear write outcome is reported as unknown, with the read tool to check.
- **Tool texts name only the service.** No other product, company or brand in tool names, titles, descriptions, results or error messages. A test scans every module and every error it can return.
- **Never expose secrets.** No credential, argument or content in log lines, results or error messages. The shared runtime logs the connector, tool, method, status and duration for you.
- **Mocked HTTP only in tests**, with recorded responses.
- **Plain, accurate English** in descriptions and messages: say what happened and what to do next.

## Other changes

Keep pull requests focused, add or update tests with every behavior change, and run `npm run typecheck` and `npm test` before you push. Commit messages start with a type, such as `feat:`, `fix:`, `docs:`, `test:` or `chore:`, and say why the change is made.

## Pull request checklist

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] The module imports nothing but `src/core` and its own folder.
- [ ] Every request goes through `h.api` or `h.media`; `origins` lists exactly the API origins, and `originFields` every credential that holds an API address.
- [ ] `credentials` lists every credential, and the README documents its environment variables.
- [ ] Each tool has the kind that matches what it does, so its annotations are true.
- [ ] Write tools mark their change with `write: true`, name a `check` read tool, and retry nothing.
- [ ] Results are trimmed to what an agent needs; lists use `h.page` and a cursor.
- [ ] Tool names, descriptions and messages name only the service.
- [ ] No credentials, arguments or content in logs, results or errors.
- [ ] Tests use recorded responses and a fake `ctx.fetch`: request shape, trimming, errors including 429, unknown outcome for writes.
- [ ] `smoke.json` has a read step (and a write step with a note on how to undo it).
- [ ] The README lists the connector, its environment variables and its tools.
