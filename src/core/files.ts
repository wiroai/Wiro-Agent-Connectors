// Files a tool hands to its host. A host that takes files says so in
// ctx.files ({ maxBytes }); a tool checks that limit (h.fileLimit) before it
// downloads anything, then passes the bytes to h.file. The result keeps its
// JSON text block first and carries one MCP embedded resource per file:
// { type: "resource", resource: { uri: "attachment:///" + the name,
// percent-encoded, mimeType, blob: the bytes in base64 } }. The stdio CLI
// passes the blocks on to its MCP client; another host may save the files and
// show the model where instead.

import type { EmbeddedResource, ToolContext } from '../types.js';
import { base64Encode } from './text.js';

/** The start of every file's uri; the file's name, percent-encoded, follows. */
export const ATTACHMENT_URI = 'attachment:///';
const MAX_NAME = 200;

/** What a tool passes to h.file. */
export interface FileOut {
  /** The file's name with its extension, e.g. "Q3 report.pdf". */
  name: string;
  /** Its type, e.g. "application/pdf". */
  mimeType: string;
  bytes: Uint8Array;
}

/** What h.file returns, for the JSON result: the name and type as handed over, and the size in bytes. */
export interface FileInfo {
  name: string;
  mimeType: string;
  size: number;
}

/** The most bytes the files of one call may hold in all, from ctx.files, or null when the host takes no files. */
export function fileLimitOf(ctx: ToolContext): number | null {
  const maxBytes = ctx.files?.maxBytes;
  return typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : null;
}

/** A file's name as hosts get it: no folder separators or control characters, at most 200 characters, its extension kept. */
export function fileName(name: string): string {
  const clean = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  const points = Array.from(clean);
  if (points.length <= MAX_NAME) return clean || 'file';
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? '';
  return points.slice(0, MAX_NAME - extension.length).join('') + extension;
}

/** A MIME type such as "application/pdf", without parameters; application/octet-stream for anything else. */
export function fileType(mimeType: string): string {
  const type = String(mimeType).split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : 'application/octet-stream';
}

/** The embedded resource that carries a file in a result. */
export function resourceBlock(file: FileInfo & { bytes: Uint8Array }): EmbeddedResource {
  return {
    type: 'resource',
    resource: { uri: `${ATTACHMENT_URI}${encodeURIComponent(file.name)}`, mimeType: file.mimeType, blob: base64Encode(file.bytes) },
  };
}
