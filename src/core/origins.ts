// Credential origins: a module may name credentials whose value is a site or
// instance URL (a Mastodon instance, a WordPress site, a shop). The core and
// every host turn such a value into an https origin with this one rule, so
// they agree on where a call may go. Web-standard globals only: the connector
// modules bundle this file, and the CLI host compiles it too.

export type SiteUrl =
  | { ok: true; url: URL; origin: string }
  | { ok: false; problem: string };

/**
 * Reads a site or instance URL from a credential value: "mastodon.social",
 * "https://mastodon.social" and "https://example.com/blog/" are all accepted,
 * and a value without a scheme gets https. It must be https and carry no user
 * name or password. On failure, `problem` completes a sentence such as "the
 * instance URL <problem>".
 */
export function parseSiteUrl(value: string): SiteUrl {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { ok: false, problem: 'is empty' };
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: 'is not a valid address (expected one like https://example.com)' };
  }
  if (url.protocol !== 'https:') return { ok: false, problem: `must be an https address, not ${url.protocol}//` };
  if (url.username || url.password) return { ok: false, problem: 'must not contain a user name or password' };
  if (!url.hostname) return { ok: false, problem: 'has no host name' };
  return { ok: true, url, origin: url.origin };
}

/** The https origin of a site or instance URL, or undefined when parseSiteUrl refuses it. */
export function siteOrigin(value: string): string | undefined {
  const site = parseSiteUrl(value);
  return site.ok ? site.origin : undefined;
}
