import type { ReactNode } from 'react';

import { buttonClass } from './styles';

/** "Loading …" for screen readers, with optional skeleton rows for the eye. */
export function LoadingState({ label, rows = 0 }: { label: string; rows?: number }) {
  return (
    <div className="mt-4">
      <p role="status" className={rows > 0 ? 'sr-only' : 'text-sm text-slate-500'}>
        {label}
      </p>
      {rows > 0 && (
        <div aria-hidden="true" className="space-y-3">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-slate-200 bg-white p-4">
              <div className="h-3.5 w-1/3 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-2/3 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Nothing here yet: a short explanation and, optionally, the next step. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white/60 p-6 text-center sm:p-8">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-600">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Something failed: what happened and a way to try again. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
    >
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`mt-3 ${buttonClass('secondary')}`}>
          Try again
        </button>
      )}
    </div>
  );
}
