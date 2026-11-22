// File types told by their first bytes (a server's Content-Type is not
// trusted), and YouTube's ISO 8601 durations.

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** The video container of a file, or undefined when it is not a video YouTube takes. */
export function sniffVideo(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 12) {
    const box = ascii(bytes, 4, 4);
    if (box === 'ftyp') {
      const brand = ascii(bytes, 8, 4);
      if (brand === 'qt  ') return 'video/quicktime';
      if (brand.startsWith('3g')) return 'video/3gpp';
      return 'video/mp4';
    }
    if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'video/quicktime';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AVI ') return 'video/x-msvideo';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'FLV') return 'video/x-flv';
  if (bytes.length >= 16 && [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11].every((value, index) => bytes[index] === value)) return 'video/x-ms-wmv';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba) return 'video/mpeg';
  if (bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'video/mp2t';
  return undefined;
}

/** JPEG or PNG, the image types YouTube takes for a thumbnail. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  return undefined;
}

/** Seconds in an ISO 8601 duration such as PT2M30S or P1DT2H. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return undefined;
  const [, weeks, days, hours, minutes, seconds] = match;
  return Math.round(Number(weeks ?? 0) * 604800 + Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0));
}
