import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, textBytes } from '../../../tests/helpers.mjs';

const TOKEN = '1b2c3d4e-5f60-4718-9293-a4b5c6d7e8f9';
const HOST = 'blog.example.com';
const BLOG_ID = '64f0c3a1b2c3d4e5f6a7b8c9';
const DRAFT_ID = '66b2c3d4e5f6071829304152';
const credentials = { token: TOKEN, publicationhost: HOST };

/** Answers each request from a list of fixtures (or functions), in order. */
function setup(answers, creds = credentials) {
  const { module } = loadModuleFor(import.meta.url);
  const queue = [...answers];
  const fetch = fakeFetch((request) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(request);
    return jsonResponse(200, fixture(import.meta.url, next));
  });
  const { ctx, logs } = makeContext({ credentials: creds, fetch });
  return { module, fetch, ctx, logs };
}

test('get_blog posts the publication query with the bare token and the normalized host', async () => {
  const { module, fetch, ctx } = setup(['publication.json'], { token: `Bearer ${TOKEN}`, publicationhost: 'https://Blog.Example.com/' });
  const { payload, isError } = await callTool(module, 'get_blog', {}, ctx);
  assert.equal(isError, false, payload.error);
  const [request] = fetch.calls;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://gql-beta.hashnode.com/');
  assert.equal(request.headers.authorization, TOKEN, 'Hashnode takes the token with no scheme');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.match(request.json.query, /publication\(host: \$host\) \{ id title url isTeam \}/);
  assert.deepEqual(request.json.variables, { host: HOST });
  assert.deepEqual(payload, { id: BLOG_ID, title: 'Acme Engineering', url: 'https://blog.example.com', is_team: true, host: HOST });
});

test('a wrong blog address and a blog without Pro are told apart, plainly', async () => {
  const missing = setup(['publication-null.json']);
  const none = await callTool(missing.module, 'get_blog', {}, missing.ctx);
  assert.equal(none.isError, true);
  assert.match(none.payload.error, /Hashnode has no blog at blog\.example\.com\. The blog address must be the bare host/);
  assert.match(none.payload.error, /list_my_blogs/);

  const free = setup(['pro-required.json']);
  const pro = await callTool(free.module, 'get_blog', {}, free.ctx);
  assert.equal(pro.isError, true);
  assert.equal(pro.payload.vendorCode, 'FORBIDDEN');
  assert.match(pro.payload.error, /works only for blogs on Hashnode Pro, and this blog is not on it \(FORBIDDEN\): Publication does not have an active Pro plan/);
  assert.match(pro.payload.error, /Billing → Upgrade to Pro/);
});

test('list_my_blogs lists the account\'s blogs, and a bad token says so', async () => {
  const { module, fetch, ctx } = setup(['me.json']);
  const { payload } = await callTool(module, 'list_my_blogs', {}, ctx);
  assert.equal(fetch.calls[0].json.variables, undefined);
  assert.deepEqual(payload, {
    account: { id: '5f1e2d3c4b5a69788796a5b4', username: 'alice' },
    blogs: [
      { id: BLOG_ID, title: 'Acme Engineering', url: 'https://blog.example.com' },
      { id: '650a1b2c3d4e5f6071829304', title: 'Alice writes', url: 'https://alice.hashnode.dev' },
    ],
  });

  const denied = setup(['unauthenticated.json']);
  const auth = await callTool(denied.module, 'list_my_blogs', {}, denied.ctx);
  assert.equal(auth.payload.vendorCode, 'UNAUTHENTICATED');
  assert.match(auth.payload.error, /Hashnode rejected the token \(UNAUTHENTICATED\): You must be authenticated\. Check that the Hashnode Personal Access Token is correct/);
});

test('list_posts returns stats per post and pages with the end cursor', async () => {
  const { module, fetch, ctx } = setup(['posts.json']);
  const first = await callTool(module, 'list_posts', { first: 2 }, ctx);
  assert.equal(first.isError, false, first.payload.error);
  assert.deepEqual(fetch.calls[0].json.variables, { host: HOST, first: 2 });
  assert.equal(first.payload.blog, 'Acme Engineering');
  assert.equal(first.payload.total, 42);
  assert.deepEqual(first.payload.posts[0], {
    id: '65a1b2c3d4e5f60718293051',
    title: 'Shipping a GraphQL API',
    slug: 'shipping-a-graphql-api',
    url: 'https://blog.example.com/shipping-a-graphql-api',
    published_at: '2026-11-18T09:00:00.000Z',
    updated_at: '2026-11-19T12:00:00.000Z',
    views: 1280,
    reactions: 34,
    comments: 5,
    replies: 2,
    read_time_minutes: 7,
    tags: ['graphql', 'api'],
    series: 'API notes',
  });
  assert.equal('views' in first.payload.posts[1], false, 'missing views are left out, never shown as 0');

  await callTool(module, 'list_posts', { first: 2, cursor: first.payload.nextCursor }, ctx);
  assert.deepEqual(fetch.calls[1].json.variables, { host: HOST, first: 2, after: 'NjVhMWIyYzNkNGU1ZjYwNzE4MjkzMDVfMjAyNi0xMS0wMVQxMDowMDowMC4wMDBa' });
});

test('list_drafts gives each draft with its editor link', async () => {
  const { module, fetch, ctx } = setup(['drafts.json']);
  const { payload } = await callTool(module, 'list_drafts', {}, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { host: HOST, first: 20 });
  assert.deepEqual(payload.drafts, [{
    id: DRAFT_ID,
    title: 'Launch notes',
    subtitle: 'What changed',
    updated_at: '2026-11-21T15:00:00.000Z',
    read_time_minutes: 3,
    cover_image: 'https://cdn.example.com/cover.png',
    tags: ['release'],
    editor_url: `https://hashnode.com/draft/${DRAFT_ID}`,
  }]);
  assert.equal(payload.nextCursor, undefined);
});

test('get_draft returns the draft with its Markdown', async () => {
  const { module, fetch, ctx } = setup(['draft.json']);
  const { payload } = await callTool(module, 'get_draft', { draft_id: DRAFT_ID }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { id: DRAFT_ID });
  assert.equal(payload.markdown, '## What changed\n\nThe onboarding flow is new.\n');
  assert.equal(payload.markdown_length, 45);
  assert.deepEqual(payload.tags, [{ slug: 'release', name: 'Release' }]);
  assert.deepEqual(payload.series, { id: '67c3d4e5f607182930415263', name: 'Changelog' });
  assert.deepEqual(payload.seo, { title: 'Launch notes', description: 'What changed in November.' });
  assert.equal(payload.editor_url, `https://hashnode.com/draft/${DRAFT_ID}`);
  assert.equal(payload.published, false);
});

test('a long draft body comes in windows under 32 KB', async () => {
  const markdown = Array.from({ length: 1200 }, (_, index) => `Line ${index} with "quotes" and ünïcödé text.`).join('\n');
  const body = { data: { draft: { id: DRAFT_ID, title: 'Long', content: { markdown } } } };
  const { module, ctx } = setup([() => jsonResponse(200, body)]);
  let joined = '';
  let cursor;
  let steps = 0;
  do {
    const step = await callTool(module, 'get_draft', { draft_id: DRAFT_ID, ...(cursor ? { cursor } : {}) }, ctx);
    assert.ok(textBytes(step.result) <= 32 * 1024);
    joined += step.payload.markdown;
    cursor = step.payload.nextCursor;
    steps += 1;
  } while (cursor && steps < 20);
  assert.ok(steps > 1);
  assert.equal(joined, markdown);
});

test('get_post reads by slug on the blog or by ID, one of the two', async () => {
  const { module, fetch, ctx } = setup(['post.json']);
  const bySlug = await callTool(module, 'get_post', { slug: 'shipping-a-graphql-api' }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { host: HOST, slug: 'shipping-a-graphql-api' });
  assert.equal(bySlug.payload.views, 1280);
  assert.equal(bySlug.payload.markdown, '## Why GraphQL\n\nOne endpoint.\n');
  assert.equal(bySlug.payload.seo, undefined);

  const byId = setup([() => jsonResponse(200, { data: { post: fixture(import.meta.url, 'post.json').data.publication.post } })]);
  await callTool(byId.module, 'get_post', { post_id: '65a1b2c3d4e5f60718293051' }, byId.ctx);
  assert.match(byId.fetch.calls[0].json.query, /post\(id: \$id\)/);

  const neither = await callTool(module, 'get_post', {}, ctx);
  assert.match(neither.payload.error, /Give slug or post_id/);
  const both = await callTool(module, 'get_post', { slug: 'a', post_id: '65a1b2c3d4e5f60718293051' }, ctx);
  assert.match(both.payload.error, /Give slug or post_id/);
  assert.equal(fetch.calls.length, 1);
});

test('list_series lists the blog\'s series', async () => {
  const { module, ctx } = setup(['series.json']);
  const { payload } = await callTool(module, 'list_series', {}, ctx);
  assert.deepEqual(payload, { series: [{ id: '67c3d4e5f607182930415263', name: 'API notes', slug: 'api-notes' }] });
});

const DRAFT = {
  title: 'Shipping a GraphQL API',
  subtitle: 'What we learned in the first month',
  content_markdown: '## First month\n\nIt went well.',
  tags: [{ slug: 'graphql', name: 'GraphQL' }, { slug: 'api' }],
  cover_image_url: 'https://cdn.example.com/cover.png',
  original_article_url: 'https://dev.example.com/graphql-api',
  series_id: '67c3d4e5f607182930415263',
  meta_title: 'Shipping a GraphQL API',
  meta_description: 'One or two sentences for search results.',
  table_of_contents: true,
};

test('create_draft finds the blog, then saves a draft with Hashnode\'s draft field names', async () => {
  const { module, fetch, ctx } = setup(['publication.json', 'create-draft.json']);
  const { payload, isError } = await callTool(module, 'create_draft', DRAFT, ctx);
  assert.equal(isError, false, payload.error);
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[1].json.query, /^mutation CreateDraft/);
  assert.deepEqual(fetch.calls[1].json.variables, {
    input: {
      publicationId: BLOG_ID,
      title: DRAFT.title,
      subtitle: DRAFT.subtitle,
      contentMarkdown: DRAFT.content_markdown,
      tags: [{ slug: 'graphql', name: 'GraphQL' }, { slug: 'api', name: 'api' }],
      coverImageOptions: { coverImageURL: 'https://cdn.example.com/cover.png' },
      originalArticleURL: 'https://dev.example.com/graphql-api',
      seriesId: '67c3d4e5f607182930415263',
      metaTags: { title: 'Shipping a GraphQL API', description: 'One or two sentences for search results.' },
      settings: { enableTableOfContent: true },
    },
  });
  assert.equal(payload.saved, 'draft, not published');
  assert.equal(payload.id, '66b2c3d4e5f6071829304153');
  assert.equal(payload.editor_url, 'https://hashnode.com/draft/66b2c3d4e5f6071829304153');
  assert.equal(payload.blog, 'Acme Engineering');
});

test('create_draft stops before writing when the blog is not found', async () => {
  const { module, fetch, ctx } = setup(['publication-null.json', 'create-draft.json']);
  const { payload } = await callTool(module, 'create_draft', DRAFT, ctx);
  assert.match(payload.error, /Hashnode has no blog at blog\.example\.com/);
  assert.equal(fetch.calls.length, 1);
});

test('update_draft sends draftId and only the given fields; it needs one', async () => {
  const { module, fetch, ctx } = setup(['update-draft.json']);
  await callTool(module, 'update_draft', { draft_id: DRAFT_ID, title: 'Shipping a GraphQL API, revised', tags: [{ slug: 'graphql' }] }, ctx);
  assert.deepEqual(fetch.calls[0].json.variables, { input: { draftId: DRAFT_ID, title: 'Shipping a GraphQL API, revised', tags: [{ slug: 'graphql', name: 'graphql' }] } });
  const nothing = await callTool(module, 'update_draft', { draft_id: DRAFT_ID }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
  assert.equal(fetch.calls.length, 1);
});

test('publish_draft and submit_draft_for_review send the draft ID', async () => {
  const published = setup(['publish-draft.json']);
  const post = await callTool(published.module, 'publish_draft', { draft_id: DRAFT_ID }, published.ctx);
  assert.deepEqual(published.fetch.calls[0].json.variables, { input: { draftId: DRAFT_ID } });
  assert.deepEqual(post.payload, {
    published: true,
    id: '65a1b2c3d4e5f60718293060',
    title: 'Shipping a GraphQL API',
    slug: 'shipping-a-graphql-api',
    url: 'https://blog.example.com/shipping-a-graphql-api',
    published_at: '2026-11-22T12:00:00.000Z',
  });

  const review = setup(['submit-draft.json']);
  const sent = await callTool(review.module, 'submit_draft_for_review', { draft_id: DRAFT_ID }, review.ctx);
  assert.match(review.fetch.calls[0].json.query, /submitDraftForReview/);
  assert.deepEqual(sent.payload, { submitted_for_review: true, id: DRAFT_ID, title: 'Launch notes' });
});

test('publish_post and update_post use a published post\'s field names', async () => {
  const { module, fetch, ctx } = setup(['publication.json', 'publish-post.json']);
  await callTool(module, 'publish_post', { ...DRAFT, meta_image_url: 'https://cdn.example.com/og.png', delist: false }, ctx);
  assert.deepEqual(fetch.calls[1].json.variables.input, {
    publicationId: BLOG_ID,
    title: DRAFT.title,
    subtitle: DRAFT.subtitle,
    contentMarkdown: DRAFT.content_markdown,
    tags: [{ slug: 'graphql', name: 'GraphQL' }, { slug: 'api', name: 'api' }],
    coverImage: 'https://cdn.example.com/cover.png',
    originalArticleURL: 'https://dev.example.com/graphql-api',
    seriesId: '67c3d4e5f607182930415263',
    metaTitle: 'Shipping a GraphQL API',
    metaDescription: 'One or two sentences for search results.',
    ogImage: 'https://cdn.example.com/og.png',
    enableToc: true,
    isDelisted: false,
  });

  const edit = setup(['update-post.json']);
  const updated = await callTool(edit.module, 'update_post', { post_id: '65a1b2c3d4e5f60718293051', title: 'Shipping a GraphQL API (2026)' }, edit.ctx);
  assert.deepEqual(edit.fetch.calls[0].json.variables, { input: { id: '65a1b2c3d4e5f60718293051', title: 'Shipping a GraphQL API (2026)' } });
  assert.equal(updated.payload.updated, true);
  assert.equal(updated.payload.updated_at, '2026-11-22T13:00:00.000Z');
});

test('a write error inside a 200 answer: bad input changed nothing, a server error is unknown', async () => {
  const bad = setup(['publication.json', 'bad-input.json']);
  const refused = await callTool(bad.module, 'create_draft', DRAFT, bad.ctx);
  assert.equal(refused.payload.outcome, undefined);
  assert.match(refused.payload.error, /Hashnode rejected the request \(BAD_USER_INPUT\): Tag slug is invalid\. Nothing was changed\./);

  const broken = setup(['internal-error.json']);
  const unknown = await callTool(broken.module, 'publish_draft', { draft_id: DRAFT_ID }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_posts');
  assert.match(unknown.payload.error, /INTERNAL_SERVER_ERROR/);
  assert.equal(broken.fetch.calls.length, 1);
});

test('every write without a clear answer is unknown and sent once', async () => {
  const fail = () => jsonResponse(502, { message: 'Bad gateway' });
  const cases = [
    ['create_draft', DRAFT, ['publication.json', fail], 'list_drafts'],
    ['update_draft', { draft_id: DRAFT_ID, title: 'x' }, [fail], 'get_draft'],
    ['publish_draft', { draft_id: DRAFT_ID }, [fail], 'list_posts'],
    ['publish_post', DRAFT, ['publication.json', fail], 'list_posts'],
    ['update_post', { post_id: '65a1b2c3d4e5f60718293051', title: 'x' }, [fail], 'get_post'],
    ['submit_draft_for_review', { draft_id: DRAFT_ID }, [fail], 'get_draft'],
    ['graphql_mutation', { query: 'mutation { likePost(input: {postId: "1"}) { post { id } } }' }, [fail], 'graphql_query'],
  ];
  for (const [tool, args, answers, check] of cases) {
    const { module, fetch, ctx } = setup(answers);
    const { payload } = await callTool(module, tool, args, ctx);
    assert.equal(payload.outcome, 'unknown', `${tool}: ${payload.error}`);
    assert.equal(payload.check, check);
    assert.equal(fetch.calls.filter((call) => /mutation/.test(call.json?.query ?? '')).length, 1, `${tool}: the mutation is sent once`);
  }
});

test('a request over 100 KB is refused before it is sent', async () => {
  const { module, fetch, ctx } = setup(['publication.json', 'create-draft.json']);
  const { payload } = await callTool(module, 'create_draft', { title: 'Big', content_markdown: 'ü'.repeat(60000) }, ctx);
  assert.match(payload.error, /Hashnode takes requests up to 100 KB, and this one is 118 KB: shorten it\. Nothing was changed\./);
  assert.equal(fetch.calls.length, 1, 'only the blog lookup went out');
});

test('graphql_query runs queries only, as a safe read, and returns data with any field errors', async () => {
  const { module, fetch, ctx } = setup([() => jsonResponse(200, { data: { tag: { id: 't1', name: 'GraphQL', postsCount: 10 } } })]);
  const query = '# a "mutation" in a comment\nquery Tag($slug: String!) { tag(slug: $slug) { id name postsCount } }';
  const { payload, isError } = await callTool(module, 'graphql_query', { query, variables: { slug: 'graphql' } }, ctx);
  assert.equal(isError, false, payload.error);
  assert.deepEqual(payload, { data: { tag: { id: 't1', name: 'GraphQL', postsCount: 10 } } });
  assert.deepEqual(fetch.calls[0].json, { query, variables: { slug: 'graphql' } });

  for (const document of ['mutation { publishDraft(input: {draftId: "x"}) { post { id } } }', 'subscription { x }', 'fragment F on Post { id }']) {
    const refused = await callTool(module, 'graphql_query', { query: document }, ctx);
    assert.equal(refused.isError, true, document);
  }
  const anonymous = await callTool(module, 'graphql_query', { query: '{ tag(slug: "mutation") { id } }' }, ctx);
  assert.equal(anonymous.isError, false, 'a string that says mutation is not a mutation');
  assert.equal(fetch.calls.length, 2);

  const invalid = setup([() => jsonResponse(400, fixture(import.meta.url, 'validation-400.json'))]);
  const bad = await callTool(invalid.module, 'graphql_query', { query: '{ post(id: "1") { stats } }' }, invalid.ctx);
  assert.equal(bad.payload.status, 400);
  assert.match(bad.payload.error, /Hashnode rejected the request \(HTTP 400\): Cannot query field "stats" on type "Post"/);
});

test('graphql_query reads strings as the server does, so a document cannot hide a mutation from it', async () => {
  const { module, fetch, ctx } = setup([() => jsonResponse(200, { data: { tag: { id: 't1' } } })]);
  // graphql-js reads \""" inside a block string as an escaped quote: the string goes on, and a second operation follows it.
  const hidden = 'query Q { tag(slug: """ \\""" """) { id } }\nmutation M { m: updatePost(input: {id: "0123456789abcdef01234567", title: "pwned"}) { post { id } } }';
  const refused = await callTool(module, 'graphql_query', { query: hidden }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /sends one operation per call/);
  // Neither an operation name nor a second query gets through.
  const named = await callTool(module, 'graphql_query', { query: 'query Q { me { id } }', operation_name: 'M' }, ctx);
  assert.match(named.payload.error, /Invalid arguments for graphql_query/);
  const two = await callTool(module, 'graphql_query', { query: 'query A { me { id } } query B { me { username } }' }, ctx);
  assert.match(two.payload.error, /sends one operation per call/);
  // Whatever the lexer cannot read the way the server does is refused, not guessed at.
  for (const document of ['{ tag(slug: "open', '{ tag(slug: """open) { id } }', 'query { a(x: "\\q") }', '{ me { id } } %', 'type Query { me: User }', '{ me { id }']) {
    const broken = await callTool(module, 'graphql_query', { query: document }, ctx);
    assert.equal(broken.isError, true, document);
    assert.match(broken.payload.error, /Nothing was sent/, document);
  }
  assert.equal(fetch.calls.length, 0, 'nothing reached Hashnode');

  // The same escape in a lone query is one string, and the query goes out as it is, without an operation name.
  const fine = 'query Q { tag(slug: """a \\""" b""") { id } } fragment F on Tag { id }';
  const ok = await callTool(module, 'graphql_query', { query: fine }, ctx);
  assert.equal(ok.isError, false, ok.payload.error);
  assert.deepEqual(fetch.calls[0].json, { query: fine });
});

test('graphql_mutation needs a mutation and never deletes posts or drafts', async () => {
  const { module, fetch, ctx } = setup([() => jsonResponse(200, { data: { rejectDraftSubmission: { draft: { id: 'd1' } } } })]);
  const query = 'mutation Reject($input: RejectDraftSubmissionInput!) { rejectDraftSubmission(input: $input) { draft { id } } }';
  const ok = await callTool(module, 'graphql_mutation', { query, variables: { input: { draftId: 'd1' } } }, ctx);
  assert.deepEqual(ok.payload, { data: { rejectDraftSubmission: { draft: { id: 'd1' } } } });
  const read = await callTool(module, 'graphql_mutation', { query: '{ me { id } }' }, ctx);
  assert.match(read.payload.error, /no mutation/);
  for (const field of ['removePost', 'deleteDraft']) {
    const refused = await callTool(module, 'graphql_mutation', { query: `mutation { ${field}(input: {id: "1"}) { __typename } }` }, ctx);
    assert.match(refused.payload.error, new RegExp(`${field} is not offered here`));
  }
  // A comment ends at its line, so these block-string marks hide nothing; an escaped quote keeps its string going; an
  // alias or a fragment still names the field.
  const tricks = [
    'mutation M { # """\nremovePost(input: {id: "0123456789abcdef01234567"}) { post { id } }\n# """\n}',
    'mutation M { publishDraft(input: {draftId: """ \\""" """}) { post { id } } removePost(input: {id: "x"}) { post { id } } }',
    'mutation M { gone: deleteDraft(id: "0123456789abcdef01234567") { __typename } }',
    'mutation M { ...Gone } fragment Gone on Mutation { removePost(input: {id: "x"}) { post { id } } }',
  ];
  for (const query of tricks) {
    const refused = await callTool(module, 'graphql_mutation', { query }, ctx);
    assert.match(refused.payload.error, /(removePost|deleteDraft) is not offered here/, query);
  }
  const twoOps = await callTool(module, 'graphql_mutation', { query: 'mutation A { likePost(input: {postId: "1"}) { post { id } } } mutation B { likePost(input: {postId: "2"}) { post { id } } }' }, ctx);
  assert.match(twoOps.payload.error, /sends one operation per call/);
  const named = await callTool(module, 'graphql_mutation', { query, operation_name: 'Reject' }, ctx);
  assert.match(named.payload.error, /Invalid arguments for graphql_mutation/);
  assert.equal(fetch.calls.length, 1);
});

test('without both credentials nothing is sent, and logs carry neither the token nor the post', async () => {
  const missing = setup(['publication.json'], { token: TOKEN });
  const refused = await callTool(missing.module, 'get_blog', {}, missing.ctx);
  assert.equal(refused.payload.error, 'Hashnode is not connected: the Hashnode blog address is missing.');
  assert.equal(missing.fetch.calls.length, 0);

  const { module, ctx, logs } = setup(['publication.json', 'create-draft.json']);
  await callTool(module, 'create_draft', { title: 'Secret launch', content_markdown: 'confidential body' }, ctx);
  assert.deepEqual(logs.map((line) => line.replace(/\d+ms$/, 'Nms')), ['hashnode create_draft POST 200 Nms', 'hashnode create_draft POST 200 Nms']);
  const joined = logs.join('\n');
  for (const secret of [TOKEN, 'Secret launch', 'confidential body']) assert.equal(joined.includes(secret), false);
});
