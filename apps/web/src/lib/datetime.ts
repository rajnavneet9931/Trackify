/**
 * Dates and times shown according to the user's preferences (time zone and
 * date format). The API always speaks UTC ISO timestamps; everything here is
 * presentation. With the defaults (device time zone, LOCALE) the output is
 * exactly what `Intl.DateTimeFormat` gives for the browser.
 */

export type DateFormat = 'LOCALE' | 'ISO' | 'DMY' | 'MDY';

export interface DateTimePrefs {
  /** IANA zone; undefined = the device's zone. */
  timeZone: string | undefined;
  dateFormat: DateFormat;
}

export const DEFAULT_PREFS: DateTimePrefs = { timeZone: undefined, dateFormat: 'LOCALE' };

/** date: "Nov 4, 2026"; longDate: "November 4, 2026"; dateTime: "Nov 4, 2026, 5:00 PM". */
export type DateStyle = 'date' | 'longDate' | 'dateTime';

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, options);
    cache.set(key, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar fields of an instant in a zone (24-hour clock). */
export function zonedParts(date: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function formatDateTime(iso: string, style: DateStyle, prefs: DateTimePrefs): string {
  const date = new Date(iso);
  const { timeZone, dateFormat } = prefs;
  if (dateFormat === 'LOCALE') {
    return formatter({
      dateStyle: style === 'longDate' ? 'long' : 'medium',
      ...(style === 'dateTime' && { timeStyle: 'short' }),
      ...(timeZone && { timeZone }),
    }).format(date);
  }
  const { year, month, day } = zonedParts(date, timeZone);
  const text =
    dateFormat === 'ISO'
      ? `${year}-${pad(month)}-${pad(day)}`
      : dateFormat === 'DMY'
        ? `${pad(day)}/${pad(month)}/${year}`
        : `${pad(month)}/${pad(day)}/${year}`;
  if (style !== 'dateTime') return text;
  const time = formatter({ timeStyle: 'short', ...(timeZone && { timeZone }) }).format(date);
  return `${text}, ${time}`;
}

/** UTC ISO → the `YYYY-MM-DDTHH:mm` a datetime-local input shows, in the zone ('' if none). */
export function toZonedInputValue(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return '';
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetAt(instant: number, timeZone: string | undefined): number {
  const p = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock fields in a zone → the UTC instant (DST-aware; gaps resolve forward). */
export function zonedToUtc(
  fields: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string | undefined,
): Date {
  const guess = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour ?? 0,
    fields.minute ?? 0,
  );
  const first = guess - offsetAt(guess, timeZone);
  return new Date(guess - offsetAt(first, timeZone));
}

/** A datetime-local value in the zone → UTC ISO; '' or invalid → null. */
export function fromZonedInputValue(value: string, timeZone: string | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = zonedToUtc({ year, month, day, hour, minute }, timeZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Start of the calendar day containing `date` in the zone, plus `addDays` days. */
export function startOfZonedDay(date: Date, timeZone: string | undefined, addDays = 0): Date {
  const p = zonedParts(date, timeZone);
  // Date.UTC normalizes day overflow (e.g. Nov 31 → Dec 1).
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return zonedToUtc(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
    timeZone,
  );
}

export function sameZonedDay(a: Date, b: Date, timeZone: string | undefined): boolean {
  const x = zonedParts(a, timeZone);
  const y = zonedParts(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}
