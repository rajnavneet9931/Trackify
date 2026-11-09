/**
 * Trackify's shared visual vocabulary (see the tokens in index.css): one set
 * of class names for buttons, panels, form controls, chips and links, so every
 * page looks and behaves the same. Plain Tailwind classes; no component library.
 *
 * Scale: body text 14px (`text-sm`), labels and metadata 12px (`text-xs`),
 * section titles 14px semibold, page titles 24–28px bold. Spacing in 4px
 * steps; panels are 8px-rounded white surfaces with hairline borders.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerOutline' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white shadow-panel hover:bg-brand-700',
  secondary: 'border border-slate-300 bg-white text-slate-700 shadow-panel hover:bg-slate-50',
  danger: 'bg-rose-600 text-white shadow-panel hover:bg-rose-700 focus-visible:outline-rose-600',
  dangerOutline:
    'border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 focus-visible:outline-rose-600',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs',
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60 ${SIZES[size]} ${VARIANTS[variant]}`;
}

/** A white surface: the one container style (no shadow-heavy cards). */
export const cardClass = 'rounded-lg border border-slate-200 bg-white shadow-panel';
export const cardPadding = 'p-4 sm:p-5';

/** Panel header row: small semibold title, actions on the right. */
export const panelHeaderClass =
  'flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5';
export const panelTitleClass = 'text-sm font-semibold text-slate-900';

export const linkClass =
  'text-sm font-medium text-brand-700 hover:text-brand-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

export const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-panel placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50';

/** Compact select/input for toolbars and inline property editing. */
export const compactControlClass =
  'h-8 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 shadow-panel focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:opacity-60';

export const chipClass =
  'inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand-800';

export const sectionHeadingClass = 'text-sm font-semibold text-slate-900';

/** Uppercase micro-label above values (property lists, KPI tiles). */
export const eyebrowClass = 'text-xs font-medium text-slate-500';
