import { PRIORITY_LABELS, STATUS_LABELS } from './labels';
import type { TaskPriority, TaskStatus } from './tasks.api';

/**
 * Status and priority indicators. Each always pairs its colour with a shape
 * and a word, so meaning never depends on colour alone. "Status:" and
 * "Priority:" prefixes are for screen readers only.
 */

const STATUS_CLASSES: Record<TaskStatus, string> = {
  TODO: 'bg-slate-100 text-slate-700 ring-slate-200',
  IN_PROGRESS: 'bg-sky-50 text-sky-800 ring-sky-200',
  DONE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
};

const pill =
  'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset';

/** The status glyph: hollow circle (to do), half-filled (in progress), check (done). */
export function StatusGlyph({
  status,
  className = 'size-3.5',
}: {
  status: TaskStatus;
  className?: string;
}) {
  if (status === 'DONE') {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={`shrink-0 text-emerald-600 ${className}`}
      >
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="m5 8.2 2 2 4-4.2"
          fill="none"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === 'IN_PROGRESS') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 text-sky-600 ${className}`}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 3.5a4.5 4.5 0 0 1 0 9Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 text-slate-400 ${className}`}>
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.2 1.6"
      />
    </svg>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`${pill} ${STATUS_CLASSES[status]}`}>
      <StatusGlyph status={status} className="size-3" />
      <span className="sr-only">Status: </span>
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  LOW: 'text-slate-400',
  MEDIUM: 'text-amber-500',
  HIGH: 'text-orange-500',
  URGENT: 'text-rose-600',
};
const PRIORITY_LEVEL: Record<TaskPriority, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };

/** Signal bars: one to four filled, in the priority's colour. */
export function PriorityGlyph({ priority }: { priority: TaskPriority }) {
  const level = PRIORITY_LEVEL[priority];
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${PRIORITY_COLOR[priority]}`}
    >
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1 + i * 3.75}
          y={12 - i * 3}
          width="2.5"
          height={3 + i * 3}
          rx="0.75"
          fill="currentColor"
          opacity={i < level ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

/** Priority as glyph + word (compact, no pill), for tables and property lists. */
export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className="inline-flex w-fit shrink-0 items-center gap-1.5 text-xs font-medium text-slate-700">
      <PriorityGlyph priority={priority} />
      <span className="sr-only">Priority: </span>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
