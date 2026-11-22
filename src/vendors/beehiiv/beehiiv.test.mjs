import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const KEY = 'bh_test_key_0123456789abcdefghijklmnop';
const PUB = 'pub_ad76629e-4a39-43ad-8055-0ee89dc6db15';
const POST = 'post_00000000-0000-0000-0000-000000000003';
const SUB = 'sub_00000000-0000-0000-0000-000000000001';
const credentials = { apikey: KEY, publicationid: PUB };

function setup(handler, creds = credentials, signal) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, fetch, signal });
  return { module, fetch, ctx, logs };
}

const json = (name, status = 200, headers = {}) => jsonResponse(status, fixture(import.meta.url, name), headers);

test('list_publications lists what the key reaches with stats, and names the saved default', async () => {
  const { module, fetch, ctx } = setup(() => json('publications.json'));
  const { payload, isError } = await callTool(module, 'list_publications', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.beehiiv.com/v2/publications?limit=100&expand%5B%5D=stats&page=1');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(payload.default_publication_id, PUB);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.publications[0], {
    id: PUB,
    name: 'Acme Weekly',
    organization: 'Acme',
    created: '2022-10-26T16:01:16.000Z',
    stats: {
      active_subscriptions: 1200,
      active_premium_subscriptions: 80,
      active_free_subscriptions: 1120,
      average_open_rate: 48.2,
      average_click_rate: 6.1,
      total_sent: 54000,
      total_unique_opened: 25000,
      total_clicked: 3100,
    },
  });
  assert.equal(payload.nextCursor, undefined);
});

test('a tool that needs a publication asks for one when none is saved, before any request', async () => {
  const { module, fetch, ctx } = setup(() => json('posts.json'), { apikey: KEY });
  const { payload } = await callTool(module, 'list_posts', {}, ctx);
  assert.match(payload.error, /Name the publication: pass publication_id \(list_publications lists the ones this key reaches\)/);
  const bad = setup(() => json('posts.json'), { apikey: KEY, publicationid: 'my publication' });
  const malformed = await callTool(bad.module, 'list_posts', {}, bad.ctx);
  assert.match(malformed.payload.error, /must be pub_ followed by 36 letters/);
  assert.equal(fetch.calls.length + bad.fetch.calls.length, 0);

  const noKey = setup(() => json('posts.json'), { publicationid: PUB });
  assert.equal((await callTool(noKey.module, 'list_posts', {}, noKey.ctx)).payload.error, 'beehiiv is not connected: the beehiiv API key is missing.');
});

test('list_posts reads sent posts with stats and shares of delivered emails, and pages', async () => {
  const { module, fetch, ctx } = setup(() => json('posts.json'));
  const first = await callTool(module, 'list_posts', { limit: 2, content_tags: ['product'] }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].path, `/v2/publications/${PUB}/posts`);
  assert.deepEqual(fetch.calls[0].query, { 'expand[]': 'stats', status: 'confirmed', 'content_tags[]': 'product', order_by: 'publish_date', direction: 'desc', limit: '2', page: '1' });
  assert.equal(first.payload.total, 7);
  assert.deepEqual(first.payload.posts[0], {
    id: 'post_00000000-0000-0000-0000-000000000001',
    title: 'Weekly digest',
    status: 'confirmed',
    audience: 'free',
    platform: 'both',
    publish_date: '2026-11-21T22:26:40.000Z',
    web_url: 'https://acme.example.com/p/weekly-digest',
    content_tags: ['product'],
    stats: {
      email: {
        recipients: 100,
        delivered: 98,
        opens: 50,
        unique_opens: 45,
        unique_open_share_pct: 45.9,
        clicks: 10,
        unique_clicks: 8,
        unique_click_share_pct: 8.2,
        unsubscribes: 1,
        spam_reports: 0,
        beehiiv_open_rate: 45.9,
        beehiiv_click_rate: 8.2,
      },
      web: { views: 200, clicks: 40 },
    },
  });
  assert.equal(first.payload.posts[1].stats, undefined, 'a draft has no stats');
  await callTool(module, 'list_posts', { limit: 2, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '2');
});

test('get_post gives the ten best links and one body version in windows', async () => {
  const { module, fetch, ctx } = setup(() => json('post.json'));
  const { payload } = await callTool(module, 'get_post', { post_id: 'post_00000000-0000-0000-0000-000000000001', content: 'free_web' }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/posts/post_00000000-0000-0000-0000-000000000001?expand%5B%5D=stats&expand%5B%5D=free_web_content`);
  assert.deepEqual(payload.top_links, [
    { url: 'https://acme.example.com/docs', unique_clicks: 9, email_unique_clicks: 7, web_unique_clicks: 2 },
    { url: 'https://acme.example.com/pricing', unique_clicks: 3, email_unique_clicks: 2, web_unique_clicks: 1 },
  ]);
  assert.equal(payload.content, '<h1>Weekly digest</h1>\n<p>Hello</p>\n');
  assert.equal(payload.subject_line, 'Three changes worth knowing');

  const big = setup(() => jsonResponse(200, { data: { id: POST, status: 'draft', content: { free: { email: '<p>'.concat('Ünïcode "text" '.repeat(5000), '</p>') } } } }));
  const window = await callTool(big.module, 'get_post', { post_id: POST, content: 'free_email' }, big.ctx);
  assert.ok(textBytes(window.result) <= 32 * 1024);
  assert.ok(window.payload.nextCursor);

  const pending = setup(() => json('pending.json', 202, { 'retry-after': '1' }));
  const still = await callTool(pending.module, 'get_post', { post_id: POST }, pending.ctx);
  assert.deepEqual(still.payload, { id: POST, state: 'pending', note: 'beehiiv is still creating the post: read it again in a moment.' });
});

test('get_posts_aggregate_stats reads totals with the same filters', async () => {
  const { module, fetch, ctx } = setup(() => json('aggregate.json'));
  const { payload } = await callTool(module, 'get_posts_aggregate_stats', { platform: 'email' }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/posts/aggregate_stats?status=confirmed&platform=email`);
  assert.equal(payload.stats.email.unique_open_share_pct, 46.9);
  assert.deepEqual(payload.top_links, [{ url: 'https://acme.example.com/docs', unique_clicks: 120 }]);
});

const DRAFT = {
  title: 'November product notes',
  subtitle: 'Three changes worth knowing',
  body_content: '<p style="font-size:16px">Hello</p>',
  email_subject_line: 'Three changes worth knowing',
  email_preview_text: 'What shipped in November',
  recipients: { email: { tier_ids: ['free', 'premium'] }, web: { tier_ids: ['free', 'premium'] } },
  content_tags: ['product'],
  web_slug: 'november-notes',
};

test('create_draft_post saves a draft, then reads it back while beehiiv finishes it', async () => {
  let reads = 0;
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'POST') return json('created.json', 201);
    reads += 1;
    return reads === 1 ? json('pending.json', 202, { 'retry-after': '0' }) : json('draft.json');
  });
  const { payload, isError } = await callTool(module, 'create_draft_post', DRAFT, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/posts`);
  assert.deepEqual(fetch.calls[0].json, {
    title: DRAFT.title,
    subtitle: DRAFT.subtitle,
    body_content: DRAFT.body_content,
    email_settings: { email_subject_line: DRAFT.email_subject_line, email_preview_text: DRAFT.email_preview_text },
    web_settings: { slug: 'november-notes' },
    recipients: DRAFT.recipients,
    content_tags: ['product'],
    status: 'draft',
  });
  assert.equal('scheduled_at' in fetch.calls[0].json, false);
  assert.deepEqual(fetch.calls.map((call) => call.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(payload, {
    saved: 'draft: nothing was sent',
    id: POST,
    preview_url: 'https://app.beehiiv.com/posts/00000000-0000-0000-0000-000000000003/preview',
    state: 'ready',
    status: 'draft',
    title: 'November product notes',
  });
});

test('a post beehiiv could not finish is reported as not saved; a cancelled wait stops reading', async () => {
  const failed = setup((request) => (request.method === 'POST' ? json('created.json', 201) : json('error-404-creation.json', 404)));
  const gone = await callTool(failed.module, 'create_draft_post', DRAFT, failed.ctx);
  assert.equal(gone.isError, true);
  assert.equal(gone.payload.outcome, undefined);
  assert.match(gone.payload.error, /could not finish creating it \(POST_CREATION_FAILED\), so no draft exists/);

  const controller = new AbortController();
  const slow = setup((request) => {
    if (request.method === 'POST') return json('created.json', 201);
    setTimeout(() => controller.abort(), 5);
    return json('pending.json', 202, { 'retry-after': '5' });
  }, credentials, controller.signal);
  const started = Date.now();
  const pending = await callTool(slow.module, 'create_draft_post', DRAFT, slow.ctx);
  assert.ok(Date.now() - started < 2000, 'the wait ends with the cancellation');
  assert.equal(pending.payload.state, 'pending');
  assert.equal(slow.fetch.calls.length, 2);
});

test('creating posts without the Send API, and a create without a clear answer', async () => {
  const free = setup(() => json('error-403.json', 403));
  const refused = await callTool(free.module, 'create_draft_post', DRAFT, free.ctx);
  assert.match(refused.payload.error, /needs the Pro or Enterprise plan, and not a Pro trial \(HTTP 403\)\. beehiiv said: "This feature requires the Pro plan"\. Nothing was changed\./);

  const down = setup(() => jsonResponse(502, { status: 502, statusText: 'Bad Gateway', errors: [{ message: 'Bad gateway' }] }));
  const unknown = await callTool(down.module, 'create_draft_post', DRAFT, down.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_posts');
  assert.equal(down.fetch.calls.length, 1);
});

test('update_draft_post reads the post first and changes drafts only', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET' ? json('draft.json') : json('draft.json')));
  const { payload } = await callTool(module, 'update_draft_post', { post_id: POST, title: 'November notes', body_content: '<p>New</p>' }, ctx);
  assert.deepEqual(fetch.calls.map((call) => call.method), ['GET', 'PATCH']);
  assert.deepEqual(fetch.calls[1].json, { title: 'November notes', body_content: '<p>New</p>' });
  assert.equal(payload.updated, true);

  const sent = setup(() => json('post.json'));
  const refused = await callTool(sent.module, 'update_draft_post', { post_id: 'post_00000000-0000-0000-0000-000000000001', title: 'x' }, sent.ctx);
  assert.match(refused.payload.error, /This post is confirmed, and update_draft_post changes drafts only/);
  assert.deepEqual(sent.fetch.calls.map((call) => call.method), ['GET']);

  const nothing = await callTool(module, 'update_draft_post', { post_id: POST }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 2);
});

test('send_test_email sends to the given addresses and says how many tests are left', async () => {
  const { module, fetch, ctx } = setup(() => json('test-send.json'));
  const { payload } = await callTool(module, 'send_test_email', { post_id: POST, recipient_emails: ['me@example.com'] }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/posts/${POST}/test_sends`);
  assert.deepEqual(fetch.calls[0].json, { recipient_emails: ['me@example.com'] });
  assert.deepEqual(payload, { sent: true, to: 1, test_sends_left_today: 19, resets_at: '2026-11-23T05:00:00.000Z' });

  const capped = setup(() => json('error-422.json', 422));
  assert.match((await callTool(capped.module, 'send_test_email', { post_id: POST, recipient_emails: ['me@example.com'] }, capped.ctx)).payload.error, /daily test send cap may be reached/);
});

test('send_post confirms a draft now or at a scheduled time', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: { id: POST, title: 'November product notes', status: 'confirmed', publish_date: 1795600000 } }));
  const scheduled = await callTool(module, 'send_post', { post_id: POST, scheduled_at: '2026-11-24T14:00:00Z' }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.deepEqual(fetch.calls[0].json, { status: 'confirmed', scheduled_at: '2026-11-24T14:00:00Z' });
  assert.match(scheduled.payload.note, /Scheduled for 2026-11-24T14:00:00Z\. To stop it, unschedule it in beehiiv itself\./);
  const now = await callTool(module, 'send_post', { post_id: POST }, ctx);
  assert.deepEqual(fetch.calls[1].json, { status: 'confirmed' });
  assert.match(now.payload.note, /^Sent/);
  const badTime = await callTool(module, 'send_post', { post_id: POST, scheduled_at: 'next Tuesday' }, ctx);
  assert.match(badTime.payload.error, /`scheduled_at` does not have the expected format/);
  assert.equal(fetch.calls.length, 2);
});

test('subscriptions: a lookup by email with cursor paging, one by ID with tags', async () => {
  const { module, fetch, ctx } = setup(() => json('subscriptions.json'));
  const first = await callTool(module, 'list_subscriptions', { email: 'jane@example.com' }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/subscriptions?email=jane%40example.com&limit=10&expand%5B%5D=custom_fields&expand%5B%5D=stats`);
  assert.deepEqual(first.payload.subscriptions[0], {
    id: SUB,
    email: 'jane@example.com',
    status: 'active',
    created: '2024-05-14T14:55:29.000Z',
    tier: 'free',
    utm_source: 'webinar',
    custom_fields: { 'First Name': 'Jane' },
    stats: { emails_received: 12, open_rate: 75, click_through_rate: 8.3 },
  });
  await callTool(module, 'list_subscriptions', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.cursor, 'eyJ0aW1lc3RhbXAiOjE3MTU2OTg1Mjl9');

  const one = setup(() => json('subscription.json'));
  const sub = await callTool(one.module, 'get_subscription', { subscription_id: SUB }, one.ctx);
  assert.equal(one.fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/subscriptions/${SUB}?expand%5B%5D=tags&expand%5B%5D=custom_fields&expand%5B%5D=stats`);
  assert.deepEqual(sub.payload.tags, ['webinar-2026']);
  assert.deepEqual(sub.payload.premium_tiers, ['Gold']);
});

test('create_subscription sends no welcome email and no reactivation unless asked, and passes warnings on', async () => {
  const { module, fetch, ctx } = setup(() => json('subscription-warning.json', 201));
  const { payload } = await callTool(module, 'create_subscription', { email: 'sam@example.com', utm_source: 'webinar', custom_fields: [{ name: 'Plan', value: 'Pro' }] }, ctx);
  assert.deepEqual(fetch.calls[0].json, {
    email: 'sam@example.com',
    send_welcome_email: false,
    reactivate_existing: false,
    double_opt_override: 'not_set',
    utm_source: 'webinar',
    custom_fields: [{ name: 'Plan', value: 'Pro' }],
  });
  assert.equal(payload.status, 'validating');
  assert.deepEqual(payload.warnings, ['Unknown custom field: Plan']);
});

test('tags, custom fields and unsubscribing go to the subscription', async () => {
  const { module, fetch, ctx } = setup(() => json('subscription.json'));
  await callTool(module, 'add_subscription_tags', { subscription_id: SUB, tags: ['webinar-2026'] }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/subscriptions/${SUB}/tags`);
  assert.deepEqual(fetch.calls[0].json, { tags: ['webinar-2026'] });

  await callTool(module, 'update_subscription', { subscription_id: SUB, custom_fields: [{ name: 'Plan', delete: true }], unsubscribe: true }, ctx);
  assert.equal(fetch.calls[1].method, 'PUT');
  assert.deepEqual(fetch.calls[1].json, { custom_fields: [{ name: 'Plan', delete: true }], unsubscribe: true });
  const nothing = await callTool(module, 'update_subscription', { subscription_id: SUB }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 2);
});

test('list_resources reads segments by last calculation and automations with their Add by API trigger', async () => {
  const segments = setup(() => json('segments.json'));
  const seg = await callTool(segments.module, 'list_resources', { kind: 'segments' }, segments.ctx);
  assert.equal(segments.fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/segments?limit=100&order_by=last_calculated&direction=desc&page=1`);
  assert.deepEqual(seg.payload.segments, [{ id: 'seg_00000000-0000-0000-0000-000000000001', name: 'Engaged', type: 'dynamic', subscribers: 640, status: 'completed', active: true, last_calculated: '2026-11-21T22:26:40.000Z' }]);

  const automations = setup(() => json('automations.json'));
  const aut = await callTool(automations.module, 'list_resources', { kind: 'automations' }, automations.ctx);
  assert.deepEqual(aut.payload.automations.map((item) => [item.name, item.add_by_api]), [['Welcome series', true], ['Win-back', false]]);

  const members = setup(() => json('subscriptions.json'));
  const listed = await callTool(members.module, 'list_segment_members', { segment_id: 'seg_00000000-0000-0000-0000-000000000001' }, members.ctx);
  assert.equal(members.fetch.calls[0].path, `/v2/publications/${PUB}/segments/seg_00000000-0000-0000-0000-000000000001/members`);
  assert.equal(listed.payload.members[0].email, 'jane@example.com');
});

test('enroll_in_automation starts a journey for one subscriber', async () => {
  const { module, fetch, ctx } = setup(() => json('journey.json', 201));
  const { payload } = await callTool(module, 'enroll_in_automation', { automation_id: 'aut_00000000-0000-0000-0000-000000000001', subscription_id: SUB }, ctx);
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/automations/aut_00000000-0000-0000-0000-000000000001/journeys`);
  assert.deepEqual(fetch.calls[0].json, { subscription_id: SUB });
  assert.equal(payload.status, 'in_progress');
  const both = await callTool(module, 'enroll_in_automation', { automation_id: 'aut_00000000-0000-0000-0000-000000000001', subscription_id: SUB, email: 'jane@example.com' }, ctx);
  assert.match(both.payload.error, /Give subscription_id or email, one of them/);
  assert.equal(fetch.calls.length, 1);
});

test('writes without a clear answer are unknown and sent once', async () => {
  const fail = () => jsonResponse(503, { status: 503, statusText: 'Service Unavailable', errors: [{ message: 'Try again' }] });
  const cases = [
    ['send_post', { post_id: POST }, 'get_post'],
    ['send_test_email', { post_id: POST, recipient_emails: ['me@example.com'] }, 'get_post'],
    ['create_subscription', { email: 'sam@example.com' }, 'list_subscriptions'],
    ['add_subscription_tags', { subscription_id: SUB, tags: ['x'] }, 'get_subscription'],
    ['update_subscription', { subscription_id: SUB, unsubscribe: true }, 'get_subscription'],
    ['enroll_in_automation', { automation_id: 'aut_00000000-0000-0000-0000-000000000001', email: 'jane@example.com' }, 'get_subscription'],
  ];
  for (const [tool, args, check] of cases) {
    const { module, fetch, ctx } = setup(fail);
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
    assert.equal(payload.check, check);
    assert.equal(fetch.calls.length, 1);
  }
});

test('api_get and api_request reach the rest of the API, without webhooks or deleting posts and subscriptions', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { data: { enabled: true } }));
  const read = await callTool(module, 'api_get', { path: `/v2/publications/${PUB}/referral_program`, query: { 'expand[]': ['rewards'] } }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { data: { enabled: true } } });
  assert.equal(fetch.calls[0].url, `https://api.beehiiv.com/v2/publications/${PUB}/referral_program?expand%5B%5D=rewards`);
  const hook = await callTool(module, 'api_request', { method: 'POST', path: `/v2/publications/${PUB}/webhooks`, json: { url: 'https://hooks.example.com' } }, ctx);
  assert.match(hook.payload.error, /Webhooks are not offered here/);
  for (const path of [`/v2/publications/${PUB}/posts/${POST}`, `/v2/publications/${PUB}/subscriptions/${SUB}`]) {
    const removed = await callTool(module, 'api_request', { method: 'DELETE', path }, ctx);
    assert.match(removed.payload.error, /deletes posts and subscriptions for good/);
  }
  assert.equal(fetch.calls.length, 1);
  const untag = await callTool(module, 'api_request', { method: 'DELETE', path: `/v2/publications/${PUB}/subscriptions/${SUB}/tags`, json: { tags: ['old'] } }, ctx);
  assert.equal(untag.isError, false, untag.payload.error);
  assert.equal(fetch.calls.length, 2);
});

test('logs carry neither the key nor the post or the subscriber', async () => {
  const { module, ctx, logs } = setup((request) => (request.method === 'POST' ? json('created.json', 201) : json('draft.json')));
  await callTool(module, 'create_draft_post', { ...DRAFT, body_content: '<p>secret announcement</p>' }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['beehiiv create_draft_post POST 201 Nms', 'beehiiv create_draft_post GET 200 Nms']);
  const joined = logs.join('\n');
  for (const secret of [KEY, 'secret announcement', PUB]) assert.equal(joined.includes(secret), false);
});
