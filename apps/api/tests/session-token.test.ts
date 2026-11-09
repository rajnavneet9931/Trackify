import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  csrfTokenMatches,
  deriveCsrfToken,
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from '../src/modules/sessions/session-token.js';

describe('session tokens', () => {
  it('are 256-bit base64url strings and unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));

    expect(tokens.size).toBe(1000);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('are stored as their SHA-256 digest, never verbatim', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).toHaveLength(32);
    expect(Buffer.from(hash).equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(Buffer.from(hash).toString('base64url')).not.toBe(token);
  });

  it.each([
    ['too short', 'abc'],
    ['bad characters', `${'a'.repeat(42)}=`],
    ['too long', 'a'.repeat(44)],
    ['not a string', 42],
  ])('rejects malformed tokens (%s)', (_label, value) => {
    expect(isWellFormedSessionToken(value)).toBe(false);
  });
});

describe('CSRF tokens', () => {
  it('are bound to the session and differ from the session token', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();

    expect(deriveCsrfToken(a)).toBe(deriveCsrfToken(a));
    expect(deriveCsrfToken(a)).not.toBe(deriveCsrfToken(b));
    expect(deriveCsrfToken(a)).not.toBe(a);
  });

  it('match only the token derived from the same session', () => {
    const session = generateSessionToken();

    expect(csrfTokenMatches(session, deriveCsrfToken(session))).toBe(true);
    expect(csrfTokenMatches(session, deriveCsrfToken(generateSessionToken()))).toBe(false);
    expect(csrfTokenMatches(session, session)).toBe(false);
    expect(csrfTokenMatches(session, undefined)).toBe(false);
    expect(csrfTokenMatches(session, '')).toBe(false);
  });
});
