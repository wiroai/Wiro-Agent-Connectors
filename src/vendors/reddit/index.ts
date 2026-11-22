// Reddit, through the Reddit Data API on https://oauth.reddit.com with the
// OAuth token of the account that signed in to the customer's own Reddit web
// app (scopes identity, read, mysubreddits, submit, edit and history).
//
// Credentials:
// - `access_token`: the current OAuth access token. The host refreshes it (it
//   lasts an hour); this module never does.
// - `developerprofileusername`: the Reddit username of the developer profile
//   that owns the app. Reddit asks every request to name it in the
//   User-Agent: "server:agent-connectors:1.0 (by /u/<name>)".
// - `redditusername` (optional): the connected account's username, as the host
//   wrote it after the sign-in. Used to list the account's own posts without
//   asking Reddit first; ownership checks always ask Reddit.
//
// Scope, as Reddit's terms for this kind of app ask: the connected identity,
// its communities, one community's rules, one text or link post, one comment
// or reply, and edits and deletes of the account's own posts and comments.
// No voting, messages, moderation, crossposting or bulk posting. Every
// request goes through guard.ts (rate window, one at a time) and every post,
// comment, edit and delete through its ledger (no duplicates, no repeats
// across communities, nothing sent twice after an unclear outcome).

import { apiTools, cleanVendorText, defineConnector, OutcomeUnknown, ToolFailure, truncate, utf8Bytes, type ApiRequest, type ToolHelpers } from '../../core/index.js';
import {
  checkMutation,
  describeMutation,
  forgetThing,
  noteWriteLimit,
  normalizeText,
  normalizeUrl,
  rateInfo,
  recordMutation,
  redditRequest,
  type LedgerCheck,
  type Mutation,
} from './guard.js';

const SUBREDDIT = '^(?:/?r/)?[A-Za-z0-9][A-Za-z0-9_]{1,20}$';
const FULLNAME = '^t[13]_[a-z0-9]{1,13}$';
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;
const MAX_TITLE = 300;
const MAX_TEXT = 40000;
const MAX_COMMENT = 10000;

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function bareName(value: string): string {
  return value.replace(/^\/?u\//i, '').replace(/^@/, '');
}

function subredditName(value: string): string {
  return value.replace(/^\/?r\//i, '');
}

function userAgent(developer: string): string {
  return `server:agent-connectors:1.0 (by /u/${developer})`;
}

function permalink(path: unknown): string | undefined {
  return typeof path === 'string' && path.startsWith('/') ? `https://www.reddit.com${path}` : undefined;
}

function isoTime(seconds: unknown): string | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function form(values: Record<string, string | boolean | undefined>): Pick<ApiRequest, 'body' | 'contentType'> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return { body: utf8Bytes(params.toString()), contentType: 'application/x-www-form-urlencoded' };
}

/** Checks the developer profile username before anything is sent: Reddit's User-Agent names it. */
function checkDeveloper(h: ToolHelpers): void {
  if (!USERNAME.test(h.credentials['developerprofileusername'] ?? '')) {
    throw new ToolFailure(
      'The Reddit developer profile username must be the 3 to 20 letters, digits, - or _ of the account that owns the app, without u/. Nothing was sent to Reddit.',
    );
  }
}

async function reddit(h: ToolHelpers, request: ApiRequest): Promise<any> {
  checkDeveloper(h);
  const { data } = await redditRequest(h, request);
  return data;
}

function trimThing(child: any): Record<string, unknown> {
  const data = child?.data ?? {};
  if (child?.kind === 't1') {
    return compact({
      id: data.name,
      type: 'comment',
      subreddit: data.subreddit,
      author: data.author,
      postId: data.link_id,
      parentId: data.parent_id,
      postTitle: typeof data.link_title === 'string' ? truncate(data.link_title, 300) : undefined,
      url: permalink(data.permalink),
      text: typeof data.body === 'string' ? truncate(data.body, 500) : undefined,
      score: data.score,
      createdAt: isoTime(data.created_utc),
      edited: data.edited ? true : undefined,
    });
  }
  if (child?.kind === 't3') {
    return compact({
      id: data.name,
      type: 'post',
      subreddit: data.subreddit,
      author: data.author,
      title: typeof data.title === 'string' ? truncate(data.title, 300) : undefined,
      url: permalink(data.permalink),
      link: data.is_self ? undefined : data.url,
      text: data.is_self && typeof data.selftext === 'string' && data.selftext ? truncate(data.selftext, 500) : undefined,
      selfPost: data.is_self,
      score: data.score,
      comments: data.num_comments,
      nsfw: data.over_18 || undefined,
      spoiler: data.spoiler || undefined,
      locked: data.locked || undefined,
      removed: data.removed_by_category ?? undefined,
      createdAt: isoTime(data.created_utc),
      edited: data.edited ? true : undefined,
    });
  }
  return compact({ id: data.name, type: child?.kind });
}

/** The connected account's name: from the credential, or Reddit's /api/v1/me when `live` or none is set. */
async function identity(h: ToolHelpers, live: boolean): Promise<string> {
  const known = h.credentials['redditusername'];
  if (!live && known && USERNAME.test(known)) return known;
  const data = await reddit(h, { path: '/api/v1/me' });
  if (typeof data?.name !== 'string' || !data.name) throw new ToolFailure('Reddit did not say which account is connected. Nothing was changed.');
  return data.name;
}

/** Reddit's JSON errors (HTTP 200 with json.errors): a refused write, or its own write limit. */
async function throwJsonErrors(h: ToolHelpers, data: any, what: string): Promise<void> {
  const errors: unknown[] = Array.isArray(data?.json?.errors) ? data.json.errors.filter(Array.isArray) : [];
  if (!errors.length) return;
  const rate = errors.find((item) => (item as unknown[])[0] === 'RATELIMIT') as unknown[] | undefined;
  if (rate) {
    const stated = typeof data?.json?.ratelimit === 'number' ? data.json.ratelimit : statedDelay(String(rate[1] ?? ''));
    const wait = await noteWriteLimit(h, stated);
    throw new ToolFailure(
      `Reddit asked to slow down before another ${what}${rate[1] ? `: ${cleanVendorText(rate[1], 200)?.replace(/[.!?]+$/, '')}` : ''}. Nothing was changed. `
        + (wait !== undefined ? `Retry after ${wait} seconds, with a fresh approval.` : 'Try again later, with a fresh approval.'),
      { vendorCode: 'RATELIMIT', ...(wait !== undefined ? { retryAfter: wait } : {}) },
    );
  }
  const [code, message, field] = errors[0] as unknown[];
  const said = cleanVendorText(message, 300);
  throw new ToolFailure(
    `Reddit did not accept the ${what} (${String(code)}${field ? `, ${String(field)}` : ''})${said ? `: ${said.replace(/[.!?]+$/, '')}` : ''}. Nothing was changed.`,
    typeof code === 'string' ? { vendorCode: code } : {},
  );
}

/** "try again in 9 minutes", "take a break for 30 seconds" -> seconds. */
function statedDelay(text: string): number | undefined {
  const match = /(\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] as string).toLowerCase();
  return value * (unit === 'hour' ? 3600 : unit === 'minute' ? 60 : 1);
}

/** Runs one mutation under the ledger: in flight before it is sent, then succeeded, failed or ambiguous. */
async function guarded<T>(mutation: Mutation, check: LedgerCheck, send: () => Promise<{ value: T; fullname?: string }>): Promise<T> {
  checkMutation(mutation, check);
  await recordMutation(mutation, 'in_flight');
  try {
    const { value, fullname } = await send();
    await recordMutation(mutation, 'succeeded', fullname);
    return value;
  } catch (error) {
    await recordMutation(mutation, error instanceof ToolFailure ? 'failed' : 'ambiguous');
    throw error;
  }
}

/** One post or comment by its fullname, checked to be the connected account's own. */
async function ownThing(h: ToolHelpers, fullname: string, what: string): Promise<any> {
  const me = await identity(h, true);
  const data = await reddit(h, { path: '/api/info', query: { id: fullname, raw_json: 1 } });
  const children: any[] = Array.isArray(data?.data?.children) ? data.data.children : [];
  const matches = children.filter((child) => child?.data?.name === fullname);
  if (matches.length !== 1) throw new ToolFailure(`Reddit found no post or comment ${fullname}, so there is nothing to ${what}. Nothing was changed.`);
  const item = matches[0];
  const author = typeof item?.data?.author === 'string' ? item.data.author : '';
  if (author.toLowerCase() !== me.toLowerCase()) {
    throw new ToolFailure(`${fullname} is not the connected account's own ${item.kind === 't1' ? 'comment' : 'post'} (or it was already deleted), so it cannot be changed here. Nothing was changed.`);
  }
  return { item, me };
}

const ALLOW_REPEAT = {
  type: 'boolean' as const,
  default: false,
  description: 'Only after an identical earlier attempt had an unknown outcome, the check showed it did not go through, and a new attempt was approved.',
};

interface SubmitArgs {
  subreddit: string;
  kind: 'self' | 'link';
  title: string;
  text?: string;
  url?: string;
  nsfw: boolean;
  spoiler: boolean;
  flair_id?: string;
  flair_text?: string;
  send_replies: boolean;
  allow_repeat_after_check: boolean;
}

const connector = defineConnector({
  vendor: 'reddit',
  label: 'Reddit',
  origins: ['https://oauth.reddit.com'],
  credentials: ['access_token', 'developerprofileusername', 'redditusername'],
  requiredCredentials: [['access_token', 'developerprofileusername']],
  credentialLabels: {
    access_token: 'Reddit access token',
    developerprofileusername: 'Reddit developer profile username',
    redditusername: 'Reddit username',
  },
  normalizeCredentials: (credentials) => {
    for (const name of ['developerprofileusername', 'redditusername']) {
      if (credentials[name]) credentials[name] = bareName(credentials[name] as string);
    }
    return credentials;
  },
  authHeaders: (credentials) => ({
    authorization: `Bearer ${credentials['access_token']}`,
    'user-agent': userAgent(String(credentials['developerprofileusername'] ?? '')),
  }),
  tools: [
    {
      name: 'get_me',
      kind: 'read',
      title: 'Get the connected Reddit account',
      description: 'Returns the connected Reddit account: username, id, karma, account age, and whether its email is verified.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const data = await reddit(h, { path: '/api/v1/me' });
        return compact({
          name: data?.name,
          id: data?.id ? `t2_${data.id}` : undefined,
          url: data?.name ? `https://www.reddit.com/user/${data.name}/` : undefined,
          linkKarma: data?.link_karma,
          commentKarma: data?.comment_karma,
          totalKarma: data?.total_karma,
          createdAt: isoTime(data?.created_utc),
          verifiedEmail: data?.has_verified_email,
          suspended: data?.is_suspended || undefined,
          rateLimit: await rateInfo(h),
        });
      },
    },
    {
      name: 'list_my_subreddits',
      kind: 'read',
      title: 'List my Reddit communities',
      description:
        'Lists the communities the connected account is subscribed to, or those where it is an approved contributor: name, title, '
        + 'subscribers, type and which posts they take. Pass nextCursor back as cursor for more; read only as many pages as the task needs.',
      inputSchema: {
        type: 'object',
        properties: {
          where: { type: 'string', enum: ['subscriber', 'contributor'], default: 'subscriber', description: 'subscriber (default) or contributor.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Communities per page, 1 to 100 (default 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { where: string; limit: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const after = typeof state?.['a'] === 'string' ? state['a'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const where = typeof state?.['w'] === 'string' ? state['w'] : args.where;
        const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
        const data = await reddit(h, { path: `/subreddits/mine/${where}`, query: { limit, after, raw_json: 1 } });
        const children: any[] = Array.isArray(data?.data?.children) ? data.data.children : [];
        const items = children.map((child) => {
          const sub = child?.data ?? {};
          return compact({
            name: sub.display_name,
            title: typeof sub.title === 'string' ? truncate(sub.title, 200) : undefined,
            url: typeof sub.url === 'string' ? `https://www.reddit.com${sub.url}` : undefined,
            subscribers: sub.subscribers,
            type: sub.subreddit_type,
            submissionType: sub.submission_type,
            nsfw: sub.over18 || undefined,
          });
        });
        const next = typeof data?.data?.after === 'string' ? data.data.after : undefined;
        return h.page({
          key: 'subreddits',
          items: items.slice(skip),
          extra: { where, rateLimit: await rateInfo(h) },
          resumeAt: (index) => h.makeCursor({ ...(after ? { a: after } : {}), o: skip + index, w: where, n: limit }),
          ...(next ? { nextPage: h.makeCursor({ a: next, o: 0, w: where, n: limit }) } : {}),
        });
      },
    },
    {
      name: 'get_subreddit_rules',
      kind: 'read',
      title: 'Get a Reddit community\'s rules',
      description:
        'Returns one community\'s rules (name, what they apply to, description) and Reddit\'s site-wide rules. Read them before posting or '
        + 'commenting there: every post must follow both.',
      inputSchema: {
        type: 'object',
        properties: { subreddit: { type: 'string', pattern: SUBREDDIT, description: 'The community name, such as test or r/test.' } },
        required: ['subreddit'],
        additionalProperties: false,
      },
      async run(args: { subreddit: string }, h) {
        const name = subredditName(args.subreddit);
        const data = await reddit(h, {
          path: `/r/${name}/about/rules`,
          query: { raw_json: 1 },
          errors: { 403: 'Reddit refused to show this community\'s rules (it may be private or banned)', 404: 'Reddit found no such community' },
        });
        const rules: any[] = Array.isArray(data?.rules) ? data.rules : [];
        return compact({
          subreddit: name,
          rules: rules.map((rule) => compact({
            name: rule?.short_name,
            appliesTo: rule?.kind,
            description: typeof rule?.description === 'string' && rule.description ? truncate(rule.description, 1000) : undefined,
            violationReason: rule?.violation_reason && rule.violation_reason !== rule.short_name ? rule.violation_reason : undefined,
          })),
          siteRules: Array.isArray(data?.site_rules) ? data.site_rules.map((rule: unknown) => truncate(String(rule), 300)) : undefined,
          rateLimit: await rateInfo(h),
        });
      },
    },
    {
      name: 'submit_post',
      kind: 'create',
      check: 'list_my_posts',
      title: 'Submit a Reddit post',
      description:
        'Submits one text or link post to one community, after its rules were read with get_subreddit_rules. nsfw and spoiler must be set '
        + 'on purpose. Reddit never gets the same post twice from here: an identical post that went through in the last 48 hours, the '
        + 'same text in another community, and a repeat after an unclear outcome are refused. Reddit has no crossposting or bulk posting here. Returns the post id and link.',
      inputSchema: {
        type: 'object',
        properties: {
          subreddit: { type: 'string', pattern: SUBREDDIT, description: 'The one community to post in, such as test or r/test.' },
          kind: { type: 'string', enum: ['self', 'link'], description: 'self for a text post, link for a link post.' },
          title: { type: 'string', minLength: 1, maxLength: MAX_TITLE, description: 'The title, up to 300 characters. Never cut a title: write a shorter one.' },
          text: { type: 'string', maxLength: MAX_TEXT, description: 'The body of a text post, in Markdown.' },
          url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'The link of a link post (https).' },
          nsfw: { type: 'boolean', description: 'Whether the post is NSFW, from the content and the community\'s rules.' },
          spoiler: { type: 'boolean', description: 'Whether the post is a spoiler.' },
          flair_id: { type: 'string', maxLength: 64, description: 'A post flair template id, for communities that require flair.' },
          flair_text: { type: 'string', maxLength: 64, description: 'The flair text, for a flair that allows its own text.' },
          send_replies: { type: 'boolean', default: true, description: 'Send replies to the account\'s inbox (default true).' },
          allow_repeat_after_check: ALLOW_REPEAT,
        },
        required: ['subreddit', 'kind', 'title', 'nsfw', 'spoiler'],
        additionalProperties: false,
      },
      async run(args: SubmitArgs, h) {
        if (args.kind === 'self' && args.url !== undefined) throw new ToolFailure('A text post (kind self) takes text, not url. Nothing was sent.');
        if (args.kind === 'link' && args.url === undefined) throw new ToolFailure('A link post (kind link) needs url. Nothing was sent.');
        if (args.kind === 'link' && args.text !== undefined) throw new ToolFailure('A link post (kind link) takes url, not text. Nothing was sent.');
        if (!args.title.trim()) throw new ToolFailure('The title is empty. Nothing was sent.');
        checkDeveloper(h);
        const subreddit = subredditName(args.subreddit);
        const me = await identity(h, false);
        const content = `${normalizeText(args.title)}\n${args.kind === 'link' ? normalizeUrl(args.url ?? '') : normalizeText(args.text ?? '')}`;
        const mutation = await describeMutation(`submit_${args.kind}`, me, `r/${subreddit}`, content, 'post');
        return guarded(mutation, { what: 'post', check: 'list_my_posts', allowRepeat: args.allow_repeat_after_check }, async () => {
          const data = await reddit(h, {
            method: 'POST',
            path: '/api/submit',
            ...form({
              api_type: 'json',
              kind: args.kind,
              sr: subreddit,
              title: args.title,
              text: args.kind === 'self' ? (args.text ?? '') : undefined,
              url: args.kind === 'link' ? args.url : undefined,
              nsfw: args.nsfw,
              spoiler: args.spoiler,
              sendreplies: args.send_replies,
              flair_id: args.flair_id,
              flair_text: args.flair_text,
            }),
            write: true,
            errors: { 403: 'Reddit refused the post (the account may be banned from this community, or the community restricts who may post)' },
          });
          await throwJsonErrors(h, data, 'post');
          const name = data?.json?.data?.name;
          const url = data?.json?.data?.url;
          if (typeof name !== 'string' && typeof url !== 'string') {
            throw new OutcomeUnknown('Reddit answered without the new post\'s id or link, so it is not known whether it was submitted.');
          }
          return {
            fullname: typeof name === 'string' ? name : undefined,
            value: compact({ id: name, url, subreddit, kind: args.kind, rateLimit: await rateInfo(h) }),
          };
        });
      },
    },
    {
      name: 'add_comment',
      kind: 'create',
      check: 'list_my_comments',
      title: 'Comment on Reddit',
      description:
        'Posts one comment on a post (t3_...) or one reply to a comment (t1_...), by its fullname. One comment per approved operation: '
        + 'an identical comment that went through in the last 48 hours, the same text on another thread, and a repeat after an unclear '
        + 'outcome are refused. Returns the comment id and link.',
      inputSchema: {
        type: 'object',
        properties: {
          thing_id: { type: 'string', pattern: FULLNAME, description: 'The fullname to reply to: t3_... for a post, t1_... for a comment.' },
          text: { type: 'string', minLength: 1, maxLength: MAX_COMMENT, description: 'The comment, in Markdown, up to 10,000 characters.' },
          allow_repeat_after_check: ALLOW_REPEAT,
        },
        required: ['thing_id', 'text'],
        additionalProperties: false,
      },
      async run(args: { thing_id: string; text: string; allow_repeat_after_check: boolean }, h) {
        if (!args.text.trim()) throw new ToolFailure('The comment is empty. Nothing was sent.');
        checkDeveloper(h);
        const me = await identity(h, false);
        const mutation = await describeMutation('comment', me, args.thing_id, normalizeText(args.text), 'comment');
        return guarded(mutation, { what: 'comment', check: 'list_my_comments', allowRepeat: args.allow_repeat_after_check }, async () => {
          const data = await reddit(h, {
            method: 'POST',
            path: '/api/comment',
            ...form({ api_type: 'json', thing_id: args.thing_id, text: args.text }),
            write: true,
            errors: { 403: 'Reddit refused the comment (the thread may be locked or archived, or the account banned from the community)' },
          });
          await throwJsonErrors(h, data, 'comment');
          const comment = data?.json?.data?.things?.[0]?.data;
          if (typeof comment?.name !== 'string') {
            throw new OutcomeUnknown('Reddit answered without the new comment\'s id, so it is not known whether it was posted.');
          }
          return {
            fullname: comment.name,
            value: compact({ id: comment.name, url: permalink(comment.permalink), parentId: comment.parent_id ?? args.thing_id, postId: comment.link_id, rateLimit: await rateInfo(h) }),
          };
        });
      },
    },
    {
      name: 'edit_text',
      kind: 'update',
      check: 'get_items',
      title: 'Edit my Reddit post or comment',
      description:
        'Replaces the text of one of the connected account\'s own text posts (t3_...) or comments (t1_...). Reddit edits bodies only, '
        + 'never a title or a link post. Checks with Reddit right before that the item is the account\'s own.',
      inputSchema: {
        type: 'object',
        properties: {
          thing_id: { type: 'string', pattern: FULLNAME, description: 'The fullname of the account\'s own post or comment.' },
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'The new text, in Markdown.' },
        },
        required: ['thing_id', 'text'],
        additionalProperties: false,
      },
      async run(args: { thing_id: string; text: string }, h) {
        checkDeveloper(h);
        const { item, me } = await ownThing(h, args.thing_id, 'edit');
        if (item.kind === 't3' && item.data?.is_self !== true) throw new ToolFailure(`${args.thing_id} is a link post, which has no text to edit. Nothing was changed.`);
        const mutation = await describeMutation('edit', me, args.thing_id, normalizeText(args.text));
        return guarded(mutation, { what: 'edit', check: 'get_items', idempotent: true }, async () => {
          const data = await reddit(h, {
            method: 'POST',
            path: '/api/editusertext',
            ...form({ api_type: 'json', thing_id: args.thing_id, text: args.text }),
            write: true,
            errors: { 403: 'Reddit refused the edit (the item may be archived or locked)' },
          });
          await throwJsonErrors(h, data, 'edit');
          const edited = data?.json?.data?.things?.[0]?.data;
          if (edited?.name !== args.thing_id) throw new OutcomeUnknown('Reddit answered without the edited item, so it is not known whether the edit was saved.');
          return { value: compact({ id: args.thing_id, url: permalink(edited.permalink), edited: true, rateLimit: await rateInfo(h) }) };
        });
      },
    },
    {
      name: 'delete_item',
      kind: 'delete',
      check: 'get_items',
      title: 'Delete my Reddit post or comment',
      description:
        'Deletes one of the connected account\'s own posts (t3_...) or comments (t1_...), for good. Checks with Reddit right before that '
        + 'the item is the account\'s own.',
      inputSchema: {
        type: 'object',
        properties: { thing_id: { type: 'string', pattern: FULLNAME, description: 'The fullname of the account\'s own post or comment.' } },
        required: ['thing_id'],
        additionalProperties: false,
      },
      async run(args: { thing_id: string }, h) {
        checkDeveloper(h);
        const { me } = await ownThing(h, args.thing_id, 'delete');
        const mutation = await describeMutation('delete', me, args.thing_id, '');
        const result = await guarded(mutation, { what: 'delete', check: 'get_items', idempotent: true }, async () => {
          const data = await reddit(h, { method: 'POST', path: '/api/del', ...form({ id: args.thing_id }), write: true });
          await throwJsonErrors(h, data, 'delete');
          return { value: compact({ id: args.thing_id, deleted: true, rateLimit: await rateInfo(h) }) };
        });
        await forgetThing(args.thing_id);
        return result;
      },
    },
    {
      name: 'list_my_posts',
      kind: 'read',
      title: 'List my Reddit posts',
      description: "Lists the connected account's own posts, newest first: id, community, title, link, score and comment count. Pass nextCursor back as cursor for older ones.",
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Posts per page, 1 to 100 (default 25).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        return listHistory(h, 'submitted', 'posts', args);
      },
    },
    {
      name: 'list_my_comments',
      kind: 'read',
      title: 'List my Reddit comments',
      description: "Lists the connected account's own comments, newest first: id, community, the post it is on, link, text and score. Pass nextCursor back as cursor for older ones.",
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Comments per page, 1 to 100 (default 25).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        return listHistory(h, 'comments', 'comments', args);
      },
    },
    {
      name: 'get_items',
      kind: 'read',
      title: 'Get Reddit posts or comments',
      description: 'Returns up to 25 posts (t3_...) or comments (t1_...) by their fullnames: author, community, text, score, and whether they were removed.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: { type: 'string', pattern: FULLNAME }, description: 'The fullnames, such as ["t3_abc123", "t1_def456"].' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      async run(args: { ids: string[] }, h) {
        const data = await reddit(h, { path: '/api/info', query: { id: args.ids.join(','), raw_json: 1 } });
        const children: any[] = Array.isArray(data?.data?.children) ? data.data.children : [];
        const found = new Set(children.map((child) => child?.data?.name));
        const missing = args.ids.filter((id) => !found.has(id));
        return compact({ items: children.map(trimThing), missing: missing.length ? missing : undefined, rateLimit: await rateInfo(h) });
      },
    },
    // Reads only: every change goes through the tools above and their checks.
    ...apiTools({
      label: 'Reddit',
      description:
        'The Reddit Data API on https://oauth.reddit.com, with the connection\'s token and Reddit\'s User-Agent, inside the app\'s rate window: '
        + 'documented GET endpoints such as /r/{name}/about, /r/{name}/new or /comments/{id} (add raw_json=1 in query). Read only what the '
        + 'task needs, never whole listings. Reference: https://www.reddit.com/dev/api.',
      send: (request, h) => {
        checkDeveloper(h);
        return redditRequest(h, request);
      },
    }).filter((tool) => tool.name === 'api_get'),
  ],
});

async function listHistory(h: ToolHelpers, where: 'submitted' | 'comments', key: string, args: { limit: number; cursor?: string }): Promise<Record<string, unknown>> {
  const state = h.cursor(args.cursor);
  const after = typeof state?.['a'] === 'string' ? state['a'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
  const me = typeof state?.['u'] === 'string' ? state['u'] : await identity(h, false);
  const data = await reddit(h, { path: `/user/${encodeURIComponent(me)}/${where}`, query: { sort: 'new', limit, after, raw_json: 1 } });
  const children: any[] = Array.isArray(data?.data?.children) ? data.data.children : [];
  const next = typeof data?.data?.after === 'string' ? data.data.after : undefined;
  return h.page({
    key,
    items: children.map(trimThing).slice(skip),
    extra: { account: me, rateLimit: await rateInfo(h) },
    resumeAt: (index) => h.makeCursor({ u: me, ...(after ? { a: after } : {}), o: skip + index, n: limit }),
    ...(next ? { nextPage: h.makeCursor({ u: me, a: next, o: 0, n: limit }) } : {}),
  });
}

export = connector;
