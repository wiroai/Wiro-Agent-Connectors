// beehiiv, through the beehiiv API v2 (https://developers.beehiiv.com).
//
// Credentials: `apikey`, an API key from beehiiv → Settings → Workspace
// Settings → API → Create New API Key (Owners and Admins), sent as a Bearer
// token to https://api.beehiiv.com/v2/ only; and `publicationid`, optional,
// the publication (pub_...) the tools use when none is named. Every plan can
// read posts, stats and subscribers and add subscribers; creating or changing
// posts (beehiiv's Send API) needs the Pro or Enterprise plan. Posts are saved
// as drafts; only send_post emails subscribers. Posts and subscriptions are
// never deleted here: beehiiv deletes them for good.

import { apiTools, defineConnector, OutcomeUnknown, ToolFailure, type ToolHelpers } from '../../core/index.js';
import { compact, isoDate, postStats, TEXT_WINDOW_BYTES, textWindow, topLinks, trimPost, trimResource, trimSubscription } from './format.js';

const V2 = '/v2';
const PUBLICATION_ID = { type: 'string' as const, pattern: '^pub_[0-9A-Za-z-]{8,64}$', description: 'The publication (pub_...). Default: the saved publication ID.' };
const POST_ID = { type: 'string' as const, pattern: '^post_[0-9A-Za-z-]{8,64}$', description: 'The post ID (post_...).' };
const SUBSCRIPTION_ID = { type: 'string' as const, pattern: '^sub_[0-9A-Za-z-]{8,64}$', description: 'The subscription ID (sub_...).' };
const CURSOR_SCHEMA = { type: 'string' as const, description: 'nextCursor from the previous result; pass the same other arguments again.' };
const SEND_API =
  'beehiiv refused the change: creating or changing posts (beehiiv\'s Send API) needs the Pro or Enterprise plan, and not a Pro trial';
const RECIPIENTS = {
  type: 'object' as const,
  description:
    'Who gets the post, as beehiiv takes it: {"email":{"tier_ids":["free","premium"]},"web":{"tier_ids":["free","premium"]}}. tier_ids takes '
    + 'free, premium, all or tier IDs; use include_segment_ids instead for segments (the two cannot be combined), exclude_segment_ids with '
    + 'either. Leave email out for a web-only post, web for an email-only one. Left out, beehiiv targets only the free tier, on email and web.',
};
const POST_FIELDS = {
  title: { type: 'string' as const, minLength: 1, maxLength: 300, description: 'The post title.' },
  subtitle: { type: 'string' as const, maxLength: 300, description: 'A subtitle.' },
  body_content: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 1000000,
    description:
      'The body as HTML with inline style attributes only: beehiiv removes <style> and <link> tags, classes do nothing, and the '
      + 'publication\'s own email template adds the layout and the footer around it.',
  },
  email_subject_line: { type: 'string' as const, maxLength: 300, description: 'The email subject line.' },
  email_preview_text: { type: 'string' as const, maxLength: 300, description: 'The preview text shown after the subject.' },
  recipients: RECIPIENTS,
  content_tags: { type: 'array' as const, maxItems: 20, items: { type: 'string' as const, minLength: 1, maxLength: 100 }, description: 'Content tags; when given they replace all tags.' },
  post_template_id: { type: 'string' as const, maxLength: 100, description: 'A post template (list_resources with kind post_templates).' },
  thumbnail_image_url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'A public https URL of the thumbnail image.' },
  web_slug: { type: 'string' as const, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 200, description: 'The web page slug.' },
  hide_from_feed: { type: 'boolean' as const, description: 'true keeps the web page out of the publication\'s feed.' },
  seo_title: { type: 'string' as const, maxLength: 300, description: 'An SEO title.' },
  seo_description: { type: 'string' as const, maxLength: 500, description: 'An SEO description.' },
};

interface PostArgs {
  publication_id?: string;
  title?: string;
  subtitle?: string;
  body_content?: string;
  email_subject_line?: string;
  email_preview_text?: string;
  recipients?: Record<string, unknown>;
  content_tags?: string[];
  post_template_id?: string;
  thumbnail_image_url?: string;
  web_slug?: string;
  hide_from_feed?: boolean;
  seo_title?: string;
  seo_description?: string;
}

/** The post fields beehiiv takes, from the tool arguments that were given. */
function postBody(args: PostArgs): Record<string, unknown> {
  const email = compact({ email_subject_line: args.email_subject_line, email_preview_text: args.email_preview_text });
  const web = compact({ slug: args.web_slug, hide_from_feed: args.hide_from_feed });
  const seo = compact({ default_title: args.seo_title, default_description: args.seo_description });
  return compact({
    title: args.title,
    subtitle: args.subtitle,
    body_content: args.body_content,
    email_settings: Object.keys(email).length ? email : undefined,
    web_settings: Object.keys(web).length ? web : undefined,
    seo_settings: Object.keys(seo).length ? seo : undefined,
    recipients: args.recipients,
    content_tags: args.content_tags,
    post_template_id: args.post_template_id,
    thumbnail_image_url: args.thumbnail_image_url,
  });
}

/** The publication a call acts on: the one named, or the saved default. */
function publicationOf(h: ToolHelpers, given: string | undefined): string {
  const id = given ?? h.credentials['publicationid'];
  if (!id) {
    throw new ToolFailure(
      'Name the publication: pass publication_id (list_publications lists the ones this key reaches), or save a default publication ID '
        + 'with the connection. Nothing was sent.',
    );
  }
  if (!/^pub_[0-9A-Za-z-]{8,64}$/.test(id)) {
    throw new ToolFailure('The publication ID must be pub_ followed by 36 letters, digits and dashes (beehiiv\'s API V2 ID). Nothing was sent.');
  }
  return id;
}

function pageState(h: ToolHelpers, cursor: string | undefined): { page: number; cursor?: string; skip: number } {
  const state = h.cursor(cursor);
  return {
    page: typeof state?.['p'] === 'number' ? state['p'] : 1,
    ...(typeof state?.['c'] === 'string' && state['c'] ? { cursor: state['c'] } : {}),
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
  };
}

/** A beehiiv list result: cursor paging when beehiiv answers with a next cursor, page numbers otherwise. */
function beehiivPage(h: ToolHelpers, key: string, data: any, items: unknown[], at: { page: number; cursor?: string; skip: number }, extra: Record<string, unknown> = {}) {
  const pagination = data?.pagination ?? data;
  const nextCursor = typeof pagination?.next_cursor === 'string' && pagination.next_cursor ? pagination.next_cursor : undefined;
  const totalPages = typeof data?.total_pages === 'number' ? data.total_pages : undefined;
  const next: Record<string, string | number> | undefined = nextCursor && pagination?.has_more !== false
    ? { c: nextCursor, o: 0 }
    : !nextCursor && !at.cursor && totalPages !== undefined && at.page < totalPages && at.page < 100 ? { p: at.page + 1, o: 0 } : undefined;
  const here: Record<string, string | number> = at.cursor ? { c: at.cursor } : { p: at.page };
  return h.page({
    key,
    items: items.slice(at.skip),
    extra: compact({ ...extra, total: typeof data?.total_results === 'number' ? data.total_results : undefined }),
    resumeAt: (index) => h.makeCursor({ ...here, o: at.skip + index }),
    ...(next ? { nextPage: h.makeCursor(next) } : {}),
  });
}

function pageQuery(at: { page: number; cursor?: string }): Record<string, string | number> {
  return at.cursor ? { cursor: at.cursor } : { page: at.page };
}

/** Waits up to `ms`, or less when the call is cancelled; false when it was. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitSeconds(headers: Headers): number {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 5) : 2;
}

/** After a create, reads the post until beehiiv has finished it (at most 3 reads), honoring Retry-After and cancellation. */
async function settle(h: ToolHelpers, publication: string, id: string): Promise<{ state: 'ready' | 'pending'; post?: any; note?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await h.api({ path: `${V2}/publications/${publication}/posts/${id}` });
    } catch (error) {
      if (error instanceof ToolFailure && error.details.status === 404 && /creation fail|POST_CREATION_FAILED/i.test(error.message)) {
        throw new ToolFailure(
          'beehiiv accepted the post but could not finish creating it (POST_CREATION_FAILED), so no draft exists: check the request '
            + '(the body and the recipients) and create it once more.',
          error.details,
        );
      }
      return { state: 'pending', note: 'beehiiv saved the post; reading it back did not work: check it with get_post.' };
    }
    if (response.status !== 202) return { state: 'ready', post: response.data?.data };
    if (attempt < 2 && !(await pause(waitSeconds(response.headers) * 1000, h.ctx.signal))) break;
  }
  return { state: 'pending', note: 'beehiiv is still finishing the post in the background: read it with get_post in a moment.' };
}

const connector = defineConnector({
  vendor: 'beehiiv',
  label: 'beehiiv',
  origins: ['https://api.beehiiv.com'],
  credentials: ['apikey', 'publicationid'],
  requiredCredentials: [['apikey']],
  credentialLabels: { apikey: 'beehiiv API key', publicationid: 'beehiiv publication ID' },
  normalizeCredentials: (credentials) => ({ ...credentials, apikey: (credentials['apikey'] ?? '').replace(/^Bearer\s+/i, '') }),
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['apikey']}` }),
  tools: [
    {
      name: 'list_publications',
      kind: 'read',
      title: 'List beehiiv publications',
      description:
        'The publications this API key reaches, with active subscriptions (premium and free), beehiiv\'s average open and click rates and '
        + 'emails sent. Use one\'s ID as publication_id. Pass nextCursor back as cursor for more.',
      inputSchema: { type: 'object', properties: { cursor: CURSOR_SCHEMA }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const at = pageState(h, args.cursor);
        const { data } = await h.api({ path: `${V2}/publications`, query: { limit: 100, 'expand[]': ['stats'], ...pageQuery(at) } });
        const publications = (Array.isArray(data?.data) ? data.data : []).map((publication: any) => compact({
          id: publication?.id,
          name: publication?.name,
          organization: publication?.organization_name,
          created: isoDate(publication?.created),
          stats: publication?.stats && typeof publication.stats === 'object' ? compact({ ...publication.stats }) : undefined,
        }));
        return beehiivPage(h, 'publications', data, publications, at, compact({ default_publication_id: h.credentials['publicationid'] || undefined }));
      },
    },
    {
      name: 'get_publication',
      kind: 'read',
      title: 'Get a beehiiv publication',
      description: 'One publication\'s numbers: active subscriptions (premium and free), beehiiv\'s average open and click rates and emails sent.',
      inputSchema: { type: 'object', properties: { publication_id: PUBLICATION_ID }, additionalProperties: false },
      async run(args: { publication_id?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({ path: `${V2}/publications/${id}`, query: { 'expand[]': ['stats'] }, errors: { 404: 'beehiiv found no such publication for this key (a key can be limited to some publications)' } });
        const publication = data?.data ?? {};
        return compact({ id: publication.id, name: publication.name, organization: publication.organization_name, created: isoDate(publication.created), stats: publication.stats ? compact({ ...publication.stats }) : undefined });
      },
    },
    {
      name: 'list_posts',
      kind: 'read',
      title: 'List beehiiv posts with stats',
      description:
        'Posts of a publication, newest published first by default, with email numbers (recipients, delivered, unique opens and clicks with '
        + 'their share of delivered emails, unsubscribes, spam reports, and beehiiv\'s own rates) and web views. status picks drafts, sent or '
        + 'scheduled (confirmed), archived or all. Dates are UTC. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          status: { type: 'string', enum: ['confirmed', 'draft', 'archived', 'all'], default: 'confirmed', description: 'confirmed (sent or scheduled, default), draft, archived or all.' },
          platform: { type: 'string', enum: ['web', 'email', 'both', 'all'], description: 'Only posts on this platform.' },
          audience: { type: 'string', enum: ['free', 'premium', 'all'], description: 'Only posts for this audience.' },
          content_tags: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Only posts with these content tags.' },
          hidden_from_feed: { type: 'string', enum: ['all', 'true', 'false'], description: 'Hidden from the feed or not (default all).' },
          order_by: { type: 'string', enum: ['publish_date', 'created', 'displayed_date'], default: 'publish_date', description: 'The order (default publish_date).' },
          direction: { type: 'string', enum: ['desc', 'asc'], default: 'desc', description: 'desc (default) or asc.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Posts per page, 1 to 100 (default 10).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; status: string; platform?: string; audience?: string; content_tags?: string[]; hidden_from_feed?: string; order_by: string; direction: string; limit: number; cursor?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const at = pageState(h, args.cursor);
        const { data } = await h.api({
          path: `${V2}/publications/${id}/posts`,
          query: {
            'expand[]': ['stats'],
            status: args.status,
            platform: args.platform,
            audience: args.audience,
            'content_tags[]': args.content_tags,
            hidden_from_feed: args.hidden_from_feed,
            order_by: args.order_by,
            direction: args.direction,
            limit: args.limit,
            ...pageQuery(at),
          },
        });
        const posts = (Array.isArray(data?.data) ? data.data : []).map(trimPost);
        return beehiivPage(h, 'posts', data, posts, at, { publication_id: id });
      },
    },
    {
      name: 'get_post',
      kind: 'read',
      title: 'Get a beehiiv post with its stats',
      description:
        'One post: its status, audience, subject line, email and web numbers, and the ten links with the most unique clicks. content returns '
        + 'one version of its body (free or premium, web, email or RSS) as HTML, in windows: pass nextCursor back as cursor. A post beehiiv '
        + 'is still creating answers with state pending.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          post_id: POST_ID,
          content: { type: 'string', enum: ['none', 'free_web', 'free_email', 'free_rss', 'premium_web', 'premium_email'], default: 'none', description: 'Which body to return (default none).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; post_id: string; content: string; cursor?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const expand = ['stats', ...(args.content !== 'none' ? [`${args.content}_content`] : [])];
        const response = await h.api({
          path: `${V2}/publications/${id}/posts/${args.post_id}`,
          query: { 'expand[]': expand },
          errors: { 404: 'beehiiv found no such post, or creating it failed in the background (POST_CREATION_FAILED: create it once more)' },
        });
        const post = response.data?.data ?? {};
        if (response.status === 202 || post.state === 'pending') {
          return { id: post.id ?? args.post_id, state: 'pending', note: 'beehiiv is still creating the post: read it again in a moment.' };
        }
        const result: Record<string, unknown> = { ...trimPost(post), top_links: topLinks(post.stats) };
        if (args.content !== 'none') {
          const [tier, platform] = args.content.split('_') as [string, string];
          const html = typeof post.content?.[tier]?.[platform] === 'string' ? post.content[tier][platform] : '';
          const state = h.cursor(args.cursor);
          const window = textWindow(html, typeof state?.['o'] === 'number' ? state['o'] : 0, TEXT_WINDOW_BYTES);
          result['content'] = window.text;
          result['content_length'] = html.length;
          if (window.offset) result['content_offset'] = window.offset;
          if (window.next !== undefined) result['nextCursor'] = h.makeCursor({ o: window.next });
        }
        return compact(result);
      },
    },
    {
      name: 'get_posts_aggregate_stats',
      kind: 'read',
      title: 'Get beehiiv totals over posts',
      description: 'Email and web totals over all posts that match the filters (sent posts by default), with the links that got the most unique clicks.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          status: { type: 'string', enum: ['confirmed', 'draft', 'archived', 'all'], default: 'confirmed', description: 'confirmed (default), draft, archived or all.' },
          platform: { type: 'string', enum: ['web', 'email', 'both', 'all'], description: 'Only posts on this platform.' },
          audience: { type: 'string', enum: ['free', 'premium', 'all'], description: 'Only posts for this audience.' },
          content_tags: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Only posts with these content tags.' },
        },
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; status: string; platform?: string; audience?: string; content_tags?: string[] }, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({
          path: `${V2}/publications/${id}/posts/aggregate_stats`,
          query: { status: args.status, platform: args.platform, audience: args.audience, 'content_tags[]': args.content_tags },
        });
        const stats = data?.data?.stats ?? data?.data ?? {};
        return compact({ publication_id: id, computed_at: isoDate(data?.data?.computed_at), stats: postStats(stats), top_links: topLinks(stats) });
      },
    },
    {
      name: 'create_draft_post',
      kind: 'create',
      check: 'list_posts',
      title: 'Save a beehiiv draft post',
      description:
        'Saves a post as a draft: it reaches no one. beehiiv finishes the post in the background, so the tool reads it back for a few seconds. '
        + 'Returns its ID and a preview link (it opens for someone signed in to beehiiv). Needs the Pro or Enterprise plan. Set recipients: left '
        + 'out, beehiiv targets only the free tier.',
      inputSchema: {
        type: 'object',
        properties: { publication_id: PUBLICATION_ID, ...POST_FIELDS },
        required: ['title', 'body_content'],
        additionalProperties: false,
      },
      async run(args: PostArgs, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({
          method: 'POST',
          path: `${V2}/publications/${id}/posts`,
          json: { ...postBody(args), status: 'draft' },
          write: true,
          errors: { 403: SEND_API },
        });
        const postId = data?.data?.id;
        if (typeof postId !== 'string' || !postId) {
          throw new OutcomeUnknown('beehiiv answered without the new post\'s ID, so it is not known whether the draft was saved.');
        }
        const settled = await settle(h, id, postId);
        return compact({
          saved: 'draft: nothing was sent',
          id: postId,
          preview_url: data?.data?.preview_url,
          state: settled.state,
          status: settled.post?.status,
          title: settled.post?.title ?? args.title,
          note: settled.note,
        });
      },
    },
    {
      name: 'update_draft_post',
      kind: 'update',
      check: 'get_post',
      title: 'Edit a beehiiv draft post',
      description:
        'Changes a draft: only the fields given change; body_content replaces the whole body, and recipients and content_tags replace what was '
        + 'there. The tool reads the post first and changes drafts only. Needs the Pro or Enterprise plan.',
      inputSchema: {
        type: 'object',
        properties: { publication_id: PUBLICATION_ID, post_id: POST_ID, ...POST_FIELDS },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: PostArgs & { post_id: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const body = postBody(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one field besides post_id. Nothing was changed.');
        const current = await h.api({ path: `${V2}/publications/${id}/posts/${args.post_id}`, errors: { 404: 'beehiiv found no such post' } });
        const status = current.data?.data?.status;
        if (current.status === 202) throw new ToolFailure('beehiiv is still creating this post: try again in a moment. Nothing was changed.');
        if (status !== 'draft') {
          throw new ToolFailure(`This post is ${String(status ?? 'not a draft')}, and update_draft_post changes drafts only (beehiiv cannot move a sent or scheduled post back). Nothing was changed.`);
        }
        const response = await h.api({ method: 'PATCH', path: `${V2}/publications/${id}/posts/${args.post_id}`, json: body, write: true, errors: { 403: SEND_API } });
        if (response.status === 202) return { id: args.post_id, state: 'pending', note: 'beehiiv took the change and is still processing it: read the post with get_post in a moment.' };
        return compact({ ...trimPost(response.data?.data ?? {}), updated: true });
      },
    },
    {
      name: 'send_test_email',
      kind: 'create',
      check: 'get_post',
      title: 'Send a beehiiv test email',
      description:
        'Sends a test email of a post to the given addresses only; it is not a send to subscribers. beehiiv caps test sends per publication '
        + 'per day: the result says how many are left.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          post_id: POST_ID,
          recipient_emails: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254 }, description: 'The addresses to send the test to.' },
        },
        required: ['post_id', 'recipient_emails'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; post_id: string; recipient_emails: string[] }, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({
          method: 'POST',
          path: `${V2}/publications/${id}/posts/${args.post_id}/test_sends`,
          json: { recipient_emails: args.recipient_emails },
          write: true,
          errors: { 422: 'beehiiv did not send the test: the daily test send cap may be reached' },
        });
        return compact({ sent: true, to: args.recipient_emails.length, test_sends_left_today: data?.data?.remaining_test_sends, resets_at: isoDate(data?.data?.reset_at) });
      },
    },
    {
      name: 'send_post',
      kind: 'update',
      check: 'get_post',
      title: 'Send or schedule a beehiiv post',
      description:
        'Publishes a draft and emails it to its recipients now, or at scheduled_at (UTC, ISO 8601). This is the one call that reaches '
        + 'subscribers. It cannot be undone through the API: a sent post cannot go back to draft, and a scheduled one is unscheduled in beehiiv '
        + 'itself. Needs the Pro or Enterprise plan.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          post_id: POST_ID,
          scheduled_at: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$',
            description: 'When to send, e.g. 2026-11-24T14:00:00Z. Leave out to send now.',
          },
        },
        required: ['post_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; post_id: string; scheduled_at?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const response = await h.api({
          method: 'PATCH',
          path: `${V2}/publications/${id}/posts/${args.post_id}`,
          json: compact({ status: 'confirmed', scheduled_at: args.scheduled_at }),
          write: true,
          errors: { 403: SEND_API },
        });
        const post = response.data?.data ?? {};
        return compact({
          ...trimPost(post),
          id: post.id ?? args.post_id,
          state: response.status === 202 ? 'pending' : undefined,
          note: args.scheduled_at
            ? `Scheduled for ${args.scheduled_at}. To stop it, unschedule it in beehiiv itself.`
            : 'Sent: it is published and emailed to its recipients.',
        });
      },
    },
    {
      name: 'list_subscriptions',
      kind: 'read',
      title: 'Find beehiiv subscriptions',
      description:
        'Looks up subscriptions by email (exact, not case-sensitive) or lists them by status and tier, with custom fields and email numbers. '
        + 'Status: active, pending (waiting for double opt-in), validating, inactive (unsubscribed), needs_attention, paused, invalid. Pass '
        + 'nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254, description: 'Find this address.' },
          status: { type: 'string', enum: ['active', 'pending', 'validating', 'inactive', 'needs_attention', 'paused', 'invalid', 'all'], description: 'Only this status.' },
          tier: { type: 'string', enum: ['free', 'premium', 'all'], description: 'Only this tier.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Subscriptions per page, 1 to 100 (default 10).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; email?: string; status?: string; tier?: string; limit: number; cursor?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const at = pageState(h, args.cursor);
        const { data } = await h.api({
          path: `${V2}/publications/${id}/subscriptions`,
          query: { email: args.email, status: args.status, tier: args.tier, limit: args.limit, 'expand[]': ['custom_fields', 'stats'], ...(at.cursor ? { cursor: at.cursor } : at.page > 1 ? { page: at.page } : {}) },
        });
        const subscriptions = (Array.isArray(data?.data) ? data.data : []).map(trimSubscription);
        return beehiivPage(h, 'subscriptions', data, subscriptions, at, { publication_id: id });
      },
    },
    {
      name: 'get_subscription',
      kind: 'read',
      title: 'Get a beehiiv subscription',
      description: 'One subscription with its tags, custom fields, UTM source, tier and email numbers.',
      inputSchema: {
        type: 'object',
        properties: { publication_id: PUBLICATION_ID, subscription_id: SUBSCRIPTION_ID },
        required: ['subscription_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; subscription_id: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({
          path: `${V2}/publications/${id}/subscriptions/${args.subscription_id}`,
          query: { 'expand[]': ['tags', 'custom_fields', 'stats'] },
          errors: { 404: 'beehiiv found no such subscription' },
        });
        return trimSubscription(data?.data ?? {});
      },
    },
    {
      name: 'create_subscription',
      kind: 'create',
      check: 'list_subscriptions',
      title: 'Add a beehiiv subscriber',
      description:
        'Adds a subscriber who agreed to receive the newsletter. double_opt_override not_set follows the publication\'s setting, which may '
        + 'email a confirmation link; off skips it. A welcome email, reactivating someone who unsubscribed, a premium tier and automations '
        + 'happen only when asked. Custom fields must already exist: beehiiv drops unknown ones and says so in warnings.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254, description: 'The subscriber\'s address.' },
          send_welcome_email: { type: 'boolean', default: false, description: 'Send the welcome email (default false).' },
          reactivate_existing: { type: 'boolean', default: false, description: 'Resubscribe someone who unsubscribed (default false).' },
          double_opt_override: { type: 'string', enum: ['not_set', 'on', 'off'], default: 'not_set', description: 'not_set (default) follows the publication; on asks for confirmation; off skips it.' },
          utm_source: { type: 'string', maxLength: 200, description: 'Where the subscriber came from.' },
          utm_medium: { type: 'string', maxLength: 200, description: 'The UTM medium.' },
          utm_campaign: { type: 'string', maxLength: 200, description: 'The UTM campaign.' },
          referring_site: { type: 'string', maxLength: 500, description: 'The referring site.' },
          custom_fields: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 2000 } },
              required: ['name', 'value'],
              additionalProperties: false,
            },
            description: 'Existing custom fields, e.g. [{"name":"First Name","value":"Jane"}].',
          },
          tier: { type: 'string', enum: ['free', 'premium'], description: 'premium changes paid access: only when asked.' },
          premium_tier_ids: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Premium tier IDs: only when asked.' },
          automation_ids: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Automations to enroll the subscriber in (they email them): only when asked.' },
        },
        required: ['email'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const id = publicationOf(h, args['publication_id']);
        const { publication_id: _publication, ...fields } = args;
        const { data } = await h.api({ method: 'POST', path: `${V2}/publications/${id}/subscriptions`, json: compact(fields), write: true });
        const warnings = Array.isArray(data?.warnings) ? data.warnings.slice(0, 10).map((item: any) => String(item?.message ?? item).slice(0, 300)) : undefined;
        return compact({ ...trimSubscription(data?.data ?? {}), warnings: warnings?.length ? warnings : undefined });
      },
    },
    {
      name: 'add_subscription_tags',
      kind: 'update',
      check: 'get_subscription',
      title: 'Tag a beehiiv subscriber',
      description: 'Adds tags to a subscription; beehiiv creates new tags on the fly (at most 100 different tags per publication).',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          subscription_id: SUBSCRIPTION_ID,
          tags: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'The tags to add.' },
        },
        required: ['subscription_id', 'tags'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; subscription_id: string; tags: string[] }, h) {
        const id = publicationOf(h, args.publication_id);
        const { data } = await h.api({ method: 'POST', path: `${V2}/publications/${id}/subscriptions/${args.subscription_id}/tags`, json: { tags: args.tags }, write: true, errors: { 404: 'beehiiv found no such subscription' } });
        return compact({ ...trimSubscription(data?.data ?? {}), tags_added: args.tags });
      },
    },
    {
      name: 'update_subscription',
      kind: 'update',
      check: 'get_subscription',
      title: 'Update or unsubscribe a beehiiv subscriber',
      description:
        'Changes a subscription\'s custom fields ({"name":"Plan","value":"Pro"}, or {"name":"Plan","delete":true} to remove a value), its tier '
        + '(it changes paid access), or unsubscribes it (unsubscribe: true: the person stops getting the newsletter).',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          subscription_id: SUBSCRIPTION_ID,
          custom_fields: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 2000 }, delete: { type: 'boolean' } },
              required: ['name'],
              additionalProperties: false,
            },
            description: 'Custom field values to set or remove.',
          },
          tier: { type: 'string', enum: ['free', 'premium'], description: 'The new tier.' },
          premium_tier_ids: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Premium tier IDs.' },
          unsubscribe: { type: 'boolean', description: 'true unsubscribes the person.' },
        },
        required: ['subscription_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; subscription_id: string; custom_fields?: unknown[]; tier?: string; premium_tier_ids?: string[]; unsubscribe?: boolean }, h) {
        const id = publicationOf(h, args.publication_id);
        const body = compact({ custom_fields: args.custom_fields, tier: args.tier, premium_tier_ids: args.premium_tier_ids, unsubscribe: args.unsubscribe });
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give custom_fields, tier, premium_tier_ids or unsubscribe. Nothing was changed.');
        const { data } = await h.api({ method: 'PUT', path: `${V2}/publications/${id}/subscriptions/${args.subscription_id}`, json: body, write: true, errors: { 404: 'beehiiv found no such subscription' } });
        return compact({ ...trimSubscription(data?.data ?? {}), updated: true });
      },
    },
    {
      name: 'list_resources',
      kind: 'read',
      title: 'List beehiiv segments, automations and more',
      description:
        'One of a publication\'s smaller lists: segments (with their size at the last calculation; Free keeps 3, Lite 10), automations (with '
        + 'their triggers and whether they take Add by API, needed to enroll someone), custom fields (names and kinds), tiers (IDs for '
        + 'recipients) or post templates. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          kind: { type: 'string', enum: ['segments', 'automations', 'custom_fields', 'tiers', 'post_templates'], description: 'Which list.' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['kind'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; kind: string; cursor?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const at = pageState(h, args.cursor);
        const order = args.kind === 'segments' ? { order_by: 'last_calculated', direction: 'desc' } : {};
        const { data } = await h.api({ path: `${V2}/publications/${id}/${args.kind}`, query: { limit: 100, ...order, ...pageQuery(at) } });
        const items = (Array.isArray(data?.data) ? data.data : []).map((item: any) => trimResource(args.kind, item));
        return beehiivPage(h, args.kind, data, items, at, { publication_id: id });
      },
    },
    {
      name: 'list_segment_members',
      kind: 'read',
      title: 'List a beehiiv segment\'s members',
      description: 'The subscriptions in a segment. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          segment_id: { type: 'string', pattern: '^seg_[0-9A-Za-z-]{8,64}$', description: 'The segment ID (seg_...).' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Members per page, 1 to 100 (default 100).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['segment_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; segment_id: string; limit: number; cursor?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        const at = pageState(h, args.cursor);
        const { data } = await h.api({ path: `${V2}/publications/${id}/segments/${args.segment_id}/members`, query: { limit: args.limit, ...pageQuery(at) }, errors: { 404: 'beehiiv found no such segment' } });
        const members = (Array.isArray(data?.data) ? data.data : []).map(trimSubscription);
        return beehiivPage(h, 'members', data, members, at, { segment_id: args.segment_id });
      },
    },
    {
      name: 'enroll_in_automation',
      kind: 'create',
      check: 'get_subscription',
      title: 'Enroll a beehiiv subscriber in an automation',
      description:
        'Starts an automation for an existing subscriber, by subscription ID or email; the automation emails them. It needs an active Add by '
        + 'API trigger (list_resources with kind automations shows it).',
      inputSchema: {
        type: 'object',
        properties: {
          publication_id: PUBLICATION_ID,
          automation_id: { type: 'string', pattern: '^aut_[0-9A-Za-z-]{8,64}$', description: 'The automation ID (aut_...).' },
          subscription_id: SUBSCRIPTION_ID,
          email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254, description: 'Or the subscriber\'s address.' },
        },
        required: ['automation_id'],
        additionalProperties: false,
      },
      async run(args: { publication_id?: string; automation_id: string; subscription_id?: string; email?: string }, h) {
        const id = publicationOf(h, args.publication_id);
        if ((args.subscription_id === undefined) === (args.email === undefined)) throw new ToolFailure('Give subscription_id or email, one of them. Nothing was sent.');
        const { data } = await h.api({
          method: 'POST',
          path: `${V2}/publications/${id}/automations/${args.automation_id}/journeys`,
          json: compact({ subscription_id: args.subscription_id, email: args.email }),
          write: true,
          errors: { 404: 'beehiiv found no such automation or subscriber' },
        });
        const journey = data?.data ?? {};
        return compact({ enrolled: true, journey_id: journey.id, status: journey.status, automation_id: journey.automation_id ?? args.automation_id, subscription_id: journey.subscription_id, email: journey.email });
      },
    },
    // The rest of the beehiiv API v2: referral program, polls, authors, workspace, subscription lookups by ID or email.
    ...apiTools({
      label: 'beehiiv',
      description:
        'The beehiiv API v2 at https://api.beehiiv.com/v2, with the connected key: paths start with /v2/, such as '
        + '/v2/publications/{id}/referral_program or /v2/publications/{id}/authors; array parameters go as "expand[]": ["stats"]. Webhooks '
        + 'and deleting posts or subscriptions are not offered. Reference: https://developers.beehiiv.com/api-reference.',
      basePath: '/v2/',
      guard(request) {
        if (request.method !== 'GET' && request.segments.includes('webhooks')) {
          throw new ToolFailure('Webhooks are not offered here: a webhook would send subscriber events to another address. Nothing was sent.');
        }
        const [, , , kind, item, rest] = request.segments;
        if (request.method === 'DELETE' && (kind === 'posts' || kind === 'subscriptions') && item && rest === undefined) {
          throw new ToolFailure('beehiiv deletes posts and subscriptions for good, so that is not offered here: delete it in beehiiv itself. Nothing was sent.');
        }
      },
    }),
  ],
});

export = connector;
