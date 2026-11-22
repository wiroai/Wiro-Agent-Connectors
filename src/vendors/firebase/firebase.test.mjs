import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext } from '../../../tests/helpers.mjs';

// The keys are made here, for this run: no key is ever stored in the repository.
function serviceAccount(projectId, email) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: `kid-${projectId}`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: email,
  };
}
const MAIN = serviceAccount('example-push', 'firebase-adminsdk-x1@example-push.iam.gserviceaccount.com');
const SECOND = serviceAccount('example-pro', 'firebase-adminsdk-y2@example-pro.iam.gserviceaccount.com');
const base64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND = '/v1/projects/example-push/messages:send';
const DEVICE = 'fT9xExampleRegistrationToken:APA91bExampleTokenBody0123456789';
const decoder = new TextDecoder();

// The shape an older setup stored: base64 keys and topic rows.
const LEGACY = [
  {
    appname: 'Example App',
    projectid: 'stale-id',
    serviceaccountjson: base64(MAIN),
    apps: [{ platform: 'ios', id: '1234567890' }, { platform: 'android', id: 'com.example.app' }],
    topics: [{ topickey: 'locale_en', topicdesc: 'English speaking users' }, { topickey: 'tier_paid', topicdesc: 'Users with active subscription' }],
  },
  {
    appName: 'Example Pro',
    serviceAccountJsonBase64: base64(SECOND),
    apps: [{ platform: 'android', packageName: 'com.example.pro' }],
    topics: { locale_tr: 'Turkish speaking users' },
  },
];

function setup(routes, accounts = JSON.stringify(LEGACY)) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch((request) => {
    if (request.url === TOKEN_URL) {
      const assertion = new URLSearchParams(decoder.decode(request.body)).get('assertion');
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
      return jsonResponse(200, { access_token: `ya29.token-for-${claims.iss.split('@')[1].split('.')[0]}`, expires_in: 3599, token_type: 'Bearer' });
    }
    const route = routes[`${request.method} ${request.path}`];
    if (!route) return jsonResponse(500, { error: { code: 500, message: `unexpected ${request.method} ${request.path}` } });
    // A route's Response is cloned, so it can answer more than once.
    return typeof route === 'function' ? route(request) : route.clone();
  });
  const { ctx, logs } = makeContext({ credentials: { accounts }, fetch });
  const sends = () => fetch.calls.filter((call) => call.url !== TOKEN_URL);
  return { module, context, fetch, ctx, logs, sends };
}

test('list_projects reads the connected projects from the settings, without calling Firebase', async () => {
  const { module, fetch, ctx } = setup({});
  const { payload, isError } = await callTool(module, 'list_projects', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(payload.projects, [
    {
      project: 'example-push',
      appName: 'Example App',
      serviceAccount: MAIN.client_email,
      apps: [{ platform: 'ios', id: '1234567890' }, { platform: 'android', id: 'com.example.app' }],
      topics: [{ topic: 'locale_en', description: 'English speaking users' }, { topic: 'tier_paid', description: 'Users with active subscription' }],
    },
    {
      project: 'example-pro',
      appName: 'Example Pro',
      serviceAccount: SECOND.client_email,
      apps: [{ platform: 'android', id: 'com.example.pro' }],
      topics: [{ topic: 'locale_tr', description: 'Turkish speaking users' }],
    },
  ]);
  assert.equal(JSON.stringify(payload).includes('PRIVATE KEY'), false);
});

test('the accounts value may be one key file, an object with accounts, or base64 of either', async () => {
  for (const accounts of [JSON.stringify(MAIN), base64(MAIN), JSON.stringify({ accounts: [{ serviceaccountjson: MAIN }] }), base64(JSON.stringify(LEGACY))]) {
    const { module, ctx } = setup({}, accounts);
    const { payload, isError } = await callTool(module, 'list_projects', {}, ctx);
    assert.equal(isError, false, payload.error);
    assert.equal(payload.projects[0].project, 'example-push');
  }
  const single = setup({}, JSON.stringify(MAIN));
  assert.deepEqual((await callTool(single.module, 'list_projects', {}, single.ctx)).payload.projects, [
    { project: 'example-push', appName: 'example-push', serviceAccount: MAIN.client_email, topics: [] },
  ]);
});

test('an unreadable accounts value is refused with what to give, and never quoted', async () => {
  for (const [accounts, message] of [
    ['not json at all', /^The Firebase accounts value could not be read as JSON\. Give the service account key file/],
    ['[]', /^The Firebase accounts list is empty/],
    [JSON.stringify([{ appname: 'x', serviceaccountjson: 'garbage-secret' }]), /^The Firebase project has no usable service account key/],
    [JSON.stringify([{ serviceaccountjson: MAIN }, { appname: 'Broken' }]), /^Firebase project 2 of the accounts list has no usable service account key/],
    [JSON.stringify([{ serviceaccountjson: { ...MAIN, project_id: undefined } }]), /has no valid project id/],
  ]) {
    const { module, fetch, ctx } = setup({}, accounts);
    const { payload, isError } = await callTool(module, 'send_message', { topic: 'locale_en', title: 'Hi', body: 'There' }, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
    assert.equal(payload.error.includes('garbage-secret'), false);
    assert.equal(fetch.calls.length, 0);
  }
});

test('send_message sends one FCM v1 message to a topic, with the project\'s own token and the Android and iOS options', async () => {
  const { module, fetch, ctx, sends } = setup({ [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'sent.json')) });
  const { payload, isError } = await callTool(module, 'send_message', {
    project: 'Example App',
    topic: '/topics/locale_en',
    title: 'Spring refresh',
    body: 'New templates are here. Tap to create.',
    image_url: 'https://cdn.example.com/push/spring.jpg',
    data: { screen: 'home', eventId: 'eid-2026' },
    android_channel_id: 'promotions',
    click_action: 'OPEN_PROMOTION',
    sound: 'default',
    badge: 1,
    priority: 'high',
    analytics_label: 'spring-2026',
  }, ctx);
  assert.equal(isError, false, payload.error);
  const exchange = fetch.calls.find((call) => call.url === TOKEN_URL);
  const claims = JSON.parse(Buffer.from(new URLSearchParams(decoder.decode(exchange.body)).get('assertion').split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.iss, MAIN.client_email);

  const [request] = sends();
  assert.equal(request.url, 'https://fcm.googleapis.com/v1/projects/example-push/messages:send');
  assert.equal(request.headers.authorization, 'Bearer ya29.token-for-example-push');
  assert.deepEqual(request.json, {
    message: {
      topic: 'locale_en',
      notification: { title: 'Spring refresh', body: 'New templates are here. Tap to create.', image: 'https://cdn.example.com/push/spring.jpg' },
      data: { screen: 'home', eventId: 'eid-2026' },
      android: { priority: 'HIGH', notification: { channel_id: 'promotions', click_action: 'OPEN_PROMOTION', sound: 'default' } },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default', badge: 1, 'mutable-content': 1 } },
        fcm_options: { image: 'https://cdn.example.com/push/spring.jpg' },
      },
      fcm_options: { analytics_label: 'spring-2026' },
    },
  });
  assert.deepEqual(payload, {
    sent: true,
    project: 'example-push',
    appName: 'Example App',
    target: 'topic locale_en',
    messageId: 'projects/example-push/messages/0:1767225600000000%31bd1c9631bd1c96',
  });
});

test('the project is picked by id, app name or app id; it is needed when several are connected', async () => {
  const { module, fetch, ctx, sends } = setup({
    [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'sent.json')),
    'POST /v1/projects/example-pro/messages:send': jsonResponse(200, { name: 'projects/example-pro/messages/1' }),
  });
  await callTool(module, 'send_message', { project: 'com.example.pro', condition: "'locale_tr' in topics", title: 'Merhaba', body: 'Yeni şablonlar' }, ctx);
  assert.equal(sends()[0].path, '/v1/projects/example-pro/messages:send');
  assert.equal(sends()[0].headers.authorization, 'Bearer ya29.token-for-example-pro');
  await callTool(module, 'send_message', { project: '1234567890', token: DEVICE, title: 'Test', body: 'Test push' }, ctx);
  assert.equal(sends()[1].path, SEND);
  assert.equal(sends()[1].json.message.token, DEVICE);

  const before = fetch.calls.length;
  const missing = await callTool(module, 'send_message', { topic: 'locale_en', title: 'a', body: 'b' }, ctx);
  assert.equal(missing.payload.error, 'Several Firebase projects are connected: give project, one of example-push (Example App), example-pro (Example Pro). Nothing was sent.');
  const unknown = await callTool(module, 'send_message', { project: 'nope', topic: 'locale_en', title: 'a', body: 'b' }, ctx);
  assert.match(unknown.payload.error, /^No connected Firebase project matches "nope"/);
  assert.equal(fetch.calls.length, before);
});

test('the target, condition, data and content are checked before anything is sent', async () => {
  const { module, fetch, ctx } = setup({}, JSON.stringify(MAIN));
  for (const [args, message] of [
    [{ title: 'a', body: 'b' }, /Give one target: topic, condition or token/],
    [{ topic: 'a', token: DEVICE, title: 'a' }, /Give one target/],
    [{ condition: "'a' in topics && 'b' in topics && 'c' in topics && 'd' in topics && 'e' in topics && 'f' in topics", title: 'a' }, /names 6 topics; Firebase allows 5/],
    [{ condition: 'everyone', title: 'a' }, /condition names no topic/],
    [{ topic: 'a', data: { count: 3 } }, /data values must be text/],
    [{ topic: 'a', data: { blob: 'x'.repeat(5000) } }, /larger than the 4 KB/],
    [{ topic: 'a' }, /The message is empty/],
  ]) {
    const { payload, isError } = await callTool(module, 'send_message', args, ctx);
    assert.equal(isError, true);
    assert.match(payload.error, message);
  }
  assert.equal(fetch.calls.length, 0);
});

test('raw platform options merge over the simple ones, and a time to live sets both platforms', async () => {
  const { module, context, ctx, sends } = setup({ [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'sent.json')) }, JSON.stringify(MAIN));
  controlClock(context)(Date.parse('2030-01-01T00:00:00Z') - Date.now());
  await callTool(module, 'send_message', {
    topic: 'all',
    data: { refresh: 'true' },
    sound: 'default',
    ttl_seconds: 3600,
    collapse_key: 'refresh',
    android: { notification: { color: '#ff0000', sound: 'chime' }, direct_boot_ok: true },
    apns: { payload: { aps: { 'content-available': 1 } } },
    webpush: { fcm_options: { link: 'https://example.com/offers' } },
  }, ctx);
  const { message } = sends()[0].json;
  assert.deepEqual(message.android, { ttl: '3600s', collapse_key: 'refresh', notification: { sound: 'chime', color: '#ff0000' }, direct_boot_ok: true });
  assert.deepEqual(message.apns, {
    headers: { 'apns-collapse-id': 'refresh', 'apns-expiration': String(Date.parse('2030-01-01T00:00:00Z') / 1000 + 3600) },
    payload: { aps: { sound: 'default', 'content-available': 1 } },
  });
  assert.deepEqual(message.webpush, { fcm_options: { link: 'https://example.com/offers' } });
  assert.equal(message.notification, undefined);
});

test('validate_message has Firebase check the message without delivering it, and hides the device token', async () => {
  const { module, ctx, sends } = setup({ [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'validated.json')) }, JSON.stringify(MAIN));
  const { payload, isError } = await callTool(module, 'validate_message', { token: DEVICE, title: 'Test', body: 'Test push' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(sends()[0].json.validate_only, true);
  assert.deepEqual(payload, {
    valid: true,
    project: 'example-push',
    appName: 'example-push',
    target: 'one device token',
    message: { token: '(device token)', notification: { title: 'Test', body: 'Test push' } },
  });

  const refused = setup({ [`POST ${SEND}`]: jsonResponse(400, fixture(import.meta.url, 'error-invalid.json')) }, JSON.stringify(MAIN));
  const invalid = await callTool(refused.module, 'validate_message', { topic: 'all', title: 'x', android: { notification: { color: 'red' } } }, refused.ctx);
  assert.match(invalid.payload.error, /^Firebase did not accept the message \(HTTP 400\)\. Firebase said: "Invalid value at 'message\.android\.notification\.color'/);
  assert.equal(invalid.payload.error.includes('Nothing was changed'), false, 'a read tool changes nothing anyway');
});

test('check_projects validates a test message for every project and names the one that fails', async () => {
  const ok = setup({
    [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'validated.json')),
    'POST /v1/projects/example-pro/messages:send': jsonResponse(200, { name: 'projects/example-pro/messages/fake_message_id' }),
  });
  const { payload } = await callTool(ok.module, 'check_projects', {}, ok.ctx);
  assert.deepEqual(payload, { projects: [{ project: 'example-push', appName: 'Example App', ok: true }, { project: 'example-pro', appName: 'Example Pro', ok: true }] });
  for (const call of ok.sends()) {
    assert.equal(call.json.validate_only, true);
    assert.equal(call.json.message.topic, 'connection-check');
  }

  const failing = setup({
    [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'validated.json')),
    'POST /v1/projects/example-pro/messages:send': jsonResponse(403, fixture(import.meta.url, 'error-permission.json')),
  });
  const refused = await callTool(failing.module, 'check_projects', {}, failing.ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.status, 403);
  assert.match(refused.payload.error, /^The Firebase project example-pro \(2 of 2\) failed the check: Firebase refused the service account firebase-adminsdk-y2@example-pro\.iam\.gserviceaccount\.com: give it the Firebase Cloud Messaging API Admin role/);
});

test('an unclear send is reported as unknown, sent once, and says that Firebase cannot look it up', async () => {
  const { module, ctx, sends } = setup({ [`POST ${SEND}`]: jsonResponse(503, { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }) }, JSON.stringify(MAIN));
  const { payload, isError } = await callTool(module, 'send_message', { topic: 'locale_en', title: 'a', body: 'b' }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, 'unknown');
  assert.equal(payload.check, undefined, 'no tool can check it');
  assert.equal(
    payload.error,
    'Firebase answered HTTP 503: The service is currently unavailable, so it is not known whether the message was sent. '
      + 'Firebase keeps no list of sent messages to look it up: send it again only if a second notification is acceptable.',
  );
  assert.equal(sends().length, 1);

  const offline = setup({ [`POST ${SEND}`]: () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); } }, JSON.stringify(MAIN));
  const timedOut = await callTool(offline.module, 'send_message', { topic: 'locale_en', title: 'a', body: 'b' }, offline.ctx);
  assert.equal(timedOut.payload.outcome, 'unknown');
  assert.match(timedOut.payload.error, /^Firebase did not answer \(the request timed out\), so it is not known whether the message was sent\./);
});

test('a token that is not registered, a missing permission and a quota limit come back plainly', async () => {
  const gone = setup({ [`POST ${SEND}`]: jsonResponse(404, fixture(import.meta.url, 'error-unregistered.json')) }, JSON.stringify(MAIN));
  const unregistered = await callTool(gone.module, 'send_message', { token: DEVICE, title: 'a', body: 'b' }, gone.ctx);
  assert.equal(unregistered.payload.status, 404);
  assert.match(unregistered.payload.error, /stop sending to it \(HTTP 404\)\. Firebase said: "Requested entity was not found\."\. Nothing was changed\.$/);

  const denied = setup({ [`POST ${SEND}`]: jsonResponse(403, fixture(import.meta.url, 'error-permission.json')) }, JSON.stringify(MAIN));
  const forbidden = await callTool(denied.module, 'send_message', { topic: 'all', title: 'a', body: 'b' }, denied.ctx);
  assert.match(forbidden.payload.error, /^Firebase refused the service account firebase-adminsdk-x1@example-push\.iam\.gserviceaccount\.com: give it the Firebase Cloud Messaging API Admin role in the project example-push/);

  const limited = setup({ [`POST ${SEND}`]: jsonResponse(429, fixture(import.meta.url, 'error-quota.json'), { 'retry-after': '60' }) }, JSON.stringify(MAIN));
  const rate = await callTool(limited.module, 'send_message', { topic: 'all', title: 'a', body: 'b' }, limited.ctx);
  assert.equal(rate.payload.retryAfter, 60);
  assert.match(rate.payload.error, /^Firebase rate limit reached \(HTTP 429\)\. Nothing was changed\. Retry after 60 seconds\.$/);
});

test('log lines carry no key, token or message content', async () => {
  const { module, ctx, logs } = setup({ [`POST ${SEND}`]: jsonResponse(200, fixture(import.meta.url, 'sent.json')) }, JSON.stringify(MAIN));
  await callTool(module, 'send_message', { token: DEVICE, title: 'Private title', body: 'Private body' }, ctx);
  const all = logs.join('\n');
  for (const secret of ['ya29', 'PRIVATE KEY', DEVICE, 'Private title', 'Private body']) assert.equal(all.includes(secret), false, secret);
  for (const line of logs) assert.match(line, /^firebase send_message POST \d{3} \d+ms$/);
});
