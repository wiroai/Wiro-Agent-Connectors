import { allowedAccounts, requireAccounts, sha256Hex, ToolFailure, type ToolHelpers } from '../../core/index.js';
import { googleApi } from './google.js';

// Which channel a call works on, and the channel lock. A sign-in acts as one
// channel (the "mine" channel): every write lands on it, so with a channel
// choice in place a write needs that channel chosen. That channel is kept in
// memory for 10 minutes, keyed by a SHA-256 hash of the access token.

const OWN_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED = 64;
const ownChannels = new Map<string, { id: string; expiresAt: number }>();

/** The channel the connection's sign-in acts as. */
export async function ownChannel(h: ToolHelpers): Promise<string> {
  const key = await sha256Hex(h.credentials['access_token'] ?? '');
  const cached = ownChannels.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.id;
  ownChannels.delete(key);
  const { data } = await googleApi(h, { path: '/youtube/v3/channels', query: { part: 'id', mine: true } });
  const id = data?.items?.[0]?.id;
  if (typeof id !== 'string' || !id) {
    throw new ToolFailure('The connected Google account has no YouTube channel: create one on YouTube, then connect again.');
  }
  const now = Date.now();
  for (const [other, entry] of ownChannels) if (entry.expiresAt <= now) ownChannels.delete(other);
  while (ownChannels.size >= MAX_CACHED) {
    const oldest = ownChannels.keys().next().value;
    if (oldest === undefined) break;
    ownChannels.delete(oldest);
  }
  ownChannels.set(key, { id, expiresAt: now + OWN_TTL_MS });
  return id;
}

/** With a channel choice in place, refuses the call unless the sign-in's own channel is chosen. */
export async function requireOwnChannel(h: ToolHelpers): Promise<void> {
  if (allowedAccounts(h.ctx.accounts, 'channels') === null) return;
  requireAccounts(h.ctx.accounts, 'channels', await ownChannel(h), 'channel');
}

/**
 * The channel a channel-scoped tool works on: channel_id when given (it must
 * be chosen), else the only chosen channel, or without a choice the
 * sign-in's own channel.
 */
export async function resolveChannel(h: ToolHelpers, channelId: string | undefined): Promise<string> {
  if (channelId) {
    requireAccounts(h.ctx.accounts, 'channels', channelId, 'channel');
    return channelId;
  }
  const allowed = allowedAccounts(h.ctx.accounts, 'channels');
  if (allowed !== null) {
    if (allowed.length === 1) return allowed[0] as string;
    if (!allowed.length) throw new ToolFailure('No YouTube channel is chosen for this connection yet. Nothing was sent.');
    throw new ToolFailure(`Several channels are chosen for this connection (${allowed.join(', ')}): give channel_id. Nothing was sent.`);
  }
  return ownChannel(h);
}
