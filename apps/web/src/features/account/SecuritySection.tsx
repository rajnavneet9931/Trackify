import { useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { PASSWORD_MIN_LENGTH } from '../auth/validation';
import { changePassword } from './account.api';
import {
  validatePasswordChange,
  type PasswordErrors,
  type PasswordField,
} from './account-validation';
import { primaryButton, sectionClass } from './ProfileSection';

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' };

/**
 * Change password. On success the API has ended every session (this one
 * too), so the app signs out and the login page explains why. Passwords live
 * only in this form's state and are cleared after each attempt's outcome.
 */
export function SecuritySection({ email }: { email: string }) {
  const { invalidateSession } = useAuth();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const set = (field: PasswordField) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const next = validatePasswordChange(values, email);
    setErrors(next);
    setFormError(undefined);
    if (Object.values(next).some(Boolean)) return;
    setSaving(true);
    try {
      await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      setValues(EMPTY);
      invalidateSession('password-changed'); // → login page with a notice
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        const fieldErrors: PasswordErrors = {};
        for (const d of Array.isArray(err.details) ? err.details : []) {
          const { path, message } = d as { path?: unknown; message?: unknown };
          if (
            (path === 'currentPassword' || path === 'newPassword') &&
            typeof message === 'string'
          ) {
            fieldErrors[path] = message;
          }
        }
        setErrors(fieldErrors);
        if (Object.keys(fieldErrors).length === 0) setFormError(err.message);
        setValues((v) => ({ ...v, currentPassword: '' }));
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError('Too many attempts. Please wait a few minutes and try again.');
      } else {
        setFormError('We couldn’t change your password. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="security-heading" className={sectionClass}>
      <h2 id="security-heading" className="text-base font-semibold">
        Security
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Changing your password signs you out on every device.
      </p>
      <form noValidate onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <TextField
          label="Current password"
          type="password"
          value={values.currentPassword}
          onValueChange={set('currentPassword')}
          error={errors.currentPassword}
          autoComplete="current-password"
          disabled={saving}
        />
        <TextField
          label="New password"
          type="password"
          value={values.newPassword}
          onValueChange={set('newPassword')}
          error={errors.newPassword}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
          autoComplete="new-password"
          disabled={saving}
        />
        <TextField
          label="Confirm new password"
          type="password"
          value={values.confirmPassword}
          onValueChange={set('confirmPassword')}
          error={errors.confirmPassword}
          autoComplete="new-password"
          disabled={saving}
        />
        <button type="submit" disabled={saving} className={primaryButton}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
