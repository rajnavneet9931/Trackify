import { normalizeEmail, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/validation';

/** Same rules as the API (account.validators.ts); the server checks again. */
export const NAME_MAX_LENGTH = 100;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function validateName(name: string): string | undefined {
  const value = name.normalize('NFC').trim();
  if (value.length > NAME_MAX_LENGTH) return `Name must be at most ${NAME_MAX_LENGTH} characters`;
  if (CONTROL_CHARS.test(value)) return 'Name must not contain control characters';
  return undefined;
}

export type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';
export type PasswordErrors = Partial<Record<PasswordField, string>>;

/** The registration policy, plus: different from the current one, confirmed. */
export function validatePasswordChange(
  { currentPassword, newPassword, confirmPassword }: Record<PasswordField, string>,
  email: string,
): PasswordErrors {
  const errors: PasswordErrors = {};
  if (!currentPassword) errors.currentPassword = 'Current password is required';

  if (!newPassword) errors.newPassword = 'New password is required';
  else if (newPassword.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  } else if (newPassword.length > PASSWORD_MAX_LENGTH) {
    errors.newPassword = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  } else if (newPassword.trim().length === 0) {
    errors.newPassword = 'Password must not be only whitespace';
  } else if (newPassword.trim().toLowerCase() === normalizeEmail(email)) {
    errors.newPassword = 'Password must not be the same as your email address';
  } else if (
    currentPassword &&
    newPassword.normalize('NFKC') === currentPassword.normalize('NFKC')
  ) {
    errors.newPassword = 'New password must be different from the current one';
  }

  if (!confirmPassword) errors.confirmPassword = 'Confirm your new password';
  else if (confirmPassword !== newPassword) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

/** Time zones the browser knows, for the picker (with UTC first). */
export function timeZoneOptions(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...zones.filter((zone) => zone !== 'UTC')];
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
