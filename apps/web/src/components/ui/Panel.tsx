import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { cardClass, panelHeaderClass, panelTitleClass } from './styles';
import { Icon, type IconName } from './Icon';

/**
 * A titled white panel: header row (title, optional action) and a body. The
 * title labels the region for assistive technology.
 */
export function Panel({
  id,
  title,
  action,
  children,
  flush = false,
  className = '',
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** Body without padding (lists that draw their own row dividers). */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`${cardClass} ${className}`}>
      <div className={panelHeaderClass}>
        <h2 id={id} className={panelTitleClass}>
          {title}
        </h2>
        {action}
      </div>
      <div className={flush ? '' : 'p-4 sm:p-5'}>{children}</div>
    </section>
  );
}

const TONES = {
  neutral: 'bg-slate-100 text-slate-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-700',
  info: 'bg-sky-50 text-sky-700',
  danger: 'bg-rose-50 text-rose-700',
} as const;

/**
 * One key number. Becomes a link only when there is a real destination for
 * it (never a fake drill-down).
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  to,
}: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  icon: IconName;
  tone?: keyof typeof TONES;
  to?: string;
}) {
  const body = (
    <>
      <dt className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
        {label}
        <span
          aria-hidden="true"
          className={`inline-flex size-7 items-center justify-center rounded-md ${TONES[tone]}`}
        >
          <Icon name={icon} className="size-4" />
        </span>
      </dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {value}
      </dd>
      {hint && <dd className="mt-0.5 truncate text-xs text-slate-500">{hint}</dd>}
    </>
  );
  return to ? (
    <div className={`${cardClass} relative p-4 transition-colors hover:border-brand-300`}>
      {body}
      <Link
        to={to}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <span className="sr-only">Open {label}</span>
      </Link>
    </div>
  ) : (
    <div className={`${cardClass} p-4`}>{body}</div>
  );
}
