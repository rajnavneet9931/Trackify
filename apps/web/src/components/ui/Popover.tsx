import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A button that toggles a floating panel (filters, sort, account menu).
 * Closes on Escape (returning focus to the button) and on a click outside.
 * The panel stays mounted while closed (hidden), so form fields inside keep
 * their state and labels.
 */
export function Popover({
  label,
  buttonContent,
  buttonClassName,
  children,
  align = 'left',
  panelClassName = 'w-72',
}: {
  /** Accessible name of the toggle button. */
  label: string;
  buttonContent: ReactNode;
  buttonClassName: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={buttonClassName}
      >
        {buttonContent}
      </button>
      <div
        id={id}
        hidden={!open}
        className={`absolute z-30 mt-1.5 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-3 shadow-pop ${
          align === 'right' ? 'right-0' : 'left-0'
        } ${panelClassName}`}
      >
        {children(() => setOpen(false))}
      </div>
    </div>
  );
}
