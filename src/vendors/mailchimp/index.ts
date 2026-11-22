// Mailchimp, through the Mailchimp Marketing API 3.0 (https://mailchimp.com/developer/marketing/api/).
//
// Credentials, two ways in:
// - a Mailchimp sign-in: `access_token` (passed and refreshed by the host)
//   and `server`, the account's data center (such as us19) that the sign-in
//   reported;
// - or `apikey`, an API key from Mailchimp -> Profile -> Extras -> API keys,
//   whose last part after the dash (such as -us19) is its data center.
// Every request goes to https://<data center>.api.mailchimp.com/3.0/. The
// data center is checked against Mailchimp's own names (us1 to us30), so a
// credential can never point the module anywhere else.

import { apiTools, defineConnector, ToolFailure, type ApiRequest, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import { subscriberHash } from './md5.js';
import { compact, html, offsetList, stripLinks, trimAudience, trimCampaign, trimMember, trimReport } from './shape.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Mailchimp';

/** Mailchimp's data centers: us1 to us22 answer today, and a few more are allowed for the ones Mailchimp adds. */
const DATA_CENTER = /^us([1-9]|[12][0-9]|30)$/;
const ORIGINS = Array.from({ length: 30 }, (_, index) => `https://us${index + 1}.api.mailchimp.com`);

type Connection = { mode: 'oauth' | 'key'; dc: string };

/** The way in and the data center of a call's credentials, or what is wrong with them. */
function connection(credentials: Readonly<Record<string, string>>): Connection | string {
  const server = (credentials['server'] ?? '').toLowerCase();
  if (credentials['access_token'] && server) {
    if (DATA_CENTER.test(server)) return { mode: 'oauth', dc: server };
    if (!credentials['apikey']) return 'the data center (server) of the sign-in is not one Mailchimp names, such as us19; connect Mailchimp again';
  }
  const key = credentials['apikey'];
  if (key) {
    const suffix = /-([a-z]{2}\d{1,2})$/i.exec(key)?.[1]?.toLowerCase();
    if (suffix) return DATA_CENTER.test(suffix) ? { mode: 'key', dc: suffix } : 'the API key ends with a data center this connector does not know';
    if (DATA_CENTER.test(server)) return { mode: 'key', dc: server };
    return 'the API key lacks its last part after the dash (such as -us19), which names its data center; paste the whole key';
  }
  return 'the sign-in has no data center (server); connect Mailchimp again';
}

function originFor(h: ToolHelpers): string {
  const found = connection(h.credentials);
  if (typeof found === 'string') throw new ToolFailure(`Mailchimp is not connected correctly: ${found}. Nothing was sent.`);
  return `https://${found.dc}.api.mailchimp.com`;
}

/** h.api to the connection's data center. */
function mc(h: ToolHelpers) {
  return (request: ApiRequest) => h.api({ ...request, origin: originFor(h) });
}

const EMAIL: JsonSchema = {
  type: 'string',
  minLength: 3,
  maxLength: 320,
  pattern: '^[^@\\s]+@[^@\\s]+$',
  description: 'An email address.',
};
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result; pass the other arguments unchanged.' };
const ID: JsonSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$', description: 'A Mailchimp id.' };
const LIST_ID: JsonSchema = { ...ID, description: 'The audience (list) id, from list_audiences.' };
const CAMPAIGN_ID: JsonSchema = { ...ID, description: 'The campaign id, from list_campaigns.' };
const COUNT = (what: string, max = 1000, fallback = 50): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description: `${what} per page, 1 to ${max} (default ${fallback}).`,
});
const DATE_TIME = (what: string): JsonSchema => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
  description: `${what}, as an ISO 8601 date or date-time, e.g. 2026-11-01T00:00:00Z.`,
});
const STATUS: JsonSchema = {
  type: 'string',
  enum: ['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional'],
  description: 'subscribed, unsubscribed, cleaned, pending (sends a double opt-in email) or transactional.',
};
const MERGE_FIELDS: JsonSchema = {
  type: 'object',
  description: 'Merge field values by tag, e.g. {"FNAME": "Jane", "LNAME": "Doe"}.',
};

function memberPath(listId: string, email: string): string {
  return `/3.0/lists/${encodeURIComponent(listId)}/members/${subscriberHash(email)}`;
}

const SETTINGS_FIELDS: Record<string, JsonSchema> = {
  subject_line: { type: 'string', minLength: 1, maxLength: 150, description: 'The subject line; merge tags like *|FNAME|* work.' },
  preview_text: { type: 'string', maxLength: 150, description: 'The preview text shown after the subject in inboxes.' },
  title: { type: 'string', maxLength: 100, description: 'The internal campaign title.' },
  from_name: { type: 'string', minLength: 1, maxLength: 100, description: 'The From name.' },
  reply_to: EMAIL,
  to_name: { type: 'string', maxLength: 100, description: 'The To name, e.g. *|FNAME|*.' },
  template_id: { type: 'integer', minimum: 1, description: 'A template to start from (see list_templates).' },
};

interface SettingsArgs {
  subject_line?: string;
  preview_text?: string;
  title?: string;
  from_name?: string;
  reply_to?: string;
  to_name?: string;
  template_id?: number;
  list_id?: string;
  saved_segment_id?: number;
  segment_opts?: Record<string, unknown>;
}

function campaignParts(args: SettingsArgs): Record<string, unknown> {
  if (args.saved_segment_id !== undefined && args.segment_opts !== undefined) {
    throw new ToolFailure('Give saved_segment_id or segment_opts, not both. Nothing was changed.');
  }
  const segment = args.saved_segment_id !== undefined ? { saved_segment_id: args.saved_segment_id } : args.segment_opts;
  const recipients = compact({ list_id: args.list_id, segment_opts: segment });
  const settings = compact({
    subject_line: args.subject_line,
    preview_text: args.preview_text,
    title: args.title,
    from_name: args.from_name,
    reply_to: args.reply_to,
    to_name: args.to_name,
    template_id: args.template_id,
  });
  return compact({
    recipients: Object.keys(recipients).length ? recipients : undefined,
    settings: Object.keys(settings).length ? settings : undefined,
  });
}

const RECIPIENT_FIELDS: Record<string, JsonSchema> = {
  list_id: LIST_ID,
  saved_segment_id: { type: 'integer', minimum: 1, description: 'Send to a saved segment or tag of the audience (see list_segments) instead of all of it.' },
  segment_opts: { type: 'object', description: 'Advanced: Mailchimp segment conditions, e.g. {"match": "all", "conditions": [...]}, instead of saved_segment_id.' },
};

const REPORT_DETAILS: Record<string, string> = {
  'click-details': 'urls_clicked',
  'open-details': 'members',
  unsubscribed: 'unsubscribes',
  'email-activity': 'emails',
  'sent-to': 'sent_to',
  'domain-performance': 'domains',
  locations: 'locations',
  'abuse-reports': 'abuse_reports',
  advice: 'advice',
};

const connector = defineConnector({
  vendor: 'mailchimp',
  label: LABEL,
  origins: ORIGINS,
  credentials: ['access_token', 'apikey', 'server'],
  requiredCredentials: [['access_token', 'server'], ['apikey']],
  credentialLabels: {
    access_token: 'Mailchimp access token',
    apikey: 'Mailchimp API key',
    server: 'Mailchimp data center (server)',
  },
  authHeaders: (credentials): Record<string, string> => {
    const found = connection(credentials);
    if (typeof found === 'string') return {};
    return found.mode === 'oauth'
      ? { authorization: `Bearer ${credentials['access_token']}` }
      : { authorization: `Basic ${btoa(`anystring:${credentials['apikey']}`)}` };
  },
  tools: [
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get the Mailchimp account',
      description: 'The connected Mailchimp account: name, login email, plan, time zone, total subscribers, industry benchmark rates, its data center and how it is connected. A quick connection check.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await mc(h)({ path: '/3.0/' });
        const found = connection(h.credentials) as Connection;
        return compact({
          account_id: data?.account_id,
          account_name: data?.account_name,
          email: data?.email,
          first_name: data?.first_name,
          last_name: data?.last_name,
          role: data?.role,
          pricing_plan_type: data?.pricing_plan_type,
          account_timezone: data?.account_timezone,
          total_subscribers: data?.total_subscribers,
          industry_stats: data?.industry_stats,
          data_center: found.dc,
          connected_with: found.mode === 'oauth' ? 'sign-in' : 'API key',
        });
      },
    },
    {
      name: 'list_audiences',
      kind: 'read',
      title: 'List Mailchimp audiences',
      description: 'The audiences (lists) with their ids, member, unsubscribe and cleaned counts, open and click rates, last campaign and campaign defaults. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { count: COUNT('Audiences', 1000, 25), cursor: CURSOR },
        additionalProperties: false,
      },
      async run(args: { count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, { key: 'lists', path: '/3.0/lists', count: args.count, trim: trimAudience });
      },
    },
    {
      name: 'create_audience',
      kind: 'create',
      check: 'list_audiences',
      title: 'Create a Mailchimp audience',
      description:
        'Creates an audience (list) with its required contact address (shown in email footers), permission reminder and campaign defaults. '
        + 'Free plans allow one audience.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'The audience name.' },
          company: { type: 'string', minLength: 1, maxLength: 100, description: 'The company or organization in the footer.' },
          address1: { type: 'string', minLength: 1, maxLength: 100, description: 'The street address.' },
          address2: { type: 'string', maxLength: 100, description: 'More of the address.' },
          city: { type: 'string', minLength: 1, maxLength: 100, description: 'The city.' },
          state: { type: 'string', maxLength: 100, description: 'The state or region.' },
          zip: { type: 'string', maxLength: 20, description: 'The postal code.' },
          country: { type: 'string', minLength: 2, maxLength: 2, description: 'The two-letter country code, e.g. US.' },
          permission_reminder: { type: 'string', minLength: 1, maxLength: 500, description: 'Why people get these emails, e.g. "You signed up on our website."' },
          from_name: { type: 'string', minLength: 1, maxLength: 100, description: 'The default From name.' },
          from_email: EMAIL,
          subject: { type: 'string', maxLength: 150, description: 'The default subject line.' },
          language: { type: 'string', minLength: 2, maxLength: 10, default: 'en', description: 'The default language, e.g. en.' },
          email_type_option: { type: 'boolean', default: false, description: 'true to let subscribers choose HTML or plain text.' },
          double_optin: { type: 'boolean', description: 'true to send a confirmation email before a signup counts.' },
        },
        required: ['name', 'company', 'address1', 'city', 'country', 'permission_reminder', 'from_name', 'from_email'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const { data } = await mc(h)({
          method: 'POST',
          path: '/3.0/lists',
          json: compact({
            name: args['name'],
            contact: compact({ company: args['company'], address1: args['address1'], address2: args['address2'], city: args['city'], state: args['state'] ?? '', zip: args['zip'] ?? '', country: args['country'] }),
            permission_reminder: args['permission_reminder'],
            campaign_defaults: { from_name: args['from_name'], from_email: args['from_email'], subject: args['subject'] ?? '', language: args['language'] },
            email_type_option: args['email_type_option'],
            double_optin: args['double_optin'],
          }),
          write: true,
          errors: { 400: 'Mailchimp did not accept the audience' },
        });
        return trimAudience(data);
      },
    },
    {
      name: 'list_members',
      kind: 'read',
      title: 'List Mailchimp audience members',
      description:
        'Members of an audience, most recently changed first, with status, merge fields, tags, rating and open and click rates. Filter by status, '
        + 'by when they changed, or VIPs only. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          status: { ...STATUS, description: 'Only members with this status.' },
          since_last_changed: DATE_TIME('Only members changed after this time'),
          before_last_changed: DATE_TIME('Only members changed before this time'),
          vip_only: { type: 'boolean', description: 'true for VIP members only.' },
          count: COUNT('Members', 1000, 50),
          cursor: CURSOR,
        },
        required: ['list_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; status?: string; since_last_changed?: string; before_last_changed?: string; vip_only?: boolean; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'members',
          path: `/3.0/lists/${encodeURIComponent(args.list_id)}/members`,
          count: args.count,
          query: {
            status: args.status,
            since_last_changed: args.since_last_changed,
            before_last_changed: args.before_last_changed,
            vip_only: args.vip_only,
            sort_field: 'last_changed',
            sort_dir: 'DESC',
          },
          trim: trimMember,
        });
      },
    },
    {
      name: 'get_member',
      kind: 'read',
      title: 'Get a Mailchimp audience member',
      description: 'One member of an audience by email address: status, merge fields, tags, interests, rating, signup and opt-in times, open and click rates. The module computes Mailchimp\'s subscriber hash.',
      inputSchema: {
        type: 'object',
        properties: { list_id: LIST_ID, email: EMAIL },
        required: ['list_id', 'email'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; email: string }, h) {
        const { data } = await mc(h)({ path: memberPath(args.list_id, args.email), errors: { 404: 'Mailchimp has no member with that email in this audience' } });
        return trimMember(data);
      },
    },
    {
      name: 'search_members',
      kind: 'read',
      title: 'Search Mailchimp members',
      description: 'Finds members by email address or name, across all audiences or in one: exact matches first, then the wider search.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'An email address, part of one, or a name.' },
          list_id: { ...LIST_ID, description: 'Search only this audience.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; list_id?: string }, h) {
        const { data } = await mc(h)({ path: '/3.0/search-members', query: { query: args.query, list_id: args.list_id, exclude_fields: '_links,exact_matches.members._links,full_search.members._links' } });
        const members = (part: any) => (Array.isArray(part?.members) ? part.members.map(trimMember) : []);
        return {
          exact_matches: { total_items: data?.exact_matches?.total_items ?? 0, members: members(data?.exact_matches) },
          full_search: { total_items: data?.full_search?.total_items ?? 0, members: members(data?.full_search) },
        };
      },
    },
    {
      name: 'upsert_member',
      kind: 'update',
      check: 'get_member',
      title: 'Add or update a Mailchimp member',
      description:
        'Adds a person to an audience with status_if_new, or updates the member with that email: merge fields, interests, language, VIP, and status '
        + 'when given. Use pending for double opt-in. Changing tags is update_member_tags.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          email: EMAIL,
          status_if_new: { ...STATUS, description: 'The status if the person is not a member yet: subscribed, pending (double opt-in), transactional, unsubscribed or cleaned.' },
          status: { ...STATUS, description: 'A new status for an existing member too. Leave out to keep it.' },
          merge_fields: MERGE_FIELDS,
          interests: { type: 'object', description: 'Interest (group) ids set on or off, e.g. {"9143cf3bd1": true}.' },
          language: { type: 'string', minLength: 2, maxLength: 10, description: 'The member\'s language, e.g. en or fr.' },
          vip: { type: 'boolean', description: 'true to mark the member as a VIP.' },
          skip_merge_validation: { type: 'boolean', default: false, description: 'true to accept the member even when required merge fields are missing.' },
        },
        required: ['list_id', 'email', 'status_if_new'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; email: string; status_if_new: string; status?: string; merge_fields?: Record<string, unknown>; interests?: Record<string, unknown>; language?: string; vip?: boolean; skip_merge_validation: boolean }, h) {
        const { data } = await mc(h)({
          method: 'PUT',
          path: memberPath(args.list_id, args.email),
          query: { skip_merge_validation: args.skip_merge_validation || undefined },
          json: compact({
            email_address: args.email,
            status_if_new: args.status_if_new,
            status: args.status,
            merge_fields: args.merge_fields,
            interests: args.interests,
            language: args.language,
            vip: args.vip,
          }),
          write: true,
          errors: { 400: 'Mailchimp did not accept the member' },
        });
        return trimMember(data);
      },
    },
    {
      name: 'batch_upsert_members',
      kind: 'update',
      check: 'list_members',
      title: 'Add or update Mailchimp members in bulk',
      description:
        'Adds up to 500 people to an audience in one call, and updates existing members when update_existing is true. Each member needs an email '
        + 'and a status (subscribed, pending, unsubscribed, cleaned or transactional). Returns the counts and each error.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          members: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            description: 'The members, e.g. [{"email_address": "ann@example.com", "status": "subscribed", "merge_fields": {"FNAME": "Ann"}, "tags": ["VIP"]}].',
            items: {
              type: 'object',
              properties: {
                email_address: EMAIL,
                status: STATUS,
                status_if_new: STATUS,
                merge_fields: MERGE_FIELDS,
                tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 50, description: 'Tags to add.' },
                language: { type: 'string', maxLength: 10 },
                vip: { type: 'boolean' },
              },
              required: ['email_address'],
              additionalProperties: false,
            },
          },
          update_existing: { type: 'boolean', default: true, description: 'true (default) to update members that exist; false leaves them unchanged and reports them as errors.' },
        },
        required: ['list_id', 'members'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; members: Record<string, unknown>[]; update_existing: boolean }, h) {
        const missing = args.members.findIndex((member) => member['status'] === undefined && member['status_if_new'] === undefined);
        if (missing !== -1) throw new ToolFailure(`members[${missing}] needs a status or a status_if_new. Nothing was changed.`);
        const { data } = await mc(h)({
          method: 'POST',
          path: `/3.0/lists/${encodeURIComponent(args.list_id)}`,
          json: { members: args.members, update_existing: args.update_existing },
          write: true,
          errors: { 400: 'Mailchimp did not accept the members' },
        });
        const emails = (items: unknown) => (Array.isArray(items) ? items.map((member: any) => member?.email_address).filter(Boolean) : []);
        return compact({
          total_created: data?.total_created,
          total_updated: data?.total_updated,
          error_count: data?.error_count,
          new_members: emails(data?.new_members),
          updated_members: emails(data?.updated_members),
          errors: Array.isArray(data?.errors) && data.errors.length
            ? data.errors.map((error: any) => compact({ email_address: error?.email_address, error: error?.error, error_code: error?.error_code }))
            : undefined,
        });
      },
    },
    {
      name: 'update_member_tags',
      kind: 'update',
      check: 'get_member',
      title: 'Tag or untag a Mailchimp member',
      description: 'Adds tags to and removes tags from one member of an audience. A tag that does not exist yet is created.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          email: EMAIL,
          add: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 50, uniqueItems: true, description: 'Tag names to add.' },
          remove: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 50, uniqueItems: true, description: 'Tag names to remove.' },
        },
        required: ['list_id', 'email'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; email: string; add?: string[]; remove?: string[] }, h) {
        const tags = [
          ...(args.add ?? []).map((name) => ({ name, status: 'active' })),
          ...(args.remove ?? []).map((name) => ({ name, status: 'inactive' })),
        ];
        if (!tags.length) throw new ToolFailure('Give tags to add or to remove. Nothing was changed.');
        await mc(h)({
          method: 'POST',
          path: `${memberPath(args.list_id, args.email)}/tags`,
          json: { tags },
          write: true,
          errors: { 404: 'Mailchimp has no member with that email in this audience' },
        });
        return compact({ email: args.email, added: args.add, removed: args.remove });
      },
    },
    {
      name: 'remove_member',
      kind: 'delete',
      check: 'get_member',
      title: 'Archive or delete a Mailchimp member',
      description:
        'Archives a member of an audience (kept in Mailchimp, can be added back), or with permanent: true deletes the member and all their data for '
        + 'good (as for a privacy request); a permanently deleted address cannot be re-imported. To stop emails only, set status unsubscribed with upsert_member.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          email: EMAIL,
          permanent: { type: 'boolean', default: false, description: 'true to delete for good instead of archiving.' },
        },
        required: ['list_id', 'email'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; email: string; permanent: boolean }, h) {
        const path = memberPath(args.list_id, args.email);
        await mc(h)({
          method: args.permanent ? 'POST' : 'DELETE',
          path: args.permanent ? `${path}/actions/delete-permanent` : path,
          write: true,
          errors: { 404: 'Mailchimp has no member with that email in this audience' },
        });
        return { email: args.email, [args.permanent ? 'deleted' : 'archived']: true };
      },
    },
    {
      name: 'list_campaigns',
      kind: 'read',
      title: 'List Mailchimp campaigns',
      description:
        'Campaigns, newest first, with status (save = draft, paused, schedule, sending, sent), subject, audience, recipients, send time and, for sent '
        + 'ones, opens and clicks. Filter by status, type, audience or send time. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['save', 'paused', 'schedule', 'sending', 'sent'], description: 'save (drafts), paused, schedule, sending or sent.' },
          type: { type: 'string', enum: ['regular', 'plaintext', 'absplit', 'rss', 'variate'], description: 'Only campaigns of this type.' },
          list_id: { ...LIST_ID, description: 'Only campaigns to this audience.' },
          since_send_time: DATE_TIME('Only campaigns sent after this time'),
          before_send_time: DATE_TIME('Only campaigns sent before this time'),
          count: COUNT('Campaigns', 1000, 25),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { status?: string; type?: string; list_id?: string; since_send_time?: string; before_send_time?: string; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'campaigns',
          path: '/3.0/campaigns',
          count: args.count,
          query: {
            status: args.status,
            type: args.type,
            list_id: args.list_id,
            since_send_time: args.since_send_time,
            before_send_time: args.before_send_time,
            sort_field: 'create_time',
            sort_dir: 'DESC',
          },
          trim: trimCampaign,
        });
      },
    },
    {
      name: 'get_campaign',
      kind: 'read',
      title: 'Get a Mailchimp campaign',
      description: 'One campaign with its settings, audience and segment, recipients, status and summary; include_content adds its HTML and plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: CAMPAIGN_ID,
          include_content: { type: 'boolean', default: false, description: 'true to add the HTML (cut at 20,000 characters) and plain text.' },
        },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string; include_content: boolean }, h) {
        const send = mc(h);
        const path = `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}`;
        const { data } = await send({ path, errors: { 404: 'Mailchimp has no campaign with that id' } });
        const result = trimCampaign(data);
        if (args.include_content) {
          const content = await send({ path: `${path}/content` });
          result['content'] = compact({ html: html(content.data?.html), plain_text: html(content.data?.plain_text) });
        }
        return result;
      },
    },
    {
      name: 'create_campaign',
      kind: 'create',
      check: 'list_campaigns',
      title: 'Create a Mailchimp campaign',
      description:
        'Creates a draft campaign to an audience (or one of its segments) with its subject, preview text, From name and reply-to. Nothing is sent. '
        + 'Then set its body with set_campaign_content, check get_send_checklist, test with send_test_email, and send or schedule it.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['regular', 'plaintext'], default: 'regular', description: 'regular (HTML, default) or plaintext.' },
          ...RECIPIENT_FIELDS,
          ...SETTINGS_FIELDS,
        },
        required: ['list_id', 'subject_line', 'from_name', 'reply_to'],
        additionalProperties: false,
      },
      async run(args: SettingsArgs & { type: string }, h) {
        const { data } = await mc(h)({
          method: 'POST',
          path: '/3.0/campaigns',
          json: { type: args.type, ...campaignParts(args) },
          write: true,
          errors: { 400: 'Mailchimp did not accept the campaign' },
        });
        return trimCampaign(data);
      },
    },
    {
      name: 'update_campaign',
      kind: 'update',
      check: 'get_campaign',
      title: 'Update a Mailchimp campaign',
      description: 'Changes a draft campaign\'s audience, segment or settings (subject, preview text, From name, reply-to, title): only the fields given.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: CAMPAIGN_ID, ...RECIPIENT_FIELDS, ...SETTINGS_FIELDS },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: SettingsArgs & { campaign_id: string }, h) {
        const body = campaignParts(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one setting or recipient field. Nothing was changed.');
        const { data } = await mc(h)({
          method: 'PATCH',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}`,
          json: body,
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp did not accept the change' },
        });
        return trimCampaign(data);
      },
    },
    {
      name: 'set_campaign_content',
      kind: 'update',
      check: 'get_campaign',
      title: 'Set a Mailchimp campaign\'s content',
      description:
        'Sets a draft campaign\'s body: HTML (with *|UNSUB|* for the unsubscribe link and merge tags like *|FNAME|*), plain text, a page Mailchimp '
        + 'imports from a URL, or a template with its editable sections. It replaces the current body.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: CAMPAIGN_ID,
          html: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The HTML body.' },
          plain_text: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The plain text body (generated from the HTML when left out).' },
          url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public page Mailchimp imports as the HTML body, instead of html.' },
          template_id: { type: 'integer', minimum: 1, description: 'A template to use, instead of html (see list_templates).' },
          template_sections: { type: 'object', description: 'With template_id: content for its mc:edit sections, e.g. {"body_content": "<p>Hello</p>"}.' },
        },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string; html?: string; plain_text?: string; url?: string; template_id?: number; template_sections?: Record<string, unknown> }, h) {
        const bodies = [args.html, args.url, args.template_id].filter((item) => item !== undefined).length;
        if (bodies > 1) throw new ToolFailure('Give one of html, url or template_id. Nothing was changed.');
        if (!bodies && args.plain_text === undefined) throw new ToolFailure('Give html, plain_text, url or template_id. Nothing was changed.');
        if (args.template_sections && args.template_id === undefined) throw new ToolFailure('template_sections go with a template_id. Nothing was changed.');
        const { data } = await mc(h)({
          method: 'PUT',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/content`,
          json: compact({
            html: args.html,
            plain_text: args.plain_text,
            url: args.url,
            template: args.template_id !== undefined ? compact({ id: args.template_id, sections: args.template_sections }) : undefined,
          }),
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp did not accept the content' },
        });
        return compact({ campaign_id: args.campaign_id, updated: true, has_html: Boolean(data?.html), has_plain_text: Boolean(data?.plain_text) });
      },
    },
    {
      name: 'get_send_checklist',
      kind: 'read',
      title: 'Check a Mailchimp campaign before sending',
      description: 'Mailchimp\'s send checklist for a campaign: whether it is ready, and each item (audience, subject, content, sender) with its success, warning or error. Run it before send_campaign.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: CAMPAIGN_ID },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string }, h) {
        const { data } = await mc(h)({ path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/send-checklist`, errors: { 404: 'Mailchimp has no campaign with that id' } });
        const items: any[] = Array.isArray(data?.items) ? data.items : [];
        return { is_ready: data?.is_ready === true, items: items.map((item) => compact({ type: item?.type, heading: item?.heading, details: item?.details })) };
      },
    },
    {
      name: 'send_test_email',
      kind: 'create',
      check: 'get_campaign',
      title: 'Send a test of a Mailchimp campaign',
      description: 'Sends a test of a campaign to up to 10 addresses, as HTML or plain text. Mailchimp limits how many tests an account may send a day.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: CAMPAIGN_ID,
          emails: { type: 'array', items: EMAIL, minItems: 1, maxItems: 10, uniqueItems: true, description: 'Where to send the test.' },
          send_type: { type: 'string', enum: ['html', 'plaintext'], default: 'html', description: 'html (default) or plaintext.' },
        },
        required: ['campaign_id', 'emails'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string; emails: string[]; send_type: string }, h) {
        await mc(h)({
          method: 'POST',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/actions/test`,
          json: { test_emails: args.emails, send_type: args.send_type },
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp did not send the test' },
        });
        return { sent: true, campaign_id: args.campaign_id, to: args.emails };
      },
    },
    {
      name: 'send_campaign',
      kind: 'create',
      check: 'get_campaign',
      title: 'Send a Mailchimp campaign',
      description: 'Sends a campaign to its audience right away. It cannot be undone. Run get_send_checklist first; a campaign that is not ready is refused by Mailchimp.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: CAMPAIGN_ID },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string }, h) {
        await mc(h)({
          method: 'POST',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/actions/send`,
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp did not send the campaign' },
        });
        return { sent: true, campaign_id: args.campaign_id, note: 'Mailchimp is sending it; get_campaign shows the status, get_campaign_report the results.' };
      },
    },
    {
      name: 'schedule_campaign',
      kind: 'update',
      check: 'get_campaign',
      title: 'Schedule a Mailchimp campaign',
      description:
        'Schedules a campaign to send at a time on a quarter hour (:00, :15, :30 or :45), in UTC, at least 15 minutes ahead. timewarp sends at that '
        + 'local time in each subscriber\'s time zone (paid plans). unschedule_campaign stops it.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: CAMPAIGN_ID,
          schedule_time: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:(00|15|30|45)(:00(\\.0+)?)?(Z|[+-]00:?00)$',
            description: 'When to send, in UTC on a quarter hour, e.g. 2026-12-01T14:00:00Z.',
          },
          timewarp: { type: 'boolean', default: false, description: 'true to send at that time in each subscriber\'s own time zone.' },
        },
        required: ['campaign_id', 'schedule_time'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string; schedule_time: string; timewarp: boolean }, h) {
        await mc(h)({
          method: 'POST',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/actions/schedule`,
          json: { schedule_time: args.schedule_time, timewarp: args.timewarp },
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp did not schedule the campaign' },
        });
        return { scheduled: true, campaign_id: args.campaign_id, schedule_time: args.schedule_time };
      },
    },
    {
      name: 'unschedule_campaign',
      kind: 'update',
      check: 'get_campaign',
      title: 'Unschedule a Mailchimp campaign',
      description: 'Stops a scheduled campaign from sending and turns it back into a draft.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: CAMPAIGN_ID },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string }, h) {
        await mc(h)({
          method: 'POST',
          path: `/3.0/campaigns/${encodeURIComponent(args.campaign_id)}/actions/unschedule`,
          write: true,
          errors: { 404: 'Mailchimp has no campaign with that id', 400: 'Mailchimp could not unschedule the campaign' },
        });
        return { unscheduled: true, campaign_id: args.campaign_id };
      },
    },
    {
      name: 'list_templates',
      kind: 'read',
      title: 'List Mailchimp templates',
      description: 'Email templates with their ids, names, types and dates: your own (user, default), Mailchimp\'s base or gallery ones, or all. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'base', 'gallery'], default: 'user', description: 'user (default), base or gallery.' },
          count: COUNT('Templates', 1000, 50),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { type: string; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'templates',
          path: '/3.0/templates',
          count: args.count,
          query: { type: args.type },
          trim: (template: any) => compact({
            id: template?.id,
            name: template?.name,
            type: template?.type,
            category: template?.category,
            drag_and_drop: template?.drag_and_drop,
            responsive: template?.responsive,
            active: template?.active,
            date_created: template?.date_created,
            date_edited: template?.date_edited,
          }),
        });
      },
    },
    {
      name: 'create_template',
      kind: 'create',
      check: 'list_templates',
      title: 'Create a Mailchimp template',
      description: 'Creates an HTML email template. Editable areas are marked mc:edit="name"; *|UNSUB|* is the unsubscribe link and *|MC:SUBJECT|* the subject.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 50, description: 'The template name, up to 50 characters.' },
          html: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The template HTML.' },
          folder_id: { type: 'string', maxLength: 100, description: 'A template folder to put it in.' },
        },
        required: ['name', 'html'],
        additionalProperties: false,
      },
      async run(args: { name: string; html: string; folder_id?: string }, h) {
        const { data } = await mc(h)({ method: 'POST', path: '/3.0/templates', json: compact({ name: args.name, html: args.html, folder_id: args.folder_id }), write: true, errors: { 400: 'Mailchimp did not accept the template' } });
        return compact({ id: data?.id, name: data?.name, type: data?.type, date_created: data?.date_created });
      },
    },
    {
      name: 'list_segments',
      kind: 'read',
      title: 'List Mailchimp segments and tags',
      description: 'The segments and tags of an audience with their ids, types (saved = conditions, static = tags or fixed lists) and member counts. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          type: { type: 'string', enum: ['saved', 'static', 'fuzzy'], description: 'Only saved segments, static ones (tags), or fuzzy ones.' },
          count: COUNT('Segments', 1000, 50),
          cursor: CURSOR,
        },
        required: ['list_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; type?: string; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'segments',
          path: `/3.0/lists/${encodeURIComponent(args.list_id)}/segments`,
          count: args.count,
          query: { type: args.type },
          trim: (segment: any) => compact({ id: segment?.id, name: segment?.name, type: segment?.type, member_count: segment?.member_count, created_at: segment?.created_at, updated_at: segment?.updated_at }),
        });
      },
    },
    {
      name: 'create_segment',
      kind: 'create',
      check: 'list_segments',
      title: 'Create a Mailchimp segment',
      description:
        'Creates a segment in an audience: a static one (a tag) with the given member emails, or a saved one that matches conditions, e.g. '
        + '{"match": "all", "conditions": [{"condition_type": "Aim", "field": "aim", "op": "open", "value": "any"}]}.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'The segment or tag name.' },
          static_segment: { type: 'array', items: EMAIL, maxItems: 500, uniqueItems: true, description: 'Member emails for a static segment (tag); an empty list makes an empty tag.' },
          options: { type: 'object', description: 'Conditions for a saved segment: {"match": "any" | "all", "conditions": [...]}.' },
        },
        required: ['list_id', 'name'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; name: string; static_segment?: string[]; options?: Record<string, unknown> }, h) {
        if ((args.static_segment === undefined) === (args.options === undefined)) throw new ToolFailure('Give static_segment or options (one of the two). Nothing was changed.');
        const { data } = await mc(h)({
          method: 'POST',
          path: `/3.0/lists/${encodeURIComponent(args.list_id)}/segments`,
          json: compact({ name: args.name, static_segment: args.static_segment, options: args.options }),
          write: true,
          errors: { 400: 'Mailchimp did not accept the segment' },
        });
        return compact({ id: data?.id, name: data?.name, type: data?.type, member_count: data?.member_count });
      },
    },
    {
      name: 'update_segment_members',
      kind: 'update',
      check: 'list_segments',
      title: 'Add or remove members of a Mailchimp static segment',
      description: 'Adds members to and removes members from a static segment or tag, by email, up to 500 each. The people must already be members of the audience.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: LIST_ID,
          segment_id: { type: 'integer', minimum: 1, description: 'The segment or tag id (see list_segments).' },
          add: { type: 'array', items: EMAIL, maxItems: 500, uniqueItems: true, description: 'Member emails to add.' },
          remove: { type: 'array', items: EMAIL, maxItems: 500, uniqueItems: true, description: 'Member emails to remove.' },
        },
        required: ['list_id', 'segment_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; segment_id: number; add?: string[]; remove?: string[] }, h) {
        if (!args.add?.length && !args.remove?.length) throw new ToolFailure('Give emails to add or to remove. Nothing was changed.');
        const { data } = await mc(h)({
          method: 'POST',
          path: `/3.0/lists/${encodeURIComponent(args.list_id)}/segments/${args.segment_id}`,
          json: compact({ members_to_add: args.add, members_to_remove: args.remove }),
          write: true,
          errors: { 404: 'Mailchimp has no such segment in this audience', 400: 'Mailchimp did not change the segment' },
        });
        const emails = (items: unknown) => (Array.isArray(items) ? items.map((member: any) => member?.email_address).filter(Boolean) : undefined);
        return compact({
          total_added: data?.total_added,
          total_removed: data?.total_removed,
          error_count: data?.error_count,
          members_added: emails(data?.members_added),
          members_removed: emails(data?.members_removed),
          errors: Array.isArray(data?.errors) && data.errors.length ? data.errors : undefined,
        });
      },
    },
    {
      name: 'list_reports',
      kind: 'read',
      title: 'List Mailchimp campaign reports',
      description: 'Results of sent campaigns, newest first: emails sent, opens and clicks with rates, bounces, unsubscribes, abuse reports and audience averages. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          since_send_time: DATE_TIME('Only campaigns sent after this time'),
          before_send_time: DATE_TIME('Only campaigns sent before this time'),
          count: COUNT('Reports', 1000, 20),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { since_send_time?: string; before_send_time?: string; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'reports',
          path: '/3.0/reports',
          count: args.count,
          query: { since_send_time: args.since_send_time, before_send_time: args.before_send_time },
          trim: trimReport,
        });
      },
    },
    {
      name: 'get_campaign_report',
      kind: 'read',
      title: 'Get a Mailchimp campaign report',
      description: 'The results of one sent campaign: emails sent, opens and clicks (totals, unique, rates), bounces, unsubscribes, forwards, abuse reports, audience averages and e-commerce totals.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: CAMPAIGN_ID },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string }, h) {
        const { data } = await mc(h)({ path: `/3.0/reports/${encodeURIComponent(args.campaign_id)}`, errors: { 404: 'Mailchimp has no report for that campaign (it may not be sent yet)' } });
        return trimReport(data);
      },
    },
    {
      name: 'get_report_details',
      kind: 'read',
      title: 'Get details of a Mailchimp campaign report',
      description:
        'One part of a sent campaign\'s report: click-details (each link\'s clicks), open-details (who opened), unsubscribed, email-activity '
        + '(each recipient\'s events), sent-to, domain-performance, locations, abuse-reports or advice. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: CAMPAIGN_ID,
          kind: { type: 'string', enum: Object.keys(REPORT_DETAILS), description: 'Which part of the report.' },
          count: COUNT('Items', 1000, 50),
          cursor: CURSOR,
        },
        required: ['campaign_id', 'kind'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: string; kind: string; count: number; cursor?: string }, h) {
        const field = REPORT_DETAILS[args.kind] as string;
        return offsetList(h, mc(h), args.cursor, {
          key: field,
          path: `/3.0/reports/${encodeURIComponent(args.campaign_id)}/${args.kind}`,
          count: args.count,
          trim: (item: any) => {
            const plain = stripLinks(item) as Record<string, unknown>;
            delete plain['campaign_id'];
            delete plain['list_id'];
            delete plain['list_is_active'];
            return compact(plain);
          },
        });
      },
    },
    {
      name: 'list_automations',
      kind: 'read',
      title: 'List Mailchimp classic automations',
      description: 'Classic automations with their ids, titles, status (save, paused, sending), audience, emails sent and open and click rates. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['save', 'paused', 'sending'], description: 'Only automations with this status.' },
          count: COUNT('Automations', 1000, 50),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { status?: string; count: number; cursor?: string }, h) {
        return offsetList(h, mc(h), args.cursor, {
          key: 'automations',
          path: '/3.0/automations',
          count: args.count,
          query: { status: args.status },
          trim: (automation: any) => compact({
            id: automation?.id,
            title: automation?.settings?.title,
            status: automation?.status,
            create_time: automation?.create_time,
            start_time: automation?.start_time,
            emails_sent: automation?.emails_sent,
            list_id: automation?.recipients?.list_id,
            list_name: automation?.recipients?.list_name,
            report_summary: automation?.report_summary,
          }),
        });
      },
    },
    {
      name: 'set_automation_state',
      kind: 'update',
      check: 'list_automations',
      title: 'Pause or start a Mailchimp automation',
      description: 'Pauses all emails of a classic automation, or starts them again.',
      inputSchema: {
        type: 'object',
        properties: {
          automation_id: { ...ID, description: 'The automation id (see list_automations).' },
          action: { type: 'string', enum: ['pause', 'start'], description: 'pause or start all of its emails.' },
        },
        required: ['automation_id', 'action'],
        additionalProperties: false,
      },
      async run(args: { automation_id: string; action: 'pause' | 'start' }, h) {
        await mc(h)({
          method: 'POST',
          path: `/3.0/automations/${encodeURIComponent(args.automation_id)}/actions/${args.action}-all-emails`,
          write: true,
          errors: { 404: 'Mailchimp has no automation with that id', 400: `Mailchimp could not ${args.action} the automation` },
        });
        return { automation_id: args.automation_id, [args.action === 'pause' ? 'paused' : 'started']: true };
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Mailchimp Marketing API 3.0 at the connection\'s data center (https://<dc>.api.mailchimp.com/3.0), with its credentials: paths start '
        + 'with /3.0/, such as /3.0/lists/{list_id}/merge-fields, /3.0/lists/{list_id}/interest-categories, /3.0/lists/{list_id}/activity, '
        + '/3.0/automations/{id}/emails, /3.0/campaigns/{id}/actions/replicate or /3.0/file-manager/files. Members are addressed by the MD5 of the '
        + 'lower-cased email. Reference: https://mailchimp.com/developer/marketing/api/.',
      basePath: '/3.0/',
      send: (request, h) => h.api({ ...request, origin: originFor(h) }),
      guard(request) {
        if (/^\/3\.0\/authorized-apps(\/|$)/.test(request.path)) {
          throw new ToolFailure('Mailchimp\'s authorized apps are not available here. Nothing was sent.');
        }
      },
    }),
  ],
});

export = connector;
