import { env } from '../config/env';

/** Mirrors the API's error envelope: `{ error: { code, message, details?, requestId? } }`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Plain values are sent as JSON; FormData is passed through untouched. */
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CSRF_HEADER = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF token for the current session. Kept only in this module's memory (never
 * in localStorage/sessionStorage or a cookie); it is recovered from
 * `GET /auth/me` after a page reload.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The full success envelope, for endpoints that return `meta` (e.g. pagination). */
export interface ApiEnvelope<T, M = Record<string, unknown>> {
  data: T;
  meta?: M;
}

/**
 * Thin fetch wrapper: JSON in/out, timeouts, cookie credentials, CSRF header
 * on state-changing requests, and a single error type. Unwraps the `{ data }`
 * success envelope.
 *
 * `acceptStatuses` lets callers treat specific non-2xx codes (e.g. 503 from a
 * readiness probe) as valid responses rather than errors.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  acceptStatuses: readonly number[] = [],
): Promise<T> {
  return (await apiRequestEnvelope<T>(path, options, acceptStatuses)).data;
}

/** Same as apiRequest, but returns `{ data, meta }` instead of only `data`. */
export async function apiRequestEnvelope<T, M = Record<string, unknown>>(
  path: string,
  { body, timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...init }: RequestOptions = {},
  acceptStatuses: readonly number[] = [],
): Promise<ApiEnvelope<T, M>> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const method = (init.method ?? 'GET').toUpperCase();
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const isJson = body !== undefined && !isFormData;

  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      ...init,
      method,
      signal,
      // Sends the HttpOnly session cookie; the browser manages it, never this code.
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        // FormData sets its own multipart boundary, so no Content-Type for it.
        ...(isJson && { 'Content-Type': 'application/json' }),
        ...(csrfToken && UNSAFE_METHODS.has(method) && { [CSRF_HEADER]: csrfToken }),
        ...headers,
      },
      ...(body !== undefined && { body: isFormData ? (body as FormData) : JSON.stringify(body) }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    throw new ApiError(
      0,
      timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      timedOut ? 'The server took too long to respond' : 'Unable to reach the server',
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const headerRequestId = response.headers.get('x-request-id') ?? undefined;

  if (response.ok || acceptStatuses.includes(response.status)) {
    if (isRecord(payload) && 'data' in payload) {
      return {
        data: payload.data as T,
        ...(isRecord(payload.meta) && { meta: payload.meta as M }),
      };
    }
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'Unexpected response from server',
      undefined,
      headerRequestId,
    );
  }

  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  throw new ApiError(
    response.status,
    typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
    typeof error?.message === 'string' ? error.message : `Request failed (${response.status})`,
    error?.details,
    typeof error?.requestId === 'string' ? error.requestId : headerRequestId,
  );
}
