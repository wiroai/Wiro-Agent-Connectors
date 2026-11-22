// Video files for TikTok's FILE_UPLOAD: the type told by the first bytes (a
// server's Content-Type is not trusted), and the chunk plan TikTok's media
// transfer rules ask for.

export type VideoType = 'video/mp4' | 'video/quicktime' | 'video/webm';

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
export const CHUNK_BYTES = 10 * MB;

export interface ChunkPlan {
  chunkSize: number;
  count: number;
  /** [first byte, last byte] of each chunk, inclusive. */
  ranges: Array<[number, number]>;
}

/**
 * Chunks for a file of `size` bytes: one chunk up to 10 MB, otherwise 10 MB
 * chunks with the remainder added to the last one, as TikTok counts them
 * (total_chunk_count = floor(size / chunk_size)).
 */
export function chunkPlan(size: number): ChunkPlan {
  const chunkSize = size <= CHUNK_BYTES ? size : CHUNK_BYTES;
  const count = Math.max(1, Math.floor(size / chunkSize));
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    const first = index * chunkSize;
    const last = index === count - 1 ? size - 1 : first + chunkSize - 1;
    ranges.push([first, last]);
  }
  return { chunkSize, count, ranges };
}
