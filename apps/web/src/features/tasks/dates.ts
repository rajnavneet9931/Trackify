import { fromZonedInputValue, sameZonedDay, toZonedInputValue } from '../../lib/datetime';

/**
 * Due dates and reminders are stored and sent as UTC ISO timestamps, and
 * entered and shown in the user's time zone (their preference, else the
 * device's) through `<input type="datetime-local">`.
 */

/** UTC ISO → the `YYYY-MM-DDTHH:mm` value a datetime-local input expects ('' if none). */
export function toLocalInputValue(iso: string | null, timeZone?: string): string {
  return toZonedInputValue(iso, timeZone);
}

/** A datetime-local value (in the zone) → UTC ISO; '' → null. */
export function fromLocalInputValue(value: string, timeZone?: string): string | null {
  return value ? fromZonedInputValue(value, timeZone) : null;
}

/** Same rules as the API (task.validators.ts scheduleProblem). */
export function scheduleProblem(dueDate: string | null, reminderAt: string | null) {
  if (reminderAt && !dueDate) return 'A reminder requires a due date';
  if (reminderAt && dueDate && new Date(reminderAt).getTime() > new Date(dueDate).getTime()) {
    return 'The reminder cannot be after the due date';
  }
  return undefined;
}

export type DueState = 'overdue' | 'today' | 'soon' | null;

/** "Soon" means within the next 48 hours (but not today). */
const SOON_MS = 48 * 3_600_000;

/**
 * Overdue (deadline passed), due today (same calendar day in the user's zone),
 * or due soon (within 48 hours). Done tasks and tasks without a deadline have
 * no state.
 */
export function dueState(
  dueDate: string | null,
  status: string,
  now = new Date(),
  timeZone?: string,
): DueState {
  if (!dueDate || status === 'DONE') return null;
  const due = new Date(dueDate);
  if (due.getTime() < now.getTime()) return 'overdue';
  if (sameZonedDay(due, now, timeZone)) return 'today';
  if (due.getTime() - now.getTime() <= SOON_MS) return 'soon';
  return null;
}
