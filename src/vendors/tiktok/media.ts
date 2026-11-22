// Video files for TikTok's FILE_UPLOAD: the type told by the first bytes (a
// server's Content-Type is not trusted), and the chunk plan TikTok's media
// transfer rules ask for.

export type VideoType = 'video/mp4' | 'video/quicktime' | 'video/webm';
export const VIDEO_TYPES: readonly VideoType[] = ['video/mp4', 'video/quicktime', 'video/webm'];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** MP4 and MOV (an ISO base media "ftyp" box), or WebM (an EBML header). */
export function sniffVideo(bytes: Uint8Array): VideoType | undefined {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return ascii(bytes, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return undefined;
}

const MB = 1024 * 1024;
/** TikTok: each chunk 5 to 64 MB, the last one may hold the rest (up to 128 MB); a file under 5 MB goes whole. */
export const MIN_CHUNK_BYTES = 5 * MB;
/**
 * The chunk size this connector uses. The last chunk holds the rest, so it
 * stays under twice this: within the smallest common host download limit
 * (25 MiB), as each chunk is read with one byte-range request.
 */
export const CHUNK_BYTES = 10 * MB;
/** TikTok takes video files up to 4 GB. */
export const MAX_VIDEO_BYTES = 4 * 1024 * MB;
/** TikTok takes at most 1,000 chunks. */
export const MAX_CHUNKS = 1000;

export interface ChunkPlan {
  chunkSize: number;
  count: number;
  /** [first byte, last byte] of each chunk, inclusive. */
  ranges: Array<[number, number]>;
}

/**
 * The chunks of a file of `size` bytes in chunks of `chunkSize`, as TikTok
 * counts them: total_chunk_count = floor(size / chunk_size), the last chunk
 * holding the rest.
 */
export function planFor(size: number, chunkSize: number): ChunkPlan {
  const count = Math.max(1, Math.floor(size / chunkSize));
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    const first = index * chunkSize;
    const last = index === count - 1 ? size - 1 : first + chunkSize - 1;
    ranges.push([first, last]);
  }
  return { chunkSize, count, ranges };
}

/** The plan this connector uses for a file of `size` bytes: one chunk up to 10 MB, otherwise 10 MB chunks with the remainder added to the last one. */
export function chunkPlan(size: number): ChunkPlan {
  return planFor(size, size <= CHUNK_BYTES ? size : CHUNK_BYTES);
}

/** The index of the chunk that starts at byte `offset`, or -1 when no chunk starts there. */
export function chunkAt(plan: ChunkPlan, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % plan.chunkSize !== 0) return -1;
  const index = offset / plan.chunkSize;
  return index < plan.count ? index : -1;
}
