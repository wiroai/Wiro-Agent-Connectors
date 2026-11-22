import { utf8Bytes } from '../../core/index.js';

// Images told apart by their first bytes (a server's Content-Type is not
// trusted), their pixel size for Tumblr's media objects, and the
// multipart/form-data body that carries a post's JSON with its image files.

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
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
export function imageSize(bytes: Uint8Array, type: ImageType): Size | undefined {
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
  return webpSize(bytes);
}

export type FormPart =
  | { name: string; value: string; contentType?: string }
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
      const type = part.contentType ? `Content-Type: ${part.contentType}\r\n` : '';
      chunks.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"\r\n${type}\r\n${part.value}\r\n`));
    }
  }
  chunks.push(utf8Bytes(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
