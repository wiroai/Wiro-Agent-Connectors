// Upload hosts: a module may name the hosts its API's own upload addresses
// are on (pre-signed part addresses such as App Store Connect's
// store-030.blobstore.apple.com, which change per upload), in uploadHosts. The
// core checks the list when the module loads, and every host matches an
// address against it with this one rule. Web-standard globals only: the
// connector modules bundle this file, and the CLI host compiles it too.

/** One DNS label: lowercase letters, digits and inner hyphens, 1 to 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * What is wrong with an uploadHosts entry, completing a sentence such as
 * "upload host X <problem>", or undefined when it is a good one: a lowercase
 * host name of at least two labels ("uploads.example.com"), or the same with a
 * leading dot for every host under it (".blobstore.apple.com").
 */
export function uploadHostProblem(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return 'must be a host name';
  const name = entry.startsWith('.') ? entry.slice(1) : entry;
  const labels = name.split('.');
  if (name.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return 'must be a lowercase host name like uploads.example.com, or one with a leading dot like .example.com for every host under it';
  }
  if (labels.length < 2) return 'needs at least two labels, like example.com';
  if (/^[0-9]+$/.test(labels[labels.length - 1] as string)) return 'must be a host name, not an IP address';
  return undefined;
}

/**
 * Whether a URL's host name is on one of a module's upload hosts. An entry
 * with a leading dot matches every host under it (".blobstore.apple.com"
 * matches store-030.blobstore.apple.com, never blobstore.apple.com itself or
 * evil-blobstore.apple.com); any other entry matches that host only. The name
 * is compared in lower case, without a trailing dot.
 */
export function isUploadHost(hostname: string, uploadHosts: readonly string[]): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return uploadHosts.some((entry) => (entry.startsWith('.') ? name.length > entry.length && name.endsWith(entry) : name === entry));
}
