import { ToolFailure, utf8Bytes } from '../../core/index.js';

// Media files told apart by their first bytes (a server's Content-Type is not
// trusted), an image's pixel size, a multipart/form-data body for uploads,
// and a pause that ends early when the call is cancelled.

export type MediaKind = 'image' | 'video' | 'audio';

export interface Sniffed {
  type: string;
  kind: MediaKind;
  extension: string;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** The media type of an image, video or audio file, from its first bytes. */
export function sniffMedia(bytes: Uint8Array): Sniffed | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', kind: 'image', extension: 'jpg' };
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return { type: 'image/png', kind: 'image', extension: 'png' };
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return { type: 'image/gif', kind: 'image', extension: 'gif' };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') {
    if (ascii(bytes, 8, 4) === 'WEBP') return { type: 'image/webp', kind: 'image', extension: 'webp' };
    if (ascii(bytes, 8, 4) === 'WAVE') return { type: 'audio/wave', kind: 'audio', extension: 'wav' };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { type: 'image/avif', kind: 'image', extension: 'avif' };
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(brand)) return { type: 'image/heic', kind: 'image', extension: 'heic' };
    if (brand === 'qt  ') return { type: 'video/quicktime', kind: 'video', extension: 'mov' };
    if (brand === 'M4A ') return { type: 'audio/mp4', kind: 'audio', extension: 'm4a' };
    return { type: 'video/mp4', kind: 'video', extension: 'mp4' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { type: 'video/webm', kind: 'video', extension: 'webm' };
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') return { type: 'audio/ogg', kind: 'audio', extension: 'ogg' };
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'fLaC') return { type: 'audio/flac', kind: 'audio', extension: 'flac' };
  if (bytes.length >= 3 && (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0))) {
    return { type: 'audio/mpeg', kind: 'audio', extension: 'mp3' };
  }
  return undefined;
}

export interface Size {
  width: number;
  height: number;
}

function valid(size: Size): Size | undefined {
  return size.width > 0 && size.height > 0 ? size : undefined;
}

function jpegSize(bytes: Uint8Array): Size | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return valid({
        height: ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number),
        width: ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number),
      });
    }
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  const at = (index: number): number => bytes[index] as number;
  if (chunk === 'VP8 ') return valid({ width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff });
  if (chunk === 'VP8L' && at(20) === 0x2f) {
    const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
    return valid({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
  }
  if (chunk === 'VP8X') return valid({ width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) });
  return undefined;
}

/** The pixel size of a JPEG, PNG, GIF or WebP image, when its header can be read. */
export function imageSize(bytes: Uint8Array, type: string): Size | undefined {
  if (type === 'image/png') {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return valid({ width: view.getUint32(16), height: view.getUint32(20) });
  }
  if (type === 'image/gif') {
    if (bytes.length < 10) return undefined;
    return valid({ width: (bytes[6] as number) | ((bytes[7] as number) << 8), height: (bytes[8] as number) | ((bytes[9] as number) << 8) });
  }
  if (type === 'image/jpeg') return jpegSize(bytes);
  if (type === 'image/webp') return webpSize(bytes);
  return undefined;
}

export type FormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

function quoted(text: string): string {
  return text.replace(/["\r\n\\]/g, (char) => encodeURIComponent(char));
}

/** A multipart/form-data body, with a random boundary. */
export function multipart(parts: FormPart[]): { body: Uint8Array; contentType: string } {
  const random = new Uint8Array(12);
  crypto.getRandomValues(random);
  const boundary = `----form${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if ('bytes' in part) {
      chunks.push(utf8Bytes(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"; filename="${quoted(part.filename)}"\r\n`
          + `Content-Type: ${part.contentType}\r\n\r\n`,
      ));
      chunks.push(part.bytes);
      chunks.push(utf8Bytes('\r\n'));
    } else {
      chunks.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(utf8Bytes(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Waits `ms`, or fails at once with `cancelled` when the call is cancelled. */
export function pause(ms: number, signal: AbortSignal | undefined, cancelled: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolFailure(cancelled));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ToolFailure(cancelled));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
