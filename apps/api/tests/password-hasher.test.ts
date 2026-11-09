import { describe, expect, it } from 'vitest';

import { argon2PasswordHasher } from '../src/modules/auth/password-hasher.js';

const PASSWORD = 'correct horse battery staple';

describe('argon2PasswordHasher', () => {
  it('produces an Argon2id hash with the configured parameters', async () => {
    const hash = await argon2PasswordHasher.hash(PASSWORD);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain(PASSWORD);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      argon2PasswordHasher.hash(PASSWORD),
      argon2PasswordHasher.hash(PASSWORD),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await argon2PasswordHasher.hash(PASSWORD);

    await expect(argon2PasswordHasher.verify(hash, PASSWORD)).resolves.toBe(true);
    await expect(argon2PasswordHasher.verify(hash, `${PASSWORD} `)).resolves.toBe(false);
    await expect(argon2PasswordHasher.verify(hash, PASSWORD.toUpperCase())).resolves.toBe(false);
  });

  it('treats Unicode-equivalent input as the same password (NFKC)', async () => {
    const composed = 'paßwörd-café-12'; // é as one code point
    const decomposed = 'paßwörd-café-12'; // é as e + combining accent

    const hash = await argon2PasswordHasher.hash(composed);
    await expect(argon2PasswordHasher.verify(hash, decomposed)).resolves.toBe(true);
  });
});
