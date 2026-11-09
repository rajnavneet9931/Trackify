import { forwardRef, useId, type ChangeEvent, type InputHTMLAttributes } from 'react';

interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value' | 'id'
> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string | undefined;
  hint?: string;
}

/**
 * Labelled, controlled input. Errors are linked with aria-describedby and
 * flagged with aria-invalid so screen readers announce them with the field.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, value, onValueChange, error, hint, className, ...inputProps },
  ref,
) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:bg-slate-50 ${
          error
            ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200'
            : 'border-slate-300 focus:border-brand-500 focus:ring-brand-100'
        }`}
        {...inputProps}
      />
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
});
