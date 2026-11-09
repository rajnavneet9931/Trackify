/**
 * Applies committed migrations to the isolated test database with
 * `prisma migrate deploy` (never resets, never creates a shadow database).
 *
 *   npm run db:test:deploy
 *
 * Reads TEST_DIRECT_DATABASE_URL (or TEST_DATABASE_URL) from the environment
 * or apps/api/.env.test, and refuses to run if it matches a development URL.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

function readEnvFile(path: string): Record<string, string | undefined> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

const dev = readEnvFile('.env');
const test = { ...readEnvFile('.env.test'), ...process.env };
const target = test.TEST_DIRECT_DATABASE_URL || test.TEST_DATABASE_URL;

if (!target) {
  console.error('TEST_DATABASE_URL is not set (see apps/api/.env.test.example).');
  process.exit(1);
}

const devUrls = [dev.DATABASE_URL, dev.DIRECT_DATABASE_URL].filter(Boolean);
const databaseName = (url: string) => new URL(url).pathname;
if (devUrls.some((url) => url === target || databaseName(url!) === databaseName(target))) {
  console.error('Refusing to migrate: the test database URL points at the development database.');
  process.exit(1);
}

console.log(`Applying migrations to test database "${databaseName(target).slice(1)}"…`);
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // DIRECT_DATABASE_URL takes precedence in prisma.config.ts over values from .env.
  env: { ...process.env, DIRECT_DATABASE_URL: target },
});
process.exit(result.status ?? 1);
