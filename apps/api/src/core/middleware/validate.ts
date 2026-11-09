import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { ValidationError } from '../errors/app-error.js';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and replaces `req.body`, `req.query` and `req.params` with their
 * parsed (typed, coerced) values, so controllers only ever see whitelisted input.
 * Unknown keys are dropped by `z.object` and rejected by `z.strictObject`; use
 * the strict form for request bodies that create or modify data.
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: { location: string; path: string; message: string }[] = [];
    const parsed: Partial<Record<keyof RequestSchemas, unknown>> = {};

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;

      const result = schema.safeParse(req[location]);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params as Request['params'];
    // Express 5 exposes `req.query` as a getter, so redefine it on the instance.
    if ('query' in parsed) {
      Object.defineProperty(req, 'query', {
        value: parsed.query,
        writable: true,
        enumerable: true,
      });
    }

    next();
  };
}
