import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Real-database tests are opt-in: they run only when TEST_DATABASE_URL is set
// (in the shell or apps/api/.env.test) and are skipped otherwise.
const { TEST_DATABASE_URL = '' } = { ...loadEnv('test', process.cwd(), 'TEST_'), ...process.env };
const devEnv = loadEnv('development', process.cwd(), ['DATABASE_URL', 'DIRECT_DATABASE_URL']);
const devUrls = [devEnv.DATABASE_URL, devEnv.DIRECT_DATABASE_URL].filter(Boolean) as string[];
const databaseOf = (url: string) => {
  const { hostname, pathname } = new URL(url);
  return `${hostname.replace('-pooler', '')}${pathname}`;
};

// Integration tests write rows, so never let them reach the development database.
if (
  TEST_DATABASE_URL &&
  devUrls.some(
    (url) => url === TEST_DATABASE_URL || databaseOf(url) === databaseOf(TEST_DATABASE_URL),
  )
) {
  throw new Error(
    'TEST_DATABASE_URL must point to a separate test database, not the development database in .env',
  );
}

// Database names the runtime guard (tests/support/database.ts) must never write to.
const devDatabaseNames = [
  ...new Set(devUrls.map((url) => decodeURIComponent(new URL(url).pathname.slice(1)))),
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Placeholder for config validation; unit tests never connect to it.
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/trackify_test',
      TEST_DATABASE_URL,
      TRACKIFY_DEV_DATABASE_NAMES: devDatabaseNames.join(','),
      // High enough not to interfere; rate-limit tests set their own low limit.
      REGISTER_RATE_LIMIT_MAX: '1000',
      LOGIN_RATE_LIMIT_MAX: '1000',
      LOGIN_ACCOUNT_RATE_LIMIT_MAX: '1000',
    },
  },
});
