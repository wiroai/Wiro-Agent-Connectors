import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'ya29.a0AfB_byCexampleGmailToken0123456789';
const credentials = { access_token: TOKEN };
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const fx = (name) => fixture(import.meta.url, name);

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts: null, fetch });
  return { module, fetch, ctx, logs };
}

/** A fake Gmail: routes by method and path below /gmail/v1/users/me. */
function gmail(overrides = {}) {
  const routes = {
    'GET /profile': () => jsonResponse(200, fx('profile.json')),
    'GET /messages': () => jsonResponse(200, fx('messages.json')),
    'GET /messages/18c3f2a9d4e5b601': (request) => jsonResponse(200, request.query.format === 'full' ? fx('message.json') : fx('meta-1.json')),
    'GET /messages/18c3f1b7a2c4d902': () => jsonResponse(200, fx('meta-2.json')),
    'GET /messages/18c3f3aa00bb1104': () => jsonResponse(200, { ...fx('meta-1.json'), id: '18c3f3aa00bb1104', labelIds: ['DRAFT'] }),
    'GET /messages/18c3f0c1d2e3f405': () => jsonResponse(200, fx('message-html.json')),
    'GET /threads/18c3e0aa11bb2203': () => jsonResponse(200, fx('thread.json')),
    'GET /labels': () => jsonResponse(200, fx('labels.json')),
    'GET /drafts': () => jsonResponse(200, fx('drafts.json')),
    'POST /messages/batchModify': () => new Response(null, { status: 204 }),
    'POST /messages/18c3f2a9d4e5b601/trash': () => jsonResponse(200, { id: '18c3f2a9d4e5b601', threadId: '18c3f2a9d4e5b601', labelIds: ['TRASH'] }),
    'POST /labels': () => jsonResponse(200, fx('label-created.json')),
    'POST /drafts': () => jsonResponse(200, fx('draft-created.json')),
    'POST /drafts/send': () => jsonResponse(200, fx('sent.json')),
    'POST /messages/send': () => jsonResponse(200, fx('sent.json')),
    ...overrides,
  };
  return (request) => {
    assert.equal(request.origin, 'https://gmail.googleapis.com');
    const route = routes[`${request.method} ${request.path.replace('/gmail/v1/users/me', '')}`];
    if (!route) throw new Error(`unexpected request ${request.method} ${request.path}`);
    return route(request);
  };
}

/** The headers and the decoded text parts of a raw message a tool sent. */
function parseRaw(raw) {
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  const [head] = message.split('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n /g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  const parts = [];
  const partPattern = /Content-Type: text\/(plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g;
  for (const match of message.matchAll(partPattern)) parts.push({ type: match[1], text: Buffer.from(match[2].replace(/\r\n/g, ''), 'base64').toString('utf8') });
  return { message, headers, parts };
}

test('get_profile reads the mailbox with the bearer token', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const { payload } = await callTool(module, 'get_profile', {}, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/profile`);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, { email: 'inbox@example.com', messages_total: 1532, threads_total: 1204, history_id: '984213' });
  assert.deepEqual([...module.accountPickers], []);
  assert.deepEqual([...module.credentials], ['access_token']);
});

test('list_messages searches, then reads each message\'s headers, and pages on', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const { payload, isError } = await callTool(module, 'list_messages', { query: 'in:inbox is:unread', label_ids: ['INBOX', 'UNREAD'], max_results: 2 }, ctx);
  assert.equal(isError, false, payload.error);
  const [list, first] = fetch.calls;
  assert.equal(list.path, '/gmail/v1/users/me/messages');
  const params = new URL(list.url).searchParams;
  assert.equal(params.get('q'), 'in:inbox is:unread');
  assert.deepEqual(params.getAll('labelIds'), ['INBOX', 'UNREAD']);
  assert.equal(params.get('maxResults'), '2');
  assert.equal(params.get('includeSpamTrash'), null);
  assert.equal(first.query.format, 'metadata');
  assert.deepEqual(new URL(first.url).searchParams.getAll('metadataHeaders'), ['From', 'To', 'Subject', 'Date']);
  assert.equal(fetch.calls.length, 3);

  assert.equal(payload.result_size_estimate, 27);
  assert.deepEqual(payload.messages[0], {
    id: '18c3f2a9d4e5b601',
    thread_id: '18c3f2a9d4e5b601',
    from: 'Alice Example <alice@example.com>',
    to: 'inbox@example.com',
    subject: 'Post idea: our new image model',
    date: 'Sat, 21 Nov 2026 09:14:03 -0800',
    received: new Date(1795540443000).toISOString(),
    snippet: "Hi, could you write a post about the new image model? It's live since Monday & people love it.",
    unread: true,
    labels: ['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'INBOX'],
  });
  assert.equal(payload.messages[1].unread, false);
  assert.ok(payload.nextCursor);

  await callTool(module, 'list_messages', { cursor: payload.nextCursor }, ctx);
  assert.equal(fetch.calls[3].query.pageToken, '04717386817224339498');
  assert.equal(fetch.calls[3].query.maxResults, '2');
});

test('a message deleted between the list and the read is left out', async () => {
  const { module, ctx } = setup(gmail({ 'GET /messages/18c3f1b7a2c4d902': () => jsonResponse(404, { error: { code: 404, message: 'Requested entity was not found.' } }) }));
  const { payload } = await callTool(module, 'list_messages', {}, ctx);
  assert.deepEqual(payload.messages.map((message) => message.id), ['18c3f2a9d4e5b601']);
});

test('get_message prefers the plain text, lists attachments, and gives the reply headers', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const { payload } = await callTool(module, 'get_message', { message_id: '18c3f2a9d4e5b601' }, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/messages/18c3f2a9d4e5b601?format=full`);
  assert.equal(payload.from, 'Alice Example <alice@example.com>');
  assert.equal(payload.cc, 'carol@example.com');
  assert.equal(payload.message_id_header, '<CAF1example123@mail.example.com>');
  assert.equal(payload.unread, true);
  assert.equal(payload.body_type, 'text');
  assert.equal(payload.body, 'Hi,\n\nCould you write a post about the new image model?\nThe launch notes are attached.\n\nThanks,\nAlice');
  assert.deepEqual(payload.attachments, [{
    filename: 'launch-notes.pdf',
    mime_type: 'application/pdf',
    size: 40213,
    attachment_id: 'ANGjdJ8exampleAttachmentId0123456789',
    part_id: '1',
  }]);

  const html = await callTool(module, 'get_message', { message_id: '18c3f2a9d4e5b601', body_format: 'html' }, ctx);
  assert.equal(html.payload.body_type, 'html');
  assert.match(html.payload.body, /^<html><head><style>/);
});

test('HTML-only mail in another charset is made readable', async () => {
  const { module, ctx } = setup(gmail());
  const { payload } = await callTool(module, 'get_message', { message_id: '18c3f0c1d2e3f405' }, ctx);
  assert.equal(payload.body_type, 'text from html');
  assert.equal(payload.body, 'Café crème & tarte\n- one\n- two');
});

test('a long body comes in parts that join up', async () => {
  const long = `${'Ünïcödé '.repeat(4000)}${'plain words '.repeat(4000)}`;
  const message = fx('message-html.json');
  message.payload.headers[2].value = 'text/plain; charset=UTF-8';
  message.payload.mimeType = 'text/plain';
  message.payload.body.data = Buffer.from(long).toString('base64url');
  const { module, ctx } = setup(gmail({ 'GET /messages/18c3f0c1d2e3f405': () => jsonResponse(200, message) }));
  const parts = [];
  let offset = 0;
  for (let round = 0; round < 10; round++) {
    const { payload, result } = await callTool(module, 'get_message', { message_id: '18c3f0c1d2e3f405', content_offset: offset }, ctx);
    assert.ok(textBytes(result) <= 32 * 1024);
    parts.push(payload.body);
    if (payload.next_content_offset === undefined) break;
    offset = payload.next_content_offset;
  }
  assert.ok(parts.length > 2);
  assert.equal(parts.join(''), long.trim());
});

test('get_thread returns the conversation oldest first', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const { payload } = await callTool(module, 'get_thread', { thread_id: '18c3e0aa11bb2203' }, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/threads/18c3e0aa11bb2203?format=full`);
  assert.equal(payload.message_count, 2);
  assert.equal(payload.messages[0].body, 'Here is invoice 1182.');
  assert.equal(payload.messages[1].from, 'Bob Example <bob@example.org>');
  assert.equal(payload.messages[1].unread, true);
});

test('list_labels and list_drafts', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const labels = await callTool(module, 'list_labels', {}, ctx);
  assert.deepEqual(labels.payload.labels[2], { id: 'Label_12', name: 'Blog requests', type: 'user' });
  const drafts = await callTool(module, 'list_drafts', { query: 'subject:post' }, ctx);
  assert.equal(fetch.calls[1].query.q, 'subject:post');
  assert.equal(fetch.calls[2].path, '/gmail/v1/users/me/messages/18c3f3aa00bb1104');
  assert.equal(drafts.payload.drafts[0].draft_id, 'r-5823415097465892115');
  assert.equal(drafts.payload.drafts[0].id, '18c3f3aa00bb1104');
  assert.equal(drafts.payload.drafts[0].subject, 'Post idea: our new image model');
});

test('mark_as_read and modify_labels change labels in one batch request', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const read = await callTool(module, 'mark_as_read', { message_ids: ['18c3f2a9d4e5b601', '18c3f1b7a2c4d902'] }, ctx);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${BASE}/messages/batchModify`);
  assert.deepEqual(fetch.calls[0].json, { ids: ['18c3f2a9d4e5b601', '18c3f1b7a2c4d902'], removeLabelIds: ['UNREAD'] });
  assert.deepEqual(read.payload, { updated: 2, read: true });

  await callTool(module, 'mark_as_read', { message_ids: ['18c3f2a9d4e5b601'], read: false }, ctx);
  assert.deepEqual(fetch.calls[1].json, { ids: ['18c3f2a9d4e5b601'], addLabelIds: ['UNREAD'] });

  const filed = await callTool(module, 'modify_labels', { message_ids: ['18c3f2a9d4e5b601'], add_label_ids: ['Label_12'], remove_label_ids: ['INBOX'] }, ctx);
  assert.deepEqual(fetch.calls[2].json, { ids: ['18c3f2a9d4e5b601'], addLabelIds: ['Label_12'], removeLabelIds: ['INBOX'] });
  assert.deepEqual(filed.payload, { updated: 1, added: ['Label_12'], removed: ['INBOX'] });

  const empty = await callTool(module, 'modify_labels', { message_ids: ['18c3f2a9d4e5b601'] }, ctx);
  assert.match(empty.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 3);
});

test('trash_message and create_label', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const trashed = await callTool(module, 'trash_message', { message_id: '18c3f2a9d4e5b601' }, ctx);
  assert.equal(fetch.calls[0].url, `${BASE}/messages/18c3f2a9d4e5b601/trash`);
  assert.equal(fetch.calls[0].body, undefined);
  assert.deepEqual(trashed.payload, { trashed: true, message_id: '18c3f2a9d4e5b601', labels: ['TRASH'] });

  const label = await callTool(module, 'create_label', { name: 'Clients/Acme', show_in_message_list: false }, ctx);
  assert.deepEqual(fetch.calls[1].json, { name: 'Clients/Acme', labelListVisibility: 'labelShow', messageListVisibility: 'hide' });
  assert.deepEqual(label.payload, { id: 'Label_31', name: 'Clients/Acme', type: 'user' });

  const exists = setup(gmail({ 'POST /labels': () => jsonResponse(409, { error: { code: 409, message: 'Label name exists or conflicts' } }) }));
  const conflict = await callTool(exists.module, 'create_label', { name: 'Clients/Acme' }, exists.ctx);
  assert.match(conflict.payload.error, /Gmail already has a label with that name \(HTTP 409\)\. Gmail said: "Label name exists or conflicts"\. Nothing was changed\./);
});

test('send_message writes a UTF-8 message with encoded headers; HTML goes with a text copy', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const { payload, isError } = await callTool(module, 'send_message', {
    to: ['Zoë Example <zoe@example.com>', 'dan@example.com'],
    cc: ['Doe, John <john@example.com>'],
    subject: 'Yeni yazı hazır: görseller ekte',
    html_body: '<p>Merhaba,</p><p>Yazı <a href="https://blog.example.com/post">burada</a>.</p>',
  }, ctx);
  assert.equal(isError, false, payload.error);
  const [sent] = fetch.calls;
  assert.equal(sent.url, `${BASE}/messages/send`);
  assert.equal(sent.json.threadId, undefined);
  const { headers, parts } = parseRaw(sent.json.raw);
  assert.match(headers.to, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.com>, dan@example\.com$/);
  assert.equal(headers.cc, '"Doe, John" <john@example.com>');
  assert.match(headers.subject, /^=\?UTF-8\?B\?/);
  const words = headers.subject.split(' ').map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8'));
  assert.equal(words.join(''), 'Yeni yazı hazır: görseller ekte');
  assert.match(headers['content-type'], /^multipart\/alternative; boundary="part_[0-9a-f]{24}"$/);
  assert.deepEqual(parts.map((part) => part.type), ['plain', 'html']);
  assert.equal(parts[0].text, 'Merhaba,\nYazı burada (https://blog.example.com/post).');
  assert.equal(parts[1].text, '<p>Merhaba,</p><p>Yazı <a href="https://blog.example.com/post">burada</a>.</p>');
  assert.deepEqual(payload, {
    sent: true,
    message_id: '18c3f4bb11cc2205',
    thread_id: '18c3f2a9d4e5b601',
    to: [headers.to.split(', ')[0], 'dan@example.com'],
    subject: 'Yeni yazı hazır: görseller ekte',
    labels: ['SENT'],
  });
});

test('a reply joins the thread with In-Reply-To and References, to the original sender', async () => {
  const original = {
    id: '18c3f2a9d4e5b601',
    threadId: '18c3f2a9d4e5b601',
    payload: { headers: [
      { name: 'Message-Id', value: '<CAF1example123@mail.example.com>' },
      { name: 'References', value: '<older@mail.example.com>' },
      { name: 'Subject', value: 'Post idea: our new image model' },
      { name: 'From', value: 'Alice Example <alice@example.com>' },
    ] },
  };
  const { module, fetch, ctx } = setup(gmail({ 'GET /messages/18c3f2a9d4e5b601': () => jsonResponse(200, original) }));
  const { payload } = await callTool(module, 'create_draft', { reply_to_message_id: '18c3f2a9d4e5b601', body: 'Sure, a draft is coming.' }, ctx);
  const [read, draft] = fetch.calls;
  assert.deepEqual(new URL(read.url).searchParams.getAll('metadataHeaders'), ['Message-ID', 'References', 'Subject', 'From', 'Reply-To']);
  assert.equal(draft.url, `${BASE}/drafts`);
  assert.equal(draft.json.message.threadId, '18c3f2a9d4e5b601');
  const { headers, parts } = parseRaw(draft.json.message.raw);
  assert.equal(headers.to, 'Alice Example <alice@example.com>');
  assert.equal(headers.subject, 'Re: Post idea: our new image model');
  assert.equal(headers['in-reply-to'], '<CAF1example123@mail.example.com>');
  assert.equal(headers.references, '<older@mail.example.com> <CAF1example123@mail.example.com>');
  assert.equal(headers['content-type'], 'text/plain; charset=UTF-8');
  assert.equal(parts[0].text, 'Sure, a draft is coming.');
  assert.deepEqual(payload, {
    draft_id: 'r-5823415097465892115',
    message_id: '18c3f3aa00bb1104',
    thread_id: '18c3f2a9d4e5b601',
    to: ['Alice Example <alice@example.com>'],
    subject: 'Re: Post idea: our new image model',
  });

  const sent = await callTool(module, 'send_draft', { draft_id: 'r-5823415097465892115' }, ctx);
  assert.deepEqual(fetch.calls[2].json, { id: 'r-5823415097465892115' });
  assert.equal(sent.payload.message_id, '18c3f4bb11cc2205');
});

test('send_message refuses a bad address, no recipient or an empty message before sending', async () => {
  const { module, fetch, ctx } = setup(gmail());
  const bad = await callTool(module, 'send_message', { to: ['not an address@'], body: 'x' }, ctx);
  assert.match(bad.payload.error, /to has an address Gmail cannot use/);
  const injected = await callTool(module, 'send_message', { to: ['a@example.com\r\nBcc: evil@example.com'], body: 'x' }, ctx);
  assert.match(injected.payload.error, /does not have the expected format/);
  const nobody = await callTool(module, 'send_message', { subject: 'Hi', body: 'x' }, ctx);
  assert.match(nobody.payload.error, /Give at least one recipient/);
  const empty = await callTool(module, 'send_message', { to: ['a@example.com'], subject: 'Hi' }, ctx);
  assert.match(empty.payload.error, /Give body or html_body/);
  assert.equal(fetch.calls.length, 0);
});

test('errors: an expired token, a rate limit, and a send without a clear answer (sent once)', async () => {
  const expired = setup(() => jsonResponse(401, fx('error-401.json')));
  const denied = await callTool(expired.module, 'list_messages', {}, expired.ctx);
  assert.equal(denied.payload.status, 401);
  assert.match(denied.payload.error, /Gmail rejected the credentials \(HTTP 401\).*Check that the Gmail access token is correct and still active\./);

  const limited = setup(() => jsonResponse(429, { error: { code: 429, message: 'User-rate limit exceeded.' } }, { 'retry-after': '20' }));
  const rate = await callTool(limited.module, 'get_profile', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 20);

  const broken = setup(gmail({ 'POST /messages/send': () => jsonResponse(500, { error: { code: 500, message: 'Backend Error' } }) }));
  const unknown = await callTool(broken.module, 'send_message', { to: ['a@example.com'], subject: 'Hi', body: 'x' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_messages');
  assert.equal(broken.fetch.calls.length, 1);

  const lost = setup(() => {
    throw new TypeError('fetch failed');
  });
  const unclear = await callTool(lost.module, 'mark_as_read', { message_ids: ['18c3f2a9d4e5b601'] }, lost.ctx);
  assert.equal(unclear.payload.outcome, 'unknown');
  assert.equal(unclear.payload.check, 'get_message');
  assert.equal(lost.fetch.calls.length, 1);
});

test('api_get and api_request stay in the mailbox and never change settings', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { history: [], historyId: '984300' }));
  const history = await callTool(module, 'api_get', { path: '/gmail/v1/users/me/history', query: { startHistoryId: '984200' } }, ctx);
  assert.equal(history.isError, false, history.payload.error);
  assert.equal(fetch.calls[0].url, `${BASE}/history?startHistoryId=984200`);
  const settingsRead = await callTool(module, 'api_get', { path: '/gmail/v1/users/me/settings/filters' }, ctx);
  assert.equal(settingsRead.isError, false);

  const forward = await callTool(module, 'api_request', { method: 'POST', path: '/gmail/v1/users/me/settings/forwardingAddresses', json: { forwardingEmail: 'x@example.com' } }, ctx);
  assert.match(forward.payload.error, /Gmail settings .* are not changed here/);
  const otherUser = await callTool(module, 'api_get', { path: '/gmail/v1/users/someone@example.com/messages' }, ctx);
  assert.match(otherUser.payload.error, /The path must start with \/gmail\/v1\/users\/me\//);
  assert.equal(fetch.calls.length, 2);

  const broken = setup(() => jsonResponse(503, { error: { message: 'unavailable' } }));
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: '/gmail/v1/users/me/threads/18c3e0aa11bb2203/modify', json: { removeLabelIds: ['INBOX'] } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.fetch.calls.length, 1);
});

test('log lines carry no token, no addresses and no content', async () => {
  const { module, ctx, logs } = setup(gmail());
  await callTool(module, 'send_message', { to: ['secret.person@example.com'], subject: 'Private subject', body: 'Private words' }, ctx);
  await callTool(module, 'list_messages', { query: 'from:secret.person@example.com' }, ctx);
  assert.ok(logs.length >= 4);
  for (const line of logs) {
    assert.match(line, /^gmail (send_message POST|list_messages GET) 200 \d+ms$/);
    assert.equal(line.includes(TOKEN), false);
    assert.equal(/secret|Private/.test(line), false);
  }
});
