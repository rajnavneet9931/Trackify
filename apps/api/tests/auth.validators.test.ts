import { describe, expect, it } from 'vitest';

import { registerBodySchema } from '../src/modules/auth/auth.validators.js';

const VALID = { email: 'ada@example.com', password: 'correct horse battery' };

function issues(input: unknown) {
  const result = registerBodySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('registerBodySchema', () => {
  it('accepts a valid body and normalizes the email', () => {
    const result = registerBodySchema.parse({
      ...VALID,
      email: '  Ada.Lovelace+Work@Example.COM ',
    });

    expect(result).toEqual({ email: 'ada.lovelace+work@example.com', password: VALID.password });
  });

  it('never alters the password', () => {
    const password = '  spaces kept intact  ';
    expect(registerBodySchema.parse({ ...VALID, password }).password).toBe(password);
  });

  it.each([
    ['not an email', 'not-an-email'],
    ['missing domain', 'ada@'],
    ['empty', ''],
    ['too long', `${'a'.repeat(250)}@example.com`],
  ])('rejects an invalid email (%s)', (_label, email) => {
    expect(issues({ ...VALID, email })).toEqual([expect.stringMatching(/^email: /)]);
  });

  it.each([
    ['too short', 'short', 'at least 12 characters'],
    ['too long', 'x'.repeat(129), 'at most 128 characters'],
    ['only whitespace', ' '.repeat(16), 'only whitespace'],
    ['same as email', 'Ada@Example.com', 'same as your email'],
  ])('rejects an invalid password (%s)', (_label, password, message) => {
    const email = password.includes('@') ? 'ada@example.com' : VALID.email;
    expect(issues({ email, password })).toEqual([expect.stringContaining(message)]);
  });

  it('accepts passwords at the length boundaries', () => {
    expect(issues({ ...VALID, password: 'x'.repeat(12) })).toEqual([]);
    expect(issues({ ...VALID, password: 'x'.repeat(128) })).toEqual([]);
  });

  it('reports missing fields individually', () => {
    expect(issues({})).toEqual(['email: Email is required', 'password: Password is required']);
  });

  it('rejects wrong types', () => {
    expect(issues({ email: 42, password: ['x'] })).toEqual(
      expect.arrayContaining([
        'email: Email must be a string',
        'password: Password must be a string',
      ]),
    );
  });

  it.each([
    ['role', { role: 'admin' }],
    ['id', { id: '00000000-0000-0000-0000-000000000000' }],
    ['passwordHash', { passwordHash: '$argon2id$...' }],
  ])('rejects unexpected field %s (no mass assignment)', (field, extra) => {
    const result = registerBodySchema.safeParse({ ...VALID, ...extra });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(field);
  });

  it('rejects non-object bodies', () => {
    expect(registerBodySchema.safeParse(undefined).success).toBe(false);
    expect(registerBodySchema.safeParse([VALID]).success).toBe(false);
  });
});
