import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque bearer secrets (session tokens, invitation tokens): 256 bits from the
 * OS CSPRNG, base64url-encoded. Only their SHA-256 digest is ever stored, so a
 * database leak yields nothing usable. A fast hash is appropriate because the
 * input is a 256-bit random secret, not a guessable password; lookups go
 * through a unique index on the digest, so there is no timing side channel on
 * the secret itself.
 */
const TOKEN_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Cheap shape check that rejects malformed input before any database work. */
export function isWellFormedOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function hashOpaqueToken(token: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(token).digest());
}
