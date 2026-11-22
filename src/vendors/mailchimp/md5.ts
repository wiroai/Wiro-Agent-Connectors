// MD5 of a text's UTF-8 bytes, as lower-case hex. Mailchimp names a list
// member by the MD5 of its lower-cased email address (the subscriber hash);
// WebCrypto has no MD5, so the module computes it here. It is an identifier,
// not a security measure.

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

const K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

export function md5Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length;
  // The message, a 1 bit, zeros, then the length in bits: a whole number of 64-byte blocks.
  const words = new Uint32Array((((length + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < length; i++) words[i >>> 2] |= bytes[i] << ((i % 4) * 8);
  words[length >>> 2] |= 0x80 << ((length % 4) * 8);
  words[words.length - 2] = (length * 8) >>> 0;
  words[words.length - 1] = Math.floor(length / 0x20000000);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  for (let block = 0; block < words.length; block += 16) {
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (A + f + (K[i] as number) + (words[block + g] as number)) >>> 0;
      const shift = SHIFTS[(i >>> 4) * 4 + (i % 4)] as number;
      const next = D;
      D = C;
      C = B;
      B = (B + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      A = next;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }
  return [a, b, c, d]
    .map((word) => [0, 8, 16, 24].map((offset) => ((word >>> offset) & 0xff).toString(16).padStart(2, '0')).join(''))
    .join('');
}

/** Mailchimp's subscriber hash: the MD5 of the lower-cased email address. */
export function subscriberHash(email: string): string {
  return md5Hex(email.trim().toLowerCase());
}
