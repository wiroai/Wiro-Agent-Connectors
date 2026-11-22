// Bundles every connector into one dependency-free CommonJS file:
//   src/vendors/<vendor>/index.ts  ->  dist/vendors/<vendor>.js
// and, for the tests only, the template and the shared core:
//   src/vendors/_template/index.ts ->  build/template.js
//   src/core/index.ts              ->  build/core.js
// Then it checks each module: nothing forbidden in the code, it loads with
// web-standard globals only, and it exports the module interface.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { forbiddenIn, loadSandboxed } from './module-sandbox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorsSrc = path.join(root, 'src', 'vendors');
const VENDOR_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

async function bundle(entry, outfile, banner) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // "neutral" knows no Node built-ins, so importing one fails the build.
    platform: 'neutral',
    format: 'cjs',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: banner },
  });
}

function check(file, expectedVendor) {
  const relative = path.relative(root, file);
  const code = fs.readFileSync(file, 'utf8');
  const forbidden = forbiddenIn(code);
  if (forbidden.length) throw new Error(`${relative} uses ${forbidden.join(', ')}`);
  const { module } = loadSandboxed(file);
  const problems = [];
  if (module.vendor !== expectedVendor) problems.push(`vendor is ${JSON.stringify(module.vendor)}, expected ${JSON.stringify(expectedVendor)}`);
  if (!Array.isArray(module.origins)) problems.push('no origins list');
  if (!Array.isArray(module.originFields)) problems.push('no originFields list');
  else if (!module.origins?.length && !module.originFields.length) problems.push('no origins');
  if (!Array.isArray(module.credentials)) problems.push('no credentials list');
  if (!Array.isArray(module.requiredCredentials) || !module.requiredCredentials.length) problems.push('no requiredCredentials list');
  if (!Array.isArray(module.accountPickers)) problems.push('no accountPickers list');
  if (!Array.isArray(module.tools) || !module.tools.length) problems.push('no tools');
  if (typeof module.call !== 'function') problems.push('no call function');
  if (problems.length) throw new Error(`${relative}: ${problems.join('; ')}`);
  return module;
}

const entries = (fs.existsSync(vendorsSrc) ? fs.readdirSync(vendorsSrc, { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(vendorsSrc, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .sort();

const built = [];
for (const name of entries) {
  const entry = path.join(vendorsSrc, name, 'index.ts');
  if (name === '_template') {
    const outfile = path.join(root, 'build', 'template.js');
    await bundle(entry, outfile, '/* The connector template, built for its own test. Not shipped. */');
    check(outfile, 'example');
    continue;
  }
  if (name.startsWith('_')) continue;
  if (!VENDOR_PATTERN.test(name)) throw new Error(`src/vendors/${name}: a vendor folder name must match ${VENDOR_PATTERN}`);
  const outfile = path.join(root, 'dist', 'vendors', `${name}.js`);
  await bundle(entry, outfile, `/* ${name} connector module (MIT License). Built from src/vendors/${name}; do not edit. */`);
  const module = check(outfile, name);
  built.push(`${name} (${module.tools.length} tool${module.tools.length === 1 ? '' : 's'})`);
}

await build({
  entryPoints: [path.join(root, 'src', 'core', 'index.ts')],
  outfile: path.join(root, 'build', 'core.js'),
  bundle: true,
  platform: 'neutral',
  format: 'cjs',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});

process.stdout.write(`Built ${built.length} connector module${built.length === 1 ? '' : 's'} into dist/vendors: ${built.join(', ')}\n`);
