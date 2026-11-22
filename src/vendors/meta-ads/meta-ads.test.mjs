import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesResponse, callTool, controlClock, fakeFetch, fixture, jsonResponse, loadModuleFor, makeContext, refusal } from '../../../tests/helpers.mjs';

const USER_TOKEN = 'EAAUserTokenFromSignIn123';
const PROOF = 'b'.repeat(64);
const SYSTEM_TOKEN = 'EAASystemUserToken456';
const ACCOUNT = '1234567890';
const CAMPAIGN = '120200000000000001';

const f = (name) => fixture(import.meta.url, name);

function router(routes) {
  return (request) => {
    const respond = routes[`${request.method} ${request.origin}${request.path}`] ?? routes[`${request.method} ${request.path}`];
    if (!respond) throw new Error(`unexpected ${request.method} ${request.url}`);
    return typeof respond === 'function' ? respond(request) : jsonResponse(200, respond);
  };
}

function setup(handler, { credentials = { systemusertoken: SYSTEM_TOKEN }, accounts = { ad_accounts: [ACCOUNT], pages: ['1001'] } } = {}) {
  const { module, context } = loadModuleFor(import.meta.url);
  const fetch = fakeFetch(handler);
  const { ctx, logs } = makeContext({ credentials, accounts, fetch });
  return { module, context, fetch, ctx, logs };
}

function fastWaits(context) {
  const advance = controlClock(context);
  context.setTimeout = (fn, ms) => {
    advance(ms);
    return setTimeout(fn, 0);
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

test('list_ad_accounts signs in with the token and its proof, keeps the active accounts it can manage, and the picker reads id and name', async () => {
  const { module, fetch, ctx } = setup(router({ 'GET /v26.0/me/adaccounts': f('adaccounts.json') }), {
    credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF },
    accounts: null,
  });
  const { payload } = await callTool(module, 'list_ad_accounts', {}, ctx);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(fetch.calls[0].query.appsecret_proof, PROOF);
  assert.deepEqual(payload.ad_accounts, [{
    id: ACCOUNT,
    name: 'Example Bakery Ads',
    status: 'ACTIVE',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    tasks: ['DRAFT', 'ANALYZE', 'ADVERTISE', 'MANAGE'],
    can_manage: true,
  }]);
  const [accounts, pages] = module.accountPickers;
  assert.deepEqual(JSON.parse(JSON.stringify(accounts)), {
    key: 'ad_accounts', label: 'Meta ad accounts', description: 'The ad accounts the agent may report on and manage.', multiple: true, tool: 'list_ad_accounts', idField: 'id', nameField: 'name', legacyField: 'adaccountid',
  });
  assert.equal(pages.key, 'pages');
  assert.equal(pages.legacyField, 'pagemappings');

  const all = await callTool(module, 'list_ad_accounts', { all: true }, ctx);
  assert.deepEqual(all.payload.ad_accounts.map((item) => [item.id, item.status, item.can_manage]), [[ACCOUNT, 'ACTIVE', true], ['2345678901', 'ACTIVE', false], ['3456789012', 'DISABLED', true]]);

  const locked = setup(router({ 'GET /v26.0/me/adaccounts': f('adaccounts.json') }), { accounts: { ad_accounts: ['2345678901'] } });
  const chosen = await callTool(locked.module, 'list_ad_accounts', { all: true }, locked.ctx);
  assert.deepEqual(chosen.payload.ad_accounts.map((item) => item.id), ['2345678901']);
  assert.equal(locked.fetch.calls[0].query.appsecret_proof, undefined, 'no proof with a system user token');
  assert.equal(locked.fetch.calls[0].headers.authorization, `Bearer ${SYSTEM_TOKEN}`);
});

test('get_ad_account names the status and whether the connection can manage it', async () => {
  const { module, fetch, ctx } = setup(router({ [`GET /v26.0/act_${ACCOUNT}`]: f('account.json') }));
  const { payload } = await callTool(module, 'get_ad_account', { ad_account_id: `act_${ACCOUNT}` }, ctx);
  assert.match(fetch.calls[0].query.fields, /amount_spent,balance,spend_cap/);
  assert.equal(payload.status, 'ACTIVE');
  assert.equal(payload.can_manage, true);
  assert.equal(payload.amount_spent, '1567800');
  assert.equal('disable_reason' in payload, false, 'a zero reason is left out');
});

test('get_insights builds the query: level, default fields, preset or range, breakdowns and filters, and pages with the cursor', async () => {
  const { module, fetch, ctx } = setup(router({ [`GET /v26.0/act_${ACCOUNT}/insights`]: f('insights.json') }));
  const first = await callTool(module, 'get_insights', { level: 'campaign', breakdowns: ['publisher_platform'], campaign_ids: [CAMPAIGN], limit: 1 }, ctx);
  const query = fetch.calls[0].query;
  assert.equal(query.level, 'campaign');
  assert.equal(query.fields, 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type,purchase_roas');
  assert.equal(query.date_preset, 'last_7d');
  assert.equal(query.breakdowns, 'publisher_platform');
  assert.deepEqual(JSON.parse(query.filtering), [{ field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }]);
  assert.equal(first.payload.rows[0].spend, '156.78');
  assert.match(first.payload.note, /not minor units/);

  await callTool(module, 'get_insights', { level: 'ad', since: '2026-11-01', until: '2026-11-15', time_increment: '1', cursor: first.payload.nextCursor }, ctx);
  const second = fetch.calls[1].query;
  assert.equal(second.after, 'MQZDZD');
  assert.equal(second.date_preset, undefined);
  assert.equal(second.time_range, '{"since":"2026-11-01","until":"2026-11-15"}');
  assert.equal(second.time_increment, '1');
  assert.match(second.fields, /quality_ranking,engagement_rate_ranking,conversion_rate_ranking$/);

  const both = await callTool(module, 'get_insights', { date_preset: 'last_30d', since: '2026-11-01', until: '2026-11-15' }, ctx);
  assert.match(both.payload.error, /Give date_preset or since and until, not both/);
  const outside = await callTool(module, 'get_insights', { ad_account_id: '999' }, ctx);
  assert.match(outside.payload.error, /The ad account 999 is not among the ad accounts chosen for this connection/);
  assert.equal(fetch.calls.length, 2);
});

test('create_campaign is always paused, declares no special category by default, and sets budget sharing only without a campaign budget', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v26.0/act_${ACCOUNT}/campaigns`]: { id: CAMPAIGN } }));
  const { payload } = await callTool(module, 'create_campaign', { name: 'Bread_Traffic_US_2026-12', objective: 'OUTCOME_TRAFFIC' }, ctx);
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(fetch.calls[0].json, {
    name: 'Bread_Traffic_US_2026-12',
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  });
  assert.equal(payload.campaign_id, CAMPAIGN);
  assert.equal(payload.status, 'PAUSED');

  await callTool(module, 'create_campaign', { name: 'CBO', objective: 'OUTCOME_SALES', daily_budget: 5000, bid_strategy: 'COST_CAP' }, ctx);
  assert.deepEqual(fetch.calls[1].json, { name: 'CBO', objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [], bid_strategy: 'COST_CAP', daily_budget: 5000 });
});

test('create_ad_set is paused, carries its targeting, and refuses the removed explore placement before sending', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v26.0/act_${ACCOUNT}/adsets`]: { id: '120210000000000001' } }));
  const targeting = { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 54, publisher_platforms: ['facebook', 'instagram'], instagram_positions: ['stream', 'story', 'reels'] };
  const { payload } = await callTool(module, 'create_ad_set', {
    campaign_id: CAMPAIGN, name: 'US 25-54', optimization_goal: 'LINK_CLICKS', targeting, daily_budget: 2000, bid_amount: 200,
  }, ctx);
  assert.deepEqual(fetch.calls[0].json, {
    campaign_id: CAMPAIGN, name: 'US 25-54', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', targeting, daily_budget: 2000, bid_amount: 200, status: 'PAUSED',
  });
  assert.deepEqual(payload, { adset_id: '120210000000000001', ad_account_id: ACCOUNT, campaign_id: CAMPAIGN, name: 'US 25-54', status: 'PAUSED' });

  const explore = await callTool(module, 'create_ad_set', { campaign_id: CAMPAIGN, name: 'x', optimization_goal: 'REACH', targeting: { instagram_positions: ['explore'] } }, ctx);
  assert.match(explore.payload.error, /removed the Instagram explore placement/);
  assert.equal(fetch.calls.length, 1);
});

test('upload_image downloads the image, checks its bytes, and uploads it as base64; anything else is refused', async () => {
  const { module, fetch, ctx } = setup(router({
    'GET https://cdn.example.com/ad.jpg': () => bytesResponse(200, JPEG, { 'content-type': 'image/jpeg' }),
    'GET https://cdn.example.com/page.html': () => bytesResponse(200, new TextEncoder().encode('<html></html>'), { 'content-type': 'text/html' }),
    [`POST /v26.0/act_${ACCOUNT}/adimages`]: f('adimages.json'),
  }));
  const { payload } = await callTool(module, 'upload_image', { image_url: 'https://cdn.example.com/ad.jpg', name: 'Holiday square' }, ctx);
  assert.equal(fetch.calls[0].headers.authorization, undefined, 'no credentials go with the download');
  assert.deepEqual(fetch.calls[1].json, { bytes: Buffer.from(JPEG).toString('base64'), name: 'Holiday square' });
  assert.deepEqual(payload, { ad_account_id: ACCOUNT, image_hash: '0123456789abcdef0123456789abcdef', url: 'https://scontent.example.com/ad-image.jpg', width: 1080, height: 1080, bytes: 12 });

  const html = await callTool(module, 'upload_image', { image_url: 'https://cdn.example.com/page.html' }, ctx);
  assert.match(html.payload.error, /did not return a JPEG, PNG or GIF image/);
  const blocked = setup(() => {
    throw refusal('a private address');
  });
  const refused = await callTool(blocked.module, 'upload_image', { image_url: 'https://files.example.com/a.jpg' }, blocked.ctx);
  assert.match(refused.payload.error, /The image URL was refused \(a private address\)/);
  assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 1);
});

test('upload_video lets Meta fetch the file and waits while it is processed', async () => {
  let reads = 0;
  const { module, context, fetch, ctx } = setup(router({
    [`POST /v26.0/act_${ACCOUNT}/advideos`]: { id: '130000000000000001' },
    'GET /v26.0/130000000000000001': () => jsonResponse(200, ++reads < 3 ? f('video-processing.json') : f('video-ready.json')),
  }));
  fastWaits(context);
  const { payload } = await callTool(module, 'upload_video', { video_url: 'https://cdn.example.com/ad.mp4', title: 'Holiday' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { file_url: 'https://cdn.example.com/ad.mp4', title: 'Holiday', name: 'Holiday' });
  assert.deepEqual(payload, { ad_account_id: ACCOUNT, video_id: '130000000000000001', status: 'ready' });
  assert.equal(reads, 3);
});

test('create_creative uses a chosen Page, and an older setup\'s Page mappings when no Pages are chosen', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v26.0/act_${ACCOUNT}/adcreatives`]: { id: '120230000000000001' } }));
  const image = await callTool(module, 'create_creative', {
    name: 'Image v1', format: 'image', message: 'Fresh bread daily', link: 'https://bakery.example.com', headline: 'Order now', image_hash: '0123456789abcdef0123456789abcdef', call_to_action_type: 'ORDER_NOW',
  }, ctx);
  assert.deepEqual(fetch.calls[0].json, {
    name: 'Image v1',
    object_story_spec: {
      page_id: '1001',
      link_data: { link: 'https://bakery.example.com', message: 'Fresh bread daily', name: 'Order now', image_hash: '0123456789abcdef0123456789abcdef', call_to_action: { type: 'ORDER_NOW' } },
    },
  });
  assert.equal(image.payload.creative_id, '120230000000000001');

  const video = await callTool(module, 'create_creative', { name: 'Video v1', format: 'video', video_id: '130000000000000001', link: 'https://bakery.example.com', thumbnail_url: 'https://cdn.example.com/thumb.jpg' }, ctx);
  assert.deepEqual(fetch.calls[1].json.object_story_spec.video_data, {
    video_id: '130000000000000001', image_url: 'https://cdn.example.com/thumb.jpg', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://bakery.example.com' } },
  });

  const other = await callTool(module, 'create_creative', { name: 'x', format: 'image', page_id: '1002', link: 'https://a.example', image_hash: '0123456789abcdef0123456789abcdef' }, ctx);
  assert.match(other.payload.error, /The Page 1002 is not among the Pages chosen for this connection\. Use one of: 1001\./);
  const noHash = await callTool(module, 'create_creative', { name: 'x', format: 'image', link: 'https://a.example' }, ctx);
  assert.match(noHash.payload.error, /needs image_hash/);
  assert.equal(fetch.calls.length, 2);

  const legacy = setup(router({ [`POST /v26.0/act_${ACCOUNT}/adcreatives`]: { id: '120230000000000002' } }), {
    credentials: { systemusertoken: SYSTEM_TOKEN, pagemappings: JSON.stringify([{ adaccountid: ACCOUNT, adaccountname: 'Ads', pageid: '1003', pagename: 'Example Studio' }, { adaccountid: '999', pageid: '1004', pagename: 'Elsewhere' }]) },
    accounts: { ad_accounts: [ACCOUNT] },
  });
  const carousel = await callTool(legacy.module, 'create_creative', {
    name: 'Carousel v1', format: 'carousel', link: 'https://bakery.example.com',
    cards: [{ link: 'https://bakery.example.com/a', headline: 'A', image_hash: '0123456789abcdef0123456789abcdef' }, { link: 'https://bakery.example.com/b', headline: 'B', image_hash: 'fedcba9876543210fedcba9876543210' }],
  }, legacy.ctx);
  assert.equal(legacy.fetch.calls[0].json.object_story_spec.page_id, '1003');
  assert.equal(legacy.fetch.calls[0].json.object_story_spec.link_data.child_attachments.length, 2);
  assert.equal(carousel.payload.page_id, '1003');
  const elsewhere = await callTool(legacy.module, 'create_creative', { name: 'x', format: 'image', page_id: '1004', link: 'https://a.example', image_hash: '0123456789abcdef0123456789abcdef' }, legacy.ctx);
  assert.match(elsewhere.payload.error, /The Page 1004 is not among the Pages chosen/);
});

test('create_ad is paused and points at its creative', async () => {
  const { module, fetch, ctx } = setup(router({ [`POST /v26.0/act_${ACCOUNT}/ads`]: { id: '120240000000000001' } }));
  const { payload } = await callTool(module, 'create_ad', { adset_id: '120210000000000001', creative_id: '120230000000000001', name: 'Ad v1' }, ctx);
  assert.deepEqual(fetch.calls[0].json, { name: 'Ad v1', adset_id: '120210000000000001', creative: { creative_id: '120230000000000001' }, status: 'PAUSED' });
  assert.equal(payload.status, 'PAUSED');
});

test('update_status, update_budget and delete_object check the object\'s ad account first, and send nothing for one outside it', async () => {
  const { module, fetch, ctx } = setup(router({
    [`GET /v26.0/${CAMPAIGN}`]: f('campaign-object.json'),
    [`POST /v26.0/${CAMPAIGN}`]: { success: true },
    [`DELETE /v26.0/${CAMPAIGN}`]: { success: true },
    'GET /v26.0/120200000000000777': { id: '120200000000000777', name: 'Not ours', status: 'ACTIVE', account_id: '999' },
  }));
  const paused = await callTool(module, 'update_status', { object_id: CAMPAIGN, status: 'PAUSED' }, ctx);
  assert.equal(fetch.calls[0].query.fields, 'id,name,status,account_id');
  assert.deepEqual(fetch.calls[1].json, { status: 'PAUSED' });
  assert.deepEqual(paused.payload, { id: CAMPAIGN, name: 'Bread_Traffic_US_2026-11', previous_status: 'ACTIVE', status: 'PAUSED' });

  const budget = await callTool(module, 'update_budget', { object_id: CAMPAIGN, daily_budget: 3000 }, ctx);
  assert.deepEqual(fetch.calls[3].json, { daily_budget: 3000 });
  assert.deepEqual(budget.payload, { id: CAMPAIGN, name: 'Bread_Traffic_US_2026-11', previous: { daily_budget: '5000' }, changed: { daily_budget: 3000 } });

  const removed = await callTool(module, 'delete_object', { object_id: CAMPAIGN }, ctx);
  assert.equal(fetch.calls[5].method, 'DELETE');
  assert.deepEqual(removed.payload, { id: CAMPAIGN, name: 'Bread_Traffic_US_2026-11', deleted: true });

  const before = fetch.calls.length;
  const outside = await callTool(module, 'update_status', { object_id: '120200000000000777', status: 'ACTIVE' }, ctx);
  assert.match(outside.payload.error, /The ad account 999 is not among the ad accounts chosen for this connection/);
  assert.deepEqual(fetch.calls.slice(before).map((call) => call.method), ['GET']);
  const nothing = await callTool(module, 'update_budget', { object_id: CAMPAIGN }, ctx);
  assert.match(nothing.payload.error, /Nothing to change/);
});

test('list_objects, get_object, list_audiences, list_ad_media, search_targeting, estimate_audience and list_pages read what an agent needs', async () => {
  const { module, fetch, ctx } = setup(router({
    [`GET /v26.0/act_${ACCOUNT}/campaigns`]: f('campaigns.json'),
    [`GET /v26.0/act_${ACCOUNT}/ads`]: { data: [] },
    [`GET /v26.0/${CAMPAIGN}`]: f('campaign-object.json'),
    [`GET /v26.0/act_${ACCOUNT}/customaudiences`]: f('audiences.json'),
    [`GET /v26.0/act_${ACCOUNT}/advideos`]: { data: [{ id: '130000000000000001', title: 'Holiday', status: { video_status: 'ready' }, length: 14.2 }] },
    'GET /v26.0/search': f('search.json'),
    [`GET /v26.0/act_${ACCOUNT}/delivery_estimate`]: f('delivery-estimate.json'),
    'GET /v26.0/me/accounts': f('me-pages.json'),
    [`GET /v26.0/act_${ACCOUNT}/promote_pages`]: f('promote-pages.json'),
  }));
  const campaigns = await callTool(module, 'list_objects', { type: 'campaign', effective_status: ['ACTIVE'] }, ctx);
  assert.equal(fetch.calls[0].query.effective_status, '["ACTIVE"]');
  assert.equal(campaigns.payload.items[0].daily_budget, '5000');
  await callTool(module, 'list_objects', { type: 'ad', adset_id: '120210000000000001' }, ctx);
  assert.deepEqual(JSON.parse(fetch.calls[1].query.filtering), [{ field: 'adset.id', operator: 'EQUAL', value: '120210000000000001' }]);

  const object = await callTool(module, 'get_object', { type: 'campaign', id: CAMPAIGN }, ctx);
  assert.equal(object.payload.account_id, ACCOUNT);

  const audiences = await callTool(module, 'list_audiences', {}, ctx);
  assert.equal(audiences.payload.audiences[0].delivery_status, 'This audience is ready for use.');
  assert.equal(audiences.payload.audiences[0].data_source, 'EVENT_BASED');

  const videos = await callTool(module, 'list_ad_media', { type: 'video' }, ctx);
  assert.deepEqual(videos.payload.videos, [{ id: '130000000000000001', title: 'Holiday', status: 'ready', length: 14.2 }]);

  const search = await callTool(module, 'search_targeting', { type: 'adinterest', q: 'baking' }, ctx);
  assert.equal(search.payload.results[0].id, '6003139266461');
  const noQuery = await callTool(module, 'search_targeting', { type: 'adinterest' }, ctx);
  assert.match(noQuery.payload.error, /q is required/);

  const estimate = await callTool(module, 'estimate_audience', { targeting: { geo_locations: { countries: ['US'] } } }, ctx);
  const estimateQuery = fetch.calls.find((call) => call.path.endsWith('/delivery_estimate')).query;
  assert.equal(estimateQuery.optimization_goal, 'REACH');
  assert.equal(estimateQuery.targeting_spec, '{"geo_locations":{"countries":["US"]}}');
  assert.deepEqual(estimate.payload, { ad_account_id: ACCOUNT, optimization_goal: 'REACH', monthly_active_lower_bound: 1800000, monthly_active_upper_bound: 2100000, estimate_ready: true });

  const pages = await callTool(module, 'list_pages', {}, ctx);
  assert.deepEqual(pages.payload.pages, [{ id: '1001', name: 'Example Bakery', category: 'Bakery', tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT'] }]);
  const promotable = await callTool(module, 'list_pages', { ad_account_id: ACCOUNT }, ctx);
  assert.deepEqual(promotable.payload.pages, [{ id: '1001', name: 'Example Bakery', category: 'Bakery' }]);
});

test('the pages picker lists every Page with no lock, the way a host calls it', async () => {
  const { module, ctx } = setup(router({ 'GET /v26.0/me/accounts': f('me-pages.json') }), { accounts: null });
  const picker = module.accountPickers.find((item) => item.key === 'pages');
  const { payload } = await callTool(module, picker.tool, {}, ctx);
  assert.deepEqual(payload.pages.map((page) => [page[picker.idField], page[picker.nameField]]), [['1001', 'Example Bakery'], ['1002', 'Example Cafe']]);
});

test('api_get and api_request keep to the chosen ad accounts, add the proof, and leave tokens and leads out of reach', async () => {
  const { module, fetch, ctx } = setup(router({
    [`GET /v26.0/act_${ACCOUNT}/adsets`]: { data: [] },
    [`GET /v26.0/${CAMPAIGN}`]: (request) => jsonResponse(200, request.query.fields === 'id,account_id' ? { id: CAMPAIGN, account_id: ACCOUNT } : { id: CAMPAIGN }),
    [`POST /v26.0/${CAMPAIGN}`]: { success: true },
    'GET /v26.0/search': f('search.json'),
    'GET /v26.0/120200000000000777': { id: '120200000000000777', account_id: '999' },
  }), { credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF } });
  const read = await callTool(module, 'api_get', { path: `/v26.0/act_${ACCOUNT}/adsets`, query: { fields: 'id,name' } }, ctx);
  assert.equal(read.payload.status, 200);
  assert.equal(fetch.calls[0].query.appsecret_proof, PROOF);
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${USER_TOKEN}`);

  const rename = await callTool(module, 'api_request', { method: 'POST', path: `/v26.0/${CAMPAIGN}`, json: { name: 'Renamed' } }, ctx);
  assert.equal(rename.payload.status, 200);
  assert.deepEqual(fetch.calls.slice(1).map((call) => `${call.method} ${call.path} ${call.query.fields ?? ''}`.trim()), [`GET /v26.0/${CAMPAIGN} id,account_id`, `POST /v26.0/${CAMPAIGN}`]);

  const search = await callTool(module, 'api_get', { path: '/v26.0/search', query: { type: 'adinterest', q: 'bread' } }, ctx);
  assert.equal(search.payload.status, 200);

  const before = fetch.calls.length;
  const other = await callTool(module, 'api_request', { method: 'DELETE', path: '/v26.0/act_999/adsets' }, ctx);
  assert.match(other.payload.error, /The ad account 999 is not among the ad accounts chosen/);
  const otherObject = await callTool(module, 'api_request', { method: 'POST', path: '/v26.0/120200000000000777', json: { status: 'ACTIVE' } }, ctx);
  assert.match(otherObject.payload.error, /The ad account 999 is not among/);
  const me = await callTool(module, 'api_get', { path: '/v26.0/me/businesses' }, ctx);
  assert.match(me.payload.error, /a path must name one of them \(act_<id>\)/);
  const leads = await callTool(module, 'api_get', { path: `/v26.0/act_${ACCOUNT}/leadgen_forms` }, ctx);
  assert.match(leads.payload.error, /Lead forms and lead data are not available/);
  const token = await callTool(module, 'api_get', { path: `/v26.0/act_${ACCOUNT}`, query: { fields: 'access_token' } }, ctx);
  assert.match(token.payload.error, /Tokens and app secrets are not available/);
  assert.deepEqual(fetch.calls.slice(before).map((call) => `${call.method} ${call.path}`), ['GET /v26.0/120200000000000777']);
});

test('errors: an unclear create names its check tool after one write, and a 429 carries retryAfter', async () => {
  const broken = setup(router({ [`POST /v26.0/act_${ACCOUNT}/campaigns`]: () => jsonResponse(500, { error: { message: 'An unknown error occurred', code: 1 } }) }));
  const unknown = await callTool(broken.module, 'create_campaign', { name: 'x', objective: 'OUTCOME_TRAFFIC' }, broken.ctx);
  assert.equal(unknown.payload.outcome, 'unknown');
  assert.equal(unknown.payload.check, 'list_objects');
  assert.equal(broken.fetch.calls.length, 1);

  const limited = setup(router({ [`GET /v26.0/act_${ACCOUNT}/insights`]: () => jsonResponse(429, { error: { message: 'User request limit reached', code: 17 } }, { 'retry-after': '300' }) }));
  const rate = await callTool(limited.module, 'get_insights', {}, limited.ctx);
  assert.equal(rate.payload.retryAfter, 300);
  assert.match(rate.payload.error, /Meta Ads rate limit reached/);

  const none = setup(router({}), { credentials: {} });
  const notConnected = await callTool(none.module, 'list_ad_accounts', {}, none.ctx);
  assert.match(notConnected.payload.error, /Meta Ads is not connected: it needs the Meta Ads access token, or the Meta Ads system user token\./);
});

test('log lines carry no tokens, proofs or arguments', async () => {
  const { module, ctx, logs } = setup(router({ [`POST /v26.0/act_${ACCOUNT}/campaigns`]: { id: CAMPAIGN } }), { credentials: { access_token: USER_TOKEN, appsecret_proof: PROOF } });
  await callTool(module, 'create_campaign', { name: 'Secret launch', objective: 'OUTCOME_TRAFFIC' }, ctx);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^meta-ads create_campaign POST 200 \d+ms$/);
  for (const secret of [USER_TOKEN, PROOF, 'Secret launch']) assert.equal(logs[0].includes(secret), false);
});
