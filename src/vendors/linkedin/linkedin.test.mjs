import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textResponse } from '../../../tests/helpers.mjs';

const TOKEN = 'AQXexampleLinkedInToken123';
const ORG = '12345678';
const credentials = { access_token: TOKEN, organizationid: ORG, linkedinname: 'Alex Example' };
const userinfo = fixture(import.meta.url, 'userinfo.json');
const byAuthor = fixture(import.meta.url, 'posts-by-author.json');
const onePost = fixture(import.meta.url, 'post.json');
const initialize = fixture(import.meta.url, 'image-initialize.json');
const POST_URN = 'urn:li:share:7300000000000000009';

// Tiny files with the right first bytes.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

function setup(handler, { creds = credentials, accounts = {} } = {}) {
  const { module } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials: creds, accounts, fetch });
  return { module, fetch, ctx, logs };
}

/** A LinkedIn that answers each request by its method and path. */
function linkedin(overrides = {}) {
  return (request) => {
    const key = `${request.method} ${request.origin}${request.path}`;
    if (overrides[key]) return overrides[key](request);
    if (key === 'GET https://api.linkedin.com/v2/userinfo') return jsonResponse(200, userinfo);
    if (key === 'POST https://api.linkedin.com/rest/images') return jsonResponse(200, initialize);
    if (key === 'PUT https://www.linkedin.com/dms-uploads/sp/v2/C4E10AQFexample/uploaded-image/0') return new Response(null, { status: 201 });
    if (key === 'POST https://api.linkedin.com/rest/posts') return new Response(null, { status: 201, headers: { 'x-restli-id': POST_URN } });
    if (request.origin === 'https://images.example.com') {
      if (request.path.endsWith('.png')) return bytesResponse(200, PNG, { 'content-type': 'image/png' });
      if (request.path.endsWith('.jpg')) return bytesResponse(200, JPEG, { 'content-type': 'image/jpeg' });
      if (request.path.endsWith('.webp')) return bytesResponse(200, WEBP, { 'content-type': 'image/png' });
    }
    throw new Error(`unexpected request ${key}`);
  };
}

test('get_profile reads /v2/userinfo with the token and LinkedIn\'s version headers, and names the organization', async () => {
  const { module, fetch, ctx } = setup(linkedin());
  const { payload, isError } = await callTool(module, 'get_profile', {}, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1);
  const [request] = fetch.calls;
  assert.equal(request.url, 'https://api.linkedin.com/v2/userinfo');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(request.headers['linkedin-version'], /^20\d{4}$/);
  assert.equal(request.headers['x-restli-protocol-version'], '2.0.0');
  assert.deepEqual(payload, {
    id: '782bbtaQ',
    personUrn: 'urn:li:person:782bbtaQ',
    name: 'Alex Example',
    givenName: 'Alex',
    familyName: 'Example',
    picture: userinfo.picture,
    locale: 'en_US',
    email: 'alex@example.com',
    organization: { id: ORG, urn: `urn:li:organization:${ORG}`, url: `https://www.linkedin.com/company/${ORG}/` },
  });
});

test('create_post posts text as the organization, in little format so reserved characters stay text', async () => {
  const { module, fetch, ctx } = setup(linkedin());
  const text = 'New (beta) release: 50% off *today* for C# fans #launch #AI2026 — thanks @[Acme Corp](urn:li:organization:2414183) <3';
  const { payload, isError } = await callTool(module, 'create_post', { text }, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 1, 'a text post is one request');
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.linkedin.com/rest/posts');
  assert.deepEqual(request.json, {
    author: `urn:li:organization:${ORG}`,
    commentary: 'New \\(beta\\) release: 50% off \\*today\\* for C\\# fans #launch #AI2026 — thanks @[Acme Corp](urn:li:organization:2414183) \\<3',
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });
  assert.deepEqual(payload, {
    id: POST_URN,
    url: `https://www.linkedin.com/feed/update/${POST_URN}/`,
    author: `urn:li:organization:${ORG}`,
    authorType: 'organization',
    content: 'text',
  });
});

test('create_post with one image downloads it, uploads it through the Images API, then posts it', async () => {
  const { module, fetch, ctx } = setup(linkedin());
  const { payload, isError } = await callTool(module, 'create_post', {
    text: 'Launch day',
    images: [{ url: 'https://images.example.com/cover.png', alt_text: 'The product box' }],
    image_title: 'Launch',
  }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(fetch.calls.map((call) => `${call.method} ${call.origin}${call.path}`), [
    'GET https://images.example.com/cover.png',
    'POST https://api.linkedin.com/rest/images',
    'PUT https://www.linkedin.com/dms-uploads/sp/v2/C4E10AQFexample/uploaded-image/0',
    'POST https://api.linkedin.com/rest/posts',
  ]);
  const [download, init, upload, post] = fetch.calls;
  assert.equal(download.headers.authorization, undefined, 'no token goes with a media download');
  assert.equal(init.url, 'https://api.linkedin.com/rest/images?action=initializeUpload');
  assert.deepEqual(init.json, { initializeUploadRequest: { owner: `urn:li:organization:${ORG}` } });
  assert.equal(upload.url, initialize.value.uploadUrl);
  assert.equal(upload.headers['content-type'], 'image/png');
  assert.equal(upload.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual([...upload.body], [...PNG]);
  assert.deepEqual(post.json.content, { media: { id: 'urn:li:image:C4E10AQFexample', title: 'Launch', altText: 'The product box' } });
  assert.equal(payload.content, 'image');
  assert.equal(payload.images, 1);
});

test('create_post with several images makes a multi-image post, and an article carries its own card', async () => {
  const many = setup(linkedin());
  const multi = await callTool(many.module, 'create_post', {
    text: 'Event photos',
    images: [{ url: 'https://images.example.com/a.png', alt_text: 'Stage' }, { url: 'https://images.example.com/b.jpg' }],
  }, many.ctx);
  assert.equal(multi.isError, false, multi.payload.error);
  const post = many.fetch.calls.at(-1);
  assert.deepEqual(post.json.content, {
    multiImage: { images: [{ id: 'urn:li:image:C4E10AQFexample', altText: 'Stage' }, { id: 'urn:li:image:C4E10AQFexample' }] },
  });
  assert.equal(many.fetch.calls.filter((call) => call.method === 'PUT')[1].headers['content-type'], 'image/jpeg');
  assert.equal(multi.payload.content, 'images');

  const article = setup(linkedin());
  const shared = await callTool(article.module, 'create_post', {
    text: 'Read the notes',
    article: { url: 'https://blog.example.com/notes', title: 'Release notes', description: 'What changed', thumbnail_url: 'https://images.example.com/thumb.png' },
  }, article.ctx);
  assert.equal(shared.isError, false, shared.payload.error);
  assert.deepEqual(article.fetch.calls.at(-1).json.content, {
    article: { source: 'https://blog.example.com/notes', title: 'Release notes', description: 'What changed', thumbnail: 'urn:li:image:C4E10AQFexample' },
  });
  assert.equal(shared.payload.content, 'article');
});

test('create_post as the member names the member\'s person URN, and without an organization ID that is the default', async () => {
  const member = setup(linkedin());
  const asMember = await callTool(member.module, 'create_post', { text: 'Hello', author: 'member', visibility: 'CONNECTIONS' }, member.ctx);
  assert.equal(asMember.isError, false, asMember.payload.error);
  assert.deepEqual(member.fetch.calls.map((call) => `${call.method} ${call.path}`), ['GET /v2/userinfo', 'POST /rest/posts']);
  assert.equal(member.fetch.calls[1].json.author, 'urn:li:person:782bbtaQ');
  assert.equal(member.fetch.calls[1].json.visibility, 'CONNECTIONS');
  assert.equal(asMember.payload.authorType, 'member');

  const noOrg = setup(linkedin(), { creds: { access_token: TOKEN } });
  const fallback = await callTool(noOrg.module, 'create_post', { text: 'Hello' }, noOrg.ctx);
  assert.equal(fallback.payload.author, 'urn:li:person:782bbtaQ');
});

test('the organization ID may be pasted as a URN or an admin URL; a missing or odd one is refused before anything is sent', async () => {
  const pasted = setup(linkedin(), { creds: { access_token: TOKEN, organizationid: 'https://www.linkedin.com/company/12345678/admin/dashboard/' } });
  await callTool(pasted.module, 'create_post', { text: 'Hi' }, pasted.ctx);
  assert.equal(pasted.fetch.calls[0].json.author, 'urn:li:organization:12345678');

  const urn = setup(linkedin(), { creds: { access_token: TOKEN, organizationid: 'urn:li:organization:12345678' } });
  await callTool(urn.module, 'create_post', { text: 'Hi' }, urn.ctx);
  assert.equal(urn.fetch.calls[0].json.author, 'urn:li:organization:12345678');

  const missing = setup(linkedin(), { creds: { access_token: TOKEN } });
  const refused = await callTool(missing.module, 'create_post', { text: 'Hi', author: 'organization' }, missing.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /needs the LinkedIn organization ID/);

  const odd = setup(linkedin(), { creds: { access_token: TOKEN, organizationid: 'acme-inc' } });
  const wrong = await callTool(odd.module, 'create_post', { text: 'Hi' }, odd.ctx);
  assert.match(wrong.payload.error, /must be the number in the Page's admin URL/);
  assert.equal(missing.fetch.calls.length + odd.fetch.calls.length, 0);
});

test('bad combinations, a WebP image and an unknown upload host are refused before the post', async () => {
  const both = setup(linkedin());
  const mixed = await callTool(both.module, 'create_post', { text: 'x', images: [{ url: 'https://images.example.com/a.png' }], article: { url: 'https://blog.example.com/a', title: 'A' } }, both.ctx);
  assert.match(mixed.payload.error, /Give images or article, not both/);
  const connections = await callTool(both.module, 'create_post', { text: 'x', visibility: 'CONNECTIONS' }, both.ctx);
  assert.match(connections.payload.error, /cannot be limited to connections/);
  const title = await callTool(both.module, 'create_post', { text: 'x', image_title: 'T' }, both.ctx);
  assert.match(title.payload.error, /image_title is for a post with exactly one image/);
  assert.equal(both.fetch.calls.length, 0);

  const webp = setup(linkedin());
  const refused = await callTool(webp.module, 'create_post', { text: 'x', images: [{ url: 'https://images.example.com/photo.webp' }] }, webp.ctx);
  assert.match(refused.payload.error, /is a WebP image, which LinkedIn does not take/);
  assert.deepEqual(webp.fetch.calls.map((call) => call.origin), ['https://images.example.com'], 'only the download happened');

  const elsewhere = setup(linkedin({
    'POST https://api.linkedin.com/rest/images': () => jsonResponse(200, { value: { ...initialize.value, uploadUrl: 'https://uploads.example.net/put' } }),
  }));
  const host = await callTool(elsewhere.module, 'create_post', { text: 'x', images: [{ url: 'https://images.example.com/a.png' }] }, elsewhere.ctx);
  assert.match(host.payload.error, /uploaded to uploads\.example\.net, an address this connector does not send files to\. Nothing was posted\./);
  assert.equal(elsewhere.fetch.calls.some((call) => call.method === 'PUT' || call.path === '/rest/posts'), false);
});

test('a post LinkedIn created without sending its URN back says so instead of inventing a link', async () => {
  const { module, ctx } = setup(linkedin({ 'POST https://api.linkedin.com/rest/posts': () => new Response(null, { status: 201 }) }));
  const { payload, isError } = await callTool(module, 'create_post', { text: 'Hello' }, ctx);
  assert.equal(isError, false);
  assert.equal(payload.id, undefined);
  assert.equal(payload.url, undefined);
  assert.match(payload.note, /no post URN, so there is no link to it/);
});

test('list_posts finds the organization\'s posts, turns little text back into plain text, and pages on', async () => {
  const { module, fetch, ctx } = setup(linkedin({ 'GET https://api.linkedin.com/rest/posts': () => jsonResponse(200, byAuthor) }));
  const first = await callTool(module, 'list_posts', { count: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  const [request] = fetch.calls;
  assert.equal(request.url, 'https://api.linkedin.com/rest/posts?q=author&author=urn%3Ali%3Aorganization%3A12345678&count=2&start=0&sortBy=LAST_MODIFIED');
  assert.equal(request.headers['x-restli-method'], 'FINDER');
  assert.equal(first.payload.author, `urn:li:organization:${ORG}`);
  assert.deepEqual(first.payload.posts[0], {
    id: 'urn:li:share:7300000000000000001',
    url: 'https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/',
    author: `urn:li:organization:${ORG}`,
    text: 'Our new release is out (finally) #launch',
    content: 'image',
    visibility: 'PUBLIC',
    state: 'PUBLISHED',
    createdAt: new Date(1795299990000).toISOString(),
    publishedAt: new Date(1795299990000).toISOString(),
    lastModifiedAt: new Date(1795300000000).toISOString(),
  });
  assert.deepEqual(first.payload.posts[1].article, { url: 'https://blog.example.com/release-notes', title: 'Release notes', description: 'Everything that changed this month.' });
  assert.equal(first.payload.posts[1].edited, true);

  await callTool(module, 'list_posts', { cursor: first.payload.nextCursor }, ctx);
  assert.equal(fetch.calls.length, 2, 'the cursor keeps the author: no second profile read');
  assert.equal(fetch.calls[1].query.start, '2');
  assert.equal(fetch.calls[1].query.count, '2');
});

test('get_post reads one post as its author, and delete_post deletes it', async () => {
  const read = setup(linkedin({ 'GET https://api.linkedin.com/rest/posts/urn%3Ali%3AugcPost%3A7300000000000000003': () => jsonResponse(200, onePost) }));
  const got = await callTool(read.module, 'get_post', { post_id: 'urn:li:ugcPost:7300000000000000003' }, read.ctx);
  assert.equal(got.isError, false, got.payload.error);
  assert.equal(read.fetch.calls[0].url, 'https://api.linkedin.com/rest/posts/urn%3Ali%3AugcPost%3A7300000000000000003?viewContext=AUTHOR');
  assert.equal(got.payload.content, 'images');
  assert.equal(got.payload.images, 2);

  const gone = setup(linkedin({ 'DELETE https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7300000000000000009': () => new Response(null, { status: 204 }) }));
  const deleted = await callTool(gone.module, 'delete_post', { post_id: POST_URN }, gone.ctx);
  assert.deepEqual(deleted.payload, { deleted: true, id: POST_URN });
  assert.equal(gone.fetch.calls[0].headers['x-restli-method'], 'DELETE');

  const bad = await callTool(gone.module, 'get_post', { post_id: 'https://www.linkedin.com/feed/update/1' }, gone.ctx);
  assert.match(bad.payload.error, /`post_id` does not have the expected format/);
});

test('LinkedIn\'s refusals keep its words: a missing permission, a revoked token, a long text, a rate limit', async () => {
  const forbidden = setup(linkedin({ 'POST https://api.linkedin.com/rest/posts': () => jsonResponse(403, fixture(import.meta.url, 'error-403.json')) }));
  const denied = await callTool(forbidden.module, 'create_post', { text: 'Hi' }, forbidden.ctx);
  assert.equal(denied.payload.status, 403);
  assert.equal(denied.payload.vendorCode, 'ACCESS_DENIED');
  assert.match(denied.payload.error, /needs the w_organization_social permission.*\(HTTP 403\)\. LinkedIn said: "Not enough permissions to access: partnerApiPostsExternal\.CREATE\.20261101"\. Nothing was changed\./);

  const revoked = setup(() => jsonResponse(401, fixture(import.meta.url, 'error-401.json')));
  const auth = await callTool(revoked.module, 'get_profile', {}, revoked.ctx);
  assert.match(auth.payload.error, /LinkedIn rejected the credentials \(HTTP 401\): The token used in the request has been revoked by the user\. Check that the LinkedIn access token is correct and still active\./);

  const long = setup(linkedin({ 'POST https://api.linkedin.com/rest/posts': () => jsonResponse(422, fixture(import.meta.url, 'error-422.json')) }));
  const tooLong = await callTool(long.module, 'create_post', { text: 'Hi' }, long.ctx);
  assert.match(tooLong.payload.error, /LinkedIn did not accept the post \(HTTP 422\)\. LinkedIn said: "ERROR :: \/commentary :: is too long/);

  const limited = setup(() => textResponse(429, 'Too Many Requests', { 'retry-after': '30' }));
  const rate = await callTool(limited.module, 'list_posts', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 30);
  assert.match(rate.payload.error, /LinkedIn rate limit reached \(HTTP 429\)\. Retry after 30 seconds\./);
});

test('a post or delete without a clear answer is reported as unknown, sent once, with the read tool to check', async () => {
  const outcomes = [
    () => {
      throw new TypeError('fetch failed');
    },
    () => {
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    },
    () => jsonResponse(504, { message: 'Gateway timeout' }),
  ];
  for (const respond of outcomes) {
    for (const [tool, args, check] of [['create_post', { text: 'Hi' }, 'list_posts'], ['delete_post', { post_id: POST_URN }, 'get_post']]) {
      const { module, fetch, ctx } = setup(respond);
      const { payload, isError } = await callTool(module, tool, args, ctx);
      assert.equal(isError, true);
      assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
      assert.equal(payload.check, check);
      assert.equal(fetch.calls.length, 1, `${tool} is sent once`);
    }
  }
});

test('a failed image upload posts nothing and says so', async () => {
  const { module, fetch, ctx } = setup(linkedin({ 'PUT https://www.linkedin.com/dms-uploads/sp/v2/C4E10AQFexample/uploaded-image/0': () => jsonResponse(500, { message: 'upload failed' }) }));
  const { payload, isError } = await callTool(module, 'create_post', { text: 'x', images: [{ url: 'https://images.example.com/a.png' }] }, ctx);
  assert.equal(isError, true);
  assert.equal(payload.outcome, undefined, 'the post itself was never sent');
  assert.match(payload.error, /server error \(HTTP 500\).*Nothing was changed\./);
  assert.equal(fetch.calls.some((call) => call.path === '/rest/posts'), false);
});

test('api_get and api_request reach /rest/ and /v2/ only, with Rest.li methods for PATCH and DELETE', async () => {
  const { module, fetch, ctx } = setup(() => jsonResponse(200, { elements: [] }));
  const read = await callTool(module, 'api_get', { path: '/rest/organizationAcls', query: { q: 'roleAssignee', state: 'APPROVED' } }, ctx);
  assert.equal(read.isError, false, read.payload.error);
  assert.equal(fetch.calls[0].url, 'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED');
  assert.equal(fetch.calls[0].headers['linkedin-version'].length, 6);

  await callTool(module, 'api_request', { method: 'PATCH', path: `/rest/posts/${encodeURIComponent(POST_URN)}`, json: { patch: { $set: { commentary: 'Edited' } } } }, ctx);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.equal(fetch.calls[1].headers['x-restli-method'], 'PARTIAL_UPDATE');
  assert.deepEqual(fetch.calls[1].json, { patch: { $set: { commentary: 'Edited' } } });

  await callTool(module, 'api_request', { method: 'DELETE', path: '/rest/socialActions/urn%3Ali%3Ashare%3A1/comments/2' }, ctx);
  assert.equal(fetch.calls[2].headers['x-restli-method'], 'DELETE');

  const outside = await callTool(module, 'api_get', { path: '/oauth/v2/accessToken' }, ctx);
  assert.match(outside.payload.error, /LinkedIn API paths start with \/rest\/ or \/v2\/\. Nothing was sent\./);
  assert.equal(fetch.calls.length, 3);
});

test('log lines carry no token, text or URL', async () => {
  const { module, ctx, logs } = setup(linkedin());
  await callTool(module, 'create_post', { text: 'Secret launch plan', images: [{ url: 'https://images.example.com/a.png' }] }, ctx);
  assert.ok(logs.length >= 4);
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /Secret|images\.example|dms-uploads/);
    assert.match(line, /^linkedin create_post (media )?(GET|POST|PUT) \d+ \d+ms$/);
  }
});
