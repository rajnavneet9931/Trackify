import { ApiError } from '../../lib/api-client';

/**
 * Client-side checks mirror the API contract (apps/api auth.validators.ts) so
 * users get instant feedback. They are never stricter than the server, which
 * remains the authority; its field errors are shown as returned.
 */
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type AuthField = 'email' | 'password';
export type FieldErrors = Partial<Record<AuthField, string>>;

// Deliberately loose: "something@something.tld". The server does the full check.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Same normalization the API applies (trim + lower-case). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string): string | undefined {
  const normalized = normalizeEmail(email);
  if (!normalized) return 'Email is required';
  if (normalized.length > EMAIL_MAX_LENGTH) {
    return `Email must be at most ${EMAIL_MAX_LENGTH} characters`;
  }
  if (!EMAIL_SHAPE.test(normalized)) return 'Must be a valid email address';
  return undefined;
}

export function validateRegistration({ email, password }: Record<AuthField, string>): FieldErrors {
  const errors: FieldErrors = {};
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;

  if (!password) errors.password = 'Password is required';
  else if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  } else if (password.trim().length === 0) {
    errors.password = 'Password must not be only whitespace';
  } else if (!emailError && password.trim().toLowerCase() === normalizeEmail(email)) {
    errors.password = 'Password must not be the same as your email address';
  }
  return errors;
}

/** Login only checks presence and bounds: the password policy may change over time. */
export function validateLogin({ email, password }: Record<AuthField, string>): FieldErrors {
  const errors: FieldErrors = {};
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;
  if (!password) errors.password = 'Password is required';
  else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export interface FormFeedback {
  fieldErrors: FieldErrors;
  formError?: string;
}

/** Maps the API's `VALIDATION_ERROR` details (`{ location, path, message }[]`) to fields. */
function serverFieldErrors(details: unknown): FieldErrors {
  const errors: FieldErrors = {};
  if (!Array.isArray(details)) return errors;
  for (const detail of details) {
    const path = (detail as { path?: unknown })?.path;
    const message = (detail as { message?: unknown })?.message;
    if ((path === 'email' || path === 'password') && typeof message === 'string') {
      errors[path] ??= message;
    }
  }
  return errors;
}

/**
 * Turns any failure from an auth request into user-facing feedback. Only
 * messages defined by our API contract (or fixed strings here) are shown;
 * the request ID is included for server faults so support can trace them.
 */
export function describeAuthError(
  error: unknown,
  action: 'sign-in' | 'registration',
): FormFeedback {
  if (!(error instanceof ApiError)) {
    return { fieldErrors: {}, formError: 'Something went wrong. Please try again.' };
  }

  switch (error.status) {
    case 400: {
      const fieldErrors = serverFieldErrors(error.details);
      return hasErrors(fieldErrors)
        ? { fieldErrors }
        : { fieldErrors, formError: 'Please check the form and try again.' };
    }
    case 401:
      return { fieldErrors: {}, formError: 'Invalid email or password.' };
    case 403:
      return {
        fieldErrors: {},
        formError: 'Your request was blocked by a security check. Refresh the page and try again.',
      };
    case 409:
      return { fieldErrors: { email: 'An account with this email address already exists.' } };
    case 429:
      return {
        fieldErrors: {},
        formError: `Too many ${action} attempts. Please wait a few minutes and try again.`,
      };
    case 0:
    case 503:
      return {
        fieldErrors: {},
        formError: 'Trackify is temporarily unavailable. Please try again in a moment.',
      };
    default:
      return {
        fieldErrors: {},
        formError: `Something went wrong. Please try again.${
          error.requestId ? ` (Reference: ${error.requestId})` : ''
        }`,
      };
  }
}
