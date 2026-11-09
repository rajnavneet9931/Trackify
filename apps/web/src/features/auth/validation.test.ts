import { describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { postLoginPath } from './redirect';
import { describeAuthError, validateLogin, validateRegistration } from './validation';

const PASSWORD = 'correct horse battery staple';

describe('validateRegistration (mirrors the API contract)', () => {
  it('accepts valid input, including email with spaces/caps (normalized by the API)', () => {
    expect(validateRegistration({ email: '  Ada@Example.COM ', password: PASSWORD })).toEqual({});
  });

  it.each([
    ['', PASSWORD, { email: 'Email is required' }],
    ['ada', PASSWORD, { email: 'Must be a valid email address' }],
    [`${'a'.repeat(250)}@x.io`, PASSWORD, { email: 'Email must be at most 254 characters' }],
    ['ada@example.com', '', { password: 'Password is required' }],
    ['ada@example.com', 'short', { password: 'Password must be at least 12 characters' }],
    ['ada@example.com', 'x'.repeat(129), { password: 'Password must be at most 128 characters' }],
    ['ada@example.com', ' '.repeat(12), { password: 'Password must not be only whitespace' }],
    [
      'ada@example.com',
      'ADA@example.com',
      { password: 'Password must not be the same as your email address' },
    ],
  ])('rejects %j / %j', (email, password, expected) => {
    expect(validateRegistration({ email, password })).toEqual(expected);
  });

  it('accepts the length boundaries (12 and 128)', () => {
    expect(validateRegistration({ email: 'a@b.io', password: 'x'.repeat(12) })).toEqual({});
    expect(validateRegistration({ email: 'a@b.io', password: 'x'.repeat(128) })).toEqual({});
  });
});

describe('validateLogin', () => {
  it('only requires a password (no policy check at sign-in)', () => {
    expect(validateLogin({ email: 'ada@example.com', password: 'short' })).toEqual({});
    expect(validateLogin({ email: '', password: '' })).toEqual({
      email: 'Email is required',
      password: 'Password is required',
    });
  });
});

describe('describeAuthError', () => {
  const err = (status: number, details?: unknown) =>
    new ApiError(status, 'X', 'server message', details, 'req-7');

  it('maps server validation details to fields', () => {
    const feedback = describeAuthError(
      err(400, [
        { location: 'body', path: 'email', message: 'Must be a valid email address' },
        { location: 'body', path: '', message: 'Unrecognized key: "role"' },
      ]),
      'registration',
    );
    expect(feedback).toEqual({ fieldErrors: { email: 'Must be a valid email address' } });
  });

  it('uses fixed, non-revealing messages for other statuses', () => {
    expect(describeAuthError(err(401), 'sign-in').formError).toBe('Invalid email or password.');
    expect(describeAuthError(err(409), 'registration').fieldErrors.email).toMatch(/already exists/);
    expect(describeAuthError(err(429), 'sign-in').formError).toMatch(/Too many sign-in attempts/);
    expect(describeAuthError(err(503), 'sign-in').formError).toMatch(/temporarily unavailable/);
    expect(describeAuthError(err(0), 'sign-in').formError).toMatch(/temporarily unavailable/);
    expect(describeAuthError(err(403), 'sign-in').formError).toMatch(/security check/);
    expect(describeAuthError(err(500), 'sign-in').formError).toBe(
      'Something went wrong. Please try again. (Reference: req-7)',
    );
    expect(describeAuthError(new Error('boom: secret'), 'sign-in').formError).not.toContain(
      'secret',
    );
  });
});

describe('postLoginPath', () => {
  const from = (pathname: string, search = '', hash = '') => ({ from: { pathname, search, hash } });

  it('returns the preserved internal destination', () => {
    expect(postLoginPath(from('/account', '?tab=1', '#x'))).toBe('/account?tab=1#x');
  });

  it.each([
    ['no state', null],
    ['protocol-relative', from('//evil.example/path')],
    ['backslash trick', from('/\\evil.example')],
    ['absolute URL', from('https://evil.example')],
    ['login loop', from('/login')],
    ['register', from('/register')],
  ])('falls back to /account for %s', (_label, state) => {
    expect(postLoginPath(state)).toBe('/account');
  });
});
