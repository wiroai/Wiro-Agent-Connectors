# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: open this repository's **Security** tab and click **Report a vulnerability**, or go to <https://github.com/wiroai/Wiro-Agent-Connectors/security/advisories/new>. Only the maintainers can read the report.

Please do not open a public issue, pull request or discussion about a vulnerability.

A good report has:

- the connector and tool, and the package version;
- what an attacker can do, and the steps to reproduce it;
- a proof of concept if you have one, without real credentials or personal data.

We will acknowledge your report, keep you posted while we fix it, and credit you in the advisory if you would like that.

## What is in scope

The connector modules (`src/vendors/`), the shared runtime they bundle (`src/core/`), the stdio CLI and host code (`src/cli.ts`, `src/host/`), and the published npm package. We are especially interested in:

- a way past the origin lock or the SSRF guard, such as reaching a private, loopback or link-local address, or an origin a connector did not declare;
- a credential, argument or piece of content that ends up in a log line, a result or an error message;
- a write sent more than once;
- an account-scoped call that gets past the account lock.

Vulnerabilities in the services the connectors talk to, or in MCP clients, belong to their owners.

## Supported versions

Security fixes go into the latest release.
