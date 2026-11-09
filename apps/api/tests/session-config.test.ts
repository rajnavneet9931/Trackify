import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';

const BASE = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('session cookie configuration', () => {
  it('development: non-Secure cookie (plain-HTTP localhost), SameSite=Strict, 7-day TTL', () => {
    const { session } = loadConfig({ ...BASE, NODE_ENV: 'development' }).auth;

    expect(session.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(session.cookie).toEqual({
      name: 'trackify_session',
      secure: false,
      sameSite: 'strict',
      path: '/api',
    });
  });

  it('production: Secure by default with the __Secure- prefix', () => {
    const { cookie } = loadConfig({ ...BASE, NODE_ENV: 'production' }).auth.session;

    expect(cookie).toMatchObject({ name: '__Secure-trackify_session', secure: true });
  });

  it('treats an empty SESSION_COOKIE_SECURE as "use the default"', () => {
    const dev = loadConfig({ ...BASE, SESSION_COOKIE_SECURE: '' });
    const prod = loadConfig({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: '' });

    expect(dev.auth.session.cookie.secure).toBe(false);
    expect(prod.auth.session.cookie.secure).toBe(true);
  });

  it('accepts the documented .env.example as-is', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseEnv } = await import('node:util');
    const env = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

    expect(() => loadConfig(env)).not.toThrow();
  });

  it('refuses insecure cookies in production', () => {
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(ConfigError);
  });

  it('refuses SameSite=None without Secure', () => {
    expect(() =>
      loadConfig({ ...BASE, SESSION_COOKIE_SAMESITE: 'none', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SAMESITE/);
  });

  it('bounds the session lifetime', () => {
    expect(() => loadConfig({ ...BASE, SESSION_TTL_HOURS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, SESSION_TTL_HOURS: String(24 * 31) })).toThrow(ConfigError);
  });
});
