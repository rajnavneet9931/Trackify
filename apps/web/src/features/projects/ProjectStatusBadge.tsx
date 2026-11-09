import type { ProjectStatus } from './projects.api';

const STATUSES: Record<ProjectStatus, { label: string; className: string }> = {
  ACTIVE: { label: 'Active', className: 'bg-emerald-50 text-emerald-700 ring-emerald-100' },
  ARCHIVED: { label: 'Archived', className: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

/** Project status pill; "Status:" is read by screen readers only. */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { label, className } = STATUSES[status];
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      <span className="sr-only">Status: </span>
      {label}
    </span>
  );
}
