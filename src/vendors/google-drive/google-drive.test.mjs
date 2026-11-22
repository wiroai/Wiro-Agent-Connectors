import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

// The key is made here, for this run: no key is ever stored in the repository.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-0123456789',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'asset-agent@example-project.iam.gserviceaccount.com',
};
const KEY_BASE64 = Buffer.from(JSON.stringify(KEY)).toString('base64');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN = 'ya29.drive-test-token';
const credentials = { serviceaccountjson: KEY_BASE64 };
const CREATIVES = '1MMZGoCreativesFolder00000000000';
const SHEET = '5SheetLeads0000000000000000000000';
const DOC = '3DocBriefDocument000000000000000';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const decoder = new TextDecoder();

/** A fake Google: the token endpoint, then routes by "METHOD origin+path" or "METHOD path". */
function setup(routes, { accounts = null, creds = credentials } = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch((request) => {
    if (request.url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    const route = routes[`${request.method} ${request.origin}${request.path}`] ?? routes[`${request.method} ${request.path}`];
    if (!route) return jsonResponse(500, { error: { code: 500, message: `unexpected ${request.method} ${request.url}` } });
    // A route's Response is cloned, so it can answer more than once.
    return typeof route === 'function' ? route(request) : route.clone();
  });
  const { ctx, logs } = makeContext({ credentials: creds, accounts, fetch });
  const apiCalls = () => fetch.calls.filter((call) => call.url !== TOKEN_URL);
  return { module, fetch, ctx, logs, apiCalls };
}

/** Parent lookups for the folder lock: id -> parents. */
function parentsOf(tree) {
  const routes = {};
  for (const [id, parents] of Object.entries(tree)) routes[`GET /drive/v3/files/${id}`] = jsonResponse(200, { id, parents });
  return routes;
}

function scopesOf(fetch) {
  const exchange = fetch.calls.find((call) => call.url === TOKEN_URL);
  const assertion = new URLSearchParams(decoder.decode(exchange.body)).get('assertion');
  return JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8')).scope;
}

const field = (item, path) => path.split('.').reduce((value, name) => value?.[name], item);

test('the folders picker: with no lock, list_folders lists the folders shared with the service account, then its shared drives', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    'GET /drive/v3/files': jsonResponse(200, fixture(import.meta.url, 'folders-shared.json')),
    'GET /drive/v3/drives': jsonResponse(200, fixture(import.meta.url, 'drives.json')),
  });
  const [picker] = module.accountPickers;
  assert.deepEqual(JSON.parse(JSON.stringify(picker)), {
    key: 'folders',
    label: 'Google Drive folders',
    description: 'The folders the agent may read and write, with their subfolders. Share each one with the service account first.',
    multiple: true,
    tool: 'list_folders',
    idField: 'id',
    nameField: 'name',
    legacyField: 'folders',
  });
  const { payload, isError } = await callTool(module, picker.tool, {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(scopesOf(fetch), 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents');
  const [list, drives] = apiCalls();
  assert.equal(list.query.q, "mimeType='application/vnd.google-apps.folder' and trashed=false and sharedWithMe");
  assert.equal(list.query.supportsAllDrives, 'true');
  assert.equal(list.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(drives.path, '/drive/v3/drives');
  assert.deepEqual(payload.folders.map((item) => [field(item, picker.idField), field(item, picker.nameField), item.type]), [
    [CREATIVES, 'Creatives', 'folder'],
    ['2CyiNWAdAssetsFolder000000000000', 'Ad Assets', 'folder'],
    ['0AMarketingSharedDriveUk9PVA', 'Marketing', 'shared_drive'],
  ]);
  assert.equal(payload.folders[0].owner, 'Jane Doe');
  assert.equal(payload.nextCursor, undefined);
});

test('list_folders pages through shared folders before the shared drives', async () => {
  const { module, ctx, apiCalls } = setup({
    'GET /drive/v3/files': (request) => jsonResponse(200, request.query.pageToken
      ? { files: [{ id: 'f3', name: 'Third' }] }
      : { ...fixture(import.meta.url, 'folders-shared.json'), nextPageToken: 'page-2' }),
    'GET /drive/v3/drives': jsonResponse(200, fixture(import.meta.url, 'drives.json')),
  });
  const first = await callTool(module, 'list_folders', {}, ctx);
  assert.equal(first.payload.folders.length, 2);
  assert.equal(apiCalls().length, 1, 'drives wait for the last folder page');
  const second = await callTool(module, 'list_folders', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(apiCalls()[1].query.pageToken, 'page-2');
  assert.deepEqual(second.payload.folders.map((item) => item.id), ['f3', '0AMarketingSharedDriveUk9PVA']);
});

test('with a lock, list_folders lists the chosen folders by name, and subfolders only inside them', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    [`GET /drive/v3/files/${CREATIVES}`]: jsonResponse(200, { id: CREATIVES, name: 'Creatives', mimeType: 'application/vnd.google-apps.folder' }),
    'GET /drive/v3/files/sub1': jsonResponse(200, { id: 'sub1', parents: [CREATIVES] }),
    'GET /drive/v3/files': jsonResponse(200, { files: [{ id: 'sub2', name: 'Week 1' }] }),
    ...parentsOf({ elsewhere: ['root0'], root0: [] }),
  }, { accounts: { folders: [CREATIVES] } });
  const chosen = await callTool(module, 'list_folders', {}, ctx);
  assert.deepEqual(chosen.payload, { chosen: true, folders: [{ id: CREATIVES, name: 'Creatives', type: 'folder' }] });

  const inside = await callTool(module, 'list_folders', { parent_id: 'sub1' }, ctx);
  assert.deepEqual(inside.payload.folders, [{ id: 'sub2', name: 'Week 1', type: 'folder' }]);
  assert.equal(apiCalls().at(-1).query.q, "mimeType='application/vnd.google-apps.folder' and trashed=false and 'sub1' in parents");

  const before = fetch.calls.length;
  const outside = await callTool(module, 'list_folders', { parent_id: 'elsewhere' }, ctx);
  assert.equal(outside.payload.error, `The folder elsewhere is not inside the folders chosen for this connection (${CREATIVES}). Nothing was changed.`);
  assert.equal(fetch.calls.length - before, 2, 'two parent lookups, no listing');
});

test('list_files builds one Drive query from the filters, trims each file, and pages with the vendor token', async () => {
  const { module, ctx, apiCalls } = setup({ 'GET /drive/v3/files': jsonResponse(200, fixture(import.meta.url, 'files.json')) });
  const { payload } = await callTool(module, 'list_files', {
    folder_id: CREATIVES, name_contains: "summer's", mime_type: 'image/*', modified_after: '2026-03-01T00:00:00Z', page_size: 3,
  }, ctx);
  const [list] = apiCalls();
  assert.equal(
    list.query.q,
    `trashed=false and '${CREATIVES}' in parents and name contains 'summer\\'s' and mimeType contains 'image/' and modifiedTime > '2026-03-01T00:00:00.000Z'`,
  );
  assert.equal(list.query.orderBy, 'modifiedTime desc');
  assert.equal(list.query.pageSize, '3');
  assert.equal(list.query.includeItemsFromAllDrives, 'true');
  assert.equal(payload.folderId, CREATIVES);
  assert.deepEqual(payload.files[1], {
    id: '2CyiNWtBanner1080Image0000000000',
    name: 'banner-1080x1080.jpg',
    kind: 'file',
    mimeType: 'image/jpeg',
    size: 245760,
    modifiedTime: '2026-04-01T09:15:00.000Z',
    createdTime: '2026-04-01T09:00:00.000Z',
    parents: [CREATIVES],
    webViewLink: 'https://drive.google.com/file/d/2CyiNWtBanner1080Image0000000000/view?usp=drivesdk',
  });
  assert.equal(payload.files[0].kind, 'folder');
  assert.equal(payload.files[2].kind, 'document');
  await callTool(module, 'list_files', { folder_id: CREATIVES, cursor: payload.nextCursor }, ctx);
  assert.equal(apiCalls()[1].query.pageToken, '~!!~AI9FV7Qexample-next-page-token');
});

test('with a lock, list_files without a folder lists the chosen folders, and a raw query is refused', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ 'GET /drive/v3/files': jsonResponse(200, { files: [] }) }, { accounts: { folders: [CREATIVES, 'f2'] } });
  await callTool(module, 'list_files', { include_folders: false }, ctx);
  assert.equal(apiCalls()[0].query.q, `trashed=false and ('${CREATIVES}' in parents or 'f2' in parents) and mimeType != 'application/vnd.google-apps.folder'`);
  const before = fetch.calls.length;
  const raw = await callTool(module, 'list_files', { query: "trashed=false) or (trashed=false" }, ctx);
  assert.match(raw.payload.error, /query is not available while this connection is limited to its chosen folders/);
  assert.equal(fetch.calls.length, before);

  const open = setup({ 'GET /drive/v3/files': jsonResponse(200, { files: [] }) });
  await callTool(open.module, 'list_files', { query: 'starred = true' }, open.ctx);
  assert.equal(open.apiCalls()[0].query.q, 'trashed=false and (starred = true)');
});

test('get_file returns the details, export formats and sharing, without the export links', async () => {
  const { module, ctx, apiCalls } = setup({ [`GET /drive/v3/files/${DOC}`]: jsonResponse(200, fixture(import.meta.url, 'file.json')) });
  const { payload } = await callTool(module, 'get_file', { file_id: DOC }, ctx);
  assert.match(apiCalls()[0].query.fields, /exportLinks/);
  assert.equal(apiCalls()[0].query.supportsAllDrives, 'true');
  assert.deepEqual(payload, {
    id: DOC,
    name: 'Campaign brief',
    kind: 'document',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-03-31T16:45:00.000Z',
    createdTime: '2026-03-30T12:00:00.000Z',
    parents: [CREATIVES],
    description: 'Summer campaign brief',
    owner: 'Jane Doe',
    lastModifiedBy: 'John Roe',
    webViewLink: 'https://docs.google.com/document/d/3DocBriefDocument000000000000000/edit?usp=drivesdk',
    exportFormats: ['application/pdf', 'text/markdown', 'text/plain'],
    sharedWith: [
      { id: '01234567890123456789', type: 'user', role: 'owner', email: 'jane@example.com' },
      { id: '98765432109876543210', type: 'user', role: 'writer', email: 'asset-agent@example-project.iam.gserviceaccount.com' },
    ],
    canEdit: true,
    canShare: true,
  });
});

test('read_file exports a Google Doc as Markdown and pages a long text with a cursor', async () => {
  const long = `# Brief\n\n${'Line with "quotes" and text.\n'.repeat(2000)}`;
  const { module, ctx, apiCalls } = setup({
    [`GET /drive/v3/files/${DOC}`]: jsonResponse(200, { id: DOC, name: 'Campaign brief', mimeType: 'application/vnd.google-apps.document' }),
    [`GET /drive/v3/files/${DOC}/export`]: textResponse(200, long, { 'content-type': 'text/markdown' }),
  });
  const first = await callTool(module, 'read_file', { file_id: DOC }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(apiCalls()[1].query.mimeType, 'text/markdown');
  assert.equal(first.payload.format, 'text/markdown');
  assert.equal(first.payload.characters, long.length);
  assert.ok(first.payload.text.startsWith('# Brief'));
  assert.ok(Buffer.byteLength(first.text) < 32 * 1024);
  let text = first.payload.text;
  let cursor = first.payload.nextCursor;
  for (let page = 0; cursor && page < 10; page++) {
    const next = await callTool(module, 'read_file', { file_id: DOC, cursor }, ctx);
    text += next.payload.text;
    cursor = next.payload.nextCursor;
  }
  assert.equal(text, long, 'the pages join up to the whole text');
});

test('read_file reads text files as they are, a Sheet as CSV, and returns links for a binary file', async () => {
  const { module, ctx, apiCalls } = setup({
    'GET /drive/v3/files/notes1': (request) => (request.query.alt === 'media'
      ? textResponse(200, 'id,name\n1,Jane\n', { 'content-type': 'text/csv' })
      : jsonResponse(200, { id: 'notes1', name: 'leads.csv', mimeType: 'text/csv', size: '17' })),
    [`GET /drive/v3/files/${SHEET}`]: jsonResponse(200, { id: SHEET, name: 'Leads', mimeType: 'application/vnd.google-apps.spreadsheet' }),
    [`GET /drive/v3/files/${SHEET}/export`]: textResponse(200, 'Date,Name\n2026-05-11,Jane\n'),
    'GET /drive/v3/files/img1': jsonResponse(200, fixture(import.meta.url, 'uploaded.json')),
  });
  const csv = await callTool(module, 'read_file', { file_id: 'notes1' }, ctx);
  assert.equal(csv.payload.text, 'id,name\n1,Jane\n');
  assert.equal(apiCalls()[1].query.alt, 'media');

  const sheet = await callTool(module, 'read_file', { file_id: SHEET, format: 'tsv' }, ctx);
  assert.equal(apiCalls()[3].query.mimeType, 'text/tab-separated-values');
  assert.equal(sheet.payload.format, 'text/tab-separated-values');
  const wrong = await callTool(module, 'read_file', { file_id: SHEET, format: 'markdown' }, ctx);
  assert.equal(wrong.payload.error, 'A spreadsheet reads as csv or tsv, not markdown.');

  const image = await callTool(module, 'read_file', { file_id: 'img1' }, ctx);
  assert.equal(image.isError, false);
  assert.equal(image.payload.binary, true);
  assert.equal(image.payload.webContentLink, 'https://drive.google.com/uc?id=4UploadedBannerImage00000000000&export=download');
  assert.match(image.payload.note, /share it publicly \(share_file, type anyone, role reader\)/);
});

test('upload_file sends a small file from a URL as one multipart request, typed from its bytes', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    'GET https://cdn.example.com/assets/banner': bytesResponse(200, PNG, { 'content-type': 'application/octet-stream' }),
    'POST /upload/drive/v3/files': jsonResponse(200, fixture(import.meta.url, 'uploaded.json')),
  });
  const { payload, isError } = await callTool(module, 'upload_file', { name: 'banner.png', folder_id: CREATIVES, url: 'https://cdn.example.com/assets/banner', description: 'Summer banner' }, ctx);
  assert.equal(isError, false, payload.error);
  const media = fetch.calls.find((call) => call.origin === 'https://cdn.example.com');
  assert.equal(media.headers.authorization, undefined, 'no token goes to a media URL');
  const upload = apiCalls().find((call) => call.path === '/upload/drive/v3/files');
  assert.equal(upload.query.uploadType, 'multipart');
  assert.equal(upload.query.supportsAllDrives, 'true');
  const boundary = /^multipart\/related; boundary=(upload_[0-9a-f]{32})$/.exec(upload.headers['content-type'])[1];
  const body = Buffer.from(upload.body);
  const text = body.toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`));
  const metadata = JSON.parse(text.split('\r\n\r\n')[1].split('\r\n')[0]);
  assert.deepEqual(metadata, { name: 'banner.png', parents: [CREATIVES], description: 'Summer banner' });
  assert.ok(text.includes(`--${boundary}\r\nContent-Type: image/png\r\n\r\n`));
  assert.ok(body.includes(Buffer.from(PNG)));
  assert.ok(text.endsWith(`\r\n--${boundary}--`));
  assert.equal(payload.id, '4UploadedBannerImage00000000000');
  assert.equal(payload.webContentLink, 'https://drive.google.com/uc?id=4UploadedBannerImage00000000000&export=download');
});

test('upload_file turns text into a Google Sheet with convert_to, and needs one source', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ 'POST /upload/drive/v3/files': jsonResponse(200, { id: 'new1', name: 'Leads', mimeType: 'application/vnd.google-apps.spreadsheet' }) });
  await callTool(module, 'upload_file', { name: 'leads.csv', content: 'a,b\n1,2\n', convert_to: 'spreadsheet' }, ctx);
  const text = Buffer.from(apiCalls()[0].body).toString('utf8');
  assert.ok(text.includes('"mimeType":"application/vnd.google-apps.spreadsheet"'));
  assert.ok(text.includes('Content-Type: text/csv\r\n\r\na,b\n1,2\n'));
  const before = fetch.calls.length;
  const neither = await callTool(module, 'upload_file', { name: 'x.txt' }, ctx);
  assert.equal(neither.payload.error, 'Give url (a public https file) or content (text), one of the two. Nothing was changed.');
  const both = await callTool(module, 'upload_file', { name: 'x.txt', content: 'a', url: 'https://cdn.example.com/x' }, ctx);
  assert.match(both.payload.error, /one of the two/);
  assert.equal(fetch.calls.length, before);
});

test('a file over 5 MB goes through a resumable upload: a session, then the whole file in one PUT', async () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 100);
  big.set(PNG);
  const session = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&upload_id=ADPycdtExampleSession`;
  const { module, ctx, apiCalls } = setup({
    'GET https://cdn.example.com/big.png': bytesResponse(200, big),
    'POST /upload/drive/v3/files': new Response(null, { status: 200, headers: { location: session } }),
    'PUT /upload/drive/v3/files': jsonResponse(200, { ...fixture(import.meta.url, 'uploaded.json'), size: String(big.length) }),
  });
  const { payload, isError } = await callTool(module, 'upload_file', { name: 'big.png', folder_id: CREATIVES, url: 'https://cdn.example.com/big.png' }, ctx);
  assert.equal(isError, false, payload.error);
  const [start, put] = apiCalls().filter((call) => call.path.startsWith('/upload/'));
  assert.equal(start.query.uploadType, 'resumable');
  assert.deepEqual(start.json, { name: 'big.png', parents: [CREATIVES] });
  assert.equal(start.headers['x-upload-content-type'], 'image/png');
  assert.equal(start.headers['x-upload-content-length'], String(big.length));
  assert.equal(put.query.upload_id, 'ADPycdtExampleSession');
  assert.equal(put.headers['content-type'], 'image/png');
  assert.equal(put.body.length, big.length);
  assert.equal(payload.size, big.length);
});

test('the PUT that carries the file is the write: an unclear answer is unknown and nothing is resent; a bad session address sends nothing', async () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  const broken = setup({
    'POST /upload/drive/v3/files': new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=s1' } }),
    'PUT /upload/drive/v3/files': jsonResponse(503, { error: { code: 503, message: 'Service Unavailable' } }),
    'GET https://cdn.example.com/big.bin': bytesResponse(200, big),
  });
  const unknown = await callTool(broken.module, 'upload_file', { name: 'big.bin', url: 'https://cdn.example.com/big.bin' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_files');
  assert.equal(broken.apiCalls().filter((call) => call.method === 'PUT').length, 1);

  const elsewhere = setup({
    'POST /upload/drive/v3/files': new Response(null, { status: 200, headers: { location: 'https://uploads.example.com/session' } }),
    'GET https://cdn.example.com/big.bin': bytesResponse(200, big),
  });
  const refused = await callTool(elsewhere.module, 'upload_file', { name: 'big.bin', url: 'https://cdn.example.com/big.bin' }, elsewhere.ctx);
  assert.equal(refused.payload.error, 'Google Drive started the upload but sent no usable upload address. Nothing was changed.');
  assert.equal(elsewhere.fetch.calls.some((call) => call.origin === 'https://uploads.example.com'), false);
});

test('with a lock, uploads need a chosen folder or one inside it; others are refused after a parent lookup', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    ...parentsOf({ week1: [CREATIVES], other: ['root0'], root0: [] }),
    'POST /upload/drive/v3/files': jsonResponse(200, { id: 'new1', name: 'n.txt' }),
  }, { accounts: { folders: [CREATIVES] } });
  const missing = await callTool(module, 'upload_file', { name: 'n.txt', content: 'hi' }, ctx);
  assert.equal(missing.payload.error, `folder_id is required: this connection may only add files to its chosen folders (${CREATIVES}). Nothing was changed.`);
  assert.equal(fetch.calls.length, 0);

  const inside = await callTool(module, 'upload_file', { name: 'n.txt', content: 'hi', folder_id: 'week1' }, ctx);
  assert.equal(inside.isError, false, inside.payload.error);
  assert.match(apiCalls()[0].query.fields, /parents,driveId/);

  const outside = await callTool(module, 'upload_file', { name: 'n.txt', content: 'hi', folder_id: 'other' }, ctx);
  assert.equal(outside.payload.error, `The folder other is not inside the folders chosen for this connection (${CREATIVES}). Nothing was changed.`);
  assert.equal(apiCalls().filter((call) => call.method === 'POST').length, 1, 'only the upload inside the lock was sent');

  const hidden = setup({
    'GET /drive/v3/files/shared1': jsonResponse(200, { id: 'shared1', parents: ['private0'] }),
    'GET /drive/v3/files/private0': jsonResponse(404, fixture(import.meta.url, 'error-404.json')),
  }, { accounts: { folders: [CREATIVES] } });
  const unseen = await callTool(hidden.module, 'get_file', { file_id: 'shared1' }, hidden.ctx);
  assert.equal(unseen.payload.error, `The file shared1 is not inside the folders chosen for this connection (${CREATIVES}). Nothing was changed.`);

  const none = setup({}, { accounts: { folders: [] } });
  const nothing = await callTool(none.module, 'get_file', { file_id: 'x1' }, none.ctx);
  assert.equal(nothing.payload.error, 'No folder is chosen for this Google Drive connection yet, so it can reach no file. Nothing was changed.');
  assert.equal(none.fetch.calls.length, 0);
});

test('create_document writes Markdown into a new Doc in one request; an empty Doc is metadata only', async () => {
  const { module, ctx, apiCalls } = setup({
    'POST /upload/drive/v3/files': jsonResponse(200, { id: 'doc1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }),
    'POST /drive/v3/files': jsonResponse(200, { id: 'doc2', name: 'Empty', mimeType: 'application/vnd.google-apps.document' }),
  });
  const filled = await callTool(module, 'create_document', { name: 'Notes', folder_id: CREATIVES, text: '# Title\n\n- one' }, ctx);
  assert.equal(filled.payload.kind, 'document');
  const text = Buffer.from(apiCalls()[0].body).toString('utf8');
  assert.ok(text.includes('{"name":"Notes","parents":["1MMZGoCreativesFolder00000000000"],"mimeType":"application/vnd.google-apps.document"}'));
  assert.ok(text.includes('Content-Type: text/markdown\r\n\r\n# Title\n\n- one'));

  await callTool(module, 'create_document', { name: 'Empty', folder_id: CREATIVES }, ctx);
  assert.deepEqual(apiCalls()[1].json, { name: 'Empty', parents: [CREATIVES], mimeType: 'application/vnd.google-apps.document' });
});

test('create_spreadsheet fills a new Sheet from rows as CSV', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ 'POST /upload/drive/v3/files': jsonResponse(200, { id: SHEET, name: 'Leads', mimeType: 'application/vnd.google-apps.spreadsheet' }) });
  await callTool(module, 'create_spreadsheet', { name: 'Leads', rows: [['Name', 'Note'], ['Jane', 'said "hi", twice'], [true, null, 3.5]] }, ctx);
  const text = Buffer.from(apiCalls()[0].body).toString('utf8');
  assert.ok(text.includes('Content-Type: text/csv\r\n\r\nName,Note\r\nJane,"said ""hi"", twice"\r\nTRUE,,3.5\r\n--'));
  const before = fetch.calls.length;
  const bad = await callTool(module, 'create_spreadsheet', { name: 'Leads', rows: [[{ a: 1 }]] }, ctx);
  assert.match(bad.payload.error, /^rows must be a list of rows/);
  assert.equal(fetch.calls.length, before);
});

test('update_file moves a file between folders with one patch, and renames or trashes it', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    'GET /drive/v3/files/file1': jsonResponse(200, { id: 'file1', parents: ['old1'] }),
    'PATCH /drive/v3/files/file1': jsonResponse(200, { id: 'file1', name: 'final.jpg', mimeType: 'image/jpeg', parents: [CREATIVES], trashed: true }),
  });
  await callTool(module, 'update_file', { file_id: 'file1', move_to_folder_id: CREATIVES, name: 'final.jpg' }, ctx);
  const patch = apiCalls().find((call) => call.method === 'PATCH');
  assert.equal(patch.query.addParents, CREATIVES);
  assert.equal(patch.query.removeParents, 'old1');
  assert.deepEqual(patch.json, { name: 'final.jpg' });

  const trashed = await callTool(module, 'update_file', { file_id: 'file1', trashed: true }, ctx);
  assert.equal(trashed.payload.trashed, true);
  assert.deepEqual(apiCalls().at(-1).json, { trashed: true });
  const before = fetch.calls.length;
  const nothing = await callTool(module, 'update_file', { file_id: 'file1' }, ctx);
  assert.equal(nothing.payload.error, 'Give at least one change. Nothing was changed.');
  assert.equal(fetch.calls.length, before);
});

test('replace_file_content uploads new media to the same file id', async () => {
  const { module, ctx, apiCalls } = setup({
    'GET /drive/v3/files/csv1': jsonResponse(200, { id: 'csv1', name: 'leads.csv', mimeType: 'text/csv' }),
    'PATCH /upload/drive/v3/files/csv1': jsonResponse(200, { id: 'csv1', name: 'leads.csv', mimeType: 'text/csv', size: '8' }),
  });
  const { payload } = await callTool(module, 'replace_file_content', { file_id: 'csv1', content: 'a,b\n3,4\n' }, ctx);
  const upload = apiCalls().find((call) => call.method === 'PATCH');
  assert.equal(upload.query.uploadType, 'media');
  assert.equal(upload.headers['content-type'], 'text/csv');
  assert.equal(decoder.decode(upload.body), 'a,b\n3,4\n');
  assert.equal(payload.size, 8);
});

test('share_file adds one permission; the arguments must fit the type', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ 'POST /drive/v3/files/file1/permissions': jsonResponse(200, fixture(import.meta.url, 'permission.json')) });
  const { payload } = await callTool(module, 'share_file', { file_id: 'file1', role: 'reader', type: 'anyone' }, ctx);
  assert.deepEqual(apiCalls()[0].json, { role: 'reader', type: 'anyone' });
  assert.equal(apiCalls()[0].query.sendNotificationEmail, undefined);
  assert.deepEqual(payload, { fileId: 'file1', permissionId: 'anyoneWithLink', type: 'anyone', role: 'reader' });

  await callTool(module, 'share_file', { file_id: 'file1', role: 'writer', type: 'user', email: 'jane@example.com', notify: false }, ctx);
  assert.deepEqual(apiCalls()[1].json, { role: 'writer', type: 'user', emailAddress: 'jane@example.com' });
  assert.equal(apiCalls()[1].query.sendNotificationEmail, 'false');

  const before = fetch.calls.length;
  assert.match((await callTool(module, 'share_file', { file_id: 'file1', role: 'reader', type: 'user' }, ctx)).payload.error, /email is required for type user/);
  assert.match((await callTool(module, 'share_file', { file_id: 'file1', role: 'reader', type: 'domain' }, ctx)).payload.error, /domain is required/);
  assert.match((await callTool(module, 'share_file', { file_id: 'file1', role: 'reader', type: 'anyone', email: 'a@example.com' }, ctx)).payload.error, /go with type user or group only/);
  assert.equal(fetch.calls.length, before);
});

test('Sheets: sheets, a paged range read, append, overwrite and clear go to the Sheets API with the range encoded', async () => {
  const sheets = 'https://sheets.googleapis.com';
  const range = encodeURIComponent('Sheet1!A1:C4');
  const { module, ctx, apiCalls } = setup({
    [`GET ${sheets}/v4/spreadsheets/${SHEET}`]: jsonResponse(200, fixture(import.meta.url, 'spreadsheet.json')),
    [`GET ${sheets}/v4/spreadsheets/${SHEET}/values/${range}`]: jsonResponse(200, fixture(import.meta.url, 'values.json')),
    [`POST ${sheets}/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('Sheet1!A:C')}:append`]: jsonResponse(200, fixture(import.meta.url, 'append.json')),
    [`PUT ${sheets}/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('Sheet1!B2:C3')}`]: jsonResponse(200, fixture(import.meta.url, 'update.json')),
    [`POST ${sheets}/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('Sheet1!A2:Z1000')}:clear`]: jsonResponse(200, fixture(import.meta.url, 'clear.json')),
  });
  const info = await callTool(module, 'get_spreadsheet', { spreadsheet_id: SHEET }, ctx);
  assert.deepEqual(info.payload.sheets[1], { sheetId: 1873456, title: 'Archive 2025', index: 1, type: 'GRID', rows: 200, columns: 8 });
  assert.equal(apiCalls()[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);

  const read = await callTool(module, 'read_sheet', { spreadsheet_id: SHEET, range: 'Sheet1!A1:C4' }, ctx);
  assert.deepEqual(read.payload, { range: 'Sheet1!A1:C4', totalRows: 4, rows: fixture(import.meta.url, 'values.json').values });
  assert.equal(apiCalls()[1].query.valueRenderOption, 'FORMATTED_VALUE');

  const appended = await callTool(module, 'append_rows', { spreadsheet_id: SHEET, range: 'Sheet1!A:C', rows: [['2026-05-14', 'Kim', 9], ['2026-05-15', 'Lee', null]] }, ctx);
  assert.deepEqual(apiCalls()[2].json, { majorDimension: 'ROWS', values: [['2026-05-14', 'Kim', 9], ['2026-05-15', 'Lee', null]] });
  assert.deepEqual(apiCalls()[2].query, { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  assert.deepEqual(appended.payload, { spreadsheetId: SHEET, updatedRange: 'Sheet1!A5:C6', updatedRows: 2, updatedCells: 6 });

  const written = await callTool(module, 'update_range', { spreadsheet_id: SHEET, range: 'Sheet1!B2:C3', rows: [['x', 1], ['y', 2]], value_input: 'RAW' }, ctx);
  assert.equal(apiCalls()[3].query.valueInputOption, 'RAW');
  assert.equal(written.payload.updatedCells, 4);

  const cleared = await callTool(module, 'clear_range', { spreadsheet_id: SHEET, range: 'Sheet1!A2:Z1000' }, ctx);
  assert.deepEqual(apiCalls()[4].json, {});
  assert.equal(cleared.payload.clearedRange, 'Sheet1!A2:Z1000');
});

test('read_sheet cuts a long range to fit and continues with the cursor', async () => {
  const rows = Array.from({ length: 800 }, (_, index) => [`row ${index}`, 'x'.repeat(60)]);
  const { module, ctx } = setup({ [`GET https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/Sheet1`]: jsonResponse(200, { range: 'Sheet1!A1:B800', values: rows }) });
  const first = await callTool(module, 'read_sheet', { spreadsheet_id: SHEET, range: 'Sheet1' }, ctx);
  assert.equal(first.payload.truncated, true);
  assert.ok(first.payload.rows.length < 800);
  const second = await callTool(module, 'read_sheet', { spreadsheet_id: SHEET, range: 'Sheet1', cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(second.payload.rows[0], rows[first.payload.rows.length]);
  assert.equal(second.payload.firstRow, first.payload.rows.length);
});

test('append_rows is sent once: an unclear answer is unknown with read_sheet to check', async () => {
  const { module, ctx, apiCalls } = setup({ [`POST https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/Sheet1:append`]: () => { throw new TypeError('fetch failed'); } });
  const { payload } = await callTool(module, 'append_rows', { spreadsheet_id: SHEET, range: 'Sheet1', rows: [['a']] }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'read_sheet');
  assert.equal(apiCalls().length, 1);
});

test('add_document_text inserts at the end with one Docs batch update, or at the start', async () => {
  const route = `POST https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`;
  const { module, ctx, apiCalls } = setup({ [route]: jsonResponse(200, fixture(import.meta.url, 'docs-batch-update.json')) });
  const { payload } = await callTool(module, 'add_document_text', { document_id: DOC, text: '\nNext steps' }, ctx);
  assert.deepEqual(apiCalls()[0].json, { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nNext steps' } }] });
  assert.deepEqual(payload, { documentId: DOC, position: 'end', characters: 11 });
  await callTool(module, 'add_document_text', { document_id: DOC, text: 'Draft\n', position: 'start' }, ctx);
  assert.deepEqual(apiCalls()[1].json.requests[0].insertText.location, { index: 1 });
});

test('Google\'s storage refusal for service accounts and a missing file come back plainly', async () => {
  const quota = setup({ 'POST /upload/drive/v3/files': jsonResponse(403, fixture(import.meta.url, 'error-storage-quota.json')) });
  const refused = await callTool(quota.module, 'upload_file', { name: 'a.txt', content: 'a', folder_id: CREATIVES }, quota.ctx);
  assert.equal(refused.payload.status, 403);
  assert.match(refused.payload.error, /Service Accounts do not have storage quota/);
  assert.match(refused.payload.error, /Nothing was changed\.$/);

  const missing = setup({ 'GET /drive/v3/files/9MissingFile': jsonResponse(404, fixture(import.meta.url, 'error-404.json')) });
  const notFound = await callTool(missing.module, 'get_file', { file_id: '9MissingFile' }, missing.ctx);
  assert.equal(notFound.payload.error, `Google Drive found no such file, or it is not shared with the service account ${KEY.client_email} (HTTP 404). Google Drive said: "File not found: 9MissingFile.".`);
});

test('api_get and api_request keep to the Drive, Sheets and Docs APIs, and to the chosen folders under a lock', async () => {
  const open = setup({
    'GET /drive/v3/about': jsonResponse(200, { user: { emailAddress: KEY.client_email } }),
    [`POST https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`]: jsonResponse(200, { documentId: DOC }),
  });
  const about = await callTool(open.module, 'api_get', { path: '/drive/v3/about', query: { fields: 'user' } }, open.ctx);
  assert.equal(about.payload.data.user.emailAddress, KEY.client_email);
  const docs = await callTool(open.module, 'api_request', { method: 'POST', origin: 'https://docs.googleapis.com', path: `/v1/documents/${DOC}:batchUpdate`, json: { requests: [] } }, open.ctx);
  assert.equal(docs.payload.status, 200);
  const before = open.fetch.calls.length;
  const gmail = await callTool(open.module, 'api_get', { path: '/gmail/v1/users/me/messages' }, open.ctx);
  assert.match(gmail.payload.error, /^Paths start with \/drive\/v3\//);
  const token = await callTool(open.module, 'api_request', { method: 'POST', origin: 'https://oauth2.googleapis.com', path: '/token' }, open.ctx);
  assert.match(token.payload.error, /^Paths start with/);
  assert.equal(open.fetch.calls.length, before);

  const locked = setup({ ...parentsOf({ file1: [CREATIVES], other: [] }), 'GET /drive/v3/files/file1/permissions': jsonResponse(200, { permissions: [] }) }, { accounts: { folders: [CREATIVES] } });
  const inside = await callTool(locked.module, 'api_get', { path: '/drive/v3/files/file1/permissions' }, locked.ctx);
  assert.equal(inside.payload.status, 200);
  for (const [args, message] of [
    [{ path: '/drive/v3/files', query: { q: 'trashed=false' } }, /list files with list_files/],
    [{ path: '/drive/v3/files/other' }, /The file other is not inside the folders chosen/],
    [{ path: '/drive/v3/drives' }, /only files paths/],
  ]) assert.match((await callTool(locked.module, 'api_get', args, locked.ctx)).payload.error, message);
  for (const [args, message] of [
    [{ method: 'POST', path: '/drive/v3/files', json: { name: 'x' } }, /a new file needs parents naming a chosen folder/],
    [{ method: 'POST', origin: 'https://sheets.googleapis.com', path: '/v4/spreadsheets', json: {} }, /create spreadsheets and documents with create_spreadsheet/],
    [{ method: 'PATCH', path: '/drive/v3/files/file1', query: { addParents: 'other' } }, /The folder other is not inside/],
  ]) assert.match((await callTool(locked.module, 'api_request', args, locked.ctx)).payload.error, message);
});

test('a 429 carries retryAfter, and log lines carry no key, token or content', async () => {
  const limited = setup({ 'GET /drive/v3/files': jsonResponse(429, { error: { code: 429, message: 'User rate limit exceeded.' } }, { 'retry-after': '30' }) });
  const rate = await callTool(limited.module, 'list_files', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);

  const { module, ctx, logs } = setup({ 'POST /upload/drive/v3/files': jsonResponse(200, { id: 'n1', name: 'secret-plan.txt' }) });
  await callTool(module, 'upload_file', { name: 'secret-plan.txt', content: 'The secret plan', folder_id: CREATIVES }, ctx);
  const all = logs.join('\n');
  for (const secret of [ACCESS_TOKEN, 'PRIVATE KEY', KEY_BASE64.slice(0, 40), 'secret plan', 'secret-plan']) assert.equal(all.includes(secret), false, secret);
  for (const line of logs) assert.match(line, /^google-drive upload_file (POST|GET) \d{3} \d+ms$/);
});
