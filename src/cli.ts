#!/usr/bin/env node
// wiro-agent-connectors <vendor>: serves one connector over stdio, with the
// vendor's credentials read from the environment.

import { accountsFromEnv, credentialsFromEnv, envNameFor, listVendors, loadConnector, serveStdio } from './host/index.js';

// The package version, for the MCP server info and --version.
const { version } = require('../package.json') as { version: string };

const USAGE = `Usage: wiro-agent-connectors <vendor>

Serves one connector as an MCP server over stdio. Each connector reads its
credentials from environment variables named <VENDOR>_<CREDENTIAL>.

Options:
  --list       List the connectors with their tools and environment variables
  --version    Print the version
  --help       Print this help`;

function describeVendors(): string {
  return listVendors()
    .map((vendor) => {
      const module = loadConnector(vendor);
      const env = module.credentials.map((name) => envNameFor(vendor, name)).join(', ');
      return `${vendor}\n  env:   ${env || '(none)'}\n  tools: ${module.tools.map((tool) => tool.name).join(', ')}`;
    })
    .join('\n\n');
}

async function main(argv: string[]): Promise<void> {
  const [first] = argv;
  if (!first || first === '--help' || first === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (!first) process.exitCode = 1;
    return;
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (first === '--list') {
    process.stdout.write(`${describeVendors()}\n`);
    return;
  }

  let module;
  try {
    module = loadConnector(first);
  } catch (error) {
    process.stderr.write(`${(error as Error).message} Available: ${listVendors().join(', ')}.\n`);
    process.exitCode = 1;
    return;
  }

  const { credentials, missing } = credentialsFromEnv(module, process.env);
  const accounts = accountsFromEnv(process.env);
  if (missing.length) {
    process.stderr.write(`${module.vendor}: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set; tools will answer with an error until ${missing.length > 1 ? 'they are' : 'it is'}.\n`);
  }
  await serveStdio(module, {
    credentials,
    accounts,
    version,
    ...(missing.length
      ? { missingCredentials: `This server has no credentials for ${module.vendor}: set ${missing.join(' and ')} in its environment and restart it.` }
      : {}),
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
