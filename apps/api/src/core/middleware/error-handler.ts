import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import {
  isDatabaseUnavailableError,
  summarizeDatabaseError,
} from '../../infrastructure/database/database-errors.js';
import { AppError, ServiceUnavailableError } from '../errors/app-error.js';
import type { ApiError } from '../http/api-response.js';

/** Errors raised by Express' body parser carry a `type` and `status`. */
interface BodyParserError extends Error {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && 'type' in err && 'status' in err;
}

/** Converts any thrown value into a normalized AppError. */
function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  if (isBodyParserError(err)) {
    if (err.type === 'entity.parse.failed') {
      return new AppError(400, 'BAD_REQUEST', 'Malformed JSON in request body');
    }
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err.status >= 400 && err.status < 500) {
      return new AppError(err.status, 'BAD_REQUEST', 'Invalid request body');
    }
  }

  // Connection details, SQL and driver messages stay in the logs only.
  if (isDatabaseUnavailableError(err)) {
    return new ServiceUnavailableError('Service temporarily unavailable. Please try again later.');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

/**
 * Centralized error handler — the single place that turns errors into HTTP
 * responses. Internal details (stack traces, raw messages) are logged but
 * never sent to clients.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = normalizeError(err);

  if (appError.code === 'SERVICE_UNAVAILABLE' && !(err instanceof AppError)) {
    req.log.error({ db: summarizeDatabaseError(err) }, 'Database unavailable');
  } else if (appError.statusCode >= 500) {
    req.log.error({ err }, 'Unhandled error');
  } else {
    req.log.debug({ err: appError }, 'Request failed');
  }

  const body: ApiError = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
      requestId: String(req.id),
    },
  };

  res.status(appError.statusCode).json(body);
};
