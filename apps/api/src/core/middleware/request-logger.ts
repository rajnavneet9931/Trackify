import { randomUUID } from 'node:crypto';

import { pinoHttp } from 'pino-http';

import type { Logger } from '../../config/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept caller-supplied IDs only if they are short and safe to echo/log.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Structured per-request logging. Assigns every request an ID (reusing a
 * well-formed upstream `X-Request-Id` for tracing) and echoes it back.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
