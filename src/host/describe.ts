// What `--list` prints for each connector, and how the CLI names the
// variables a connector still needs.

import { andList, orList, requiredAlternatives } from '../core/credentials.js';
import type { ConnectorModule } from '../types.js';
import { envNameFor } from './env.js';

/** The variables of each alternative in plain words: "A", "A and B", "A, or B". */
export function describeNeeded(needed: ReadonlyArray<ReadonlyArray<string>>): string {
  return orList(needed.map((list) => andList(list)));
}

/**
 * A connector's entry in `--list`: its environment variables, which of them a
 * call needs when that is not all of them, its tools, and its account pickers.
 * The CLI maps no variable to a picker: accounts are chosen in
 * CONNECTOR_ACCOUNTS, under the pickers' keys.
 */
export function describeConnector(module: ConnectorModule): string {
  const variables = (names: readonly string[]): string[] => names.map((name) => envNameFor(module.vendor, name));
  const rows: Array<[string, string[]]> = [['env', [variables(module.credentials).join(', ') || '(none)']]];

  const alternatives = requiredAlternatives(module);
  const [only] = alternatives;
  const all = alternatives.length === 1 && only !== undefined
    && only.length === module.credentials.length && module.credentials.every((name) => only.includes(name));
  if (!all) {
    rows.push(['needs', [alternatives.some((list) => !list.length) ? 'nothing (every variable is optional)' : describeNeeded(alternatives.map(variables))]]);
  }

  rows.push(['tools', [module.tools.map((tool) => tool.name).join(', ')]]);

  const pickers = module.accountPickers ?? [];
  if (pickers.length) {
    rows.push(['accounts', pickers.map((picker) => `${picker.key} (${picker.label}, ${picker.multiple ? 'one or more' : 'one'}, listed by ${picker.tool})`)]);
  }

  // Labels line up within an entry: "env:   " and "tools: " as before, wider only with accounts.
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = rows.flatMap(([label, values]) => values.map((value, index) => `  ${(index === 0 ? `${label}:` : '').padEnd(width)}${value}`));
  return [module.vendor, ...lines].join('\n');
}
