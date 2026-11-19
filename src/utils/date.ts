const CAIRO_TZ = 'Africa/Cairo';

/**
 * Get the current Date adjusted to Cairo timezone components.
 */
export function getCairoNow(): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return new Date(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  );
}

/** Format any Date object into YYYY-MM-DD in Africa/Cairo timezone */
export function formatCairoDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/** YYYY-MM-DD in Cairo timezone */
export function getCairoToday(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // en-CA gives YYYY-MM-DD
}

/** YYYY-MM for the current month in Cairo */
export function getCurrentMonth(): string {
  return getCairoToday().slice(0, 7);
}

/** Given YYYY-MM, return the previous month as YYYY-MM */
export function getPreviousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Given YYYY-MM, return the next month as YYYY-MM */
export function getNextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Extract YYYY-MM from a YYYY-MM-DD date string or Date */
export function getMonthFromDate(date: string | Date): string {
  const str = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return str.slice(0, 7);
}

/** Check if a YYYY-MM-DD date falls within a YYYY-MM month */
export function isDateInMonth(date: string, month: string): boolean {
  return getMonthFromDate(date) === month;
}

/** Check if a YYYY-MM month is the current month or any previous month */
export function isCurrentOrPreviousMonth(month: string): boolean {
  const current = getCurrentMonth();
  return compareMonths(month, current) <= 0;
}

/** Check if a YYYY-MM-DD date is in the future relative to Cairo today */
export function isDateInFuture(date: string): boolean {
  return compareDates(date, getCairoToday()) > 0;
}

/** Validate YYYY-MM-DD format and actual date validity */
export function isDateValid(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Validate YYYY-MM format */
export function isMonthValid(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const m = parseInt(month.split('-')[1], 10);
  return m >= 1 && m <= 12;
}

/** Compare two YYYY-MM-DD dates. Returns <0, 0, or >0 */
export function compareDates(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Compare two YYYY-MM months. Returns <0, 0, or >0 */
export function compareMonths(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Get start and end Date objects in UTC for a specific day in Africa/Cairo timezone.
 * Accurately handles daylight saving time and standard time transitions.
 */
export function getCairoDayBounds(dateStr: string): { start: Date; end: Date } {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CAIRO_TZ,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(noonUtc);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+02:00';
  const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
  const sign = match ? (match[1] === '+' ? -1 : 1) : -1;
  const hours = match ? parseInt(match[2], 10) : 2;
  const minutes = match ? parseInt(match[3], 10) : 0;
  const offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;

  const startUtc = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() + offsetMs);
  const endUtc = new Date(new Date(`${dateStr}T23:59:59.999Z`).getTime() + offsetMs);
  return { start: startUtc, end: endUtc };
}
