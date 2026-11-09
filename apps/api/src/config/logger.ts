import { pino, type Logger } from 'pino';

import type { AppConfig } from './env.js';

export type { Logger };

/** Paths scrubbed from every log line. Extend as sensitive fields are introduced. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.csrfToken',
  '*.sessionToken',
  '*.connectionString',
  '*.databaseUrl',
  'database.url',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'env'>): Logger {
  // ECS/runtime images omit dev dependencies such as pino-pretty.
  // Enable it only when explicitly requested in a development installation.
  const usePrettyTransport = config.env === 'development' && process.env.LOG_PRETTY === 'true';

  return pino({
    level: config.logLevel,
    base: { service: 'trackify-api', env: config.env },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(usePrettyTransport && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    }),
  });
}
