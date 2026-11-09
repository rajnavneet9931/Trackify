/** Longest valid email address (RFC 5321 path limit); matches the column size. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Canonical form of an email address, applied before every write and lookup so
 * the unique index treats `Ada@Example.com ` and `ada@example.com` as the same.
 * Lower-cases the whole address: providers treat local parts case-insensitively
 * in practice. Dots and `+tags` are preserved (they can be distinct mailboxes).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The only user fields ever returned by the API. Never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

/** Explicit field selection shared by every query that returns a PublicUser. */
export const publicUserSelect = {
  id: true,
  email: true,
  createdAt: true,
} as const;
