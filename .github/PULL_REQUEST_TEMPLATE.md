## What this changes

<!-- One or two sentences. For a new connector: the service, and what its tools do. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] The module imports nothing but `src/core` and its own folder (no npm packages, no Node modules).
- [ ] Every request goes through `h.api` or `h.media`; `origins` lists exactly the API origins.
- [ ] `credentials` lists every credential, and the README documents its environment variables.
- [ ] Each tool has the kind that matches what it does (read, create, update, delete), so its annotations are true.
- [ ] Write tools mark their change with `write: true`, name a `check` read tool, and retry nothing.
- [ ] Results are trimmed to what an agent needs; lists use `h.page` and a cursor.
- [ ] Tool names, descriptions and messages name only the service: no other brand.
- [ ] No credentials, arguments or content in logs, results or errors.
- [ ] Tests use recorded responses (with personal data replaced) and a fake `ctx.fetch`: request shape, trimming, errors including 429, unknown outcome for writes.
- [ ] `smoke.json` has a read step (and a write step with a note on how to undo it).
- [ ] The README lists the connector, its environment variables and its tools.
- [ ] Optional: I ran `npm run smoke -- <vendor>` with my own test account.
