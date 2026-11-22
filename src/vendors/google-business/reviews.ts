import { truncate } from '../../core/index.js';
import { compact } from './google.js';

// Reviews as the Business Profile API v4 returns them, trimmed for an agent.

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const TRANSLATED = '(Translated by Google)';
const ORIGINAL = '(Original)';

/**
 * Google sends a translated review as "(Translated by Google) ... (Original)
 * ..." in one comment, in either order. The reviewer's own words are the
 * "(Original)" part.
 */
export function splitTranslation(comment: unknown): { original: string; translated?: string } {
  const text = typeof comment === 'string' ? comment : '';
  const originalAt = text.indexOf(ORIGINAL);
  const translatedAt = text.indexOf(TRANSLATED);
  if (originalAt < 0) {
    if (translatedAt > 0) {
      return { original: text.slice(0, translatedAt).trim(), translated: text.slice(translatedAt + TRANSLATED.length).trim() };
    }
    return { original: text.trim() };
  }
  const original = translatedAt > originalAt
    ? text.slice(originalAt + ORIGINAL.length, translatedAt)
    : text.slice(originalAt + ORIGINAL.length);
  let translated: string | undefined;
  if (translatedAt >= 0) {
    translated = translatedAt < originalAt
      ? text.slice(translatedAt + TRANSLATED.length, originalAt)
      : text.slice(translatedAt + TRANSLATED.length);
  } else if (originalAt > 0) {
    translated = text.slice(0, originalAt);
  }
  return { original: original.trim(), ...(translated?.trim() ? { translated: translated.trim() } : {}) };
}

/** The owner's reply with Google's moderation state, when the API sends it. */
export function trimReply(reply: any): Record<string, unknown> | undefined {
  if (!reply || typeof reply !== 'object') return undefined;
  return compact({
    comment: typeof reply.comment === 'string' ? truncate(reply.comment, 4096) : undefined,
    updated: reply.updateTime,
    state: reply.reviewReplyState,
    policy_violation: reply.policyViolation,
  });
}

export function reviewId(review: any): string | undefined {
  if (typeof review?.reviewId === 'string' && review.reviewId) return review.reviewId;
  const name = typeof review?.name === 'string' ? review.name : '';
  return name.split('/').pop() || undefined;
}

export function trimReview(review: any): Record<string, unknown> {
  const reviewer = review?.reviewer ?? {};
  const anonymous = reviewer.isAnonymous === true;
  const words = splitTranslation(review?.comment);
  const reply = trimReply(review?.reviewReply);
  return compact({
    id: reviewId(review),
    rating: STARS[String(review?.starRating)],
    reviewer: anonymous ? undefined : (typeof reviewer.displayName === 'string' ? truncate(reviewer.displayName, 200) : undefined),
    anonymous,
    comment: truncate(words.original, 4000),
    translated: words.translated ? truncate(words.translated, 4000) : undefined,
    created: review?.createTime,
    updated: review?.updateTime,
    media: Array.isArray(review?.reviewMediaItems) ? review.reviewMediaItems.length : undefined,
    answered: Boolean(reply),
    reply,
  });
}
