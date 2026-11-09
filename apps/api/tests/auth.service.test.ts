import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../src/core/errors/app-error.js';
import { AuthService, EMAIL_TAKEN_MESSAGE } from '../src/modules/auth/auth.service.js';
import type { PasswordHasher } from '../src/modules/auth/password-hasher.js';
import { SessionService } from '../src/modules/sessions/index.js';
import { InMemorySessionRepository, InMemoryUserRepository } from './helpers.js';

const fakeHasher: PasswordHasher = {
  hash: vi.fn(async (password: string) => `hashed(${password.length})`),
  verify: vi.fn(),
};

const sessions = new SessionService(new InMemorySessionRepository(), 60_000);

describe('AuthService.register', () => {
  it('stores a normalized email and the hash — never the plaintext password', async () => {
    const users = new InMemoryUserRepository();
    const service = new AuthService(users, fakeHasher, sessions);

    const user = await service.register({
      email: '  Grace@Example.COM ',
      password: 'a-long-secret-phrase',
    });

    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({ email: 'grace@example.com', passwordHash: 'hashed(20)' });
    expect(JSON.stringify(users.rows)).not.toContain('a-long-secret-phrase');
    expect(user).toEqual({
      id: expect.any(String),
      email: 'grace@example.com',
      createdAt: expect.any(Date),
    });
    expect(Object.keys(user)).not.toContain('passwordHash');
  });

  it('maps a duplicate email (any casing) to a 409 ConflictError', async () => {
    const service = new AuthService(new InMemoryUserRepository(), fakeHasher, sessions);
    await service.register({ email: 'grace@example.com', password: 'a-long-secret-phrase' });

    const error = await service
      .register({ email: 'GRACE@example.com', password: 'another-long-phrase' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: EMAIL_TAKEN_MESSAGE,
    });
  });

  it('propagates unexpected repository errors unchanged', async () => {
    const failure = new Error('connection lost');
    const service = new AuthService(
      {
        create: () => Promise.reject(failure),
        findCredentialsByEmail: () => Promise.resolve(null),
      },
      fakeHasher,
      sessions,
    );

    await expect(
      service.register({ email: 'grace@example.com', password: 'a-long-secret-phrase' }),
    ).rejects.toBe(failure);
  });
});
