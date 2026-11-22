import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'SG.AbCdEfGhIjKlMnOpQrStUv.0123456789abcdefghijklmnopqrstuvwxyzABCDE';
const credentials = { apikey: KEY };
const json = (name) => fixture(import.meta.url, name);
const LIST = 'ca7a3796-e8a8-4029-9ccb-df8937940562';
const SEND = '27c21bbf-a12c-440b-b8bf-c526975328ca';

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

const accepted = () => new Response(null, { status: 202, headers: { 'x-message-id': 'W5nR2V8vQlOaxkSWGvxJkQ' } });

test('the module declares its origin, its one credential and no account picker', () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(module.origins), ['https://api.sendgrid.com']);
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('get_account reads the key\'s scopes, and the account when the key may', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path === '/v3/scopes' ? json('scopes.json') : json('account.json')));
  const { payload } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/scopes');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(fetch.calls[1].url, 'https://api.sendgrid.com/v3/user/account');
  assert.deepEqual(payload, {
    scopes: 13,
    can: { send_mail: true, marketing: true, templates: true, senders: true, suppressions: true, stats: true, email_activity: true },
    account: { type: 'paid', reputation: 99.7 },
  });

  const narrow = setup(() => jsonResponse(200, { scopes: ['mail.send'] }));
  const small = await callTool(narrow.module, 'get_account', {}, narrow.ctx);
  assert.equal(narrow.fetch.calls.length, 1, 'no account read without user.account.read');
  assert.equal(small.payload.can.marketing, false);
});

test('send_email gives each recipient a copy, keeps text before HTML, and returns the message id', async () => {
  const { module, fetch, ctx } = setup(accepted);
  const { payload, isError } = await callTool(module, 'send_email', {
    from: { email: 'shop@example.com', name: 'Shop' },
    to: [{ email: 'ann@example.com', name: 'Ann' }, { email: 'bob@example.com' }],
    reply_to: { email: 'help@example.com' },
    subject: 'Your order',
    text: 'Thanks',
    html: '<p>Thanks</p>',
    categories: ['orders'],
    asm_group_id: 12,
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  assert.deepEqual(fetch.calls[0].json, {
    personalizations: [{ to: [{ email: 'ann@example.com', name: 'Ann' }] }, { to: [{ email: 'bob@example.com' }] }],
    from: { email: 'shop@example.com', name: 'Shop' },
    reply_to: { email: 'help@example.com' },
    subject: 'Your order',
    content: [{ type: 'text/plain', value: 'Thanks' }, { type: 'text/html', value: '<p>Thanks</p>' }],
    categories: ['orders'],
    asm: { group_id: 12 },
  });
  assert.deepEqual(payload, { accepted: true, status: 202, messageId: 'W5nR2V8vQlOaxkSWGvxJkQ', recipients: 2 });
});

test('send_email sends one shared email with cc and bcc, or a template with its data, or a sandbox check', async () => {
  const { module, fetch, ctx } = setup(accepted);
  const mixed = await callTool(module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }],
    cc: [{ email: 'boss@example.com' }],
    subject: 'Hi',
    text: 'Hi',
  }, ctx);
  assert.match(mixed.payload.error, /cc and bcc go on one shared email: set separate_copies to false/);
  assert.equal(fetch.calls.length, 0);

  await callTool(module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }],
    cc: [{ email: 'boss@example.com' }],
    separate_copies: false,
    subject: 'Hi',
    text: 'Hi',
  }, ctx);
  assert.deepEqual(fetch.calls[0].json.personalizations, [{ to: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }], cc: [{ email: 'boss@example.com' }] }]);

  const templated = await callTool(module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }],
    template_id: 'd-2c214ac919e84170b21855cc129b4a5f',
    dynamic_template_data: { order_id: '1234' },
    sandbox_mode: true,
  }, ctx);
  assert.deepEqual(fetch.calls[1].json, {
    personalizations: [{ to: [{ email: 'ann@example.com' }], dynamic_template_data: { order_id: '1234' } }],
    from: { email: 'shop@example.com' },
    template_id: 'd-2c214ac919e84170b21855cc129b4a5f',
    mail_settings: { sandbox_mode: { enable: true } },
  });
  assert.equal(templated.payload.sandbox, true);

  const noBody = await callTool(module, 'send_email', { from: { email: 'shop@example.com' }, to: [{ email: 'ann@example.com' }], subject: 'x' }, ctx);
  assert.match(noBody.payload.error, /Give text or html, or a template_id/);
  const nobody = await callTool(module, 'send_email', { from: { email: 'shop@example.com' }, subject: 'x', text: 'x' }, ctx);
  assert.match(nobody.payload.error, /at least one recipient/);
  assert.equal(fetch.calls.length, 2);
});

test('send_email downloads attachments from public URLs and sends them in base64 with a type from the name', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 example');
  const { module, fetch, ctx } = setup((request) => (request.origin === 'https://files.example.com' ? bytesResponse(200, pdf, { 'content-type': 'application/pdf' }) : accepted()));
  const { payload } = await callTool(module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }],
    subject: 'Invoice',
    text: 'Attached',
    attachments: [{ url: 'https://files.example.com/invoice.pdf', filename: 'invoice.pdf' }],
  }, ctx);
  assert.equal(payload.accepted, true);
  assert.equal(fetch.calls[0].url, 'https://files.example.com/invoice.pdf');
  assert.equal(fetch.calls[0].headers.authorization, undefined, 'no key goes with a download');
  assert.deepEqual(fetch.calls[1].json.attachments, [{ content: btoa('%PDF-1.7 example'), filename: 'invoice.pdf', type: 'application/pdf' }]);

  const inline = await callTool(module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }],
    subject: 'Logo',
    html: '<img src="cid:logo">',
    attachments: [{ url: 'https://files.example.com/logo.png', filename: 'logo.png', disposition: 'inline' }],
  }, ctx);
  assert.match(inline.payload.error, /needs a content_id/);

  const blocked = setup((request) => {
    if (request.origin === 'https://files.example.com') throw refusal('a private address');
    return accepted();
  });
  const refused = await callTool(blocked.module, 'send_email', {
    from: { email: 'shop@example.com' },
    to: [{ email: 'ann@example.com' }],
    subject: 'Invoice',
    text: 'Attached',
    attachments: [{ url: 'https://files.example.com/invoice.pdf', filename: 'invoice.pdf' }],
  }, blocked.ctx);
  assert.match(refused.payload.error, /The attachment invoice\.pdf URL was refused .*Nothing was changed\./);
  assert.equal(blocked.fetch.calls.length, 1, 'the email is not sent when an attachment fails');
});

test('a refused sender keeps SendGrid\'s words', async () => {
  const { module, ctx } = setup(() => jsonResponse(400, json('error-400.json')));
  const { payload } = await callTool(module, 'send_email', { from: { email: 'x@example.com' }, to: [{ email: 'ann@example.com' }], subject: 'Hi', text: 'Hi' }, ctx);
  assert.match(payload.error, /^SendGrid did not accept the email \(HTTP 400\)\. SendGrid said: "The from address does not match a verified Sender Identity\. Mail cannot be sent until this error is resolved\."\. Nothing was changed\.$/);

  const denied = setup(() => jsonResponse(401, json('error-401.json')));
  const auth = await callTool(denied.module, 'list_lists', {}, denied.ctx);
  assert.match(auth.payload.error, /SendGrid rejected the credentials \(HTTP 401\): The provided authorization grant is invalid, expired, or revoked\. Check that the SendGrid API key is correct/);
});

test('contacts: upsert gives a job id, the job reads back, search and lookup by email trim the contacts', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'PUT') return jsonResponse(202, { job_id: '0b2d5f19-0c34-4e62-8dbc-1f9a2e7c4b11' });
    if (request.path.endsWith('/search')) return jsonResponse(200, json('search.json'));
    if (request.path.endsWith('/search/emails')) return jsonResponse(200, json('search-emails.json'));
    return jsonResponse(200, json('import.json'));
  });
  const upsert = await callTool(module, 'upsert_contacts', { list_ids: [LIST], contacts: [{ email: 'ann@example.com', first_name: 'Ann', custom_fields: { e1_T: 'VIP' } }] }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/marketing/contacts');
  assert.deepEqual(fetch.calls[0].json, { list_ids: [LIST], contacts: [{ email: 'ann@example.com', first_name: 'Ann', custom_fields: { e1_T: 'VIP' } }] });
  assert.deepEqual(upsert.payload, { accepted: true, job_id: '0b2d5f19-0c34-4e62-8dbc-1f9a2e7c4b11', contacts: 1 });

  const job = await callTool(module, 'get_import_status', { job_id: '0b2d5f19-0c34-4e62-8dbc-1f9a2e7c4b11' }, ctx);
  assert.equal(job.payload.status, 'completed');
  assert.equal(job.payload.results.created_count, 1);

  const search = await callTool(module, 'search_contacts', { query: "email LIKE 'ann%'" }, ctx);
  assert.equal(fetch.calls[2].method, 'POST');
  assert.deepEqual(fetch.calls[2].json, { query: "email LIKE 'ann%'" });
  assert.equal(search.payload.contact_count, 1);
  assert.deepEqual(search.payload.contacts[0], {
    id: '3a5f1a26-0a1c-4f8e-9d55-7b4e2f1c9a01',
    email: 'ann@example.com',
    first_name: 'Ann',
    last_name: 'Example',
    city: 'Austin',
    country: 'US',
    list_ids: [LIST],
    custom_fields: { plan: 'pro' },
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-11-20T10:00:00Z',
  });

  const byEmail = await callTool(module, 'get_contacts_by_email', { emails: ['ann@example.com', 'bob@example.com'] }, ctx);
  assert.equal(byEmail.payload.contacts[0].email, 'ann@example.com');
  assert.deepEqual(byEmail.payload.not_found, ['bob@example.com']);

  const noId = await callTool(module, 'upsert_contacts', { contacts: [{ first_name: 'Nobody' }] }, ctx);
  assert.match(noId.payload.error, /contacts\[0\] needs an email/);
  assert.equal(fetch.calls.length, 4);
});

test('delete_contacts sends the ids in one query parameter and returns the job', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(202, { job_id: 'del-1' }));
  const { payload } = await callTool(module, 'delete_contacts', { ids: ['a1b2c3d4e5', 'f6a7b8c9d0'] }, ctx);
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/marketing/contacts?ids=a1b2c3d4e5%2Cf6a7b8c9d0');
  assert.deepEqual(payload, { accepted: true, job_id: 'del-1', contacts: 2 });
});

test('list_lists pages with the page_token of SendGrid\'s next link', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('lists.json')));
  const first = await callTool(module, 'list_lists', { page_size: 2 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/marketing/lists?page_size=2');
  assert.deepEqual(first.payload.lists[0], { id: LIST, name: 'Newsletter', contact_count: 1542 });
  assert.equal(first.payload.total, 5);
  await callTool(module, 'list_lists', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.sendgrid.com/v3/marketing/lists?page_size=2&page_token=eyJpZCI6IjEyMyJ9');

  const other = await callTool(module, 'list_single_sends', { cursor: first.payload.nextCursor }, ctx);
  assert.match(other.payload.error, /cursor is not valid for this tool/);
});

test('lists: create, and delete with or without the contacts', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'POST' ? jsonResponse(201, { id: LIST, name: 'Newsletter', contact_count: 0 }) : jsonResponse(202, { job_id: 'j1' })));
  const created = await callTool(module, 'create_list', { name: 'Newsletter' }, ctx);
  assert.deepEqual(created.payload, { id: LIST, name: 'Newsletter', contact_count: 0 });
  await callTool(module, 'delete_list', { list_id: LIST }, ctx);
  assert.equal(fetch.calls[1].url, `https://api.sendgrid.com/v3/marketing/lists/${LIST}`);
  await callTool(module, 'delete_list', { list_id: LIST, delete_contacts: true }, ctx);
  assert.equal(fetch.calls[2].url, `https://api.sendgrid.com/v3/marketing/lists/${LIST}?delete_contacts=true`);
});

test('Single Sends: create maps the fields, get shows the HTML, schedule and unschedule hit the schedule', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/schedule')) return jsonResponse(201, request.method === 'PUT' ? { send_at: '2026-12-01T09:00:00Z', status: 'scheduled' } : { ...json('singlesend.json'), status: 'draft' });
    return jsonResponse(request.method === 'POST' ? 201 : 200, json('singlesend.json'));
  });
  const created = await callTool(module, 'create_single_send', {
    name: 'November newsletter',
    subject: 'What is new in November',
    html_content: '<p>Hello</p>',
    sender_id: 123456,
    suppression_group_id: 12,
    list_ids: [LIST],
    categories: ['newsletter'],
  }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/marketing/singlesends');
  assert.deepEqual(fetch.calls[0].json, {
    name: 'November newsletter',
    categories: ['newsletter'],
    send_to: { list_ids: [LIST] },
    email_config: { subject: 'What is new in November', html_content: '<p>Hello</p>', generate_plain_content: true, editor: 'code', sender_id: 123456, suppression_group_id: 12 },
  });
  assert.equal(created.payload.email_config.html_content, undefined, 'a write result leaves the HTML out');

  const one = await callTool(module, 'get_single_send', { single_send_id: SEND }, ctx);
  assert.match(one.payload.email_config.html_content, /unsubscribe/);
  assert.equal(one.payload.warnings, undefined);

  const scheduled = await callTool(module, 'schedule_single_send', { single_send_id: SEND, send_at: '2026-12-01T09:00:00Z' }, ctx);
  assert.equal(fetch.calls[2].method, 'PUT');
  assert.equal(fetch.calls[2].url, `https://api.sendgrid.com/v3/marketing/singlesends/${SEND}/schedule`);
  assert.deepEqual(scheduled.payload, { id: SEND, status: 'scheduled', send_at: '2026-12-01T09:00:00Z' });
  const now = await callTool(module, 'schedule_single_send', { single_send_id: SEND, send_at: 'now' }, ctx);
  assert.deepEqual(fetch.calls[3].json, { send_at: 'now' });
  assert.equal(now.isError, false);
  const bad = await callTool(module, 'schedule_single_send', { single_send_id: SEND, send_at: 'tomorrow' }, ctx);
  assert.match(bad.payload.error, /`send_at` does not have the expected format/);

  await callTool(module, 'unschedule_single_send', { single_send_id: SEND }, ctx);
  assert.equal(fetch.calls[4].method, 'DELETE');
  assert.equal(fetch.calls[4].url, `https://api.sendgrid.com/v3/marketing/singlesends/${SEND}/schedule`);

  const empty = await callTool(module, 'update_single_send', { single_send_id: SEND }, ctx);
  assert.match(empty.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 5);
});

test('list_single_sends and single send statistics', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.startsWith('/v3/marketing/stats/') ? { results: [{ id: SEND, ab_variation: 'all', ab_phase: 'all', aggregation: 'total', stats: { delivered: 95, opens: 40, unique_opens: 35 } }] } : json('singlesends.json')));
  const list = await callTool(module, 'list_single_sends', {}, ctx);
  assert.equal(list.payload.single_sends.length, 2);
  assert.equal(list.payload.single_sends[1].send_at, '2026-10-20T14:00:00Z');
  assert.equal(list.payload.nextCursor, undefined);
  const stats = await callTool(module, 'get_single_send_stats', { single_send_id: SEND }, ctx);
  assert.equal(fetch.calls[1].url, `https://api.sendgrid.com/v3/marketing/stats/singlesends/${SEND}?aggregated_by=total`);
  assert.deepEqual(stats.payload.results, [{ ab_variation: 'all', ab_phase: 'all', stats: { delivered: 95, opens: 40, unique_opens: 35 } }]);
});

test('templates: list summarizes versions, get shows the active version\'s HTML, versions are added as code', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'POST') return jsonResponse(201, { id: 'v-new', template_id: 'd-2c214ac919e84170b21855cc129b4a5f', name: 'v3', active: 1, subject: 'Order {{order_id}}' });
    return jsonResponse(200, request.path === '/v3/templates' ? json('templates.json') : json('templates.json').result[0]);
  });
  const list = await callTool(module, 'list_templates', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/templates?generations=dynamic&page_size=50');
  assert.equal(list.payload.templates[0].versions[0].html_content, undefined);
  const one = await callTool(module, 'get_template', { template_id: 'd-2c214ac919e84170b21855cc129b4a5f' }, ctx);
  assert.equal(one.payload.versions[0].html_content, '<p>Order {{order_id}}</p>');
  assert.equal(one.payload.versions[1].html_content, undefined, 'only the active version\'s HTML');

  const version = await callTool(module, 'create_template_version', { template_id: 'd-2c214ac919e84170b21855cc129b4a5f', name: 'v3', subject: 'Order {{order_id}}', html_content: '<p>{{order_id}}</p>', test_data: { order_id: '1' } }, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.sendgrid.com/v3/templates/d-2c214ac919e84170b21855cc129b4a5f/versions');
  assert.deepEqual(fetch.calls[2].json, { name: 'v3', subject: 'Order {{order_id}}', html_content: '<p>{{order_id}}</p>', generate_plain_content: true, active: 1, editor: 'code', test_data: '{"order_id":"1"}' });
  assert.equal(version.payload.id, 'v-new');
});

test('senders, unsubscribe groups and suppressions', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path === '/v3/verified_senders') return jsonResponse(200, json('senders.json'));
    if (request.path === '/v3/asm/groups') return jsonResponse(200, json('groups.json'));
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse(200, json('bounces.json'));
  });
  const senders = await callTool(module, 'list_senders', {}, ctx);
  assert.deepEqual(senders.payload.senders[0], { id: 123456, nickname: 'Marketing', from_email: 'news@example.com', from_name: 'Example News', reply_to: 'news@example.com', verified: true, locked: false });
  const groups = await callTool(module, 'list_unsubscribe_groups', {}, ctx);
  assert.deepEqual(groups.payload.groups, [{ id: 12, name: 'Newsletter', description: 'Monthly news', is_default: true, unsubscribes: 85 }]);
  const bounces = await callTool(module, 'list_suppressions', { type: 'bounces', limit: 1 }, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.sendgrid.com/v3/suppression/bounces?limit=1&offset=0');
  assert.deepEqual(bounces.payload.suppressions[0], { email: 'bad@example.com', created: new Date(1795300000 * 1000).toISOString(), reason: '550 5.1.1 The email account does not exist', status: '5.1.1' });
  assert.ok(bounces.payload.nextCursor, 'a full page may have more');

  await callTool(module, 'delete_suppression', { type: 'bounces', email: 'bad@example.com' }, ctx);
  assert.equal(fetch.calls[3].url, 'https://api.sendgrid.com/v3/suppression/bounces/bad%40example.com');
  await callTool(module, 'delete_suppression', { type: 'unsubscribes', email: 'bad@example.com' }, ctx);
  assert.equal(fetch.calls[4].url, 'https://api.sendgrid.com/v3/asm/suppressions/global/bad%40example.com');
});

test('get_stats sums each metric over the range and lists the periods without zeros', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('stats.json')));
  const { payload } = await callTool(module, 'get_stats', { start_date: '2026-11-20', end_date: '2026-11-21' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/stats?start_date=2026-11-20&end_date=2026-11-21&aggregated_by=day');
  assert.equal(payload.totals.all.delivered, 144);
  assert.equal(payload.totals.all.unique_opens, 53);
  assert.deepEqual(payload.periods[1], { date: '2026-11-21', stats: [{ metrics: { blocks: 1, clicks: 4, delivered: 49, opens: 20, requests: 50, unique_clicks: 3, unique_opens: 18 } }] });

  await callTool(module, 'get_stats', { start_date: '2026-11-20', categories: ['orders', 'news'] }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.sendgrid.com/v3/categories/stats?start_date=2026-11-20&aggregated_by=day&categories=orders&categories=news');
});

test('search_email_activity reads recent messages, and says what the add-on is when it is missing', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('messages.json')));
  const { payload } = await callTool(module, 'search_email_activity', { query: 'to_email="ann@example.com"' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.sendgrid.com/v3/messages?query=to_email%3D%22ann%40example.com%22&limit=20');
  assert.equal(payload.messages[0].status, 'delivered');

  const missing = setup(() => jsonResponse(403, json('error-403.json')));
  const refused = await callTool(missing.module, 'search_email_activity', { query: 'to_email="ann@example.com"' }, missing.ctx);
  assert.match(refused.payload.error, /needs the Email Activity history add-on/);
});

test('a rate limit carries retryAfter from SendGrid\'s reset header', async () => {
  const reset = Math.floor(Date.now() / 1000) + 30;
  const { module, ctx } = setup(() => textResponse(429, 'too many', { 'x-ratelimit-reset': String(reset) }));
  const { payload } = await callTool(module, 'list_lists', {}, ctx);
  assert.equal(payload.status, 429);
  assert.ok(payload.retryAfter >= 29 && payload.retryAfter <= 30, String(payload.retryAfter));
});

test('writes without a clear answer are unknown, sent once, with the read tool to check', async () => {
  const writes = [
    ['send_email', { from: { email: 'a@example.com' }, to: [{ email: 'b@example.com' }], subject: 'S', text: 'T' }, 'search_email_activity'],
    ['upsert_contacts', { contacts: [{ email: 'b@example.com' }] }, 'search_contacts'],
    ['delete_contacts', { ids: ['a1b2c3d4e5'] }, 'search_contacts'],
    ['create_list', { name: 'L' }, 'list_lists'],
    ['delete_list', { list_id: LIST }, 'list_lists'],
    ['create_single_send', { name: 'S' }, 'list_single_sends'],
    ['update_single_send', { single_send_id: SEND, name: 'S' }, 'get_single_send'],
    ['schedule_single_send', { single_send_id: SEND, send_at: 'now' }, 'get_single_send'],
    ['unschedule_single_send', { single_send_id: SEND }, 'get_single_send'],
    ['delete_single_send', { single_send_id: SEND }, 'list_single_sends'],
    ['create_template', { name: 'T' }, 'list_templates'],
    ['create_template_version', { template_id: 'd-2c214ac919e84170b21855cc129b4a5f', name: 'v', subject: 's', html_content: '<p>x</p>' }, 'get_template'],
    ['create_sender', { nickname: 'N', from_email: 'a@example.com', reply_to: 'a@example.com', address: '1 St', city: 'C', country: 'US' }, 'list_senders'],
    ['delete_suppression', { type: 'bounces', email: 'a@example.com' }, 'list_suppressions'],
  ];
  for (const respond of [() => jsonResponse(500, { errors: [{ message: 'internal error' }] }), () => { throw new TypeError('fetch failed'); }]) {
    for (const [tool, args, check] of writes) {
      const { module, fetch, ctx } = setup(respond);
      const { payload } = await callTool(module, tool, args, ctx);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check, tool);
      assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
    }
  }
});

test('api_get and api_request reach the rest of /v3/, but not API keys, teammates or subusers', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { contact_count: 1542, billable_count: 1500 }));
  const count = await callTool(module, 'api_get', { path: '/v3/marketing/contacts/count' }, ctx);
  assert.deepEqual(count.payload, { status: 200, data: { contact_count: 1542, billable_count: 1500 } });
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);

  const keys = await callTool(module, 'api_get', { path: '/v3/api_keys' }, ctx);
  assert.equal(keys.payload.error, 'SendGrid API keys are not available here. Nothing was sent.');
  const teammate = await callTool(module, 'api_request', { method: 'POST', path: '/v3/teammates', json: { email: 'x@example.com' } }, ctx);
  assert.match(teammate.payload.error, /^Changing SendGrid teammates, subusers, access settings, single sign-on or the account's email, username or password is not available here\. Nothing was sent\.$/);
  const segment = await callTool(module, 'api_request', { method: 'POST', path: '/v3/marketing/segments/2.0', json: { name: 'VIP', query_dsl: "email LIKE '%@example.com'" } }, ctx);
  assert.equal(segment.isError, false);
  assert.equal(fetch.calls.length, 2);

  // The guard looks at the path as a server that decodes escapes would, whatever the case.
  for (const [method, path] of [['GET', '/v3/api%5Fkeys'], ['POST', '/v3/API_KEYS'], ['POST', '/v3/marketing%2F..%2Fapi_keys'], ['DELETE', '/v3/api_keys;x/k1']]) {
    const refused = await callTool(module, method === 'GET' ? 'api_get' : 'api_request', { ...(method === 'GET' ? {} : { method }), path }, ctx);
    assert.equal(refused.payload.error, 'SendGrid API keys are not available here. Nothing was sent.', path);
  }
  for (const [method, path] of [['POST', '/v3/teammate%73'], ['POST', '/v3/Teammates'], ['DELETE', '/v3/subusers/x'], ['PATCH', '/v3/scopes/requests/r1/approve'], ['PUT', '/v3/user/email'], ['PUT', '/v3/user/%65mail'], ['PUT', '/v3/User/Password'], ['PUT', '/v3/user/username']]) {
    const refused = await callTool(module, 'api_request', { method, path, json: {} }, ctx);
    assert.match(refused.payload.error, /^Changing SendGrid teammates/, path);
  }
  const escaped = await callTool(module, 'api_request', { method: 'POST', path: '/v3/..%2Fv2/x' }, ctx);
  assert.equal(escaped.payload.error, 'The path must stay under /v3/. Nothing was sent.');
  assert.equal(fetch.calls.length, 2);
  // Reading teammates and the account email works, and so do the webhook settings.
  for (const path of ['/v3/teammates', '/v3/user/email']) assert.equal((await callTool(module, 'api_get', { path }, ctx)).isError, false, path);
  const webhook = await callTool(module, 'api_request', { method: 'PATCH', path: '/v3/user/webhooks/event/settings', json: { enabled: true } }, ctx);
  assert.equal(webhook.isError, false);
  assert.equal(fetch.calls.length, 5);
});

test('logs never carry the key or a recipient', async () => {
  const { module, ctx, logs } = setup(accepted);
  await callTool(module, 'send_email', { from: { email: 'shop@example.com' }, to: [{ email: 'ann@example.com' }], subject: 'Hi', text: 'Hi' }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['sendgrid send_email POST 202 Nms']);
  assert.equal(logs.join('\n').includes(KEY), false);
  assert.equal(logs.join('\n').includes('ann@example.com'), false);
});
