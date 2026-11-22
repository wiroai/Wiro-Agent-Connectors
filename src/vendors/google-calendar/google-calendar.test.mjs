import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

// The key is made here, for this run: no key is ever stored in the repository.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-0123456789',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'booking-agent@example-project.iam.gserviceaccount.com',
  client_id: '100000000000000000001',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const KEY_JSON = JSON.stringify(KEY);
const KEY_BASE64 = Buffer.from(KEY_JSON).toString('base64');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN = 'ya29.calendar-test-token';
const CALENDAR = 'bookings@group.calendar.google.com';
const CALENDAR_PATH = '/calendar/v3/calendars/bookings%40group.calendar.google.com';
const credentials = { serviceaccountjson: KEY_BASE64, calendarid: CALENDAR, timezone: 'Europe/Istanbul', slotdurationminutes: '45' };

const calendarFixture = fixture(import.meta.url, 'calendar.json');
const freeBusy = fixture(import.meta.url, 'freebusy.json');
const events = fixture(import.meta.url, 'events.json');
const created = fixture(import.meta.url, 'event-created.json');

/** A fake Google: the token endpoint, then the routes by "METHOD path". */
function setup(routes, options = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  // A fixed "now": Sunday 2030-01-06 15:00 in Istanbul.
  controlClock(context)(Date.parse('2030-01-06T12:00:00Z') - Date.now());
  const fetch = fakeFetch((request) => {
    if (request.url === TOKEN_URL) return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    const route = routes[`${request.method} ${request.path}`];
    if (!route) return jsonResponse(500, { error: { code: 500, message: `unexpected ${request.method} ${request.path}` } });
    // A route's Response is cloned, so it can answer more than once.
    return typeof route === 'function' ? route(request) : route.clone();
  });
  const { ctx, logs } = makeContext({ credentials: options.credentials ?? credentials, fetch });
  const apiCalls = () => fetch.calls.filter((call) => call.url !== TOKEN_URL);
  return { module, fetch, ctx, logs, apiCalls };
}

function decodeJwt(jwt) {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

test('get_calendar signs a token for the calendar scopes from the base64 key file and reads the connected calendar', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ [`GET ${CALENDAR_PATH}`]: jsonResponse(200, calendarFixture) });
  const { payload, isError } = await callTool(module, 'get_calendar', {}, ctx);
  assert.equal(isError, false, payload.error);

  const [exchange] = fetch.calls;
  assert.equal(exchange.url, TOKEN_URL);
  const assertion = decodeJwt(new URLSearchParams(new TextDecoder().decode(exchange.body)).get('assertion'));
  assert.equal(assertion.iss, KEY.client_email);
  assert.equal(assertion.scope, 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events');

  const [read] = apiCalls();
  assert.equal(read.url, `https://www.googleapis.com${CALENDAR_PATH}`);
  assert.equal(read.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(payload, {
    calendarId: CALENDAR,
    summary: 'Bookings',
    description: 'Appointments booked by phone',
    timeZone: 'Europe/Istanbul',
    connectionTimeZone: 'Europe/Istanbul',
    slotMinutes: 45,
  });
});

test('the key file works as plain JSON too, and a key that is no key file sends nothing', async () => {
  const plain = setup({ [`GET ${CALENDAR_PATH}`]: jsonResponse(200, calendarFixture) }, { credentials: { ...credentials, serviceaccountjson: KEY_JSON } });
  assert.equal((await callTool(plain.module, 'get_calendar', {}, plain.ctx)).isError, false);

  const bad = setup({}, { credentials: { ...credentials, serviceaccountjson: 'bm90IGEga2V5' } });
  const { payload, isError } = await callTool(bad.module, 'get_calendar', {}, bad.ctx);
  assert.equal(isError, true);
  assert.match(payload.error, /^The service account key is not a Google service account key file/);
  assert.equal(bad.fetch.calls.length, 0);

  const missing = setup({}, { credentials: { serviceaccountjson: KEY_JSON } });
  const notConnected = await callTool(missing.module, 'get_calendar', {}, missing.ctx);
  assert.equal(notConnected.payload.error, 'Google Calendar is not connected: the Google Calendar calendar ID is missing.');
});

test('find_free_slots reads free/busy once and returns the open slots inside opening hours, in the connection\'s time zone', async () => {
  const { module, ctx, apiCalls } = setup({ 'POST /calendar/v3/freeBusy': jsonResponse(200, freeBusy) });
  const { payload, isError } = await callTool(module, 'find_free_slots', { start: '2030-01-07', end: '2030-01-08', slot_minutes: 60 }, ctx);
  assert.equal(isError, false, payload.error);

  const [query] = apiCalls();
  assert.equal(query.method, 'POST');
  assert.deepEqual(query.json, {
    timeMin: '2030-01-06T21:00:00Z',
    timeMax: '2030-01-08T21:00:00Z',
    timeZone: 'Europe/Istanbul',
    items: [{ id: CALENDAR }],
  });
  assert.equal(query.headers.authorization, `Bearer ${ACCESS_TOKEN}`);

  assert.equal(payload.timeZone, 'Europe/Istanbul');
  assert.equal(payload.from, '2030-01-07T00:00:00+03:00');
  assert.equal(payload.to, '2030-01-09T00:00:00+03:00');
  assert.equal(payload.slotMinutes, 60);
  assert.deepEqual(payload.slots.map((slot) => slot.start), [
    '2030-01-07T09:00:00+03:00',
    '2030-01-07T11:00:00+03:00',
    '2030-01-07T12:00:00+03:00',
    '2030-01-07T14:00:00+03:00',
    '2030-01-07T15:00:00+03:00',
    '2030-01-07T16:00:00+03:00',
    '2030-01-07T17:00:00+03:00',
    '2030-01-08T17:00:00+03:00',
  ]);
  assert.equal(payload.slots[0].end, '2030-01-07T10:00:00+03:00');
  assert.deepEqual(payload.busy[0], { start: '2030-01-07T10:00:00+03:00', end: '2030-01-07T11:00:00+03:00' });
  assert.equal(payload.busy.length, 3);
  assert.equal(payload.nextCursor, undefined);
});

test('find_free_slots pages with a cursor, keeps buffers, and uses the connection\'s slot length by default', async () => {
  const { module, ctx } = setup({ 'POST /calendar/v3/freeBusy': jsonResponse(200, freeBusy) });
  const first = await callTool(module, 'find_free_slots', { start: '2030-01-07', end: '2030-01-08', slot_minutes: 60, max_slots: 5 }, ctx);
  assert.equal(first.payload.slots.length, 5);
  assert.equal(first.payload.slots[4].start, '2030-01-07T15:00:00+03:00');
  assert.ok(first.payload.nextCursor);
  const second = await callTool(module, 'find_free_slots', { slot_minutes: 60, max_slots: 5, cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(second.payload.slots.map((slot) => slot.start), ['2030-01-07T16:00:00+03:00', '2030-01-07T17:00:00+03:00', '2030-01-08T17:00:00+03:00']);
  assert.equal(second.payload.nextCursor, undefined);

  const buffered = await callTool(module, 'find_free_slots', { start: '2030-01-07', end: '2030-01-07', slot_minutes: 60, buffer_minutes: 30 }, ctx);
  assert.deepEqual(buffered.payload.slots.map((slot) => slot.start.slice(11, 16)), ['12:00', '15:00', '16:00', '17:00']);

  const saturday = await callTool(module, 'find_free_slots', {
    start: '2030-01-12', end: '2030-01-12', hours: [{ days: ['sat'], start: '10:00', end: '12:00' }],
  }, ctx);
  assert.equal(saturday.payload.slotMinutes, 45);
  assert.deepEqual(saturday.payload.slots.map((slot) => `${slot.start.slice(11, 16)}-${slot.end.slice(11, 16)}`), ['10:00-10:45', '10:45-11:30']);
});

test('find_free_slots looks up the calendar\'s own time zone when the connection has none, and leaves out past slots', async () => {
  const { module, ctx, apiCalls } = setup({
    [`GET ${CALENDAR_PATH}`]: jsonResponse(200, { timeZone: 'America/New_York' }),
    'POST /calendar/v3/freeBusy': jsonResponse(200, { calendars: { [CALENDAR]: { busy: [] } } }),
  }, { credentials: { serviceaccountjson: KEY_JSON, calendarid: CALENDAR } });
  const { payload } = await callTool(module, 'find_free_slots', { days: 1, slot_minutes: 120 }, ctx);
  const [zoneRead, query] = apiCalls();
  assert.equal(zoneRead.query.fields, 'timeZone');
  assert.equal(query.json.timeZone, 'America/New_York');
  assert.equal(payload.timeZone, 'America/New_York');
  // Now is Sunday 07:00 in New York: no opening hours on Sunday, Monday is outside the one-day window.
  assert.deepEqual(payload.slots, []);
  assert.equal(payload.from, '2030-01-06T07:00:00-05:00');
});

test('find_free_slots says which calendar it could not read and whom to share it with', async () => {
  const { module, ctx } = setup({ 'POST /calendar/v3/freeBusy': jsonResponse(200, fixture(import.meta.url, 'freebusy-not-found.json')) });
  const { payload, isError } = await callTool(module, 'find_free_slots', { start: '2030-01-07' }, ctx);
  assert.equal(isError, true);
  assert.equal(
    payload.error,
    `Google Calendar could not read the busy times of the calendar ${CALENDAR} (notFound): check the calendar ID and share the calendar with the service account ${KEY.client_email}.`,
  );
});

test('a bad time zone or range is refused before anything is sent', async () => {
  const badZone = setup({}, { credentials: { ...credentials, timezone: 'Mars/Olympus' } });
  const zone = await callTool(badZone.module, 'find_free_slots', {}, badZone.ctx);
  assert.match(zone.payload.error, /"Mars\/Olympus" is not an IANA time zone .* \(it is the connection's time zone setting\)\. Nothing was sent\./);
  assert.equal(badZone.fetch.calls.length, 0);

  const { module, fetch, ctx } = setup({});
  const long = await callTool(module, 'find_free_slots', { start: '2030-01-01', end: '2030-06-01' }, ctx);
  assert.match(long.payload.error, /at most 62 days/);
  const reversed = await callTool(module, 'find_free_slots', { start: '2030-01-08', end: '2030-01-07T10:00:00' }, ctx);
  assert.match(reversed.payload.error, /end must be after start/);
  const closed = await callTool(module, 'find_free_slots', { hours: [{ days: ['mon'], start: '18:00', end: '09:00' }] }, ctx);
  assert.match(closed.payload.error, /close after it opens/);
  assert.equal(fetch.calls.length, 0);
});

test('list_events expands repeating events in start order, trims each event, and pages with the vendor token', async () => {
  const { module, ctx, apiCalls } = setup({ [`GET ${CALENDAR_PATH}/events`]: jsonResponse(200, events) });
  const { payload } = await callTool(module, 'list_events', { time_min: '2030-01-07', query: 'consultation', max_results: 2 }, ctx);
  const [list] = apiCalls();
  assert.deepEqual(list.query, {
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: '2030-01-06T21:00:00Z',
    q: 'consultation',
    maxResults: '2',
  });
  assert.equal(payload.calendarId, CALENDAR);
  assert.deepEqual(payload.events[0], {
    id: '0h5q8k2l3m4n5o6p7q8r9s0t1u',
    status: 'confirmed',
    summary: 'Consultation: Jane Doe',
    description: 'Caller: +1 555 0100\nTopic: first visit',
    location: 'Main office',
    start: '2030-01-07T10:00:00+03:00',
    end: '2030-01-07T11:00:00+03:00',
    timeZone: 'Europe/Istanbul',
    organizer: CALENDAR,
    reminders: 'default',
    htmlLink: 'https://www.google.com/calendar/event?eid=MGg1cThrMmwzbTRuNW82cDdxOHI5czB0MXU',
    created: '2030-01-04T10:00:00.000Z',
    updated: '2030-01-04T10:05:00.000Z',
  });
  assert.equal(payload.events[1].allDay, true);
  assert.deepEqual(payload.events[1].reminders, [{ method: 'popup', minutes: 1440 }]);

  await callTool(module, 'list_events', { cursor: payload.nextCursor }, ctx);
  assert.equal(apiCalls()[1].query.pageToken, 'CigKGjdxYmJ0aGVhbXBsZXRva2VuGAEggICA');
});

test('create_event books an event with its own id, the connection\'s time zone and default length, and the calendar\'s reminders', async () => {
  const { module, ctx, apiCalls } = setup({
    [`POST ${CALENDAR_PATH}/events`]: (request) => jsonResponse(200, { ...created, id: request.json.id }),
  });
  const { payload, isError } = await callTool(module, 'create_event', {
    summary: 'Consultation: John Roe',
    description: 'Caller: +1 555 0101',
    start: '2030-01-07T11:00',
    private_properties: { source: 'phone' },
  }, ctx);
  assert.equal(isError, false, payload.error);
  const [create] = apiCalls();
  assert.equal(create.url, `https://www.googleapis.com${CALENDAR_PATH}/events`);
  assert.match(create.json.id, /^[0-9a-v]{26}$/);
  assert.deepEqual({ ...create.json, id: 'x' }, {
    id: 'x',
    summary: 'Consultation: John Roe',
    description: 'Caller: +1 555 0101',
    reminders: { useDefault: true },
    extendedProperties: { private: { source: 'phone' } },
    start: { dateTime: '2030-01-07T11:00:00', timeZone: 'Europe/Istanbul' },
    end: { dateTime: '2030-01-07T11:45:00', timeZone: 'Europe/Istanbul' },
  });
  assert.equal(payload.id, create.json.id);
  assert.equal(payload.end, '2030-01-07T11:45:00+03:00');
});

test('create_event takes instants and all-day dates, and checks its times before sending', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ [`POST ${CALENDAR_PATH}/events`]: (request) => jsonResponse(200, { ...created, id: request.json.id }) });
  await callTool(module, 'create_event', { summary: 'Call', start: '2030-01-07T08:00:00Z', end: '2030-01-07T08:30:00Z', attendees: ['guest@example.com'], reminder_minutes: [10], send_updates: 'all' }, ctx);
  const [timed] = apiCalls();
  assert.deepEqual(timed.json.start, { dateTime: '2030-01-07T08:00:00Z', timeZone: 'Europe/Istanbul' });
  assert.deepEqual(timed.json.attendees, [{ email: 'guest@example.com' }]);
  assert.deepEqual(timed.json.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  assert.equal(timed.query.sendUpdates, 'all');

  await callTool(module, 'create_event', { summary: 'Office closed', start: '2030-01-08', end: '2030-01-09' }, ctx);
  assert.deepEqual(apiCalls()[1].json.start, { date: '2030-01-08' });

  const before = fetch.calls.length;
  for (const [args, message] of [
    [{ summary: 'x', start: '2030-01-08' }, /An all-day event needs an end date/],
    [{ summary: 'x', start: '2030-01-08', end: '2030-01-08T10:00:00' }, /both be dates/],
    [{ summary: 'x', start: '2030-01-08T10:00:00', end: '2030-01-08T09:00:00' }, /end must be after start/],
    [{ summary: 'x', start: '2030-02-30T10:00:00' }, /not a valid date/],
    [{ summary: 'x', start: '2030-01-08T10:00:00', end: '2030-01-08T11:00:00', duration_minutes: 30 }, /Give end or duration_minutes, not both/],
  ]) {
    const { payload, isError } = await callTool(module, 'create_event', args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, before, 'nothing sent for bad times');
});

test('an unclear create outcome is unknown, names the new event\'s id and get_event, and is sent once', async () => {
  const { module, ctx, apiCalls } = setup({ [`POST ${CALENDAR_PATH}/events`]: jsonResponse(503, { error: { code: 503, message: 'Backend Error' } }) });
  const { payload, isError } = await callTool(module, 'create_event', { summary: 'Call', start: '2030-01-07T11:00:00', end: '2030-01-07T11:30:00' }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, 'get_event');
  assert.match(payload.error, /The new event's id is "[0-9a-v]{26}"\. Call get_event to see whether it was, before trying again\./);
  assert.equal(apiCalls().length, 1);
});

test('update_event patches only the given fields, and switching to all-day clears the time fields', async () => {
  const { module, fetch, ctx, apiCalls } = setup({ [`PATCH ${CALENDAR_PATH}/events/evt123`]: jsonResponse(200, { ...created, id: 'evt123', start: { date: '2030-01-10' }, end: { date: '2030-01-11' } }) });
  const { payload } = await callTool(module, 'update_event', { event_id: 'evt123', start: '2030-01-10', end: '2030-01-11', summary: 'Moved' }, ctx);
  const [patch] = apiCalls();
  assert.equal(patch.method, 'PATCH');
  assert.deepEqual(patch.json, {
    summary: 'Moved',
    start: { date: '2030-01-10', dateTime: null, timeZone: null },
    end: { date: '2030-01-11', dateTime: null, timeZone: null },
  });
  assert.equal(payload.allDay, true);

  const before = fetch.calls.length;
  const empty = await callTool(module, 'update_event', { event_id: 'evt123' }, ctx);
  assert.equal(empty.payload.error, 'Give at least one field to change. Nothing was changed.');
  assert.equal(fetch.calls.length, before);
});

test('update_event moves a timed event with start and duration_minutes', async () => {
  const { module, ctx, apiCalls } = setup({ [`PATCH ${CALENDAR_PATH}/events/evt123`]: jsonResponse(200, created) });
  await callTool(module, 'update_event', { event_id: 'evt123', start: '2030-01-09T14:00:00', duration_minutes: 30, status: 'tentative' }, ctx);
  assert.deepEqual(apiCalls()[0].json, {
    status: 'tentative',
    start: { date: null, dateTime: '2030-01-09T14:00:00', timeZone: 'Europe/Istanbul' },
    end: { date: null, dateTime: '2030-01-09T14:30:00', timeZone: 'Europe/Istanbul' },
  });
});

test('delete_event deletes once; an event that is already gone counts as deleted; a wrong id says so', async () => {
  const gone = setup({ [`DELETE ${CALENDAR_PATH}/events/evt123`]: jsonResponse(410, fixture(import.meta.url, 'error-410.json')) });
  const already = await callTool(gone.module, 'delete_event', { event_id: 'evt123', send_updates: 'none' }, gone.ctx);
  assert.deepEqual(already.payload, { deleted: true, eventId: 'evt123', note: 'The event was already deleted.' });
  assert.equal(gone.apiCalls()[0].query.sendUpdates, 'none');

  const ok = setup({ [`DELETE ${CALENDAR_PATH}/events/evt123`]: new Response(null, { status: 204 }) });
  assert.deepEqual((await callTool(ok.module, 'delete_event', { event_id: 'evt123' }, ok.ctx)).payload, { deleted: true, eventId: 'evt123' });

  const missing = setup({ [`DELETE ${CALENDAR_PATH}/events/nope`]: jsonResponse(404, fixture(import.meta.url, 'error-404.json')) });
  const notFound = await callTool(missing.module, 'delete_event', { event_id: 'nope' }, missing.ctx);
  assert.equal(notFound.payload.error, 'Google Calendar found no such event on the connected calendar (HTTP 404). Google Calendar said: "Not Found". Nothing was changed.');
});

test('a refusal names the service account to share with; a 429 carries retryAfter', async () => {
  const refused = setup({ [`GET ${CALENDAR_PATH}/events/evt1`]: jsonResponse(403, fixture(import.meta.url, 'error-403.json')) });
  const forbidden = await callTool(refused.module, 'get_event', { event_id: 'evt1' }, refused.ctx);
  assert.equal(forbidden.payload.status, 403);
  assert.match(forbidden.payload.error, new RegExp(`share the calendar with the service account ${KEY.client_email.replace(/\./g, '\\.')}`));

  const limited = setup({ [`GET ${CALENDAR_PATH}/events`]: jsonResponse(429, fixture(import.meta.url, 'error-429.json'), { 'retry-after': '17' }) });
  const rate = await callTool(limited.module, 'list_events', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 17);
  assert.match(rate.payload.error, /^Google Calendar rate limit reached \(HTTP 429\)\. Retry after 17 seconds\.$/);
});

test('api_get and api_request reach the rest of the Calendar API, on the connected calendar only', async () => {
  const { module, fetch, ctx, apiCalls } = setup({
    'GET /calendar/v3/colors': jsonResponse(200, { kind: 'calendar#colors', event: { 1: { background: '#a4bdfc' } } }),
    [`POST ${CALENDAR_PATH}/acl`]: jsonResponse(200, { id: 'user:guest@example.com', role: 'reader' }),
  });
  const colors = await callTool(module, 'api_get', { path: '/calendar/v3/colors' }, ctx);
  assert.equal(colors.payload.status, 200);
  assert.equal(apiCalls()[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);

  const share = await callTool(module, 'api_request', { method: 'POST', path: `${CALENDAR_PATH}/acl`, json: { role: 'reader', scope: { type: 'user', value: 'guest@example.com' } } }, ctx);
  assert.equal(share.payload.data.role, 'reader');

  const before = fetch.calls.length;
  const other = await callTool(module, 'api_get', { path: '/calendar/v3/calendars/someone%40example.com/events' }, ctx);
  assert.equal(other.payload.error, `The path names the calendar someone@example.com. This connection works on the calendar ${CALENDAR} only. Nothing was sent.`);
  const create = await callTool(module, 'api_request', { method: 'POST', path: '/calendar/v3/calendars', json: { summary: 'New' } }, ctx);
  assert.match(create.payload.error, /Creating calendars is not available here/);
  const outside = await callTool(module, 'api_get', { path: '/drive/v3/files' }, ctx);
  assert.match(outside.payload.error, /The path must start with \/calendar\/v3\//);
  assert.equal(fetch.calls.length, before, 'nothing sent for refused paths');

  const broken = setup({ [`POST ${CALENDAR_PATH}/events/quickAdd`]: jsonResponse(502, { error: { code: 502, message: 'Bad Gateway' } }) });
  const unknown = await callTool(broken.module, 'api_request', { method: 'POST', path: `${CALENDAR_PATH}/events/quickAdd`, query: { text: 'Lunch tomorrow' } }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'api_get');
  assert.equal(broken.apiCalls().length, 1);
});

test('log lines carry no key, token or arguments', async () => {
  const { module, ctx, logs } = setup({ [`POST ${CALENDAR_PATH}/events`]: (request) => jsonResponse(200, { ...created, id: request.json.id }) });
  await callTool(module, 'create_event', { summary: 'Secret meeting with Jane', start: '2030-01-07T11:00:00' }, ctx);
  assert.ok(logs.length >= 2);
  const all = logs.join('\n');
  for (const secret of [ACCESS_TOKEN, 'PRIVATE KEY', KEY_BASE64.slice(0, 40), 'Secret meeting', 'Jane']) assert.equal(all.includes(secret), false, secret);
  for (const line of logs) assert.match(line, /^google-calendar create_event (POST|GET) \d{3} \d+ms$/);
});

test('a text reply from a gateway does not break the result', async () => {
  const { module, ctx } = setup({ [`GET ${CALENDAR_PATH}`]: textResponse(502, '<html>Bad gateway</html>') });
  const { payload, isError } = await callTool(module, 'get_calendar', {}, ctx);
  assert.equal(isError, true);
  assert.equal(payload.error, 'Google Calendar had a server error (HTTP 502). Try again later.');
});
