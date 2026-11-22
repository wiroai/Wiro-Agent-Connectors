// Kaggle, through the Kaggle API v1 at https://www.kaggle.com/api/v1/
// (https://github.com/Kaggle/kaggle-cli documents it).
//
// Credentials: `username`, the Kaggle username (the last part of the profile
// address), which names your notebooks and datasets; and `apitoken`, an API
// token from Kaggle → Settings → API → Generate New Token (KGAT_ and 32
// hexadecimal characters), sent as a Bearer token to /api/v1/ only. A legacy
// API key (32 hexadecimal characters from kaggle.json) also works: it is sent
// with the username, as Kaggle's own client does. Files to upload come from a
// public https URL or as text; Kaggle hands out a signed upload address
// (Google Cloud Storage), which gets the file and never the Kaggle token.
// Nothing is deleted here: deleting notebooks and datasets stays on Kaggle.

import { apiTools, defineConnector, ToolFailure, truncate, type ToolHelpers } from '../../core/index.js';
import {
  answerError,
  compact,
  competitionSlug,
  field,
  hours,
  listOf,
  logTail,
  ownerSlug,
  TEXT_WINDOW_BYTES,
  textOf,
  textWindow,
  uploadAll,
  UPLOAD_ORIGINS,
  type FileArg,
} from './helpers.js';

const API = '/api/v1';
const MACHINES: Record<string, { machineShape?: string; enableGpu: boolean; enableTpu: boolean }> = {
  none: { enableGpu: false, enableTpu: false },
  gpu_t4x2: { machineShape: 'NvidiaTeslaT4', enableGpu: true, enableTpu: false },
  gpu_l4: { machineShape: 'NvidiaL4', enableGpu: true, enableTpu: false },
  tpu_v5e8: { machineShape: 'TpuV5E8', enableGpu: false, enableTpu: true },
};
const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-SA-4.0', 'ODbL-1.0', 'GPL-2.0', 'other', 'unknown'];

const NOTEBOOK_REF = { type: 'string' as const, minLength: 1, maxLength: 300, description: 'The notebook as "owner/slug" (its ref), its slug alone for your own, or its kaggle.com link.' };
const DATASET_REF = { type: 'string' as const, minLength: 1, maxLength: 300, description: 'The dataset as "owner/slug", its slug alone for your own, or its kaggle.com link.' };
const COMPETITION = { type: 'string' as const, minLength: 1, maxLength: 300, description: 'The competition\'s slug, such as titanic, or its kaggle.com link.' };
const CURSOR_SCHEMA = { type: 'string' as const, description: 'nextCursor from the previous result; pass the same other arguments again.' };
const SOURCES = (example: string, what: string) => ({
  type: 'array' as const,
  maxItems: 50,
  uniqueItems: true,
  items: { type: 'string' as const, minLength: 1, maxLength: 300 },
  description: `${what}, e.g. ["${example}"]. They appear in the run under /kaggle/input/.`,
});
const FILE_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, pattern: '^[^/\\\\]{1,255}$', description: 'The file name on Kaggle, e.g. sales.csv.' },
    url: { type: 'string' as const, format: 'uri' as const, maxLength: 2000, description: 'A public https URL to download the file from (up to 25 MB).' },
    content: { type: 'string' as const, maxLength: 1000000, description: 'Or the file\'s text itself (up to 1,000,000 characters).' },
    description: { type: 'string' as const, maxLength: 1000, description: 'What the file holds.' },
  },
  required: ['name'],
  additionalProperties: false,
  description: 'A file from a public https URL (up to 25 MB) or as text: give url or content.',
};
const FILES_SCHEMA = {
  type: 'array' as const,
  minItems: 1,
  maxItems: 20,
  items: FILE_SCHEMA,
  description: 'The files, each from a public https URL or as text (up to 20 per call, 25 MB each).',
};

function cursorPage(h: ToolHelpers, cursor: string | undefined): { page: number; token?: string; skip: number } {
  const state = h.cursor(cursor);
  return {
    page: typeof state?.['p'] === 'number' ? state['p'] : 1,
    ...(typeof state?.['k'] === 'string' && state['k'] ? { token: state['k'] } : {}),
    skip: typeof state?.['o'] === 'number' ? state['o'] : 0,
  };
}

/** A Kaggle list result: the next page by Kaggle's page token, or by page number when a full page came back. */
function kagglePage(h: ToolHelpers, key: string, data: any, items: unknown[], at: { page: number; token?: string; skip: number }, pageSize: number, extra?: Record<string, unknown>) {
  const nextToken = !Array.isArray(data) && typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
  const here = { p: at.page, ...(at.token ? { k: at.token } : {}) };
  const next: Record<string, string | number> | undefined = nextToken
    ? { p: at.page + 1, k: nextToken, o: 0 }
    : items.length >= pageSize ? { p: at.page + 1, o: 0 } : undefined;
  return h.page({
    key,
    items: items.slice(at.skip),
    ...(extra ? { extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...here, o: at.skip + index }),
    ...(next ? { nextPage: h.makeCursor(next) } : {}),
  });
}

function trimNotebook(item: any): Record<string, unknown> {
  const ref = field(item, 'ref');
  const private_ = field(item, 'isPrivate');
  return compact({
    ref,
    title: field(item, 'title'),
    url: typeof ref === 'string' ? `https://www.kaggle.com/code/${ref}` : undefined,
    last_run: field(item, 'lastRunTime'),
    language: field(item, 'language'),
    type: field(item, 'kernelType'),
    visibility: private_ === true ? 'private' : private_ === false ? 'public' : undefined,
    gpu: field(item, 'enableGpu'),
    tpu: field(item, 'enableTpu'),
    machine: field(item, 'machineShape'),
    internet: field(item, 'enableInternet'),
    votes: field(item, 'totalVotes'),
    version: field(item, 'currentVersionNumber'),
  });
}

function trimDataset(item: any): Record<string, unknown> {
  const ref = field(item, 'ref');
  const private_ = field(item, 'isPrivate');
  const usability = field(item, 'usabilityRating');
  return compact({
    ref,
    title: field(item, 'title'),
    url: typeof ref === 'string' ? `https://www.kaggle.com/datasets/${ref}` : undefined,
    size_bytes: field(item, 'totalBytes'),
    updated: field(item, 'lastUpdated'),
    visibility: private_ === true ? 'private' : private_ === false ? 'public' : undefined,
    downloads: field(item, 'downloadCount'),
    votes: field(item, 'voteCount'),
    version: field(item, 'currentVersionNumber'),
    usability: typeof usability === 'number' ? Math.round(usability * 100) / 10 : undefined,
    license: field(item, 'licenseName'),
  });
}

function quotaRow(quota: any): Record<string, unknown> | undefined {
  if (!quota || typeof quota !== 'object') return undefined;
  const used = hours(field(quota, 'timeUsed'));
  const reserved = hours(field(quota, 'timeReserved'));
  const allowed = hours(field(quota, 'totalTimeAllowed'));
  const left = used !== undefined && allowed !== undefined ? Math.max(0, Math.round((allowed - used - (reserved ?? 0)) * 10) / 10) : undefined;
  return compact({ used_hours: used, reserved_hours: reserved, left_hours: left, weekly_hours: allowed, extra_hours_enabled: field(quota, 'isPayToScaleEnabled') === true });
}

const refused = (data: any): Record<string, unknown> | undefined => {
  const lists = compact({
    datasets: field(data, 'invalidDatasetSources'),
    competitions: field(data, 'invalidCompetitionSources'),
    notebooks: field(data, 'invalidKernelSources'),
    models: field(data, 'invalidModelSources'),
    tags: field(data, 'invalidTags'),
  });
  const nonEmpty = Object.fromEntries(Object.entries(lists).filter(([, value]) => Array.isArray(value) && value.length));
  return Object.keys(nonEmpty).length ? nonEmpty : undefined;
};

/** The output files of a run, reading Kaggle's pages until `name` is found (or all of them, up to 10 pages). */
async function findOutputFile(h: ToolHelpers, owner: string, slug: string, name: string): Promise<{ name: string; url: string } | undefined> {
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { data } = await h.api({ path: `${API}/kernels/output`, query: { userName: owner, kernelSlug: slug, pageSize: 100, pageToken: token } });
    const failed = answerError(data);
    if (failed) throw new ToolFailure(`Kaggle refused to list the output: ${failed}.`);
    for (const file of listOf(data, 'files')) {
      if (field(file, 'fileName') === name && typeof field(file, 'url') === 'string') return { name, url: field(file, 'url') };
    }
    token = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
    if (!token) break;
  }
  return undefined;
}

const connector = defineConnector({
  vendor: 'kaggle',
  label: 'Kaggle',
  origins: ['https://www.kaggle.com', ...UPLOAD_ORIGINS.filter((origin) => origin !== 'https://www.kaggle.com')],
  credentials: ['username', 'apitoken'],
  credentialLabels: { username: 'Kaggle username', apitoken: 'Kaggle API token' },
  normalizeCredentials: (credentials) => {
    const username = (credentials['username'] ?? '').replace(/^https?:\/\/(?:www\.)?kaggle\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0] ?? '';
    return { ...credentials, username, apitoken: (credentials['apitoken'] ?? '').replace(/^Bearer\s+/i, '') };
  },
  authHeaders: (credentials) => {
    const token = credentials['apitoken'] as string;
    if (/^[0-9a-f]{32}$/i.test(token)) return { authorization: `Basic ${btoa(`${credentials['username']}:${token}`)}` };
    return { authorization: `Bearer ${token}` };
  },
  tools: [
    {
      name: 'get_quota',
      kind: 'read',
      title: 'Get my Kaggle GPU and TPU quota',
      description:
        'The weekly GPU and TPU allowance of the account, in hours: used, held by running sessions, left, the weekly total, and when it '
        + 'refreshes. Check it before a GPU or TPU run. It also confirms the token works.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await h.api({ path: `${API}/kernels/quota` });
        return compact({ gpu: quotaRow(field(data, 'gpuQuota')), tpu: quotaRow(field(data, 'tpuQuota')), refreshes_at: field(data, 'quotaRefreshTime') });
      },
    },
    {
      name: 'list_notebooks',
      kind: 'read',
      title: 'List Kaggle notebooks',
      description:
        'Your own notebooks, last run first by default, with their ref, link, language, type, visibility, accelerator, internet, votes and '
        + 'current version; or someone\'s public notebooks with scope everyone and user. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['mine', 'everyone'], default: 'mine', description: 'mine (default) or everyone (public notebooks; narrow with user or search).' },
          user: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$', description: 'A username whose public notebooks to list (with scope everyone).' },
          search: { type: 'string', maxLength: 200, description: 'Words to search for.' },
          kernel_type: { type: 'string', enum: ['notebook', 'script'], description: 'Only notebooks or only scripts.' },
          language: { type: 'string', enum: ['python', 'r', 'sqlite', 'julia'], description: 'Only this language.' },
          sort_by: {
            type: 'string',
            enum: ['dateRun', 'dateCreated', 'voteCount', 'viewCount', 'hotness', 'commentCount', 'scoreDescending', 'scoreAscending', 'relevance'],
            default: 'dateRun',
            description: 'The order (default dateRun; relevance needs search).',
          },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Notebooks per page, 1 to 100 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { scope: string; user?: string; search?: string; kernel_type?: string; language?: string; sort_by: string; page_size: number; cursor?: string }, h) {
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/kernels/list`,
          query: {
            group: args.scope === 'mine' ? 'profile' : 'everyone',
            user: args.user,
            search: args.search,
            kernelType: args.kernel_type,
            language: args.language,
            sortBy: args.sort_by,
            pageSize: args.page_size,
            page: at.token ? undefined : at.page,
            pageToken: at.token,
          },
        });
        const notebooks = listOf(data, 'kernels').map(trimNotebook);
        return kagglePage(h, 'notebooks', data, notebooks, at, args.page_size);
      },
    },
    {
      name: 'get_notebook',
      kind: 'read',
      title: 'Get a Kaggle notebook and its code',
      description:
        'One notebook\'s settings (language, type, visibility, accelerator, internet, data sources, version) and its code: the script, or the '
        + 'whole notebook JSON, in windows of about 24 KB. Pass nextCursor back as cursor for the next part of the code.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook: NOTEBOOK_REF,
          include_code: { type: 'boolean', default: true, description: 'Return the code too (default true).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['notebook'],
        additionalProperties: false,
      },
      async run(args: { notebook: string; include_code: boolean; cursor?: string }, h) {
        const { owner, slug } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const { data } = await h.api({ path: `${API}/kernels/pull`, query: { userName: owner, kernelSlug: slug }, errors: { 404: 'Kaggle found no notebook with that name that this account can see' } });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle refused to read the notebook: ${failed}.`);
        const metadata = field(data, 'metadata') ?? {};
        const result: Record<string, unknown> = {
          ...trimNotebook(metadata),
          ref: field(metadata, 'ref') ?? `${owner}/${slug}`,
          dataset_sources: field(metadata, 'datasetDataSources'),
          competition_sources: field(metadata, 'competitionDataSources'),
          notebook_sources: field(metadata, 'kernelDataSources'),
          model_sources: field(metadata, 'modelDataSources'),
        };
        if (args.include_code) {
          const blob = field(data, 'blob') ?? {};
          const source = typeof field(blob, 'source') === 'string' ? field(blob, 'source') : '';
          const state = h.cursor(args.cursor);
          const window = textWindow(source, typeof state?.['o'] === 'number' ? state['o'] : 0, TEXT_WINDOW_BYTES);
          result['code'] = window.text;
          result['code_length'] = source.length;
          if (window.offset) result['code_offset'] = window.offset;
          if (window.next !== undefined) result['nextCursor'] = h.makeCursor({ o: window.next });
        }
        return compact(result);
      },
    },
    {
      name: 'push_notebook',
      kind: 'create',
      check: 'get_notebook',
      title: 'Push a Kaggle notebook',
      description:
        'Creates a notebook, or saves a new version of an existing one, and runs it unless run is false. It is private, on CPU and without '
        + 'internet unless asked: a GPU or TPU uses the weekly quota (get_quota), and GPU and internet need a phone-verified account. For a new '
        + 'notebook the slug must be the title in lowercase with dashes. Each push is a new version; check the run with get_notebook_status.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook: NOTEBOOK_REF,
          title: { type: 'string', minLength: 5, maxLength: 50, description: 'The title, at least 5 characters (renaming changes the slug).' },
          code: { type: 'string', minLength: 1, maxLength: 1000000, description: 'The script, or the whole notebook as nbformat 4 JSON (code cells with "outputs": []).' },
          kernel_type: { type: 'string', enum: ['script', 'notebook'], default: 'script', description: 'script (default) or notebook; fixed once the notebook exists.' },
          language: { type: 'string', enum: ['python', 'r', 'rmarkdown'], default: 'python', description: 'python (default), r or rmarkdown.' },
          private: { type: 'boolean', default: true, description: 'true (default). false makes it public: anyone can see and copy it.' },
          accelerator: {
            type: 'string',
            enum: ['none', 'gpu_t4x2', 'gpu_l4', 'tpu_v5e8'],
            default: 'none',
            description: 'none (CPU, default), gpu_t4x2 (two T4 GPUs), gpu_l4, or tpu_v5e8. A GPU or TPU uses the weekly quota.',
          },
          internet: { type: 'boolean', default: false, description: 'Let the code reach the internet (default false), e.g. to install packages.' },
          dataset_sources: SOURCES('janedoe/sales-2026', 'Datasets as "owner/slug"'),
          competition_sources: SOURCES('titanic', 'Competitions you joined, by slug'),
          notebook_sources: SOURCES('janedoe/feature-prep', 'Other notebooks\' output, as "owner/slug"'),
          model_sources: SOURCES('google/gemma/transformers/2b', 'Models as "owner/model/framework/variation", a version number at the end to pin one'),
          run: { type: 'boolean', default: true, description: 'true (default) saves and runs; false saves a version without running it.' },
          session_timeout_seconds: { type: 'integer', minimum: 60, maximum: 43200, description: 'Stop the run after this many seconds (Kaggle\'s own limit is 12 hours, 9 on TPU).' },
        },
        required: ['notebook', 'title', 'code'],
        additionalProperties: false,
      },
      async run(args: {
        notebook: string; title: string; code: string; kernel_type: string; language: string; private: boolean; accelerator: string; internet: boolean;
        dataset_sources?: string[]; competition_sources?: string[]; notebook_sources?: string[]; model_sources?: string[]; run: boolean; session_timeout_seconds?: number;
      }, h) {
        const { ref } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const machine = MACHINES[args.accelerator] ?? MACHINES['none']!;
        const { data } = await h.api({
          method: 'POST',
          path: `${API}/kernels/push`,
          json: compact({
            slug: ref,
            newTitle: args.title,
            text: args.code,
            language: args.language,
            kernelType: args.kernel_type,
            isPrivate: args.private,
            enableGpu: machine.enableGpu,
            enableTpu: machine.enableTpu,
            machineShape: machine.machineShape,
            enableInternet: args.internet,
            datasetDataSources: args.dataset_sources ?? [],
            competitionDataSources: args.competition_sources ?? [],
            kernelDataSources: args.notebook_sources ?? [],
            modelDataSources: args.model_sources ?? [],
            categoryIds: [],
            kernelExecutionType: args.run ? undefined : 'QUICK_SAVE',
            sessionTimeoutSeconds: args.session_timeout_seconds,
          }),
          write: true,
        });
        const failed = answerError(data);
        const version = field(data, 'versionNumber');
        if (failed && version === undefined) throw new ToolFailure(`Kaggle did not save the notebook: ${failed}. Nothing was changed.`);
        return compact({
          saved: true,
          ref: field(data, 'ref') ?? ref,
          url: field(data, 'url'),
          version,
          run: args.run ? 'started: check it with get_notebook_status' : 'not started (saved without running)',
          refused_sources: refused(data),
          warning: failed,
        });
      },
    },
    {
      name: 'get_notebook_status',
      kind: 'read',
      title: 'Get a Kaggle notebook run\'s status',
      description:
        'The status of the notebook\'s latest run: queued, running, complete, error, or cancelled, with Kaggle\'s failure message on error. '
        + 'Runs take minutes to hours: check again later rather than in a loop.',
      inputSchema: {
        type: 'object',
        properties: { notebook: NOTEBOOK_REF },
        required: ['notebook'],
        additionalProperties: false,
      },
      async run(args: { notebook: string }, h) {
        const { owner, slug, ref } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const { data } = await h.api({ path: `${API}/kernels/status`, query: { userName: owner, kernelSlug: slug }, errors: { 404: 'Kaggle found no notebook with that name that this account can see' } });
        const status = typeof data === 'string' ? data : field(data, 'status');
        const message = field(data, 'failureMessage');
        return compact({ ref, status: typeof status === 'string' ? status.toLowerCase() : undefined, failure_message: message ? truncate(String(message), 2000) : undefined });
      },
    },
    {
      name: 'get_notebook_output',
      kind: 'read',
      title: 'Get a Kaggle notebook\'s output and log',
      description:
        'The output files of the notebook\'s latest run (names and signed download links that expire soon) and the last lines of its log. '
        + 'read_notebook_output_file shows a text file\'s contents. Pass nextCursor back as cursor for more files.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook: NOTEBOOK_REF,
          log_lines: { type: 'integer', minimum: 0, maximum: 400, default: 40, description: 'How many log lines to show from the end (default 40).' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Files per page, 1 to 100 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['notebook'],
        additionalProperties: false,
      },
      async run(args: { notebook: string; log_lines: number; page_size: number; cursor?: string }, h) {
        const { owner, slug, ref } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/kernels/output`,
          query: { userName: owner, kernelSlug: slug, pageSize: args.page_size, pageToken: at.token },
          errors: { 404: 'Kaggle found no notebook with that name that this account can see' },
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle refused to list the output: ${failed}.`);
        const files = listOf(data, 'files').map((file: any) => compact({ name: field(file, 'fileName'), url: field(file, 'url') }));
        const log = at.page === 1 && args.log_lines > 0 ? logTail(field(data, 'log'), args.log_lines) : undefined;
        const extra = compact({ ref, log_tail: log?.lines, log_lines_total: log?.total });
        const nextToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
        return h.page({
          key: 'files',
          items: files.slice(at.skip),
          extra,
          resumeAt: (index) => h.makeCursor({ p: at.page, ...(at.token ? { k: at.token } : {}), o: at.skip + index }),
          ...(nextToken ? { nextPage: h.makeCursor({ p: at.page + 1, k: nextToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'read_notebook_output_file',
      kind: 'read',
      title: 'Read a Kaggle notebook output file',
      description:
        'Shows a text output file of the notebook\'s latest run (a CSV of results, a log, a JSON file), in windows of about 24 KB: pass '
        + 'nextCursor back as cursor for the next part. Files up to 8 MB; binary files are not shown.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook: NOTEBOOK_REF,
          file_name: { type: 'string', minLength: 1, maxLength: 500, description: 'The file name as get_notebook_output lists it.' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['notebook', 'file_name'],
        additionalProperties: false,
      },
      async run(args: { notebook: string; file_name: string; cursor?: string }, h) {
        const { owner, slug, ref } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const file = await findOutputFile(h, owner, slug, args.file_name);
        if (!file) throw new ToolFailure(`The latest run of ${ref} has no output file named ${args.file_name}: get_notebook_output lists them.`);
        const { bytes } = await h.media(file.url, { what: 'output file', maxBytes: 8 * 1024 * 1024 });
        const text = textOf(bytes, args.file_name);
        const state = h.cursor(args.cursor);
        const window = textWindow(text, typeof state?.['o'] === 'number' ? state['o'] : 0, TEXT_WINDOW_BYTES);
        return compact({
          ref,
          file_name: args.file_name,
          size_bytes: bytes.length,
          text: window.text,
          offset: window.offset || undefined,
          length: text.length,
          nextCursor: window.next !== undefined ? h.makeCursor({ o: window.next }) : undefined,
        });
      },
    },
    {
      name: 'list_datasets',
      kind: 'read',
      title: 'List Kaggle datasets',
      description:
        'Your own datasets, last updated first by default, with ref, link, size, visibility, downloads, votes, version and usability; or public '
        + 'datasets (scope public, with search) or one user\'s (user). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['mine', 'public'], default: 'mine', description: 'mine (default) or public.' },
          search: { type: 'string', maxLength: 200, description: 'Words to search for (with scope public).' },
          user: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$', description: 'Only this user\'s public datasets.' },
          sort_by: { type: 'string', enum: ['updated', 'hottest', 'votes', 'active', 'published'], default: 'updated', description: 'The order (default updated).' },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Datasets per page, 1 to 100 (default 20).' },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { scope: string; search?: string; user?: string; sort_by: string; page_size: number; cursor?: string }, h) {
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/datasets/list`,
          query: {
            group: args.user ? undefined : args.scope === 'mine' ? 'my' : 'public',
            user: args.user,
            search: args.search,
            sortBy: args.sort_by,
            pageSize: args.page_size,
            page: at.token ? undefined : at.page,
            pageToken: at.token,
          },
        });
        const datasets = listOf(data, 'datasets').map(trimDataset);
        return kagglePage(h, 'datasets', data, datasets, at, Array.isArray(data) ? Math.min(args.page_size, 20) : args.page_size);
      },
    },
    {
      name: 'list_dataset_files',
      kind: 'read',
      title: 'List a Kaggle dataset\'s files',
      description: 'The files of a dataset (its current version, or a given one), with their names, sizes and dates. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          dataset: DATASET_REF,
          version: { type: 'integer', minimum: 1, description: 'A version number (default: the current one).' },
          cursor: CURSOR_SCHEMA,
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      async run(args: { dataset: string; version?: number; cursor?: string }, h) {
        const { owner, slug, ref } = ownerSlug(args.dataset, h.credentials['username'] as string, 'dataset');
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/datasets/list/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
          query: { datasetVersionNumber: args.version, pageSize: 100, pageToken: at.token },
          errors: { 404: 'Kaggle found no dataset with that name that this account can see' },
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle refused to list the files: ${failed}.`);
        const files = listOf(data, 'datasetFiles').map((file: any) => compact({ name: field(file, 'name'), size_bytes: field(file, 'totalBytes'), created: field(file, 'creationDate') }));
        const nextToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
        return h.page({
          key: 'files',
          items: files.slice(at.skip),
          extra: { ref },
          resumeAt: (index) => h.makeCursor({ p: at.page, ...(at.token ? { k: at.token } : {}), o: at.skip + index }),
          ...(nextToken ? { nextPage: h.makeCursor({ p: at.page + 1, k: nextToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_dataset_status',
      kind: 'read',
      title: 'Get a Kaggle dataset\'s status',
      description: 'Whether a dataset (after a create or a new version) is still processing or ready. Large files can take minutes.',
      inputSchema: {
        type: 'object',
        properties: { dataset: DATASET_REF },
        required: ['dataset'],
        additionalProperties: false,
      },
      async run(args: { dataset: string }, h) {
        const { owner, slug, ref } = ownerSlug(args.dataset, h.credentials['username'] as string, 'dataset');
        const { data } = await h.api({
          path: `${API}/datasets/status/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
          errors: { 404: 'Kaggle found no dataset with that name that this account can see' },
        });
        const status = typeof data === 'string' ? data : field(data, 'status');
        return compact({ ref, status: typeof status === 'string' ? status.toLowerCase() : undefined });
      },
    },
    {
      name: 'create_dataset',
      kind: 'create',
      check: 'list_datasets',
      title: 'Create a Kaggle dataset',
      description:
        'Creates a dataset from files given by public https URL or as text: each file is uploaded to the signed address Kaggle hands out, then '
        + 'the dataset is created, private unless asked. A public dataset needs a license the owner chose; anyone can then see and copy it. '
        + 'Check processing with get_dataset_status.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{4,49}$', description: 'The dataset slug, 5 to 50 lowercase letters, digits and dashes; one in use is refused.' },
          title: { type: 'string', minLength: 6, maxLength: 50, description: 'The title, 6 to 50 characters.' },
          subtitle: { type: 'string', minLength: 20, maxLength: 80, description: 'A subtitle, 20 to 80 characters.' },
          description: { type: 'string', maxLength: 20000, description: 'Where the data comes from and what each column means (Markdown).' },
          license: { type: 'string', enum: LICENSES, default: 'unknown', description: 'The license (default unknown, for a private dataset).' },
          private: { type: 'boolean', default: true, description: 'true (default). false makes it public.' },
          owner: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$', description: 'An organization to own it (default: your account).' },
          files: FILES_SCHEMA,
        },
        required: ['slug', 'title', 'files'],
        additionalProperties: false,
      },
      async run(args: { slug: string; title: string; subtitle?: string; description?: string; license: string; private: boolean; owner?: string; files: FileArg[] }, h) {
        if (!args.private && args.license === 'unknown') {
          throw new ToolFailure('A public dataset needs a license the owner chose (license). Nothing was created.');
        }
        const uploaded = await uploadAll(h, args.files, (file, size) => ({
          path: `${API}/blobs/upload`,
          json: { type: 'DATASET', name: file.name, contentLength: size, lastModifiedEpochSeconds: Math.floor(Date.now() / 1000) },
        }));
        const owner = args.owner ?? (h.credentials['username'] as string);
        const { data } = await h.api({
          method: 'POST',
          path: `${API}/datasets/create/new`,
          json: compact({
            ownerSlug: owner,
            slug: args.slug,
            title: args.title,
            subtitle: args.subtitle,
            description: args.description,
            licenseName: args.license,
            isPrivate: args.private,
            files: uploaded.map((item) => compact({ token: item.token, description: item.file.description })),
          }),
          write: true,
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle did not create the dataset: ${failed}. Nothing was created.`);
        return compact({
          created: true,
          ref: field(data, 'ref') ?? `${owner}/${args.slug}`,
          url: field(data, 'url'),
          status: typeof field(data, 'status') === 'string' ? String(field(data, 'status')).toLowerCase() : undefined,
          visibility: args.private ? 'private' : 'public',
          files: uploaded.map((item) => ({ name: item.file.name, size_bytes: item.size })),
          refused_tags: field(data, 'invalidTags')?.length ? field(data, 'invalidTags') : undefined,
        });
      },
    },
    {
      name: 'create_dataset_version',
      kind: 'create',
      check: 'get_dataset_status',
      title: 'Upload a new Kaggle dataset version',
      description:
        'Uploads a new version of a dataset. Kaggle builds the version from the files sent with it, so send every file the dataset should keep. '
        + 'delete_old_versions removes every earlier version for good: only when asked. Check processing with get_dataset_status.',
      inputSchema: {
        type: 'object',
        properties: {
          dataset: DATASET_REF,
          version_notes: { type: 'string', minLength: 1, maxLength: 1000, description: 'What changed in this version.' },
          files: FILES_SCHEMA,
          delete_old_versions: { type: 'boolean', default: false, description: 'true deletes every earlier version for good (default false).' },
        },
        required: ['dataset', 'version_notes', 'files'],
        additionalProperties: false,
      },
      async run(args: { dataset: string; version_notes: string; files: FileArg[]; delete_old_versions: boolean }, h) {
        const { owner, slug, ref } = ownerSlug(args.dataset, h.credentials['username'] as string, 'dataset');
        const uploaded = await uploadAll(h, args.files, (file, size) => ({
          path: `${API}/blobs/upload`,
          json: { type: 'DATASET', name: file.name, contentLength: size, lastModifiedEpochSeconds: Math.floor(Date.now() / 1000) },
        }));
        const { data } = await h.api({
          method: 'POST',
          path: `${API}/datasets/create/version/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
          json: {
            versionNotes: args.version_notes,
            deleteOldVersions: args.delete_old_versions,
            files: uploaded.map((item) => compact({ token: item.token, description: item.file.description })),
          },
          write: true,
          errors: { 404: 'Kaggle found no dataset with that name that this account may change' },
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle did not create the version: ${failed}. Nothing was created.`);
        return compact({
          created: true,
          ref: field(data, 'ref') ?? ref,
          url: field(data, 'url'),
          status: typeof field(data, 'status') === 'string' ? String(field(data, 'status')).toLowerCase() : undefined,
          files: uploaded.map((item) => ({ name: item.file.name, size_bytes: item.size })),
        });
      },
    },
    {
      name: 'list_competitions',
      kind: 'read',
      title: 'List Kaggle competitions',
      description:
        'Competitions matching some words, latest deadline first by default, with category, reward, deadline, teams, whether you entered and '
        + 'whether it takes notebook submissions only. group entered lists the ones you joined. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', maxLength: 200, description: 'Words to search for.' },
          group: { type: 'string', enum: ['general', 'entered', 'inClass'], description: 'entered: only the ones you joined.' },
          category: { type: 'string', enum: ['featured', 'research', 'recruitment', 'gettingStarted', 'masters', 'playground'], description: 'Only this category.' },
          sort_by: {
            type: 'string',
            enum: ['latestDeadline', 'earliestDeadline', 'prize', 'numberOfTeams', 'recentlyCreated', 'grouped', 'best', 'relevance'],
            default: 'latestDeadline',
            description: 'The order (default latestDeadline).',
          },
          cursor: CURSOR_SCHEMA,
        },
        additionalProperties: false,
      },
      async run(args: { search?: string; group?: string; category?: string; sort_by: string; cursor?: string }, h) {
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/competitions/list`,
          query: { search: args.search, group: args.group, category: args.category, sortBy: args.sort_by, page: at.token ? undefined : at.page, pageToken: at.token },
        });
        const competitions = listOf(data, 'competitions').map((item: any) => {
          const ref = String(field(item, 'ref') ?? field(item, 'url') ?? '');
          const slug = ref.replace(/\/+$/, '').split('/').pop() || undefined;
          return compact({
            slug,
            title: field(item, 'title'),
            url: slug ? `https://www.kaggle.com/competitions/${slug}` : undefined,
            category: field(item, 'category'),
            reward: field(item, 'reward'),
            deadline: field(item, 'deadline'),
            teams: field(item, 'teamCount'),
            entered: field(item, 'userHasEntered'),
            notebooks_only: field(item, 'isKernelsSubmissionsOnly'),
            max_daily_submissions: field(item, 'maxDailySubmissions'),
          });
        });
        return kagglePage(h, 'competitions', data, competitions, at, 20);
      },
    },
    {
      name: 'get_leaderboard',
      kind: 'read',
      title: 'Get a Kaggle competition leaderboard',
      description: 'The top of a competition\'s public leaderboard: rank, team, score and submission date.',
      inputSchema: {
        type: 'object',
        properties: {
          competition: COMPETITION,
          top: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'How many rows, 1 to 200 (default 20).' },
        },
        required: ['competition'],
        additionalProperties: false,
      },
      async run(args: { competition: string; top: number }, h) {
        const slug = competitionSlug(args.competition);
        const { data } = await h.api({ path: `${API}/competitions/${encodeURIComponent(slug)}/leaderboard/view`, errors: { 404: 'Kaggle found no competition with that slug' } });
        const rows = listOf(data, 'submissions');
        return {
          competition: slug,
          rows: rows.slice(0, args.top).map((row: any, index: number) => compact({ rank: index + 1, team: field(row, 'teamName'), score: field(row, 'score'), submitted: field(row, 'submissionDate') })),
          total_on_page: rows.length,
        };
      },
    },
    {
      name: 'list_submissions',
      kind: 'read',
      title: 'List my Kaggle competition submissions',
      description: 'Your submissions to a competition, newest first, with file, date, status, public and private scores and description. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { competition: COMPETITION, cursor: CURSOR_SCHEMA },
        required: ['competition'],
        additionalProperties: false,
      },
      async run(args: { competition: string; cursor?: string }, h) {
        const slug = competitionSlug(args.competition);
        const at = cursorPage(h, args.cursor);
        const { data } = await h.api({
          path: `${API}/competitions/submissions/list/${encodeURIComponent(slug)}`,
          query: { page: at.token ? undefined : at.page, pageToken: at.token },
          errors: { 404: 'Kaggle found no competition with that slug' },
        });
        const submissions = listOf(data, 'submissions').map((item: any) => compact({
          ref: field(item, 'ref'),
          file: field(item, 'fileName'),
          date: field(item, 'date'),
          status: typeof field(item, 'status') === 'string' ? String(field(item, 'status')).toLowerCase() : undefined,
          public_score: field(item, 'publicScore'),
          private_score: field(item, 'privateScore'),
          description: field(item, 'description'),
          error: field(item, 'errorDescription'),
        }));
        return kagglePage(h, 'submissions', data, submissions, at, 20, { competition: slug });
      },
    },
    {
      name: 'submit_to_competition',
      kind: 'create',
      check: 'list_submissions',
      title: 'Submit a file to a Kaggle competition',
      description:
        'Sends a submission file (from a public https URL or as text) to a competition: Kaggle hands out an upload address, the file goes '
        + 'there, then the submission is made. It uses one of the day\'s submissions. You must have joined the competition and accepted its '
        + 'rules on kaggle.com first; the API cannot. Read the score later with list_submissions.',
      inputSchema: {
        type: 'object',
        properties: {
          competition: COMPETITION,
          file: FILE_SCHEMA,
          description: { type: 'string', minLength: 1, maxLength: 1000, description: 'What this submission is, e.g. "Gradient boosting, 5 folds".' },
        },
        required: ['competition', 'file', 'description'],
        additionalProperties: false,
      },
      async run(args: { competition: string; file: FileArg; description: string }, h) {
        const slug = competitionSlug(args.competition);
        const [uploaded] = await uploadAll(h, [args.file], (file, size) => ({
          path: `${API}/competitions/submission-url`,
          json: { competitionName: slug, fileName: file.name, contentLength: size, lastModifiedEpochSeconds: Math.floor(Date.now() / 1000) },
        }));
        const { data } = await h.api({
          method: 'POST',
          path: `${API}/competitions/submissions/submit/${encodeURIComponent(slug)}`,
          json: { blobFileTokens: uploaded!.token, submissionDescription: args.description },
          write: true,
          errors: { 403: 'Kaggle refused the submission: join the competition and accept its rules on kaggle.com first' },
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle did not take the submission: ${failed}. Nothing was submitted.`);
        return compact({ submitted: true, competition: slug, ref: field(data, 'ref'), message: field(data, 'message') });
      },
    },
    {
      name: 'submit_notebook_to_competition',
      kind: 'create',
      check: 'list_submissions',
      title: 'Submit a notebook version to a Kaggle competition',
      description:
        'For a code competition: submits a version of one of your notebooks and the output file it writes. It uses one of the day\'s '
        + 'submissions; you must have joined the competition and accepted its rules on kaggle.com first.',
      inputSchema: {
        type: 'object',
        properties: {
          competition: COMPETITION,
          notebook: NOTEBOOK_REF,
          version: { type: 'integer', minimum: 1, description: 'The notebook version to submit.' },
          file_name: { type: 'string', minLength: 1, maxLength: 255, description: 'The output file to score, e.g. submission.csv.' },
          description: { type: 'string', minLength: 1, maxLength: 1000, description: 'What this submission is.' },
        },
        required: ['competition', 'notebook', 'version', 'file_name', 'description'],
        additionalProperties: false,
      },
      async run(args: { competition: string; notebook: string; version: number; file_name: string; description: string }, h) {
        const slug = competitionSlug(args.competition);
        const { owner, slug: kernel } = ownerSlug(args.notebook, h.credentials['username'] as string, 'notebook');
        const { data } = await h.api({
          method: 'POST',
          path: `${API}/competitions/submissions/submit-notebook/${encodeURIComponent(slug)}`,
          json: { kernelOwner: owner, kernelSlug: kernel, kernelVersion: args.version, fileName: args.file_name, submissionDescription: args.description },
          write: true,
          errors: { 403: 'Kaggle refused the submission: join the competition and accept its rules on kaggle.com first' },
        });
        const failed = answerError(data);
        if (failed) throw new ToolFailure(`Kaggle did not take the submission: ${failed}. Nothing was submitted.`);
        return compact({ submitted: true, competition: slug, ref: field(data, 'ref'), message: field(data, 'message') });
      },
    },
    // The rest of the Kaggle API v1: models, dataset metadata, kernel sessions, competition data files.
    ...apiTools({
      label: 'Kaggle',
      description:
        'The Kaggle API v1 at https://www.kaggle.com/api/v1, with the connected token: paths start with /api/v1/, such as '
        + '/api/v1/datasets/metadata/{owner}/{slug}, /api/v1/competitions/data/list/{slug} or /api/v1/models/list. Deleting notebooks, datasets '
        + 'or models is not offered here. Reference: https://www.kaggle.com/docs/api.',
      basePath: '/api/v1/',
      guard(request) {
        if (request.method !== 'GET' && request.segments.some((segment) => segment === 'delete')) {
          throw new ToolFailure('Deleting on Kaggle is not offered here: delete it on kaggle.com itself. Nothing was sent.');
        }
      },
    }),
  ],
});

export = connector;
