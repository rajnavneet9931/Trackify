import { Link } from 'react-router';

import type { ProjectCompletion } from './dashboard.api';

/**
 * Charts without a charting library: horizontal bars drawn with CSS. Each is
 * a single series in the brand color (no legend needed), every value is also
 * printed as text, and the markup is a list, so screen readers and print get
 * the same numbers as the bars.
 */

const track = 'h-2 w-full overflow-hidden rounded-full bg-slate-100';
const bar = 'h-full rounded-full bg-brand-600';

/**
 * One stacked bar for a whole distribution (e.g. tasks by status). Purely a
 * visual overview: the same numbers are listed as text right below it.
 */
export function StackedBar({
  segments,
  total,
}: {
  segments: { key: string; value: number; className: string }[];
  total: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100"
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.key}
            className={`h-full first:rounded-l-full last:rounded-r-full ${s.className}`}
            style={{ width: `${(s.value / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

const percentOf = (value: number, total: number) =>
  total === 0 ? 0 : Math.round((value / total) * 100);

/** Bars scaled to the total (share of all tasks), with count and share as text. */
export function BarList({
  label,
  items,
  total,
}: {
  label: string;
  items: { key: string; label: string; value: number }[];
  total: number;
}) {
  return (
    <ul aria-label={label} className="mt-3 space-y-3">
      {items.map((item) => {
        const share = percentOf(item.value, total);
        return (
          <li key={item.key} title={`${item.label}: ${item.value} (${share}%)`}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-slate-700">{item.label}</span>
              <span className="text-slate-900 tabular-nums">
                {item.value}
                <span className="ml-1 text-xs text-slate-500">({share}%)</span>
              </span>
            </div>
            <div className={`mt-1 ${track}`} aria-hidden="true">
              {item.value > 0 && <div className={bar} style={{ width: `${share}%` }} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Completion per active project, linking to each project. */
export function ProjectCompletionList({
  workspaceId,
  projects,
  activeCount,
}: {
  workspaceId: string;
  projects: ProjectCompletion[];
  activeCount: number;
}) {
  if (projects.length === 0) {
    return <p className="text-sm text-slate-500">No active projects.</p>;
  }
  return (
    <>
      <ul aria-label="Completion by project" className="space-y-3">
        {projects.map((p) => (
          <li
            key={p.id}
            title={`${p.name}: ${p.doneTasks} of ${p.totalTasks} tasks done (${p.completionPercent}%)`}
          >
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <Link
                to={`/workspaces/${workspaceId}/projects/${p.id}`}
                className="min-w-0 truncate font-medium text-slate-800 hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                {p.name}
              </Link>
              <span className="shrink-0 text-slate-900 tabular-nums">
                {p.totalTasks === 0 ? (
                  <span className="text-xs text-slate-500">No tasks yet</span>
                ) : (
                  <>
                    {p.completionPercent}%
                    <span className="ml-1 text-xs text-slate-500">
                      ({p.doneTasks}/{p.totalTasks} done)
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className={`mt-1 ${track}`} aria-hidden="true">
              {p.completionPercent > 0 && (
                <div className={bar} style={{ width: `${p.completionPercent}%` }} />
              )}
            </div>
          </li>
        ))}
      </ul>
      {activeCount > projects.length && (
        <p className="mt-3 text-xs text-slate-500">
          Showing the {projects.length} newest of {activeCount} active projects.
        </p>
      )}
    </>
  );
}
