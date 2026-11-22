// Google Calendar, through the Calendar API v3 with a service account.
//
// Credentials:
// - `serviceaccountjson`: a service account key, the JSON file Google Cloud
//   creates under IAM and admin -> Service accounts -> Keys (its base64 text
//   works too). It signs a short-lived token (RS256) for the calendar and
//   calendar.events scopes; the key never leaves the call.
// - `calendarid`: the one calendar this connection works on ("primary" is the
//   service account's own calendar). Share it with the service account's
//   email, with "Make changes to events".
// - `timezone` (optional): an IANA time zone for slots and events. When it is
//   empty, the calendar's own time zone is used.
// - `slotdurationminutes` (optional): the default appointment length, 30
//   when empty.

import {
  apiTools,
  defineConnector,
  OutcomeUnknown,
  ToolFailure,
  truncate,
  type ApiRequest,
  type ApiResponse,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { googleApi, KEY_CREDENTIAL, serviceAccountWords } from './service-account.js';
import {
  addMinutesToLocal,
  DAY_MS,
  findFreeSlots,
  formatInZone,
  formatUtc,
  isTimeZone,
  MINUTE_MS,
  minutesOfDay,
  parseTime,
  TIME_PATTERN,
  toInstant,
  WEEKDAYS,
  type HoursRule,
  type ParsedTime,
} from './time.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Google Calendar';
const API_ORIGIN = 'https://www.googleapis.com';
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'];
const DEFAULT_SLOT_MINUTES = 30;
const MAX_RANGE_DAYS = 62;
const DEFAULT_HOURS: HoursRule[] = [{ days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60 }];
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const MAX_BUSY_RETURNED = 100;
/**
 * Event ids are base32hex, with "_" and a time for one occurrence of a
 * repeating event (abc123_20260511T090000Z). Nothing else is taken: an id of
 * "." or ".." would turn the event's path into the calendar's own.
 */
const EVENT_ID_PATTERN = '^[A-Za-z0-9_-]{1,1024}$';
const NO_EVENT = { 404: 'Google Calendar found no such event on the connected calendar' };
const NOTHING_CHANGED = ' Nothing was changed.';

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function calendarIdOf(h: ToolHelpers): string {
  const id = h.credentials['calendarid'] as string;
  if (id === '.' || id === '..') throw new ToolFailure('The Google Calendar calendar ID is not a calendar ID: copy it from the calendar\'s settings, under Integrate calendar. Nothing was sent.');
  return id;
}

function calendarPath(h: ToolHelpers, rest = ''): string {
  return `/calendar/v3/calendars/${encodeURIComponent(calendarIdOf(h))}${rest}`;
}

function eventPath(h: ToolHelpers, eventId: string): string {
  return calendarPath(h, `/events/${encodeURIComponent(eventId)}`);
}

/** The default slot length from the connection, 30 minutes when it is empty or not a number. */
function defaultSlotMinutes(h: ToolHelpers): number {
  const value = Number(h.credentials['slotdurationminutes']);
  return Number.isInteger(value) && value >= 5 && value <= 480 ? value : DEFAULT_SLOT_MINUTES;
}

/** Google's words for its usage limits (rateLimitExceeded, userRateLimitExceeded, quotaExceeded), which Google Calendar sends as 403. */
const USAGE_LIMIT = /rate limit|usage limit|quota exceeded|too many requests/i;
/** Google Calendar's refusal of guests from a service account (forbiddenForServiceAccounts). */
const NO_GUESTS = /domain-wide delegation|forbiddenForServiceAccounts/i;

/** Google Calendar answers 403 for missing sharing, usage limits and guests: the advice follows the reason Google gave. */
function explainRefusal(h: ToolHelpers, error: unknown): unknown {
  if (!(error instanceof ToolFailure) || error.details.status !== 403) return error;
  const ending = error.message.endsWith(NOTHING_CHANGED) ? NOTHING_CHANGED : '';
  const text = error.message.slice(0, error.message.length - ending.length);
  const advice = NO_GUESTS.test(text)
    ? 'Google Calendar does not let a service account invite guests: add guests in Google Calendar itself.'
    : USAGE_LIMIT.test(text)
      ? 'That is a Google Calendar usage limit, not a sharing problem: wait a minute and try again.'
      : `Share the calendar with ${serviceAccountWords(h)} (Settings and sharing -> Share with specific people, "Make changes to events"), `
        + 'and check that the Google Calendar API is enabled for the key\'s project.';
  return new ToolFailure(`${text} ${advice}${ending}`, error.details);
}

async function calendar(h: ToolHelpers, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await googleApi(h, SCOPES, {
      ...request,
      errors: {
        404: `Google Calendar found nothing there: check the calendar ID and that the calendar is shared with ${serviceAccountWords(h)}`,
        ...request.errors,
      },
    });
  } catch (error) {
    throw explainRefusal(h, error);
  }
}

/** The time zone a call uses: the argument, the connection's setting, or the calendar's own. */
async function zoneFor(h: ToolHelpers, given: string | undefined): Promise<string> {
  const zone = given || h.credentials['timezone'];
  if (zone) {
    if (!isTimeZone(zone)) {
      throw new ToolFailure(
        `"${truncate(zone, 64)}" is not an IANA time zone such as Europe/Istanbul or America/New_York`
          + `${given ? '' : ' (it is the connection\'s time zone setting)'}. Nothing was sent.`,
      );
    }
    return zone;
  }
  const { data } = await calendar(h, { path: calendarPath(h), query: { fields: 'timeZone' } });
  return typeof data?.timeZone === 'string' && isTimeZone(data.timeZone) ? data.timeZone : 'UTC';
}

function timeOf(text: string, field: string): ParsedTime {
  const parsed = parseTime(text);
  if (!parsed) throw new ToolFailure(`${field} is not a valid date or date-time, such as 2026-05-11 or 2026-05-11T09:00:00. Nothing was sent.`);
  return parsed;
}

function trimEvent(event: any): Record<string, unknown> {
  const attendees: any[] = Array.isArray(event?.attendees) ? event.attendees : [];
  const overrides: any[] = Array.isArray(event?.reminders?.overrides) ? event.reminders.overrides : [];
  return compact({
    id: event?.id,
    status: event?.status,
    summary: event?.summary,
    description: typeof event?.description === 'string' ? truncate(event.description, 2000) : undefined,
    location: event?.location,
    start: event?.start?.dateTime ?? event?.start?.date,
    end: event?.end?.dateTime ?? event?.end?.date,
    allDay: event?.start?.date ? true : undefined,
    timeZone: event?.start?.timeZone,
    recurrence: Array.isArray(event?.recurrence) ? event.recurrence : undefined,
    recurringEventId: event?.recurringEventId,
    attendees: attendees.length
      ? attendees.slice(0, 50).map((attendee) => compact({
        email: attendee?.email,
        name: attendee?.displayName,
        responseStatus: attendee?.responseStatus,
        organizer: attendee?.organizer === true ? true : undefined,
        optional: attendee?.optional === true ? true : undefined,
      }))
      : undefined,
    attendeeCount: attendees.length > 50 ? attendees.length : undefined,
    organizer: event?.organizer?.email,
    reminders: event?.reminders?.useDefault === true
      ? 'default'
      : overrides.length ? overrides.map((item) => compact({ method: item?.method, minutes: item?.minutes })) : undefined,
    transparency: event?.transparency,
    visibility: event?.visibility,
    colorId: event?.colorId,
    privateProperties: event?.extendedProperties?.private,
    htmlLink: event?.htmlLink,
    hangoutLink: event?.hangoutLink,
    created: event?.created,
    updated: event?.updated,
  });
}

/** A new event id: 26 base32hex characters, which Google Calendar accepts as a client-chosen id. */
function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Array.from(bytes, (byte) => BASE32HEX[byte & 31]).join('');
}

interface EventArgs {
  event_id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  duration_minutes?: number;
  timezone?: string;
  reminder_minutes?: number[];
  recurrence?: string[];
  color_id?: string;
  visibility?: string;
  transparency?: string;
  status?: string;
  private_properties?: Record<string, unknown>;
  send_updates?: string;
}

const EVENT_FIELDS: Record<string, JsonSchema> = {
  summary: { type: 'string', minLength: 1, maxLength: 1024, description: 'The event title.' },
  description: { type: 'string', maxLength: 8000, description: 'The event description (plain text or simple HTML).' },
  location: { type: 'string', maxLength: 1024, description: 'A place or an address.' },
  start: {
    type: 'string',
    pattern: TIME_PATTERN,
    description: 'When it starts: 2026-05-11T09:00:00 (in timezone), 2026-05-11T09:00:00+03:00, or a date such as 2026-05-11 for an all-day event.',
  },
  end: {
    type: 'string',
    pattern: TIME_PATTERN,
    description: 'When it ends, in the same form as start (for an all-day event, the day after the last day).',
  },
  timezone: { type: 'string', maxLength: 64, description: 'An IANA time zone such as Europe/Istanbul for times without an offset. Default: the connection\'s time zone, else the calendar\'s.' },
  reminder_minutes: {
    type: 'array',
    items: { type: 'integer', minimum: 0, maximum: 40320 },
    maxItems: 5,
    description: 'Pop-up reminders, in minutes before the start, e.g. [10, 60]. Default: the calendar\'s own reminders.',
  },
  recurrence: {
    type: 'array',
    items: { type: 'string', pattern: '^(RRULE|EXRULE|RDATE|EXDATE)[:;]', maxLength: 500 },
    maxItems: 10,
    description: 'Repeat rules, e.g. ["RRULE:FREQ=WEEKLY;COUNT=4"] (needs a time zone).',
  },
  color_id: { type: 'string', pattern: '^([1-9]|1[01])$', description: 'An event color, "1" to "11".' },
  visibility: { type: 'string', enum: ['default', 'public', 'private', 'confidential'], description: 'Who can see the details.' },
  transparency: { type: 'string', enum: ['opaque', 'transparent'], description: 'opaque blocks the time (busy); transparent shows it as free.' },
  private_properties: { type: 'object', description: 'Up to 20 private key-value tags on the event, values as text, e.g. {"source": "phone"}.' },
  send_updates: {
    type: 'string',
    enum: ['all', 'externalOnly', 'none'],
    description: 'Who gets an email about the change: it only matters for an event whose guests were added in Google Calendar itself. Default: Google Calendar\'s default, none.',
  },
};

function checkProperties(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 20) throw new ToolFailure('private_properties takes at most 20 entries. Nothing was sent.');
  for (const [key, item] of entries) {
    if (typeof item !== 'string' || key.length > 44 || item.length > 1024) {
      throw new ToolFailure('private_properties values must be text (keys up to 44 characters, values up to 1024). Nothing was sent.');
    }
  }
  return value as Record<string, string>;
}

/** start or end as Google Calendar wants it: a date, or a date-time with an offset or a time zone. */
function eventTime(time: ParsedTime, zone: string | undefined, patch: boolean): Record<string, unknown> {
  if (time.kind === 'date') {
    const text = `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
    return patch ? { date: text, dateTime: null, timeZone: null } : { date: text };
  }
  const text = time.text.length === 16 ? `${time.text}:00` : time.text;
  return { ...(patch ? { date: null } : {}), dateTime: text, ...(zone ? { timeZone: zone } : {}) };
}

/** The event body from the arguments that were given (for a patch, only those). */
async function eventBody(h: ToolHelpers, args: EventArgs, patch: boolean): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (args.summary !== undefined) body['summary'] = args.summary;
  if (args.description !== undefined) body['description'] = args.description;
  if (args.location !== undefined) body['location'] = args.location;
  if (args.reminder_minutes !== undefined) {
    body['reminders'] = { useDefault: false, overrides: args.reminder_minutes.map((minutes) => ({ method: 'popup', minutes })) };
  } else if (!patch) {
    body['reminders'] = { useDefault: true };
  }
  if (args.recurrence !== undefined) body['recurrence'] = args.recurrence;
  if (args.color_id !== undefined) body['colorId'] = args.color_id;
  if (args.visibility !== undefined) body['visibility'] = args.visibility;
  if (args.transparency !== undefined) body['transparency'] = args.transparency;
  if (args.status !== undefined) body['status'] = args.status;
  const properties = checkProperties(args.private_properties);
  if (properties) body['extendedProperties'] = { private: properties };

  const start = args.start !== undefined ? timeOf(args.start, 'start') : undefined;
  let end = args.end !== undefined ? timeOf(args.end, 'end') : undefined;
  if (args.duration_minutes !== undefined) {
    if (end) throw new ToolFailure('Give end or duration_minutes, not both. Nothing was sent.');
    if (!start || start.kind === 'date') throw new ToolFailure('duration_minutes needs a start with a time of day. Nothing was sent.');
  }
  if (!patch && start && !end) {
    if (start.kind === 'date') throw new ToolFailure('An all-day event needs an end date (the day after its last day). Nothing was sent.');
    // An appointment of the connection's default length.
    const minutes = args.duration_minutes ?? defaultSlotMinutes(h);
    end = start.kind === 'instant'
      ? { kind: 'instant', ms: start.ms + minutes * MINUTE_MS, text: new Date(start.ms + minutes * MINUTE_MS).toISOString() }
      : timeOf(addMinutesToLocal(start, minutes), 'end');
  } else if (patch && start && args.duration_minutes !== undefined) {
    end = start.kind === 'instant'
      ? { kind: 'instant', ms: start.ms + args.duration_minutes * MINUTE_MS, text: new Date(start.ms + args.duration_minutes * MINUTE_MS).toISOString() }
      : timeOf(addMinutesToLocal(start as Extract<ParsedTime, { kind: 'local' }>, args.duration_minutes), 'end');
  }
  if (start && end && (start.kind === 'date') !== (end.kind === 'date')) {
    throw new ToolFailure('start and end must both be dates (an all-day event) or both have a time of day. Nothing was sent.');
  }
  // A time without an offset, or a repeat rule, needs a time zone; a time zone the call or the
  // connection names goes with every timed start and end.
  const needsZone = [start, end].some((time) => time?.kind === 'local') || (args.recurrence !== undefined && start?.kind !== 'date');
  const named = args.timezone || h.credentials['timezone'];
  const zone = (start || end) && (needsZone || named) ? await zoneFor(h, args.timezone) : undefined;
  if (start && end) {
    const zoneForCheck = zone ?? 'UTC';
    if (toInstant(end, zoneForCheck) <= toInstant(start, zoneForCheck)) throw new ToolFailure('end must be after start. Nothing was sent.');
  }
  if (start) body['start'] = eventTime(start, zone, patch);
  if (end) body['end'] = eventTime(end, zone, patch);
  return body;
}

/**
 * The generic tools work on the connection's calendar only: a calendar path
 * must name it, an event may not move to another calendar, a free/busy query
 * reads it alone, and the service account's calendar list (which names other
 * calendars) is reachable for this calendar's entry only.
 */
function calendarGuard(request: ApiToolRequest, h: ToolHelpers): void {
  const calendarId = calendarIdOf(h);
  const [, , collection, id, sub, subId, action] = request.segments;
  const refuse = (what: string): never => {
    throw new ToolFailure(`${what} This connection works on the calendar ${calendarId} only. Nothing was sent.`);
  };
  if (collection === 'calendars') {
    if (id === undefined && request.method !== 'GET') refuse('Creating calendars is not available here.');
    if (id !== undefined && id !== calendarId) refuse(`The path names the calendar ${truncate(id, 100)}.`);
    if (sub === 'events' && subId !== undefined && action === 'move') {
      const destination = request.query['destination'] ?? [];
      if (destination.length !== 1 || destination[0] !== calendarId) refuse('Moving an event to another calendar is not available here.');
    }
  }
  if (collection === 'users' && id === 'me' && sub === 'calendarList') {
    if (subId === undefined) refuse('The calendar list names other calendars, so it is not available here.');
    if (subId !== calendarId) refuse(`The path names the calendar ${truncate(subId as string, 100)}.`);
  }
  if (collection === 'freeBusy') {
    // A raw body cannot be checked: the calendars go in json, and find_free_slots reads this one's.
    const items = request.json?.['items'];
    const onlyThis = Array.isArray(items) && items.length > 0
      && items.every((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === calendarId);
    if (!onlyThis) refuse('A free/busy query must name the connected calendar alone, in json (find_free_slots reads it).');
  }
}

const connector = defineConnector({
  vendor: 'google-calendar',
  label: LABEL,
  origins: [API_ORIGIN, TOKEN_ORIGIN],
  credentials: [KEY_CREDENTIAL, 'calendarid', 'timezone', 'slotdurationminutes'],
  requiredCredentials: [[KEY_CREDENTIAL, 'calendarid']],
  credentialLabels: {
    serviceaccountjson: 'Google Calendar service account key',
    calendarid: 'Google Calendar calendar ID',
    timezone: 'Google Calendar time zone',
    slotdurationminutes: 'Google Calendar default slot length',
  },
  tools: [
    {
      name: 'get_calendar',
      kind: 'read',
      title: 'Get the Google Calendar calendar',
      description:
        'Returns the connected calendar: its ID, name, description and time zone, with the connection\'s time zone and default slot length. '
        + 'A quick check that the key works and the calendar is shared with the service account.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await calendar(h, { path: calendarPath(h) });
        return compact({
          calendarId: calendarIdOf(h),
          summary: data?.summary,
          description: typeof data?.description === 'string' ? truncate(data.description, 1000) : undefined,
          timeZone: data?.timeZone,
          location: data?.location,
          connectionTimeZone: h.credentials['timezone'],
          slotMinutes: defaultSlotMinutes(h),
        });
      },
    },
    {
      name: 'find_free_slots',
      kind: 'read',
      title: 'Find free Google Calendar slots',
      description:
        'Finds open appointment slots on the connected calendar: it reads the busy times (free/busy) between start and end and returns '
        + 'the slots of slot_minutes inside the opening hours that are free, in the calendar\'s time zone, plus the busy blocks. '
        + 'Opening hours default to Monday to Friday 09:00-18:00; pass hours for others. Past slots are left out. '
        + `Up to ${MAX_RANGE_DAYS} days per call; pass nextCursor back as cursor for more slots.`,
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', pattern: TIME_PATTERN, description: 'Search from: a date (its midnight), a time, or an instant. Default: now.' },
          end: { type: 'string', pattern: TIME_PATTERN, description: 'Search until (a date means the end of that day). Default: start plus days.' },
          days: { type: 'integer', minimum: 1, maximum: MAX_RANGE_DAYS, default: 7, description: 'Days to search when end is not given (default 7).' },
          slot_minutes: { type: 'integer', minimum: 5, maximum: 480, description: 'Slot length in minutes. Default: the connection\'s slot length, else 30.' },
          step_minutes: { type: 'integer', minimum: 5, maximum: 480, description: 'Minutes between slot starts, counted from the opening time. Default: the slot length.' },
          buffer_minutes: { type: 'integer', minimum: 0, maximum: 240, default: 0, description: 'Free minutes to keep before and after each busy block (default 0).' },
          min_notice_minutes: { type: 'integer', minimum: 0, maximum: 43200, default: 0, description: 'Leave out slots starting sooner than this many minutes from now (default 0).' },
          hours: {
            type: 'array',
            minItems: 1,
            maxItems: 14,
            items: {
              type: 'object',
              properties: {
                days: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] }, minItems: 1, uniqueItems: true, description: 'Weekdays: mon, tue, wed, thu, fri, sat, sun.' },
                start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'Opening time, HH:MM.' },
                end: { type: 'string', pattern: '^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$', description: 'Closing time, HH:MM (24:00 for midnight).' },
              },
              required: ['days', 'start', 'end'],
              additionalProperties: false,
            },
            description: 'Opening hours, e.g. [{"days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "18:00"}, {"days": ["sat"], "start": "10:00", "end": "14:00"}].',
          },
          timezone: { type: 'string', maxLength: 64, description: 'An IANA time zone for the hours and the results. Default: the connection\'s, else the calendar\'s.' },
          max_slots: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Slots to return, 1 to 200 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: {
        start?: string; end?: string; days: number; slot_minutes?: number; step_minutes?: number; buffer_minutes: number;
        min_notice_minutes: number; hours?: Array<{ days: string[]; start: string; end: string }>; timezone?: string; max_slots: number; cursor?: string;
      }, h) {
        const state = h.cursor(args.cursor);
        const zone = await zoneFor(h, args.timezone);
        const now = Date.now();
        let from: number;
        let to: number;
        if (typeof state?.['s'] === 'number' && typeof state?.['e'] === 'number') {
          from = state['s'];
          to = state['e'];
        } else {
          const start = args.start !== undefined ? timeOf(args.start, 'start') : undefined;
          from = start ? toInstant(start, zone) : now;
          if (args.end !== undefined) {
            const end = timeOf(args.end, 'end');
            to = toInstant(end, zone) + (end.kind === 'date' ? DAY_MS : 0);
          } else {
            to = from + args.days * DAY_MS;
          }
        }
        if (to <= from) throw new ToolFailure('end must be after start. Nothing was sent.');
        if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new ToolFailure(`The search can cover at most ${MAX_RANGE_DAYS} days per call. Nothing was sent.`);
        const slotMinutes = args.slot_minutes ?? defaultSlotMinutes(h);
        const rules: HoursRule[] = args.hours
          ? args.hours.map((rule) => ({ days: rule.days.map((day) => WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number])), start: minutesOfDay(rule.start), end: minutesOfDay(rule.end) }))
          : DEFAULT_HOURS;
        for (const rule of rules) if (rule.end <= rule.start) throw new ToolFailure('Each opening hours entry must close after it opens. Nothing was sent.');

        const calendarId = calendarIdOf(h);
        const { data } = await calendar(h, {
          method: 'POST',
          path: '/calendar/v3/freeBusy',
          json: { timeMin: formatUtc(from), timeMax: formatUtc(to), timeZone: zone, items: [{ id: calendarId }] },
          // A free/busy query reads and changes nothing.
          safe: true,
        });
        const calendars = data?.calendars && typeof data.calendars === 'object' ? data.calendars : {};
        const entry: any = calendars[calendarId] ?? Object.values(calendars)[0];
        const errors: any[] = Array.isArray(entry?.errors) ? entry.errors : [];
        if (!entry || errors.length) {
          const reason = typeof errors[0]?.reason === 'string' ? ` (${truncate(errors[0].reason, 60)})` : '';
          throw new ToolFailure(
            `Google Calendar could not read the busy times of the calendar ${calendarId}${reason}: check the calendar ID and share the calendar with ${serviceAccountWords(h)}.`,
          );
        }
        const busy: Array<[number, number]> = (Array.isArray(entry.busy) ? entry.busy : [])
          .map((block: any) => [Date.parse(block?.start), Date.parse(block?.end)] as [number, number])
          .filter(([start, end]: [number, number]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
        const found = findFreeSlots({
          from,
          to,
          earliest: now + args.min_notice_minutes * MINUTE_MS,
          busy,
          rules,
          zone,
          slotMs: slotMinutes * MINUTE_MS,
          stepMs: (args.step_minutes ?? slotMinutes) * MINUTE_MS,
          bufferMs: args.buffer_minutes * MINUTE_MS,
          max: args.max_slots,
        });
        const clipped = busy
          .filter(([start, end]) => end > from && start < to)
          .map(([start, end]) => ({ start: formatInZone(Math.max(start, from), zone), end: formatInZone(Math.min(end, to), zone) }));
        return compact({
          calendarId,
          timeZone: zone,
          slotMinutes,
          from: formatInZone(from, zone),
          to: formatInZone(to, zone),
          busy: clipped.slice(0, MAX_BUSY_RETURNED),
          busyCount: clipped.length > MAX_BUSY_RETURNED ? clipped.length : undefined,
          slots: found.slots.map(([start, end]) => ({ start: formatInZone(start, zone), end: formatInZone(end, zone) })),
          nextCursor: found.next !== undefined ? h.makeCursor({ s: found.next, e: to }) : undefined,
        });
      },
    },
    {
      name: 'list_events',
      kind: 'read',
      title: 'List Google Calendar events',
      description:
        'Lists the events on the connected calendar from time_min (default now) on, in start order, with recurring events expanded: '
        + 'id, title, times, location, guests, status and link. Filter by text with query. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          time_min: { type: 'string', pattern: TIME_PATTERN, description: 'Events ending after this time. Default: now.' },
          time_max: { type: 'string', pattern: TIME_PATTERN, description: 'Events starting before this time.' },
          query: { type: 'string', maxLength: 500, description: 'Free text to match in the title, description, location or guests.' },
          updated_min: { type: 'string', pattern: TIME_PATTERN, description: 'Only events changed after this time (deleted ones are then included, status cancelled).' },
          timezone: { type: 'string', maxLength: 64, description: 'An IANA time zone for times without an offset. Default: the connection\'s, else the calendar\'s.' },
          max_results: { type: 'integer', minimum: 1, maximum: 250, default: 50, description: 'Events per page, 1 to 250 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { time_min?: string; time_max?: string; query?: string; updated_min?: string; timezone?: string; max_results: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const needsZone = [args.time_min, args.time_max, args.updated_min].some((text) => text !== undefined && parseTime(text)?.kind !== 'instant');
        const zone = needsZone ? await zoneFor(h, args.timezone) : 'UTC';
        const instant = (text: string, field: string): string => formatUtc(toInstant(timeOf(text, field), zone));
        const query = {
          singleEvents: true,
          orderBy: 'startTime',
          timeMin: args.time_min !== undefined ? instant(args.time_min, 'time_min') : formatUtc(Date.now()),
          timeMax: args.time_max !== undefined ? instant(args.time_max, 'time_max') : undefined,
          updatedMin: args.updated_min !== undefined ? instant(args.updated_min, 'updated_min') : undefined,
          q: args.query,
          maxResults: args.max_results,
          pageToken,
        };
        const { data } = await calendar(h, { path: calendarPath(h, '/events'), query });
        const events: any[] = Array.isArray(data?.items) ? data.items : [];
        return h.page({
          key: 'events',
          items: events.map(trimEvent).slice(skip),
          extra: compact({ calendarId: calendarIdOf(h), timeZone: data?.timeZone }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0 }) } : {}),
        });
      },
    },
    {
      name: 'get_event',
      kind: 'read',
      title: 'Get a Google Calendar event',
      description: 'Returns one event of the connected calendar by its id: title, times, description, location, guests and their answers, reminders, status and link. A deleted event comes back with status cancelled.',
      inputSchema: {
        type: 'object',
        properties: { event_id: { type: 'string', minLength: 1, maxLength: 1024, pattern: EVENT_ID_PATTERN, description: 'The event id.' } },
        required: ['event_id'],
        additionalProperties: false,
      },
      async run(args: { event_id: string }, h) {
        const { data } = await calendar(h, { path: eventPath(h, args.event_id), errors: NO_EVENT });
        return trimEvent(data);
      },
    },
    {
      name: 'create_event',
      kind: 'create',
      check: 'get_event',
      title: 'Create a Google Calendar event',
      description:
        'Creates an event on the connected calendar, such as a booked appointment: title, start and end (or duration_minutes, by default the '
        + 'connection\'s slot length), description, location, reminders (default: the calendar\'s), repeat rules, color and private tags. '
        + 'Times without an offset are in the connection\'s time zone. Returns the event with its id and link.',
      inputSchema: {
        type: 'object',
        properties: {
          ...EVENT_FIELDS,
          duration_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Length in minutes when end is not given. Default: the connection\'s slot length, else 30.' },
        },
        required: ['summary', 'start'],
        additionalProperties: false,
      },
      async run(args: EventArgs, h) {
        const body = await eventBody(h, args, false);
        const id = newEventId();
        try {
          const { data } = await calendar(h, {
            method: 'POST',
            path: calendarPath(h, '/events'),
            query: { sendUpdates: args.send_updates },
            json: { id, ...body },
            write: true,
          });
          return trimEvent(data);
        } catch (error) {
          if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${error.message} The new event's id is "${id}".`);
          throw error;
        }
      },
    },
    {
      name: 'update_event',
      kind: 'update',
      check: 'get_event',
      title: 'Update a Google Calendar event',
      description:
        'Changes an event of the connected calendar: only the fields given change (reminder_minutes and recurrence replace the whole list), '
        + 'and guests added in Google Calendar stay. status cancelled cancels it. Returns the updated event.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: { type: 'string', minLength: 1, maxLength: 1024, pattern: EVENT_ID_PATTERN, description: 'The event id.' },
          ...EVENT_FIELDS,
          duration_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'With start: the new length in minutes, instead of end.' },
          status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'], description: 'The event status.' },
        },
        required: ['event_id'],
        additionalProperties: false,
      },
      async run(args: EventArgs & { event_id: string }, h) {
        const body = await eventBody(h, args, true);
        if (!Object.keys(body).length) throw new ToolFailure('Give at least one field to change. Nothing was changed.');
        const { data } = await calendar(h, {
          method: 'PATCH',
          path: eventPath(h, args.event_id),
          query: { sendUpdates: args.send_updates },
          json: body,
          write: true,
          errors: NO_EVENT,
        });
        return trimEvent(data);
      },
    },
    {
      name: 'delete_event',
      kind: 'delete',
      check: 'get_event',
      title: 'Delete a Google Calendar event',
      description: 'Deletes an event from the connected calendar (for a repeating event, the whole series; to drop one occurrence, pass that occurrence\'s id from list_events). Deleting an event that is already deleted succeeds.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: { type: 'string', minLength: 1, maxLength: 1024, pattern: EVENT_ID_PATTERN, description: 'The event id.' },
          send_updates: EVENT_FIELDS['send_updates'] as JsonSchema,
        },
        required: ['event_id'],
        additionalProperties: false,
      },
      async run(args: { event_id: string; send_updates?: string }, h) {
        try {
          await calendar(h, { method: 'DELETE', path: eventPath(h, args.event_id), query: { sendUpdates: args.send_updates }, write: true, errors: NO_EVENT });
        } catch (error) {
          if (error instanceof ToolFailure && error.details.status === 410) return { deleted: true, eventId: args.event_id, note: 'The event was already deleted.' };
          throw error;
        }
        return { deleted: true, eventId: args.event_id };
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Google Calendar API v3 at https://www.googleapis.com/calendar/v3, as the service account: paths start with /calendar/v3/, '
        + 'such as /calendar/v3/calendars/{calendarId}/events/{eventId}/instances, /calendar/v3/calendars/{calendarId}/acl or /calendar/v3/colors, '
        + 'and calendar paths must name the connected calendar (URL-encoded); other calendars are out of reach. Reference: '
        + 'https://developers.google.com/workspace/calendar/api/v3/reference.',
      basePath: '/calendar/v3/',
      guard: calendarGuard,
      send: (request, h) => calendar(h, request),
    }),
  ],
});

export = connector;
