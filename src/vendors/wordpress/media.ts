// The file types a WordPress media library takes by default, told by their
// first bytes (a server's Content-Type is not trusted), and a safe file name
// with the extension WordPress checks against the content.

export interface FileType {
  mime: string;
  ext: string;
}

export const MEDIA_TYPES_TEXT = 'JPEG, PNG, GIF, WebP, AVIF or HEIC images, MP4, MOV, WebM or MKV video, MP3, WAV or OGG audio, and PDF';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VP', 'MSNV', 'mmp4']);

export function sniffFile(bytes: Uint8Array): FileType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { mime: 'image/gif', ext: 'gif' };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') {
    const kind = ascii(bytes, 8, 4);
    if (kind === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    if (kind === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
    if (brand === 'heic' || brand === 'heix') return { mime: 'image/heic', ext: 'heic' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov' };
    if (MP4_BRANDS.has(brand)) return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes('webm') ? { mime: 'video/webm', ext: 'webm' } : { mime: 'video/x-matroska', ext: 'mkv' };
  }
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  // An MPEG audio frame header (the layer bits are never 00 for MP3).
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0 && ((bytes[1] as number) & 0x06) !== 0) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  return undefined;
}

/**
 * A file name WordPress accepts: the given name or the URL's last path segment,
 * reduced to letters, digits, dots, dashes and underscores, with the extension
 * of the type the bytes show.
 */
export function uploadName(given: string | undefined, url: string, ext: string): string {
  let base = given ?? '';
  if (!base) {
    try {
      base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    } catch {
      base = '';
    }
  }
  base = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
  return `${base || 'upload'}.${ext}`;
}
