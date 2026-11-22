// Emails and phone numbers, normalized and hashed the way Google asks for
// Customer Match and enhanced conversions, in the Google Ads API and the Data
// Manager API alike: SHA-256 of the normalized text, as lower-case hex.

import { sha256Hex } from '../../core/index.js';

export const MAX_MATCH_IDENTIFIERS = 10_000;

/**
 * Trimmed and in lower case; for gmail.com and googlemail.com also without
 * dots and without a "+suffix" in the name, as Google normalizes them.
 */
export function normalizeEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return undefined;
  let name = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!/^[^\s@]+$/.test(name) || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) return undefined;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const plus = name.indexOf('+');
    name = (plus === -1 ? name : name.slice(0, plus)).replace(/\./g, '');
  }
  return name ? `${name}@${domain}` : undefined;
}

/** E.164: a plus sign, the country code and the number, digits only. */
export function normalizePhone(raw: string): string | undefined {
  const text = raw.trim();
  if (!text.startsWith('+')) return undefined;
  const number = text.slice(1).replace(/[\s().-]/g, '');
  return /^[1-9][0-9]{7,14}$/.test(number) ? `+${number}` : undefined;
}

export interface IdentifierArgs {
  emails?: string[];
  phones?: string[];
  hashed_emails?: string[];
  hashed_phones?: string[];
}

export interface Hashed {
  emails: string[];
  phones: string[];
  skippedEmails: number[];
  skippedPhones: number[];
}

/** Hashes the plain emails and phones (skipping the invalid ones, by index) and adds the hashes given as they are. */
export async function hashIdentifiers(args: IdentifierArgs): Promise<Hashed> {
  const result: Hashed = { emails: [], phones: [], skippedEmails: [], skippedPhones: [] };
  for (const [index, email] of (args.emails ?? []).entries()) {
    const normalized = normalizeEmail(email);
    if (normalized) result.emails.push(await sha256Hex(normalized));
    else result.skippedEmails.push(index);
  }
  for (const [index, phone] of (args.phones ?? []).entries()) {
    const normalized = normalizePhone(phone);
    if (normalized) result.phones.push(await sha256Hex(normalized));
    else result.skippedPhones.push(index);
  }
  result.emails.push(...(args.hashed_emails ?? []).map((hash) => hash.toLowerCase()));
  result.phones.push(...(args.hashed_phones ?? []).map((hash) => hash.toLowerCase()));
  return result;
}

/** How many emails and phones were given, plain and hashed. */
export function identifierCount(args: IdentifierArgs): number {
  return (args.emails?.length ?? 0) + (args.phones?.length ?? 0) + (args.hashed_emails?.length ?? 0) + (args.hashed_phones?.length ?? 0);
}

/** At most 100 indices of skipped inputs, with their count. */
export function skippedSummary(indices: number[]): Record<string, unknown> | undefined {
  return indices.length ? { count: indices.length, first_indices: indices.slice(0, 100) } : undefined;
}

export const IDENTIFIER_LISTS = {
  emails: { type: 'array' as const, maxItems: MAX_MATCH_IDENTIFIERS, items: { type: 'string' as const, maxLength: 320 }, description: 'Email addresses in plain text; they are normalized and hashed with SHA-256 before anything is sent.' },
  phones: { type: 'array' as const, maxItems: MAX_MATCH_IDENTIFIERS, items: { type: 'string' as const, maxLength: 40 }, description: 'Phone numbers in E.164 form with the country code, e.g. "+15551234567"; hashed with SHA-256 before sending.' },
};

const SHA256_HEX = { type: 'string' as const, pattern: '^[A-Fa-f0-9]{64}$' };

export const HASHED_LISTS = {
  hashed_emails: { type: 'array' as const, maxItems: MAX_MATCH_IDENTIFIERS, items: SHA256_HEX, description: 'Emails already normalized and hashed with SHA-256 (hex).' },
  hashed_phones: { type: 'array' as const, maxItems: MAX_MATCH_IDENTIFIERS, items: SHA256_HEX, description: 'E.164 phone numbers already hashed with SHA-256 (hex).' },
};

export const CONSENT = {
  ad_user_data_consent: { type: 'string' as const, enum: ['GRANTED', 'DENIED'], description: 'The people\'s consent to sending their data to Google for ads, required for people in the EEA.' },
  ad_personalization_consent: { type: 'string' as const, enum: ['GRANTED', 'DENIED'], description: 'Their consent to personalized advertising, required for people in the EEA.' },
};
