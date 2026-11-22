import fs from 'node:fs';
import path from 'node:path';
import type { ConnectorModule } from '../types.js';

export const VENDOR_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

/** dist/vendors, next to this package's dist/host. */
export const DEFAULT_VENDORS_DIR = path.resolve(__dirname, '..', 'vendors');

export function listVendors(dir = DEFAULT_VENDORS_DIR): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.slice(0, -3))
    .filter((name) => VENDOR_PATTERN.test(name))
    .sort();
}

/** Throws unless the value looks like a connector module for `vendor`. */
export function assertConnectorModule(value: unknown, vendor: string): asserts value is ConnectorModule {
  const module = value as Partial<ConnectorModule> | null;
  const problems: string[] = [];
  if (!module || typeof module !== 'object') problems.push('it exports no object');
  else {
    if (module.vendor !== vendor) problems.push(`vendor is ${JSON.stringify(module.vendor)}`);
    // A module built before originFields existed has none.
    const originFields: unknown = module.originFields ?? [];
    if (!Array.isArray(module.origins)) problems.push('origins is missing');
    if (!Array.isArray(originFields)) problems.push('originFields is not a list');
    else if (Array.isArray(module.origins) && !module.origins.length && !originFields.length) problems.push('it names no origins');
    if (!Array.isArray(module.credentials)) problems.push('credentials is missing');
    else if (Array.isArray(originFields) && originFields.some((name) => !module.credentials?.includes(name))) {
      problems.push('an origin field is not one of its credentials');
    }
    if (!Array.isArray(module.tools)) problems.push('tools is missing');
    if (typeof module.call !== 'function') problems.push('call is missing');
  }
  if (problems.length) throw new Error(`${vendor}.js is not a connector module: ${problems.join(', ')}.`);
}

/**
 * Loads dist/vendors/<vendor>.js. The name must match the vendor pattern, and
 * the file must really be inside the directory (no "..", no symlink out).
 */
export function loadConnector(vendor: string, dir = DEFAULT_VENDORS_DIR): ConnectorModule {
  if (!VENDOR_PATTERN.test(vendor)) throw new Error(`"${vendor}" is not a connector name.`);
  const root = fs.realpathSync(dir);
  let file: string;
  try {
    file = fs.realpathSync(path.join(root, `${vendor}.js`));
  } catch {
    throw new Error(`There is no connector named "${vendor}".`);
  }
  if (path.dirname(file) !== root) throw new Error(`There is no connector named "${vendor}".`);
  const module: unknown = require(file);
  assertConnectorModule(module, vendor);
  return module;
}
