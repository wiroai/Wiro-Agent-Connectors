// The image types Bluesky takes, told by their first bytes (a server's
// Content-Type is not trusted), and their pixel size for the post's aspect
// ratio, so clients lay the image out without cropping.

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
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
    // Start-of-frame markers carry the size; DHT (C4), JPG (C8) and DAC (CC) do not.
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
  if (chunk === 'VP8 ') {
    return valid({ width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff });
  }
  if (chunk === 'VP8L' && at(20) === 0x2f) {
    const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
    return valid({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
  }
  if (chunk === 'VP8X') {
    return valid({ width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) });
  }
  return undefined;
}

/** The pixel size of a JPEG, PNG or WebP image, when its header can be read. */
export function imageSize(bytes: Uint8Array, type: ImageType): Size | undefined {
  if (type === 'image/png') {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return valid({ width: view.getUint32(16), height: view.getUint32(20) });
  }
  if (type === 'image/jpeg') return jpegSize(bytes);
  return webpSize(bytes);
}
