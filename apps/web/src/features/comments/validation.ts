import { COMMENT_MAX_LENGTH } from './comments.api';

/**
 * Mirrors the API's comment rule (apps/api comment.validators.ts): NFC
 * normalized and trimmed, 1–5000 characters, line breaks and tabs allowed but
 * no other control characters. The server stays authoritative.
 */
const CONTROL_CHARACTERS = /[^\P{Cc}\t\n\r]/u;

export function normalizeComment(value: string): string {
  return value.normalize('NFC').trim();
}

export function validateComment(value: string): string | undefined {
  const normalized = normalizeComment(value);
  if (!normalized) return 'Comment is required';
  if (normalized.length > COMMENT_MAX_LENGTH) {
    return `Comment must be at most ${COMMENT_MAX_LENGTH} characters`;
  }
  if (CONTROL_CHARACTERS.test(normalized)) return 'Comment must not contain control characters';
  return undefined;
}
