import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'eyJexampleRedditAccessToken123';
const credentials = { access_token: TOKEN, developerprofileusername: 'u/acme_dev', redditusername: 'acme_social' };
const UA = 'server:agent-connectors:1.0 (by /u/acme_dev)';
const RATE = { 'x-ratelimit-used': '12', 'x-ratelimit-remaining': '588.0', 'x-ratelimit-reset': '300' };
const me = fixture(import.meta.url, 'me.json');
const submitOk = fixture(import.meta.url, 'submit-ok.json');
const commentOk = fixture(import.meta.url, 'comment-ok.json');
const ownPost = fixture(import.meta.url, 'info-own-post.json');

const SELF_POST = { subreddit: 'r/test', kind: 'self', title: 'Connector smoke test', text: 'Hello from the test.', nsfw: false, spoiler: false };

function setup(handler, { creds = credentials } = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, fetch });
  return { module, fetch, ctx, logs };
}

/** The form fields of a request Reddit gets as application/x-www-form-urlencoded. */
function formOf(request) {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body)));
}

/** A Reddit that answers by path, with its rate headers on every reply. */
function reddit(overrides = {}) {
  return (request) => {
    const key = `${request.method} ${request.path}`;
    if (overrides[key]) return overrides[key](request);
    if (key === 'GET /api/v1/me') return jsonResponse(200, me, RATE);
    if (key === 'POST /api/submit') return jsonResponse(200, submitOk, RATE);
    if (key === 'POST /api/comment') return jsonResponse(200, commentOk, RATE);
    if (key === 'GET /api/info') return jsonResponse(200, ownPost, RATE);
    if (key === 'POST /api/editusertext') return jsonResponse(200, fixture(import.meta.url, 'edit-ok.json'), RATE);
    if (key === 'POST /api/del') return jsonResponse(200, {}, RATE);
    if (key === 'GET /subreddits/mine/subscriber' || key === 'GET /subreddits/mine/contributor') return jsonResponse(200, fixture(import.meta.url, 'subreddits.json'), RATE);
    if (key === 'GET /r/test/about/rules') return jsonResponse(200, fixture(import.meta.url, 'rules.json'), RATE);
    if (key === 'GET /user/acme_social/submitted') return jsonResponse(200, fixture(import.meta.url, 'submitted.json'), RATE);
    if (key === 'GET /user/acme_social/comments') return jsonResponse(200, fixture(import.meta.url, 'comments.json'), RATE);
    throw new Error(`unexpected request ${key}`);
  };
}

test('get_me sends the token and Reddit\'s User-Agent naming the developer profile, and reports the rate window', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const { payload, isError } = await callTool(module, 'get_me', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.url, 'https://oauth.reddit.com/api/v1/me');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers['user-agent'], UA);
  assert.deepEqual(payload, {
    name: 'acme_social',
    id: 't2_abc12de',
    url: 'https://www.reddit.com/user/acme_social/',
    linkKarma: 120,
    commentKarma: 45,
    totalKarma: 165,
    createdAt: '2020-09-13T12:26:40.000Z',
    verifiedEmail: true,
    rateLimit: { used: 12, remaining: 588, resetSeconds: 300 },
  });
});

test('list_my_subreddits and get_subreddit_rules read one page and one community', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const subs = await callTool(module, 'list_my_subreddits', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://oauth.reddit.com/subreddits/mine/subscriber?limit=100&raw_json=1');
  assert.deepEqual(subs.payload.subreddits[1], { name: 'boxes', title: 'All about boxes', url: 'https://www.reddit.com/r/boxes/', subscribers: 3200, type: 'restricted', submissionType: 'self' });
  await callTool(module, 'list_my_subreddits', { cursor: subs.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.after, 't5_2qh1i');

  const rules = await callTool(module, 'get_subreddit_rules', { subreddit: 'r/test' }, ctx);
  assert.equal(fetch.calls[2].url, 'https://oauth.reddit.com/r/test/about/rules?raw_json=1');
  assert.deepEqual(rules.payload.rules, [
    { name: 'Limit self-promotion', appliesTo: 'link', description: 'No self-promotion more than once a week.', violationReason: 'Self-promotion' },
    { name: 'Be civil', appliesTo: 'all', description: 'Be kind.' },
  ]);
  assert.equal(rules.payload.siteRules.length, 3);

  const bad = await callTool(module, 'get_subreddit_rules', { subreddit: '../api/v1/me' }, ctx);
  assert.match(bad.payload.error, /`subreddit` does not have the expected format/);
  assert.equal(fetch.calls.length, 3);
});

test('submit_post sends one text post as a form, with nsfw and spoiler as given', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const { payload, isError } = await callTool(module, 'submit_post', { ...SELF_POST, flair_id: 'f1a2b3c4' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1, 'the account name came from the credential');
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://oauth.reddit.com/api/submit');
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(request.headers['user-agent'], UA);
  assert.deepEqual(formOf(request), {
    api_type: 'json',
    kind: 'self',
    sr: 'test',
    title: 'Connector smoke test',
    text: 'Hello from the test.',
    nsfw: 'false',
    spoiler: 'false',
    sendreplies: 'true',
    flair_id: 'f1a2b3c4',
  });
  assert.deepEqual(payload, {
    id: 't3_1abcde',
    url: 'https://www.reddit.com/r/test/comments/1abcde/connector_smoke_test/',
    subreddit: 'test',
    kind: 'self',
    rateLimit: { used: 12, remaining: 588, resetSeconds: 300 },
  });
});

test('without a stored username, submit_post asks Reddit who is connected first', async () => {
  const { module, fetch, ctx } = setup(reddit(), { creds: { access_token: TOKEN, developerprofileusername: 'acme_dev' } });
  const { isError } = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(isError, false);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/v1/me', 'POST /api/submit']);
});

test('the same post is never sent twice, nor the same text to another community, a near copy included', async () => {
  const { module, fetch, ctx } = setup(reddit());
  await callTool(module, 'submit_post', SELF_POST, ctx);
  const again = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(again.isError, true);
  assert.match(again.payload.error, /This exact Reddit post already went through in the last 48 hours, so it was not sent again\. Nothing was sent\./);

  const elsewhere = await callTool(module, 'submit_post', { ...SELF_POST, subreddit: 'boxes', title: '  connector SMOKE   test ' }, ctx);
  assert.match(elsewhere.payload.error, /The same post text went to another community in the last 48 hours\. Reddit does not allow repeating it/);
  assert.equal(fetch.calls.length, 1);

  const link = { subreddit: 'test', kind: 'link', title: 'Our launch', url: 'https://www.example.com/launch?utm_source=reddit&id=7', nsfw: false, spoiler: false };
  await callTool(module, 'submit_post', link, ctx);
  assert.equal(formOf(fetch.calls[1]).url, link.url, 'the link goes as given');
  const tracked = await callTool(module, 'submit_post', { ...link, subreddit: 'boxes', url: 'https://www.example.com/launch?id=7&utm_campaign=x#top' }, ctx);
  assert.match(tracked.payload.error, /The same post text went to another community/);
  assert.equal(fetch.calls.length, 2);
});

test('Reddit\'s JSON errors are failures: a refused post may be fixed and sent again, a write limit holds writes back', async () => {
  let reply = fixture(import.meta.url, 'submit-error.json');
  const { module, fetch, ctx } = setup(reddit({ 'POST /api/submit': () => jsonResponse(200, reply, RATE) }));
  const refused = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.vendorCode, 'SUBREDDIT_NOEXIST');
  assert.equal(refused.payload.error, "Reddit did not accept the post (SUBREDDIT_NOEXIST, sr): that community doesn't exist. Nothing was changed.");

  reply = fixture(import.meta.url, 'submit-ratelimit.json');
  const limited = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(fetch.calls.length, 2, 'a refused post does not block the same post');
  assert.equal(limited.payload.vendorCode, 'RATELIMIT');
  assert.equal(limited.payload.retryAfter, 541);
  assert.match(limited.payload.error, /Reddit asked to slow down before another post: Looks like you've been doing that a lot\. Take a break for 9 minutes before trying again\. Nothing was changed\. Retry after 541 seconds, with a fresh approval\./);

  const held = await callTool(module, 'add_comment', { thing_id: 't3_1abcde', text: 'Nice' }, ctx);
  assert.match(held.payload.error, /Reddit's rate limit for this app needs a pause\. Nothing was sent\. Retry after \d+ seconds\./);
  assert.equal(fetch.calls.length, 2, 'writes wait');
  const read = await callTool(module, 'get_me', {}, ctx);
  assert.equal(read.isError, false, 'reads go on');
});

test('an unclear post is never sent again until a check and an explicit go-ahead', async () => {
  let fail = true;
  const { module, fetch, ctx } = setup(reddit({ 'POST /api/submit': () => (fail ? jsonResponse(503, { message: 'Service Unavailable' }) : jsonResponse(200, submitOk, RATE)) }));
  const unknown = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_my_posts');
  assert.equal(fetch.calls.length, 1);

  const blocked = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.match(blocked.payload.error, /An identical Reddit post was sent earlier and its outcome is unknown\. Check list_my_posts first; only if it is not there and a new attempt is approved, call again with allow_repeat_after_check: true\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 1);

  fail = false;
  const retried = await callTool(module, 'submit_post', { ...SELF_POST, allow_repeat_after_check: true }, ctx);
  assert.equal(retried.isError, false, retried.payload.error);
  assert.equal(fetch.calls.length, 2);

  const noData = setup(reddit({ 'POST /api/submit': () => jsonResponse(200, { json: { errors: [] } }, RATE) }));
  const unclear = await callTool(noData.module, 'submit_post', SELF_POST, noData.ctx);
  assert.equal(unclear.payload.outcome, 'unknown', 'success needs the new post\'s id or link');
});

test('submit_post checks its own arguments before anything is sent', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const noUrl = await callTool(module, 'submit_post', { ...SELF_POST, kind: 'link', text: undefined }, ctx);
  assert.match(noUrl.payload.error, /A link post \(kind link\) needs url/);
  const selfUrl = await callTool(module, 'submit_post', { ...SELF_POST, url: 'https://www.example.com/' }, ctx);
  assert.match(selfUrl.payload.error, /A text post \(kind self\) takes text, not url/);
  const { nsfw: _nsfw, ...unset } = SELF_POST;
  const missing = await callTool(module, 'submit_post', unset, ctx);
  assert.match(missing.payload.error, /`nsfw` is required/);
  const long = await callTool(module, 'submit_post', { ...SELF_POST, title: 'x'.repeat(301) }, ctx);
  assert.match(long.payload.error, /`title` must be at most 300 characters/);
  assert.equal(fetch.calls.length, 0);
});

test('add_comment replies once to one fullname; the same text is not repeated on another thread', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const { payload, isError } = await callTool(module, 'add_comment', { thing_id: 't3_1abcde', text: 'Thanks for testing!' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(formOf(fetch.calls[0]), { api_type: 'json', thing_id: 't3_1abcde', text: 'Thanks for testing!' });
  assert.deepEqual(payload, {
    id: 't1_kxyz12',
    url: 'https://www.reddit.com/r/test/comments/1abcde/connector_smoke_test/kxyz12/',
    parentId: 't3_1abcde',
    postId: 't3_1abcde',
    rateLimit: { used: 12, remaining: 588, resetSeconds: 300 },
  });
  const twice = await callTool(module, 'add_comment', { thing_id: 't3_1abcde', text: 'thanks for  testing!' }, ctx);
  assert.match(twice.payload.error, /This exact Reddit comment already went through/);
  const fanOut = await callTool(module, 'add_comment', { thing_id: 't1_other1', text: 'Thanks for testing!' }, ctx);
  assert.match(fanOut.payload.error, /The same comment text went to another thread in the last 48 hours/);
  assert.equal(fetch.calls.length, 1);
  const badTarget = await callTool(module, 'add_comment', { thing_id: 't2_abc', text: 'x' }, ctx);
  assert.match(badTarget.payload.error, /`thing_id` does not have the expected format/);
});

test('edit_text checks with Reddit that the post is the account\'s own, then replaces its text', async () => {
  const { module, fetch, ctx } = setup(reddit());
  const { payload, isError } = await callTool(module, 'edit_text', { thing_id: 't3_1abcde', text: 'Updated text' }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.path}`), ['GET /api/v1/me', 'GET /api/info', 'POST /api/editusertext']);
  assert.deepEqual(fetch.calls[1].query, { id: 't3_1abcde', raw_json: '1' });
  assert.deepEqual(formOf(fetch.calls[2]), { api_type: 'json', thing_id: 't3_1abcde', text: 'Updated text' });
  assert.deepEqual(payload, { id: 't3_1abcde', url: 'https://www.reddit.com/r/test/comments/1abcde/connector_smoke_test/', edited: true, rateLimit: { used: 12, remaining: 588, resetSeconds: 300 } });

  // Doing the same edit again changes nothing more, so it may go again.
  const again = await callTool(module, 'edit_text', { thing_id: 't3_1abcde', text: 'Updated text' }, ctx);
  assert.equal(again.isError, false);
});

test('edits and deletes of someone else\'s item, or of a link post\'s text, are refused before the write', async () => {
  const other = setup(reddit({ 'GET /api/info': () => jsonResponse(200, fixture(import.meta.url, 'info-other.json'), RATE) }));
  const notMine = await callTool(other.module, 'delete_item', { thing_id: 't1_other1' }, other.ctx);
  assert.match(notMine.payload.error, /t1_other1 is not the connected account's own comment \(or it was already deleted\), so it cannot be changed here\. Nothing was changed\./);
  assert.deepEqual(other.fetch.calls.map((call) => call.method), ['GET', 'GET']);

  const link = setup(reddit({ 'GET /api/info': () => jsonResponse(200, fixture(import.meta.url, 'info-link-post.json'), RATE) }));
  const noText = await callTool(link.module, 'edit_text', { thing_id: 't3_1link1', text: 'x' }, link.ctx);
  assert.match(noText.payload.error, /t3_1link1 is a link post, which has no text to edit/);

  const gone = setup(reddit({ 'GET /api/info': () => jsonResponse(200, { kind: 'Listing', data: { children: [] } }, RATE) }));
  const missing = await callTool(gone.module, 'delete_item', { thing_id: 't3_gone1' }, gone.ctx);
  assert.match(missing.payload.error, /Reddit found no post or comment t3_gone1, so there is nothing to delete/);
  assert.equal([...link.fetch.calls, ...gone.fetch.calls].some((call) => call.method === 'POST'), false);
});

test('delete_item deletes the account\'s own post, after which the same post may be written again', async () => {
  const { module, fetch, ctx } = setup(reddit());
  await callTool(module, 'submit_post', SELF_POST, ctx);
  const deleted = await callTool(module, 'delete_item', { thing_id: 't3_1abcde' }, ctx);
  assert.equal(deleted.isError, false, deleted.payload.error);
  assert.deepEqual(deleted.payload, { id: 't3_1abcde', deleted: true, rateLimit: { used: 12, remaining: 588, resetSeconds: 300 } });
  assert.deepEqual(formOf(fetch.calls.at(-1)), { id: 't3_1abcde' });
  const reposted = await callTool(module, 'submit_post', SELF_POST, ctx);
  assert.equal(reposted.isError, false, reposted.payload.error);
});

test('list_my_posts, list_my_comments and get_items read the account\'s own history', async () => {
  const { module, fetch, ctx } = setup(reddit({ 'GET /api/info': () => jsonResponse(200, ownPost, RATE) }));
  const postsPage = await callTool(module, 'list_my_posts', {}, ctx);
  assert.equal(fetch.calls[0].url, 'https://oauth.reddit.com/user/acme_social/submitted?sort=new&limit=25&raw_json=1');
  assert.deepEqual(postsPage.payload.posts[0], {
    id: 't3_1abcde',
    type: 'post',
    subreddit: 'test',
    author: 'acme_social',
    title: 'Connector smoke test',
    url: 'https://www.reddit.com/r/test/comments/1abcde/connector_smoke_test/',
    text: 'Hello',
    selfPost: true,
    score: 1,
    comments: 0,
    createdAt: new Date(1795290000 * 1000).toISOString(),
  });
  await callTool(module, 'list_my_posts', { cursor: postsPage.payload.nextCursor }, ctx);
  assert.equal(fetch.calls[1].query.after, 't3_0zzzzz');

  const commentsPage = await callTool(module, 'list_my_comments', { limit: 10 }, ctx);
  assert.equal(fetch.calls[2].query.limit, '10');
  assert.equal(commentsPage.payload.comments[0].postTitle, 'Connector smoke test');
  assert.equal(commentsPage.payload.comments[0].edited, true);
  assert.equal(commentsPage.payload.nextCursor, undefined);

  const items = await callTool(module, 'get_items', { ids: ['t3_1abcde', 't1_nothere'] }, ctx);
  assert.equal(fetch.calls[3].query.id, 't3_1abcde,t1_nothere');
  assert.deepEqual(items.payload.missing, ['t1_nothere']);
});

test('the rate window: a spent window or a 429 stops every request until the reset, and the last request waits for a write', async () => {
  const spent = setup(reddit({ 'GET /api/v1/me': () => jsonResponse(200, me, { 'x-ratelimit-used': '600', 'x-ratelimit-remaining': '0.0', 'x-ratelimit-reset': '42' }) }));
  await callTool(spent.module, 'get_me', {}, spent.ctx);
  const paused = await callTool(spent.module, 'list_my_posts', {}, spent.ctx);
  assert.match(paused.payload.error, /needs a pause\. Nothing was sent\. Retry after 4[12] seconds\./);
  assert.equal(spent.fetch.calls.length, 1);

  const throttled = setup(reddit({ 'GET /api/v1/me': () => textResponse(429, 'Too Many Requests', { 'x-ratelimit-reset': '12' }) }));
  const first = await callTool(throttled.module, 'get_me', {}, throttled.ctx);
  assert.equal(first.payload.retryAfter, 12);
  const second = await callTool(throttled.module, 'get_me', {}, throttled.ctx);
  assert.match(second.payload.error, /Nothing was sent/);
  assert.equal(throttled.fetch.calls.length, 1);

  const lastOne = setup(reddit({ 'GET /api/v1/me': () => jsonResponse(200, me, { 'x-ratelimit-used': '599', 'x-ratelimit-remaining': '1.0', 'x-ratelimit-reset': '30' }) }));
  await callTool(lastOne.module, 'get_me', {}, lastOne.ctx);
  const read = await callTool(lastOne.module, 'list_my_posts', {}, lastOne.ctx);
  assert.match(read.payload.error, /Only one Reddit request is left in this rate window, kept for a post or comment/);
  const write = await callTool(lastOne.module, 'submit_post', SELF_POST, lastOne.ctx);
  assert.equal(write.isError, false, write.payload.error);
});

test('requests of one app go out one at a time', async () => {
  let inFlight = 0;
  let most = 0;
  const { module, ctx } = setup(async (request) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return reddit()(request);
  });
  await Promise.all([callTool(module, 'get_me', {}, ctx), callTool(module, 'list_my_posts', {}, ctx), callTool(module, 'get_subreddit_rules', { subreddit: 'test' }, ctx)]);
  assert.equal(most, 1);
});

test('api_get reads inside the rate window with the User-Agent; there is no api_request', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { kind: 't5', data: { display_name: 'test' } }, RATE));
  assert.equal(module.tools.some((tool) => tool.name === 'api_request'), false);
  const about = await callTool(module, 'api_get', { path: '/r/test/about', query: { raw_json: 1 } }, ctx);
  assert.equal(about.isError, false, about.payload.error);
  assert.equal(fetch.calls[0].url, 'https://oauth.reddit.com/r/test/about?raw_json=1');
  assert.equal(fetch.calls[0].headers['user-agent'], UA);
  const none = await callTool(module, 'api_request', { method: 'POST', path: '/api/vote' }, ctx);
  assert.match(none.payload.error, /Unknown tool "api_request"/);
});

test('a developer profile username Reddit would not accept stops every tool before it sends anything', async () => {
  const { module, fetch, ctx } = setup(reddit(), { creds: { access_token: TOKEN, developerprofileusername: 'not a valid name!' } });
  for (const [tool, args] of [['get_me', {}], ['submit_post', SELF_POST], ['api_get', { path: '/r/test/about' }]]) {
    const { payload } = await callTool(module, tool, args, ctx);
    assert.match(payload.error, /The Reddit developer profile username must be the 3 to 20 letters/);
  }
  assert.equal(fetch.calls.length, 0);

  const missing = setup(reddit(), { creds: { access_token: TOKEN } });
  const notConnected = await callTool(missing.module, 'get_me', {}, missing.ctx);
  assert.equal(notConnected.payload.error, 'Reddit is not connected: the Reddit developer profile username is missing.');
});

test('Reddit\'s 401 asks for a reconnect, and log lines carry no token or text', async () => {
  const denied = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const auth = await callTool(denied.module, 'get_me', {}, denied.ctx);
  assert.match(auth.payload.error, /Reddit rejected the credentials \(HTTP 401\): Unauthorized\./);

  const { module, ctx, logs } = setup(reddit());
  await callTool(module, 'submit_post', { ...SELF_POST, title: 'Secret title' }, ctx);
  assert.ok(logs.length >= 1);
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /Secret|acme/);
    assert.match(line, /^reddit submit_post POST \d+ \d+ms$/);
  }
});
