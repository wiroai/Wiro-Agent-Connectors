import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'oauth-token-0123456789abcdef';
const KEY = '0123456789abcdef'.repeat(2) + '-us6';
const signIn = { access_token: TOKEN, server: 'us19' };
const keyed = { apikey: KEY };
const json = (name) => fixture(import.meta.url, name);
const LIST = 'abc123def4';
const CAMPAIGN = '42694e9e57';
const HASH = 'b58996c504c5638798eb6b511e6f49af';

function setup(handler, credentials = signIn) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

const noContent = () => new Response(null, { status: 204 });

test('the module declares every data center origin and the two ways in', () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.equal(module.origins.length, 30);
  assert.equal(module.origins[0], 'https://us1.api.mailchimp.com');
  assert.equal(module.origins[18], 'https://us19.api.mailchimp.com');
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.credentials), ['access_token', 'apikey', 'server']);
  assert.deepEqual(plain(module.requiredCredentials), [['access_token', 'server'], ['apikey']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('a sign-in goes to its data center with a Bearer token', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('root.json')));
  const { payload, isError } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://us19.api.mailchimp.com/3.0/');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    account_id: '8d3a3db4d97663a9074efcc16',
    account_name: 'Example Co',
    email: 'owner@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    role: 'owner',
    pricing_plan_type: 'monthly',
    account_timezone: 'America/Los_Angeles',
    total_subscribers: 5420,
    industry_stats: { open_rate: 0.21, bounce_rate: 0.01, click_rate: 0.02 },
    data_center: 'us19',
    connected_with: 'sign-in',
  });
});

test('an API key goes to the data center its last part names, with Basic auth', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('root.json')), keyed);
  const { payload } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://us6.api.mailchimp.com/3.0/');
  assert.equal(fetch.calls[0].headers.authorization, `Basic ${btoa(`anystring:${KEY}`)}`);
  assert.equal(payload.data_center, 'us6');
  assert.equal(payload.connected_with, 'API key');

  // A key's own data center wins over a stale server value.
  const both = setup(() => jsonResponse(200, json('root.json')), { apikey: KEY, server: 'us2' });
  await callTool(both.module, 'get_account', {}, both.ctx);
  assert.equal(both.fetch.calls[0].origin, 'https://us6.api.mailchimp.com');
});

test('credentials that cannot name a data center send nothing', async () => {
  const cases = [
    [{}, 'Mailchimp is not connected: it needs the Mailchimp access token and Mailchimp data center (server), or the Mailchimp API key.'],
    [{ access_token: TOKEN }, 'Mailchimp is not connected: it needs the Mailchimp data center (server), or the Mailchimp API key.'],
    [{ access_token: TOKEN, server: 'evil.example.com' }, 'Mailchimp is not connected correctly: the data center (server) of the sign-in is not one Mailchimp names, such as us19; connect Mailchimp again. Nothing was sent.'],
    [{ apikey: '0123456789abcdef' }, 'Mailchimp is not connected correctly: the API key lacks its last part after the dash (such as -us19), which names its data center; paste the whole key. Nothing was sent.'],
    [{ apikey: '0123456789abcdef-us99' }, 'Mailchimp is not connected correctly: the API key ends with a data center this connector does not know. Nothing was sent.'],
  ];
  for (const [credentials, message] of cases) {
    const { module, fetch, ctx } = setup(() => jsonResponse(200, {}), credentials);
    const { payload } = await callTool(module, 'list_audiences', {}, ctx);
    assert.equal(payload.error, message);
    assert.equal(fetch.calls.length, 0);
  }
  // A key without its suffix still works with the server value a sign-in left.
  const fallback = setup(() => jsonResponse(200, json('lists.json')), { apikey: '0123456789abcdef', server: 'us7' });
  await callTool(fallback.module, 'list_audiences', {}, fallback.ctx);
  assert.equal(fallback.fetch.calls[0].origin, 'https://us7.api.mailchimp.com');
});

test('members are addressed by the MD5 of the lower-cased email', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('member.json')));
  const { payload } = await callTool(module, 'get_member', { list_id: LIST, email: 'User@Example.com' }, ctx);
  assert.equal(fetch.calls[0].url, `https://us19.api.mailchimp.com/3.0/lists/${LIST}/members/${HASH}`);
  assert.deepEqual(payload, {
    id: HASH,
    email_address: 'user@example.com',
    status: 'subscribed',
    full_name: 'Jane Doe',
    merge_fields: { FNAME: 'Jane', LNAME: 'Doe', ADDRESS: '', PHONE: '' },
    tags: ['VIP'],
    vip: false,
    language: 'en',
    member_rating: 4,
    source: 'API - Generic',
    timestamp_opt: '2025-01-10T10:00:00+00:00',
    last_changed: '2026-11-21T10:00:00+00:00',
    avg_open_rate: 0.65,
    avg_click_rate: 0.12,
    country_code: 'US',
    list_id: LIST,
  });

});

test('the subscriber hash is standard MD5, for any length and for non-ASCII addresses', async () => {
  const { createHash } = await import('node:crypto');
  const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('member.json')));
  const emails = [
    'user@example.com',
    'a@b.co',
    'Ann.Example+news@Example.org',
    'zoë@exämple.com',
    `${'x'.repeat(55)}@example.com`,
    `${'y'.repeat(120)}@example.com`,
  ];
  for (const email of emails) {
    await callTool(module, 'get_member', { list_id: LIST, email }, ctx);
    assert.equal(fetch.calls.at(-1).path.slice(-32), md5(email.toLowerCase()), email);
  }
  assert.equal(md5('user@example.com'), HASH);
});

test('list_audiences pages with count and offset, leaves Mailchimp\'s links out, and keeps the stats', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('lists.json')));
  const { payload } = await callTool(module, 'list_audiences', { count: 1 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://us19.api.mailchimp.com/3.0/lists?count=1&offset=0&exclude_fields=_links%2Clists._links');
  assert.equal(payload.total_items, 1);
  assert.equal(payload.nextCursor, undefined);
  assert.deepEqual(payload.lists[0].stats.member_count, 5420);
  assert.equal(JSON.stringify(payload).includes('_links'), false);
  assert.equal(payload.lists[0].permission_reminder, undefined);
});

test('a long member page is cut under 32 KB and resumes inside the same Mailchimp page', async () => {
  const members = Array.from({ length: 300 }, (_, index) => ({
    id: String(index).padStart(32, '0'),
    email_address: `person${index}@example.com`,
    status: 'subscribed',
    merge_fields: { FNAME: `Person ${index}`, NOTES: 'n'.repeat(300) },
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { members, total_items: 900 }));
  const first = await callTool(module, 'list_members', { list_id: LIST, count: 300 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.members.length;
  const second = await callTool(module, 'list_members', { list_id: LIST, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.offset, '0');
  assert.equal(second.payload.members[0].email_address, `person${shown}@example.com`);
  assert.equal(fetch.calls[0].query.sort_field, 'last_changed');
});

test('upsert_member PUTs the member at its hash with status_if_new', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('member.json')));
  const { payload } = await callTool(module, 'upsert_member', {
    list_id: LIST,
    email: 'user@example.com',
    status_if_new: 'pending',
    merge_fields: { FNAME: 'Jane' },
    vip: true,
  }, ctx);
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].url, `https://us19.api.mailchimp.com/3.0/lists/${LIST}/members/${HASH}`);
  assert.deepEqual(fetch.calls[0].json, { email_address: 'user@example.com', status_if_new: 'pending', merge_fields: { FNAME: 'Jane' }, vip: true });
  assert.equal(payload.email_address, 'user@example.com');

  const missing = await callTool(module, 'upsert_member', { list_id: LIST, email: 'user@example.com' }, ctx);
  assert.match(missing.payload.error, /`status_if_new` is required/);
  assert.equal(fetch.calls.length, 1);
});

test('a Mailchimp validation error keeps its own words', async () => {
  const { module, ctx } = setup(() => jsonResponse(400, json('error-400.json')));
  const { payload } = await callTool(module, 'upsert_member', { list_id: LIST, email: 'user@example.com', status_if_new: 'subscribed' }, ctx);
  assert.equal(payload.status, 400);
  assert.match(payload.error, /^Mailchimp did not accept the member \(HTTP 400\)\. Mailchimp said: "The resource submitted could not be validated\./);

  const denied = setup(() => jsonResponse(401, json('error-401.json')), keyed);
  const auth = await callTool(denied.module, 'get_account', {}, denied.ctx);
  assert.match(auth.payload.error, /Mailchimp rejected the credentials \(HTTP 401\): Your API key may be invalid, or you've attempted to access the wrong datacenter\. Check that the Mailchimp API key is correct and still active\./);
});

test('batch_upsert_members reports counts, the emails and each error', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('batch.json')));
  const { payload } = await callTool(module, 'batch_upsert_members', {
    list_id: LIST,
    members: [
      { email_address: 'alice@example.com', status: 'subscribed', merge_fields: { FNAME: 'Alice' } },
      { email_address: 'user@example.com', status_if_new: 'subscribed' },
    ],
  }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `https://us19.api.mailchimp.com/3.0/lists/${LIST}`);
  assert.equal(fetch.calls[0].json.update_existing, true);
  assert.deepEqual(payload, {
    total_created: 1,
    total_updated: 1,
    error_count: 1,
    new_members: ['alice@example.com'],
    updated_members: ['user@example.com'],
    errors: [{ email_address: 'bad@', error: 'bad@ looks fake or invalid, please enter a real email address.', error_code: 'ERROR_CONTACT_EXISTS' }],
  });

  const noStatus = await callTool(module, 'batch_upsert_members', { list_id: LIST, members: [{ email_address: 'a@example.com' }] }, ctx);
  assert.match(noStatus.payload.error, /members\[0\] needs a status or a status_if_new/);
});

test('tags, archive and permanent delete act on the member\'s hash', async () => {
  const { module, fetch, ctx } = setup(noContent);
  await callTool(module, 'update_member_tags', { list_id: LIST, email: 'user@example.com', add: ['VIP'], remove: ['Cold'] }, ctx);
  assert.equal(fetch.calls[0].url, `https://us19.api.mailchimp.com/3.0/lists/${LIST}/members/${HASH}/tags`);
  assert.deepEqual(fetch.calls[0].json, { tags: [{ name: 'VIP', status: 'active' }, { name: 'Cold', status: 'inactive' }] });

  const archived = await callTool(module, 'remove_member', { list_id: LIST, email: 'user@example.com' }, ctx);
  assert.equal(fetch.calls[1].method, 'DELETE');
  assert.deepEqual(archived.payload, { email: 'user@example.com', archived: true });
  const deleted = await callTool(module, 'remove_member', { list_id: LIST, email: 'user@example.com', permanent: true }, ctx);
  assert.equal(fetch.calls[2].method, 'POST');
  assert.equal(fetch.calls[2].path, `/3.0/lists/${LIST}/members/${HASH}/actions/delete-permanent`);
  assert.deepEqual(deleted.payload, { email: 'user@example.com', deleted: true });

  const nothing = await callTool(module, 'update_member_tags', { list_id: LIST, email: 'user@example.com' }, ctx);
  assert.match(nothing.payload.error, /Give tags to add or to remove/);
  assert.equal(fetch.calls.length, 3);
});

test('search_members returns exact matches and the wider search', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('search.json')));
  const { payload } = await callTool(module, 'search_members', { query: 'user@example.com', list_id: LIST }, ctx);
  assert.equal(fetch.calls[0].path, '/3.0/search-members');
  assert.equal(fetch.calls[0].query.query, 'user@example.com');
  assert.equal(payload.exact_matches.total_items, 1);
  assert.equal(payload.exact_matches.members[0].email_address, 'user@example.com');
  assert.deepEqual(payload.full_search, { total_items: 0, members: [] });
});

test('the campaign flow: create a draft, set its content, check, test, send, schedule and unschedule', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/send-checklist')) return jsonResponse(200, json('checklist.json'));
    if (request.path.endsWith('/content')) return jsonResponse(200, { html: '<p>Hi</p>', plain_text: 'Hi' });
    if (request.path.includes('/actions/')) return noContent();
    return jsonResponse(200, json('campaign.json'));
  });
  const created = await callTool(module, 'create_campaign', {
    list_id: LIST,
    saved_segment_id: 12345,
    subject_line: 'December news',
    preview_text: 'What we shipped',
    from_name: 'Example Team',
    reply_to: 'hello@example.com',
  }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://us19.api.mailchimp.com/3.0/campaigns');
  assert.deepEqual(fetch.calls[0].json, {
    type: 'regular',
    recipients: { list_id: LIST, segment_opts: { saved_segment_id: 12345 } },
    settings: { subject_line: 'December news', preview_text: 'What we shipped', from_name: 'Example Team', reply_to: 'hello@example.com' },
  });
  assert.equal(created.payload.id, CAMPAIGN);
  assert.equal(created.payload.recipients.segment_text, 'All subscribers');
  assert.equal(JSON.stringify(created.payload).includes('_links'), false);

  const content = await callTool(module, 'set_campaign_content', { campaign_id: CAMPAIGN, html: '<p>Hi *|FNAME|*</p><a href="*|UNSUB|*">Unsubscribe</a>' }, ctx);
  assert.equal(fetch.calls[1].method, 'PUT');
  assert.equal(fetch.calls[1].path, `/3.0/campaigns/${CAMPAIGN}/content`);
  assert.deepEqual(content.payload, { campaign_id: CAMPAIGN, updated: true, has_html: true, has_plain_text: true });

  const checklist = await callTool(module, 'get_send_checklist', { campaign_id: CAMPAIGN }, ctx);
  assert.deepEqual(checklist.payload, {
    is_ready: false,
    items: [
      { type: 'success', heading: 'List', details: 'Main Newsletter (5,420 recipients)' },
      { type: 'error', heading: 'Content', details: 'Your campaign has no content.' },
    ],
  });

  await callTool(module, 'send_test_email', { campaign_id: CAMPAIGN, emails: ['qa@example.com'] }, ctx);
  assert.deepEqual(fetch.calls[3].json, { test_emails: ['qa@example.com'], send_type: 'html' });
  await callTool(module, 'send_campaign', { campaign_id: CAMPAIGN }, ctx);
  await callTool(module, 'schedule_campaign', { campaign_id: CAMPAIGN, schedule_time: '2026-12-01T14:15:00Z' }, ctx);
  assert.deepEqual(fetch.calls[5].json, { schedule_time: '2026-12-01T14:15:00Z', timewarp: false });
  await callTool(module, 'unschedule_campaign', { campaign_id: CAMPAIGN }, ctx);
  assert.deepEqual(fetch.calls.slice(3).map((call) => `${call.method} ${call.path}`), [
    `POST /3.0/campaigns/${CAMPAIGN}/actions/test`,
    `POST /3.0/campaigns/${CAMPAIGN}/actions/send`,
    `POST /3.0/campaigns/${CAMPAIGN}/actions/schedule`,
    `POST /3.0/campaigns/${CAMPAIGN}/actions/unschedule`,
  ]);

  const offQuarter = await callTool(module, 'schedule_campaign', { campaign_id: CAMPAIGN, schedule_time: '2026-12-01T14:10:00Z' }, ctx);
  assert.match(offQuarter.payload.error, /`schedule_time` does not have the expected format/);
  const twoBodies = await callTool(module, 'set_campaign_content', { campaign_id: CAMPAIGN, html: '<p>x</p>', template_id: 5 }, ctx);
  assert.match(twoBodies.payload.error, /Give one of html, url or template_id/);
  assert.equal(fetch.calls.length, 7);
});

test('get_campaign adds the content only when asked, and update_campaign needs a change', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/content') ? { html: '<p>Hello</p>', plain_text: 'Hello' } : json('campaign.json')));
  const plain = await callTool(module, 'get_campaign', { campaign_id: CAMPAIGN }, ctx);
  assert.equal(plain.payload.content, undefined);
  assert.equal(fetch.calls.length, 1);
  const full = await callTool(module, 'get_campaign', { campaign_id: CAMPAIGN, include_content: true }, ctx);
  assert.deepEqual(full.payload.content, { html: '<p>Hello</p>', plain_text: 'Hello' });

  const empty = await callTool(module, 'update_campaign', { campaign_id: CAMPAIGN }, ctx);
  assert.match(empty.payload.error, /Nothing to change/);
  await callTool(module, 'update_campaign', { campaign_id: CAMPAIGN, subject_line: 'New subject' }, ctx);
  assert.equal(fetch.calls[3].method, 'PATCH');
  assert.deepEqual(fetch.calls[3].json, { settings: { subject_line: 'New subject' } });
});

test('reports: the summary and the parts of a report, without Mailchimp\'s links', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/click-details') ? json('click-details.json') : json('report.json')));
  const report = await callTool(module, 'get_campaign_report', { campaign_id: CAMPAIGN }, ctx);
  assert.equal(report.payload.opens.unique_opens, 2680);
  assert.equal(report.payload.clicks.click_rate, 0.1222);
  assert.equal(report.payload.ecommerce, undefined, 'all-zero e-commerce is left out');

  const clicks = await callTool(module, 'get_report_details', { campaign_id: CAMPAIGN, kind: 'click-details', count: 2 }, ctx);
  assert.equal(fetch.calls[1].path, `/3.0/reports/${CAMPAIGN}/click-details`);
  assert.equal(fetch.calls[1].query.exclude_fields, '_links,urls_clicked._links');
  assert.equal(clicks.payload.total_items, 2);
  assert.deepEqual(clicks.payload.urls_clicked[0], {
    id: '1b2c3d4e5f',
    url: 'https://example.com/blog/a',
    total_clicks: 500,
    click_percentage: 0.56,
    unique_clicks: 400,
    unique_click_percentage: 0.61,
    last_click: '2026-11-21T08:00:00+00:00',
    ab_split: {},
  });
});

test('segments, templates and automations', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/segments')) return request.method === 'POST' ? jsonResponse(200, { id: 777, name: 'New tag', type: 'static', member_count: 0 }) : jsonResponse(200, json('segments.json'));
    if (request.path.includes('/segments/')) return jsonResponse(200, { members_added: [{ email_address: 'user@example.com' }], members_removed: [], errors: [], total_added: 1, total_removed: 0, error_count: 0 });
    if (request.path.startsWith('/3.0/automations/')) return noContent();
    return jsonResponse(200, json('automations.json'));
  });
  const segments = await callTool(module, 'list_segments', { list_id: LIST, type: 'static' }, ctx);
  assert.equal(fetch.calls[0].query.type, 'static');
  assert.deepEqual(segments.payload.segments[0], { id: 12345, name: 'VIP', type: 'static', member_count: 42, created_at: '2025-06-01T10:00:00+00:00', updated_at: '2026-11-01T10:00:00+00:00' });

  const tag = await callTool(module, 'create_segment', { list_id: LIST, name: 'New tag', static_segment: [] }, ctx);
  assert.deepEqual(fetch.calls[1].json, { name: 'New tag', static_segment: [] });
  assert.equal(tag.payload.id, 777);
  const neither = await callTool(module, 'create_segment', { list_id: LIST, name: 'x' }, ctx);
  assert.match(neither.payload.error, /static_segment or options/);

  const members = await callTool(module, 'update_segment_members', { list_id: LIST, segment_id: 12345, add: ['user@example.com'] }, ctx);
  assert.equal(fetch.calls[2].path, `/3.0/lists/${LIST}/segments/12345`);
  assert.deepEqual(fetch.calls[2].json, { members_to_add: ['user@example.com'] });
  assert.deepEqual(members.payload, { total_added: 1, total_removed: 0, error_count: 0, members_added: ['user@example.com'], members_removed: [] });

  const automations = await callTool(module, 'list_automations', {}, ctx);
  assert.equal(automations.payload.automations[0].title, 'Welcome series');
  const paused = await callTool(module, 'set_automation_state', { automation_id: '4e3b0c2a1d', action: 'pause' }, ctx);
  assert.equal(fetch.calls[4].path, '/3.0/automations/4e3b0c2a1d/actions/pause-all-emails');
  assert.deepEqual(paused.payload, { automation_id: '4e3b0c2a1d', paused: true });
});

test('a 429 without Retry-After asks to wait, and a refused URL says nothing was sent', async () => {
  const { module, ctx } = setup(() => jsonResponse(429, { title: 'Too Many Requests', status: 429, detail: 'You have exceeded the limit of 10 simultaneous connections.' }));
  const { payload } = await callTool(module, 'list_campaigns', {}, ctx);
  assert.equal(payload.status, 429);
  assert.match(payload.error, /Mailchimp rate limit reached \(HTTP 429\)\. Wait a while before retrying\./);

  const blocked = setup(() => {
    throw refusal();
  });
  const write = await callTool(blocked.module, 'send_campaign', { campaign_id: CAMPAIGN }, blocked.ctx);
  assert.equal(write.payload.outcome, undefined);
  assert.match(write.payload.error, /blocked before it was sent/);
});

test('writes without a clear answer are unknown, sent once, with the read tool to check', async () => {
  const writes = [
    ['create_audience', { name: 'A', company: 'C', address1: '1 St', city: 'X', country: 'US', permission_reminder: 'P', from_name: 'F', from_email: 'f@example.com' }, 'list_audiences'],
    ['upsert_member', { list_id: LIST, email: 'a@example.com', status_if_new: 'subscribed' }, 'get_member'],
    ['batch_upsert_members', { list_id: LIST, members: [{ email_address: 'a@example.com', status: 'subscribed' }] }, 'list_members'],
    ['update_member_tags', { list_id: LIST, email: 'a@example.com', add: ['t'] }, 'get_member'],
    ['remove_member', { list_id: LIST, email: 'a@example.com' }, 'get_member'],
    ['create_campaign', { list_id: LIST, subject_line: 'S', from_name: 'F', reply_to: 'r@example.com' }, 'list_campaigns'],
    ['update_campaign', { campaign_id: CAMPAIGN, title: 'T' }, 'get_campaign'],
    ['set_campaign_content', { campaign_id: CAMPAIGN, html: '<p>x</p>' }, 'get_campaign'],
    ['send_test_email', { campaign_id: CAMPAIGN, emails: ['a@example.com'] }, 'get_campaign'],
    ['send_campaign', { campaign_id: CAMPAIGN }, 'get_campaign'],
    ['schedule_campaign', { campaign_id: CAMPAIGN, schedule_time: '2026-12-01T14:00:00Z' }, 'get_campaign'],
    ['unschedule_campaign', { campaign_id: CAMPAIGN }, 'get_campaign'],
    ['create_template', { name: 'T', html: '<p>x</p>' }, 'list_templates'],
    ['create_segment', { list_id: LIST, name: 'S', static_segment: [] }, 'list_segments'],
    ['update_segment_members', { list_id: LIST, segment_id: 1, add: ['a@example.com'] }, 'list_segments'],
    ['set_automation_state', { automation_id: 'abc', action: 'start' }, 'list_automations'],
  ];
  for (const respond of [() => jsonResponse(503, { title: 'Service Unavailable', detail: 'down' }), () => { throw new TypeError('fetch failed'); }]) {
    for (const [tool, args, check] of writes) {
      const { module, fetch, ctx } = setup(respond);
      const { payload } = await callTool(module, tool, args, ctx);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check, tool);
      assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
    }
  }
});

test('api_get and api_request go to the connection\'s data center under /3.0/', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { merge_fields: [{ tag: 'FNAME', name: 'First Name', type: 'text' }], total_items: 1 }), keyed);
  const read = await callTool(module, 'api_get', { path: `/3.0/lists/${LIST}/merge-fields` }, ctx);
  assert.equal(read.isError, false, read.payload.error);
  assert.equal(fetch.calls[0].url, `https://us6.api.mailchimp.com/3.0/lists/${LIST}/merge-fields`);
  assert.equal(fetch.calls[0].headers.authorization, `Basic ${btoa(`anystring:${KEY}`)}`);

  const replicate = await callTool(module, 'api_request', { method: 'POST', path: `/3.0/campaigns/${CAMPAIGN}/actions/replicate` }, ctx);
  assert.equal(replicate.isError, false);
  assert.equal(fetch.calls[1].origin, 'https://us6.api.mailchimp.com');

  const apps = await callTool(module, 'api_get', { path: '/3.0/authorized-apps' }, ctx);
  assert.match(apps.payload.error, /authorized apps are not available here/);
  const outside = await callTool(module, 'api_get', { path: '/export/1.0/list' }, ctx);
  assert.equal(outside.payload.error, 'The path must start with /3.0/. Nothing was sent.');
  assert.equal(fetch.calls.length, 2);

  const broken = setup(() => jsonResponse(200, {}), { apikey: 'no-data-center' });
  const refused = await callTool(broken.module, 'api_get', { path: '/3.0/lists' }, broken.ctx);
  assert.match(refused.payload.error, /Mailchimp is not connected correctly/);
  assert.equal(broken.fetch.calls.length, 0);
});

test('logs never carry the token, the key or an email', async () => {
  const signed = setup(() => jsonResponse(200, json('member.json')));
  await callTool(signed.module, 'get_member', { list_id: LIST, email: 'user@example.com' }, signed.ctx);
  assert.deepEqual(signed.logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['mailchimp get_member GET 200 Nms']);
  const keyedRun = setup(() => jsonResponse(200, json('root.json')), keyed);
  await callTool(keyedRun.module, 'get_account', {}, keyedRun.ctx);
  const text = [...signed.logs, ...keyedRun.logs].join('\n');
  for (const secret of [TOKEN, KEY, 'user@example.com', HASH]) assert.equal(text.includes(secret), false, secret);
});

test('a text error page from Mailchimp is not shown as the vendor\'s words', async () => {
  const { module, ctx } = setup(() => textResponse(502, '<html><body>Bad gateway</body></html>', { 'content-type': 'text/html' }));
  const { payload } = await callTool(module, 'list_audiences', {}, ctx);
  assert.equal(payload.error, 'Mailchimp had a server error (HTTP 502). Try again later.');
});
