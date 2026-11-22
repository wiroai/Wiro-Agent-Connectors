// Google Drive, with Google Sheets and Google Docs, through the Drive API v3,
// the Sheets API v4 and the Docs API v1, as a service account.
//
// Credential: `serviceaccountjson`, a service account key, the JSON file
// Google Cloud creates under IAM and admin -> Service accounts -> Keys (its
// base64 text works too). It signs a short-lived token (RS256) for the drive,
// spreadsheets and documents scopes; the key never leaves the call.
//
// The service account sees only what is shared with its email: folders shared
// with it (Editor, or Content manager in a shared drive) and shared drives it
// is a member of. A host can limit the connection to chosen folders (the
// `folders` account picker): the tools then reach those folders, their
// subfolders and the files in them, and nothing else.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  ToolFailure,
  truncate,
  utf8Bytes,
  type ApiRequest,
  type ApiResponse,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  checkRows,
  compact,
  FOLDER_TYPE,
  GOOGLE_TYPES,
  isTextType,
  kindOf,
  multipartBody,
  queryLiteral,
  textPage,
  toCsv,
  trimFile,
  typeByName,
  uploadType,
  type Cell,
} from './files.js';
import { googleApi, KEY_CREDENTIAL, serviceAccountWords } from './service-account.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Google Drive';
const DRIVE_ORIGIN = 'https://www.googleapis.com';
const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
const DOCS_ORIGIN = 'https://docs.googleapis.com';
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
];
const PICKER = 'folders';
/** Drive takes up to 5 MB in one request with metadata; larger files go through a resumable upload. */
const SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PARENT_LOOKUPS = 20;
const FILE_FIELDS = 'id,name,mimeType,size,parents,driveId,createdTime,modifiedTime,webViewLink,webContentLink';
const LIST_FIELDS = 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,shortcutDetails/targetId)';
const ID_PATTERN = '^[A-Za-z0-9_-]{1,200}$';

const ID: JsonSchema = { type: 'string', pattern: ID_PATTERN, description: 'A Drive file or folder id (the part after /d/ or /folders/ in its link).' };

function enc(id: string): string {
  return encodeURIComponent(id);
}

function drive(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  const who = serviceAccountWords(h);
  return googleApi(h, SCOPES, {
    ...request,
    errors: {
      403: `Google Drive refused the request: share the file or folder with ${who} (Editor, or Content manager in a shared drive) and check that the API is enabled for the key's project`,
      404: `Google Drive found no such file, or it is not shared with ${who}`,
      ...request.errors,
    },
  });
}

/** The folders a host chose for the connection, or null when it applies no lock. */
function chosenFolders(h: ToolHelpers): string[] | null {
  return allowedAccounts(h.ctx.accounts, PICKER);
}

/**
 * Refuses an item outside the chosen folders: it must be one of them, sit in a
 * shared drive chosen as a folder, or have one of them among its ancestors.
 * `data` is the item's own metadata with parents and driveId.
 */
async function checkInside(h: ToolHelpers, allowed: string[], id: string, data: any, what: string): Promise<void> {
  if (!allowed.length) throw new ToolFailure(`No folder is chosen for this ${LABEL} connection yet, so it can reach no file. Nothing was changed.`);
  if (allowed.includes(id)) return;
  const refuse = (): never => {
    throw new ToolFailure(`The ${what} ${id} is not inside the folders chosen for this connection (${allowed.join(', ')}). Nothing was changed.`);
  };
  const seen = new Set<string>([id]);
  let item = data;
  const frontier: string[] = [];
  let lookups = 0;
  for (;;) {
    if (typeof item?.driveId === 'string' && allowed.includes(item.driveId)) return;
    for (const parent of Array.isArray(item?.parents) ? item.parents : []) {
      if (typeof parent !== 'string' || seen.has(parent)) continue;
      if (allowed.includes(parent)) return;
      seen.add(parent);
      frontier.push(parent);
    }
    const next = frontier.shift();
    if (next === undefined || lookups >= MAX_PARENT_LOOKUPS) refuse();
    lookups++;
    try {
      item = (await drive(h, { path: `/drive/v3/files/${enc(next as string)}`, query: { fields: 'id,parents,driveId', supportsAllDrives: true } })).data;
    } catch (error) {
      // A parent the service account cannot see is outside every folder shared with it.
      if (error instanceof ToolFailure && (error.details.status === 403 || error.details.status === 404)) refuse();
      throw error;
    }
  }
}

/** An item's metadata (fields), after checking that it is inside the chosen folders. */
async function getChecked(h: ToolHelpers, id: string, fields: string, what = 'file'): Promise<any> {
  const allowed = chosenFolders(h);
  if (allowed !== null && !allowed.length) throw new ToolFailure(`No folder is chosen for this ${LABEL} connection yet, so it can reach no file. Nothing was changed.`);
  const missing = ['parents', 'driveId'].filter((name) => !new RegExp(`(^|,)${name}(,|$)`).test(fields));
  const wanted = allowed === null || !missing.length ? fields : `${fields},${missing.join(',')}`;
  const { data } = await drive(h, { path: `/drive/v3/files/${enc(id)}`, query: { fields: wanted, supportsAllDrives: true } });
  if (allowed !== null) await checkInside(h, allowed, id, data, what);
  return data;
}

async function assertInside(h: ToolHelpers, id: string, what = 'file'): Promise<void> {
  const allowed = chosenFolders(h);
  // A chosen folder itself needs no lookup.
  if (allowed !== null && !allowed.includes(id)) await getChecked(h, id, 'id', what);
}

/** The folder a new file goes in: required, and checked, when the connection is limited to chosen folders. */
async function targetFolder(h: ToolHelpers, folderId: string | undefined): Promise<string[] | undefined> {
  if (folderId === undefined) {
    const allowed = chosenFolders(h);
    if (allowed !== null) {
      throw new ToolFailure(`folder_id is required: this connection may only add files to its chosen folders${allowed.length ? ` (${allowed.join(', ')})` : ''}. Nothing was changed.`);
    }
    return undefined;
  }
  await assertInside(h, folderId, 'folder');
  return [folderId];
}

interface Source {
  url?: string;
  content?: string;
}

/** The bytes to upload: a public https file, or text given in the call. */
async function sourceBytes(h: ToolHelpers, source: Source): Promise<{ bytes: Uint8Array; served: string | null }> {
  if ((source.url === undefined) === (source.content === undefined)) {
    throw new ToolFailure('Give url (a public https file) or content (text), one of the two. Nothing was changed.');
  }
  if (source.url !== undefined) {
    const { bytes, contentType } = await h.media(source.url, { what: 'file', maxBytes: MAX_UPLOAD_BYTES });
    return { bytes, served: contentType };
  }
  return { bytes: utf8Bytes(source.content as string), served: null };
}

/** The resumable session address Drive returned, checked to be Drive's own upload endpoint. */
function sessionAddress(location: string | null): URL {
  let url: URL | undefined;
  try {
    url = location ? new URL(location) : undefined;
  } catch {
    // refused below
  }
  if (!url || url.origin !== DRIVE_ORIGIN || !url.pathname.startsWith('/upload/drive/v3/files')) {
    throw new ToolFailure('Google Drive started the upload but sent no usable upload address. Nothing was changed.');
  }
  return url;
}

/**
 * Sends file bytes: with metadata in one multipart request (up to 5 MB), as
 * bare media (an update without metadata, up to 5 MB), or as a resumable
 * upload: a session first, then the whole file in one PUT. Only the request
 * that carries the file can make the change; it is sent once.
 */
async function sendFile(h: ToolHelpers, options: { fileId?: string; metadata?: Record<string, unknown>; bytes: Uint8Array; mimeType: string }): Promise<any> {
  const method = options.fileId ? 'PATCH' : 'POST';
  const path = options.fileId ? `/upload/drive/v3/files/${enc(options.fileId)}` : '/upload/drive/v3/files';
  if (options.bytes.length <= SIMPLE_UPLOAD_MAX) {
    if (options.metadata) {
      const { body, contentType } = multipartBody(options.metadata, options.bytes, options.mimeType);
      return (await drive(h, { method, path, query: { uploadType: 'multipart', supportsAllDrives: true, fields: FILE_FIELDS }, body, contentType, write: true })).data;
    }
    return (await drive(h, { method, path, query: { uploadType: 'media', supportsAllDrives: true, fields: FILE_FIELDS }, body: options.bytes, contentType: options.mimeType, write: true })).data;
  }
  const started = await drive(h, {
    method,
    path,
    query: { uploadType: 'resumable', supportsAllDrives: true, fields: FILE_FIELDS },
    json: options.metadata ?? {},
    headers: { 'x-upload-content-type': options.mimeType, 'x-upload-content-length': String(options.bytes.length) },
  });
  const session = sessionAddress(started.headers.get('location'));
  const query = Object.fromEntries(session.searchParams);
  return (await drive(h, {
    method: 'PUT',
    path: session.pathname,
    query: { ...query, fields: query['fields'] ?? FILE_FIELDS },
    body: options.bytes,
    contentType: options.mimeType,
    write: true,
  })).data;
}

/** A metadata-only create (an empty Google Doc or Sheet, a folder). */
async function createMetadata(h: ToolHelpers, metadata: Record<string, unknown>): Promise<any> {
  return (await drive(h, { method: 'POST', path: '/drive/v3/files', query: { supportsAllDrives: true, fields: FILE_FIELDS }, json: metadata, write: true })).data;
}

/** A list of Drive files, one vendor page, as h.page wants it. */
async function listPage(h: ToolHelpers, query: Record<string, string | number | boolean | undefined>, cursor: string | undefined, key: string, trim: (file: any) => Record<string, unknown>, extra?: Record<string, unknown>) {
  const state = h.cursor(cursor);
  const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const { data } = await drive(h, { path: '/drive/v3/files', query: { ...query, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true } });
  const files: any[] = Array.isArray(data?.files) ? data.files : [];
  return h.page({
    key,
    items: files.map(trim).slice(skip),
    extra: compact({ ...extra, incompleteSearch: data?.incompleteSearch === true ? true : undefined }),
    resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
    ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
  });
}

function trimFolder(folder: any): Record<string, unknown> {
  const owners: any[] = Array.isArray(folder?.owners) ? folder.owners : [];
  return compact({
    id: folder?.id,
    name: folder?.name,
    type: 'folder',
    owner: owners[0]?.displayName || owners[0]?.emailAddress,
    modifiedTime: folder?.modifiedTime,
  });
}

/** The chosen folders themselves (a host's lock), with their names. */
async function chosenFolderList(h: ToolHelpers, allowed: string[], cursor: string | undefined) {
  const state = h.cursor(cursor);
  const offset = typeof state?.['c'] === 'number' ? state['c'] : 0;
  const ids = allowed.slice(offset, offset + 25);
  const items: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const { data } = await drive(h, { path: `/drive/v3/files/${enc(id)}`, query: { fields: 'id,name,mimeType,driveId,modifiedTime', supportsAllDrives: true } });
      if (data?.driveId === id) {
        const shared = await drive(h, { path: `/drive/v3/drives/${enc(id)}`, query: { fields: 'id,name' } }).catch(() => null);
        items.push(compact({ id, name: shared?.data?.name ?? data?.name, type: 'shared_drive' }));
      } else {
        items.push({ ...trimFolder(data), id });
      }
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
      items.push({ id, name: id, type: 'folder', error: truncate(error.message, 300) });
    }
  }
  return h.page({
    key: 'folders',
    items,
    extra: { chosen: true },
    resumeAt: (index) => h.makeCursor({ c: offset + index }),
    ...(offset + ids.length < allowed.length ? { nextPage: h.makeCursor({ c: offset + ids.length }) } : {}),
  });
}

/** Folders shared with the service account, then the shared drives it is a member of. */
async function sharedFolderList(h: ToolHelpers, cursor: string | undefined) {
  const state = h.cursor(cursor);
  const phase = state?.['ph'] === 'd' ? 'd' : 'f';
  const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const items: Record<string, unknown>[] = [];
  let nextPage: string | undefined;
  let drivesToken = phase === 'd' ? pageToken : undefined;
  let listDrives = phase === 'd';
  if (phase === 'f') {
    const { data } = await drive(h, {
      path: '/drive/v3/files',
      query: {
        q: `mimeType='${FOLDER_TYPE}' and trashed=false and sharedWithMe`,
        fields: 'nextPageToken,files(id,name,modifiedTime,owners(displayName,emailAddress))',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
    for (const folder of Array.isArray(data?.files) ? data.files : []) items.push(trimFolder(folder));
    if (typeof data?.nextPageToken === 'string' && data.nextPageToken) nextPage = h.makeCursor({ ph: 'f', p: data.nextPageToken, o: 0 });
    else listDrives = true;
  }
  if (listDrives) {
    const { data } = await drive(h, { path: '/drive/v3/drives', query: { pageSize: 100, pageToken: drivesToken, fields: 'nextPageToken,drives(id,name)' } });
    for (const shared of Array.isArray(data?.drives) ? data.drives : []) items.push(compact({ id: shared?.id, name: shared?.name, type: 'shared_drive' }));
    drivesToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
    if (drivesToken) nextPage = h.makeCursor({ ph: 'd', p: drivesToken, o: 0 });
  }
  return h.page({
    key: 'folders',
    items: items.slice(skip),
    resumeAt: (index) => h.makeCursor({ ph: phase, ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
    ...(nextPage ? { nextPage } : {}),
  });
}

const EXPORTS: Record<string, Record<string, string>> = {
  [GOOGLE_TYPES.document]: { markdown: 'text/markdown', text: 'text/plain', html: 'text/html' },
  [GOOGLE_TYPES.spreadsheet]: { csv: 'text/csv', tsv: 'text/tab-separated-values' },
  [GOOGLE_TYPES.presentation]: { text: 'text/plain' },
};

const CELL_ROWS: JsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10000,
  items: { type: 'array', maxItems: 1000 },
  description: 'Rows of cells, e.g. [["2026-05-11", "Jane", 42], ["2026-05-12", "John", 17]]: text, numbers, true/false or null.',
};

const VALUE_INPUT: JsonSchema = {
  type: 'string',
  enum: ['USER_ENTERED', 'RAW'],
  default: 'USER_ENTERED',
  description: 'USER_ENTERED (default) reads values as if typed in (formulas, dates, numbers); RAW stores them as given.',
};

const RANGE: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 500,
  description: 'A range in A1 notation, e.g. Sheet1!A1:D50, Sheet1!A:A or Sheet1 (a sheet name with spaces in quotes: \'My sheet\'!A1).',
};

function valuesPath(spreadsheetId: string, range: string, suffix = ''): string {
  return `/v4/spreadsheets/${enc(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

/** The id inside a Sheets or Docs path segment such as "abc:batchUpdate". */
function idOfSegment(segment: string | undefined): string | undefined {
  const id = segment?.split(':')[0];
  return id ? id : undefined;
}

/**
 * The generic tools keep to the Drive, Sheets and Docs APIs, and, while a host
 * limits the connection to chosen folders, to items inside them.
 */
async function driveGuard(request: ApiToolRequest, h: ToolHelpers): Promise<void> {
  const refuse = (sentence: string): never => {
    throw new ToolFailure(`${sentence} Nothing was sent.`);
  };
  const [first, second, third, fourth] = request.segments;
  let area: 'drive' | 'upload' | 'sheets' | 'docs';
  if (request.origin === DRIVE_ORIGIN && first === 'drive' && second === 'v3') area = 'drive';
  else if (request.origin === DRIVE_ORIGIN && first === 'upload' && second === 'drive' && third === 'v3') area = 'upload';
  else if (request.origin === SHEETS_ORIGIN && first === 'v4' && second === 'spreadsheets') area = 'sheets';
  else if (request.origin === DOCS_ORIGIN && first === 'v1' && second === 'documents') area = 'docs';
  else {
    return refuse('Paths start with /drive/v3/ (or /upload/drive/v3/) on https://www.googleapis.com, /v4/spreadsheets on https://sheets.googleapis.com, or /v1/documents on https://docs.googleapis.com.');
  }
  if (area === 'upload' && request.method === 'GET') refuse('Upload paths take POST, PUT or PATCH.');
  const allowed = chosenFolders(h);
  if (allowed === null) return;

  const lockNote = 'This connection is limited to its chosen folders:';
  if (area === 'sheets' || area === 'docs') {
    const id = idOfSegment(third);
    if (!id) return refuse(`${lockNote} create spreadsheets and documents with create_spreadsheet and create_document, in a chosen folder.`);
    await assertInside(h, id);
    return;
  }
  const collection = area === 'upload' ? fourth : third;
  const fileId = area === 'upload' ? request.segments[4] : fourth;
  if (collection === 'about' && request.method === 'GET') return;
  if (collection !== 'files') return refuse(`${lockNote} only files paths (/drive/v3/files/...) and about are reachable.`);
  if (area === 'upload') {
    if (!fileId) return refuse(`${lockNote} upload new files with upload_file.`);
    await assertInside(h, fileId);
    return;
  }
  if (fileId === 'generateIds' && request.method === 'GET') return;
  if (!fileId || fileId === 'trash') {
    if (request.method === 'POST' && !fileId) {
      const parents = Array.isArray(request.json?.['parents']) ? (request.json?.['parents'] as unknown[]) : [];
      if (!parents.length || !parents.every((parent) => typeof parent === 'string')) refuse(`${lockNote} a new file needs parents naming a chosen folder.`);
      for (const parent of parents as string[]) await assertInside(h, parent, 'folder');
      return;
    }
    return refuse(`${lockNote} list files with list_files.`);
  }
  await assertInside(h, fileId);
  const moved = [...(request.query['addParents'] ?? []).flatMap((value) => value.split(',')), ...(Array.isArray(request.json?.['parents']) ? (request.json?.['parents'] as unknown[]) : [])];
  for (const parent of moved) {
    if (typeof parent !== 'string' || !parent) refuse(`${lockNote} parents must be folder ids.`);
    await assertInside(h, parent as string, 'folder');
  }
}

const connector = defineConnector({
  vendor: 'google-drive',
  label: LABEL,
  origins: [DRIVE_ORIGIN, SHEETS_ORIGIN, DOCS_ORIGIN, TOKEN_ORIGIN],
  credentials: [KEY_CREDENTIAL],
  credentialLabels: { serviceaccountjson: 'Google Drive service account key' },
  accountPickers: [
    {
      key: PICKER,
      label: 'Google Drive folders',
      description: 'The folders the agent may read and write, with their subfolders. Share each one with the service account first.',
      multiple: true,
      tool: 'list_folders',
      idField: 'id',
      nameField: 'name',
      legacyField: 'folders',
    },
  ],
  tools: [
    {
      name: 'list_folders',
      kind: 'read',
      title: 'List Google Drive folders',
      description:
        'Lists folders: without parent_id, the folders chosen for this connection, or, with no choice made, the folders shared with the '
        + 'service account and the shared drives it is a member of; with parent_id, the subfolders of that folder. Each has its id and name. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { ...ID, description: 'List the subfolders of this folder.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { parent_id?: string; cursor?: string }, h) {
        if (args.parent_id !== undefined) {
          await assertInside(h, args.parent_id, 'folder');
          return listPage(h, {
            q: `mimeType='${FOLDER_TYPE}' and trashed=false and ${queryLiteral(args.parent_id)} in parents`,
            fields: 'nextPageToken,files(id,name,modifiedTime,owners(displayName,emailAddress))',
            pageSize: 100,
            orderBy: 'name',
          }, args.cursor, 'folders', trimFolder, { parentId: args.parent_id });
        }
        const allowed = chosenFolders(h);
        return allowed === null ? sharedFolderList(h, args.cursor) : chosenFolderList(h, allowed, args.cursor);
      },
    },
    {
      name: 'list_files',
      kind: 'read',
      title: 'List Google Drive files',
      description:
        'Lists the files in a folder (or, without folder_id, in the chosen folders, or everything the service account can see), newest change '
        + 'first: id, name, kind (folder, document, spreadsheet, presentation or file), type, size, times and link. Filter by name, text, type '
        + 'or change time. Subfolders are listed too; list one with its id for its files. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { ...ID, description: 'The folder to list.' },
          name_contains: { type: 'string', maxLength: 200, description: 'Only names containing this text.' },
          full_text: { type: 'string', maxLength: 200, description: 'Only files whose name or content contains this text.' },
          mime_type: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9.+-]+/([A-Za-z0-9.+-]+|\\*)$', description: 'Only this type, e.g. image/png, or a family such as image/* or video/*.' },
          modified_after: { type: 'string', maxLength: 40, description: 'Only files changed after this time (RFC 3339), e.g. 2026-05-01T00:00:00Z.' },
          include_folders: { type: 'boolean', default: true, description: 'List subfolders too (default true).' },
          order_by: { type: 'string', enum: ['modifiedTime desc', 'createdTime desc', 'name', 'folder,name'], default: 'modifiedTime desc', description: 'Order (default newest change first).' },
          query: { type: 'string', maxLength: 1000, description: 'A raw Drive search query, e.g. "starred = true"; not available while the connection is limited to chosen folders.' },
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Files per page, 1 to 1000 (default 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: {
        folder_id?: string; name_contains?: string; full_text?: string; mime_type?: string; modified_after?: string;
        include_folders: boolean; order_by: string; query?: string; page_size: number; cursor?: string;
      }, h) {
        const allowed = chosenFolders(h);
        const clauses = ['trashed=false'];
        if (args.folder_id !== undefined) {
          await assertInside(h, args.folder_id, 'folder');
          clauses.push(`${queryLiteral(args.folder_id)} in parents`);
        } else if (allowed !== null) {
          if (!allowed.length) throw new ToolFailure(`No folder is chosen for this ${LABEL} connection yet, so it can list no file.`);
          clauses.push(`(${allowed.map((id) => `${queryLiteral(id)} in parents`).join(' or ')})`);
        }
        if (args.name_contains) clauses.push(`name contains ${queryLiteral(args.name_contains)}`);
        if (args.full_text) clauses.push(`fullText contains ${queryLiteral(args.full_text)}`);
        if (args.mime_type) {
          clauses.push(args.mime_type.endsWith('/*')
            ? `mimeType contains ${queryLiteral(args.mime_type.slice(0, -1))}`
            : `mimeType = ${queryLiteral(args.mime_type)}`);
        }
        if (!args.include_folders) clauses.push(`mimeType != '${FOLDER_TYPE}'`);
        if (args.modified_after !== undefined) {
          const time = Date.parse(args.modified_after);
          if (!Number.isFinite(time)) throw new ToolFailure('modified_after is not a time such as 2026-05-01T00:00:00Z.');
          clauses.push(`modifiedTime > '${new Date(time).toISOString()}'`);
        }
        if (args.query !== undefined) {
          if (allowed !== null) throw new ToolFailure('query is not available while this connection is limited to its chosen folders: use the other filters.');
          clauses.push(`(${args.query})`);
        }
        return listPage(h, {
          q: clauses.join(' and '),
          fields: LIST_FIELDS,
          pageSize: args.page_size,
          orderBy: args.order_by,
        }, args.cursor, 'files', trimFile, compact({ folderId: args.folder_id }));
      },
    },
    {
      name: 'get_file',
      kind: 'read',
      title: 'Get a Google Drive file',
      description:
        'Returns a file\'s details: name, kind, type, size, folder, owner, times, description, links (webViewLink to open it; webContentLink '
        + 'to download it once it is shared publicly), the formats a Google Doc, Sheet or Slides file exports to, and who it is shared with.',
      inputSchema: { type: 'object', properties: { file_id: ID }, required: ['file_id'], additionalProperties: false },
      async run(args: { file_id: string }, h) {
        const data = await getChecked(h, args.file_id, [
          'id,name,mimeType,size,parents,driveId,description,starred,trashed,createdTime,modifiedTime,webViewLink,webContentLink,md5Checksum',
          'owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shortcutDetails(targetId,targetMimeType),exportLinks',
          'permissions(id,type,role,emailAddress,domain),capabilities(canEdit,canShare)',
        ].join(','));
        const permissions: any[] = Array.isArray(data?.permissions) ? data.permissions : [];
        return compact({
          ...trimFile(data),
          md5Checksum: data?.md5Checksum,
          exportFormats: data?.exportLinks && typeof data.exportLinks === 'object' ? Object.keys(data.exportLinks) : undefined,
          sharedWith: permissions.length
            ? permissions.slice(0, 30).map((permission) => compact({ id: permission?.id, type: permission?.type, role: permission?.role, email: permission?.emailAddress, domain: permission?.domain }))
            : undefined,
          canEdit: data?.capabilities?.canEdit,
          canShare: data?.capabilities?.canShare,
        });
      },
    },
    {
      name: 'read_file',
      kind: 'read',
      title: 'Read a Google Drive file as text',
      description:
        'Returns the text of a file, in pages of about 25 KB: a Google Doc as Markdown (or plain text or HTML), a Google Sheet\'s first sheet '
        + 'as CSV (read_sheet reads any sheet and range), a Slides file as plain text, and text files (TXT, CSV, JSON, HTML, XML and similar) '
        + 'as they are, up to 4 MB. A binary file (an image, a video, a PDF) is not read: its details and links come back instead. '
        + 'Pass nextCursor back as cursor for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          format: { type: 'string', enum: ['markdown', 'text', 'html', 'csv', 'tsv'], description: 'For a Google Doc: markdown (default), text or html. For a Google Sheet: csv (default) or tsv.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      async run(args: { file_id: string; format?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const file = await getChecked(h, args.file_id, 'id,name,mimeType,size,webViewLink,webContentLink');
        const mimeType = typeof file?.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
        const kind = kindOf(mimeType);
        let request: ApiRequest;
        let format: string | undefined;
        const exports = EXPORTS[mimeType];
        if (exports) {
          const name = args.format ?? Object.keys(exports)[0] as string;
          format = exports[name];
          if (!format) throw new ToolFailure(`A ${kind} reads as ${Object.keys(exports).join(' or ')}, not ${name}.`);
          request = { path: `/drive/v3/files/${enc(args.file_id)}/export`, query: { mimeType: format }, maxBytes: MAX_TEXT_BYTES };
        } else if (kind !== 'file') {
          throw new ToolFailure(
            kind === 'folder'
              ? 'That is a folder: list its files with list_files.'
              : kind === 'shortcut'
                ? 'That is a shortcut: read its target, whose id get_file returns as shortcutTarget.'
                : `A Google ${kind} file has no text to read.`,
          );
        } else if (isTextType(mimeType)) {
          if (Number(file?.size) > MAX_TEXT_BYTES) throw new ToolFailure(`The file has ${Number(file.size)} bytes; read_file reads text files up to ${MAX_TEXT_BYTES} bytes.`);
          request = { path: `/drive/v3/files/${enc(args.file_id)}`, query: { alt: 'media', supportsAllDrives: true }, maxBytes: MAX_TEXT_BYTES, headers: { accept: '*/*' } };
        } else {
          return compact({
            ...trimFile(file),
            binary: true,
            note: 'This is a binary file, so it is not returned as text. Open it with webViewLink; for another tool to download it, share it '
              + 'publicly (share_file, type anyone, role reader): webContentLink then downloads it.',
          });
        }
        const { data } = await drive(h, request);
        const text = typeof data === 'string' ? data : data === null || data === undefined ? '' : JSON.stringify(data, null, 2);
        if (offset > text.length) throw new ToolFailure('The cursor points past the end of the file: the file changed. Start again without cursor.');
        const page = textPage(text, offset);
        return compact({
          id: file?.id,
          name: file?.name,
          mimeType,
          format,
          characters: text.length,
          offset: offset || undefined,
          text: page.piece,
          nextCursor: page.next !== undefined ? h.makeCursor({ o: page.next }) : undefined,
        });
      },
    },
    {
      name: 'upload_file',
      kind: 'create',
      check: 'list_files',
      title: 'Upload a file to Google Drive',
      description:
        'Uploads a file into a folder: from a public https URL (images, videos, PDFs and any other file, up to 50 MB) or from text given here '
        + '(CSV, Markdown, JSON, HTML or plain text). The type comes from the file itself unless mime_type says otherwise; convert_to turns '
        + 'it into a Google Doc, Sheet or Slides file. Returns the new file with its id and link. A service account owns no storage of its '
        + 'own: upload into a shared drive, or Google may answer storageQuotaExceeded.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 500, description: 'The file name, e.g. banner-1080x1080.jpg.' },
          folder_id: { ...ID, description: 'The folder to put it in (required when the connection is limited to chosen folders).' },
          url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of the file.' },
          content: { type: 'string', maxLength: 1000000, description: 'The file\'s text, instead of url.' },
          mime_type: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$', description: 'The file type, e.g. text/csv. Default: from the file.' },
          description: { type: 'string', maxLength: 2000, description: 'A description shown in Drive.' },
          convert_to: { type: 'string', enum: ['document', 'spreadsheet', 'presentation'], description: 'Convert into a Google Doc (from text, Markdown, HTML or a .docx file), Sheet (from CSV or a .xlsx file) or Slides file (from a .pptx file).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: Source & { name: string; folder_id?: string; mime_type?: string; description?: string; convert_to?: keyof typeof GOOGLE_TYPES }, h) {
        const parents = await targetFolder(h, args.folder_id);
        const { bytes, served } = await sourceBytes(h, args);
        const mimeType = args.content !== undefined && !args.mime_type ? typeByName(args.name) ?? 'text/plain' : uploadType(bytes, args.name, args.mime_type, served);
        const metadata = compact({ name: args.name, parents, description: args.description, mimeType: args.convert_to ? GOOGLE_TYPES[args.convert_to] : undefined });
        return trimFile(await sendFile(h, { metadata, bytes, mimeType }));
      },
    },
    {
      name: 'create_document',
      kind: 'create',
      check: 'list_files',
      title: 'Create a Google Doc',
      description:
        'Creates a Google Doc in a folder, empty or with text: Markdown (default; headings, lists, links and tables become formatting), plain '
        + 'text or HTML. Returns its id and link. add_document_text adds more text later.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 500, description: 'The document title.' },
          folder_id: { ...ID, description: 'The folder to put it in (required when the connection is limited to chosen folders).' },
          text: { type: 'string', maxLength: 1000000, description: 'The document\'s content.' },
          format: { type: 'string', enum: ['markdown', 'text', 'html'], default: 'markdown', description: 'How text is written: markdown (default), text or html.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string; folder_id?: string; text?: string; format: 'markdown' | 'text' | 'html' }, h) {
        const parents = await targetFolder(h, args.folder_id);
        const metadata = compact({ name: args.name, parents, mimeType: GOOGLE_TYPES.document });
        if (args.text === undefined || args.text === '') return trimFile(await createMetadata(h, metadata));
        const mimeType = { markdown: 'text/markdown', text: 'text/plain', html: 'text/html' }[args.format];
        return trimFile(await sendFile(h, { metadata, bytes: utf8Bytes(args.text), mimeType }));
      },
    },
    {
      name: 'create_spreadsheet',
      kind: 'create',
      check: 'list_files',
      title: 'Create a Google Sheet',
      description: 'Creates a Google Sheet in a folder, empty or filled with rows (or CSV text). Returns its id and link, for read_sheet, append_rows and update_range.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 500, description: 'The spreadsheet title.' },
          folder_id: { ...ID, description: 'The folder to put it in (required when the connection is limited to chosen folders).' },
          rows: CELL_ROWS,
          csv: { type: 'string', maxLength: 1000000, description: 'CSV text, instead of rows.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string; folder_id?: string; rows?: unknown[]; csv?: string }, h) {
        if (args.rows !== undefined && args.csv !== undefined) throw new ToolFailure('Give rows or csv, not both. Nothing was changed.');
        const rows = args.rows !== undefined ? checkRows(args.rows, 'rows') : undefined;
        const parents = await targetFolder(h, args.folder_id);
        const metadata = compact({ name: args.name, parents, mimeType: GOOGLE_TYPES.spreadsheet });
        const csv = rows ? toCsv(rows) : args.csv;
        if (csv === undefined || csv === '') return trimFile(await createMetadata(h, metadata));
        return trimFile(await sendFile(h, { metadata, bytes: utf8Bytes(csv), mimeType: 'text/csv' }));
      },
    },
    {
      name: 'update_file',
      kind: 'update',
      check: 'get_file',
      title: 'Rename, move or trash a Google Drive file',
      description: 'Changes a file\'s name, description or star, moves it to another folder, or moves it to the trash (trashed true) and back (trashed false). Only the fields given change.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          name: { type: 'string', minLength: 1, maxLength: 500, description: 'The new name.' },
          description: { type: 'string', maxLength: 2000, description: 'The new description.' },
          starred: { type: 'boolean', description: 'Star or unstar it.' },
          trashed: { type: 'boolean', description: 'true moves it to the trash; false restores it.' },
          move_to_folder_id: { ...ID, description: 'The folder to move it into (it leaves its current folder).' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      async run(args: { file_id: string; name?: string; description?: string; starred?: boolean; trashed?: boolean; move_to_folder_id?: string }, h) {
        const body = compact({ name: args.name, description: args.description, starred: args.starred, trashed: args.trashed });
        if (!Object.keys(body).length && args.move_to_folder_id === undefined) throw new ToolFailure('Give at least one change. Nothing was changed.');
        let addParents: string | undefined;
        let removeParents: string | undefined;
        if (args.move_to_folder_id !== undefined || chosenFolders(h) !== null) {
          const file = await getChecked(h, args.file_id, 'id,parents');
          if (args.move_to_folder_id !== undefined) {
            await assertInside(h, args.move_to_folder_id, 'folder');
            const current: string[] = Array.isArray(file?.parents) ? file.parents.filter((parent: unknown) => typeof parent === 'string') : [];
            addParents = current.includes(args.move_to_folder_id) ? undefined : args.move_to_folder_id;
            removeParents = current.filter((parent) => parent !== args.move_to_folder_id).join(',') || undefined;
          }
        }
        const { data } = await drive(h, {
          method: 'PATCH',
          path: `/drive/v3/files/${enc(args.file_id)}`,
          query: { supportsAllDrives: true, fields: FILE_FIELDS, addParents, removeParents },
          json: body,
          write: true,
        });
        return trimFile(data);
      },
    },
    {
      name: 'replace_file_content',
      kind: 'update',
      check: 'get_file',
      title: 'Replace a Google Drive file\'s content',
      description:
        'Replaces the content of an existing file and keeps its id, name and links: from a public https URL (up to 50 MB) or from text given '
        + 'here. New text, Markdown or HTML replaces a Google Doc\'s content, and CSV a Google Sheet\'s.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https URL of the new content.' },
          content: { type: 'string', maxLength: 1000000, description: 'The new content as text, instead of url.' },
          mime_type: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$', description: 'The new content\'s type. Default: from the content, else the file\'s type.' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      async run(args: Source & { file_id: string; mime_type?: string }, h) {
        const file = await getChecked(h, args.file_id, 'id,name,mimeType');
        const current = typeof file?.mimeType === 'string' ? file.mimeType : '';
        if (current === FOLDER_TYPE) throw new ToolFailure('That is a folder, which has no content to replace. Nothing was changed.');
        const { bytes, served } = await sourceBytes(h, args);
        const ownType = current.startsWith('application/vnd.google-apps.') ? undefined : current;
        const name = typeof file?.name === 'string' ? file.name : '';
        const mimeType = args.mime_type
          ?? (args.content !== undefined
            ? (current === GOOGLE_TYPES.spreadsheet ? 'text/csv' : ownType ?? typeByName(name) ?? 'text/plain')
            : uploadType(bytes, name, undefined, served ?? ownType));
        return trimFile(await sendFile(h, { fileId: args.file_id, bytes, mimeType }));
      },
    },
    {
      name: 'share_file',
      kind: 'create',
      check: 'get_file',
      title: 'Share a Google Drive file',
      description:
        'Gives a person, a group, a whole domain or anyone with the link access to a file or folder, as reader, commenter or writer (Editor; '
        + 'Content manager in a shared drive). Files the service account creates belong to it: share them with the people who need to edit them. '
        + 'type anyone with role reader makes the file public, so other tools can download it from its webContentLink.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          role: { type: 'string', enum: ['reader', 'commenter', 'writer'], description: 'reader, commenter or writer.' },
          type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'], description: 'user or group (with email), domain (with domain), or anyone with the link.' },
          email: { type: 'string', pattern: '^[^\\s@]+@[^\\s@]+$', maxLength: 320, description: 'The person\'s or group\'s email, for type user or group.' },
          domain: { type: 'string', pattern: '^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$', maxLength: 253, description: 'The domain, for type domain, e.g. example.com.' },
          notify: { type: 'boolean', description: 'For user and group: send Google\'s notification email (default true).' },
          message: { type: 'string', maxLength: 2000, description: 'A note for the notification email.' },
        },
        required: ['file_id', 'role', 'type'],
        additionalProperties: false,
      },
      async run(args: { file_id: string; role: string; type: string; email?: string; domain?: string; notify?: boolean; message?: string }, h) {
        const person = args.type === 'user' || args.type === 'group';
        if (person && !args.email) throw new ToolFailure(`email is required for type ${args.type}. Nothing was changed.`);
        if (args.type === 'domain' && !args.domain) throw new ToolFailure('domain is required for type domain. Nothing was changed.');
        if (!person && (args.email || args.notify !== undefined || args.message)) throw new ToolFailure('email, notify and message go with type user or group only. Nothing was changed.');
        await assertInside(h, args.file_id);
        const { data } = await drive(h, {
          method: 'POST',
          path: `/drive/v3/files/${enc(args.file_id)}/permissions`,
          query: {
            supportsAllDrives: true,
            fields: 'id,type,role,emailAddress,domain',
            sendNotificationEmail: person ? args.notify : undefined,
            emailMessage: args.message,
          },
          json: compact({ role: args.role, type: args.type, emailAddress: args.email, domain: args.domain }),
          write: true,
        });
        return compact({ fileId: args.file_id, permissionId: data?.id, type: data?.type, role: data?.role, email: data?.emailAddress, domain: data?.domain });
      },
    },
    {
      name: 'get_spreadsheet',
      kind: 'read',
      title: 'Get a Google Sheet\'s sheets',
      description: 'Returns a Google Sheet\'s title, locale, time zone, link and its sheets (tabs) with their ids, names and sizes, to pick a range for read_sheet.',
      inputSchema: { type: 'object', properties: { spreadsheet_id: { ...ID, description: 'The spreadsheet id (the part after /d/ in its link).' } }, required: ['spreadsheet_id'], additionalProperties: false },
      async run(args: { spreadsheet_id: string }, h) {
        await assertInside(h, args.spreadsheet_id, 'spreadsheet');
        const { data } = await drive(h, {
          origin: SHEETS_ORIGIN,
          path: `/v4/spreadsheets/${enc(args.spreadsheet_id)}`,
          query: { fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount)))' },
        });
        const sheets: any[] = Array.isArray(data?.sheets) ? data.sheets : [];
        return compact({
          spreadsheetId: data?.spreadsheetId,
          title: data?.properties?.title,
          locale: data?.properties?.locale,
          timeZone: data?.properties?.timeZone,
          url: data?.spreadsheetUrl,
          sheets: sheets.slice(0, 200).map((sheet) => compact({
            sheetId: sheet?.properties?.sheetId,
            title: sheet?.properties?.title,
            index: sheet?.properties?.index,
            type: sheet?.properties?.sheetType,
            rows: sheet?.properties?.gridProperties?.rowCount,
            columns: sheet?.properties?.gridProperties?.columnCount,
          })),
        });
      },
    },
    {
      name: 'read_sheet',
      kind: 'read',
      title: 'Read a Google Sheet range',
      description:
        'Reads the cells of a range, row by row (trailing empty cells left out): as shown (default), as raw values, or with formulas. '
        + 'Pass nextCursor back as cursor for the next rows of a long range.',
      inputSchema: {
        type: 'object',
        properties: {
          spreadsheet_id: { ...ID, description: 'The spreadsheet id (the part after /d/ in its link).' },
          range: RANGE,
          render: { type: 'string', enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'], default: 'FORMATTED_VALUE', description: 'FORMATTED_VALUE (as shown, default), UNFORMATTED_VALUE (raw numbers) or FORMULA.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['spreadsheet_id', 'range'],
        additionalProperties: false,
      },
      async run(args: { spreadsheet_id: string; range: string; render: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        await assertInside(h, args.spreadsheet_id, 'spreadsheet');
        const { data } = await drive(h, {
          origin: SHEETS_ORIGIN,
          path: valuesPath(args.spreadsheet_id, args.range),
          query: { valueRenderOption: args.render, majorDimension: 'ROWS' },
          errors: { 400: 'Google Sheets did not accept the range: check the sheet name and the A1 notation' },
        });
        const rows: unknown[] = Array.isArray(data?.values) ? data.values : [];
        return h.page({
          key: 'rows',
          items: rows.slice(skip),
          extra: compact({ range: data?.range, totalRows: rows.length, firstRow: skip || undefined }),
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'append_rows',
      kind: 'create',
      check: 'read_sheet',
      title: 'Append rows to a Google Sheet',
      description: 'Adds rows after the last row of the table in a range, e.g. Sheet1!A1 or Sheet1!A:D. Returns the range written and the counts.',
      inputSchema: {
        type: 'object',
        properties: { spreadsheet_id: { ...ID, description: 'The spreadsheet id.' }, range: RANGE, rows: CELL_ROWS, value_input: VALUE_INPUT },
        required: ['spreadsheet_id', 'range', 'rows'],
        additionalProperties: false,
      },
      async run(args: { spreadsheet_id: string; range: string; rows: unknown[]; value_input: string }, h) {
        const rows: Cell[][] = checkRows(args.rows, 'rows');
        await assertInside(h, args.spreadsheet_id, 'spreadsheet');
        const { data } = await drive(h, {
          method: 'POST',
          origin: SHEETS_ORIGIN,
          path: valuesPath(args.spreadsheet_id, args.range, ':append'),
          query: { valueInputOption: args.value_input, insertDataOption: 'INSERT_ROWS' },
          json: { majorDimension: 'ROWS', values: rows },
          write: true,
        });
        const updates = data?.updates ?? {};
        return compact({ spreadsheetId: args.spreadsheet_id, updatedRange: updates.updatedRange, updatedRows: updates.updatedRows, updatedCells: updates.updatedCells });
      },
    },
    {
      name: 'update_range',
      kind: 'update',
      check: 'read_sheet',
      title: 'Write cells in a Google Sheet',
      description: 'Overwrites the cells of a range with rows, starting at its top-left cell, e.g. Sheet1!B2:C3. Cells outside the rows given stay as they are.',
      inputSchema: {
        type: 'object',
        properties: { spreadsheet_id: { ...ID, description: 'The spreadsheet id.' }, range: RANGE, rows: CELL_ROWS, value_input: VALUE_INPUT },
        required: ['spreadsheet_id', 'range', 'rows'],
        additionalProperties: false,
      },
      async run(args: { spreadsheet_id: string; range: string; rows: unknown[]; value_input: string }, h) {
        const rows: Cell[][] = checkRows(args.rows, 'rows');
        await assertInside(h, args.spreadsheet_id, 'spreadsheet');
        const { data } = await drive(h, {
          method: 'PUT',
          origin: SHEETS_ORIGIN,
          path: valuesPath(args.spreadsheet_id, args.range),
          query: { valueInputOption: args.value_input },
          json: { majorDimension: 'ROWS', values: rows },
          write: true,
        });
        return compact({ spreadsheetId: args.spreadsheet_id, updatedRange: data?.updatedRange, updatedRows: data?.updatedRows, updatedCells: data?.updatedCells });
      },
    },
    {
      name: 'clear_range',
      kind: 'delete',
      check: 'read_sheet',
      title: 'Clear cells in a Google Sheet',
      description: 'Clears the values of a range (formatting stays), e.g. Sheet1!A2:Z1000.',
      inputSchema: {
        type: 'object',
        properties: { spreadsheet_id: { ...ID, description: 'The spreadsheet id.' }, range: RANGE },
        required: ['spreadsheet_id', 'range'],
        additionalProperties: false,
      },
      async run(args: { spreadsheet_id: string; range: string }, h) {
        await assertInside(h, args.spreadsheet_id, 'spreadsheet');
        const { data } = await drive(h, { method: 'POST', origin: SHEETS_ORIGIN, path: valuesPath(args.spreadsheet_id, args.range, ':clear'), json: {}, write: true });
        return compact({ spreadsheetId: args.spreadsheet_id, clearedRange: data?.clearedRange });
      },
    },
    {
      name: 'add_document_text',
      kind: 'create',
      check: 'read_file',
      title: 'Add text to a Google Doc',
      description: 'Inserts plain text at the end (default) or the start of a Google Doc. read_file shows the result; other edits go through api_request (the Docs batchUpdate method).',
      inputSchema: {
        type: 'object',
        properties: {
          document_id: { ...ID, description: 'The document id (the part after /d/ in its link).' },
          text: { type: 'string', minLength: 1, maxLength: 200000, description: 'The text to insert; \\n starts a new paragraph.' },
          position: { type: 'string', enum: ['end', 'start'], default: 'end', description: 'end (default) or start.' },
        },
        required: ['document_id', 'text'],
        additionalProperties: false,
      },
      async run(args: { document_id: string; text: string; position: 'end' | 'start' }, h) {
        await assertInside(h, args.document_id, 'document');
        const insertText = args.position === 'start' ? { location: { index: 1 }, text: args.text } : { endOfSegmentLocation: {}, text: args.text };
        const { data } = await drive(h, {
          method: 'POST',
          origin: DOCS_ORIGIN,
          path: `/v1/documents/${enc(args.document_id)}:batchUpdate`,
          json: { requests: [{ insertText }] },
          write: true,
        });
        return compact({ documentId: data?.documentId ?? args.document_id, position: args.position, characters: args.text.length });
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Google Drive API v3 (https://www.googleapis.com, paths /drive/v3/... and /upload/drive/v3/...), the Google Sheets API v4 '
        + '(https://sheets.googleapis.com, /v4/spreadsheets/...) and the Google Docs API v1 (https://docs.googleapis.com, /v1/documents/...), '
        + 'as the service account; pass origin for Sheets or Docs. Add supportsAllDrives=true for shared drives. While the connection is '
        + 'limited to chosen folders, paths must name a file inside them. References: https://developers.google.com/workspace/drive/api/reference/rest/v3, '
        + 'https://developers.google.com/workspace/sheets/api/reference/rest, https://developers.google.com/workspace/docs/api/reference/rest.',
      originArgument: 'https://www.googleapis.com for Drive (default), https://sheets.googleapis.com for Sheets, https://docs.googleapis.com for Docs.',
      guard: driveGuard,
      send: (request, h) => drive(h, request),
    }),
  ],
});

export = connector;
