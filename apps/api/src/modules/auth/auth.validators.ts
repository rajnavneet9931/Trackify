import { z } from 'zod';

import { emailSchema } from '../users/index.js';

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound keeps hashing cost bounded; long passphrases still fit comfortably. */
export const PASSWORD_MAX_LENGTH = 128;

const requiredString = (field: string) =>
  z.string({
    error: (issue) =>
      issue.input === undefined ? `${field} is required` : `${field} must be a string`,
  });

// Length is the only composition rule (NIST SP 800-63B); no forced symbols or digits.
// The password is never trimmed or otherwise altered here.
export const passwordSchema = requiredString('Password')
  .min(PASSWORD_MIN_LENGTH, {
    error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  })
  .refine((password) => password.trim().length > 0, {
    error: 'Password must not be only whitespace',
  });

/**
 * `POST /auth/register` body. Strict: any field other than email and password
 * (e.g. `role`, `id`) is rejected rather than silently ignored.
 */
export const registerBodySchema = z
  .strictObject({ email: emailSchema, password: passwordSchema })
  .refine(({ email, password }) => password.trim().toLowerCase() !== email, {
    path: ['password'],
    error: 'Password must not be the same as your email address',
  });

export type RegisterBody = z.infer<typeof registerBodySchema>;

/**
 * `POST /auth/login` body. Same email normalization as registration. The
 * password is only bounded, not checked against the current policy, so a
 * future policy change never locks out existing accounts.
 */
export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: requiredString('Password')
    .min(1, { error: 'Password is required' })
    .max(PASSWORD_MAX_LENGTH, {
      error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    }),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
