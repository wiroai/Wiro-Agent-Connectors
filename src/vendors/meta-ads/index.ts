// Meta Ads (Facebook and Instagram ads), through the Marketing API v26.0 on
// the Graph API (https://developers.facebook.com/docs/marketing-api).
//
// Credentials, either way in:
// - `access_token`: a user access token from a sign-in with the customer's own
//   Meta app, with `appsecret_proof` (the HMAC-SHA256 of that token keyed with
//   the app secret, which the host computes) when the host has one;
// - `systemusertoken`: a token of a Meta Business Manager system user that has
//   the ad accounts (and the Pages for ad creatives) assigned, used unchanged.
// When a host passes both, the system user token is used (without the proof).
// `pagemappings` is the Page choice an older setup made per ad account (JSON
// text); the `pages` account picker replaces it.
//
// Campaigns, ad sets and ads are always created paused; update_status turns
// them on. Budgets are in the minor unit of the account's currency (cents).

import {
  allowedAccounts,
  apiTools,
  defineConnector,
  requireAccounts,
  ToolFailure,
  truncate,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  base64,
  compact,
  DATE_PATTERN,
  HTTPS_URL,
  imageType,
  ISO_TIME_PATTERN,
  listResult,
  listState,
  pickAccount,
  proofQuery,
  refuseSecrets,
  rowsOf,
  sleep,
  tokenOf,
  VERSION,
} from './graph.js';
import { readGraphRequest, refuseUnsafe, withoutSecrets, withRateLimits, type GraphRequestParts } from './graph-rules.js';

type SchemaType = ToolDefinition['inputSchema'];

const AD_ACCOUNT = { argument: 'ad_account_id', label: 'ad account' };
const AD_ACCOUNT_ID: SchemaType = {
  type: 'string',
  pattern: '^(act_)?[0-9]{1,30}$',
  description: 'The ad account id, with or without act_, from list_ad_accounts. Leave it out when only one ad account is chosen for this connection.',
};
const OBJECT_ID: SchemaType = { type: 'string', pattern: '^[0-9]{1,30}$', description: 'A campaign, ad set or ad id.' };
const MONEY: SchemaType = { type: 'integer', minimum: 1, maximum: 1_000_000_000_000, description: 'In the minor unit of the account\'s currency: 5000 is 50.00 USD.' };
const TIME: SchemaType = { type: 'string', pattern: ISO_TIME_PATTERN, description: 'A date and time with its offset, such as 2026-12-01T09:00:00+0000.' };
const TARGETING: SchemaType = {
  type: 'object',
  description: 'A Meta targeting spec, such as {"geo_locations": {"countries": ["US"]}, "age_min": 25, "age_max": 54, "flexible_spec": [{"interests": [{"id": "6003139266461"}]}], '
    + '"publisher_platforms": ["facebook", "instagram"]}. Omit the placement fields for automatic placements; never use explore in instagram_positions.',
};
const STATUS_FILTER: SchemaType = {
  type: 'array',
  items: {
    type: 'string',
    enum: ['ACTIVE', 'PAUSED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'],
  },
  minItems: 1,
  uniqueItems: true,
  description: 'Only items with these effective statuses, e.g. ["ACTIVE", "PAUSED"].',
};
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
const OBJECT_TYPES = ['campaign', 'ad_set', 'ad', 'creative'] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];
const OBJECTS: Record<ObjectType, { edge: string; fields: string }> = {
  campaign: {
    edge: 'campaigns',
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,special_ad_categories,start_time,stop_time,created_time',
  },
  ad_set: {
    edge: 'adsets',
    fields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,targeting,promoted_object,destination_type',
  },
  ad: { edge: 'ads', fields: 'id,name,status,effective_status,campaign_id,adset_id,creative{id,name},created_time,updated_time' },
  creative: { edge: 'adcreatives', fields: 'id,name,status,object_story_spec,thumbnail_url,image_hash,video_id,call_to_action_type' },
};
const DEFAULT_INSIGHT_FIELDS: Record<string, string[]> = {
  account: ['spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'actions', 'cost_per_action_type', 'purchase_roas'],
  campaign: ['campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'actions', 'cost_per_action_type', 'purchase_roas'],
  adset: ['adset_id', 'adset_name', 'campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'actions', 'cost_per_action_type'],
  ad: ['ad_id', 'ad_name', 'adset_name', 'campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'actions', 'cost_per_action_type', 'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'],
};
const DATE_PRESETS = [
  'today', 'yesterday', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'last_3d', 'last_7d', 'last_14d', 'last_28d',
  'last_30d', 'last_90d', 'last_week_mon_sun', 'last_week_sun_sat', 'this_week_mon_today', 'this_week_sun_today', 'maximum',
];
const BREAKDOWNS = [
  'age', 'gender', 'country', 'region', 'dma', 'device_platform', 'publisher_platform', 'platform_position', 'impression_device',
  'hourly_stats_aggregated_by_advertiser_time_zone', 'hourly_stats_aggregated_by_audience_time_zone', 'frequency_value',
];
const POLL_MS = 3000;

/** Every request signs in with the connection's token, plus the app secret proof of a sign-in token. */
function graph(h: ToolHelpers, request: Parameters<ToolHelpers['api']>[0]) {
  return h.api({ ...request, query: { ...request.query, ...proofQuery(h.credentials) } });
}

function adAccountOf(h: ToolHelpers, given: string | undefined): string {
  return pickAccount(h, 'ad_accounts', given?.replace(/^act_/, ''), AD_ACCOUNT);
}

/** The Pages an older setup chose for an ad account (pagemappings), or for any account. */
function mappedPages(credentials: Readonly<Record<string, string>>, adAccountId?: string): string[] {
  let mappings: unknown;
  try {
    mappings = JSON.parse(credentials['pagemappings'] ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(mappings)) return [];
  return [...new Set(mappings
    .filter((item) => item && typeof item === 'object' && (!adAccountId || String(item.adaccountid ?? '').replace(/^act_/, '') === adAccountId))
    .map((item) => String(item.pageid ?? ''))
    .filter((id) => /^[0-9]{1,30}$/.test(id)))];
}

/** The Pages the connection may use in creatives, or null without an account lock. */
function allowedPages(h: ToolHelpers, adAccountId?: string): string[] | null {
  const accounts = h.ctx.accounts;
  if (accounts === null) return null;
  if (accounts && Array.isArray(accounts['pages'])) return accounts['pages'].map(String);
  return mappedPages(h.credentials, adAccountId);
}

const PAGE_KEYS = new Set(['page_id', 'actor_id']);
const STORY_KEYS = new Set(['object_story_id', 'effective_object_story_id']);

/** The Page ids that parameters name at any depth (JSON text included): page_id, actor_id, and the Page of an object_story_id. */
function pageIdsIn(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === 'string') {
    if (!/^\s*[[{]/.test(value)) return;
    try {
      pageIdsIn(JSON.parse(value), into, depth + 1);
    } catch {
      // text, not JSON
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pageIdsIn(item, into, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    const name = key.trim().toLowerCase();
    if (PAGE_KEYS.has(name) && (typeof item === 'string' || typeof item === 'number')) into.add(String(item).trim());
    else if (STORY_KEYS.has(name) && typeof item === 'string') into.add(item.trim().split('_')[0] ?? '');
    else pageIdsIn(item, into, depth + 1);
  }
}

/** Refuses any Page outside the ones chosen for the connection, wherever the parameters name one. */
function requirePages(h: ToolHelpers, values: unknown[], adAccountId?: string): void {
  const allowed = allowedPages(h, adAccountId);
  if (allowed === null) return;
  const ids = new Set<string>();
  for (const value of values) pageIdsIn(value, ids);
  const refused = [...ids].filter((id) => !allowed.includes(id)).map((id) => truncate(id, 40));
  if (!refused.length) return;
  throw new ToolFailure(
    `The Page ${refused.join(', ')} ${refused.length > 1 ? 'are' : 'is'} not among the Pages chosen for this connection. `
      + (allowed.length ? `Use one of: ${allowed.join(', ')}.` : 'No Page is chosen for it yet.') + ' Nothing was sent.',
  );
}

function choosePage(h: ToolHelpers, given: string | undefined, adAccountId: string): string {
  const allowed = allowedPages(h, adAccountId);
  if (given) {
    if (allowed && !allowed.includes(given)) {
      throw new ToolFailure(
        `The Page ${given} is not among the Pages chosen for this connection. `
          + (allowed.length ? `Use one of: ${allowed.join(', ')}.` : 'No Page is chosen for it yet.') + ' Nothing was sent.',
      );
    }
    return given;
  }
  if (allowed && allowed.length === 1) return allowed[0] as string;
  if (allowed && allowed.length > 1) throw new ToolFailure(`page_id is required: one of ${allowed.join(', ')}. Nothing was sent.`);
  if (allowed) throw new ToolFailure('No Page is chosen for this connection yet, and a creative needs one. Nothing was sent.');
  throw new ToolFailure('page_id is required. Nothing was sent.');
}

/** Reads an object with its ad account, and refuses one outside the ad accounts chosen for the connection. */
async function objectInAccount(h: ToolHelpers, id: string, fields: string): Promise<any> {
  const { data } = await graph(h, { path: `/${VERSION}/${id}`, query: { fields: `${fields},account_id` } });
  const account = String(data?.account_id ?? '').replace(/^act_/, '');
  if (!account) throw new ToolFailure(`Meta Ads did not say which ad account ${id} belongs to. Nothing was changed.`);
  requireAccounts(h.ctx.accounts, 'ad_accounts', account, 'ad account');
  return data;
}

function trimAccount(account: any): Record<string, unknown> {
  const tasks: string[] = Array.isArray(account?.user_tasks) ? account.user_tasks : [];
  return compact({
    id: account?.account_id ?? String(account?.id ?? '').replace(/^act_/, ''),
    name: account?.name,
    status: ACCOUNT_STATUS[account?.account_status] ?? account?.account_status,
    currency: account?.currency,
    timezone: account?.timezone_name,
    tasks: tasks.length ? tasks : undefined,
    can_manage: tasks.length ? tasks.includes('ADVERTISE') && tasks.includes('ANALYZE') : undefined,
  });
}

function checkPlacements(targeting: any): void {
  if (Array.isArray(targeting?.instagram_positions) && targeting.instagram_positions.includes('explore')) {
    throw new ToolFailure('Meta removed the Instagram explore placement: take explore out of instagram_positions. Nothing was sent.');
  }
}

// Words in a path segment or a fields selection (where Graph names edges and
// nested fields) that lead out of what the generic tools may reach.
const LEAD_WORDS = /(?<![a-z0-9_])(?:leads|leadgen_forms|field_data)(?![a-z0-9_])/i;
const USER_PAGE_WORDS = /(?<![a-z0-9_])accounts(?![a-z0-9_])/i;
const OTHER_ACCOUNT_WORDS = new RegExp(
  '(?<![a-z0-9_])(?:business|businesses|owned_businesses|client_businesses|agencies|adaccounts|ad_accounts|owned_ad_accounts|client_ad_accounts'
    + '|pending_owned_ad_accounts|pending_client_ad_accounts|assigned_ad_accounts|shared_accounts)(?![a-z0-9_])',
  'i',
);

/**
 * What the generic tools keep out of reach besides tokens: lead data, the
 * accounts edge (each Page with its token), and, while ad accounts are chosen,
 * businesses and other ad accounts (by path, nested fields or ids).
 */
function refuseOutOfReach(parts: GraphRequestParts, h: ToolHelpers): void {
  const selection = [...parts.segments, ...parts.fields];
  if (selection.some((text) => LEAD_WORDS.test(text))) {
    throw new ToolFailure('Lead forms and lead data are not available on this connection. Nothing was sent.');
  }
  if (selection.some((text) => USER_PAGE_WORDS.test(text))) {
    throw new ToolFailure('The accounts edge (Pages with their tokens) is not available through the generic Meta Ads tools: list_pages lists the Pages. Nothing was sent.');
  }
  if (allowedAccounts(h.ctx.accounts, 'ad_accounts') === null) return;
  if (selection.some((text) => OTHER_ACCOUNT_WORDS.test(text)) || parts.params.some(({ name }) => name.trim().toLowerCase() === 'ids')) {
    throw new ToolFailure(
      'With ad accounts chosen for this connection, the generic Meta Ads tools stay inside them: businesses, agencies, other ad accounts and '
        + 'lookups by ids are not available. Nothing was sent.',
    );
  }
}

/** The generic tools keep to the chosen ad accounts: a path names one (act_<id>) or an object of one. */
async function adAccountLock(request: ApiToolRequest, h: ToolHelpers): Promise<void> {
  if (allowedAccounts(h.ctx.accounts, 'ad_accounts') === null) return;
  const named = request.segments.filter((segment) => /^act_[0-9]{1,30}$/.test(segment)).map((segment) => segment.slice(4));
  if (named.length) {
    requireAccounts(h.ctx.accounts, 'ad_accounts', named, 'ad account');
    return;
  }
  const first = request.segments[1];
  if (request.method === 'GET' && first === 'search') return;
  if (first && /^[0-9]{1,30}$/.test(first)) {
    try {
      await objectInAccount(h, first, 'id');
    } catch (error) {
      if (error instanceof ToolFailure && error.details.status) {
        throw new ToolFailure(`${first} could not be matched to an ad account chosen for this connection: ${error.message}`, error.details);
      }
      throw error;
    }
    return;
  }
  throw new ToolFailure(
    'With ad accounts chosen for this connection, a path must name one of them (act_<id>) or one of their campaigns, ad sets, ads, creatives or audiences. Nothing was sent.',
  );
}

interface InsightArgs {
  ad_account_id?: string;
  level: string;
  fields?: string[];
  date_preset?: string;
  since?: string;
  until?: string;
  time_increment?: string;
  breakdowns?: string[];
  action_breakdowns?: string[];
  campaign_ids?: string[];
  adset_ids?: string[];
  ad_ids?: string[];
  sort?: string;
  limit: number;
  cursor?: string;
}

interface CreativeArgs {
  ad_account_id?: string;
  page_id?: string;
  instagram_user_id?: string;
  name: string;
  format: 'image' | 'video' | 'carousel';
  message?: string;
  link?: string;
  headline?: string;
  description?: string;
  image_hash?: string;
  video_id?: string;
  thumbnail_url?: string;
  call_to_action_type?: string;
  call_to_action_link?: string;
  cards?: Array<{ link: string; headline?: string; description?: string; image_hash?: string; video_id?: string; call_to_action_type?: string }>;
}

function objectStory(args: CreativeArgs): Record<string, unknown> {
  const cta = (type: string | undefined, link: string | undefined) => (type ? compact({ type, value: link ? { link } : undefined }) : undefined);
  if (args.format === 'video') {
    if (!args.video_id) throw new ToolFailure('A video creative needs video_id (from upload_video). Nothing was sent.');
    return {
      video_data: compact({
        video_id: args.video_id,
        message: args.message,
        title: args.headline,
        link_description: args.description,
        image_url: args.thumbnail_url,
        image_hash: args.image_hash,
        call_to_action: cta(args.call_to_action_type ?? (args.link || args.call_to_action_link ? 'LEARN_MORE' : undefined), args.call_to_action_link ?? args.link),
      }),
    };
  }
  if (!args.link) throw new ToolFailure(`An ${args.format} creative needs link, the page people go to. Nothing was sent.`);
  if (args.format === 'carousel') {
    if (!args.cards || args.cards.length < 2) throw new ToolFailure('A carousel creative needs 2 to 10 cards. Nothing was sent.');
    return {
      link_data: compact({
        link: args.link,
        message: args.message,
        call_to_action: cta(args.call_to_action_type, args.call_to_action_link),
        child_attachments: args.cards.map((card) => compact({
          link: card.link,
          name: card.headline,
          description: card.description,
          image_hash: card.image_hash,
          video_id: card.video_id,
          call_to_action: cta(card.call_to_action_type, card.link),
        })),
      }),
    };
  }
  if (!args.image_hash) throw new ToolFailure('An image creative needs image_hash (from upload_image). Nothing was sent.');
  return {
    link_data: compact({
      link: args.link,
      message: args.message,
      name: args.headline,
      description: args.description,
      image_hash: args.image_hash,
      call_to_action: cta(args.call_to_action_type, args.call_to_action_link),
    }),
  };
}

/**
 * api_get and api_request. Before anything is sent, every argument is read the
 * way Graph reads it (query, JSON or form body, nested JSON text): no batch,
 * method override, token, lead data or accounts edge; with accounts chosen, no
 * other ad account or business, and no Page outside the chosen ones; then the
 * path must name a chosen ad account or one of its objects. Replies lose any
 * token they carry.
 */
function genericTools(): ToolDefinition[] {
  const tools = apiTools({
    label: 'Meta Ads',
    description:
      'The Marketing API v26.0 on https://graph.facebook.com, with the connection\'s token: paths start with /v26.0/, such as /v26.0/act_<id>/insights, '
      + '/v26.0/act_<id>/customaudiences, /v26.0/<campaign_id> or /v26.0/<ad_id>/previews, with parameters in query (lists and objects as JSON text). '
      + 'With ad accounts chosen, a path must name one of them or one of their objects, and Pages in a body must be chosen ones. One request per call: '
      + 'batch and method are refused; lead data and tokens stay out of reach. Reference: https://developers.facebook.com/docs/marketing-api.',
    basePath: `/${VERSION}/`,
    methods: ['POST', 'DELETE'],
    guard: async (request, h) => {
      refuseSecrets(request);
      await adAccountLock(request, h);
    },
    send: async (request, h) => {
      const response = await graph(h, request);
      return { ...response, data: withoutSecrets(response.data) };
    },
  });
  return tools.map((tool) => ({
    ...tool,
    async run(args: Record<string, unknown>, h: ToolHelpers) {
      const parts = readGraphRequest(args, 'Meta Ads');
      refuseUnsafe(parts, 'Meta Ads');
      refuseOutOfReach(parts, h);
      requirePages(h, parts.params.map(({ name, value }) => ({ [name]: value })));
      return tool.run(args, h);
    },
  }));
}

const connector = defineConnector({
  vendor: 'meta-ads',
  label: 'Meta Ads',
  origins: ['https://graph.facebook.com'],
  credentials: ['access_token', 'systemusertoken', 'appsecret_proof', 'pagemappings'],
  requiredCredentials: [['access_token'], ['systemusertoken']],
  credentialLabels: {
    access_token: 'Meta Ads access token',
    systemusertoken: 'Meta Ads system user token',
    appsecret_proof: 'Meta Ads app secret proof',
    pagemappings: 'Meta Ads Page mappings',
  },
  authHeaders: (credentials) => ({ authorization: `Bearer ${tokenOf(credentials)}` }),
  accountPickers: [
    {
      key: 'ad_accounts',
      label: 'Meta ad accounts',
      description: 'The ad accounts the agent may report on and manage.',
      multiple: true,
      tool: 'list_ad_accounts',
      idField: 'id',
      nameField: 'name',
      legacyField: 'adaccountid',
    },
    {
      key: 'pages',
      label: 'Facebook Pages for ads',
      description: 'The Pages the agent may use in ad creatives.',
      multiple: true,
      tool: 'list_pages',
      idField: 'id',
      nameField: 'name',
      legacyField: 'pagemappings',
    },
  ],
  tools: withRateLimits([
    {
      name: 'list_ad_accounts',
      kind: 'read',
      title: 'List Meta ad accounts',
      description:
        'Lists the ad accounts this connection can use, with id (without act_), name, status, currency, time zone and the connected account\'s tasks. '
        + 'By default only active accounts it can both manage and report on (ADVERTISE and ANALYZE); all: true lists every one. When ad accounts are chosen '
        + 'for the connection, only those are listed. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          all: { type: 'boolean', default: false, description: 'true to list every ad account, not only the active ones with ADVERTISE and ANALYZE.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Ad accounts per call, 1 to 100 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { all: boolean; limit: number; cursor?: string }, h) {
        const state = listState(h, args.cursor, args.limit);
        const { data } = await graph(h, {
          path: `/${VERSION}/me/adaccounts`,
          query: { fields: 'account_id,name,account_status,currency,timezone_name,user_tasks', limit: state.limit, after: state.after },
        });
        const allowed = allowedAccounts(h.ctx.accounts, 'ad_accounts');
        const accounts = rowsOf(data)
          .filter((row) => args.all || (row?.account_status === 1 && Array.isArray(row?.user_tasks) && row.user_tasks.includes('ADVERTISE') && row.user_tasks.includes('ANALYZE')))
          .map(trimAccount)
          .filter((item) => typeof item['id'] === 'string' && (!allowed || allowed.includes(item['id'])));
        return listResult(h, 'ad_accounts', accounts, state, data);
      },
    },
    {
      name: 'get_ad_account',
      kind: 'read',
      title: 'Get a Meta ad account',
      description:
        'Returns an ad account\'s status (and why it is disabled), the connected account\'s tasks on it, currency, time zone, amount spent, balance, spend cap '
        + 'and minimum daily budget (money in the currency\'s minor unit). Check can_manage before any change: ANALYZE alone is read-only.',
      inputSchema: { type: 'object', properties: { ad_account_id: AD_ACCOUNT_ID }, additionalProperties: false },
      async run(args: { ad_account_id?: string }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}`,
          query: { fields: 'account_id,name,account_status,disable_reason,user_tasks,currency,timezone_name,amount_spent,balance,spend_cap,min_daily_budget' },
        });
        return compact({
          ...trimAccount(data),
          disable_reason: data?.disable_reason || undefined,
          amount_spent: data?.amount_spent,
          balance: data?.balance,
          spend_cap: data?.spend_cap,
          min_daily_budget: data?.min_daily_budget,
        });
      },
    },
    {
      name: 'list_pages',
      kind: 'read',
      title: 'List Facebook Pages for ads',
      description:
        'Lists the Facebook Pages this connection can use in ad creatives: the Pages assigned to the connected account with its tasks on each (ADVERTISE to run '
        + 'ads), or, with ad_account_id, the Pages that ad account can promote. When Pages are chosen for the connection, only those are listed.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: { ...AD_ACCOUNT_ID, description: 'List the Pages this ad account can promote instead.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Pages per call, 1 to 100 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; limit: number; cursor?: string }, h) {
        const accountId = args.ad_account_id ? adAccountOf(h, args.ad_account_id) : undefined;
        const state = listState(h, args.cursor, args.limit);
        const { data } = await graph(h, {
          path: accountId ? `/${VERSION}/act_${accountId}/promote_pages` : `/${VERSION}/me/accounts`,
          query: { fields: accountId ? 'id,name,category' : 'id,name,category,tasks', limit: state.limit, after: state.after },
        });
        const allowed = allowedPages(h, accountId);
        const pages = rowsOf(data)
          .filter((row) => typeof row?.id === 'string' && (!allowed || allowed.includes(row.id)))
          .map((row) => compact({ id: row.id, name: row.name, category: row.category, tasks: Array.isArray(row.tasks) ? row.tasks : undefined }));
        return listResult(h, 'pages', pages, state, data, accountId ? { ad_account_id: accountId } : undefined);
      },
    },
    {
      name: 'get_insights',
      kind: 'read',
      title: 'Get Meta Ads insights',
      description:
        'Reads ad performance for an ad account at account, campaign, ad set or ad level: spend, impressions, reach, clicks, CTR, CPC, CPM, frequency, actions, '
        + 'cost per action and ROAS by default (ads also get their quality, engagement and conversion rankings), for a date preset (default last_7d) or '
        + 'since/until, optionally per day, broken down by age, gender, country, placement or device, and filtered to campaigns, ad sets or ads. '
        + 'Spend and costs are strings in the account currency, not minor units. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          level: { type: 'string', enum: ['account', 'campaign', 'adset', 'ad'], default: 'campaign', description: 'account, campaign (default), adset or ad.' },
          fields: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9_]{2,60}$' }, minItems: 1, maxItems: 40, uniqueItems: true, description: 'Insight fields instead of the defaults, e.g. ["spend", "actions"].' },
          date_preset: { type: 'string', enum: DATE_PRESETS, description: 'A date preset (default last_7d when no since/until).' },
          since: { type: 'string', pattern: DATE_PATTERN, description: 'The first day, in the account\'s time zone.' },
          until: { type: 'string', pattern: DATE_PATTERN, description: 'The last day, included.' },
          time_increment: { type: 'string', pattern: '^([1-9]|[1-8][0-9]|90|monthly|all_days)$', description: '1 for one row per day, 7 per week, monthly, or all_days (default).' },
          breakdowns: { type: 'array', items: { type: 'string', enum: BREAKDOWNS }, minItems: 1, maxItems: 3, uniqueItems: true, description: 'Break the rows down, e.g. ["age", "gender"] or ["publisher_platform"].' },
          action_breakdowns: { type: 'array', items: { type: 'string', enum: ['action_type', 'action_device', 'action_destination', 'action_video_type', 'action_carousel_card_id'] }, minItems: 1, maxItems: 3, uniqueItems: true, description: 'How actions are split (default action_type).' },
          campaign_ids: { type: 'array', items: OBJECT_ID, minItems: 1, maxItems: 50, uniqueItems: true, description: 'Only these campaigns.' },
          adset_ids: { type: 'array', items: OBJECT_ID, minItems: 1, maxItems: 50, uniqueItems: true, description: 'Only these ad sets.' },
          ad_ids: { type: 'array', items: OBJECT_ID, minItems: 1, maxItems: 50, uniqueItems: true, description: 'Only these ads.' },
          sort: { type: 'string', pattern: '^[a-z0-9_]{2,60}_(ascending|descending)$', description: 'Sort rows, e.g. spend_descending.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Rows per call, 1 to 500 (default 50).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: InsightArgs, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        if ((args.since || args.until) && args.date_preset) throw new ToolFailure('Give date_preset or since and until, not both. Nothing was sent.');
        if (Boolean(args.since) !== Boolean(args.until)) throw new ToolFailure('since and until go together. Nothing was sent.');
        const state = listState(h, args.cursor, args.limit);
        const filtering = [
          ...(args.campaign_ids ? [{ field: 'campaign.id', operator: 'IN', value: args.campaign_ids }] : []),
          ...(args.adset_ids ? [{ field: 'adset.id', operator: 'IN', value: args.adset_ids }] : []),
          ...(args.ad_ids ? [{ field: 'ad.id', operator: 'IN', value: args.ad_ids }] : []),
        ];
        const range = args.since && args.until ? { since: args.since, until: args.until } : undefined;
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}/insights`,
          query: {
            level: args.level,
            fields: (args.fields ?? DEFAULT_INSIGHT_FIELDS[args.level] ?? []).join(','),
            date_preset: range ? undefined : args.date_preset ?? 'last_7d',
            time_range: range ? JSON.stringify(range) : undefined,
            time_increment: args.time_increment,
            breakdowns: args.breakdowns?.join(','),
            action_breakdowns: args.action_breakdowns?.join(','),
            filtering: filtering.length ? JSON.stringify(filtering) : undefined,
            sort: args.sort,
            limit: state.limit,
            after: state.after,
          },
        });
        return listResult(h, 'rows', rowsOf(data), state, data, {
          ad_account_id: accountId,
          level: args.level,
          ...(range ? { since: range.since, until: range.until } : { date_preset: args.date_preset ?? 'last_7d' }),
          note: 'Money in insights is in the account currency (not minor units). A row Meta has no data for is left out.',
        });
      },
    },
    {
      name: 'list_objects',
      kind: 'read',
      title: 'List Meta campaigns, ad sets, ads or creatives',
      description:
        "Lists an ad account's campaigns, ad sets, ads or creatives, newest first, with status, effective status and, for campaigns and ad sets, budgets "
        + '(minor units), bid strategy and schedule; ad sets also show their targeting and optimization goal. Filter by campaign, ad set or effective status. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          type: { type: 'string', enum: [...OBJECT_TYPES], description: 'campaign, ad_set, ad or creative.' },
          campaign_id: { ...OBJECT_ID, description: 'Only the ad sets or ads of this campaign.' },
          adset_id: { ...OBJECT_ID, description: 'Only the ads of this ad set.' },
          effective_status: STATUS_FILTER,
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Items per call, 1 to 100 (default 25).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['type'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; type: ObjectType; campaign_id?: string; adset_id?: string; effective_status?: string[]; limit: number; cursor?: string }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const state = listState(h, args.cursor, args.limit);
        const { edge, fields } = OBJECTS[args.type];
        const filtering = [
          ...(args.campaign_id && args.type !== 'campaign' ? [{ field: 'campaign.id', operator: 'EQUAL', value: args.campaign_id }] : []),
          ...(args.adset_id && args.type === 'ad' ? [{ field: 'adset.id', operator: 'EQUAL', value: args.adset_id }] : []),
        ];
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}/${edge}`,
          query: {
            fields,
            effective_status: args.effective_status && args.type !== 'creative' ? JSON.stringify(args.effective_status) : undefined,
            filtering: filtering.length ? JSON.stringify(filtering) : undefined,
            limit: state.limit,
            after: state.after,
          },
        });
        return listResult(h, 'items', rowsOf(data), state, data, { ad_account_id: accountId, type: args.type });
      },
    },
    {
      name: 'get_object',
      kind: 'read',
      title: 'Get a Meta campaign, ad set, ad or creative',
      description:
        'Returns one campaign, ad set, ad or creative with its ad account, status, effective status and settings (budgets in minor units, targeting, creative). '
        + 'Use it to check a change, or one whose outcome was unclear.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...OBJECT_TYPES], description: 'campaign, ad_set, ad or creative.' },
          id: { ...OBJECT_ID, description: 'Its id.' },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      },
      async run(args: { type: ObjectType; id: string }, h) {
        const extra = args.type === 'ad' ? ',ad_review_feedback,issues_info' : args.type === 'campaign' || args.type === 'ad_set' ? ',updated_time' : '';
        const data = await objectInAccount(h, args.id, `${OBJECTS[args.type].fields}${extra}`);
        return compact({ ...data, account_id: String(data.account_id).replace(/^act_/, '') });
      },
    },
    {
      name: 'list_audiences',
      kind: 'read',
      title: 'List Meta custom audiences',
      description: "Lists an ad account's custom and lookalike audiences with their size range, source, delivery status and last update. Pass nextCursor back as cursor for more.",
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Audiences per call, 1 to 100 (default 25).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; limit: number; cursor?: string }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const state = listState(h, args.cursor, args.limit);
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}/customaudiences`,
          query: {
            fields: 'id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,data_source,delivery_status,operation_status,time_updated',
            limit: state.limit,
            after: state.after,
          },
        });
        const audiences = rowsOf(data).map((row) => compact({
          ...row,
          description: typeof row?.description === 'string' ? truncate(row.description, 300) : undefined,
          data_source: row?.data_source?.type ?? row?.data_source,
          delivery_status: row?.delivery_status?.description ?? row?.delivery_status,
          operation_status: row?.operation_status?.description ?? row?.operation_status,
        }));
        return listResult(h, 'audiences', audiences, state, data, { ad_account_id: accountId });
      },
    },
    {
      name: 'list_ad_media',
      kind: 'read',
      title: 'List Meta ad images or videos',
      description: "Lists an ad account's uploaded ad images (hash, name, URL, size) or ad videos (id, title, processing status, length). Use it to find an image_hash or video_id, or to check an upload.",
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          type: { type: 'string', enum: ['image', 'video'], default: 'image', description: 'image (default) or video.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Items per call, 1 to 100 (default 25).' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; type: 'image' | 'video'; limit: number; cursor?: string }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const state = listState(h, args.cursor, args.limit);
        const images = args.type === 'image';
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}/${images ? 'adimages' : 'advideos'}`,
          query: { fields: images ? 'hash,name,url,width,height,status,created_time' : 'id,title,status,length,created_time', limit: state.limit, after: state.after },
        });
        const items = rowsOf(data).map((row) => (images ? compact(row) : compact({ ...row, status: row?.status?.video_status ?? row?.status })));
        return listResult(h, images ? 'images' : 'videos', items, state, data, { ad_account_id: accountId });
      },
    },
    {
      name: 'search_targeting',
      kind: 'read',
      title: 'Search Meta targeting options',
      description:
        'Finds targeting ids for an ad set: interests (adinterest, or adinterestsuggestion from interest_list), places (adgeolocation, with location_types), '
        + 'languages (adlocale), employers, job titles, schools and fields of study, with the audience size range Meta gives.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['adinterest', 'adinterestsuggestion', 'adgeolocation', 'adlocale', 'adworkemployer', 'adworkposition', 'adeducationschool', 'adeducationmajor'],
            description: 'What to search.',
          },
          q: { type: 'string', minLength: 1, maxLength: 200, description: 'The search text.' },
          interest_list: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 10, description: 'adinterestsuggestion: interest names to find related ones for.' },
          location_types: {
            type: 'array',
            items: { type: 'string', enum: ['country', 'region', 'city', 'zip', 'geo_market', 'electoral_district', 'country_group', 'neighborhood'] },
            minItems: 1,
            uniqueItems: true,
            description: 'adgeolocation: the kinds of place to find.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Results, 1 to 50 (default 10).' },
        },
        required: ['type'],
        additionalProperties: false,
      },
      async run(args: { type: string; q?: string; interest_list?: string[]; location_types?: string[]; limit: number }, h) {
        if (args.type === 'adinterestsuggestion' ? !args.interest_list : !args.q) {
          throw new ToolFailure(args.type === 'adinterestsuggestion' ? 'adinterestsuggestion needs interest_list. Nothing was sent.' : 'q is required. Nothing was sent.');
        }
        const { data } = await graph(h, {
          path: `/${VERSION}/search`,
          query: {
            type: args.type,
            q: args.q,
            interest_list: args.interest_list ? JSON.stringify(args.interest_list) : undefined,
            location_types: args.location_types ? JSON.stringify(args.location_types) : undefined,
            limit: args.limit,
          },
        });
        return { type: args.type, results: rowsOf(data).slice(0, args.limit).map((row) => compact(row)) };
      },
    },
    {
      name: 'estimate_audience',
      kind: 'read',
      title: 'Estimate a Meta Ads audience',
      description:
        'Estimates how many people a targeting spec reaches in an ad account (the monthly active range Meta gives), for an optimization goal (default REACH). '
        + 'Use it to size or compare audiences before creating an ad set.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          targeting: TARGETING,
          optimization_goal: { type: 'string', pattern: '^[A-Z_]{2,60}$', default: 'REACH', description: 'The ad set optimization goal, e.g. REACH (default), LINK_CLICKS, OFFSITE_CONVERSIONS.' },
          promoted_object: { type: 'object', description: 'What the ad set promotes, when the goal needs it, e.g. {"pixel_id": "...", "custom_event_type": "PURCHASE"}.' },
        },
        required: ['targeting'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; targeting: Record<string, unknown>; optimization_goal: string; promoted_object?: Record<string, unknown> }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        checkPlacements(args.targeting);
        const { data } = await graph(h, {
          path: `/${VERSION}/act_${accountId}/delivery_estimate`,
          query: {
            targeting_spec: JSON.stringify(args.targeting),
            optimization_goal: args.optimization_goal,
            promoted_object: args.promoted_object ? JSON.stringify(args.promoted_object) : undefined,
          },
        });
        const [row] = rowsOf(data);
        return compact({
          ad_account_id: accountId,
          optimization_goal: args.optimization_goal,
          monthly_active_lower_bound: row?.estimate_mau_lower_bound,
          monthly_active_upper_bound: row?.estimate_mau_upper_bound,
          estimate_ready: row?.estimate_ready,
        });
      },
    },
    {
      name: 'create_campaign',
      kind: 'create',
      check: 'list_objects',
      title: 'Create a Meta Ads campaign (paused)',
      description:
        'Creates a campaign in an ad account, always paused, with an objective (OUTCOME_*), special ad categories (FINANCIAL_PRODUCTS_SERVICES, EMPLOYMENT, '
        + 'HOUSING or ISSUES_ELECTIONS_POLITICS; [] for none), and optionally a campaign budget (daily or lifetime, in minor units), bid strategy, spend cap '
        + 'and schedule. Without a campaign budget, set budgets on its ad sets. Nothing runs until update_status turns it on.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          name: { type: 'string', minLength: 1, maxLength: 400, description: 'The campaign name.' },
          objective: {
            type: 'string',
            enum: ['OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'],
            description: 'The campaign objective.',
          },
          special_ad_categories: {
            type: 'array',
            items: { type: 'string', enum: ['FINANCIAL_PRODUCTS_SERVICES', 'EMPLOYMENT', 'HOUSING', 'ISSUES_ELECTIONS_POLITICS'] },
            uniqueItems: true,
            default: [],
            description: 'Declared categories for financial products, employment, housing or social issues; [] (default) for none.',
          },
          special_ad_category_country: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}$' }, minItems: 1, uniqueItems: true, description: 'Countries for the special ad categories, e.g. ["US"].' },
          bid_strategy: { type: 'string', enum: ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP', 'LOWEST_COST_WITH_MIN_ROAS'], description: 'With a campaign budget.' },
          daily_budget: { ...MONEY, description: 'A campaign daily budget in minor units (5000 is 50.00 in USD).' },
          lifetime_budget: { ...MONEY, description: 'A campaign lifetime budget in minor units; needs stop_time.' },
          spend_cap: { ...MONEY, description: 'The most the campaign may spend in all, in minor units.' },
          start_time: TIME,
          stop_time: TIME,
          adset_budget_sharing: { type: 'boolean', description: 'Without a campaign budget: let ad sets share up to 20% of their budgets (default false).' },
        },
        required: ['name', 'objective'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; name: string; objective: string; special_ad_categories: string[]; special_ad_category_country?: string[]; bid_strategy?: string; daily_budget?: number; lifetime_budget?: number; spend_cap?: number; start_time?: string; stop_time?: string; adset_budget_sharing?: boolean }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        if (args.daily_budget && args.lifetime_budget) throw new ToolFailure('Give daily_budget or lifetime_budget, not both. Nothing was sent.');
        const campaignBudget = Boolean(args.daily_budget || args.lifetime_budget);
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/campaigns`,
          json: compact({
            name: args.name,
            objective: args.objective,
            status: 'PAUSED',
            special_ad_categories: args.special_ad_categories,
            special_ad_category_country: args.special_ad_category_country,
            bid_strategy: args.bid_strategy,
            daily_budget: args.daily_budget,
            lifetime_budget: args.lifetime_budget,
            spend_cap: args.spend_cap,
            start_time: args.start_time,
            stop_time: args.stop_time,
            is_adset_budget_sharing_enabled: campaignBudget ? undefined : args.adset_budget_sharing ?? false,
          }),
          write: true,
        });
        return compact({
          campaign_id: data?.id ? String(data.id) : undefined,
          ad_account_id: accountId,
          name: args.name,
          objective: args.objective,
          status: 'PAUSED',
          next: 'The campaign is paused. Add ad sets and ads, then turn it on with update_status.',
        });
      },
    },
    {
      name: 'create_ad_set',
      kind: 'create',
      check: 'list_objects',
      title: 'Create a Meta ad set (paused)',
      description:
        'Creates an ad set in a campaign, always paused: targeting, optimization goal, billing event (default IMPRESSIONS), and, unless the campaign has its own '
        + 'budget, a daily or lifetime budget in minor units; optionally a bid, schedule, promoted object (an app: its Meta app ID as application_id, from '
        + 'api_get /v26.0/act_<id>/advertisable_applications, and its store link as object_store_url; a pixel and event; or one of the chosen Pages), '
        + 'destination and attribution.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          campaign_id: { ...OBJECT_ID, description: 'The campaign, from create_campaign or list_objects.' },
          name: { type: 'string', minLength: 1, maxLength: 400, description: 'The ad set name.' },
          optimization_goal: { type: 'string', pattern: '^[A-Z_]{2,60}$', description: 'e.g. LINK_CLICKS, LANDING_PAGE_VIEWS, IMPRESSIONS, REACH, OFFSITE_CONVERSIONS, LEAD_GENERATION, THRUPLAY, VALUE, APP_INSTALLS.' },
          billing_event: { type: 'string', pattern: '^[A-Z_]{2,60}$', default: 'IMPRESSIONS', description: 'What is paid for: IMPRESSIONS (default), LINK_CLICKS, THRUPLAY, ...' },
          targeting: TARGETING,
          daily_budget: { ...MONEY, description: 'A daily budget in minor units (2000 is 20.00 in USD).' },
          lifetime_budget: { ...MONEY, description: 'A lifetime budget in minor units; needs end_time.' },
          bid_amount: { ...MONEY, description: 'A bid or cost cap in minor units, for the bid strategies that take one.' },
          bid_strategy: { type: 'string', enum: ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP', 'LOWEST_COST_WITH_MIN_ROAS'], description: 'The bid strategy.' },
          start_time: TIME,
          end_time: TIME,
          promoted_object: {
            type: 'object',
            description: 'What the ad set promotes, e.g. {"application_id": "<the app\'s Meta app ID>", "object_store_url": "https://apps.apple.com/app/id<App Store id>"} '
              + '(application_id is the Meta app registered for the app, listed by /v26.0/act_<id>/advertisable_applications; a store connector gives only the App Store id '
              + 'or the package name the store link is built from), {"pixel_id": "...", "custom_event_type": "PURCHASE"}, or {"page_id": "<a chosen Page>"}.',
          },
          destination_type: { type: 'string', pattern: '^[A-Z_]{2,40}$', description: 'Where people go, e.g. WEBSITE, APP, MESSENGER, WHATSAPP, ON_AD.' },
          attribution_spec: { type: 'array', maxItems: 4, items: { type: 'object' }, description: 'e.g. [{"event_type": "CLICK_THROUGH", "window_days": 7}].' },
          dsa_beneficiary: { type: 'string', maxLength: 200, description: 'For ads shown in the EU: who benefits from the ad.' },
          dsa_payor: { type: 'string', maxLength: 200, description: 'For ads shown in the EU: who pays for the ad.' },
        },
        required: ['campaign_id', 'name', 'optimization_goal', 'targeting'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const accountId = adAccountOf(h, args['ad_account_id']);
        checkPlacements(args['targeting']);
        if (args['daily_budget'] && args['lifetime_budget']) throw new ToolFailure('Give daily_budget or lifetime_budget, not both. Nothing was sent.');
        requirePages(h, [args['promoted_object']], accountId);
        const { ad_account_id: _account, ...fields } = args;
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/adsets`,
          json: compact({ ...fields, status: 'PAUSED' }),
          write: true,
        });
        return compact({
          adset_id: data?.id ? String(data.id) : undefined,
          ad_account_id: accountId,
          campaign_id: args['campaign_id'],
          name: args['name'],
          status: 'PAUSED',
        });
      },
    },
    {
      name: 'upload_image',
      kind: 'create',
      check: 'list_ad_media',
      title: 'Upload a Meta ad image',
      description:
        'Downloads an image from a public https URL (JPEG, PNG or GIF, up to 30 MB) and uploads it to an ad account\'s image library. Returns the image_hash '
        + 'a creative uses. Sizes: feed 1200x628 or 1080x1080, stories and Reels 1080x1920, at least 600 px wide.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          image_url: { ...HTTPS_URL, description: 'A public https URL of the image.' },
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'A name for it in the library.' },
        },
        required: ['image_url'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; image_url: string; name?: string }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const { bytes } = await h.media(args.image_url, { what: 'image', maxBytes: 30_000_000, accept: 'image/jpeg,image/png,image/gif' });
        if (!imageType(bytes)) throw new ToolFailure('The URL did not return a JPEG, PNG or GIF image. Nothing was uploaded.');
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/adimages`,
          json: compact({ bytes: base64(bytes), name: args.name }),
          write: true,
        });
        const images = data?.images && typeof data.images === 'object' ? Object.values(data.images as Record<string, any>) : [];
        const [image] = images;
        return compact({ ad_account_id: accountId, image_hash: image?.hash, url: image?.url, width: image?.width, height: image?.height, bytes: bytes.length });
      },
    },
    {
      name: 'upload_video',
      kind: 'create',
      check: 'list_ad_media',
      title: 'Upload a Meta ad video',
      description:
        'Adds a video to an ad account from a public https URL (Meta downloads it; MP4 or MOV) and waits up to wait_seconds while Meta processes it. Returns '
        + 'the video_id a creative uses and its status; use it in a creative once the status is ready (list_ad_media shows it).',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          video_url: { ...HTTPS_URL, description: 'A public https URL of the video.' },
          title: { type: 'string', maxLength: 255, description: 'The video title.' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 45, default: 30, description: 'How long to wait for processing, 0 to 45 seconds (default 30).' },
        },
        required: ['video_url'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; video_url: string; title?: string; wait_seconds: number }, h) {
        const deadline = Date.now() + args.wait_seconds * 1000;
        const accountId = adAccountOf(h, args.ad_account_id);
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/advideos`,
          json: compact({ file_url: args.video_url, title: args.title, name: args.title }),
          write: true,
        });
        const videoId = data?.id ? String(data.id) : undefined;
        if (!videoId) throw new ToolFailure('Meta Ads sent back no video id. Check list_ad_media with type video before trying again.');
        let status: string | undefined;
        let reason: string | undefined;
        try {
          for (;;) {
            const read = await graph(h, { path: `/${VERSION}/${videoId}`, query: { fields: 'status' } });
            status = read.data?.status?.video_status;
            reason = read.data?.status?.processing_phase?.error?.message ?? read.data?.status?.error?.message;
            if (status !== 'processing' || Date.now() + POLL_MS > deadline) break;
            await sleep(POLL_MS, h.ctx.signal);
          }
        } catch (error) {
          if (!(error instanceof ToolFailure)) throw error;
          return { ad_account_id: accountId, video_id: videoId, status: 'unknown', note: `The video was added; its status could not be read (${error.message}). Check list_ad_media with type video.` };
        }
        if (status === 'error') {
          throw new ToolFailure(`The video was added as ${videoId}, but Meta Ads could not process it${reason ? `: ${truncate(String(reason), 300)}` : ''}. Upload a fixed file instead.`);
        }
        return compact({
          ad_account_id: accountId,
          video_id: videoId,
          status: status ?? 'processing',
          next: status === 'ready' ? undefined : 'Meta Ads is still processing the video: check list_ad_media with type video before using it in a creative.',
        });
      },
    },
    {
      name: 'create_creative',
      kind: 'create',
      check: 'list_objects',
      title: 'Create a Meta ad creative',
      description:
        'Creates an ad creative for one of the chosen Facebook Pages (and optionally an Instagram account): an image ad (image_hash), a video ad (video_id, '
        + 'with a thumbnail) or a carousel of 2 to 10 cards, with primary text (message, 125 characters recommended), headline (40), description (30), '
        + 'link and call to action (LEARN_MORE, SHOP_NOW, SIGN_UP, DOWNLOAD, INSTALL_MOBILE_APP, ...). Returns the creative id for create_ad.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          page_id: { type: 'string', pattern: '^[0-9]{1,30}$', description: 'The Facebook Page the ad runs as, from list_pages. Leave it out when only one Page is chosen.' },
          instagram_user_id: { type: 'string', pattern: '^[0-9]{1,30}$', description: 'An Instagram account id the ad runs as on Instagram.' },
          name: { type: 'string', minLength: 1, maxLength: 400, description: 'The creative name.' },
          format: { type: 'string', enum: ['image', 'video', 'carousel'], description: 'image, video or carousel.' },
          message: { type: 'string', maxLength: 2200, description: 'The primary text.' },
          link: { ...HTTPS_URL, description: 'Where people go; required for image and carousel ads.' },
          headline: { type: 'string', maxLength: 255, description: 'The headline.' },
          description: { type: 'string', maxLength: 255, description: 'The description under the headline.' },
          image_hash: { type: 'string', pattern: '^[0-9a-f]{32}$', description: 'From upload_image: the image of an image ad, or a video thumbnail.' },
          video_id: { type: 'string', pattern: '^[0-9]{1,30}$', description: 'From upload_video, for a video ad.' },
          thumbnail_url: { ...HTTPS_URL, description: 'A public https URL of a video thumbnail.' },
          call_to_action_type: { type: 'string', pattern: '^[A-Z_]{2,40}$', description: 'e.g. LEARN_MORE, SHOP_NOW, SIGN_UP, DOWNLOAD, GET_OFFER, CONTACT_US, SUBSCRIBE, APPLY_NOW, INSTALL_MOBILE_APP, USE_MOBILE_APP, BOOK_TRAVEL, GET_QUOTE, WATCH_MORE, SEND_MESSAGE.' },
          call_to_action_link: { ...HTTPS_URL, description: 'The call to action\'s link, when it differs from link (a video ad uses link by default).' },
          cards: {
            type: 'array',
            minItems: 2,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                link: HTTPS_URL,
                headline: { type: 'string', maxLength: 255 },
                description: { type: 'string', maxLength: 255 },
                image_hash: { type: 'string', pattern: '^[0-9a-f]{32}$' },
                video_id: { type: 'string', pattern: '^[0-9]{1,30}$' },
                call_to_action_type: { type: 'string', pattern: '^[A-Z_]{2,40}$' },
              },
              required: ['link'],
              additionalProperties: false,
            },
            description: 'Carousel cards: link, headline, description and an image_hash or video_id each.',
          },
        },
        required: ['name', 'format'],
        additionalProperties: false,
      },
      async run(args: CreativeArgs, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const pageId = choosePage(h, args.page_id, accountId);
        const story = objectStory(args);
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/adcreatives`,
          json: { name: args.name, object_story_spec: compact({ page_id: pageId, instagram_user_id: args.instagram_user_id, ...story }) },
          write: true,
        });
        return compact({ creative_id: data?.id ? String(data.id) : undefined, ad_account_id: accountId, page_id: pageId, name: args.name, format: args.format });
      },
    },
    {
      name: 'create_ad',
      kind: 'create',
      check: 'list_objects',
      title: 'Create a Meta ad (paused)',
      description: 'Creates an ad in an ad set from a creative, always paused; turn it on with update_status once its campaign and ad set are ready. Meta reviews every ad before it runs.',
      inputSchema: {
        type: 'object',
        properties: {
          ad_account_id: AD_ACCOUNT_ID,
          adset_id: { ...OBJECT_ID, description: 'The ad set, from create_ad_set or list_objects.' },
          creative_id: { ...OBJECT_ID, description: 'The creative, from create_creative or list_objects.' },
          name: { type: 'string', minLength: 1, maxLength: 400, description: 'The ad name.' },
          tracking_specs: { type: 'array', maxItems: 10, items: { type: 'object' }, description: 'Conversion tracking, e.g. [{"action.type": ["offsite_conversion"], "fb_pixel": ["<pixel id>"]}].' },
        },
        required: ['adset_id', 'creative_id', 'name'],
        additionalProperties: false,
      },
      async run(args: { ad_account_id?: string; adset_id: string; creative_id: string; name: string; tracking_specs?: unknown[] }, h) {
        const accountId = adAccountOf(h, args.ad_account_id);
        const { data } = await graph(h, {
          method: 'POST',
          path: `/${VERSION}/act_${accountId}/ads`,
          json: compact({ name: args.name, adset_id: args.adset_id, creative: { creative_id: args.creative_id }, status: 'PAUSED', tracking_specs: args.tracking_specs }),
          write: true,
        });
        return compact({ ad_id: data?.id ? String(data.id) : undefined, ad_account_id: accountId, adset_id: args.adset_id, creative_id: args.creative_id, status: 'PAUSED' });
      },
    },
    {
      name: 'update_status',
      kind: 'update',
      check: 'get_object',
      title: 'Turn a Meta campaign, ad set or ad on or off',
      description:
        'Sets a campaign, ad set or ad to ACTIVE (it can start spending), PAUSED or ARCHIVED, after checking it belongs to a chosen ad account. Returns its '
        + 'status before and after. A campaign only spends when its ad sets and ads are active too.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: OBJECT_ID,
          status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'], description: 'ACTIVE, PAUSED or ARCHIVED.' },
        },
        required: ['object_id', 'status'],
        additionalProperties: false,
      },
      async run(args: { object_id: string; status: string }, h) {
        const before = await objectInAccount(h, args.object_id, 'id,name,status');
        const { data } = await graph(h, { method: 'POST', path: `/${VERSION}/${args.object_id}`, json: { status: args.status }, write: true });
        if (data?.success === false) throw new ToolFailure('Meta Ads did not change the status (it answered success: false). Check get_object before trying again.');
        return compact({ id: args.object_id, name: before?.name, previous_status: before?.status, status: args.status });
      },
    },
    {
      name: 'update_budget',
      kind: 'update',
      check: 'get_object',
      title: 'Change a Meta campaign or ad set budget',
      description:
        'Changes the budget of a campaign or ad set after checking it belongs to a chosen ad account: daily or lifetime budget, bid amount, spend cap (campaigns) '
        + 'or end time (ad sets). Money is in minor units (3000 is 30.00 in USD). Returns the values before and after.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { ...OBJECT_ID, description: 'A campaign or ad set id.' },
          daily_budget: MONEY,
          lifetime_budget: MONEY,
          bid_amount: MONEY,
          spend_cap: MONEY,
          end_time: TIME,
        },
        required: ['object_id'],
        additionalProperties: false,
      },
      async run(args: { object_id: string; daily_budget?: number; lifetime_budget?: number; bid_amount?: number; spend_cap?: number; end_time?: string }, h) {
        const { object_id: id, ...changes } = args;
        if (!Object.keys(changes).length) throw new ToolFailure('Nothing to change: give a budget, bid_amount, spend_cap or end_time. Nothing was sent.');
        if (changes.daily_budget && changes.lifetime_budget) throw new ToolFailure('Give daily_budget or lifetime_budget, not both. Nothing was sent.');
        const before = await objectInAccount(h, id, 'id,name,daily_budget,lifetime_budget');
        const { data } = await graph(h, { method: 'POST', path: `/${VERSION}/${id}`, json: changes, write: true });
        if (data?.success === false) throw new ToolFailure('Meta Ads did not change the budget (it answered success: false). Check get_object before trying again.');
        return compact({
          id,
          name: before?.name,
          previous: compact({ daily_budget: before?.daily_budget, lifetime_budget: before?.lifetime_budget }),
          changed: changes,
        });
      },
    },
    {
      name: 'delete_object',
      kind: 'delete',
      check: 'get_object',
      title: 'Delete a Meta campaign, ad set or ad',
      description: 'Deletes a campaign, ad set or ad after checking it belongs to a chosen ad account. Meta keeps it with status DELETED; it cannot run again. Pausing is the reversible choice.',
      inputSchema: {
        type: 'object',
        properties: { object_id: OBJECT_ID },
        required: ['object_id'],
        additionalProperties: false,
      },
      async run(args: { object_id: string }, h) {
        const before = await objectInAccount(h, args.object_id, 'id,name,status');
        const { data } = await graph(h, { method: 'DELETE', path: `/${VERSION}/${args.object_id}`, write: true });
        return { id: args.object_id, name: before?.name, deleted: data?.success !== false };
      },
    },
    ...genericTools(),
  ], 'Meta Ads'),
});

export = connector;
