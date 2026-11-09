import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../errors/app-error.js';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Bucket key; defaults to the client IP. */
  keyGenerator?: (req: Request) => string;
  /** Count only failed (4xx/5xx) responses, e.g. failed logins per account. */
  skipSuccessfulRequests?: boolean;
}

/**
 * Fixed-window limiter. Counters live in this process's memory: with several
 * API instances each enforces its own budget (effective limit = max × instances)
 * and counters reset on restart. A shared store is needed for exact global limits.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(options.keyGenerator && { keyGenerator: options.keyGenerator }),
    ...(options.skipSuccessfulRequests && { skipSuccessfulRequests: true }),
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}
