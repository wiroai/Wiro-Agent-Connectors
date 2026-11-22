// Apollo.io, through the Apollo REST API v1 (https://docs.apollo.io/reference).
//
// Credentials: `apikey`, an Apollo API key, and optionally `masterapikey`, a
// master API key (Settings -> Integrations -> API). A master key reaches every
// endpoint; another key only the endpoints it was given. A call uses the
// master key when there is one, otherwise the API key; either alone is
// enough to connect. The key goes in the x-api-key header to
// https://api.apollo.io/api/v1/ only.
//
// People search is free; enrichment, company search, job postings and news
// use Apollo credits, and their tools say so.

import { apiTools, defineConnector, ToolFailure, truncate, type ApiRequest, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import {
  compact,
  paged,
  trimAccount,
  trimCall,
  trimContact,
  trimDeal,
  trimEmailMessage,
  trimOrganization,
  trimPerson,
  trimSequence,
  trimTask,
} from './shape.js';

type JsonSchema = ToolDefinition['inputSchema'];
type Query = NonNullable<ApiRequest['query']>;

const LABEL = 'Apollo';
const BASE = '/api/v1';

const NO_ACCESS = 'Apollo refused the request: the API key cannot use this endpoint (a master API key, or a key given access to it, can) or the plan does not include it';

/** h.api with Apollo's 403 explained. */
function ap(h: ToolHelpers, request: ApiRequest) {
  return h.api({ ...request, errors: { 403: NO_ACCESS, ...request.errors } });
}

const ID: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'An Apollo id.' };
const IDS = (what: string, max: number): JsonSchema => ({ type: 'array', items: ID, minItems: 1, maxItems: max, uniqueItems: true, description: `${what}, up to ${max}.` });
const STRINGS = (what: string, max = 100): JsonSchema => ({
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 300 },
  maxItems: max,
  uniqueItems: true,
  description: what,
});
const PER_PAGE = (fallback = 25): JsonSchema => ({ type: 'integer', minimum: 1, maximum: 100, default: fallback, description: `Results per page, 1 to 100 (default ${fallback}).` });
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result; pass the other arguments unchanged.' };
const FILTERS: JsonSchema = {
  type: 'object',
  description: 'Any other parameter of this Apollo endpoint, by its documented name without [], e.g. {"organization_industries": ["software"], "revenue_range": {"min": 1000000}}.',
};
const EMAIL: JsonSchema = { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+$', description: 'An email address.' };
const DATE_TIME = (what: string): JsonSchema => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
  description: `${what}, an ISO 8601 date or date-time.`,
});
const CUSTOM_FIELDS: JsonSchema = { type: 'object', description: 'Custom field values by field id (see list_team_data custom_fields), e.g. {"6650f0c0a1b2c3d4e5f60789": "value"}.' };
const DATE: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

/** The free filters with the typed arguments over them: a typed argument that was given wins. */
function merged(typed: Record<string, unknown>, filters?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...filters };
  for (const [key, value] of Object.entries(typed)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A JSON body from typed arguments and the free filters; typed arguments win. */
function body(typed: Record<string, unknown>, filters?: Record<string, unknown>): Record<string, unknown> {
  return compact(merged(typed, filters));
}

/** A {min, max} range, or undefined when neither end is given. */
function range(min: unknown, max: unknown): Record<string, unknown> | undefined {
  return min === undefined && max === undefined ? undefined : compact({ min, max });
}

/** Query parameters for Apollo's GET searches: lists repeat as name[]; names with brackets stay as they are. */
function query(typed: Record<string, unknown>, filters?: Record<string, unknown>): Query {
  const out: Query = {};
  for (const [key, value] of Object.entries(merged(typed, filters))) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      out[key.endsWith(']') ? key : `${key}[]`] = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : item)) as (string | number | boolean)[];
    } else if (typeof value === 'object') {
      // A range such as {"min": 1, "max": 5} becomes name[min]=1&name[max]=5.
      for (const [part, inner] of Object.entries(value as Record<string, unknown>)) {
        if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') out[`${key}[${part}]`] = inner;
      }
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

const PERSON_DETAILS: JsonSchema = {
  type: 'object',
  description: 'Who to enrich: an Apollo person id, an email, a LinkedIn URL, or a name with a company domain or name.',
  properties: {
    id: ID,
    email: EMAIL,
    hashed_email: { type: 'string', pattern: '^[0-9a-f]{32}([0-9a-f]{32})?$', description: 'The MD5 or SHA-256 of the email.' },
    linkedin_url: { type: 'string', format: 'uri', maxLength: 500 },
    first_name: { type: 'string', maxLength: 100 },
    last_name: { type: 'string', maxLength: 100 },
    name: { type: 'string', maxLength: 200 },
    domain: { type: 'string', maxLength: 200, description: 'The employer\'s domain, without www.' },
    organization_name: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
};

const CONTACT_FIELDS: Record<string, JsonSchema> = {
  first_name: { type: 'string', maxLength: 100 },
  last_name: { type: 'string', maxLength: 100 },
  email: EMAIL,
  title: { type: 'string', maxLength: 300 },
  organization_name: { type: 'string', maxLength: 300 },
  account_id: ID,
  owner_id: ID,
  website_url: { type: 'string', maxLength: 500 },
  label_names: STRINGS('Lists (labels) the contact belongs to; on update this replaces them.', 50),
  contact_stage_id: ID,
  present_raw_address: { type: 'string', maxLength: 300, description: 'Where the contact is, e.g. "Austin, United States".' },
  direct_phone: { type: 'string', maxLength: 50 },
  corporate_phone: { type: 'string', maxLength: 50 },
  mobile_phone: { type: 'string', maxLength: 50 },
  home_phone: { type: 'string', maxLength: 50 },
  other_phone: { type: 'string', maxLength: 50 },
  linkedin_url: { type: 'string', maxLength: 500 },
  typed_custom_fields: CUSTOM_FIELDS,
};
const CONTACT: JsonSchema = { type: 'object', properties: CONTACT_FIELDS, additionalProperties: false };

const ACCOUNT_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 300 },
  domain: { type: 'string', maxLength: 200, description: 'The company\'s domain, without www.' },
  owner_id: ID,
  account_stage_id: ID,
  phone: { type: 'string', maxLength: 50 },
  raw_address: { type: 'string', maxLength: 300 },
  typed_custom_fields: CUSTOM_FIELDS,
};

const TASK_TYPES = ['call', 'outreach_manual_email', 'linkedin_step_connect', 'linkedin_step_message', 'linkedin_step_view_profile', 'linkedin_step_interact_post', 'action_item'];

/**
 * One contact or account, or several with the bulk endpoint: the created records, and those Apollo matched instead.
 * With dedupe, the single endpoint updates the record it matches in place, while the bulk endpoint returns its
 * matches unchanged: they come back as unchanged_existing_<kind>.
 */
async function createRecords(
  h: ToolHelpers,
  kind: 'contacts' | 'accounts',
  records: Record<string, unknown>[],
  options: { dedupe: boolean; labels?: string[] },
): Promise<Record<string, unknown>> {
  const trim = kind === 'contacts' ? trimContact : trimAccount;
  if (records.length === 1 && !options.labels?.length) {
    const { data } = await ap(h, {
      method: 'POST',
      path: `${BASE}/${kind}`,
      json: compact({ ...records[0], run_dedupe: options.dedupe || undefined }),
      write: true,
      errors: { 422: `Apollo did not accept the ${kind === 'contacts' ? 'contact' : 'account'}` },
    });
    const record = kind === 'contacts' ? data?.contact : data?.account;
    return { [kind]: record ? [trim(record)] : [] };
  }
  const { data } = await ap(h, {
    method: 'POST',
    path: `${BASE}/${kind}/bulk_create`,
    json: compact({ [kind]: records, run_dedupe: options.dedupe || undefined, append_label_names: options.labels }),
    write: true,
    errors: { 422: `Apollo did not accept the ${kind}` },
  });
  const created: unknown[] = Array.isArray(data?.[`created_${kind}`]) ? data[`created_${kind}`] : [];
  const existing: unknown[] = Array.isArray(data?.[`existing_${kind}`]) ? data[`existing_${kind}`] : [];
  if (!options.dedupe) return compact({ [kind]: created.map(trim), [`existing_${kind}`]: existing.map(trim) });
  return compact({
    [kind]: created.map(trim),
    [`unchanged_existing_${kind}`]: existing.map(trim),
    note: existing.length
      ? `Apollo matched ${existing.length} of them to existing ${kind} and left those unchanged: change them with update_${kind === 'contacts' ? 'contact' : 'account'}.`
      : undefined,
  });
}

/** contacts[i] of upsert_contacts needs something Apollo matches on, or each call would add it again. */
function requireMatchKeys(contacts: Record<string, unknown>[]): void {
  const given = (contact: Record<string, unknown>, key: string) => typeof contact[key] === 'string' && (contact[key] as string).trim() !== '';
  const index = contacts.findIndex((contact) => !given(contact, 'email')
    && !(given(contact, 'first_name') && given(contact, 'last_name') && given(contact, 'organization_name')));
  if (index !== -1) {
    throw new ToolFailure(`contacts[${index}] needs an email, or a first_name and last_name with organization_name, for Apollo to match it on. Nothing was changed.`);
  }
}

/** Apollo's request ids are signed 64-bit integers, as text. */
const REQUEST_ID = /^-?\d{1,19}$/;

/**
 * What enrich_people says about phones. Apollo looks for them after answering, and only while
 * phone_enrichment.status is pending is there a result to poll, by the top-level request id. That id is a
 * signed 64-bit integer, which a JSON number cannot always hold exactly, so it is read from request_id_str.
 */
function phoneLookup(data: any): Record<string, unknown> {
  const lookup = data?.phone_enrichment;
  if (!lookup || typeof lookup !== 'object') return {};
  const message = typeof lookup.message === 'string' && lookup.message ? truncate(lookup.message, 300) : undefined;
  if (lookup.status !== 'pending') return { phone_enrichment: compact({ status: lookup.status, message }) };
  const id = [data?.request_id_str, data?.request_id].find((value) => typeof value === 'string' && REQUEST_ID.test(value))
    ?? (Number.isSafeInteger(data?.request_id) ? String(data.request_id) : undefined);
  if (!id) return { phone_enrichment: { status: 'pending', message: 'Apollo gave no request id that can be read exactly, so the phones cannot be polled.' } };
  return { request_id: id, phone_enrichment: compact({ status: 'pending', message }) };
}

/** get_profile's credit fields: Apollo answers them flat, next to the user's own fields. */
function creditUsage(data: any): Record<string, unknown> {
  const number = (key: string) => (typeof data?.[key] === 'number' ? data[key] : undefined);
  const kind = (limit: string, used: string) => compact({ limit: number(limit), used: number(used) });
  return compact({
    lead_credits: compact({ limit: number('effective_num_lead_credits'), used: number('num_lead_credits_used'), remaining: number('num_credits_remaining') }),
    direct_dial_credits: kind('effective_num_direct_dial_credits', 'num_direct_dial_credits_used'),
    export_credits: kind('effective_num_export_credits', 'num_export_credits_used'),
    ai_credits: kind('effective_num_ai_credits', 'num_ai_credits_used'),
    power_up_credits: kind('effective_num_power_up_credits', 'num_power_up_credits_used'),
    total_unified_credits_used: number('total_unified_credits_used'),
  });
}

const EMAIL_STATUSES = ['delivered', 'scheduled', 'drafted', 'not_opened', 'opened', 'clicked', 'unsubscribed', 'demoed', 'bounced', 'spam_blocked', 'failed_other'];
const REPLY_CLASSES = ['willing_to_meet', 'follow_up_question', 'person_referral', 'out_of_office', 'already_left_company_or_not_right_person', 'not_interested', 'unsubscribe', 'none_of_the_above'];

const LIST_KINDS: Record<string, { path: string; field: string; trim(item: any): unknown; paged?: boolean }> = {
  users: { path: `${BASE}/users/search`, field: 'users', paged: true, trim: (user) => compact({ id: user?.id, first_name: user?.first_name, last_name: user?.last_name, email: user?.email, title: user?.title }) },
  email_accounts: { path: `${BASE}/email_accounts`, field: 'email_accounts', trim: (account) => compact({ id: account?.id, email: account?.email, type: account?.type, active: account?.active, default: account?.default, user_id: account?.user_id }) },
  contact_stages: { path: `${BASE}/contact_stages`, field: 'contact_stages', trim: (stage) => compact({ id: stage?.id, name: stage?.name, display_order: stage?.display_order ?? stage?.order, category: stage?.category }) },
  account_stages: { path: `${BASE}/account_stages`, field: 'account_stages', trim: (stage) => compact({ id: stage?.id, name: stage?.name, display_order: stage?.display_order ?? stage?.order, category: stage?.category }) },
  deal_stages: { path: `${BASE}/opportunity_stages`, field: 'opportunity_stages', trim: (stage) => compact({ id: stage?.id, name: stage?.name, display_order: stage?.display_order, probability: stage?.probability, is_won: stage?.is_won, is_closed: stage?.is_closed, opportunity_pipeline_id: stage?.opportunity_pipeline_id }) },
  lists: { path: `${BASE}/labels`, field: 'labels', trim: (label) => compact({ id: label?.id, name: label?.name, modality: label?.modality, cached_count: label?.cached_count }) },
  custom_fields: { path: `${BASE}/typed_custom_fields`, field: 'typed_custom_fields', trim: (field) => compact({ id: field?.id, name: field?.name, type: field?.type, modality: field?.modality }) },
};

const connector = defineConnector({
  vendor: 'apollo',
  label: LABEL,
  origins: ['https://api.apollo.io'],
  credentials: ['apikey', 'masterapikey'],
  requiredCredentials: [['apikey'], ['masterapikey']],
  credentialLabels: { apikey: 'Apollo API key', masterapikey: 'Apollo master API key' },
  authHeaders: (credentials) => ({ 'x-api-key': (credentials['masterapikey'] || credentials['apikey']) as string }),
  tools: [
    {
      name: 'get_profile',
      kind: 'read',
      title: 'Get the Apollo user and credits',
      description:
        'The Apollo user the API key belongs to (name, email, team) and, with credits, the user\'s credits: for lead, direct dial, export, AI and power-up '
        + 'credits the allowance and how many are used, and the lead credits left. Free; a quick connection check.',
      inputSchema: {
        type: 'object',
        properties: { credits: { type: 'boolean', default: true, description: 'true (default) to include credit usage.' } },
        additionalProperties: false,
      },
      async run(args: { credits: boolean }, h) {
        const { data } = await ap(h, { path: `${BASE}/users/api_profile`, query: { include_credit_usage: args.credits || undefined } });
        return compact({
          id: data?.id,
          team_id: data?.team_id,
          first_name: data?.first_name,
          last_name: data?.last_name,
          email: data?.email,
          title: data?.title,
          credit_usage: args.credits ? creditUsage(data) : undefined,
          key: h.credentials['masterapikey'] ? 'master API key' : 'API key',
        });
      },
    },
    {
      name: 'get_usage',
      kind: 'read',
      title: 'Get Apollo API usage',
      description: 'Apollo usage: per endpoint, the API calls made and the rate limits left this minute, hour and day (kind api), or the credits used by kind (kind credits). Free.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['api', 'credits'], default: 'api', description: 'api (rate limits) or credits.' },
          endpoints: STRINGS('For kind api: only these endpoints, as Apollo names them, e.g. ["api/v1/contacts/search"].', 50),
        },
        additionalProperties: false,
      },
      async run(args: { kind: string; endpoints?: string[] }, h) {
        const { data } = await ap(h, {
          method: 'POST',
          path: args.kind === 'credits' ? `${BASE}/usage_stats/credit_usage_stats` : `${BASE}/usage_stats/api_usage_stats`,
          json: args.kind === 'api' && args.endpoints?.length ? { endpoints: args.endpoints } : {},
          safe: true,
        });
        return data ?? {};
      },
    },
    {
      name: 'search_people',
      kind: 'read',
      title: 'Search Apollo people',
      description:
        'Finds prospects in Apollo\'s database by titles, seniority, locations, company domains, sizes, industries and keywords. Free (no credits). '
        + 'Results have obfuscated last names and no emails or phones: enrich_people reveals those. Up to 100 a page, 500 pages. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          person_titles: STRINGS('Job titles, e.g. ["CEO", "head of marketing"].'),
          include_similar_titles: { type: 'boolean', description: 'Also match similar titles (Apollo\'s default is true).' },
          person_seniorities: { type: 'array', items: { type: 'string', enum: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'] }, uniqueItems: true, description: 'Seniorities.' },
          person_locations: STRINGS('Where people live: cities, US states, countries.'),
          organization_locations: STRINGS('Where their employer is based.'),
          organization_domains: STRINGS('Employer domains, e.g. ["example.com"].', 1000),
          organization_ids: STRINGS('Apollo company ids of employers.'),
          organization_num_employees_ranges: STRINGS('Employer headcounts as "min,max", e.g. ["1,50", "51,200"].'),
          contact_email_status: { type: 'array', items: { type: 'string', enum: ['verified', 'unverified', 'likely to engage', 'unavailable'] }, uniqueItems: true, description: 'Email statuses.' },
          q_keywords: { type: 'string', maxLength: 500, description: 'Keywords over the whole profile.' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'people',
          perPage: args['per_page'],
          maxPage: 500,
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/mixed_people/api_search`,
            json: body({
              person_titles: args['person_titles'],
              include_similar_titles: args['include_similar_titles'],
              person_seniorities: args['person_seniorities'],
              person_locations: args['person_locations'],
              organization_locations: args['organization_locations'],
              q_organization_domains_list: args['organization_domains'],
              organization_ids: args['organization_ids'],
              organization_num_employees_ranges: args['organization_num_employees_ranges'],
              contact_email_status: args['contact_email_status'],
              q_keywords: args['q_keywords'],
              page,
              per_page: perPage,
            }, args['filters']),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: trimPerson,
        });
      },
    },
    {
      name: 'enrich_people',
      kind: 'read',
      title: 'Enrich people with Apollo',
      description:
        'Looks up 1 to 10 people (by Apollo id, email, LinkedIn URL, or name with company) and returns their full profile: work email, title, '
        + 'location, employment and company. Uses Apollo credits: 1 per person for email or details found, 8 more for a mobile phone. '
        + 'Phones arrive later: with reveal_phone_number, phone_enrichment says whether Apollo is looking for them; while it is pending, '
        + 'the result has a request_id for get_enrichment_result. Skipped or not_attempted means there is nothing to wait for.',
      inputSchema: {
        type: 'object',
        properties: {
          people: { type: 'array', items: PERSON_DETAILS, minItems: 1, maxItems: 10, description: 'The people to look up.' },
          reveal_personal_emails: { type: 'boolean', default: false, description: 'true to also return personal emails (more credits; never for people in GDPR regions).' },
          reveal_phone_number: { type: 'boolean', default: false, description: 'true to look for phone numbers too (8 credits for a mobile); they come by get_enrichment_result.' },
        },
        required: ['people'],
        additionalProperties: false,
      },
      async run(args: { people: Record<string, string>[]; reveal_personal_emails: boolean; reveal_phone_number: boolean }, h) {
        const index = args.people.findIndex((person) => !person['id'] && !person['email'] && !person['hashed_email'] && !person['linkedin_url'] && !person['name'] && !(person['first_name'] && person['last_name']));
        if (index !== -1) throw new ToolFailure(`people[${index}] needs an id, an email, a LinkedIn URL or a name. Nothing was sent.`);
        const options = compact({
          reveal_personal_emails: args.reveal_personal_emails || undefined,
          reveal_phone_number: args.reveal_phone_number || undefined,
          // Apollo sends phone results to a webhook or keeps them for polling: this connector polls.
          poll_only: args.reveal_phone_number || undefined,
        });
        if (args.people.length === 1) {
          const { data } = await ap(h, { method: 'POST', path: `${BASE}/people/match`, json: { ...args.people[0], ...options }, safe: true });
          return compact({ matches: [trimPerson(data?.person)], credits_consumed: data?.credits_consumed, ...phoneLookup(data) });
        }
        const { data } = await ap(h, { method: 'POST', path: `${BASE}/people/bulk_match`, json: { details: args.people, ...options }, safe: true });
        const matches: unknown[] = Array.isArray(data?.matches) ? data.matches : [];
        return compact({
          matches: matches.map(trimPerson),
          missing_records: data?.missing_records,
          credits_consumed: data?.credits_consumed,
          ...phoneLookup(data),
        });
      },
    },
    {
      name: 'get_enrichment_result',
      kind: 'read',
      title: 'Get an Apollo enrichment result',
      description:
        'The phone numbers (or waterfall results) of an earlier enrich_people with reveal_phone_number, by the request_id it returned while '
        + 'phone_enrichment was pending. While Apollo is still looking it answers 404: try again in about 10 seconds, a few times at most.',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'string', pattern: REQUEST_ID.source, description: 'The request_id from enrich_people, exactly as given, e.g. "-9045486258674686251".' } },
        required: ['request_id'],
        additionalProperties: false,
      },
      async run(args: { request_id: string }, h) {
        const { data } = await ap(h, {
          path: `${BASE}/webhook_result/${args.request_id}`,
          errors: {
            // Apollo's 404 is either result_pending (still looking) or request_id_unknown (an id it never issued). Its
            // body carries only that code, under error_code, so the sentence says what to do in each case.
            404: 'Apollo has no result for that request_id. If its phone lookup is still running (result_pending), try again in about 10 seconds, '
              + 'a few times at most; if it keeps answering 404, Apollo does not know the id (request_id_unknown): stop, since only a request_id '
              + 'that enrich_people returned with phone_enrichment pending can be polled',
            400: 'Apollo did not take that request_id (it must be the signed number enrich_people returned)',
            410: 'Apollo no longer keeps that result (it is older than 30 days)',
          },
        });
        const result = data?.webhook_result ?? data;
        const people: unknown[] = Array.isArray(result?.people) ? result.people : Array.isArray(result?.matches) ? result.matches : result?.person ? [result.person] : [];
        return compact({
          request_type: data?.request_type,
          status: result?.status ?? data?.webhook_status,
          failure_reason: data?.failure_reason,
          credits_consumed: result?.credits_consumed,
          people: people.map(trimPerson),
        });
      },
    },
    {
      name: 'enrich_organizations',
      kind: 'read',
      title: 'Enrich companies with Apollo',
      description: 'Looks up 1 to 10 companies by domain and returns their profile: industry, size, revenue, funding, location, technologies, links. Uses 1 Apollo credit per company.',
      inputSchema: {
        type: 'object',
        properties: { domains: { type: 'array', items: { type: 'string', pattern: '^(?!www\\.)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$', description: 'A domain without www, e.g. example.com.' }, minItems: 1, maxItems: 10, uniqueItems: true, description: 'Company domains.' } },
        required: ['domains'],
        additionalProperties: false,
      },
      async run(args: { domains: string[] }, h) {
        if (args.domains.length === 1) {
          const { data } = await ap(h, { path: `${BASE}/organizations/enrich`, query: { domain: args.domains[0] } });
          return { organizations: data?.organization ? [trimOrganization(data.organization)] : [] };
        }
        const { data } = await ap(h, { method: 'POST', path: `${BASE}/organizations/bulk_enrich`, json: { domains: args.domains }, safe: true });
        const organizations: unknown[] = Array.isArray(data?.organizations) ? data.organizations : [];
        return compact({ organizations: organizations.map(trimOrganization), missing_records: data?.missing_records });
      },
    },
    {
      name: 'search_organizations',
      kind: 'read',
      title: 'Search Apollo companies',
      description:
        'Finds companies in Apollo\'s database by name, domains, headcount, locations, keywords, technologies, revenue or funding. Uses 1 Apollo credit '
        + 'per page (up to 100 companies). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          q_organization_name: { type: 'string', maxLength: 200, description: 'Part of the company name.' },
          organization_domains: STRINGS('Company domains.', 1000),
          organization_num_employees_ranges: STRINGS('Headcounts as "min,max", e.g. ["51,200"].'),
          organization_locations: STRINGS('Headquarters locations.'),
          organization_not_locations: STRINGS('Headquarters locations to leave out.'),
          q_organization_keyword_tags: STRINGS('Industry keywords, e.g. ["saas"].'),
          currently_using_any_of_technology_uids: STRINGS('Technologies, with underscores, e.g. ["google_analytics"].'),
          organization_ids: STRINGS('Apollo company ids.'),
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'organizations',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/mixed_companies/search`,
            json: body({
              q_organization_name: args['q_organization_name'],
              q_organization_domains_list: args['organization_domains'],
              organization_num_employees_ranges: args['organization_num_employees_ranges'],
              organization_locations: args['organization_locations'],
              organization_not_locations: args['organization_not_locations'],
              q_organization_keyword_tags: args['q_organization_keyword_tags'],
              currently_using_any_of_technology_uids: args['currently_using_any_of_technology_uids'],
              organization_ids: args['organization_ids'],
              page,
              per_page: perPage,
            }, args['filters']),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: trimOrganization,
          extra: (data) => ({ saved_accounts: Array.isArray(data?.accounts) && data.accounts.length ? data.accounts.map(trimAccount) : undefined }),
        });
      },
    },
    {
      name: 'list_job_postings',
      kind: 'read',
      title: 'List an Apollo company\'s job postings',
      description: 'A company\'s open job postings (title, location, URL, date). Uses 1 Apollo credit per page. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { organization_id: { ...ID, description: 'The Apollo company id (from search_organizations or enrich_organizations).' }, per_page: PER_PAGE(25), cursor: CURSOR },
        required: ['organization_id'],
        additionalProperties: false,
      },
      async run(args: { organization_id: string; per_page: number; cursor?: string }, h) {
        return paged(h, args.cursor, {
          key: 'organization_job_postings',
          perPage: args.per_page,
          request: (page, perPage) => ({ path: `${BASE}/organizations/${args.organization_id}/job_postings`, query: { page, per_page: perPage }, errors: { 403: NO_ACCESS } }),
          trim: (job: any) => compact({ id: job?.id, title: job?.title, url: job?.url, city: job?.city, state: job?.state, country: job?.country, posted_at: job?.posted_at, last_seen_at: job?.last_seen_at }),
        });
      },
    },
    {
      name: 'search_news',
      kind: 'read',
      title: 'Search Apollo news about companies',
      description: 'News articles about given companies (funding, hires, launches, partnerships), newest first, optionally by category and date. Uses 1 Apollo credit per page. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          organization_ids: { type: 'array', items: ID, minItems: 1, maxItems: 100, uniqueItems: true, description: 'Apollo company ids.' },
          categories: STRINGS('News categories, e.g. ["hires", "investment"].', 20),
          published_after: DATE_TIME('Only articles published on or after this date'),
          published_before: DATE_TIME('Only articles published on or before this date'),
          per_page: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Articles per page, 1 to 25 (default 10).' },
          cursor: CURSOR,
        },
        required: ['organization_ids'],
        additionalProperties: false,
      },
      async run(args: { organization_ids: string[]; categories?: string[]; published_after?: string; published_before?: string; per_page: number; cursor?: string }, h) {
        return paged(h, args.cursor, {
          key: 'news_articles',
          perPage: args.per_page,
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/news_articles/search`,
            json: body({
              organization_ids: args.organization_ids,
              categories: args.categories,
              published_at: range(args.published_after, args.published_before),
              page,
              per_page: perPage,
            }),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: (article: any) => compact({ id: article?.id, title: article?.title, url: article?.url, domain: article?.domain, published_at: article?.published_at, event_categories: article?.event_categories, organization_id: article?.organization_id, snippet: typeof article?.snippet === 'string' ? article.snippet.slice(0, 400) : undefined }),
        });
      },
    },
    {
      name: 'create_contacts',
      kind: 'create',
      check: 'search_contacts',
      title: 'Create Apollo contacts',
      description:
        'Saves 1 to 100 people as contacts in your Apollo account, with their email, title, company, phones, lists and owner. Apollo does not check '
        + 'for duplicates here: to avoid them, use upsert_contacts. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          contacts: { type: 'array', items: CONTACT, minItems: 1, maxItems: 100, description: 'The contacts.' },
          append_label_names: STRINGS('Lists (labels) to add every contact to.', 50),
        },
        required: ['contacts'],
        additionalProperties: false,
      },
      async run(args: { contacts: Record<string, unknown>[]; append_label_names?: string[] }, h) {
        return createRecords(h, 'contacts', args.contacts, { dedupe: false, labels: args.append_label_names });
      },
    },
    {
      name: 'upsert_contacts',
      kind: 'update',
      check: 'search_contacts',
      title: 'Create or update Apollo contacts',
      description:
        'Saves 1 to 100 contacts without adding duplicates. Each needs an email, or a first and last name with organization_name, for Apollo to match on. '
        + 'One contact (without append_label_names): the contact Apollo matches is updated in place with the values given (others are kept), or a new '
        + 'one is created. Several, or append_label_names: Apollo creates the new ones and leaves those it matches unchanged; they come back in '
        + 'unchanged_existing_contacts, to change with update_contact. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          contacts: { type: 'array', items: CONTACT, minItems: 1, maxItems: 100, description: 'The contacts.' },
          append_label_names: STRINGS('Lists (labels) to add the contacts to. Given, it makes this a bulk save: contacts Apollo matches are left as they are.', 50),
        },
        required: ['contacts'],
        additionalProperties: false,
      },
      async run(args: { contacts: Record<string, unknown>[]; append_label_names?: string[] }, h) {
        requireMatchKeys(args.contacts);
        return createRecords(h, 'contacts', args.contacts, { dedupe: true, labels: args.append_label_names });
      },
    },
    {
      name: 'update_contact',
      kind: 'update',
      check: 'get_contact',
      title: 'Update an Apollo contact',
      description: 'Changes one contact: only the fields given. label_names replaces the contact\'s lists. Free.',
      inputSchema: {
        type: 'object',
        properties: { contact_id: { ...ID, description: 'The contact id.' }, ...CONTACT_FIELDS },
        required: ['contact_id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const { contact_id: id, ...fields } = args;
        if (!Object.keys(compact(fields)).length) throw new ToolFailure('Nothing to change: give at least one field. Nothing was changed.');
        const { data } = await ap(h, {
          method: 'PATCH',
          path: `${BASE}/contacts/${id}`,
          json: compact(fields),
          write: true,
          errors: { 404: 'Apollo has no contact with that id', 422: 'Apollo did not accept the change' },
        });
        return trimContact(data?.contact ?? data);
      },
    },
    {
      name: 'search_contacts',
      kind: 'read',
      title: 'Search Apollo contacts',
      description: 'Your saved contacts by keywords (name, title, company, email), stages or lists, sorted by activity, creation or update. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          q_keywords: { type: 'string', maxLength: 500, description: 'Keywords: a name, title, company or email.' },
          contact_stage_ids: STRINGS('Contact stage ids (see list_team_data contact_stages).'),
          contact_label_ids: STRINGS('List (label) ids (see list_team_data lists).'),
          sort_by_field: { type: 'string', enum: ['contact_last_activity_date', 'contact_email_last_opened_at', 'contact_email_last_clicked_at', 'contact_created_at', 'contact_updated_at'], description: 'Sort by this field.' },
          sort_ascending: { type: 'boolean', description: 'true for ascending (with sort_by_field).' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'contacts',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/contacts/search`,
            json: body({
              q_keywords: args['q_keywords'],
              contact_stage_ids: args['contact_stage_ids'],
              contact_label_ids: args['contact_label_ids'],
              sort_by_field: args['sort_by_field'],
              sort_ascending: args['sort_ascending'],
              page,
              per_page: perPage,
            }, args['filters']),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: trimContact,
        });
      },
    },
    {
      name: 'get_contact',
      kind: 'read',
      title: 'Get an Apollo contact',
      description: 'One saved contact with its email, phones, company, stage, lists, owner, sequences and custom fields. Free.',
      inputSchema: { type: 'object', properties: { contact_id: { ...ID, description: 'The contact id.' } }, required: ['contact_id'], additionalProperties: false },
      async run(args: { contact_id: string }, h) {
        const { data } = await ap(h, { path: `${BASE}/contacts/${args.contact_id}`, errors: { 404: 'Apollo has no contact with that id' } });
        return trimContact(data?.contact ?? data);
      },
    },
    {
      name: 'create_accounts',
      kind: 'create',
      check: 'search_accounts',
      title: 'Create Apollo accounts',
      description: 'Saves 1 to 100 companies as accounts in your Apollo account, with name, domain, owner, stage, phone and address. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          accounts: { type: 'array', items: { type: 'object', properties: ACCOUNT_FIELDS, required: ['name'], additionalProperties: false }, minItems: 1, maxItems: 100, description: 'The accounts.' },
          append_label_names: STRINGS('Lists (labels) to add every account to.', 50),
        },
        required: ['accounts'],
        additionalProperties: false,
      },
      async run(args: { accounts: Record<string, unknown>[]; append_label_names?: string[] }, h) {
        return createRecords(h, 'accounts', args.accounts, { dedupe: false, labels: args.append_label_names });
      },
    },
    {
      name: 'update_account',
      kind: 'update',
      check: 'get_account',
      title: 'Update an Apollo account',
      description: 'Changes one account (a saved company): only the fields given. Free.',
      inputSchema: {
        type: 'object',
        properties: { account_id: { ...ID, description: 'The account id.' }, ...ACCOUNT_FIELDS },
        required: ['account_id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const { account_id: id, ...fields } = args;
        if (!Object.keys(compact(fields)).length) throw new ToolFailure('Nothing to change: give at least one field. Nothing was changed.');
        const { data } = await ap(h, {
          method: 'PATCH',
          path: `${BASE}/accounts/${id}`,
          json: compact(fields),
          write: true,
          errors: { 404: 'Apollo has no account with that id', 422: 'Apollo did not accept the change' },
        });
        return trimAccount(data?.account ?? data);
      },
    },
    {
      name: 'search_accounts',
      kind: 'read',
      title: 'Search Apollo accounts',
      description: 'Your saved accounts (companies) by name, stages or lists, sorted by activity, creation or update. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          q_organization_name: { type: 'string', maxLength: 200, description: 'Part of the company name.' },
          account_stage_ids: STRINGS('Account stage ids (see list_team_data account_stages).'),
          account_label_ids: STRINGS('List (label) ids.'),
          sort_by_field: { type: 'string', enum: ['account_last_activity_date', 'account_created_at', 'account_updated_at'], description: 'Sort by this field.' },
          sort_ascending: { type: 'boolean', description: 'true for ascending (with sort_by_field).' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'accounts',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/accounts/search`,
            json: body({
              q_organization_name: args['q_organization_name'],
              account_stage_ids: args['account_stage_ids'],
              account_label_ids: args['account_label_ids'],
              sort_by_field: args['sort_by_field'],
              sort_ascending: args['sort_ascending'],
              page,
              per_page: perPage,
            }, args['filters']),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: trimAccount,
        });
      },
    },
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get an Apollo account',
      description: 'One saved account (company) with its domain, owner, stage, lists and custom fields. Free.',
      inputSchema: { type: 'object', properties: { account_id: { ...ID, description: 'The account id.' } }, required: ['account_id'], additionalProperties: false },
      async run(args: { account_id: string }, h) {
        const { data } = await ap(h, { path: `${BASE}/accounts/${args.account_id}`, errors: { 404: 'Apollo has no account with that id' } });
        return trimAccount(data?.account ?? data);
      },
    },
    {
      name: 'search_sequences',
      kind: 'read',
      title: 'Search Apollo sequences',
      description: 'Sequences (email outreach campaigns) by name, with whether they are active, their steps, and contacts scheduled, delivered, opened, replied and bounced with rates. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: { q_name: { type: 'string', maxLength: 200, description: 'Part of the sequence name.' }, per_page: PER_PAGE(), cursor: CURSOR },
        additionalProperties: false,
      },
      async run(args: { q_name?: string; per_page: number; cursor?: string }, h) {
        return paged(h, args.cursor, {
          key: 'emailer_campaigns',
          perPage: args.per_page,
          request: (page, perPage) => ({ method: 'POST', path: `${BASE}/emailer_campaigns/search`, json: body({ q_name: args.q_name, page, per_page: perPage }), safe: true, errors: { 403: NO_ACCESS } }),
          trim: trimSequence,
        });
      },
    },
    {
      name: 'add_contacts_to_sequence',
      kind: 'create',
      check: 'get_contact',
      title: 'Add contacts to an Apollo sequence',
      description:
        'Adds contacts (by id, or every contact of some lists) to a sequence, sending from one of your email accounts (list_team_data email_accounts). '
        + 'In an active sequence they start getting its emails. Contacts without email, unverified, or active in other sequences are skipped unless allowed; '
        + 'the result names those skipped and why.',
      inputSchema: {
        type: 'object',
        properties: {
          sequence_id: { ...ID, description: 'The sequence id (see search_sequences).' },
          contact_ids: IDS('Contact ids', 100),
          label_names: STRINGS('Instead of contact_ids: add every contact of these lists.', 20),
          send_email_from_email_account_id: { ...ID, description: 'The email account to send from.' },
          sequence_no_email: { type: 'boolean', description: 'Also add contacts without an email.' },
          sequence_unverified_email: { type: 'boolean', description: 'Also add contacts with an unverified email.' },
          sequence_job_change: { type: 'boolean', description: 'Also add contacts who recently changed jobs.' },
          sequence_active_in_other_campaigns: { type: 'boolean', description: 'Also add contacts active in other sequences.' },
          sequence_finished_in_other_campaigns: { type: 'boolean', description: 'Also add contacts finished in other sequences.' },
          sequence_same_company_in_same_campaign: { type: 'boolean', description: 'Also add contacts whose colleagues are in this sequence.' },
          user_id: { ...ID, description: 'The user adding them (see list_team_data users).' },
          status: { type: 'string', enum: ['active', 'paused'], description: 'Start them active (default) or paused.' },
          auto_unpause_at: DATE_TIME('With status paused: when they start'),
        },
        required: ['sequence_id', 'send_email_from_email_account_id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        if (!args['contact_ids']?.length === !args['label_names']?.length) throw new ToolFailure('Give contact_ids or label_names (one of the two). Nothing was changed.');
        const { sequence_id: id, ...rest } = args;
        const { data } = await ap(h, {
          method: 'POST',
          path: `${BASE}/emailer_campaigns/${id}/add_contact_ids`,
          json: body({ ...rest, emailer_campaign_id: id }),
          write: true,
          errors: { 404: 'Apollo has no sequence with that id', 422: 'Apollo did not add the contacts' },
        });
        const added: unknown[] = Array.isArray(data?.contacts) ? data.contacts : [];
        return compact({
          added: added.map((contact: any) => compact({ id: contact?.id, name: contact?.name, email: contact?.email })),
          skipped_contact_ids: data?.skipped_contact_ids,
          sequence: data?.emailer_campaign ? trimSequence(data.emailer_campaign) : undefined,
        });
      },
    },
    {
      name: 'update_sequence_contacts',
      kind: 'update',
      check: 'get_contact',
      title: 'Stop, finish or remove Apollo sequence contacts',
      description: 'Changes contacts\' status in sequences: stop (halt their progress), mark_as_finished, or remove them from the sequences.',
      inputSchema: {
        type: 'object',
        properties: {
          sequence_ids: IDS('Sequence ids', 50),
          contact_ids: IDS('Contact ids', 100),
          mode: { type: 'string', enum: ['stop', 'mark_as_finished', 'remove'], description: 'stop, mark_as_finished or remove.' },
        },
        required: ['sequence_ids', 'contact_ids', 'mode'],
        additionalProperties: false,
      },
      async run(args: { sequence_ids: string[]; contact_ids: string[]; mode: string }, h) {
        const { data } = await ap(h, {
          method: 'POST',
          path: `${BASE}/emailer_campaigns/remove_or_stop_contact_ids`,
          json: { emailer_campaign_ids: args.sequence_ids, contact_ids: args.contact_ids, mode: args.mode },
          write: true,
          errors: { 422: 'Apollo did not change the contacts' },
        });
        const contacts: unknown[] = Array.isArray(data?.contacts) ? data.contacts : [];
        return compact({ mode: args.mode, contacts: contacts.map((contact: any) => compact({ id: contact?.id, name: contact?.name })), sequences: args.sequence_ids });
      },
    },
    {
      name: 'set_sequence_active',
      kind: 'update',
      check: 'search_sequences',
      title: 'Activate or deactivate an Apollo sequence',
      description: 'Activates a sequence (its contacts start getting its emails; it needs at least one step) or deactivates it (sending stops).',
      inputSchema: {
        type: 'object',
        properties: {
          sequence_id: { ...ID, description: 'The sequence id.' },
          active: { type: 'boolean', description: 'true to activate, false to deactivate.' },
        },
        required: ['sequence_id', 'active'],
        additionalProperties: false,
      },
      async run(args: { sequence_id: string; active: boolean }, h) {
        const { data } = await ap(h, {
          method: 'POST',
          path: `${BASE}/emailer_campaigns/${args.sequence_id}/${args.active ? 'approve' : 'abort'}`,
          write: true,
          errors: { 404: 'Apollo has no sequence with that id', 422: `Apollo could not ${args.active ? 'activate' : 'deactivate'} the sequence` },
        });
        return compact({ id: args.sequence_id, active: data?.emailer_campaign?.active ?? args.active });
      },
    },
    {
      name: 'search_outreach_emails',
      kind: 'read',
      title: 'Search Apollo outreach emails',
      description:
        'Emails sent or scheduled by your sequences: by sequence, status (delivered, opened, clicked, bounced...), reply class (replies are found '
        + 'by reply_classes, not by a status), user, keywords, or a range of the dates they were due or sent. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          sequence_ids: STRINGS('Only emails of these sequences.'),
          statuses: { type: 'array', items: { type: 'string', enum: EMAIL_STATUSES }, uniqueItems: true, description: `Only emails in these statuses: ${EMAIL_STATUSES.join(', ')}.` },
          reply_classes: {
            type: 'array',
            items: { type: 'string', enum: REPLY_CLASSES },
            uniqueItems: true,
            description: `Only emails whose reply Apollo classed as one of these: ${REPLY_CLASSES.join(', ')}. All of them find every reply.`,
          },
          user_ids: STRINGS('Only emails of these users.'),
          q_keywords: { type: 'string', maxLength: 300, description: 'Keywords.' },
          date_after: { ...DATE, description: 'Only emails due or sent (see date_mode) on or after this date, YYYY-MM-DD.' },
          date_before: { ...DATE, description: 'Only emails due or sent (see date_mode) on or before this date, YYYY-MM-DD.' },
          date_mode: { type: 'string', enum: ['completed_at', 'due_at'], default: 'completed_at', description: 'What date_after and date_before apply to: completed_at (default), when the email was sent, or due_at, when it is due.' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const dated = Boolean(args['date_after'] || args['date_before']);
        return paged(h, args['cursor'], {
          key: 'emailer_messages',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            path: `${BASE}/emailer_messages/search`,
            query: query({
              emailer_campaign_ids: args['sequence_ids'],
              emailer_message_stats: args['statuses'],
              emailer_message_reply_classes: args['reply_classes'],
              user_ids: args['user_ids'],
              q_keywords: args['q_keywords'],
              emailer_message_date_range_mode: dated ? args['date_mode'] : undefined,
              emailer_message_date_range: range(args['date_after'], args['date_before']),
              page,
              per_page: perPage,
            }, args['filters']),
            errors: { 403: NO_ACCESS },
          }),
          trim: trimEmailMessage,
        });
      },
    },
    {
      name: 'get_outreach_email_activities',
      kind: 'read',
      title: 'Get an Apollo outreach email\'s activity',
      description: 'The activity of one outreach email: when it was delivered, opened and clicked, and the reply. Free.',
      inputSchema: { type: 'object', properties: { email_id: { ...ID, description: 'The outreach email id (see search_outreach_emails).' } }, required: ['email_id'], additionalProperties: false },
      async run(args: { email_id: string }, h) {
        const { data } = await ap(h, { path: `${BASE}/emailer_messages/${args.email_id}/activities`, errors: { 404: 'Apollo has no outreach email with that id' } });
        return data ?? {};
      },
    },
    {
      name: 'create_deal',
      kind: 'create',
      check: 'search_deals',
      title: 'Create an Apollo deal',
      description: 'Creates a deal (opportunity) with its name, amount, stage (list_team_data deal_stages), owner, account and close date. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 300, description: 'The deal name.' },
          amount: { type: 'number', minimum: 0, description: 'The value, without currency.' },
          opportunity_stage_id: ID,
          owner_id: ID,
          account_id: ID,
          closed_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The expected close date, YYYY-MM-DD.' },
          typed_custom_fields: CUSTOM_FIELDS,
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const { data } = await ap(h, {
          method: 'POST',
          path: `${BASE}/opportunities`,
          json: compact({ ...args, amount: args['amount'] !== undefined ? String(args['amount']) : undefined }),
          write: true,
          errors: { 422: 'Apollo did not accept the deal' },
        });
        return trimDeal(data?.opportunity ?? data);
      },
    },
    {
      name: 'search_deals',
      kind: 'read',
      title: 'Search Apollo deals',
      description: 'Deals by name, accounts, owners, stages, open or closed, amount or close date, sorted as asked. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          q_opportunity_name: { type: 'string', maxLength: 300, description: 'Keywords in the deal or account name.' },
          account_ids: STRINGS('Account ids.'),
          owner_ids: STRINGS('Owner (user) ids.'),
          stage_ids: STRINGS('Deal stage ids.'),
          is_closed: { type: 'boolean', description: 'true for closed deals only, false for open ones.' },
          sort_by_field: { type: 'string', enum: ['amount', 'is_closed', 'is_won'], description: 'Sort by this field.' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'opportunities',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            path: `${BASE}/opportunities/search`,
            query: query({
              q_opportunity_name: args['q_opportunity_name'],
              account_ids: args['account_ids'],
              opportunity_owner_ids: args['owner_ids'],
              opportunity_stage_ids: args['stage_ids'],
              opportunity_is_closed: args['is_closed'],
              sort_by_field: args['sort_by_field'],
              page,
              per_page: perPage,
            }, args['filters']),
            errors: { 403: NO_ACCESS },
          }),
          trim: trimDeal,
        });
      },
    },
    {
      name: 'update_deal',
      kind: 'update',
      check: 'get_deal',
      title: 'Update an Apollo deal',
      description: 'Changes a deal: only the fields given, such as a new stage, amount or close date. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { ...ID, description: 'The deal id.' },
          name: { type: 'string', minLength: 1, maxLength: 300 },
          amount: { type: 'number', minimum: 0 },
          opportunity_stage_id: ID,
          owner_id: ID,
          closed_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD.' },
          typed_custom_fields: CUSTOM_FIELDS,
        },
        required: ['deal_id'],
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        const { deal_id: id, ...fields } = args;
        const changes = compact({ ...fields, amount: fields['amount'] !== undefined ? String(fields['amount']) : undefined });
        if (!Object.keys(changes).length) throw new ToolFailure('Nothing to change: give at least one field. Nothing was changed.');
        const { data } = await ap(h, {
          method: 'PATCH',
          path: `${BASE}/opportunities/${id}`,
          json: changes,
          write: true,
          errors: { 404: 'Apollo has no deal with that id', 422: 'Apollo did not accept the change' },
        });
        return trimDeal(data?.opportunity ?? data);
      },
    },
    {
      name: 'get_deal',
      kind: 'read',
      title: 'Get an Apollo deal',
      description: 'One deal with its amount, stage, owner, account, close date and whether it is closed or won. Free.',
      inputSchema: { type: 'object', properties: { deal_id: { ...ID, description: 'The deal id.' } }, required: ['deal_id'], additionalProperties: false },
      async run(args: { deal_id: string }, h) {
        const { data } = await ap(h, { path: `${BASE}/opportunities/${args.deal_id}`, errors: { 404: 'Apollo has no deal with that id' } });
        return trimDeal(data?.opportunity ?? data);
      },
    },
    {
      name: 'create_tasks',
      kind: 'create',
      check: 'search_tasks',
      title: 'Create Apollo tasks',
      description: `A task for a user about 1 to 100 contacts (one task each): a call, a manual email, a LinkedIn step or an action item, with priority, due time and note. Types: ${TASK_TYPES.join(', ')}. Free.`,
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { ...ID, description: 'The user who does the task (see list_team_data users).' },
          contact_ids: IDS('The contacts the task is about', 100),
          type: { type: 'string', enum: TASK_TYPES, description: 'The kind of task.' },
          status: { type: 'string', enum: ['scheduled', 'completed', 'skipped'], default: 'scheduled', description: 'scheduled (default) for future tasks.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'The priority.' },
          due_at: DATE_TIME('When it is due'),
          title: { type: 'string', maxLength: 300, description: 'A title (one task only); Apollo makes one when left out.' },
          note: { type: 'string', maxLength: 5000, description: 'What to do.' },
        },
        required: ['user_id', 'contact_ids', 'type', 'due_at'],
        additionalProperties: false,
      },
      async run(args: { user_id: string; contact_ids: string[]; type: string; status: string; priority?: string; due_at: string; title?: string; note?: string }, h) {
        const shared = { user_id: args.user_id, type: args.type, status: args.status, priority: args.priority, due_at: args.due_at, note: args.note };
        if (args.contact_ids.length === 1) {
          const { data } = await ap(h, { method: 'POST', path: `${BASE}/tasks`, json: compact({ ...shared, contact_id: args.contact_ids[0], title: args.title }), write: true, errors: { 422: 'Apollo did not accept the task' } });
          return { tasks: [trimTask(data?.task ?? data)] };
        }
        const { data } = await ap(h, { method: 'POST', path: `${BASE}/tasks/bulk_create`, json: compact({ ...shared, contact_ids: args.contact_ids }), write: true, errors: { 422: 'Apollo did not accept the tasks' } });
        return { tasks: (Array.isArray(data?.tasks) ? data.tasks : []).map(trimTask) };
      },
    },
    {
      name: 'search_tasks',
      kind: 'read',
      title: 'Search Apollo tasks',
      description: 'Tasks sorted by due date or priority, with their type, status, contact and note. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          sort_by_field: { type: 'string', enum: ['task_due_at', 'task_priority'], default: 'task_due_at', description: 'task_due_at (default) or task_priority.' },
          sort_ascending: { type: 'boolean', description: 'true for ascending.' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'tasks',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            method: 'POST',
            path: `${BASE}/tasks/search`,
            json: body({ sort_by_field: args['sort_by_field'], sort_ascending: args['sort_ascending'], page, per_page: perPage }, args['filters']),
            safe: true,
            errors: { 403: NO_ACCESS },
          }),
          trim: trimTask,
        });
      },
    },
    {
      name: 'log_call',
      kind: 'create',
      check: 'search_calls',
      title: 'Log a call in Apollo',
      description: 'Records a phone call made outside Apollo against a contact or account: status, duration, numbers, times, purpose and outcome, and a note. Free.',
      inputSchema: {
        type: 'object',
        properties: {
          contact_id: ID,
          account_id: ID,
          user_ids: { type: 'array', items: ID, maxItems: 5, description: 'The users on the call (see list_team_data users).' },
          status: { type: 'string', enum: ['queued', 'ringing', 'in-progress', 'completed', 'no_answer', 'failed', 'busy'], description: 'The call status.' },
          duration: { type: 'integer', minimum: 0, description: 'The length in seconds.' },
          to_number: { type: 'string', maxLength: 50 },
          from_number: { type: 'string', maxLength: 50 },
          start_time: DATE_TIME('When it started'),
          end_time: DATE_TIME('When it ended'),
          phone_call_purpose_id: ID,
          phone_call_outcome_id: ID,
          note: { type: 'string', maxLength: 5000, description: 'A note about the call.' },
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        if (!args['contact_id'] && !args['account_id']) throw new ToolFailure('Give the contact_id or account_id the call was with. Nothing was changed.');
        const { user_ids: users, ...rest } = args;
        const { data } = await ap(h, {
          method: 'POST',
          path: `${BASE}/phone_calls`,
          json: compact({ ...rest, user_id: users, logged: true }),
          write: true,
          errors: { 422: 'Apollo did not accept the call' },
        });
        return trimCall(data?.phone_call ?? data);
      },
    },
    {
      name: 'search_calls',
      kind: 'read',
      title: 'Search Apollo calls',
      description: 'Calls made or received, by date range, duration, direction, users, purposes, outcomes or keywords. Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          date_after: DATE_TIME('Only calls on or after this date'),
          date_before: DATE_TIME('Only calls on or before this date'),
          inbound: { type: 'string', enum: ['incoming', 'outgoing'], description: 'incoming or outgoing calls.' },
          user_ids: STRINGS('Only calls of these users.'),
          q_keywords: { type: 'string', maxLength: 300, description: 'Keywords.' },
          filters: FILTERS,
          per_page: PER_PAGE(),
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: Record<string, any>, h) {
        return paged(h, args['cursor'], {
          key: 'phone_calls',
          perPage: args['per_page'],
          request: (page, perPage) => ({
            path: `${BASE}/phone_calls/search`,
            query: query({
              date_range: range(args['date_after'], args['date_before']),
              inbound: args['inbound'],
              user_ids: args['user_ids'],
              q_keywords: args['q_keywords'],
              page,
              per_page: perPage,
            }, args['filters']),
            errors: { 403: NO_ACCESS },
          }),
          trim: trimCall,
        });
      },
    },
    {
      name: 'list_team_data',
      kind: 'read',
      title: 'List Apollo team settings',
      description:
        'The ids other tools take: users (owner_id, user_id), email_accounts (to send sequences from), contact_stages, account_stages, deal_stages, '
        + 'lists (labels) and custom_fields (typed_custom_fields). Free. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: Object.keys(LIST_KINDS), description: 'What to list.' },
          cursor: CURSOR,
        },
        required: ['kind'],
        additionalProperties: false,
      },
      async run(args: { kind: string; cursor?: string }, h) {
        const kind = LIST_KINDS[args.kind]!;
        if (kind.paged) {
          return paged(h, args.cursor, {
            key: kind.field,
            perPage: 100,
            request: (page, perPage) => ({ path: kind.path, query: { page, per_page: perPage }, errors: { 403: NO_ACCESS } }),
            trim: kind.trim,
          });
        }
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const { data } = await ap(h, { path: kind.path });
        const items: unknown[] = Array.isArray(data?.[kind.field]) ? data[kind.field] : Array.isArray(data) ? data : [];
        return h.page({ key: kind.field, items: items.map(kind.trim).slice(skip), resumeAt: (index) => h.makeCursor({ s: skip + index }) });
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Apollo REST API v1 at https://api.apollo.io/api/v1, with the connected key (the master key when there is one): paths start with /api/v1/, '
        + 'such as /api/v1/contacts/{id}/opportunities, /api/v1/contacts/update_stages, /api/v1/accounts/bulk_update, /api/v1/labels, /api/v1/notes, '
        + '/api/v1/tasks/{id}/complete or /api/v1/emailer_messages/{id}/send_now. Reference: https://docs.apollo.io/reference.',
      basePath: '/api/v1/',
    }),
  ],
});

export = connector;
