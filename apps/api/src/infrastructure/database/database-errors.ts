/**
 * Classification of database failures, so callers can respond with a safe
 * 503 instead of a 500, and log a summary without connection details.
 */

/** Driver-adapter error kinds that mean "the database cannot serve requests right now". */
const UNAVAILABLE_KINDS = new Set([
  'DatabaseNotReachable',
  'DatabaseDoesNotExist',
  'DatabaseAccessDenied',
  'AuthenticationFailed',
  'TlsConnectionError',
  'TooManyConnections',
  'ConnectionClosed',
  'SocketTimeout',
]);

/** Errors raised by `pg` itself before Prisma wraps them (e.g. connect timeout). */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const PG_CONNECTION_MESSAGE = /^Connection terminated/;

/**
 * Transient contention, safe to retry later: lock_timeout expired (55P03),
 * serialization failure (40001), deadlock (40P01). The transaction was rolled
 * back, so the client gets the generic 503 rather than a 500.
 */
const TRANSIENT_SQLSTATES = new Set(['55P03', '40001', '40P01']);

/**
 * Prisma client errors that mean "too busy right now", not a bug:
 * - P2028: an interactive transaction could not start within `maxWait`, or
 *   expired after `timeout` (rolled back). Seen under load as
 *   "Transaction API error: Unable to start a transaction in the given time."
 * - P2024: timed out waiting for a connection from the pool.
 * Nothing was committed, so the client gets the generic 503 (retry later).
 */
const TRANSIENT_PRISMA_CODES = new Set(['P2028', 'P2024']);

const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi;

export interface DatabaseErrorSummary {
  /** Stable category, e.g. `DatabaseNotReachable`, `AuthenticationFailed`, `Timeout`. */
  kind: string;
  /** Prisma (`P…`), PostgreSQL SQLSTATE or Node errno code, when known. */
  code?: string;
  /** Error message with any URLs removed. For server logs only — never send to clients. */
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function driverAdapterCause(err: unknown): Record<string, unknown> | undefined {
  const meta = asRecord(asRecord(err)?.meta);
  return asRecord(asRecord(meta?.driverAdapterError)?.cause);
}

function errorCode(err: unknown): string | undefined {
  const code = asRecord(err)?.code;
  return typeof code === 'string' ? code : undefined;
}

export class DatabaseTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'DatabaseTimeoutError';
  }
}

export function isDatabaseUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof DatabaseTimeoutError) return true;
  if (err.name === 'PrismaClientInitializationError') return true;
  if (
    err.name === 'PrismaClientKnownRequestError' &&
    TRANSIENT_PRISMA_CODES.has(errorCode(err) ?? '')
  ) {
    return true;
  }

  const cause = driverAdapterCause(err);
  if (typeof cause?.originalCode === 'string' && TRANSIENT_SQLSTATES.has(cause.originalCode)) {
    return true;
  }
  const kind = cause?.kind;
  if (typeof kind === 'string') return UNAVAILABLE_KINDS.has(kind);

  const code = errorCode(err);
  if (code && NETWORK_ERROR_CODES.has(code)) return true;
  return PG_CONNECTION_MESSAGE.test(err.message);
}

/** Produces a log-safe description of a database error. */
export function summarizeDatabaseError(err: unknown): DatabaseErrorSummary {
  const cause = driverAdapterCause(err);
  const kind =
    (typeof cause?.kind === 'string' && cause.kind) ||
    (err instanceof DatabaseTimeoutError && 'Timeout') ||
    (err instanceof Error && PG_CONNECTION_MESSAGE.test(err.message) && 'ConnectionTimeout') ||
    (err instanceof Error && err.name) ||
    'Unknown';

  const code =
    (typeof cause?.originalCode === 'string' && cause.originalCode) || errorCode(err) || undefined;

  const rawMessage =
    typeof cause?.originalMessage === 'string'
      ? cause.originalMessage
      : err instanceof Error
        ? err.message
        : String(err);

  return {
    kind,
    ...(code && { code }),
    message: rawMessage.replace(CREDENTIAL_URL, '[redacted-url]').trim().slice(0, 500),
  };
}

/**
 * True when `error` is Prisma's unique-constraint violation (P2002) on the
 * named index. With driver adapters, Prisma reports the index under
 * meta.driverAdapterError.cause.constraint.index.
 */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (asRecord(error)?.code !== 'P2002') return false;
  const constraint = asRecord(driverAdapterCause(error)?.constraint);
  return constraint?.index === indexName;
}
