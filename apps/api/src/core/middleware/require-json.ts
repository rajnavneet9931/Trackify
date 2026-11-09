import type { NextFunction, Request, Response } from 'express';

import { UnsupportedMediaTypeError } from '../errors/app-error.js';

/**
 * Accepts only `application/json` request bodies. Rejects HTML-form encodings,
 * which browsers can send cross-site without a CORS preflight.
 */
export function requireJson(req: Request, _res: Response, next: NextFunction): void {
  if (req.is('application/json')) {
    next();
    return;
  }
  next(new UnsupportedMediaTypeError('Content-Type must be application/json'));
}
