import { useDateTime } from '../account/preferences-context';
import { dueState } from './dates';

const STYLES = {
  overdue: { label: 'Overdue', className: 'bg-rose-50 text-rose-700 ring-rose-200' },
  today: { label: 'Due today', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  soon: { label: 'Due soon', className: 'bg-sky-50 text-sky-700 ring-sky-100' },
} as const;

/** "Overdue", "Due today" or "Due soon"; nothing for other or done tasks. */
export function DueBadge({ dueDate, status }: { dueDate: string | null; status: string }) {
  const { timeZone } = useDateTime();
  const state = dueState(dueDate, status, new Date(), timeZone);
  if (!state) return null;
  const { label, className } = STYLES[state];
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {label}
    </span>
  );
}
