import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';

const VALID_URL = 'postgresql://user:s3cret@localhost:5432/trackify';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL });

    expect(config).toMatchObject({
      env: 'development',
      port: 4000,
      logLevel: 'info',
      http: { corsOrigins: ['http://localhost:5173'], trustProxy: 0, bodyLimit: '100kb' },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses comma-separated CORS origins', () => {
    const config = loadConfig({
      DATABASE_URL: VALID_URL,
      CORS_ORIGINS: 'https://app.trackify.dev, https://admin.trackify.dev',
    });

    expect(config.http.corsOrigins).toEqual([
      'https://app.trackify.dev',
      'https://admin.trackify.dev',
    ]);
  });

  it('fails fast with every invalid variable listed', () => {
    expect(() => loadConfig({ PORT: 'abc', NODE_ENV: 'staging' })).toThrow(ConfigError);

    try {
      loadConfig({ PORT: 'abc', NODE_ENV: 'staging' });
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('NODE_ENV');
    }
  });

  it('never echoes secret values in error messages', () => {
    const secretUrl = 'mysql://admin:topsecret@db:3306/x';

    expect(() => loadConfig({ DATABASE_URL: secretUrl })).toThrow(ConfigError);
    try {
      loadConfig({ DATABASE_URL: secretUrl });
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('topsecret');
    }
  });
});
