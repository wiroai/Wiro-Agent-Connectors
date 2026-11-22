// LinkedIn stores a post's commentary in its "little" text format, where
// | { } @ [ ] ( ) < > # \ * _ ~ are reserved: an unescaped one is read as
// markup, and LinkedIn may drop the rest of the text after it. Plain text is
// turned into little here, so a post reads as written:
// - #hashtag stays a hashtag (a # at the start or after a space or
//   punctuation, followed by letters or digits);
// - @[Name](urn:li:person:...) and @[Name](urn:li:organization:...) stay
//   mentions (the name's own reserved characters are escaped);
// - every other reserved character is escaped with a backslash.

const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const MENTION = /^@\[([^\]\n]{1,200})\]\((urn:li:(?:person|organization|organizationBrand):[A-Za-z0-9_-]{1,100})\)/;
const HASHTAG = /^#[\p{L}\p{N}]+/u;

function escapeText(text: string): string {
  return text.replace(RESERVED, (char) => `\\${char}`);
}

/** Whether a # at this position starts a hashtag: at the start, or after anything but a letter, digit or backslash. */
function hashtagAllowedAfter(previous: string | undefined): boolean {
  return previous === undefined || !/[\p{L}\p{N}\\]/u.test(previous);
}

/** Plain text (with optional mentions) in LinkedIn's little format. */
export function toLittle(text: string): string {
  let out = '';
  let plain = '';
  let index = 0;
  const flush = (): void => {
    out += escapeText(plain);
    plain = '';
  };
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index] as string;
    if (char === '@') {
      const mention = MENTION.exec(rest);
      if (mention) {
        flush();
        out += `@[${escapeText(mention[1] as string)}](${mention[2] as string})`;
        index += mention[0].length;
        continue;
      }
    }
    if (char === '#' && hashtagAllowedAfter(index > 0 ? text[index - 1] : undefined)) {
      const tag = HASHTAG.exec(rest);
      if (tag) {
        flush();
        out += tag[0];
        index += tag[0].length;
        continue;
      }
    }
    plain += char;
    index++;
  }
  flush();
  return out;
}

/** Commentary as LinkedIn returns it, back to readable text: hashtag templates and escapes undone. */
export function fromLittle(text: string): string {
  return text
    .replace(/\{hashtag\|\\?([#＃])\|([^}]*)\}/g, '$1$2')
    .replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');
}
