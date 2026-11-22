// Media for X posts: the type told by the first bytes (a server's
// Content-Type is not trusted), X's category and size limit for it, and the
// standard base64 X's JSON upload takes.

export interface MediaKind {
  type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/quicktime';
  category: 'tweet_image' | 'tweet_gif' | 'tweet_video';
  /** X's own limit for this kind. */
  maxBytes: number;
  /** Whether X processes it after the upload (GIFs and videos). */
  processed: boolean;
}

const MB = 1024 * 1024;
export const IMAGE_MAX_BYTES = 5 * MB;
export const GIF_MAX_BYTES = 15 * MB;
export const VIDEO_MAX_BYTES = 512 * MB;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function sniffMedia(bytes: Uint8Array): MediaKind | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: 'image/jpeg', category: 'tweet_image', maxBytes: IMAGE_MAX_BYTES, processed: false };
  }
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return { type: 'image/png', category: 'tweet_image', maxBytes: IMAGE_MAX_BYTES, processed: false };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { type: 'image/webp', category: 'tweet_image', maxBytes: IMAGE_MAX_BYTES, processed: false };
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return { type: 'image/gif', category: 'tweet_gif', maxBytes: GIF_MAX_BYTES, processed: true };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    return { type: ascii(bytes, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4', category: 'tweet_video', maxBytes: VIDEO_MAX_BYTES, processed: true };
  }
  return undefined;
}

/** Standard base64 (with + / and padding), as X's JSON upload takes it. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
