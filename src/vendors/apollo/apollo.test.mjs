import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'apollo-key-0123456789abcdefghij';
const MASTER = 'apollo-master-key-0123456789abcd';
const json = (name) => fixture(import.meta.url, name);

function setup(handler, credentials = { apikey: KEY }) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

test('either key connects Apollo, and no account picker', () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(module.origins), ['https://api.apollo.io']);
  assert.deepEqual(plain(module.credentials), ['apikey', 'masterapikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey'], ['masterapikey']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('calls use the master key when there is one, the API key otherwise', async () => {
  const standard = setup(() => jsonResponse(200, json('profile.json')));
  const plain = await callTool(standard.module, 'get_profile', {}, standard.ctx);
  assert.equal(standard.fetch.calls[0].url, 'https://api.apollo.io/api/v1/users/api_profile?include_credit_usage=true');
  assert.equal(standard.fetch.calls[0].headers['x-api-key'], KEY);
  assert.deepEqual(plain.payload, {
    id: '66c8db577ed7f201b25c0eef',
    team_id: '6095a710bd01d100a506d4ac',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    title: 'Head of Sales',
    credit_usage: json('profile.json').credit_usage,
    key: 'API key',
  });

  const both = setup(() => jsonResponse(200, json('profile.json')), { apikey: KEY, masterapikey: MASTER });
  const master = await callTool(both.module, 'get_profile', { credits: false }, both.ctx);
  assert.equal(both.fetch.calls[0].headers['x-api-key'], MASTER);
  assert.equal(both.fetch.calls[0].url, 'https://api.apollo.io/api/v1/users/api_profile');
  assert.equal(master.payload.key, 'master API key');

  const masterOnly = setup(() => jsonResponse(200, json('profile.json')), { masterapikey: MASTER });
  await callTool(masterOnly.module, 'get_profile', {}, masterOnly.ctx);
  assert.equal(masterOnly.fetch.calls[0].headers['x-api-key'], MASTER);

  const none = setup(() => jsonResponse(200, {}), {});
  const missing = await callTool(none.module, 'get_profile', {}, none.ctx);
  assert.equal(missing.payload.error, 'Apollo is not connected: it needs the Apollo API key, or the Apollo master API key.');
  assert.equal(none.fetch.calls.length, 0);
});

test('search_people posts the filters as a free read and pages up to Apollo\'s 500 pages', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('people-search.json')));
  const first = await callTool(module, 'search_people', {
    person_titles: ['CEO', 'CTO'],
    person_locations: ['United States'],
    organization_domains: ['example.com'],
    organization_num_employees_ranges: ['1,50'],
    filters: { organization_industries: ['software'], person_titles: ['ignored'] },
    per_page: 1,
  }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/mixed_people/api_search');
  assert.deepEqual(fetch.calls[0].json, {
    organization_industries: ['software'],
    person_titles: ['CEO', 'CTO'],
    person_locations: ['United States'],
    q_organization_domains_list: ['example.com'],
    organization_num_employees_ranges: ['1,50'],
    page: 1,
    per_page: 1,
  });
  assert.equal(first.payload.total_entries, 232);
  assert.deepEqual(first.payload.people[0], {
    id: '67bdafd0c3a4c50001bbd7c2',
    first_name: 'Andrew',
    last_name_obfuscated: 'Hu***n',
    title: 'Chief Executive Officer',
    has_email: true,
    has_direct_phone: 'Yes',
    has_city: true,
    has_country: true,
    organization: { name: 'Example Media', has_industry: true, has_phone: false, has_employee_count: true },
  });
  await callTool(module, 'search_people', { person_titles: ['CEO', 'CTO'], cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 2);
  assert.equal(fetch.calls[1].json.per_page, 1);
});

test('enrich_people uses people/match for one person and bulk_match for several, and polls for phones', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/bulk_match') ? { ...json('bulk-match.json'), request_id: '4567' } : json('person-match.json')));
  const one = await callTool(module, 'enrich_people', { people: [{ email: 'tim@example.com' }], reveal_personal_emails: true }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/people/match');
  assert.deepEqual(fetch.calls[0].json, { email: 'tim@example.com', reveal_personal_emails: true });
  const person = one.payload.matches[0];
  assert.equal(person.email, 'tim@example.com');
  assert.equal(person.organization.name, 'Example');
  assert.equal(person.organization.phone, '+15550100');
  assert.deepEqual(person.employment_history, [
    { title: 'Founder & CEO', organization_name: 'Example', start_date: '2015-01-01', current: true },
    { title: 'Engineer', organization_name: 'Prior Co', start_date: '2010-01-01', end_date: '2014-12-01', current: false },
  ]);

  const many = await callTool(module, 'enrich_people', { people: [{ id: '64a7ff0cc4dfae00013df1a5' }, { first_name: 'No', last_name: 'Body', domain: 'example.com' }], reveal_phone_number: true }, ctx);
  assert.equal(fetch.calls[1].path, '/api/v1/people/bulk_match');
  assert.deepEqual(fetch.calls[1].json, { details: [{ id: '64a7ff0cc4dfae00013df1a5' }, { first_name: 'No', last_name: 'Body', domain: 'example.com' }], reveal_phone_number: true, poll_only: true });
  assert.equal(many.payload.matches.length, 2);
  assert.equal(many.payload.matches[1], null);
  assert.equal(many.payload.request_id, '4567');
  assert.equal(many.payload.credits_consumed, 1);

  const vague = await callTool(module, 'enrich_people', { people: [{ domain: 'example.com' }] }, ctx);
  assert.match(vague.payload.error, /people\[0\] needs an id, an email, a LinkedIn URL or a name/);
  assert.equal(fetch.calls.length, 2);
});

test('get_enrichment_result reads the polled phones, and explains a pending result', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('webhook-result.json')));
  const { payload } = await callTool(module, 'get_enrichment_result', { request_id: '1039995589705121900' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/webhook_result/1039995589705121900');
  assert.deepEqual(payload, {
    request_type: 'phone',
    status: 'success',
    credits_consumed: 1,
    people: [{ id: '587cf802f65125cad923a266', phone_numbers: [{ number: '+15555550164', type: 'other', status: 'valid_number' }, { number: '+14155550117', type: 'other', status: 'valid_number' }] }],
  });

  const pending = setup(() => jsonResponse(404, { error_code: 'result_pending', retry_after_seconds: 10 }));
  const later = await callTool(pending.module, 'get_enrichment_result', { request_id: '4567' }, pending.ctx);
  assert.equal(later.payload.status, 404);
  assert.equal(later.payload.error, 'Apollo has no result for that request_id yet (still pending) or does not know it (HTTP 404).');
  const expired = setup(() => jsonResponse(410, { error_code: 'request_id_expired' }));
  const gone = await callTool(expired.module, 'get_enrichment_result', { request_id: '4567' }, expired.ctx);
  assert.match(gone.payload.error, /no longer keeps that result/);
});

test('enrich_organizations uses a GET for one domain and bulk_enrich for several', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.method === 'GET' ? json('org-enrich.json') : { organizations: [json('org-enrich.json').organization], missing_records: 1 }));
  const one = await callTool(module, 'enrich_organizations', { domains: ['example.com'] }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/organizations/enrich?domain=example.com');
  assert.deepEqual(one.payload.organizations[0], {
    id: '5e66b6381e05b4008c8331b8',
    name: 'Example',
    website_url: 'http://www.example.com',
    primary_domain: 'example.com',
    linkedin_url: 'http://www.linkedin.com/company/example',
    industry: 'information technology & services',
    keywords: ['sales'],
    estimated_num_employees: 1600,
    annual_revenue: 100000000,
    annual_revenue_printed: '100M',
    total_funding_printed: '251.2M',
    latest_funding_stage: 'Series D',
    founded_year: 2015,
    city: 'San Francisco',
    state: 'California',
    country: 'United States',
    short_description: 'Example builds sales tools.',
    technology_names: ['Salesforce'],
  });
  const many = await callTool(module, 'enrich_organizations', { domains: ['example.com', 'example.org'] }, ctx);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.deepEqual(fetch.calls[1].json, { domains: ['example.com', 'example.org'] });
  assert.equal(many.payload.missing_records, 1);
  const www = await callTool(module, 'enrich_organizations', { domains: ['www.example.com'] }, ctx);
  assert.match(www.payload.error, /does not have the expected format/);
});

test('search_organizations returns companies and the saved accounts Apollo matched', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('companies-search.json')));
  const { payload } = await callTool(module, 'search_organizations', { q_organization_name: 'Example', per_page: 2 }, ctx);
  assert.deepEqual(fetch.calls[0].json, { q_organization_name: 'Example', page: 1, per_page: 2 });
  assert.equal(payload.total_entries, 3);
  assert.equal(payload.organizations.length, 2);
  assert.deepEqual(payload.saved_accounts, [{ id: 'acc456', name: 'Example', domain: 'example.com', organization_id: '5e66b6381e05b4008c8331b8' }]);
  assert.ok(payload.nextCursor, 'page 1 of 2');
});

test('create_contacts posts one contact, or several in bulk; upsert_contacts asks Apollo to dedupe', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/bulk_create') ? json('contacts-bulk.json') : json('contact.json')));
  const one = await callTool(module, 'create_contacts', { contacts: [{ first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', label_names: ['Prospect'] }] }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/contacts');
  assert.deepEqual(fetch.calls[0].json, { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', label_names: ['Prospect'] });
  assert.deepEqual(one.payload.contacts[0].phone_numbers, [{ number: '+14155551234', type: 'work_direct' }]);
  assert.equal('typed_custom_fields' in one.payload.contacts[0], false);

  const many = await callTool(module, 'upsert_contacts', { contacts: [{ email: 'john@example.com' }, { email: 'jane@example.com' }], append_label_names: ['Inbound'] }, ctx);
  assert.equal(fetch.calls[1].path, '/api/v1/contacts/bulk_create');
  assert.deepEqual(fetch.calls[1].json, { contacts: [{ email: 'john@example.com' }, { email: 'jane@example.com' }], run_dedupe: true, append_label_names: ['Inbound'] });
  assert.deepEqual(many.payload.contacts.map((contact) => contact.id), ['cnt790']);
  assert.deepEqual(many.payload.existing_contacts.map((contact) => contact.id), ['cnt789']);

  await callTool(module, 'upsert_contacts', { contacts: [{ email: 'jane@example.com' }] }, ctx);
  assert.deepEqual(fetch.calls[2].json, { email: 'jane@example.com', run_dedupe: true });
});

test('contacts and accounts: update with PATCH, search, read; a validation error keeps Apollo\'s words', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/search')) return jsonResponse(200, json('contacts-search.json'));
    return jsonResponse(200, json('contact.json'));
  });
  await callTool(module, 'update_contact', { contact_id: 'cnt789', title: 'Co-Founder & CEO', label_names: ['Customer'] }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/contacts/cnt789');
  assert.deepEqual(fetch.calls[0].json, { title: 'Co-Founder & CEO', label_names: ['Customer'] });
  const nothing = await callTool(module, 'update_contact', { contact_id: 'cnt789' }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);

  const search = await callTool(module, 'search_contacts', { q_keywords: 'CEO', sort_by_field: 'contact_updated_at' }, ctx);
  assert.deepEqual(fetch.calls[1].json, { q_keywords: 'CEO', sort_by_field: 'contact_updated_at', page: 1, per_page: 25 });
  assert.equal(search.payload.contacts[0].id, 'cnt789');
  assert.equal(search.payload.nextCursor, undefined);
  await callTool(module, 'get_contact', { contact_id: 'cnt789' }, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.apollo.io/api/v1/contacts/cnt789');

  const invalid = setup(() => jsonResponse(422, json('error-422.json')));
  const refused = await callTool(invalid.module, 'create_accounts', { accounts: [{ name: 'x' }] }, invalid.ctx);
  assert.match(refused.payload.error, /^Apollo did not accept the account \(HTTP 422\)\. Apollo said: "Name is required"\. Nothing was changed\.$/);
});

test('a key without access to an endpoint gets Apollo\'s 403 explained', async () => {
  const { module, ctx } = setup(() => jsonResponse(403, json('error-403.json')));
  const { payload } = await callTool(module, 'search_sequences', {}, ctx);
  assert.equal(payload.status, 403);
  assert.match(payload.error, /^Apollo refused the request: the API key cannot use this endpoint \(a master API key, or a key given access to it, can\) or the plan does not include it \(HTTP 403\)\. Apollo said: "api\/v1\/emailer_campaigns\/search is not accessible with this api_key"\.$/);
});

test('sequences: search, add contacts from an email account, change their status, activate', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/search')) return jsonResponse(200, json('sequences.json'));
    if (request.path.endsWith('/add_contact_ids')) return jsonResponse(200, json('add-contacts.json'));
    if (request.path.endsWith('/approve')) return jsonResponse(200, { emailer_campaign: { id: 'seq001', active: true } });
    return jsonResponse(200, { contacts: [{ id: 'cnt789', name: 'Jane Doe' }] });
  });
  const sequences = await callTool(module, 'search_sequences', { q_name: 'Outbound' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { q_name: 'Outbound', page: 1, per_page: 25 });
  assert.equal(sequences.payload.emailer_campaigns[0].reply_rate, 0.075);

  const added = await callTool(module, 'add_contacts_to_sequence', { sequence_id: 'seq001', contact_ids: ['cnt789', 'cnt790'], send_email_from_email_account_id: 'ea001', sequence_active_in_other_campaigns: false }, ctx);
  assert.equal(fetch.calls[1].path, '/api/v1/emailer_campaigns/seq001/add_contact_ids');
  assert.deepEqual(fetch.calls[1].json, { contact_ids: ['cnt789', 'cnt790'], send_email_from_email_account_id: 'ea001', sequence_active_in_other_campaigns: false, emailer_campaign_id: 'seq001' });
  assert.deepEqual(added.payload.added, [{ id: 'cnt789', name: 'Jane Doe', email: 'jane@example.com' }]);
  assert.deepEqual(added.payload.skipped_contact_ids, { cnt790: 'contacts_without_email' });
  const neither = await callTool(module, 'add_contacts_to_sequence', { sequence_id: 'seq001', send_email_from_email_account_id: 'ea001' }, ctx);
  assert.match(neither.payload.error, /contact_ids or label_names/);

  await callTool(module, 'update_sequence_contacts', { sequence_ids: ['seq001'], contact_ids: ['cnt789'], mode: 'mark_as_finished' }, ctx);
  assert.deepEqual(fetch.calls[2].json, { emailer_campaign_ids: ['seq001'], contact_ids: ['cnt789'], mode: 'mark_as_finished' });
  const active = await callTool(module, 'set_sequence_active', { sequence_id: 'seq001', active: true }, ctx);
  assert.equal(fetch.calls[3].path, '/api/v1/emailer_campaigns/seq001/approve');
  assert.deepEqual(active.payload, { id: 'seq001', active: true });
  await callTool(module, 'set_sequence_active', { sequence_id: 'seq001', active: false }, ctx);
  assert.equal(fetch.calls[4].path, '/api/v1/emailer_campaigns/seq001/abort');
});

test('GET searches send lists as name[] and ranges as name[min]', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.includes('opportunities') ? json('deals.json') : { pagination: { page: 1, total_pages: 1 }, emailer_messages: [{ id: 'msg001', subject: 'Hi', status: 'delivered', emailer_campaign_id: 'seq001' }] }));
  const emails = await callTool(module, 'search_outreach_emails', { sequence_ids: ['seq001'], statuses: ['opened'], date_after: '2026-11-01' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/emailer_messages/search?emailer_campaign_ids%5B%5D=seq001&emailer_message_stats%5B%5D=opened&emailer_message_date_range%5Bmin%5D=2026-11-01&page=1&per_page=25');
  assert.equal(emails.payload.emailer_messages[0].id, 'msg001');

  await callTool(module, 'search_deals', { account_ids: ['acc456'], is_closed: false, filters: { opportunity_amount_range: { min: 1000 } } }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.apollo.io/api/v1/opportunities/search?opportunity_amount_range%5Bmin%5D=1000&account_ids%5B%5D=acc456&opportunity_is_closed=false&page=1&per_page=25');
});

test('deals: create with the amount as text, update with PATCH, read one', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('deal.json')));
  const created = await callTool(module, 'create_deal', { name: 'Example - Enterprise Plan', amount: 50000, opportunity_stage_id: 'dstg002', closed_date: '2026-06-30' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { name: 'Example - Enterprise Plan', amount: '50000', opportunity_stage_id: 'dstg002', closed_date: '2026-06-30' });
  assert.equal(created.payload.deal_probability, 10);
  await callTool(module, 'update_deal', { deal_id: 'opp001', amount: 65000, opportunity_stage_id: 'dstg003' }, ctx);
  assert.equal(fetch.calls[1].method, 'PATCH');
  assert.equal(fetch.calls[1].url, 'https://api.apollo.io/api/v1/opportunities/opp001');
  assert.deepEqual(fetch.calls[1].json, { amount: '65000', opportunity_stage_id: 'dstg003' });
  await callTool(module, 'get_deal', { deal_id: 'opp001' }, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.apollo.io/api/v1/opportunities/opp001');
});

test('tasks: one contact uses tasks, several use bulk_create; calls are logged against a contact', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/bulk_create')) return jsonResponse(200, { success: true, tasks: [json('task.json').task, { ...json('task.json').task, id: 't2', contact_id: 'cnt790' }] });
    if (request.path.endsWith('/phone_calls')) return jsonResponse(200, { phone_call: { id: 'call1', status: 'completed', duration: 420, contact_id: 'cnt789' } });
    return jsonResponse(200, json('task.json'));
  });
  const base = { user_id: 'usr001', type: 'call', due_at: '2026-11-25T14:00:00Z', priority: 'high', note: 'Follow up on the proposal.' };
  const one = await callTool(module, 'create_tasks', { ...base, contact_ids: ['cnt789'] }, ctx);
  assert.equal(fetch.calls[0].path, '/api/v1/tasks');
  assert.deepEqual(fetch.calls[0].json, { user_id: 'usr001', type: 'call', status: 'scheduled', priority: 'high', due_at: '2026-11-25T14:00:00Z', note: 'Follow up on the proposal.', contact_id: 'cnt789' });
  assert.equal(one.payload.tasks[0].id, '67a1b2c3d4e5f60001234567');
  const many = await callTool(module, 'create_tasks', { ...base, contact_ids: ['cnt789', 'cnt790'] }, ctx);
  assert.equal(fetch.calls[1].path, '/api/v1/tasks/bulk_create');
  assert.deepEqual(fetch.calls[1].json.contact_ids, ['cnt789', 'cnt790']);
  assert.equal(many.payload.tasks.length, 2);

  const call = await callTool(module, 'log_call', { contact_id: 'cnt789', user_ids: ['usr001'], status: 'completed', duration: 420, note: 'Discussed expansion' }, ctx);
  assert.deepEqual(fetch.calls[2].json, { contact_id: 'cnt789', status: 'completed', duration: 420, note: 'Discussed expansion', user_id: ['usr001'], logged: true });
  assert.deepEqual(call.payload, { id: 'call1', status: 'completed', duration: 420, contact_id: 'cnt789' });
  const nobody = await callTool(module, 'log_call', { status: 'completed' }, ctx);
  assert.match(nobody.payload.error, /contact_id or account_id/);
});

test('list_team_data lists users page by page and the deal stages at once', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.path.endsWith('/users/search') ? json('users.json') : json('stages.json')));
  const users = await callTool(module, 'list_team_data', { kind: 'users' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.apollo.io/api/v1/users/search?page=1&per_page=100');
  assert.deepEqual(users.payload.users, [{ id: 'usr001', first_name: 'Admin', last_name: 'User', email: 'admin@example.com', title: 'Sales lead' }]);
  const stages = await callTool(module, 'list_team_data', { kind: 'deal_stages' }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.apollo.io/api/v1/opportunity_stages');
  assert.deepEqual(stages.payload.opportunity_stages, [{ id: 'dstg001', name: 'Discovery', display_order: 1, probability: 10, is_won: false, is_closed: false, opportunity_pipeline_id: 'pl1' }]);
});

test('a big person page is cut under 32 KB and resumes inside the same Apollo page', async () => {
  const people = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, first_name: `Person ${index}`, title: 't'.repeat(250), headline: 'h'.repeat(190), organization: { name: 'Org', short_description: 'd'.repeat(480) } }));
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { total_entries: 1000, people }));
  const first = await callTool(module, 'search_people', { per_page: 100 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  const shown = first.payload.people.length;
  assert.ok(shown < 100);
  const second = await callTool(module, 'search_people', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.page, 1);
  assert.equal(second.payload.people[0].id, `p${shown}`);
});

test('a 429 carries retryAfter', async () => {
  const { module, ctx } = setup(() => textResponse(429, 'The maximum number of api calls allowed for api/v1/contacts/search is 200 times per minute.', { 'retry-after': '60' }));
  const { payload } = await callTool(module, 'search_contacts', {}, ctx);
  assert.equal(payload.retryAfter, 60);
  assert.match(payload.error, /Apollo rate limit reached \(HTTP 429\)\. Retry after 60 seconds\./);
});

test('writes without a clear answer are unknown, sent once, with the read tool to check', async () => {
  const writes = [
    ['create_contacts', { contacts: [{ email: 'a@example.com' }] }, 'search_contacts'],
    ['upsert_contacts', { contacts: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }, 'search_contacts'],
    ['update_contact', { contact_id: 'c1', title: 'T' }, 'get_contact'],
    ['create_accounts', { accounts: [{ name: 'A' }] }, 'search_accounts'],
    ['update_account', { account_id: 'a1', name: 'A' }, 'get_account'],
    ['add_contacts_to_sequence', { sequence_id: 's1', contact_ids: ['c1'], send_email_from_email_account_id: 'e1' }, 'get_contact'],
    ['update_sequence_contacts', { sequence_ids: ['s1'], contact_ids: ['c1'], mode: 'stop' }, 'get_contact'],
    ['set_sequence_active', { sequence_id: 's1', active: true }, 'search_sequences'],
    ['create_deal', { name: 'D' }, 'search_deals'],
    ['update_deal', { deal_id: 'd1', name: 'D' }, 'get_deal'],
    ['create_tasks', { user_id: 'u1', contact_ids: ['c1'], type: 'call', due_at: '2026-12-01' }, 'search_tasks'],
    ['log_call', { contact_id: 'c1' }, 'search_calls'],
  ];
  for (const respond of [() => jsonResponse(500, { error: 'Internal error' }), () => { throw new TypeError('fetch failed'); }]) {
    for (const [tool, args, check] of writes) {
      const { module, fetch, ctx } = setup(respond);
      const { payload } = await callTool(module, tool, args, ctx);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check, tool);
      assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
    }
  }
});

test('reads by POST (searches, enrichment, usage) fail plainly on a server error', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(503, { error: 'Service unavailable' }));
  for (const [tool, args] of [['search_people', {}], ['enrich_people', { people: [{ email: 'a@example.com' }] }], ['get_usage', {}]]) {
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, undefined, tool);
    assert.match(payload.error, /Apollo had a server error \(HTTP 503\): Service unavailable\. Try again later\./);
  }
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].url, 'https://api.apollo.io/api/v1/usage_stats/api_usage_stats');
});

test('api_get and api_request reach the rest of /api/v1/ with the key', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { labels: [] }), { apikey: KEY, masterapikey: MASTER });
  const read = await callTool(module, 'api_get', { path: '/api/v1/labels' }, ctx);
  assert.equal(read.payload.status, 200);
  assert.equal(fetch.calls[0].headers['x-api-key'], MASTER);
  const complete = await callTool(module, 'api_request', { method: 'POST', path: '/api/v1/tasks/t1/complete' }, ctx);
  assert.equal(complete.isError, false);
  const outside = await callTool(module, 'api_get', { path: '/v1/people' }, ctx);
  assert.equal(outside.payload.error, 'The path must start with /api/v1/. Nothing was sent.');
  assert.equal(fetch.calls.length, 2);
});

test('logs never carry a key or a person', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(200, json('person-match.json')), { apikey: KEY, masterapikey: MASTER });
  await callTool(module, 'enrich_people', { people: [{ email: 'tim@example.com' }] }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['apollo enrich_people POST 200 Nms']);
  const text = logs.join('\n');
  for (const secret of [KEY, MASTER, 'tim@example.com']) assert.equal(text.includes(secret), false, secret);
});
