import { useEffect, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { TextField } from '../../components/form/TextField';
import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { getProfile, updateProfile, type Profile } from './account.api';
import { NAME_MAX_LENGTH, validateName } from './account-validation';
import { useDateTime, usePreferences } from './preferences-context';

export const sectionClass = 'mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-panel';
export const primaryButton =
  'rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; profile: Profile };

/** Display name (editable), email (read-only: it can't be changed) and member since. */
export function ProfileSection() {
  const { invalidateSession } = useAuth();
  const dt = useDateTime();
  const { setDisplayName } = usePreferences();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getProfile(controller.signal)
      .then((profile) => {
        setState({ status: 'ready', profile });
        setName(profile.name ?? '');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) invalidateSession();
        else setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [attempt, invalidateSession]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || state.status !== 'ready') return;
    const problem = validateName(name);
    setError(problem);
    setFormError(undefined);
    setSaved(false);
    if (problem) return;
    setSaving(true);
    try {
      const value = name.normalize('NFC').trim();
      const profile = await updateProfile({ name: value === '' ? null : value });
      setState({ status: 'ready', profile });
      setName(profile.name ?? '');
      setDisplayName(profile.name);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setFormError(
        err instanceof ApiError && err.status === 400
          ? err.message
          : 'We couldn’t save your profile. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="profile-heading" className={sectionClass}>
      <h2 id="profile-heading" className="text-base font-semibold">
        Profile
      </h2>

      {state.status === 'loading' && (
        <p role="status" className="mt-4 text-sm text-slate-500">
          Loading profile…
        </p>
      )}
      {state.status === 'error' && (
        <div role="alert" className="mt-4 text-sm text-rose-800">
          <p>We couldn’t load your profile.</p>
          <button
            type="button"
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
            className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <form noValidate onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
          {formError && <FormAlert>{formError}</FormAlert>}
          {saved && <FormAlert tone="success">Profile saved.</FormAlert>}
          <TextField
            label="Display name"
            value={name}
            onValueChange={(value) => {
              setName(value);
              setSaved(false);
            }}
            error={error}
            hint="Optional. Shown on your account."
            maxLength={NAME_MAX_LENGTH + 20}
            autoComplete="name"
            disabled={saving}
          />
          <dl className="divide-y divide-slate-100 text-sm">
            <div className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between">
              <dt className="text-slate-600">Email</dt>
              <dd className="font-medium break-all">
                {state.profile.email}
                <span className="block text-xs font-normal text-slate-500">
                  Your email can’t be changed.
                </span>
              </dd>
            </div>
            <div className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between">
              <dt className="text-slate-600">Member since</dt>
              <dd className="font-medium">{dt.format(state.profile.createdAt, 'longDate')}</dd>
            </div>
          </dl>
          <button type="submit" disabled={saving} className={primaryButton}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </form>
      )}
    </section>
  );
}
