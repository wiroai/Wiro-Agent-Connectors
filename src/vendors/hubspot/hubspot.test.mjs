import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'CJ-example-access-token-0123456789';
const credentials = { access_token: TOKEN, portalid: '12345678' };
const json = (name) => fixture(import.meta.url, name);

function setup(handler, creds = credentials) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, fetch });
  return { module, fetch, ctx, logs };
}

const noContent = () => new Response(null, { status: 204 });

test('the module needs the access token; the portal id is optional; no account picker', () => {
  const { module } = setup(() => jsonResponse(200, {}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(module.origins), ['https://api.hubapi.com']);
  assert.deepEqual(plain(module.credentials), ['access_token', 'portalid']);
  assert.deepEqual(plain(module.requiredCredentials), [['access_token']]);
  assert.deepEqual(plain(module.accountPickers), []);
});

test('get_account reads the account with the Bearer token and notices a token of another portal', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('account.json')));
  const { payload } = await callTool(module, 'get_account', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/account-info/v3/details');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, { portalId: 12345678, accountType: 'STANDARD', timeZone: 'US/Eastern', companyCurrency: 'USD', dataHostingLocation: 'na1', uiDomain: 'app.hubspot.com' });

  const other = setup(() => jsonResponse(200, json('account.json')), { access_token: TOKEN, portalid: '999' });
  const mismatch = await callTool(other.module, 'get_account', {}, other.ctx);
  assert.equal(mismatch.payload.warning, 'The token belongs to HubSpot portal 12345678, not to portal 999 this connection was made for.');

  const fetch2 = fakeFetch(() => jsonResponse(200, {}));
  const missing = await callTool(other.module, 'get_account', {}, makeContext({ credentials: { portalid: '1' }, fetch: fetch2 }).ctx);
  assert.equal(missing.payload.error, 'HubSpot is not connected: the HubSpot access token is missing.');
  assert.equal(fetch2.calls.length, 0);
});

test('list_objects asks for properties and associations, trims empty values, and pages with after', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('contacts.json')));
  const first = await callTool(module, 'list_objects', { object_type: 'contacts', properties: ['email', 'firstname', 'lastname', 'phone', 'lifecyclestage'], associations: ['companies'], limit: 2 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts?limit=2&properties=email%2Cfirstname%2Clastname%2Cphone%2Clifecyclestage&associations=companies');
  assert.deepEqual(first.payload.results[0], {
    id: '501',
    properties: { createdate: '2026-03-24T10:00:00.000Z', email: 'ann@example.com', firstname: 'Ann', lastmodifieddate: '2026-11-20T10:00:00.000Z', lastname: 'Example', lifecyclestage: 'lead' },
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    associations: { companies: ['201'] },
  });
  assert.equal('lastname' in first.payload.results[1].properties, false, 'an empty value is left out');
  await callTool(module, 'list_objects', { object_type: 'contacts', cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.after, '503');
  assert.equal(fetch.calls[1].query.limit, '2');

  const bad = await callTool(module, 'list_objects', { object_type: '../oauth' }, ctx);
  assert.match(bad.payload.error, /`object_type` does not have the expected format/);
  assert.equal(fetch.calls.length, 2);
});

test('get_object finds a contact by email with id_property', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('contacts.json').results[0]));
  const { payload } = await callTool(module, 'get_object', { object_type: 'contacts', id: 'ann+news@example.com', id_property: 'email', properties_with_history: ['lifecyclestage'] }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts/ann%2Bnews%40example.com?idProperty=email&propertiesWithHistory=lifecyclestage');
  assert.equal(payload.id, '501');

  const gone = setup(() => jsonResponse(404, { status: 'error', message: 'Object not found. objectId are usually numeric.', category: 'OBJECT_NOT_FOUND' }));
  const missing = await callTool(gone.module, 'get_object', { object_type: 'deals', id: '9' }, gone.ctx);
  assert.match(missing.payload.error, /^HubSpot has no deals record with that id \(HTTP 404\)\. HubSpot said: "Object not found\. objectId are usually numeric\."\.$/);
});

test('search_objects posts the filters as a read, returns the total, and pages with after', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, json('search.json')));
  const filterGroups = [{ filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: '*@example.com' }] }];
  const first = await callTool(module, 'search_objects', { object_type: 'contacts', filter_groups: filterGroups, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], properties: ['email'], limit: 1 }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts/search');
  assert.deepEqual(fetch.calls[0].json, { filterGroups, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], properties: ['email'], limit: 1 });
  assert.equal(first.payload.total, 2);
  await callTool(module, 'search_objects', { object_type: 'contacts', filter_groups: filterGroups, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.after, '1');

  const tooMany = Array.from({ length: 4 }, () => ({ filters: Array.from({ length: 5 }, () => ({ propertyName: 'email', operator: 'HAS_PROPERTY' })) }));
  const refused = await callTool(module, 'search_objects', { object_type: 'contacts', filter_groups: tooMany }, ctx);
  assert.match(refused.payload.error, /at most 18 filters/);
  const badOperator = await callTool(module, 'search_objects', { object_type: 'contacts', filter_groups: [{ filters: [{ propertyName: 'email', operator: 'LIKE', value: 'x' }] }] }, ctx);
  assert.match(badOperator.payload.error, /operator` must be one of/);
  assert.equal(fetch.calls.length, 2);
});

test('create_object makes an engagement associated with HubSpot\'s default type, looked up once', async () => {
  const { module, fetch, ctx } = setup((request) => (request.path.endsWith('/labels') ? jsonResponse(200, json('labels-notes-contacts.json')) : jsonResponse(201, json('note.json'))));
  const { payload } = await callTool(module, 'create_object', {
    object_type: 'notes',
    properties: { hs_note_body: 'Called about the renewal.', hs_timestamp: '2026-11-22T10:00:00.000Z' },
    associations: [{ to_object_type: 'contacts', to_id: '501' }, { to_object_type: 'contacts', to_id: '502' }, { to_object_type: 'deals', to_id: '9001', type_id: 214 }],
  }, ctx);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), ['GET /crm/v4/associations/notes/contacts/labels', 'POST /crm/v3/objects/notes']);
  assert.deepEqual(fetch.calls[1].json, {
    properties: { hs_note_body: 'Called about the renewal.', hs_timestamp: '2026-11-22T10:00:00.000Z' },
    associations: [
      { to: { id: '501' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
      { to: { id: '502' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
      { to: { id: '9001' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] },
    ],
  });
  assert.equal(payload.id, '90001');
  assert.equal(payload.properties.hs_note_body, 'Called about the renewal.');
});

test('a duplicate contact is a clear 409, and a missing scope a clear 403', async () => {
  const dup = setup(() => jsonResponse(409, json('error-409.json')));
  const conflict = await callTool(dup.module, 'create_object', { object_type: 'contacts', properties: { email: 'ann@example.com' } }, dup.ctx);
  assert.equal(conflict.payload.status, 409);
  assert.match(conflict.payload.error, /^HubSpot already has a record with that unique value \(for a contact, that email\) \(HTTP 409\)\. HubSpot said: "Contact already exists\. Existing ID: 501"\. Nothing was changed\.$/);

  const scopes = setup(() => jsonResponse(403, json('error-403.json')));
  const denied = await callTool(scopes.module, 'publish_marketing_email', { email_id: '12345678' }, scopes.ctx);
  assert.match(denied.payload.error, /HubSpot refused to publish it \(it needs Marketing Hub Enterprise or the transactional email add-on, and the marketing-email scope\) \(HTTP 403\)/);
});

test('update_object patches the properties given, by id or unique property; delete archives', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'DELETE' ? noContent() : jsonResponse(200, json('contacts.json').results[1])));
  await callTool(module, 'update_object', { object_type: 'contacts', id: 'bob@example.com', id_property: 'email', properties: { lifecyclestage: 'customer', hubspot_owner_id: '77' } }, ctx);
  assert.equal(fetch.calls[0].method, 'PATCH');
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts/bob%40example.com?idProperty=email');
  assert.deepEqual(fetch.calls[0].json, { properties: { lifecyclestage: 'customer', hubspot_owner_id: '77' } });
  const empty = await callTool(module, 'update_object', { object_type: 'contacts', id: '502', properties: {} }, ctx);
  assert.match(empty.payload.error, /Nothing to change/);

  const deleted = await callTool(module, 'delete_object', { object_type: 'deals', id: '9001' }, ctx);
  assert.equal(fetch.calls[1].method, 'DELETE');
  assert.equal(fetch.calls[1].url, 'https://api.hubapi.com/crm/v3/objects/deals/9001');
  assert.deepEqual(deleted.payload, { deleted: true, object_type: 'deals', id: '9001' });
});

test('properties, pipelines and owners are trimmed to what a caller needs', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.startsWith('/crm/v3/properties/')) return jsonResponse(200, json('properties.json'));
    if (request.path.startsWith('/crm/v3/pipelines/')) return jsonResponse(200, json('pipelines.json'));
    return jsonResponse(200, json('owners.json'));
  });
  const properties = await callTool(module, 'list_properties', { object_type: 'contacts', filter: 'stage' }, ctx);
  assert.deepEqual(properties.payload, {
    total: 1,
    properties: [{ name: 'lifecyclestage', label: 'Lifecycle Stage', type: 'enumeration', fieldType: 'radio', groupName: 'contactinformation', description: 'The qualification of contacts to sales readiness.', options: [{ label: 'Lead', value: 'lead' }, { label: 'Customer', value: 'customer' }] }],
  });
  const all = await callTool(module, 'list_properties', { object_type: 'contacts' }, ctx);
  assert.equal(all.payload.properties[2].readOnly, true);
  assert.equal(all.payload.properties[2].calculated, true);

  const pipelines = await callTool(module, 'list_pipelines', {}, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.hubapi.com/crm/v3/pipelines/deals');
  assert.deepEqual(pipelines.payload.pipelines[0].stages, [
    { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, isClosed: false, probability: '0.2' },
    { id: 'closedwon', label: 'Closed Won', displayOrder: 5, isClosed: true, probability: '1.0' },
  ]);

  const owners = await callTool(module, 'list_owners', { email: 'sales@example.com' }, ctx);
  assert.equal(fetch.calls[3].url, 'https://api.hubapi.com/crm/v3/owners?email=sales%40example.com&limit=100');
  assert.deepEqual(owners.payload.owners, [{ id: '77', email: 'sales@example.com', firstName: 'Sam', lastName: 'Seller', userId: 12345, teams: [{ id: '9', name: 'East', primary: true }] }]);
});

test('a long property list is cut under 32 KB and continues with the cursor', async () => {
  const results = Array.from({ length: 400 }, (_, index) => ({ name: `custom_${index}`, label: `Custom field ${index}`, type: 'string', fieldType: 'text', groupName: 'custom', description: 'd'.repeat(180) }));
  const { module, ctx } = setup(() => jsonResponse(200, { results }));
  const first = await callTool(module, 'list_properties', { object_type: 'contacts' }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024);
  const shown = first.payload.properties.length;
  const second = await callTool(module, 'list_properties', { object_type: 'contacts', cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.properties[0].name, `custom_${shown}`);
});

test('associations: list them, create them with the default or a labelled type, and remove them', async () => {
  const { module, fetch, ctx } = setup((request) => (request.method === 'GET' ? jsonResponse(200, json('associations.json')) : request.path.endsWith('archive') ? noContent() : jsonResponse(201, json('batch-associations.json'))));
  const list = await callTool(module, 'list_associations', { object_type: 'contacts', id: '501', to_object_type: 'companies' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/crm/v4/objects/contacts/501/associations/companies?limit=100');
  assert.deepEqual(list.payload.associations, [{ toObjectId: '201', types: [{ category: 'HUBSPOT_DEFINED', typeId: 1, label: 'Primary' }, { category: 'HUBSPOT_DEFINED', typeId: 279 }] }]);

  const plain = await callTool(module, 'create_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '501', to_id: '201' }] }, ctx);
  assert.equal(fetch.calls[1].path, '/crm/v4/associations/contacts/companies/batch/associate/default');
  assert.deepEqual(fetch.calls[1].json, { inputs: [{ from: { id: '501' }, to: { id: '201' } }] });
  assert.deepEqual(plain.payload, { status: 'COMPLETE', associated: 1 });
  await callTool(module, 'create_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '501', to_id: '201' }], type_id: 1 }, ctx);
  assert.equal(fetch.calls[2].path, '/crm/v4/associations/contacts/companies/batch/create');
  assert.deepEqual(fetch.calls[2].json.inputs[0].types, [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }]);

  await callTool(module, 'remove_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '501', to_id: '201' }] }, ctx);
  assert.equal(fetch.calls[3].path, '/crm/v4/associations/contacts/companies/batch/archive');
  assert.deepEqual(fetch.calls[3].json, { inputs: [{ from: { id: '501' }, to: [{ id: '201' }] }] });
  await callTool(module, 'remove_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '501', to_id: '201' }], type_id: 1 }, ctx);
  assert.equal(fetch.calls[4].path, '/crm/v4/associations/contacts/companies/batch/labels/archive');
});

test('lists: search them, read members with their properties, add and remove members', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path === '/crm/v3/lists/search') return jsonResponse(200, json('lists-search.json'));
    if (request.path.endsWith('/batch/read')) return jsonResponse(200, json('batch-read.json'));
    if (request.path.endsWith('/memberships/add')) return jsonResponse(200, { recordsIdsAdded: ['501'], recordIdsMissing: ['999'] });
    if (request.path.endsWith('/memberships/remove')) return jsonResponse(200, { recordIdsRemoved: ['502'], recordIdsMissing: [] });
    return jsonResponse(200, json('memberships.json'));
  });
  const lists = await callTool(module, 'search_lists', { query: 'news', count: 2 }, ctx);
  assert.deepEqual(fetch.calls[0].json, { query: 'news', count: 2, offset: 0, additionalProperties: [] });
  assert.deepEqual(lists.payload.lists[0], { listId: '123', name: 'Newsletter subscribers', objectTypeId: '0-1', processingType: 'MANUAL', size: 59, folder: 'Marketing', createdAt: '2025-09-28T22:03:17.998Z', updatedAt: '2026-11-01T22:03:37.005Z' });
  assert.equal(lists.payload.total, 5);
  await callTool(module, 'search_lists', { cursor: lists.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].json.offset, 2);

  const members = await callTool(module, 'list_list_members', { list_id: '123', properties: ['email'] }, ctx);
  assert.equal(fetch.calls[2].url, 'https://api.hubapi.com/crm/v3/lists/123/memberships?limit=100');
  assert.equal(fetch.calls[3].method, 'POST');
  assert.equal(fetch.calls[3].path, '/crm/v3/objects/contacts/batch/read');
  assert.deepEqual(fetch.calls[3].json, { inputs: [{ id: '501' }, { id: '502' }], properties: ['email'] });
  assert.deepEqual(members.payload.members[0], { recordId: '501', membershipTimestamp: '2026-11-01T10:00:00.000Z', properties: { email: 'ann@example.com' } });

  const added = await callTool(module, 'add_to_list', { list_id: '123', record_ids: ['501', '999'] }, ctx);
  assert.equal(fetch.calls[4].method, 'PUT');
  assert.deepEqual(fetch.calls[4].json, ['501', '999']);
  assert.deepEqual(added.payload, { listId: '123', added: ['501'], missing: ['999'] });
  const removed = await callTool(module, 'remove_from_list', { list_id: '123', record_ids: ['502'] }, ctx);
  assert.deepEqual(removed.payload, { listId: '123', removed: ['502'], missing: [] });
});

test('marketing emails: list, get with content, create a draft, update and publish', async () => {
  const { module, fetch, ctx } = setup((request) => {
    if (request.path.endsWith('/publish')) return noContent();
    if (request.method === 'GET' && request.path === '/marketing/v3/emails') return jsonResponse(200, json('emails.json'));
    return jsonResponse(request.method === 'POST' ? 201 : 200, json('emails.json').results[0]);
  });
  const list = await callTool(module, 'list_marketing_emails', { is_published: false, include_stats: true }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/marketing/v3/emails?limit=20&isPublished=false&includeStats=true&sort=-updatedAt');
  assert.deepEqual(list.payload.emails[0].to, { include: ['123'], exclude: [] });
  assert.equal(list.payload.emails[0].content, undefined);

  const one = await callTool(module, 'get_marketing_email', { email_id: '12345678', include_content: true }, ctx);
  assert.equal(fetch.calls[1].url, 'https://api.hubapi.com/marketing/v3/emails/12345678?includeStats=true');
  assert.equal(one.payload.content.plainTextVersion, 'Hello');

  await callTool(module, 'create_marketing_email', {
    name: 'March Newsletter 2026',
    subject: 'What is new this month',
    from_name: 'Example Team',
    reply_to: 'hello@example.com',
    template_path: '@hubspot/email/dnd/welcome.html',
    include_lists: ['123'],
    subscription_id: 9876,
  }, ctx);
  assert.deepEqual(fetch.calls[2].json, {
    name: 'March Newsletter 2026',
    subject: 'What is new this month',
    templatePath: '@hubspot/email/dnd/welcome.html',
    from: { fromName: 'Example Team', replyTo: 'hello@example.com' },
    to: { contactIlsLists: { include: ['123'] } },
    subscriptionDetails: { subscriptionId: 9876 },
  });
  await callTool(module, 'update_marketing_email', { email_id: '12345678', subject: 'New subject' }, ctx);
  assert.equal(fetch.calls[3].method, 'PATCH');
  assert.deepEqual(fetch.calls[3].json, { subject: 'New subject' });
  const published = await callTool(module, 'publish_marketing_email', { email_id: '12345678' }, ctx);
  assert.equal(fetch.calls[4].path, '/marketing/v3/emails/12345678/publish');
  assert.equal(published.payload.published, true);
});

test('send_single_email sends with a send_id, to the transactional or the marketing endpoint', async () => {
  const { module, fetch, ctx } = setup((request) => jsonResponse(200, request.method === 'GET' ? json('send-status.json') : json('single-send.json')));
  const { payload } = await callTool(module, 'send_single_email', { email_id: 12345678, to: 'ann@example.com', custom_properties: { order_number: 'ORD-1' } }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/marketing/v3/transactional/single-email/send');
  const sent = fetch.calls[0].json;
  assert.match(sent.message.sendId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, { emailId: 12345678, message: { to: 'ann@example.com', sendId: sent.message.sendId }, customProperties: { order_number: 'ORD-1' } });
  assert.deepEqual(payload, { sendId: sent.message.sendId, statusId: 'a1b2c3d4-0000-1111-2222-333344445555', status: 'PENDING', requestedAt: '2026-11-22T10:00:00.000Z' });

  await callTool(module, 'send_single_email', { type: 'marketing', email_id: 1, to: 'ann@example.com', send_id: 'order-1' }, ctx);
  assert.equal(fetch.calls[1].path, '/marketing/v4/email/single-send');
  assert.equal(fetch.calls[1].json.message.sendId, 'order-1');

  const status = await callTool(module, 'get_send_status', { status_id: 'a1b2c3d4-0000-1111-2222-333344445555' }, ctx);
  assert.equal(fetch.calls[2].path, '/marketing/v3/email/send-statuses/a1b2c3d4-0000-1111-2222-333344445555');
  assert.equal(status.payload.sendResult, 'SENT');

  const lost = setup(() => {
    throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
  });
  const unknown = await callTool(lost.module, 'send_single_email', { email_id: 1, to: 'ann@example.com', send_id: 'order-2' }, lost.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_send_status');
  assert.match(unknown.payload.error, /Sending it again with send_id "order-2" is safe/);
  assert.equal(lost.fetch.calls.length, 1);
});

test('upload_file downloads the file without the token and posts it as multipart', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const { module, fetch, ctx } = setup((request) => (request.origin === 'https://cdn.example.com' ? bytesResponse(200, png, { 'content-type': 'image/png' }) : jsonResponse(201, json('file.json'))));
  const { payload } = await callTool(module, 'upload_file', { url: 'https://cdn.example.com/images/banner.png', folder_path: '/marketing' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://cdn.example.com/images/banner.png');
  assert.equal(fetch.calls[0].headers.authorization, undefined);
  const upload = fetch.calls[1];
  assert.equal(upload.url, 'https://api.hubapi.com/files/v3/files');
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=----connector[0-9a-f]{32}$/);
  const body = new TextDecoder('latin1').decode(upload.body);
  assert.match(body, /name="fileName"\r\n\r\nbanner\.png\r\n/);
  assert.match(body, /name="folderPath"\r\n\r\n\/marketing\r\n/);
  assert.match(body, /name="options"\r\n\r\n\{"access":"PUBLIC_NOT_INDEXABLE","overwrite":false,"duplicateValidationStrategy":"NONE","duplicateValidationScope":"ENTIRE_PORTAL"\}\r\n/);
  const header = 'name="file"; filename="banner.png"\r\nContent-Type: image/png\r\n\r\n';
  const start = body.indexOf(header) + header.length;
  assert.ok(start > header.length, 'the file part is there');
  assert.deepEqual([...upload.body.subarray(start, start + png.length)], [...png], 'the file bytes follow its headers unchanged');
  assert.ok(body.endsWith('--\r\n'));
  assert.deepEqual(payload, { id: '67890', name: 'banner', extension: 'png', type: 'IMG', size: 1234, access: 'PUBLIC_NOT_INDEXABLE', path: '/marketing/banner.png', url: 'https://f.example.com/hubfs/12345678/marketing/banner.png', createdAt: '2026-11-22T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z' });

  const nameless = await callTool(module, 'upload_file', { url: 'https://cdn.example.com/download?id=7' }, ctx);
  assert.match(nameless.payload.error, /give file_name/);
  const blocked = setup(() => {
    throw refusal('a private address');
  });
  const refused = await callTool(blocked.module, 'upload_file', { url: 'https://10.0.0.1/a.png' }, blocked.ctx);
  assert.match(refused.payload.error, /The file URL was refused .*Nothing was changed\./);
});

test('list_files searches the file manager', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { results: [json('file.json')], paging: { next: { after: 'abc' } } }));
  const { payload } = await callTool(module, 'list_files', { name: 'banner', type: 'IMG' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://api.hubapi.com/files/v3/files/search?name=banner&type=IMG&limit=20&sort=-createdAt');
  assert.equal(payload.files[0].id, '67890');
  assert.ok(payload.nextCursor);
});

test('HubSpot\'s rate limit and server errors', async () => {
  const limited = setup(() => jsonResponse(429, json('error-429.json')));
  const rate = await callTool(limited.module, 'search_objects', { object_type: 'contacts' }, limited.ctx);
  assert.equal(rate.payload.status, 429);
  assert.match(rate.payload.error, /HubSpot rate limit reached \(HTTP 429\)\. Wait a while before retrying\./);

  const down = setup(() => jsonResponse(502, { status: 'error', message: 'Bad gateway' }));
  const read = await callTool(down.module, 'list_objects', { object_type: 'contacts' }, down.ctx);
  assert.equal(read.payload.outcome, undefined);
  assert.match(read.payload.error, /HubSpot had a server error \(HTTP 502\): Bad gateway\. Try again later\./);
});

test('writes without a clear answer are unknown, sent once, with the read tool to check', async () => {
  const writes = [
    ['create_object', { object_type: 'contacts', properties: { email: 'a@example.com' } }, 'search_objects'],
    ['update_object', { object_type: 'contacts', id: '501', properties: { firstname: 'A' } }, 'get_object'],
    ['delete_object', { object_type: 'contacts', id: '501' }, 'get_object'],
    ['create_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '1', to_id: '2' }] }, 'list_associations'],
    ['remove_associations', { from_object_type: 'contacts', to_object_type: 'companies', pairs: [{ from_id: '1', to_id: '2' }] }, 'list_associations'],
    ['add_to_list', { list_id: '123', record_ids: ['1'] }, 'list_list_members'],
    ['remove_from_list', { list_id: '123', record_ids: ['1'] }, 'list_list_members'],
    ['create_marketing_email', { name: 'E' }, 'list_marketing_emails'],
    ['update_marketing_email', { email_id: '1', name: 'E' }, 'get_marketing_email'],
    ['publish_marketing_email', { email_id: '1' }, 'get_marketing_email'],
    ['send_single_email', { email_id: 1, to: 'a@example.com' }, 'get_send_status'],
  ];
  for (const respond of [() => jsonResponse(500, { status: 'error', message: 'internal error' }), () => { throw new TypeError('fetch failed'); }]) {
    for (const [tool, args, check] of writes) {
      const { module, fetch, ctx } = setup(respond);
      const { payload } = await callTool(module, tool, args, ctx);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check, tool);
      assert.equal(fetch.calls.length, 1, `${tool} is never retried`);
    }
  }
});

test('api_get and api_request reach any HubSpot path but OAuth', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { results: [{ category: 'HUBSPOT_DEFINED', typeId: 279, label: null }] }));
  const labels = await callTool(module, 'api_get', { path: '/crm/v4/associations/contacts/companies/labels' }, ctx);
  assert.equal(labels.payload.status, 200);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const merge = await callTool(module, 'api_request', { method: 'POST', path: '/crm/v3/objects/contacts/merge', json: { primaryObjectId: '501', objectIdToMerge: '502' } }, ctx);
  assert.equal(merge.isError, false);
  const token = await callTool(module, 'api_get', { path: '/oauth/v1/access-tokens/abc' }, ctx);
  assert.match(token.payload.error, /OAuth endpoints are not available here/);
  assert.equal(fetch.calls.length, 2);
});

test('logs never carry the token or a record\'s content', async () => {
  const { module, ctx, logs } = setup(() => jsonResponse(201, json('note.json')));
  await callTool(module, 'create_object', { object_type: 'notes', properties: { hs_note_body: 'Secret plans', hs_timestamp: '2026-11-22T10:00:00Z' } }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['hubspot create_object POST 201 Nms']);
  const text = logs.join('\n');
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('Secret plans'), false);
});
