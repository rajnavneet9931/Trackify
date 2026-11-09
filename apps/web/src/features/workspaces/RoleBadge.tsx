import type { WorkspaceRole } from './workspaces.api';

const ROLES: Record<WorkspaceRole, { label: string; className: string }> = {
  OWNER: { label: 'Owner', className: 'bg-brand-50 text-brand-700 ring-brand-100' },
  MEMBER: { label: 'Member', className: 'bg-slate-100 text-slate-700 ring-slate-200' },
};

/** Workspace role pill. `prefix` is read by screen readers only (e.g. "Your role: "). */
export function RoleBadge({ role, prefix = 'Role: ' }: { role: WorkspaceRole; prefix?: string }) {
  const { label, className } = ROLES[role];
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      <span className="sr-only">{prefix}</span>
      {label}
    </span>
  );
}
