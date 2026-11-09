import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ToastContext, type ToastTone } from './toast-context';

const DISMISS_MS = 5000;

const TONES: Record<ToastTone, string> = {
  success: 'border-emerald-200 bg-white text-emerald-800',
  error: 'border-rose-200 bg-white text-rose-800',
  info: 'border-slate-200 bg-white text-slate-800',
};

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

/**
 * Transient feedback for actions that have no natural place on the page
 * (e.g. "All notifications marked as read"). Announced politely to screen
 * readers; each toast closes itself or with its × button. Inline messages
 * remain the pattern for form results.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = nextId.current++;
      // Newest last, at most three on screen.
      setToasts((list) => [...list.slice(-2), { id, message, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-label="Notifications from Trackify"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${TONES[t.tone]}`}
          >
            <p className="flex-1">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss message"
              className="rounded text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
