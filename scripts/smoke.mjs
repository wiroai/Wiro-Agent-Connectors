// A live smoke test of one connector against the real service, for a person
// with a test account. It is never part of npm test or CI.
//
//   npm run build
//   npm run smoke -- <vendor>            one read
//   npm run smoke -- <vendor> --write    one read, then one write
//
// Credentials come from the environment (<VENDOR>_<CREDENTIAL>), or from a
// .env file in the repository root. The steps are src/vendors/<vendor>/smoke.json;
// "{{timestamp}}" in their arguments becomes the current time.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [vendor, ...flags] = process.argv.slice(2);

if (!vendor || vendor.startsWith('-')) {
  process.stderr.write('Usage: npm run smoke -- <vendor> [--write]\n');
  process.exit(1);
}

const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let host;
try {
  host = require(path.join(root, 'dist', 'host', 'index.js'));
} catch {
  process.stderr.write('Run npm run build first.\n');
  process.exit(1);
}

const module = host.loadConnector(vendor);
const plan = JSON.parse(fs.readFileSync(path.join(root, 'src', 'vendors', vendor, 'smoke.json'), 'utf8'));
const { credentials, missing } = host.credentialsFromEnv(module, process.env);
if (missing.length) {
  process.stderr.write(`Set ${missing.join(' and ')} (in the environment or .env) first.\n`);
  process.exit(1);
}
const accounts = host.accountsFromEnv(process.env);
const fetch = host.createGuardedFetch({ origins: module.origins, credentialOrigins: host.originsFromCredentials(module, credentials) });
const now = new Date().toISOString();
const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('{{timestamp}}', now));

async function run(label, step) {
  const started = Date.now();
  const result = await module.call(step.tool, fill(step.args ?? {}), {
    credentials,
    accounts,
    fetch,
    log: (line) => process.stderr.write(`  ${line}\n`),
  });
  const text = result.content?.[0]?.text ?? '';
  process.stdout.write(`${label} ${step.tool}: ${result.isError ? 'ERROR' : 'ok'} (${Date.now() - started}ms)\n`);
  process.stdout.write(`${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}\n\n`);
  return !result.isError;
}

let ok = await run('read', plan.read);
if (flags.includes('--write')) {
  if (!plan.write) {
    process.stdout.write(`${vendor} has no write step.\n`);
  } else {
    if (plan.write.note) process.stdout.write(`Note: ${plan.write.note}\n`);
    ok = (await run('write', plan.write)) && ok;
  }
}
process.exitCode = ok ? 0 : 1;
