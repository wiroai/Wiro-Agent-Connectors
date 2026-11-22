import { ToolFailure, utf8Bytes } from '../../core/index.js';

// A video told apart by its first bytes (a server's Content-Type is not
// trusted), a multipart/form-data body for Pinterest's upload storage, and a
// pause that ends early when the call is cancelled.

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** video/mp4 or video/quicktime from an MP4 or MOV file's ftyp box, else undefined. */
export function sniffVideo(bytes: Uint8Array): { type: string; extension: string } | undefined {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return undefined;
  const brand = ascii(bytes, 8, 4);
  if (brand === 'qt  ') return { type: 'video/quicktime', extension: 'mov' };
  if (['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1', 'M4A '].includes(brand)) return undefined;
  return { type: 'video/mp4', extension: 'mp4' };
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
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
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
