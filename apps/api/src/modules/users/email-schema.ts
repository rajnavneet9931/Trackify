import { z } from 'zod';

import { EMAIL_MAX_LENGTH, normalizeEmail } from './user.model.js';

/**
 * The one email rule for every request body (registration, login,
 * invitations): normalized with normalizeEmail, then validated.
 */
export const emailSchema = z
  .string({
    error: (issue) => (issue.input === undefined ? 'Email is required' : 'Email must be a string'),
  })
  .max(EMAIL_MAX_LENGTH * 2, { error: 'Email is too long' }) // cheap pre-check before normalizing
  .transform(normalizeEmail)
  .pipe(
    z
      .email({ error: 'Must be a valid email address' })
      .max(EMAIL_MAX_LENGTH, { error: `Email must be at most ${EMAIL_MAX_LENGTH} characters` }),
  );
