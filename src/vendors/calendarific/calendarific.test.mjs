import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes, textResponse } from '../../../tests/helpers.mjs';

const KEY = 'calendarific-test-key-0123456789abcdef';
const credentials = { apikey: KEY };

/** A value from the module's sandbox, as plain JSON of this realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup(handler) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(typeof handler === 'function' ? handler : () => jsonResponse(200, handler));
  const { ctx, logs } = makeContext({ credentials, fetch });
  return { module, fetch, ctx, logs };
}

/** The query of a request without the key, which every test checks once. */
function queryOf(request) {
  const { api_key: key, ...rest } = request.query;
  assert.equal(key, KEY, 'the key goes in the api_key parameter');
  return rest;
}

/** Answers each request with the fixture for its year and month. */
function byMonth(request) {
  const { year, month } = request.query;
  const name = month ? `holidays-${year}-${String(month).padStart(2, '0')}.json` : `holidays-${year}.json`;
  return jsonResponse(200, fixture(import.meta.url, name));
}

test('the module reads apikey and reaches only calendarific.com; every tool only reads', () => {
  const { module } = loadModuleFor(import.meta.url);
  assert.deepEqual(plain(module.credentials), ['apikey']);
  assert.deepEqual(plain(module.requiredCredentials), [['apikey']]);
  assert.deepEqual(plain(module.origins), ['https://calendarific.com']);
  assert.deepEqual(plain(module.originFields), []);
  assert.deepEqual(plain(module.accountPickers), []);
  assert.deepEqual(plain(module.tools.map((tool) => tool.name)), ['list_holidays', 'list_upcoming_holidays', 'list_countries', 'list_languages']);
  for (const tool of module.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
});

test('list_holidays sends the country, year and filters with the key, and trims each holiday', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'holidays-2026-12.json'));
  const { payload, isError } = await callTool(module, 'list_holidays', { country: 'us', year: 2026, month: 12 }, ctx);
  assert.equal(isError, false, JSON.stringify(payload));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].origin, 'https://calendarific.com');
  assert.equal(fetch.calls[0].path, '/api/v2/holidays');
  assert.deepEqual(queryOf(fetch.calls[0]), { country: 'US', year: '2026', month: '12' });

  assert.equal(payload.country, 'US');
  assert.equal(payload.year, 2026);
  assert.equal(payload.month, 12);
  assert.equal(payload.count, 6);
  assert.deepEqual(payload.holidays[0], {
    name: 'Pearl Harbor Remembrance Day',
    date: '2026-12-07',
    description: 'Pearl Harbor Remembrance Day remembers the attack on Pearl Harbor on December 7, 1941.',
    types: ['Observance'],
    primaryType: 'Observance',
    locations: 'All',
    states: 'All',
    url: 'https://calendarific.com/holiday/us/pearl-harbor-remembrance-day',
  });
  // An astronomical event keeps its time; a local holiday lists its states.
  assert.equal(payload.holidays[1].date, '2026-12-21T15:50:00-05:00');
  assert.deepEqual(payload.holidays[4].states, ['us-ky', 'us-nc']);
  assert.equal(payload.holidays[4].locations, 'KY, NC');
  // Calendarific's own fields an agent does not need are left out.
  assert.ok(!JSON.stringify(payload).includes('urlid'));
  assert.ok(!JSON.stringify(payload).includes('zoneabb'));
});

test('list_holidays passes day, region, kinds and language', async () => {
  const { module, fetch, ctx } = setup(fixture(import.meta.url, 'holidays-2026-12.json'));
  await callTool(module, 'list_holidays', { country: 'US', year: 2026, month: 12, day: 25, location: 'US-NY', types: ['national', 'religious'], language: 'FR' }, ctx);
  assert.deepEqual(queryOf(fetch.calls[0]), { country: 'US', year: '2026', month: '12', day: '25', location: 'us-ny', type: 'national,religious', language: 'fr' });

  for (const [args, message] of [
    [{ country: 'USA', year: 2026 }, /`country` does not have the expected format/],
    [{ country: 'US' }, /`year` is required/],
    [{ country: 'US', year: 2026, month: 13 }, /`month` must be at most 12/],
    [{ country: 'US', year: 2026, types: ['federal'] }, /`types\[0\]` must be one of "national", "local", "religious", "observance"/],
    [{ country: 'US', year: 2026, location: 'new york' }, /`location` does not have the expected format/],
  ]) {
    const { payload, isError } = await callTool(module, 'list_holidays', args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 1, 'refused calls send nothing');
});

test('a long list is cut under 32 KB and the cursor continues after the last holiday returned', async () => {
  const [base] = fixture(import.meta.url, 'holidays-2026-12.json').response.holidays;
  const many = Array.from({ length: 200 }, (_, index) => ({ ...base, name: `Holiday ${index + 1}`, description: 'd'.repeat(380) }));
  const { module, fetch, ctx } = setup({ meta: { code: 200 }, response: { holidays: many } });
  const first = await callTool(module, 'list_holidays', { country: 'US', year: 2026 }, ctx);
  assert.ok(textBytes(first.result) <= 32 * 1024, `result is ${textBytes(first.result)} bytes`);
  assert.equal(first.payload.truncated, true);
  assert.equal(first.payload.count, 200);
  const shown = first.payload.holidays.length;
  const second = await callTool(module, 'list_holidays', { country: 'US', year: 2026, cursor: first.payload.nextCursor }, ctx);
  assert.equal(second.payload.holidays[0].name, `Holiday ${shown + 1}`);
  assert.equal(fetch.calls.length, 2, 'the next part asks again');
});

test('list_upcoming_holidays asks for each month a window touches and returns its holidays by date', async () => {
  const { module, fetch, ctx } = setup(byMonth);
  const { payload } = await callTool(module, 'list_upcoming_holidays', { country: 'us', from: '2026-12-20', days: 21, types: ['national', 'observance'] }, ctx);
  assert.deepEqual(fetch.calls.map(queryOf), [
    { country: 'US', type: 'national,observance', year: '2026', month: '12' },
    { country: 'US', type: 'national,observance', year: '2027', month: '1' },
  ]);
  assert.equal(payload.from, '2026-12-20');
  assert.equal(payload.to, '2027-01-09');
  assert.deepEqual(payload.holidays.map((holiday) => [holiday.date.slice(0, 10), holiday.name]), [
    ['2026-12-21', 'December Solstice'],
    ['2026-12-24', 'Christmas Eve'],
    ['2026-12-25', 'Christmas Day'],
    ['2026-12-26', 'Day After Christmas Day'],
    ['2026-12-31', "New Year's Eve"],
    ['2027-01-01', "New Year's Day"],
    ['2027-01-07', 'Orthodox Christmas Day'],
  ]);
  assert.equal(payload.count, 7);
});

test('a window over several months of a year asks for the whole year once', async () => {
  const { module, fetch, ctx } = setup(byMonth);
  const { payload } = await callTool(module, 'list_upcoming_holidays', { country: 'US', from: '2026-11-15', days: 30 }, ctx);
  assert.deepEqual(fetch.calls.map(queryOf), [{ country: 'US', year: '2026' }]);
  assert.equal(payload.to, '2026-12-14');
  assert.deepEqual(payload.holidays.map((holiday) => holiday.name), ['Thanksgiving Day', 'Black Friday', 'Pearl Harbor Remembrance Day']);
});

test('list_upcoming_holidays starts today in UTC by default, and refuses a date that does not exist', async () => {
  const { module, fetch, ctx } = setup({ meta: { code: 200 }, response: { holidays: [] } });
  const { payload } = await callTool(module, 'list_upcoming_holidays', { country: 'JP', days: 1 }, ctx);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(payload.from, today);
  assert.equal(payload.to, today);
  assert.deepEqual(payload.holidays, []);
  assert.equal(queryOf(fetch.calls[0]).month, String(Number(today.slice(5, 7))));

  for (const from of ['2026-02-30', '2026-13-01']) {
    const refused = await callTool(module, 'list_upcoming_holidays', { country: 'JP', from }, ctx);
    assert.match(refused.payload.error, /from must be a real date as YYYY-MM-DD/);
  }
  const tooLong = await callTool(module, 'list_upcoming_holidays', { country: 'JP', days: 400 }, ctx);
  assert.match(tooLong.payload.error, /`days` must be at most 366/);
  assert.equal(fetch.calls.length, 1);
});

test('list_countries and list_languages list what the holiday tools take', async () => {
  const countries = setup(fixture(import.meta.url, 'countries.json'));
  const listed = await callTool(countries.module, 'list_countries', {}, countries.ctx);
  assert.equal(countries.fetch.calls[0].path, '/api/v2/countries');
  assert.deepEqual(queryOf(countries.fetch.calls[0]), {});
  assert.deepEqual(listed.payload, {
    count: 3,
    countries: [
      { code: 'US', name: 'United States', holidays: 198, languages: 4 },
      { code: 'TR', name: 'Türkiye', holidays: 74, languages: 2 },
      { code: 'JP', name: 'Japan', holidays: 96, languages: 2 },
    ],
  });

  const languages = setup(fixture(import.meta.url, 'languages.json'));
  const known = await callTool(languages.module, 'list_languages', {}, languages.ctx);
  assert.equal(languages.fetch.calls[0].path, '/api/v2/languages');
  assert.deepEqual(known.payload, {
    count: 3,
    languages: [
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'fr', name: 'French', nativeName: 'français' },
      { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
    ],
  });
});

test('Calendarific errors become clear tool errors', async () => {
  const cases = [
    [() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')), 401, /^Calendarific rejected the API key: check it on your Calendarific account dashboard \(HTTP 401\)\.$/],
    [() => jsonResponse(403, { meta: { code: 403, error_type: 'subscription_expired' }, response: [] }), 403, /^The Calendarific subscription of this API key has expired: renew it on calendarific\.com \(HTTP 403\)\.$/],
    [() => jsonResponse(429, fixture(import.meta.url, 'error-429.json')), 429, /^The Calendarific request limit of this API key is used up for the month \(HTTP 429\)\. It resets when the plan's month starts again/],
    [() => jsonResponse(503, { meta: { code: 503 }, response: [] }), 503, /^Calendarific is down for planned maintenance: try again later \(HTTP 503\)\.$/],
    [() => textResponse(500, '<html>error</html>'), 500, /^Calendarific had a server error \(HTTP 500\)\. Try again later\.$/],
    // A body that says it failed counts, whatever the HTTP status.
    [() => jsonResponse(200, { meta: { code: 422, error_type: 'invalid parameter', error_detail: 'Invalid country\ncode.' }, response: [] }), 422, /^Calendarific refused the request \(code 422\): Invalid country code\.$/],
  ];
  for (const [respond, status, message] of cases) {
    const { module, ctx } = setup(respond);
    const { payload, isError } = await callTool(module, 'list_holidays', { country: 'US', year: 2026 }, ctx);
    assert.equal(isError, true, String(status));
    assert.equal(payload.status, status);
    assert.match(payload.error, message);
  }
  const offline = setup(() => {
    throw new TypeError('fetch failed');
  });
  const unreachable = await callTool(offline.module, 'list_countries', {}, offline.ctx);
  assert.match(unreachable.payload.error, /Calendarific could not be reached \(fetch failed\)/);

  const noKey = makeContext({ credentials: {}, fetch: offline.fetch });
  assert.equal((await callTool(offline.module, 'list_languages', {}, noKey.ctx)).payload.error, 'Calendarific is not connected: the Calendarific API key is missing.');
  assert.equal(offline.fetch.calls.length, 1);
});

test('log lines name the vendor, tool, status and duration, never the key or arguments', async () => {
  const { module, ctx, logs } = setup(fixture(import.meta.url, 'holidays-2026-12.json'));
  await callTool(module, 'list_holidays', { country: 'TR', year: 2026, location: 'tr-34' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^calendarific list_holidays GET 200 \d+ms$/);
  assert.equal(logs.some((line) => line.includes(KEY) || line.includes('tr-34')), false);
});
