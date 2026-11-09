import type { NextFunction, Request, Response } from 'express';

import { NotFoundError } from '../errors/app-error.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}
