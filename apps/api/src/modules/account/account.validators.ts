import { z } from 'zod';

import { passwordSchema, PASSWORD_MAX_LENGTH } from '../auth/index.js';
import { DateFormat, NAME_MAX_LENGTH } from './account.model.js';

// Control characters (C0, DEL, C1) never belong in a display name.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Display name: NFC + trim; empty (or null) clears it. */
const nameSchema = z
  .string({ error: 'name must be a string or null' })
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .max(NAME_MAX_LENGTH, { error: `Name must be at most ${NAME_MAX_LENGTH} characters` })
      .refine((value) => !CONTROL_CHARS.test(value), {
        error: 'Name must not contain control characters',
      }),
  )
  .transform((value) => (value === '' ? null : value))
  .nullable();

/**
 * `PATCH /users/me`. Strict: only the display name can change. `email`,
 * `password`, `id`, roles or anything else is a 400 (email is immutable).
 */
export const updateProfileBodySchema = z.strictObject({ name: nameSchema });
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

/** `PATCH /users/me/password`. The new password follows the registration policy. */
export const changePasswordBodySchema = z
  .strictObject({
    currentPassword: z
      .string({ error: 'Current password is required' })
      .min(1, { error: 'Current password is required' })
      .max(PASSWORD_MAX_LENGTH, {
        error: `Current password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      }),
    newPassword: passwordSchema,
  })
  .refine(
    ({ currentPassword, newPassword }) =>
      currentPassword.normalize('NFKC') !== newPassword.normalize('NFKC'),
    { path: ['newPassword'], error: 'New password must be different from the current one' },
  );
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

/** Case-insensitive lookup of the zone names this runtime lists (plus UTC). */
const KNOWN_ZONES = new Map(
  [...Intl.supportedValuesOf('timeZone'), 'UTC'].map((zone) => [zone.toLowerCase(), zone]),
);

/**
 * A time zone this runtime understands, or null. Kept as the user wrote it
 * (ICU would turn "Asia/Kolkata" into its legacy alias "Asia/Calcutta"); only
 * the letter case is corrected when the name is in the runtime's list.
 */
export function canonicalTimeZone(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    return null; // RangeError: unknown time zone
  }
  return KNOWN_ZONES.get(value.toLowerCase()) ?? value;
}

const timeZoneSchema = z
  .string({ error: 'timeZone must be a string or null' })
  .max(64, { error: 'timeZone must be at most 64 characters' })
  .transform((value, ctx) => {
    const zone = canonicalTimeZone(value);
    if (!zone) {
      ctx.addIssue({ code: 'custom', message: 'timeZone must be a valid IANA time zone' });
      return z.NEVER;
    }
    return zone;
  })
  .nullable();

const flag = (name: string) => z.boolean({ error: `${name} must be true or false` });

/** `PATCH /users/me/settings`: any subset, at least one field. */
export const updateSettingsBodySchema = z
  .strictObject({
    timeZone: timeZoneSchema.optional(),
    dateFormat: z
      .enum(DateFormat, { error: 'dateFormat must be one of LOCALE, ISO, DMY, MDY' })
      .optional(),
    notifications: z
      .strictObject({
        taskAssigned: flag('taskAssigned').optional(),
        taskCommented: flag('taskCommented').optional(),
        taskReminder: flag('taskReminder').optional(),
      })
      .refine((n) => Object.keys(n).length > 0, {
        error: 'notifications must contain at least one preference',
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'Provide at least one setting to change',
  });
export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;

export const noInputSchema = z.strictObject({});
