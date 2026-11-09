/**
 * Initials avatar. The colour is derived from the person's id (or name), so
 * the same person always looks the same, from a restrained set of tints that
 * keep the initials readable (WCAG AA on each background). Decorative: the
 * name is always written next to it.
 */
const TINTS = [
  'bg-indigo-100 text-indigo-800',
  'bg-sky-100 text-sky-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-900',
  'bg-rose-100 text-rose-800',
  'bg-violet-100 text-violet-800',
  'bg-teal-100 text-teal-800',
  'bg-slate-200 text-slate-800',
];

function initialsOf(label: string): string {
  const base = label.includes('@') ? label.split('@')[0]! : label;
  const words = base
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters =
    words.length >= 2
      ? `${words[0]![0]}${words[words.length - 1]![0]}`
      : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

function tintFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length]!;
}

export function Avatar({
  label,
  seed,
  size = 'md',
}: {
  /** Display name or email: the initials come from it. */
  label: string;
  /** Stable key for the colour (e.g. the user id); defaults to the label. */
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = { sm: 'size-6 text-[10px]', md: 'size-7 text-xs', lg: 'size-9 text-sm' };
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]} ${tintFor(seed ?? label)}`}
    >
      {initialsOf(label)}
    </span>
  );
}
