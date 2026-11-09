import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma CLI does not load .env automatically; use Node's built-in loader.
// Variables already set in the environment (e.g. by CI) take precedence.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // CLI-only connection (migrate, studio, db pull). Migrations need a direct,
    // non-pooled connection, so DIRECT_DATABASE_URL wins when set; the running
    // API always uses DATABASE_URL. Empty is allowed so `prisma generate` and
    // `prisma validate` work without a database (e.g. in CI).
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '',
  },
});
