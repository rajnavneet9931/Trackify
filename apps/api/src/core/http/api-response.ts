import type { Response } from 'express';

import type { ErrorCode } from '../errors/app-error.js';

/** Envelope for every successful JSON response. */
export interface ApiSuccess<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Envelope for every error JSON response. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiSuccess<T> = meta ? { data, meta } : { data };
  res.status(statusCode).json(body);
}
