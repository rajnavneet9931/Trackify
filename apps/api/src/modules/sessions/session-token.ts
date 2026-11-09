import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  generateOpaqueToken,
  hashOpaqueToken,
  isWellFormedOpaqueToken,
} from '../../core/security/opaque-token.js';

const CSRF_CONTEXT = 'trackify:csrf:v1';

/** A new opaque session token. Sent to the browser only; never stored. */
export const generateSessionToken = generateOpaqueToken;

/** Rejects malformed cookies before any database work. */
export const isWellFormedSessionToken = isWellFormedOpaqueToken;

/** What the database stores: SHA-256 of the token (see core/security/opaque-token). */
export const hashSessionToken = hashOpaqueToken;

/**
 * Per-session CSRF token, derived from the session token so nothing extra is
 * stored. Only code that can read API responses (same origin / allowed CORS
 * origin) learns it; a cross-site attacker cannot compute it.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_CONTEXT).digest('base64url');
}

export function csrfTokenMatches(sessionToken: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(deriveCsrfToken(sessionToken));
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
