export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'GONE'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/**
 * Base class for expected (operational) errors. Messages of AppErrors are
 * considered safe to return to clients; anything else is treated as a 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

/** The resource existed but is permanently unusable (e.g. an expired invitation). */
export class GoneError extends AppError {
  constructor(message = 'Resource is no longer available') {
    super(410, 'GONE', message);
  }
}

/** Well-formed request that cannot be processed given current data. */
export class UnprocessableEntityError extends AppError {
  constructor(message = 'Request cannot be processed') {
    super(422, 'UNPROCESSABLE_ENTITY', message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}
