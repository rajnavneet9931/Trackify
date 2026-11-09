import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import type { AppConfig } from './config/env.js';
import type { Logger } from './config/logger.js';
import { errorHandler } from './core/middleware/error-handler.js';
import { notFoundHandler } from './core/middleware/not-found.js';
import { createRateLimiter } from './core/middleware/rate-limit.js';
import { REQUEST_ID_HEADER, requestLogger } from './core/middleware/request-logger.js';
import { verifyOrigin } from './core/middleware/verify-origin.js';
import type { DatabaseClient } from './infrastructure/database/prisma.js';
import { CSRF_HEADER } from './modules/sessions/index.js';
import { createApiRouter, type ApiRouterDeps } from './routes/index.js';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  overrides?: ApiRouterDeps['overrides'];
}

/**
 * Builds the Express application. Pure factory — no listening, no globals —
 * so it can be instantiated in tests with injected dependencies.
 */
export function createApp({ config, logger, db, overrides }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  // Observability first so every request (including rejected ones) is logged.
  app.use(requestLogger(logger));

  // Security
  app.use(helmet());
  app.use(
    cors({
      origin: [...config.http.corsOrigins],
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', CSRF_HEADER, REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER],
      maxAge: 600,
    }),
  );
  app.use(verifyOrigin(config.http.corsOrigins));
  app.use(API_PREFIX, createRateLimiter(config.http.rateLimit));

  // Parsing (strict size limits)
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.http.bodyLimit }));

  // Routes
  app.use(API_PREFIX, createApiRouter({ config, logger, db, overrides }));

  // Fallthrough
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
