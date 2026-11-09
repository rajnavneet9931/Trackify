import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),
  // Per-process pool size. Total connections = API instances × this value; keep that
  // below the server's max_connections (or route through a pooler such as PgBouncer).
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Upper bound for opening a new connection (pg's own default of 0 waits forever).
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  // Time budget for the readiness probe's database check; allows for serverless cold starts.
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** How often the in-process reminder processor runs; 0 disables it. */
  REMINDER_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  BODY_LIMIT: z.string().default('100kb'),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  // Stricter per-IP limit for registration (each attempt costs an Argon2 hash).
  REGISTER_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Login limits: all attempts per IP, and failed attempts per account (email).
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_ACCOUNT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  // Absolute session lifetime; there is no sliding renewal.
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  // Defaults to true in production, false otherwise (plain-HTTP local development).
  // An empty value (e.g. `SESSION_COOKIE_SECURE=` in .env) means "use the default".
  SESSION_COOKIE_SECURE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.stringbool().optional(),
  ),
  SESSION_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

  // Invitations expire after this many hours (bounded: 1 hour to 30 days).
  INVITATION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  // DEVELOPMENT ONLY: include the raw invitation token (as an accept link) in the
  // create response, because no email delivery is configured. Defaults to true
  // in development, false otherwise; startup fails if enabled in production.
  INVITATION_DEV_LINKS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.stringbool().optional(),
  ),
  // Invitations an owner may create per window (per user, not per IP).
  INVITATION_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  INVITATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly database: DatabaseConfig;
  readonly health: { readonly dbTimeoutMs: number };
  readonly reminders: { readonly pollIntervalMs: number };
  readonly auth: {
    readonly registerRateLimit: RateLimitConfig;
    readonly loginRateLimit: RateLimitConfig;
    readonly loginAccountRateLimit: RateLimitConfig;
    readonly session: SessionConfig;
  };
  readonly invitations: {
    readonly ttlMs: number;
    /** Development only: return the accept link in the API response (no email delivery). */
    readonly exposeDevLinks: boolean;
    readonly createRateLimit: RateLimitConfig;
  };
  readonly http: {
    readonly corsOrigins: readonly string[];
    readonly trustProxy: number;
    readonly bodyLimit: string;
    readonly rateLimit: { readonly windowMs: number; readonly max: number };
  };
}

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly max: number;
}

export interface SessionConfig {
  readonly ttlMs: number;
  readonly cookie: {
    /** `__Secure-` prefixed when secure, so browsers refuse it over plain HTTP. */
    readonly name: string;
    readonly secure: boolean;
    readonly sameSite: 'strict' | 'lax' | 'none';
    /** Sent only to API routes, never to the SPA's own paths. */
    readonly path: string;
  };
}

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables and maps them to a typed, immutable config.
 * Only variable names and messages are reported on failure — never values,
 * so secrets cannot leak into logs.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = result.data;
  const isProduction = env.NODE_ENV === 'production';
  const cookieSecure = env.SESSION_COOKIE_SECURE ?? isProduction;
  const exposeDevLinks = env.INVITATION_DEV_LINKS ?? env.NODE_ENV === 'development';

  const issues: string[] = [];
  if (isProduction && exposeDevLinks) {
    issues.push(
      'INVITATION_DEV_LINKS: must not be enabled in production (it exposes invitation tokens)',
    );
  }
  if (isProduction && !cookieSecure) {
    issues.push('SESSION_COOKIE_SECURE: must be true in production (cookies over HTTPS only)');
  }
  if (env.SESSION_COOKIE_SAMESITE === 'none' && !cookieSecure) {
    issues.push('SESSION_COOKIE_SAMESITE: "none" requires SESSION_COOKIE_SECURE=true');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    database: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
    }),
    health: Object.freeze({ dbTimeoutMs: env.HEALTH_DB_TIMEOUT_MS }),
    reminders: Object.freeze({ pollIntervalMs: env.REMINDER_POLL_INTERVAL_MS }),
    auth: Object.freeze({
      registerRateLimit: Object.freeze({
        windowMs: env.REGISTER_RATE_LIMIT_WINDOW_MS,
        max: env.REGISTER_RATE_LIMIT_MAX,
      }),
      loginRateLimit: Object.freeze({
        windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
        max: env.LOGIN_RATE_LIMIT_MAX,
      }),
      loginAccountRateLimit: Object.freeze({
        windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
        max: env.LOGIN_ACCOUNT_RATE_LIMIT_MAX,
      }),
      session: Object.freeze({
        ttlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
        cookie: Object.freeze({
          name: cookieSecure ? '__Secure-trackify_session' : 'trackify_session',
          secure: cookieSecure,
          sameSite: env.SESSION_COOKIE_SAMESITE,
          path: '/api',
        }),
      }),
    }),
    invitations: Object.freeze({
      ttlMs: env.INVITATION_TTL_HOURS * 60 * 60 * 1000,
      exposeDevLinks,
      createRateLimit: Object.freeze({
        windowMs: env.INVITATION_RATE_LIMIT_WINDOW_MS,
        max: env.INVITATION_RATE_LIMIT_MAX,
      }),
    }),
    http: Object.freeze({
      corsOrigins: Object.freeze([...env.CORS_ORIGINS]),
      trustProxy: env.TRUST_PROXY,
      bodyLimit: env.BODY_LIMIT,
      rateLimit: Object.freeze({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX }),
    }),
  });
}
