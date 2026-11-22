// Which credentials a call needs. A module may name them as alternatives
// (requiredCredentials): a call goes ahead when every credential of at least
// one list has a value. The core and the CLI host decide it with these
// helpers, so they agree on when a connector is connected. Web-standard
// globals only: the connector modules bundle this file, and the CLI host
// compiles it too.

type Lists = ReadonlyArray<ReadonlyArray<string>>;

/**
 * A module's alternatives: its requiredCredentials, or one list of every
 * credential when it names none (a module built before they existed).
 */
export function requiredAlternatives(module: { credentials: readonly string[]; requiredCredentials?: Lists }): string[][] {
  return (module.requiredCredentials ?? [module.credentials]).map((list) => [...list]);
}

/**
 * What each alternative still lacks, or [] when one of them is complete. An
 * alternative that lacks everything another one lacks, and more, is left out
 * (and of two that lack the same, the first is kept), so each list returned
 * is a smallest set of credentials that would complete the connection.
 */
export function unmetAlternatives(alternatives: Lists, has: (name: string) => boolean): string[][] {
  const lacking = alternatives.map((list) => list.filter((name) => !has(name)));
  if (lacking.some((list) => list.length === 0)) return [];
  return lacking.filter((list, index) => !lacking.some((other, otherIndex) => otherIndex !== index
    && other.every((name) => list.includes(name))
    && (other.length < list.length || otherIndex < index)));
}

/** "A", "A and B", "A, B and C". */
export function andList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "A", "A, or B", "A, B, or C": alternatives in plain words. */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}
