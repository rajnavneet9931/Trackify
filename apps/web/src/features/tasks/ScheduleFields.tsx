import { useId } from 'react';

const inputClass = (invalid: boolean) =>
  `mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:ring-2 focus:outline-none disabled:bg-slate-50 ${
    invalid
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200'
      : 'border-slate-300 focus:border-brand-500 focus:ring-brand-100'
  }`;

/**
 * Due date and optional reminder, in the user's local time (datetime-local
 * values). Clearing a field removes it; the reminder needs a due date first.
 */
export function ScheduleFields({
  dueDate,
  reminderAt,
  onDueDateChange,
  onReminderAtChange,
  error,
  disabled,
}: {
  /** datetime-local values ('' = none). */
  dueDate: string;
  reminderAt: string;
  onDueDateChange: (value: string) => void;
  onReminderAtChange: (value: string) => void;
  /** Problem with the pair (shown on the reminder field). */
  error?: string | undefined;
  disabled: boolean;
}) {
  const dueId = useId();
  const reminderId = useId();
  const errorId = error ? `${reminderId}-error` : undefined;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={dueId} className="block text-sm font-medium text-slate-800">
          Due date <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <input
          id={dueId}
          type="datetime-local"
          name="dueDate"
          value={dueDate}
          onChange={(e) => onDueDateChange(e.target.value)}
          disabled={disabled}
          className={inputClass(false)}
        />
      </div>
      <div>
        <label htmlFor={reminderId} className="block text-sm font-medium text-slate-800">
          Reminder <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <input
          id={reminderId}
          type="datetime-local"
          name="reminderAt"
          value={reminderAt}
          max={dueDate || undefined}
          onChange={(e) => onReminderAtChange(e.target.value)}
          disabled={disabled || (!dueDate && !reminderAt)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className={inputClass(Boolean(error))}
        />
        {error ? (
          <p id={errorId} className="mt-1 text-sm text-rose-600">
            {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            {dueDate ? 'An in-app reminder, at or before the due date.' : 'Set a due date first.'}
          </p>
        )}
      </div>
    </div>
  );
}
