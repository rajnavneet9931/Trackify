import type { NextFunction, Request, Response } from 'express';

import { ForbiddenError } from '../errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF layer 1 (all unsafe requests, including login and registration):
 * rejects requests a browser marks as cross-site, using Fetch Metadata and the
 * Origin header. Requests without either header (curl, server-to-server) are
 * not browser-initiated CSRF and pass through. Authenticated routes add a
 * per-session CSRF token on top (see requireSession).
 */
export function verifyOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const fetchSite = req.get('sec-fetch-site');
    const origin = req.get('origin');

    if (fetchSite === 'cross-site' && !(origin && allowed.has(origin))) {
      next(new ForbiddenError('Cross-site request rejected'));
      return;
    }
    if (origin !== undefined && !allowed.has(origin)) {
      next(new ForbiddenError('Cross-site request rejected'));
      return;
    }
    next();
  };
}
