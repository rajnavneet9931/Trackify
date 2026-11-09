import argon2 from 'argon2';

/**
 * Argon2id with OWASP's recommended baseline (19 MiB memory, 2 iterations,
 * parallelism 1): ~45 ms per hash on a typical CPU. Parameters are stored in
 * each encoded hash, so they can be raised later without breaking old hashes.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/**
 * Unicode-normalizes (NFKC, per NIST SP 800-63B) so visually identical input
 * typed on different devices produces the same hash. Must be applied
 * identically when hashing and verifying.
 */
function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => argon2.hash(normalizePassword(password), ARGON2_OPTIONS),
  verify: (hash, password) => argon2.verify(hash, normalizePassword(password)),
};
