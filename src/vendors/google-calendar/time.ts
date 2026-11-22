// Times in an IANA time zone, with the Intl API only (no time zone data of our
// own): wall-clock parts of an instant, the instant of a wall-clock time, and
// RFC 3339 text with the zone's offset. Plus the free-slot search the
// availability tool runs on the busy times Google Calendar returns.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_FORMATTERS = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** true when `zone` is an IANA time zone name the runtime knows, such as Europe/Istanbul. */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(zone, found);
  }
  return found;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time of an instant in a time zone. */
export function wallTime(ms: number, zone: string): WallTime {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** The zone's offset from UTC at an instant, in milliseconds (east of UTC is positive). */
export function offsetAt(ms: number, zone: string): number {
  const wall = wallTime(ms, zone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant of a wall-clock time in a zone. A time a clock change skips maps to the instant next to it. */
export function instantOf(year: number, month: number, day: number, hour: number, minute: number, second: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = offsetAt(guess, zone);
  const instant = guess - first;
  const second2 = offsetAt(instant, zone);
  return second2 === first ? instant : guess - second2;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** RFC 3339 text of an instant in a zone, with the zone's offset: 2026-05-11T09:00:00+03:00. */
export function formatInZone(ms: number, zone: string): string {
  const wall = wallTime(ms, zone);
  const offset = Math.round(offsetAt(ms, zone) / MINUTE);
  const abs = Math.abs(offset);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
    + `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** RFC 3339 in UTC without milliseconds: 2026-05-11T06:00:00Z. */
export function formatUtc(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export type ParsedTime =
  | { kind: 'date'; year: number; month: number; day: number }
  | { kind: 'local'; year: number; month: number; day: number; hour: number; minute: number; second: number; text: string }
  | { kind: 'instant'; ms: number; text: string };

export const TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})?)?$';
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A date (2026-05-11), a wall-clock time (2026-05-11T09:00) or an instant (…Z or …+03:00), or null. */
export function parseTime(text: string): ParsedTime | null {
  const match = DATE_TIME.exec(text);
  if (!match) return null;
  const [, y, mo, d, hh, mi, ss, , zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!realDate(year, month, day)) return null;
  if (hh === undefined) return { kind: 'date', year, month, day };
  const hour = Number(hh);
  const minute = Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== undefined) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? { kind: 'instant', ms, text } : null;
  }
  return { kind: 'local', year, month, day, hour, minute, second, text };
}

/** The instant a parsed time stands for in a zone (a date is its midnight). */
export function toInstant(time: ParsedTime, zone: string): number {
  if (time.kind === 'instant') return time.ms;
  if (time.kind === 'date') return instantOf(time.year, time.month, time.day, 0, 0, 0, zone);
  return instantOf(time.year, time.month, time.day, time.hour, time.minute, time.second, zone);
}

/** The date `days` after a date. */
export function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** A wall-clock time plus some minutes, as wall-clock text without an offset: 2026-05-11T09:30:00. */
export function addMinutesToLocal(time: Extract<ParsedTime, { kind: 'local' }>, minutes: number): string {
  const moved = new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute + minutes, time.second));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}T${pad(moved.getUTCHours())}:${pad(moved.getUTCMinutes())}:${pad(moved.getUTCSeconds())}`;
}

/** "09:30" -> 570; "24:00" -> 1440. */
export function minutesOfDay(text: string): number {
  const [hours, minutes] = text.split(':').map(Number);
  return (hours as number) * 60 + (minutes as number);
}

export interface HoursRule {
  days: number[];
  /** Minutes after midnight. */
  start: number;
  end: number;
}

export interface SlotSearch {
  from: number;
  to: number;
  /** No slot starts before this instant (now, plus any notice). */
  earliest: number;
  /** Busy intervals, [start, end) in ms. */
  busy: Array<[number, number]>;
  rules: HoursRule[];
  zone: string;
  slotMs: number;
  stepMs: number;
  bufferMs: number;
  max: number;
}

/** Sorted, merged intervals. */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Free slots of slotMs inside the opening hours of each day between from and
 * to, starting at the opening time and every stepMs after it, that overlap no
 * busy interval (widened by bufferMs on each side). Stops after `max` slots;
 * `next` is where the search would go on.
 */
export function findFreeSlots(search: SlotSearch): { slots: Array<[number, number]>; next?: number } {
  const busy = mergeIntervals(search.busy.map(([start, end]) => [start - search.bufferMs, end + search.bufferMs]));
  const slots: Array<[number, number]> = [];
  const lowest = Math.max(search.from, search.earliest);
  const first = wallTime(search.from, search.zone);
  let date = { year: first.year, month: first.month, day: first.day };
  // A day before, for a window that started the evening before in a zone far from UTC.
  date = addDays(date, -1);
  for (let guard = 0; guard < 400; guard++) {
    const midnight = instantOf(date.year, date.month, date.day, 0, 0, 0, search.zone);
    if (midnight >= search.to) break;
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const starts = new Set<number>();
    const candidates: Array<[number, number]> = [];
    for (const rule of search.rules) {
      if (!rule.days.includes(weekday)) continue;
      const open = instantOf(date.year, date.month, date.day, Math.floor(rule.start / 60), rule.start % 60, 0, search.zone);
      const nextDay = addDays(date, 1);
      const close = rule.end >= 1440
        ? instantOf(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, search.zone)
        : instantOf(date.year, date.month, date.day, Math.floor(rule.end / 60), rule.end % 60, 0, search.zone);
      for (let start = open; start + search.slotMs <= close; start += search.stepMs) {
        const end = start + search.slotMs;
        if (start < lowest || end > search.to || starts.has(start)) continue;
        starts.add(start);
        candidates.push([start, end]);
      }
    }
    candidates.sort((a, b) => a[0] - b[0]);
    for (const [start, end] of candidates) {
      if (busy.some(([busyStart, busyEnd]) => start < busyEnd && end > busyStart)) continue;
      if (slots.length >= search.max) return { slots, next: start };
      slots.push([start, end]);
    }
    date = addDays(date, 1);
  }
  return { slots };
}

export const DAY_MS = DAY;
export const MINUTE_MS = MINUTE;
