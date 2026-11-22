import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = 'KGAT_0123456789abcdef0123456789abcdef';
const credentials = { username: 'janedoe', apitoken: TOKEN };
const GCS = 'https://storage.googleapis.com/upload/storage/v1/b/kaggle-uploads/o?uploadType=resumable&upload_id=ADPycdv0example';

function setup(handler, creds = credentials) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, fetch });
  return { module, fetch, ctx, logs };
}

const json = (name, status = 200, headers = {}) => jsonResponse(status, fixture(import.meta.url, name), headers);

/** A Kaggle API stand-in for the upload flows: ticket, signed upload, then the create or submit call. */
function uploadFlow(finalFixture, overrides = {}) {
  return (request) => {
    if (request.origin === 'https://files.example.com') return bytesResponse(200, new TextEncoder().encode('region,sales\nnorth,10\n'), { 'content-type': 'text/csv' });
    if (request.path === '/api/v1/blobs/upload' || request.path === '/api/v1/competitions/submission-url') {
      return overrides.ticket ? overrides.ticket(request) : json('blob-ticket.json');
    }
    if (request.origin === 'https://storage.googleapis.com') return overrides.upload ? overrides.upload(request) : jsonResponse(200, { kind: 'storage#object' });
    return overrides.final ? overrides.final(request) : json(finalFixture);
  };
}

test('get_quota reads the weekly GPU and TPU hours with the Bearer token', async () => {
  const { module, fetch, ctx } = setup(() => json('quota.json'));
  const { payload, isError } = await callTool(module, 'get_quota', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/quota');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    gpu: { used_hours: 10, reserved_hours: 0.5, left_hours: 19.5, weekly_hours: 30, extra_hours_enabled: false },
    tpu: { used_hours: 0, left_hours: 20, weekly_hours: 20, extra_hours_enabled: false },
    refreshes_at: '2026-11-29T00:00:00Z',
  });
});

test('a legacy API key goes with the username, as Kaggle\'s own client sends it', async () => {
  const legacy = '0123456789abcdef0123456789abcdef';
  const { module, fetch, ctx } = setup(() => json('quota.json'), { username: '@janedoe', apitoken: legacy });
  await callTool(module, 'get_quota', {}, ctx);
  assert.equal(fetch.calls[0].headers.authorization, `Basic ${Buffer.from(`janedoe:${legacy}`).toString('base64')}`);
});

test('list_notebooks lists your own notebooks from either answer shape, and pages', async () => {
  const { module, fetch, ctx } = setup(() => json('kernels-legacy.json'));
  const first = await callTool(module, 'list_notebooks', { page_size: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/list?group=profile&sortBy=dateRun&pageSize=2&page=1');
  assert.deepEqual(first.payload.notebooks, [
    {
      ref: 'janedoe/sales-forecast',
      title: 'Sales Forecast',
      url: 'https://www.kaggle.com/code/janedoe/sales-forecast',
      last_run: '2026-11-20T10:11:12.13Z',
      language: 'python',
      type: 'notebook',
      visibility: 'private',
      gpu: false,
      internet: false,
      votes: 0,
      version: 4,
    },
    { ref: 'janedoe/feature-prep', title: 'Feature prep', url: 'https://www.kaggle.com/code/janedoe/feature-prep', language: 'python', type: 'script', visibility: 'public' },
  ]);
  await callTool(module, 'list_notebooks', { page_size: 2, cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.page, '2');

  const tokens = setup(() => json('kernels-new.json'));
  const newer = await callTool(tokens.module, 'list_notebooks', { scope: 'everyone', user: 'bob', search: 'sales forecast' }, tokens.ctx);
  assert.deepEqual(tokens.fetch.calls[0].query, { group: 'everyone', user: 'bob', search: 'sales forecast', sortBy: 'dateRun', pageSize: '20', page: '1' });
  assert.equal(newer.payload.notebooks[0].machine, 'NvidiaTeslaT4');
  await callTool(tokens.module, 'list_notebooks', { cursor: newer.payload.nextCursor }, tokens.ctx);
  assert.equal(tokens.fetch.calls[1].query.pageToken, 'CgwI2ZqTxQYQ');
  assert.equal(tokens.fetch.calls[1].query.page, undefined);
});

test('get_notebook reads your own notebook by slug or link, with its code', async () => {
  const { module, fetch, ctx } = setup(() => json('pull.json'));
  const { payload } = await callTool(module, 'get_notebook', { notebook: 'sales-forecast' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/pull?userName=janedoe&kernelSlug=sales-forecast');
  assert.equal(payload.ref, 'janedoe/sales-forecast');
  assert.deepEqual(payload.dataset_sources, ['janedoe/sales-2026']);
  assert.match(payload.code, /read_csv/);
  assert.equal(payload.nextCursor, undefined);

  await callTool(module, 'get_notebook', { notebook: 'https://www.kaggle.com/code/bob/eda-notebook?scriptVersionId=1' }, ctx);
  assert.equal(fetch.calls[1].url, 'https://www.kaggle.com/api/v1/kernels/pull?userName=bob&kernelSlug=eda-notebook');
  const bad = await callTool(module, 'get_notebook', { notebook: 'a/b/c' }, ctx);
  assert.match(bad.payload.error, /must be named "owner\/slug"/);
  assert.equal(fetch.calls.length, 2);
});

test('push_notebook saves a private CPU version by default and maps accelerators', async () => {
  const { module, fetch, ctx } = setup(() => json('push.json'));
  const { payload, isError } = await callTool(module, 'push_notebook', { notebook: 'sales-forecast', title: 'Sales Forecast', code: 'print(1)' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/push');
  assert.deepEqual(fetch.calls[0].json, {
    slug: 'janedoe/sales-forecast',
    newTitle: 'Sales Forecast',
    text: 'print(1)',
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: false,
    enableTpu: false,
    enableInternet: false,
    datasetDataSources: [],
    competitionDataSources: [],
    kernelDataSources: [],
    modelDataSources: [],
    categoryIds: [],
  });
  assert.deepEqual(payload, {
    saved: true,
    ref: '/code/janedoe/sales-forecast',
    url: 'https://www.kaggle.com/code/janedoe/sales-forecast',
    version: 5,
    run: 'started: check it with get_notebook_status',
    refused_sources: { datasets: ['janedoe/missing-data'] },
  });

  await callTool(module, 'push_notebook', {
    notebook: 'janedoe/gpu-run', title: 'GPU run', code: '{}', kernel_type: 'notebook', accelerator: 'gpu_t4x2', internet: true, run: false,
    dataset_sources: ['janedoe/sales-2026'], session_timeout_seconds: 3600,
  }, ctx);
  const gpu = fetch.calls[1].json;
  assert.equal(gpu.enableGpu, true);
  assert.equal(gpu.machineShape, 'NvidiaTeslaT4');
  assert.equal(gpu.enableInternet, true);
  assert.equal(gpu.kernelExecutionType, 'QUICK_SAVE');
  assert.equal(gpu.sessionTimeoutSeconds, 3600);
  assert.deepEqual(gpu.datasetDataSources, ['janedoe/sales-2026']);
});

test('a push Kaggle refuses in a 200 answer is a failure, and a push with no clear answer is unknown', async () => {
  const refused = setup(() => json('push-error.json'));
  const { payload } = await callTool(refused.module, 'push_notebook', { notebook: 'x-note', title: 'Short title', code: 'print(1)' }, refused.ctx);
  assert.equal(payload.outcome, undefined);
  assert.match(payload.error, /Kaggle did not save the notebook: Notebook title must be at least 5 characters\. Nothing was changed\./);

  const down = setup(() => jsonResponse(503, { code: 503, message: 'Service unavailable' }));
  const unknown = await callTool(down.module, 'push_notebook', { notebook: 'x-note', title: 'Short title', code: 'print(1)' }, down.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'get_notebook');
  assert.equal(down.fetch.calls.length, 1);
});

test('get_notebook_status lowercases the status and passes the failure message', async () => {
  const { module, fetch, ctx } = setup(() => json('status.json'));
  const { payload } = await callTool(module, 'get_notebook_status', { notebook: 'sales-forecast' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/status?userName=janedoe&kernelSlug=sales-forecast');
  assert.deepEqual(payload, { ref: 'janedoe/sales-forecast', status: 'error', failure_message: 'Your notebook tried to allocate more memory than is available.' });
});

test('get_notebook_output lists the files and the end of the run log', async () => {
  const { module, fetch, ctx } = setup(() => json('output.json'));
  const { payload } = await callTool(module, 'get_notebook_output', { notebook: 'sales-forecast', log_lines: 2 }, ctx);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/kernels/output?userName=janedoe&kernelSlug=sales-forecast&pageSize=20');
  assert.deepEqual(payload.files.map((file) => file.name), ['submission.csv', '__results__.html']);
  assert.deepEqual(payload.log_tail, ['warning: slow', 'training done']);
  assert.equal(payload.log_lines_total, 3);
});

test('read_notebook_output_file finds the file and downloads it without the Kaggle token', async () => {
  const csv = 'id,survived\n1,0\n2,1\n';
  const { module, fetch, ctx } = setup((request) => (request.origin === 'https://storage.googleapis.com'
    ? bytesResponse(200, new TextEncoder().encode(csv), { 'content-type': 'text/csv' })
    : json('output.json')));
  const { payload, isError } = await callTool(module, 'read_notebook_output_file', { notebook: 'sales-forecast', file_name: 'submission.csv' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls[1].url, 'https://storage.googleapis.com/kaggle-output/101/submission.csv?X-Goog-Signature=abc');
  assert.equal(fetch.calls[1].headers.authorization, undefined, 'the signed link gets no token');
  assert.deepEqual(payload, { ref: 'janedoe/sales-forecast', file_name: 'submission.csv', size_bytes: csv.length, text: csv, length: csv.length });

  const missing = await callTool(module, 'read_notebook_output_file', { notebook: 'sales-forecast', file_name: 'model.pkl' }, ctx);
  assert.match(missing.payload.error, /has no output file named model\.pkl/);

  const binary = setup((request) => (request.origin === 'https://storage.googleapis.com' ? bytesResponse(200, new Uint8Array([0x89, 0x50, 0, 0, 1])) : json('output.json')));
  const blob = await callTool(binary.module, 'read_notebook_output_file', { notebook: 'sales-forecast', file_name: 'submission.csv' }, binary.ctx);
  assert.match(blob.payload.error, /is a binary file/);
});

test('list_datasets, list_dataset_files and get_dataset_status read your datasets', async () => {
  const list = setup(() => json('datasets.json'));
  const datasets = await callTool(list.module, 'list_datasets', {}, list.ctx);
  assert.equal(list.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/datasets/list?group=my&sortBy=updated&pageSize=20&page=1');
  assert.deepEqual(datasets.payload.datasets, [{
    ref: 'janedoe/sales-2026',
    title: 'Sales 2026',
    url: 'https://www.kaggle.com/datasets/janedoe/sales-2026',
    size_bytes: 1234567,
    updated: '2026-11-19T08:00:00.00Z',
    visibility: 'private',
    downloads: 0,
    votes: 0,
    version: 2,
    usability: 7.1,
    license: 'Unknown',
  }]);

  const files = setup(() => json('dataset-files.json'));
  const listed = await callTool(files.module, 'list_dataset_files', { dataset: 'sales-2026' }, files.ctx);
  assert.equal(files.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/datasets/list/janedoe/sales-2026?pageSize=100');
  assert.deepEqual(listed.payload.files, [{ name: 'sales.csv', size_bytes: 1200000, created: '2026-11-19T08:00:00Z' }]);

  // One user's datasets go with group user, as Kaggle's own client sends them.
  const theirs = setup(() => json('datasets.json'));
  await callTool(theirs.module, 'list_datasets', { user: 'bob' }, theirs.ctx);
  assert.equal(theirs.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/datasets/list?group=user&user=bob&sortBy=updated&pageSize=20&page=1');
  await callTool(theirs.module, 'list_datasets', { scope: 'public', search: 'sales' }, theirs.ctx);
  assert.deepEqual(theirs.fetch.calls[1].query, { group: 'public', search: 'sales', sortBy: 'updated', pageSize: '20', page: '1' });

  const status = setup(() => jsonResponse(200, 'ready'));
  const ready = await callTool(status.module, 'get_dataset_status', { dataset: 'janedoe/sales-2026' }, status.ctx);
  assert.equal(status.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/datasets/status/janedoe/sales-2026');
  assert.deepEqual(ready.payload, { ref: 'janedoe/sales-2026', status: 'ready' });
});

test('create_dataset uploads each file to the signed address, without the token, then creates a private dataset', async () => {
  const { module, fetch, ctx } = setup(uploadFlow('dataset-created.json'));
  const { payload, isError } = await callTool(module, 'create_dataset', {
    slug: 'sales-2026',
    title: 'Sales 2026',
    subtitle: 'Monthly sales by region, 2026',
    files: [{ name: 'sales.csv', url: 'https://files.example.com/sales.csv', description: 'Monthly sales' }, { name: 'notes.md', content: '# Notes\n' }],
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.origin}${call.path}`), [
    'GET https://files.example.com/sales.csv',
    'POST https://www.kaggle.com/api/v1/blobs/upload',
    'PUT https://storage.googleapis.com/upload/storage/v1/b/kaggle-uploads/o',
    'POST https://www.kaggle.com/api/v1/blobs/upload',
    'PUT https://storage.googleapis.com/upload/storage/v1/b/kaggle-uploads/o',
    'POST https://www.kaggle.com/api/v1/datasets/create/new',
  ]);
  assert.equal(fetch.calls[0].headers.authorization, undefined);
  const ticket = fetch.calls[1].json;
  assert.equal(ticket.type, 'DATASET');
  assert.equal(ticket.name, 'sales.csv');
  assert.equal(ticket.contentLength, 22);
  assert.ok(Number.isInteger(ticket.lastModifiedEpochSeconds));
  const upload = fetch.calls[2];
  assert.equal(upload.url, GCS);
  assert.equal(upload.headers.authorization, undefined, 'the Kaggle token never goes to the storage address');
  assert.equal(upload.headers['content-type'], 'application/octet-stream');
  assert.equal(new TextDecoder().decode(upload.body), 'region,sales\nnorth,10\n');
  assert.equal(new TextDecoder().decode(fetch.calls[4].body), '# Notes\n');
  assert.deepEqual(fetch.calls[5].json, {
    ownerSlug: 'janedoe',
    slug: 'sales-2026',
    title: 'Sales 2026',
    subtitle: 'Monthly sales by region, 2026',
    licenseName: 'unknown',
    isPrivate: true,
    files: [{ token: 'dXBsb2FkLXRva2VuLTE', description: 'Monthly sales' }, { token: 'dXBsb2FkLXRva2VuLTE' }],
  });
  assert.equal(fetch.calls[5].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(payload, {
    created: true,
    ref: 'janedoe/sales-2026',
    url: 'https://www.kaggle.com/datasets/janedoe/sales-2026',
    status: 'ok',
    visibility: 'private',
    files: [{ name: 'sales.csv', size_bytes: 22 }, { name: 'notes.md', size_bytes: 8 }],
  });
});

test('create_dataset refuses before uploading: no license for a public dataset, a file twice, no url or content', async () => {
  const { module, fetch, ctx } = setup(uploadFlow('dataset-created.json'));
  const base = { slug: 'sales-2026', title: 'Sales 2026' };
  const license = await callTool(module, 'create_dataset', { ...base, private: false, files: [{ name: 'a.csv', content: 'x' }] }, ctx);
  assert.match(license.payload.error, /A public dataset needs a license/);
  const twice = await callTool(module, 'create_dataset', { ...base, files: [{ name: 'a.csv', content: 'x' }, { name: 'a.csv', content: 'y' }] }, ctx);
  assert.match(twice.payload.error, /given twice/);
  const neither = await callTool(module, 'create_dataset', { ...base, files: [{ name: 'a.csv' }] }, ctx);
  assert.match(neither.payload.error, /give url or content/);
  // Kaggle takes slugs of 6 to 50 characters: a shorter one is refused before any file is downloaded or uploaded.
  const short = await callTool(module, 'create_dataset', { ...base, slug: 'sales', files: [{ name: 'a.csv', url: 'https://files.example.com/a.csv' }] }, ctx);
  assert.match(short.payload.error, /Invalid arguments for create_dataset/);
  assert.equal(fetch.calls.length, 0);
});

test('an upload address on an unknown host is never sent the file, and a failed upload creates nothing', async () => {
  const elsewhere = setup(uploadFlow('dataset-created.json', { ticket: () => jsonResponse(200, { token: 't', createUrl: 'https://uploads.example.net/put?sig=1' }) }));
  const off = await callTool(elsewhere.module, 'create_dataset', { slug: 'sales-2026', title: 'Sales 2026', files: [{ name: 'a.csv', content: 'x' }] }, elsewhere.ctx);
  assert.match(off.payload.error, /upload address on uploads\.example\.net, where this connector does not send files\. Nothing was created\./);
  assert.deepEqual(elsewhere.fetch.calls.map((call) => call.path), ['/api/v1/blobs/upload']);

  const expired = setup(uploadFlow('dataset-created.json', { upload: () => new Response('<Error/>', { status: 404 }) }));
  const gone = await callTool(expired.module, 'create_dataset', { slug: 'sales-2026', title: 'Sales 2026', files: [{ name: 'a.csv', content: 'x' }] }, expired.ctx);
  assert.equal(gone.payload.outcome, undefined);
  assert.match(gone.payload.error, /The upload address Kaggle gave for a\.csv has expired/);
  assert.equal(expired.fetch.calls.length, 2);

  const refusedMedia = setup((request) => {
    if (request.origin === 'https://files.example.com') throw refusal('a private address');
    return json('blob-ticket.json');
  });
  const media = await callTool(refusedMedia.module, 'create_dataset', { slug: 'sales-2026', title: 'Sales 2026', files: [{ name: 'a.csv', url: 'https://files.example.com/a.csv' }] }, refusedMedia.ctx);
  assert.match(media.payload.error, /file a\.csv URL was refused/);
  assert.equal(refusedMedia.fetch.calls.length, 1);
});

test('the create call without a clear answer is unknown, after the uploads, and sent once', async () => {
  const { module, fetch, ctx } = setup(uploadFlow('dataset-created.json', { final: () => jsonResponse(502, { code: 502, message: 'Bad gateway' }) }));
  const { payload } = await callTool(module, 'create_dataset', { slug: 'sales-2026', title: 'Sales 2026', files: [{ name: 'a.csv', content: 'x' }] }, ctx);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'list_datasets');
  assert.equal(fetch.calls.filter((call) => call.path === '/api/v1/datasets/create/new').length, 1);
});

test('create_dataset_version uploads the files and posts the version body', async () => {
  const { module, fetch, ctx } = setup(uploadFlow('dataset-created.json'));
  const { payload } = await callTool(module, 'create_dataset_version', { dataset: 'sales-2026', version_notes: 'November data added', files: [{ name: 'sales.csv', content: 'region,sales\n' }] }, ctx);
  const last = fetch.calls[fetch.calls.length - 1];
  assert.equal(last.url, 'https://www.kaggle.com/api/v1/datasets/create/version/janedoe/sales-2026');
  assert.deepEqual(last.json, { versionNotes: 'November data added', deleteOldVersions: false, files: [{ token: 'dXBsb2FkLXRva2VuLTE' }] });
  assert.equal(payload.created, true);

  // delete_old_versions deletes every earlier version for good, so the tool is annotated destructive and not idempotent.
  const tool = module.tools.find((candidate) => candidate.name === 'create_dataset_version');
  assert.deepEqual({ ...tool.annotations }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  const replacing = setup(uploadFlow('dataset-created.json'));
  await callTool(replacing.module, 'create_dataset_version', { dataset: 'sales-2026', version_notes: 'Replaced', files: [{ name: 'sales.csv', content: 'x' }], delete_old_versions: true }, replacing.ctx);
  assert.equal(replacing.fetch.calls[replacing.fetch.calls.length - 1].json.deleteOldVersions, true);
});

test('competitions: the list by slug, a leaderboard, and your submissions', async () => {
  const list = setup(() => json('competitions.json'));
  const competitions = await callTool(list.module, 'list_competitions', { search: 'tabular', group: 'entered' }, list.ctx);
  assert.equal(list.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/competitions/list?search=tabular&group=entered&sortBy=latestDeadline&page=1');
  // The groups are Kaggle's current list tabs; the retired inClass is refused before anything is sent.
  await callTool(list.module, 'list_competitions', { group: 'community' }, list.ctx);
  assert.equal(list.fetch.calls[1].query.group, 'community');
  const retired = await callTool(list.module, 'list_competitions', { group: 'inClass' }, list.ctx);
  assert.match(retired.payload.error, /Invalid arguments for list_competitions/);
  assert.equal(list.fetch.calls.length, 2);
  assert.deepEqual(competitions.payload.competitions[0], {
    slug: 'titanic',
    title: 'Titanic - Machine Learning from Disaster',
    url: 'https://www.kaggle.com/competitions/titanic',
    category: 'Getting Started',
    reward: 'Knowledge',
    deadline: '2030-01-01T00:00:00Z',
    teams: 15000,
    entered: true,
    notebooks_only: false,
    max_daily_submissions: 10,
  });

  const board = setup(() => json('leaderboard.json'));
  const top = await callTool(board.module, 'get_leaderboard', { competition: 'https://www.kaggle.com/competitions/titanic/leaderboard', top: 2 }, board.ctx);
  assert.equal(board.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/competitions/titanic/leaderboard/view');
  assert.deepEqual(top.payload.rows, [
    { rank: 1, team: 'Team A', score: '0.99', submitted: '2026-11-01T00:00:00Z' },
    { rank: 2, team: 'Team B', score: '0.98', submitted: '2026-11-02T00:00:00Z' },
  ]);

  const subs = setup(() => json('submissions.json'));
  const mine = await callTool(subs.module, 'list_submissions', { competition: 'titanic' }, subs.ctx);
  assert.equal(subs.fetch.calls[0].url, 'https://www.kaggle.com/api/v1/competitions/submissions/list/titanic?page=1');
  assert.deepEqual(mine.payload.submissions, [{ ref: 123, file: 'submission.csv', date: '2026-11-20T12:00:00Z', status: 'complete', public_score: '0.77', private_score: '', description: 'first try' }]);
});

test('submit_to_competition takes an upload ticket, uploads, then submits the token', async () => {
  const { module, fetch, ctx } = setup(uploadFlow('submitted.json'));
  const { payload } = await callTool(module, 'submit_to_competition', { competition: 'titanic', file: { name: 'submission.csv', content: 'PassengerId,Survived\n892,0\n' }, description: 'Gradient boosting, 5 folds' }, ctx);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/v1/competitions/submission-url',
    'PUT /upload/storage/v1/b/kaggle-uploads/o',
    'POST /api/v1/competitions/submissions/submit/titanic',
  ]);
  assert.equal(fetch.calls[0].json.competitionName, 'titanic');
  assert.equal(fetch.calls[0].json.fileName, 'submission.csv');
  assert.deepEqual(fetch.calls[2].json, { blobFileTokens: 'dXBsb2FkLXRva2VuLTE', submissionDescription: 'Gradient boosting, 5 folds' });
  assert.deepEqual(payload, { submitted: true, competition: 'titanic', ref: 456, message: 'Successfully submitted to Titanic - Machine Learning from Disaster' });
});

test('submit_notebook_to_competition submits a notebook version', async () => {
  const { module, fetch, ctx } = setup(() => json('submitted.json'));
  await callTool(module, 'submit_notebook_to_competition', { competition: 'titanic', notebook: 'sales-forecast', version: 3, file_name: 'submission.csv', description: 'Version 3' }, ctx);
  assert.equal(fetch.calls[0].url, 'https://www.kaggle.com/api/v1/competitions/submissions/submit-notebook/titanic');
  assert.deepEqual(fetch.calls[0].json, { kernelOwner: 'janedoe', kernelSlug: 'sales-forecast', kernelVersion: 3, fileName: 'submission.csv', submissionDescription: 'Version 3' });
});

test('Kaggle\'s refusals are passed on plainly, a 429 with retryAfter', async () => {
  const denied = setup(() => json('error-401.json', 401));
  assert.match((await callTool(denied.module, 'get_quota', {}, denied.ctx)).payload.error, /Kaggle rejected the credentials \(HTTP 401\): Unauthenticated\. Check that the Kaggle username and Kaggle API token are correct/);
  const forbidden = setup(() => json('error-403.json', 403));
  assert.match((await callTool(forbidden.module, 'get_notebook', { notebook: 'bob/private-one' }, forbidden.ctx)).payload.error, /Kaggle refused the request \(HTTP 403\): Permission 'kernels\.get' was denied/);
  const limited = setup(() => jsonResponse(429, { code: 429, message: 'Too many requests' }, { 'retry-after': '30' }));
  const rate = await callTool(limited.module, 'list_datasets', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);
});

test('api_get and api_request keep to /api/v1/ and never delete', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { info: { title: 'Sales 2026' } }));
  const read = await callTool(module, 'api_get', { path: '/api/v1/datasets/metadata/janedoe/sales-2026' }, ctx);
  assert.deepEqual(read.payload, { status: 200, data: { info: { title: 'Sales 2026' } } });
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  // Kaggle's router ignores case, so every spelling of a delete is refused.
  for (const path of [
    '/api/v1/kernels/delete/janedoe/sales-forecast',
    '/api/v1/dataset/janedoe/sales-2026/delete',
    '/api/v1/dataset/janedoe/sales-2026/DELETE',
    '/api/v1/kernels/Delete/janedoe/sales-forecast',
    '/api/v1/models/janedoe/my-model/%44elete',
    '/api/v1/datasets/DeleteDataset',
  ]) {
    const refused = await callTool(module, 'api_request', { method: 'POST', path }, ctx);
    assert.match(refused.payload.error, /Deleting on Kaggle is not offered here/, path);
  }
  const outside = await callTool(module, 'api_get', { path: '/settings' }, ctx);
  assert.match(outside.payload.error, /must start with \/api\/v1\//);
  assert.equal(fetch.calls.length, 1);
});

test('a long notebook comes in windows, and logs carry no token, code or file content', async () => {
  const source = Array.from({ length: 3000 }, (_, index) => `x_${index} = "value ${index}"`).join('\n');
  const { module, ctx, logs } = setup(() => jsonResponse(200, { metadata: { ref: 'janedoe/big' }, blob: { source } }));
  let joined = '';
  let cursor;
  let steps = 0;
  do {
    const step = await callTool(module, 'get_notebook', { notebook: 'big', ...(cursor ? { cursor } : {}) }, ctx);
    assert.ok(textBytes(step.result) <= 32 * 1024);
    joined += step.payload.code;
    cursor = step.payload.nextCursor;
    steps += 1;
  } while (cursor && steps < 20);
  assert.equal(joined, source);
  assert.ok(logs.every((line) => /^kaggle get_notebook GET 200 \d+ms$/.test(line)));

  const upload = setup(uploadFlow('dataset-created.json'));
  await callTool(upload.module, 'create_dataset', { slug: 'secret-set', title: 'Secret data', files: [{ name: 'a.csv', content: 'very private row' }] }, upload.ctx);
  const joinedLogs = upload.logs.join('\n');
  for (const secret of [TOKEN, 'very private row', 'upload_id', 'secret-set']) assert.equal(joinedLogs.includes(secret), false, secret);
});
