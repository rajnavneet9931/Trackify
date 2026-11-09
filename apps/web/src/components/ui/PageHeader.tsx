import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useDocumentTitle } from './useDocumentTitle';

export interface Crumb {
  label: string;
  /** Omitted for the current page. */
  to?: string;
}

/**
 * The one page header used across the app, always in the same order:
 * breadcrumbs (the full path, the last one being this page), then the title
 * with an optional badge and the page's actions, then optional tabs.
 * Also names the browser tab after the page.
 */
export function PageHeader({
  crumbs,
  title,
  badge,
  subtitle,
  actions,
  tabs,
  documentTitle,
}: {
  crumbs: Crumb[];
  title: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** Defaults to `title`. */
  documentTitle?: string;
}) {
  useDocumentTitle(documentTitle ?? title);
  return (
    <div>
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-slate-500">
          {crumbs.map((crumb, i) => (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="text-slate-400">
                  ›
                </span>
              )}
              {crumb.to ? (
                <Link
                  to={crumb.to}
                  className="max-w-[16rem] truncate rounded hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="max-w-[16rem] truncate text-slate-700">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <header className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900 sm:text-3xl">
              {title}
            </h1>
            {badge}
          </div>
          {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {tabs}
    </div>
  );
}
