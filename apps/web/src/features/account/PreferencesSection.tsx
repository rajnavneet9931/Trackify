import { useId, useMemo, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { ApiError } from '../../lib/api-client';
import { formatDateTime, type DateFormat } from '../../lib/datetime';
import { useAuth } from '../auth/auth-context';
import { updateSettings, type AccountSettings } from './account.api';
import { deviceTimeZone, timeZoneOptions } from './account-validation';
import { usePreferences } from './preferences-context';
import { primaryButton, sectionClass } from './ProfileSection';

const selectClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50';

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'LOCALE', label: 'Browser default' },
  { value: 'ISO', label: 'Year-month-day' },
  { value: 'DMY', label: 'Day/month/year' },
  { value: 'MDY', label: 'Month/day/year' },
];

const NOTIFICATIONS: { key: keyof AccountSettings['notifications']; label: string }[] = [
  { key: 'taskAssigned', label: 'A task is assigned to me' },
  { key: 'taskCommented', label: 'Someone comments on my tasks' },
  { key: 'taskReminder', label: 'Reminders for due tasks' },
];

/** A fixed sample instant, so each format can be previewed. */
const SAMPLE = '2026-11-04T17:30:00.000Z';

/**
 * Time zone, date format and in-app notification types. Saved together; the
 * whole app shows dates with the new settings as soon as they're saved.
 */
export function PreferencesSection() {
  const { invalidateSession } = useAuth();
  const { settings, loaded, setSettings } = usePreferences();
  const id = useId();
  const zones = useMemo(() => timeZoneOptions(), []);
  const [draft, setDraft] = useState<AccountSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const current = draft ?? settings;

  const change = (next: AccountSettings) => {
    setDraft(next);
    setSaved(false);
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const updated = await updateSettings({
        timeZone: current.timeZone,
        dateFormat: current.dateFormat,
        notifications: current.notifications,
      });
      setSettings(updated);
      setDraft(null);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setError(
        err instanceof ApiError && err.status === 400
          ? err.message
          : 'We couldn’t save your preferences. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const preview = formatDateTime(SAMPLE, 'dateTime', {
    timeZone: current.timeZone ?? undefined,
    dateFormat: current.dateFormat,
  });

  return (
    <section aria-labelledby="preferences-heading" className={sectionClass}>
      <h2 id="preferences-heading" className="text-base font-semibold">
        Preferences
      </h2>
      {!loaded && (
        <p role="status" className="mt-1 text-xs text-slate-500">
          Loading your saved preferences…
        </p>
      )}
      <form noValidate onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
        {error && <FormAlert>{error}</FormAlert>}
        {saved && <FormAlert tone="success">Preferences saved.</FormAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-zone`} className="block text-sm font-medium text-slate-800">
              Time zone
            </label>
            <select
              id={`${id}-zone`}
              value={current.timeZone ?? ''}
              onChange={(e) => change({ ...current, timeZone: e.target.value || null })}
              disabled={saving}
              className={selectClass}
            >
              <option value="">Device default ({deviceTimeZone()})</option>
              {current.timeZone && !zones.includes(current.timeZone) && (
                <option value={current.timeZone}>{current.timeZone}</option>
              )}
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-format`} className="block text-sm font-medium text-slate-800">
              Date format
            </label>
            <select
              id={`${id}-format`}
              value={current.dateFormat}
              onChange={(e) => change({ ...current, dateFormat: e.target.value as DateFormat })}
              disabled={saving}
              className={selectClass}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Example: <span className="font-medium text-slate-700">{preview}</span>. Applies to
          deadlines, reminders, comments and activity everywhere in Trackify.
        </p>

        <fieldset>
          <legend className="text-sm font-medium text-slate-800">In-app notifications</legend>
          <p className="text-xs text-slate-500">
            Turned-off types aren’t created for you and are hidden from your notifications.
          </p>
          <div className="mt-2 space-y-2">
            {NOTIFICATIONS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={current.notifications[key]}
                  onChange={(e) =>
                    change({
                      ...current,
                      notifications: { ...current.notifications, [key]: e.target.checked },
                    })
                  }
                  disabled={saving}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <button type="submit" disabled={saving || !draft} className={primaryButton}>
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
      </form>
    </section>
  );
}
