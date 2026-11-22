// Text and byte helpers on web-standard globals only (TextEncoder, btoa, atob),
// so the bundled modules need nothing from Node.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Cuts a string to at most `max` code points, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * A vendor's error text, made safe to show: one line, no control characters,
 * at most `max` code points. HTML pages (gateway errors) are dropped.
 */
export function cleanVendorText(text: unknown, max = 300): string | undefined {
  if (typeof text !== 'string') return undefined;
  if (/^\s*</.test(text)) return undefined;
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? truncate(line, max) : undefined;
}

/** "2,000,000" */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
