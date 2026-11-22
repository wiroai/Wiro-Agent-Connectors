import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'xkeysib-0123456789abcdef0123456789abcdef-AbCdEfGhIjKlMnOp';
const credentials = { apikey: KEY };
const json = (name) => fixture(import.meta.url, name);

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

const noContent = () => new Response(null, { status: 204 });

test('the module declares its origin, its one credential and no account picker', () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(module.origins), ['https://api.brevo.com']);
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('get_account sends the api-key header and keeps the plan, not the SMTP relay or the address', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('account.json')));
  const { payload, isError } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(isError, false);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/account');
  assert.equal(fetch.calls[0].headers['api-key'], KEY);
  assert.equal(fetch.calls[0].headers.authorization, undefined);
  assert.deepEqual(payload, {
    email: 'marketing@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    companyName: 'Example Co',
    plan: json('account.json').plan,
    marketingAutomation: false,
  });
});

test('a missing key sends nothing, and a refused key names it', async () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const fetch = fakeFetch(() => jsonResponse(200, {}));
  const missing = await callTool(module, 'get_account', {}, makeContext({ credentials: {}, fetch }).ctx);
  assert.equal(missing.payload.error, 'Brevo is not connected: the Brevo API key is missing.');
  assert.equal(fetch.calls.length, 0);

  const denied = setup(() => jsonResponse(401, json('error-401.json')));
  const auth = await callTool(denied.module, 'get_account', {}, denied.ctx);
  assert.equal(auth.payload.status, 401);
  assert.equal(auth.payload.vendorCode, 'unauthorized');
  assert.match(auth.payload.error, /Brevo rejected the credentials \(HTTP 401\): Key not found\. Check that the Brevo API key is correct and still active\./);
});

test('list_contacts pages with limit and offset, returns the total, and trims each contact', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('contacts.json')));
  const first = await callTool(module, 'list_contacts', { limit: 2, list_ids: [5, 12], modified_since: '2026-11-01T00:00:00.000Z' }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/contacts?listIds=5&listIds=12&modifiedSince=2026-11-01T00%3A00%3A00.000Z&sort=desc&limit=2&offset=0');
  assert.equal(first.payload.total, 3);
  assert.deepEqual(first.payload.contacts[0], {
    id: 42,
    email: 'ann@example.com',
    attributes: { FIRSTNAME: 'Ann', LASTNAME: 'Example' },
    listIds: [5, 12],
    emailBlacklisted: false,
    smsBlacklisted: false,
    createdAt: '2026-11-20T09:12:01.000+01:00',
    modifiedAt: '2026-11-21T10:00:00.000+01:00',
  });
  assert.equal('attributes' in first.payload.contacts[1], false, 'empty attributes are left out');
  assert.ok(first.payload.nextCursor, '2 of 3 shown: there is more');

  await callTool(module, 'list_contacts', { list_ids: [5, 12], cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.offset, '2');
  assert.equal(fetch.calls[1].query.limit, '2', 'the page size stays with the cursor');

  const both = await callTool(module, 'list_contacts', { list_ids: [5], segment_id: 3 }, ctx);
  assert.match(both.payload.error, /list_ids or segment_id, not both/);
  assert.equal(fetch.calls.length, 2);
});

test('a page over 32 KB is cut and the cursor resumes inside the same Brevo page', async () => {
  const contacts = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    email: `person${index}@example.com`,
    attributes: { NOTES: 'n'.repeat(400), FIRSTNAME: `Person ${index}` },
    listIds: [5],
  }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { contacts, count: 200 }));
  const first = await callTool(module, 'list_contacts', { limit: 200 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  assert.equal(first.payload.truncated, true);
  const shown = first.payload.contacts.length;
  const second = await callTool(module, 'list_contacts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.offset, '0');
  assert.equal(second.payload.contacts[0].id, shown + 1);
});

test('get_contact encodes the identifier and counts the statistics unless asked for them', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('contact.json')));
  const { payload } = await callTool(module, 'get_contact', { identifier: 'ann+news@example.com' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/contacts/ann%2Bnews%40example.com');
  assert.deepEqual(payload.statisticCounts, { messagesSent: 2, opened: 1, clicked: 0, unsubscriptions: 2 });
  assert.equal(payload.statistics, undefined);

  const full = await callTool(module, 'get_contact', { identifier: '42', identifier_type: 'contact_id', include_statistics: true }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/contacts/42?identifierType=contact_id');
  assert.equal(full.payload.statistics.messagesSent.length, 2);

  const gone = setup(() => jsonResponse(404, json('error-404.json')));
  const missing = await callTool(gone.module, 'get_contact', { identifier: 'nobody@example.com' }, gone.ctx);
  assert.match(missing.payload.error, /^Brevo has no contact with that identifier \(HTTP 404\)\. Brevo said: "Contact does not exist"\.$/);
});

test('upsert_contact maps the arguments to Brevo\'s fields and tells a create from an update', async () => {
  const created = setup(() => jsonResponse(201, { id: 77 }));
  const { payload } = await callTool(created.module, 'upsert_contact', {
    email: 'new@example.com',
    attributes: { FIRSTNAME: 'New' },
    list_ids: [5],
    email_blacklisted: false,
  }, created.ctx);
  assert.equal(created.fetch.calls[0].method, 'POST');
  assert.equal(created.fetch.calls[0].url, 'https://api.brevo.com/v3/contacts');
  assert.deepEqual(created.fetch.calls[0].json, {
    email: 'new@example.com',
    attributes: { FIRSTNAME: 'New' },
    listIds: [5],
    emailBlacklisted: false,
    updateEnabled: true,
  });
  assert.deepEqual(payload, { saved: true, id: 77, email: 'new@example.com' });
  const createOnly = await callTool(created.module, 'upsert_contact', { email: 'new@example.com', update_existing: false }, created.ctx);
  assert.equal(created.fetch.calls[1].json.updateEnabled, false);
  assert.deepEqual(createOnly.payload, { saved: true, id: 77, email: 'new@example.com', created: true });

  const updated = setup(noContent);
  const again = await callTool(updated.module, 'upsert_contact', { email: 'new@example.com' }, updated.ctx);
  assert.deepEqual(again.payload, { saved: true, email: 'new@example.com', updated: true });

  const nothing = await callTool(updated.module, 'upsert_contact', {}, updated.ctx);
  assert.match(nothing.payload.error, /Give an email, an ext_id or attributes/);
  assert.equal(updated.fetch.calls.length, 1);
});

test('update_contact and delete_contact act on one contact; an empty update sends nothing', async () => {
  const { module, fetch, ctx } = setup(noContent);
  const changed = await callTool(module, 'update_contact', { identifier: 'ann@example.com', attributes: { FIRSTNAME: 'Annie' }, unlink_list_ids: [12] }, ctx);
  assert.deepEqual(changed.payload, { updated: true, identifier: 'ann@example.com' });
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/contacts/ann%40example.com');
  assert.deepEqual(fetch.calls[0].json, { attributes: { FIRSTNAME: 'Annie' }, unlinkListIds: [12] });

  const empty = await callTool(module, 'update_contact', { identifier: 'ann@example.com' }, ctx);
  assert.match(empty.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 1);

  const removed = await callTool(module, 'delete_contact', { identifier: 'ann@example.com' }, ctx);
  assert.deepEqual(removed.payload, { deleted: true, identifier: 'ann@example.com' });
  assert.equal(fetch.calls[1].method, 'DELETE');
});

test('list membership takes emails or ids, at most 150, and returns what succeeded and failed', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, json('list-add.json')));
  const added = await callTool(module, 'add_contacts_to_list', { list_id: 5, emails: ['ann@example.com', 'nobody@example.com'] }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/contacts/lists/5/contacts/add');
  assert.deepEqual(fetch.calls[0].json, { emails: ['ann@example.com', 'nobody@example.com'] });
  assert.deepEqual(added.payload, { listId: 5, success: ['ann@example.com'], failure: ['nobody@example.com'], total: 1 });

  await callTool(module, 'remove_contacts_from_list', { list_id: 5, ids: [42] }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/contacts/lists/5/contacts/remove');
  assert.deepEqual(fetch.calls[1].json, { ids: [42] });

  const both = await callTool(module, 'add_contacts_to_list', { list_id: 5, emails: ['a@example.com'], ids: [1] }, ctx);
  assert.match(both.payload.error, /Give emails or ids \(one of the two\)/);
  const many = await callTool(module, 'add_contacts_to_list', { list_id: 5, ids: Array.from({ length: 151 }, (_, i) => i + 1) }, ctx);
  assert.match(many.payload.error, /`ids` must have at most 150 items/);
  assert.equal(fetch.calls.length, 2);
});

test('folders and lists: list them with their counts and create them', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'POST') return jsonResponse(201, { id: 9 });
    return jsonResponse(200, request.path.endsWith('/folders') ? json('folders.json') : json('lists.json'));
  });
  const folders = await callTool(module, 'list_folders', {}, ctx);
  assert.deepEqual(folders.payload.folders, [{ id: 3, name: 'Newsletters', totalSubscribers: 500, uniqueSubscribers: 498, totalBlacklisted: 2 }]);
  const lists = await callTool(module, 'list_lists', { folder_id: 3 }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/contacts/folders/3/lists?limit=50&offset=0');
  assert.deepEqual(lists.payload.lists[0], { id: 5, name: 'Weekly newsletter', folderId: 3, totalSubscribers: 120, totalBlacklisted: 1 });
  assert.equal(lists.payload.nextCursor, undefined);

  const folder = await callTool(module, 'create_folder', { name: 'Promotions' }, ctx);
  assert.deepEqual(folder.payload, { id: 9, name: 'Promotions' });
  const list = await callTool(module, 'create_list', { name: 'Black Friday', folder_id: 3 }, ctx);
  assert.deepEqual(fetch.calls[3].json, { name: 'Black Friday', folderId: 3 });
  assert.deepEqual(list.payload, { id: 9, name: 'Black Friday', folderId: 3 });
});

test('list_email_campaigns leaves the HTML out and keeps the global statistics', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('campaigns.json')));
  const { payload } = await callTool(module, 'list_email_campaigns', { status: 'sent', statistics: true }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/emailCampaigns?status=sent&statistics=globalStats&excludeHtmlContent=true&limit=25&offset=0');
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.campaigns[0].globalStats, json('campaigns.json').campaigns[0].statistics.globalStats);
  assert.equal(payload.campaigns[0].htmlContent, undefined);
  assert.equal(payload.campaigns[1].globalStats, undefined, 'an empty stats object is left out');

  const half = await callTool(module, 'list_email_campaigns', { start_date: '2026-11-01T00:00:00Z' }, ctx);
  assert.match(half.payload.error, /start_date and end_date together/);
});

test('get_email_campaign returns per-list stats and the most clicked links, and the HTML only when asked', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('campaign.json')));
  const { payload } = await callTool(module, 'get_email_campaign', { campaign_id: 101 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/emailCampaigns/101?excludeHtmlContent=true');
  assert.deepEqual(payload.linksStats, [
    { url: 'https://example.com/blog/a', clicks: 30 },
    { url: 'https://example.com/pricing', clicks: 12 },
    { url: 'https://example.com/blog/b', clicks: 3 },
  ]);
  assert.equal(payload.campaignStats[0].listId, 5);
  assert.equal(payload.globalStats.delivered, 1180);
  assert.equal(payload.htmlContent, undefined);

  const withHtml = await callTool(module, 'get_email_campaign', { campaign_id: 101, include_html: true }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/emailCampaigns/101');
  assert.match(withHtml.payload.htmlContent, /\{\{ unsubscribe \}\}/);
});

test('create_email_campaign needs one body and recipients, and maps the fields', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, { id: 103 }));
  const base = { name: 'Dec', subject: 'December news', sender: { email: 'news@example.com', name: 'Example News' } };
  const noBody = await callTool(module, 'create_email_campaign', { ...base, list_ids: [5] }, ctx);
  assert.match(noBody.payload.error, /exactly one of html_content, html_url or template_id/);
  const noRecipients = await callTool(module, 'create_email_campaign', { ...base, template_id: 10 }, ctx);
  assert.match(noRecipients.payload.error, /Give list_ids or segment_ids/);
  const noSender = await callTool(module, 'create_email_campaign', { ...base, sender: { name: 'x' }, template_id: 10, list_ids: [5] }, ctx);
  assert.match(noSender.payload.error, /sender needs an email or an id/);
  assert.equal(fetch.calls.length, 0);

  const { payload } = await callTool(module, 'create_email_campaign', {
    ...base,
    list_ids: [5],
    exclusion_list_ids: [12],
    html_content: '<p>Hi {{ contact.FIRSTNAME }}</p><a href="{{ unsubscribe }}">Unsubscribe</a>',
    preview_text: 'Hello',
    tag: 'newsletter',
  }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/emailCampaigns');
  assert.deepEqual(fetch.calls[0].json, {
    name: 'Dec',
    subject: 'December news',
    previewText: 'Hello',
    sender: { email: 'news@example.com', name: 'Example News' },
    recipients: { listIds: [5], exclusionListIds: [12] },
    htmlContent: '<p>Hi {{ contact.FIRSTNAME }}</p><a href="{{ unsubscribe }}">Unsubscribe</a>',
    tag: 'newsletter',
  });
  assert.deepEqual(payload, { id: 103, name: 'Dec', status: 'draft' });
});

test('campaign actions: update, test, send now and delete hit their own endpoints', async () => {
  const { module, fetch, ctx } = setup(noContent);
  await callTool(module, 'update_email_campaign', { campaign_id: 102, subject: 'New subject', scheduled_at: '2026-12-01T09:00:00.000Z' }, ctx);
  await callTool(module, 'send_test_email', { campaign_id: 102, emails: ['qa@example.com'] }, ctx);
  const sent = await callTool(module, 'send_campaign_now', { campaign_id: 102 }, ctx);
  await callTool(module, 'delete_email_campaign', { campaign_id: 102 }, ctx);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    'PUT /v3/emailCampaigns/102',
    'POST /v3/emailCampaigns/102/sendTest',
    'POST /v3/emailCampaigns/102/sendNow',
    'DELETE /v3/emailCampaigns/102',
  ]);
  assert.deepEqual(fetch.calls[0].json, { subject: 'New subject', scheduledAt: '2026-12-01T09:00:00.000Z' });
  assert.deepEqual(fetch.calls[1].json, { emailTo: ['qa@example.com'] });
  assert.equal(fetch.calls[2].body, undefined, 'send now has no body');
  assert.equal(sent.payload.sent, true);

  const credits = setup(() => jsonResponse(402, { code: 'not_enough_credits', message: 'Not enough credits' }));
  const refused = await callTool(credits.module, 'send_campaign_now', { campaign_id: 102 }, credits.ctx);
  assert.match(refused.payload.error, /^Brevo refused to send: the account does not have enough email credits \(HTTP 402\)\. Brevo said: "Not enough credits"\. Nothing was changed\.$/);
});

test('templates: list without HTML, get with HTML, create and update', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.method === 'POST') return jsonResponse(201, { id: 12 });
    if (request.method === 'PUT') return noContent();
    return jsonResponse(200, request.path.endsWith('/templates') ? json('templates.json') : json('templates.json').templates[0]);
  });
  const list = await callTool(module, 'list_templates', { active: true }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/smtp/templates?templateStatus=true&limit=50&offset=0');
  assert.equal(list.payload.templates[0].htmlContent, undefined);
  assert.equal(list.payload.templates[1].tag, undefined, 'empty values are left out');
  const one = await callTool(module, 'get_template', { template_id: 10 }, ctx);
  assert.equal(one.payload.htmlContent, '<p>Thanks</p>');

  const created = await callTool(module, 'create_template', { name: 'Receipt', subject: 'Receipt {{ params.ID }}', sender: { id: 3 }, html_content: '<p>Receipt body</p>' }, ctx);
  assert.deepEqual(fetch.calls[2].json, { templateName: 'Receipt', subject: 'Receipt {{ params.ID }}', sender: { id: 3 }, htmlContent: '<p>Receipt body</p>', isActive: true });
  assert.deepEqual(created.payload, { id: 12, name: 'Receipt' });
  await callTool(module, 'update_template', { template_id: 10, is_active: false }, ctx);
  assert.equal(fetch.calls[3].url, 'https://api.brevo.com/v3/smtp/templates/10');
  assert.deepEqual(fetch.calls[3].json, { isActive: false });
});

test('send_transactional_email checks its body, maps it, and reports the message id or a schedule', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(201, { messageId: '<202611211001.12345@smtp-relay.example.com>' }));
  const noSubject = await callTool(module, 'send_transactional_email', { sender: { email: 'shop@example.com' }, to: [{ email: 'ann@example.com' }], html_content: '<p>x</p>' }, ctx);
  assert.match(noSubject.payload.error, /subject is required without template_id/);
  const badAttachment = await callTool(module, 'send_transactional_email', { to: [{ email: 'ann@example.com' }], template_id: 10, attachments: [{ content: 'aGVsbG8=' }] }, ctx);
  assert.match(badAttachment.payload.error, /needs a name/);
  assert.equal(fetch.calls.length, 0);

  const { payload } = await callTool(module, 'send_transactional_email', {
    sender: { email: 'shop@example.com', name: 'Shop' },
    to: [{ email: 'ann@example.com', name: 'Ann' }],
    bcc: [{ email: 'archive@example.com' }],
    reply_to: { email: 'help@example.com' },
    subject: 'Your order',
    html_content: '<p>Thanks for your order</p>',
    tags: ['orders'],
    attachments: [{ url: 'https://files.example.com/invoice.pdf', name: 'invoice.pdf' }],
  }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.deepEqual(fetch.calls[0].json, {
    sender: { email: 'shop@example.com', name: 'Shop' },
    to: [{ email: 'ann@example.com', name: 'Ann' }],
    bcc: [{ email: 'archive@example.com' }],
    replyTo: { email: 'help@example.com' },
    subject: 'Your order',
    htmlContent: '<p>Thanks for your order</p>',
    tags: ['orders'],
    attachment: [{ url: 'https://files.example.com/invoice.pdf', name: 'invoice.pdf' }],
  });
  assert.deepEqual(payload, { sent: true, messageId: '<202611211001.12345@smtp-relay.example.com>' });

  const later = setup(() => jsonResponse(202, {}));
  const scheduled = await callTool(later.module, 'send_transactional_email', { to: [{ email: 'ann@example.com' }], template_id: 10, params: { ORDER_ID: '1234' }, scheduled_at: '2026-12-01T09:00:00.000Z' }, later.ctx);
  assert.deepEqual(later.fetch.calls[0].json, { to: [{ email: 'ann@example.com' }], templateId: 10, params: { ORDER_ID: '1234' }, scheduledAt: '2026-12-01T09:00:00.000Z' });
  assert.deepEqual(scheduled.payload, { sent: false, scheduled: true });

  const unverified = setup(() => jsonResponse(400, json('error-400.json')));
  const refused = await callTool(unverified.module, 'send_transactional_email', { to: [{ email: 'ann@example.com' }], template_id: 10 }, unverified.ctx);
  assert.equal(refused.payload.vendorCode, 'invalid_parameter');
  assert.match(refused.payload.error, /^Brevo did not accept the email \(HTTP 400\)\. Brevo said: "sender email is not verified\. Please verify it before using it\."\. Nothing was changed\.$/);
});

test('transactional statistics and events', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/events') ? json('events.json') : json('aggregated.json')));
  const stats = await callTool(module, 'get_transactional_stats', { days: 7, tag: 'orders' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.brevo.com/v3/smtp/statistics/aggregatedReport?days=7&tag=orders');
  assert.equal(stats.payload.delivered, 118);

  const events = await callTool(module, 'list_transactional_events', { email: 'ann@example.com', tags: ['orders', 'vip'], limit: 2 }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/smtp/statistics/events?email=ann%40example.com&tags=%5B%22orders%22%2C%22vip%22%5D&limit=2&offset=0');
  assert.deepEqual(events.payload.events[0], {
    date: '2026-11-21T10:01:00.000+01:00',
    event: 'delivered',
    email: 'ann@example.com',
    subject: 'Your order 1234',
    messageId: '<202611211001.12345@smtp-relay.example.com>',
    templateId: 10,
    tag: 'orders',
    from: 'shop@example.com',
  });
  assert.ok(events.payload.nextCursor, 'a full page without a total may have more');

  const both = await callTool(module, 'get_transactional_stats', { days: 7, start_date: '2026-11-01', end_date: '2026-11-07' }, ctx);
  assert.match(both.payload.error, /days or a date range, not both/);
});

test('a 429 carries retryAfter', async () => {
  const { module, ctx } = setup(() => textResponse(429, 'Too many requests', { 'retry-after': '10' }));
  const { payload } = await callTool(module, 'list_contacts', {}, ctx);
  assert.equal(payload.status, 429);
  assert.equal(payload.retryAfter, 10);
  assert.match(payload.error, /Brevo rate limit reached \(HTTP 429\)\. Retry after 10 seconds\./);
});

test('writes without a clear answer are unknown, sent once, with the read tool to check', async () => {
  const writes = [
    ['upsert_contact', { email: 'ann@example.com' }, 'get_contact'],
    ['update_contact', { identifier: 'ann@example.com', attributes: { A: 1 } }, 'get_contact'],
    ['delete_contact', { identifier: 'ann@example.com' }, 'get_contact'],
    ['create_folder', { name: 'F' }, 'list_folders'],
    ['create_list', { name: 'L', folder_id: 3 }, 'list_lists'],
    ['add_contacts_to_list', { list_id: 5, ids: [42] }, 'list_list_contacts'],
    ['remove_contacts_from_list', { list_id: 5, ids: [42] }, 'list_list_contacts'],
    ['create_email_campaign', { name: 'N', subject: 'S', sender: { id: 1 }, template_id: 10, list_ids: [5] }, 'list_email_campaigns'],
    ['update_email_campaign', { campaign_id: 1, subject: 'S' }, 'get_email_campaign'],
    ['send_test_email', { campaign_id: 1 }, 'get_email_campaign'],
    ['send_campaign_now', { campaign_id: 1 }, 'get_email_campaign'],
    ['delete_email_campaign', { campaign_id: 1 }, 'list_email_campaigns'],
    ['create_template', { name: 'T', subject: 'S', sender: { id: 1 }, html_content: '<p>body body</p>' }, 'list_templates'],
    ['update_template', { template_id: 1, subject: 'S' }, 'get_template'],
    ['send_transactional_email', { to: [{ email: 'ann@example.com' }], template_id: 10 }, 'list_transactional_events'],
  ];
  for (const respond of [() => jsonResponse(502, { message: 'Bad gateway' }), () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); }]) {
    for (const [tool, args, check] of writes) {
      const { module, fetch, ctx } = setup(respond);
      const { payload, isError } = await callTool(module, tool, args, ctx);
      assert.equal(isError, true);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check, tool);
      assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
    }
  }
});

test('a refused URL says nothing was sent, and a read failure is a plain error', async () => {
  const blocked = setup(() => {
    throw refusal();
  });
  const write = await callTool(blocked.module, 'send_campaign_now', { campaign_id: 1 }, blocked.ctx);
  assert.equal(write.payload.outcome, undefined);
  assert.match(write.payload.error, /blocked before it was sent.*Nothing was changed\./);

  const down = setup(() => jsonResponse(503, { message: 'Service unavailable' }));
  const read = await callTool(down.module, 'list_email_campaigns', {}, down.ctx);
  assert.equal(read.payload.outcome, undefined);
  assert.match(read.payload.error, /Brevo had a server error \(HTTP 503\): Service unavailable\. Try again later\./);
});

test('api_get and api_request reach the rest of the API under /v3/, and keep the organization out of reach', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { attributes: [{ name: 'FIRSTNAME', category: 'normal', type: 'text' }] }));
  const read = await callTool(module, 'api_get', { path: '/v3/contacts/attributes' }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { attributes: [{ name: 'FIRSTNAME', category: 'normal', type: 'text' }] } });
  assert.equal(fetch.calls[0].headers['api-key'], KEY);

  const sms = await callTool(module, 'api_request', { method: 'POST', path: '/v3/smsCampaigns/7/sendNow' }, ctx);
  assert.equal(sms.isError, false);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.equal(fetch.calls[1].url, 'https://api.brevo.com/v3/smsCampaigns/7/sendNow');

  const invite = await callTool(module, 'api_request', { method: 'POST', path: '/v3/organization/user/invitation/send', json: { email: 'x@example.com' } }, ctx);
  assert.match(invite.payload.error, /organization or its sub-accounts is not available here\. Nothing was sent\./);
  // Brevo decodes escapes before it routes, so the guard looks at the path as Brevo would.
  for (const path of [
    '/v3/%63orporate/subAccount/key',
    '/v3/Corporate/subAccount/key',
    '/v3/corporate%2FsubAccount%2Fkey',
    '/v3/corporate;x/subAccount/key',
    '/v3/contacts%2F..%2Forganization/user/invitation/send',
    '/v3/%4Frganization/user/invitation/send',
  ]) {
    const refused = await callTool(module, 'api_request', { method: 'POST', path, json: { name: 'x' } }, ctx);
    assert.match(refused.payload.error, /organization or its sub-accounts is not available here\. Nothing was sent\./, path);
  }
  const escaped = await callTool(module, 'api_request', { method: 'POST', path: '/v3/..%2Fcorporate/subAccount/key' }, ctx);
  assert.equal(escaped.payload.error, 'The path must stay under /v3/. Nothing was sent.');
  const outside = await callTool(module, 'api_get', { path: '/v2/contacts' }, ctx);
  assert.equal(outside.payload.error, 'The path must start with /v3/. Nothing was sent.');
  assert.equal(fetch.calls.length, 2);
  // Reading the organization works.
  const users = await callTool(module, 'api_get', { path: '/v3/organization/invited/users' }, ctx);
  assert.equal(users.isError, false);
  assert.equal(fetch.calls.length, 3);
});

test('logs carry the tool, method and status, never the key or the email', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(201, { messageId: '<m@example.com>' }));
  await callTool(module, 'send_transactional_email', { to: [{ email: 'ann@example.com' }], template_id: 10 }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['brevo send_transactional_email POST 201 Nms']);
  assert.equal(logs.join('\n').includes(KEY), false);
  assert.equal(logs.join('\n').includes('ann@example.com'), false);
});
