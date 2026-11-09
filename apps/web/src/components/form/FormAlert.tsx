import type { ReactNode } from 'react';

const TONES = {
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  info: 'border-brand-100 bg-brand-50 text-brand-700',
} as const;

/**
 * Inline message box. Errors use role="alert" (announced immediately);
 * other tones use role="status".
 */
export function FormAlert({
  tone = 'error',
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border px-3 py-2 text-sm ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
