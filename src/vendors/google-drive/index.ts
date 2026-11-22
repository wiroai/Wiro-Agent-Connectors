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
// `folders` account picker, which lists every folder the service account can
// reach): the tools then reach those folders, their subfolders and the files
// in them, and nothing else.
//
// download_file and export_file hand a stored file, or a PDF or Office copy
// of a Google file, to a host that takes files, within its limit. For a
// service that downloads by URL, a file leaves Drive by link: share_file with
// type anyone returns a download link, and unshare_file takes the link back
// afterwards, in the same run. share_file says when that link cannot work: a
// sharing setting forbids it, downloads are off for viewers, or the file is
// over Google's 100 MB virus-scan limit (a download by link then gets a
// warning page). list_files finds links still open.

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  formatNumber,
  orList,
  OutcomeUnknown,
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
  oneFolderQuery,
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
/**
 * Google Drive scans files up to 100 MB for viruses. A download of a larger
 * file by link gets Google's warning page instead of the file, so a service
 * fetching the link gets that page. Counted in decimal megabytes, to warn
 * rather than miss.
 */
const SCAN_LIMIT_BYTES = 100_000_000;
const MAX_PARENT_LOOKUPS = 20;
/** Folders per page of the picker's list, and the parent names looked up for one page (a few at a time). */
const FOLDER_PAGE_SIZE = 150;
const MAX_NAME_LOOKUPS = 25;
const LOOKUP_BATCH = 5;
const FILE_FIELDS = 'id,name,mimeType,size,parents,driveId,createdTime,modifiedTime,webViewLink,webContentLink';
const LIST_FIELDS = 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,shortcutDetails/targetId)';
const ID_PATTERN = '^[A-Za-z0-9_-]{1,200}$';
const NOTHING_CHANGED = ' Nothing was changed.';

const ID: JsonSchema = { type: 'string', pattern: ID_PATTERN, description: 'A Drive file or folder id (the part after /d/ or /folders/ in its link).' };

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** A 403 that is one of Google's usage limits: waiting helps, sharing does not. */
class UsageLimit extends ToolFailure {}

/** Google's words for a usage limit (rateLimitExceeded, userRateLimitExceeded, quotaExceeded, sharingRateLimitExceeded) and for full storage (storageQuotaExceeded). */
const USAGE_LIMIT = /rate limit|usage limit|quota exceeded|too many requests/i;
const STORAGE_FULL = /storage quota/i;
/**
 * Google's 400 invalidSharingRequest has two common causes: a sharing that
 * was made although its notification email could not be sent, and one a
 * sharing setting does not allow ("ACL change not allowed."). Google puts the
 * cause after "User message:", when the reply carries it at all.
 */
const EMAIL_NOT_SENT = /successfully shared but (the )?emails? could not be sent/i;
const USER_MESSAGE = /User message:/i;
/** Google's 403 exportSizeLimitExceeded: an export over its 10 MB limit. */
const EXPORT_TOO_LARGE = /too large to be exported/i;

/** What the service account needs to share a file. */
const SHARING_RIGHTS = 'in a shared drive it needs the Content manager or Manager role, elsewhere Editor access with "Editors can change permissions and share" on';
const SHARING_SETTINGS = '(Admin console: Apps, Google Workspace, Drive and Docs, Sharing settings)';

/**
 * What to do when Google Drive refuses a new sharing: Google Workspace can
 * forbid sharing outside the organization or by link, for the organization
 * or one shared drive (400), and a 403 may also mean the service account
 * may not share the file at all.
 */
function sharingAdvice(h: ToolHelpers, type: string, status: number): string {
  const forbids = type === 'anyone'
    ? 'a Google Workspace sharing setting, of the organization or of the shared drive, forbids sharing outside the organization or with '
      + `anyone with the link: then this file cannot leave Google Drive by link until an administrator allows it ${SHARING_SETTINGS} or a `
      + 'manager of the shared drive does in its settings.'
    : 'a Google Workspace sharing setting, of the organization or of the shared drive, forbids sharing outside the organization: then '
      + `only an administrator ${SHARING_SETTINGS} or a manager of the shared drive can allow it.`;
  if (status === 400) return `Google Drive did not allow this sharing. Most likely ${forbids}`;
  return `Google Drive may not let ${serviceAccountWords(h)} share it: ${SHARING_RIGHTS}. Or ${forbids}`;
}

/**
 * Google Drive answers 403 for missing sharing, usage limits and storage, and
 * 400 or 403 for a sharing it does not allow: the advice follows the reason
 * Google gave. `sharing` is the type of a new sharing (share_file).
 */
function explainRefusal(h: ToolHelpers, error: unknown, sharing?: string): unknown {
  if (!(error instanceof ToolFailure)) return error;
  const { status } = error.details;
  if (status !== 403 && !(sharing !== undefined && status === 400)) return error;
  const ending = error.message.endsWith(NOTHING_CHANGED) ? NOTHING_CHANGED : '';
  const text = error.message.slice(0, error.message.length - ending.length);
  if (status === 403 && EXPORT_TOO_LARGE.test(text)) {
    return new ToolFailure(`${text} Google Drive exports up to 10 MB of a Google file: export another format (txt and csv are smaller), or open it with webViewLink.`, error.details);
  }
  if (status === 403 && STORAGE_FULL.test(text)) {
    return new ToolFailure(`${text} A service account has no Drive storage of its own: use a folder in a shared drive, where files belong to the drive.${ending}`, error.details);
  }
  if (status === 403 && USAGE_LIMIT.test(text)) {
    return new UsageLimit(`${text} That is a Google Drive usage limit, not a sharing problem: wait a minute and try again.${ending}`, error.details);
  }
  if (sharing !== undefined) {
    // The sharing was made and only its email failed: share_file reports that as done.
    if (EMAIL_NOT_SENT.test(text)) return error;
    return new ToolFailure(`${text} ${sharingAdvice(h, sharing, status as number)}${ending}`, error.details);
  }
  return new ToolFailure(
    `${text} Share the file or folder with ${serviceAccountWords(h)} (Editor, or Content manager in a shared drive), and check that the `
      + `Google Drive, Sheets and Docs APIs are enabled for the key's project.${ending}`,
    error.details,
  );
}

/** One Drive, Sheets or Docs request. `sharing`: the type of a new sharing, for the advice on a refusal. */
async function drive(h: ToolHelpers, request: ApiRequest, sharing?: string): Promise<ApiResponse> {
  try {
    return await googleApi(h, SCOPES, {
      ...request,
      errors: { 404: `Google Drive found no such file, or it is not shared with ${serviceAccountWords(h)}`, ...request.errors },
    });
  } catch (error) {
    throw explainRefusal(h, error, sharing);
  }
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
      // A parent the service account cannot see is outside every folder shared with it; a usage limit says nothing about that.
      if (error instanceof ToolFailure && !(error instanceof UsageLimit) && (error.details.status === 403 || error.details.status === 404)) refuse();
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

/** A shared drive in a folder list: its label says what it is. */
function sharedDriveItem(id: unknown, name: unknown): Record<string, unknown> {
  const shown = typeof name === 'string' && name ? name : id;
  return compact({ id, name: shown, label: `${String(shown)} (shared drive)`, type: 'shared_drive' });
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
        items.push(sharedDriveItem(id, shared?.data?.name ?? data?.name));
      } else {
        const folder = trimFolder(data);
        items.push({ ...folder, id, label: folder['name'] ?? id });
      }
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
      items.push({ id, name: id, label: id, type: 'folder', error: truncate(error.message, 300) });
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

/**
 * The names of the folders' parents, to tell same-named folders apart: from
 * the page itself, then by a few lookups (a shared drive by its own name). A
 * parent the service account cannot see (the owner's own folder) has none.
 */
async function parentNames(h: ToolHelpers, folders: any[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const folder of folders) if (typeof folder?.id === 'string' && typeof folder?.name === 'string') names.set(folder.id, folder.name);
  const driveIds = new Set(folders.map((folder) => folder?.driveId).filter((id): id is string => typeof id === 'string'));
  const missing = [...new Set(folders.map((folder) => (Array.isArray(folder?.parents) ? folder.parents[0] : undefined)))]
    .filter((id): id is string => typeof id === 'string' && !names.has(id))
    .slice(0, MAX_NAME_LOOKUPS);
  for (let start = 0; start < missing.length; start += LOOKUP_BATCH) {
    const batch = missing.slice(start, start + LOOKUP_BATCH);
    const found = await Promise.all(batch.map(async (id) => {
      try {
        const { data } = driveIds.has(id)
          ? await drive(h, { path: `/drive/v3/drives/${enc(id)}`, query: { fields: 'id,name' } })
          : await drive(h, { path: `/drive/v3/files/${enc(id)}`, query: { fields: 'id,name', supportsAllDrives: true } });
        return typeof data?.name === 'string' && data.name ? (data.name as string) : undefined;
      } catch (error) {
        // A label is a convenience: a parent that cannot be read leaves the folder's own name.
        if (error instanceof ToolFailure) return undefined;
        throw error;
      }
    }));
    batch.forEach((id, index) => {
      const name = found[index];
      if (name) names.set(id, name);
    });
  }
  return names;
}

/** A folder of the picker's list: its own name, and a label with its parent's name. */
function reachableFolder(folder: any, names: Map<string, string>): Record<string, unknown> {
  const parentId = Array.isArray(folder?.parents) && typeof folder.parents[0] === 'string' ? (folder.parents[0] as string) : undefined;
  const parentName = parentId ? names.get(parentId) : undefined;
  const name = typeof folder?.name === 'string' && folder.name ? folder.name : folder?.id;
  return compact({
    id: folder?.id,
    name,
    label: parentName ? `${name} (in ${parentName})` : name,
    type: 'folder',
    parentId,
    driveId: folder?.driveId,
    modifiedTime: folder?.modifiedTime,
  });
}

/**
 * Every folder the service account can reach, by name: folders shared with
 * it, their subfolders, and the folders of its shared drives. Then the shared
 * drives it is a member of.
 */
async function reachableFolderList(h: ToolHelpers, cursor: string | undefined) {
  const state = h.cursor(cursor);
  const phase = state?.['ph'] === 'd' ? 'd' : 'f';
  const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
  const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
  const items: Record<string, unknown>[] = [];
  let nextPage: string | undefined;
  let incompleteSearch: boolean | undefined;
  let listDrives = phase === 'd';
  if (phase === 'f') {
    const { data } = await drive(h, {
      path: '/drive/v3/files',
      query: {
        q: `mimeType='${FOLDER_TYPE}' and trashed=false`,
        corpora: 'allDrives',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'name',
        pageSize: FOLDER_PAGE_SIZE,
        pageToken,
        fields: 'nextPageToken,incompleteSearch,files(id,name,parents,driveId,modifiedTime)',
      },
    });
    const folders: any[] = Array.isArray(data?.files) ? data.files : [];
    const names = await parentNames(h, folders);
    for (const folder of folders) items.push(reachableFolder(folder, names));
    if (data?.incompleteSearch === true) incompleteSearch = true;
    if (typeof data?.nextPageToken === 'string' && data.nextPageToken) nextPage = h.makeCursor({ ph: 'f', p: data.nextPageToken, o: 0 });
    else listDrives = true;
  }
  if (listDrives) {
    const { data } = await drive(h, {
      path: '/drive/v3/drives',
      query: { pageSize: 100, pageToken: phase === 'd' ? pageToken : undefined, fields: 'nextPageToken,drives(id,name)' },
    });
    for (const shared of Array.isArray(data?.drives) ? data.drives : []) items.push(sharedDriveItem(shared?.id, shared?.name));
    if (typeof data?.nextPageToken === 'string' && data.nextPageToken) nextPage = h.makeCursor({ ph: 'd', p: data.nextPageToken, o: 0 });
  }
  return h.page({
    key: 'folders',
    items: items.slice(skip),
    extra: compact({ incompleteSearch }),
    resumeAt: (index) => h.makeCursor({ ph: phase, ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
    ...(nextPage ? { nextPage } : {}),
  });
}

/**
 * Whether people with this role may not download the file: its owner or a
 * manager turned downloads off for viewers and commenters (or for editors
 * too), on the file or for its whole shared drive. Google's effective
 * restriction counts every setting; either signal is enough.
 */
function downloadBlocked(file: any, role: string): boolean {
  const restrictions = file?.downloadRestrictions;
  const restriction = restrictions?.effectiveDownloadRestrictionWithContext ?? restrictions?.itemDownloadRestriction;
  if (restriction?.restrictedForWriters === true) return true;
  if (role === 'writer') return false;
  return restriction?.restrictedForReaders === true || file?.copyRequiresWriterPermission === true;
}

/** The sentence for a file over Google's virus-scan limit, or undefined. */
function scanWarning(file: any): string | undefined {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= SCAN_LIMIT_BYTES) return undefined;
  return 'Google Drive does not scan files over 100 MB for viruses, so a download of this one by link gets Google\'s warning page '
    + 'instead of the file: a service that fetches the link gets that page, not the file (a person can still download it from there).';
}

/** Where a file shared with anyone downloads without signing in: the file itself, or a Google file's exports by format. */
function downloadLinks(file: any): Record<string, unknown> {
  if (typeof file?.webContentLink === 'string' && file.webContentLink) return { downloadUrl: file.webContentLink };
  const links = file?.exportLinks && typeof file.exportLinks === 'object' ? (file.exportLinks as Record<string, unknown>) : {};
  const exportUrls: Record<string, string> = {};
  for (const [type, url] of Object.entries(links)) {
    if (typeof url !== 'string') continue;
    let format: string | null = null;
    try {
      format = new URL(url).searchParams.get('exportFormat');
    } catch {
      // keyed by its type instead
    }
    exportUrls[format || type] = url;
  }
  return Object.keys(exportUrls).length ? { exportUrls } : {};
}

const EXPORTS: Record<string, Record<string, string>> = {
  [GOOGLE_TYPES.document]: { markdown: 'text/markdown', text: 'text/plain', html: 'text/html' },
  [GOOGLE_TYPES.spreadsheet]: { csv: 'text/csv', tsv: 'text/tab-separated-values' },
  [GOOGLE_TYPES.presentation]: { text: 'text/plain' },
};

/** What each kind of Google file is called in messages. */
const KIND_NAMES: Record<string, string> = {
  document: 'Google Doc',
  spreadsheet: 'Google Sheet',
  presentation: 'Google Slides file',
  drawing: 'Google Drawing',
  form: 'Google Form',
  site: 'Google Site',
};

/**
 * The formats export_file makes of each kind of Google file, from Google
 * Drive's export types: csv holds a Sheet's first sheet only, and png a
 * Slides file's first slide. Their types come from the extension.
 */
const FILE_EXPORTS: Record<string, string[]> = {
  document: ['pdf', 'docx', 'txt'],
  spreadsheet: ['pdf', 'xlsx', 'csv'],
  presentation: ['pdf', 'pptx', 'txt', 'png'],
  drawing: ['pdf', 'png'],
};
const EXPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'png'];

/** The most bytes this host takes in files from the call; a host that takes none is refused before anything is sent. */
function filesTaken(h: ToolHelpers): number {
  const limit = h.fileLimit();
  if (limit === null) {
    throw new ToolFailure(
      `This host takes no files, so ${h.tool} cannot hand one back. Open the file with get_file's webViewLink, or hand it to a service `
        + `that downloads by URL with share_file. Nothing was sent to ${LABEL}.`,
    );
  }
  return limit;
}

/** Google's own file types, application/vnd.google-apps.*: none has a stored file. */
const GOOGLE_APPS_TYPE = 'application/vnd.google-apps.';

/** Why an item is not a stored file to hand back as it is (a folder, a shortcut, a Google file to export), or undefined for one. */
function notStoredFile(mimeType: unknown): string | undefined {
  const kind = kindOf(mimeType);
  if (kind === 'file') {
    // A Google file of a kind not named here (an Apps Script project, a Vids video, a My Maps map) has no stored file either.
    return typeof mimeType === 'string' && mimeType.startsWith(GOOGLE_APPS_TYPE)
      ? 'That is a Google file with no stored file to download, and export_file exports only Google Docs, Sheets, Slides files and Drawings.'
      : undefined;
  }
  if (kind === 'folder') return 'That is a folder: list its files with list_files.';
  if (kind === 'shortcut') return 'That is a shortcut: use its target, whose id get_file returns as shortcutTarget.';
  if (FILE_EXPORTS[kind]) return `That is a ${KIND_NAMES[kind]}, which has no stored file: export it with export_file.`;
  return `A ${KIND_NAMES[kind] ?? 'Google file of this kind'} cannot be downloaded or exported.`;
}

/** Refuses a file the service account may not download: downloads are off for its role, on the file or in its shared drive. */
function assertDownloadable(h: ToolHelpers, file: any): void {
  if (file?.capabilities?.canDownload === false) {
    throw new ToolFailure(`Google Drive does not let ${serviceAccountWords(h)} download this file: downloads are turned off for its role, on the file or in its shared drive.`);
  }
}

/** An export's file name: the Google file's name with the format's extension. */
function exportName(name: string, format: string): string {
  return name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
}

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
  // The range is one path segment: "." or ".." would change the path itself.
  pattern: '^(?!\\.{1,2}$)',
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

const LOCK_NOTE = 'This connection is limited to its chosen folders:';

/**
 * The parents a request's JSON body names, all inside the chosen folders.
 * A raw body never gets here (only json can be checked), so a request that
 * must name parents and has none in json is refused.
 */
async function assertParents(h: ToolHelpers, parents: unknown, problem: string): Promise<void> {
  if (!Array.isArray(parents) || !parents.length || !parents.every((parent) => typeof parent === 'string' && parent)) {
    throw new ToolFailure(`${LOCK_NOTE} ${problem} Nothing was sent.`);
  }
  for (const parent of new Set(parents as string[])) await assertInside(h, parent, 'folder');
}

/**
 * The generic tools keep to the Drive, Sheets and Docs APIs, and, while a host
 * limits the connection to chosen folders, to items inside them: the file a
 * path names, every folder a request moves or copies something into (the
 * addParents query, parents in the JSON body), the spreadsheet a sheet is
 * copied to, and the folder a file listing's query names.
 */
async function driveGuard(request: ApiToolRequest, h: ToolHelpers): Promise<void> {
  const refuse = (sentence: string): never => {
    throw new ToolFailure(`${sentence} Nothing was sent.`);
  };
  const { segments } = request;
  const [first, second, third] = segments;
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

  if (area === 'sheets' || area === 'docs') {
    const id = idOfSegment(third);
    if (!id) return refuse(`${LOCK_NOTE} create spreadsheets and documents with create_spreadsheet and create_document, in a chosen folder.`);
    await assertInside(h, id);
    // A sheet copied into another spreadsheet (sheets/{sheetId}:copyTo) writes there.
    if (area === 'sheets' && segments.some((segment) => /:copyto$/i.test(segment))) {
      const destination = request.json?.['destinationSpreadsheetId'];
      if (typeof destination !== 'string' || !destination) {
        return refuse(`${LOCK_NOTE} copyTo needs json with destinationSpreadsheetId naming a spreadsheet inside them.`);
      }
      if (destination !== id) await assertInside(h, destination, 'spreadsheet');
    }
    return;
  }
  // /drive/v3/files/{fileId}/{action}, and /upload/drive/v3/files/{fileId}.
  const shift = area === 'upload' ? 1 : 0;
  const collection = segments[2 + shift];
  const fileId = segments[3 + shift];
  const action = area === 'drive' ? segments[4]?.toLowerCase() : undefined;
  if (collection === 'about' && request.method === 'GET') return;
  if (collection !== 'files') return refuse(`${LOCK_NOTE} only files paths (/drive/v3/files/...) and about are reachable.`);
  if (!fileId) {
    if (area === 'upload') return refuse(`${LOCK_NOTE} upload new files with upload_file.`);
    if (request.method === 'GET') {
      const folder = oneFolderQuery(request.query['q']);
      if (!folder) {
        return refuse(`${LOCK_NOTE} list files with list_files, or with a q naming one chosen folder and nothing else but trashed and mimeType terms, such as "'FOLDER_ID' in parents and trashed=false".`);
      }
      await assertInside(h, folder, 'folder');
      return;
    }
    if (request.method === 'POST') return assertParents(h, request.json?.['parents'], 'a new file needs json with parents naming a chosen folder.');
    return refuse(`${LOCK_NOTE} only file listings and new files go to /drive/v3/files itself.`);
  }
  if (fileId === 'generateIds' && request.method === 'GET') return;
  if (fileId === 'trash') return refuse(`${LOCK_NOTE} emptying the trash is not available.`);
  await assertInside(h, fileId);
  const checked = new Set<string>();
  // A copy lands in the parents its body names: they must be given, in json, and inside the chosen folders.
  if (action === 'copy') {
    await assertParents(h, request.json?.['parents'], 'a copy needs json with parents naming a chosen folder.');
    for (const parent of request.json?.['parents'] as string[]) checked.add(parent);
  }
  // A move (addParents, or parents in a body) must stay inside them, on upload paths too.
  const moved = [...(request.query['addParents'] ?? []).flatMap((value) => value.split(',')), ...(Array.isArray(request.json?.['parents']) ? (request.json['parents'] as unknown[]) : [])];
  for (const parent of moved) {
    if (typeof parent !== 'string' || !parent.trim()) refuse(`${LOCK_NOTE} parents must be folder ids.`);
    const id = (parent as string).trim();
    if (checked.has(id)) continue;
    checked.add(id);
    await assertInside(h, id, 'folder');
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
      nameField: 'label',
      legacyField: 'folders',
    },
  ],
  tools: [
    {
      name: 'list_folders',
      kind: 'read',
      title: 'List Google Drive folders',
      description:
        'Lists folders: without parent_id, the folders chosen for this connection, or, with no choice made, every folder the service account '
        + 'can reach (folders shared with it, their subfolders and the folders of its shared drives, each labeled with its parent folder\'s '
        + 'name), then the shared drives it is a member of; with parent_id, the subfolders of that folder. Each has its id and name. '
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
        return allowed === null ? reachableFolderList(h, args.cursor) : chosenFolderList(h, allowed, args.cursor);
      },
    },
    {
      name: 'list_files',
      kind: 'read',
      title: 'List Google Drive files',
      description:
        'Lists the files in a folder (or, without folder_id, in the chosen folders, or everything the service account can see), newest change '
        + 'first (full-text matches by relevance): id, name, kind (folder, document, spreadsheet, presentation or file), type, size, times and '
        + 'link. Filter by name, text, type, change time, or whether anyone with the link can open them. Subfolders are listed too; list one '
        + 'with its id for its files. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { ...ID, description: 'The folder to list.' },
          name_contains: { type: 'string', maxLength: 200, description: 'Only names containing this text.' },
          full_text: { type: 'string', maxLength: 200, description: 'Only files whose name or content contains this text; they come back by relevance.' },
          mime_type: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9.+-]+/([A-Za-z0-9.+-]+|\\*)$', description: 'Only this type, e.g. image/png, or a family such as image/* or video/*.' },
          modified_after: { type: 'string', maxLength: 40, description: 'Only files changed after this time (RFC 3339), e.g. 2026-05-01T00:00:00Z.' },
          shared_with_anyone: {
            type: 'boolean',
            description: 'true: only files anyone with the link can open (shared with anyone, as share_file does for a service), to find links '
              + 'still open and remove them with unshare_file; false: only files that are not.',
          },
          include_folders: { type: 'boolean', default: true, description: 'List subfolders too (default true).' },
          order_by: {
            type: 'string',
            enum: ['modifiedTime desc', 'createdTime desc', 'name', 'folder,name'],
            description: 'Order (default newest change first). Not with full_text or a fullText query: Google Drive sorts those by relevance.',
          },
          query: { type: 'string', maxLength: 1000, description: 'A raw Drive search query, e.g. "starred = true"; not available while the connection is limited to chosen folders.' },
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Files per page, 1 to 1000 (default 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: {
        folder_id?: string; name_contains?: string; full_text?: string; mime_type?: string; modified_after?: string;
        shared_with_anyone?: boolean; include_folders: boolean; order_by?: string; query?: string; page_size: number; cursor?: string;
      }, h) {
        // Google Drive refuses a sort order for a query with a fullText term: those come back by relevance.
        const fullText = Boolean(args.full_text) || (args.query !== undefined && /\bfullText\s+contains\b/i.test(args.query));
        if (fullText && args.order_by !== undefined) {
          throw new ToolFailure('order_by does not go with full_text or a fullText query: Google Drive returns full-text matches by relevance. Leave order_by out.');
        }
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
        // A link for anyone is "anyoneWithLink"; "anyoneCanFind" is one that also shows in search.
        if (args.shared_with_anyone === true) clauses.push(`(visibility = 'anyoneWithLink' or visibility = 'anyoneCanFind')`);
        if (args.shared_with_anyone === false) clauses.push(`visibility != 'anyoneWithLink' and visibility != 'anyoneCanFind'`);
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
          orderBy: fullText ? undefined : args.order_by ?? 'modifiedTime desc',
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
        + 'as they are, up to 4 MB. A binary file (an image, a video, a PDF) is not read: its details and links come back instead, and '
        + 'download_file hands the file itself to the host (export_file a PDF, Word, Excel or PowerPoint copy of a Google file). To hand a '
        + 'file to a service that downloads by URL, use share_file (type anyone), then unshare_file in the same run. Pass nextCursor back '
        + 'as cursor for the next page.',
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
            note: 'This is a binary file, which read_file does not read: download_file hands it to the host as a file, where the host takes '
              + 'files. Open it with webViewLink. For a service that downloads files by URL, share_file with type anyone and role reader '
              + 'returns its downloadUrl; in the same run, once the service has the file (or has failed), unshare_file with permission_id '
              + 'anyoneWithLink takes the link back.',
            warning: scanWarning(file),
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
      name: 'download_file',
      kind: 'read',
      title: 'Download a Google Drive file',
      description:
        'Hands a stored file (an image, a video, a PDF, an Office file or any other upload) to the host as a file, with its details, for the '
        + 'host to save or pass on. Its size is checked against the most the host takes before anything is downloaded. A Google Doc, Sheet, '
        + 'Slides file or Drawing has no stored file: export_file makes a PDF or Office copy of it. A host that takes no files gets a '
        + 'refusal; share_file (type anyone) then hands the file to a service that downloads by URL.',
      inputSchema: { type: 'object', properties: { file_id: ID }, required: ['file_id'], additionalProperties: false },
      async run(args: { file_id: string }, h) {
        const limit = filesTaken(h);
        const file = await getChecked(h, args.file_id, 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,capabilities(canDownload)');
        const problem = notStoredFile(file?.mimeType);
        if (problem) throw new ToolFailure(problem);
        assertDownloadable(h, file);
        const size = Number(file?.size);
        if (Number.isFinite(size) && size > limit) {
          throw new ToolFailure(
            `The file has ${formatNumber(size)} bytes, more than the ${formatNumber(limit)} bytes this host takes, so it was not downloaded. `
              + 'share_file (type anyone) hands it to a service that downloads by URL instead.',
          );
        }
        const { data } = await drive(h, {
          path: `/drive/v3/files/${enc(args.file_id)}`,
          query: { alt: 'media', supportsAllDrives: true },
          headers: { accept: '*/*' },
          binary: true,
          maxBytes: limit,
        });
        const name = typeof file?.name === 'string' && file.name ? file.name : args.file_id;
        const mimeType = typeof file?.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
        return compact({ ...trimFile(file), md5Checksum: file?.md5Checksum, file: h.file({ name, mimeType, bytes: data }) });
      },
    },
    {
      name: 'export_file',
      kind: 'read',
      title: 'Export a Google Doc, Sheet, Slides file or Drawing',
      description:
        'Exports a Google Doc, Sheet, Slides file or Drawing and hands the copy to the host as a file: a Doc as pdf, docx or txt; a Sheet as '
        + 'pdf, xlsx or csv (csv holds its first sheet only); a Slides file as pdf, pptx, txt or png (png shows its first slide only); a '
        + 'Drawing as pdf or png. Google Drive exports up to 10 MB. A host that takes no files gets a refusal; read_file reads the text of '
        + 'a Doc, Sheet or Slides file instead.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          format: {
            type: 'string',
            enum: EXPORT_FORMATS,
            default: 'pdf',
            description: 'pdf (default, every kind), docx (Doc), xlsx (Sheet), pptx (Slides), csv (Sheet, its first sheet), txt (Doc or Slides) or png (Slides, its first slide; Drawing).',
          },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
      async run(args: { file_id: string; format: string }, h) {
        const limit = filesTaken(h);
        const file = await getChecked(h, args.file_id, 'id,name,mimeType,modifiedTime,webViewLink,capabilities(canDownload)');
        const kind = kindOf(file?.mimeType);
        const formats = FILE_EXPORTS[kind];
        if (!formats) {
          throw new ToolFailure(notStoredFile(file?.mimeType)
            ?? 'That is a stored file, not a Google Doc, Sheet, Slides file or Drawing: download it with download_file.');
        }
        if (!formats.includes(args.format)) throw new ToolFailure(`A ${KIND_NAMES[kind]} exports as ${orList(formats)}, not ${args.format}.`);
        assertDownloadable(h, file);
        const mimeType = typeByName(`export.${args.format}`) ?? 'application/octet-stream';
        const { data } = await drive(h, {
          path: `/drive/v3/files/${enc(args.file_id)}/export`,
          query: { mimeType },
          headers: { accept: '*/*' },
          binary: true,
          maxBytes: limit,
        });
        const note = kind === 'spreadsheet' && args.format === 'csv'
          ? 'csv holds the first sheet only; read_sheet reads any sheet.'
          : kind === 'presentation' && args.format === 'png' ? 'png shows the first slide only.' : undefined;
        const name = exportName(typeof file?.name === 'string' && file.name ? file.name : args.file_id, args.format);
        return compact({ ...trimFile(file), format: args.format, note, file: h.file({ name, mimeType, bytes: data }) });
      },
    },
    {
      name: 'upload_file',
      kind: 'create',
      check: 'list_files',
      title: 'Upload a file to Google Drive',
      description:
        'Uploads a file into a folder: from a public https URL (images, videos, PDFs and any other file, up to 50 MB) or from text given here '
        + '(CSV, Markdown, JSON, HTML or plain text). A connector reads no local files: a file on a computer or in a workspace must first be '
        + 'reachable at a public https URL. The type comes from the file itself unless mime_type says otherwise; convert_to turns it into a '
        + 'Google Doc, Sheet or Slides file. Returns the new file with its id and link. A service account owns no storage of its own: upload '
        + 'into a shared drive, or Google may answer storageQuotaExceeded.',
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
        + 'type anyone with role reader is how a file reaches a service that downloads by URL: the result then has downloadUrl (the file '
        + 'itself) or, for a Google Doc, Sheet or Slides file, exportUrls by format (pdf, docx, xlsx, pptx and more), and a warning when a '
        + 'service cannot fetch it (downloads off for viewers; over 100 MB, Google answers with a virus-scan page). Anyone with the link can '
        + 'open the file until unshare_file removes permission anyoneWithLink: do that in the same run, once the service has the file. A '
        + 'sharing setting of the organization or the shared drive can forbid links for anyone; the error then says so.',
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
        // The file (links, size, download settings, the right to share) is read before the change, so nothing after it can fail.
        const file = await getChecked(h, args.file_id, [
          'id,name,mimeType,size,webViewLink,webContentLink,exportLinks',
          'copyRequiresWriterPermission,downloadRestrictions,capabilities(canShare)',
        ].join(','));
        if (file?.capabilities?.canShare === false) {
          throw new ToolFailure(
            `Google Drive does not let ${serviceAccountWords(h)} change who can open this ${kindOf(file?.mimeType) === 'folder' ? 'folder' : 'file'}: `
              + `${SHARING_RIGHTS}, unless a sharing setting of the organization or of the shared drive stops it anyway. Nothing was changed.`,
          );
        }
        const details = trimFile(file);
        const about = { fileId: args.file_id, name: details['name'], mimeType: details['mimeType'], size: details['size'] };
        let data: any;
        try {
          ({ data } = await drive(h, {
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
          }, args.type));
        } catch (error) {
          if (!(error instanceof ToolFailure) || error.details.status !== 400) throw error;
          // Google made the sharing and only its email failed: it is done.
          if (EMAIL_NOT_SENT.test(error.message)) {
            return compact({
              ...about,
              type: args.type,
              role: args.role,
              email: args.email,
              webViewLink: file?.webViewLink,
              warning: 'Google Drive made the sharing but could not send its notification email: check the address. get_file lists the sharing with its permission id.',
            });
          }
          // A 400 that gives no cause may be that same case, when an email was to be sent.
          if (person && args.notify !== false && !USER_MESSAGE.test(error.message)) {
            throw new OutcomeUnknown(
              'Google Drive answered HTTP 400 without a cause, as it does both when a sharing setting forbids the sharing and when it made '
                + 'the sharing but could not send the notification email, so it is not known whether the sharing was made.',
            );
          }
          throw error;
        }
        const anyone = args.type === 'anyone';
        let links: Record<string, unknown> = {};
        let warning: string | undefined;
        if (anyone && downloadBlocked(file, args.role)) {
          warning = `Downloads are turned off for ${args.role === 'writer' ? 'editors' : 'viewers'} of this file (on the file, or in its shared drive), `
            + 'so the link opens it in Google Drive but gives no file to download: a service cannot fetch it.';
        } else if (anyone) {
          links = downloadLinks(file);
          if (links['downloadUrl']) warning = scanWarning(file);
        }
        return compact({
          ...about,
          permissionId: data?.id,
          type: data?.type,
          role: data?.role,
          email: data?.emailAddress,
          domain: data?.domain,
          webViewLink: file?.webViewLink,
          ...links,
          warning,
          note: anyone
            ? `Anyone with the link can open the file until unshare_file removes permission ${String(data?.id ?? 'anyoneWithLink')}: do that in the same run, once the service has the file.`
            : undefined,
        });
      },
    },
    {
      name: 'unshare_file',
      kind: 'delete',
      check: 'get_file',
      title: 'Remove a sharing from a Google Drive file',
      description:
        'Removes one sharing from a file or folder by its permission id: the permissionId share_file returned, or an id from get_file\'s '
        + 'sharedWith. anyoneWithLink takes back a link shared with anyone: call it in the same run, once the service that needed the file '
        + 'has it or has failed (list_files with shared_with_anyone finds links still open). Sharing inherited from a folder is removed on '
        + 'the folder, and the owner\'s cannot be removed.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: ID,
          permission_id: { type: 'string', pattern: ID_PATTERN, description: 'The permission id, e.g. anyoneWithLink.' },
        },
        required: ['file_id', 'permission_id'],
        additionalProperties: false,
      },
      async run(args: { file_id: string; permission_id: string }, h) {
        await assertInside(h, args.file_id);
        await drive(h, {
          method: 'DELETE',
          path: `/drive/v3/files/${enc(args.file_id)}/permissions/${enc(args.permission_id)}`,
          query: { supportsAllDrives: true },
          write: true,
          errors: { 404: 'Google Drive found no such sharing on the file (it may be removed already), or no such file' },
        });
        return { removed: true, fileId: args.file_id, permissionId: args.permission_id };
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
        'The Google Drive API v3 (https://www.googleapis.com: /drive/v3/..., /upload/drive/v3/...), Sheets API v4 (https://sheets.googleapis.com: '
        + '/v4/spreadsheets/...) and Docs API v1 (https://docs.googleapis.com: /v1/documents/...), as the service account; pass origin for '
        + 'Sheets or Docs, and supportsAllDrives=true for shared drives. While the connection is limited to chosen folders, paths must name a '
        + 'file inside them, and a file listing needs a q such as "\'FOLDER_ID\' in parents and trashed=false". Reference: '
        + 'https://developers.google.com/workspace/drive/api/reference/rest/v3 (Sheets and Docs: /workspace/sheets/api/reference/rest, '
        + '/workspace/docs/api/reference/rest).',
      originArgument: 'https://www.googleapis.com for Drive (default), https://sheets.googleapis.com for Sheets, https://docs.googleapis.com for Docs.',
      guard: driveGuard,
      send: (request, h) => drive(h, request),
    }),
  ],
});

export = connector;
