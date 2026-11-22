// HubSpot, through the HubSpot APIs at https://api.hubapi.com (https://developers.hubspot.com/docs/api-reference).
//
// Credentials: `access_token`, the token of a HubSpot sign-in (an OAuth app's,
// passed and refreshed by the host), and optionally `portalid`, the HubSpot
// account (portal) the sign-in was made for. The token goes as a Bearer token
// to https://api.hubapi.com only. The tools cover CRM records of every type
// (contacts, companies, deals, tickets, products, engagements such as notes,
// calls, tasks, meetings and emails, and custom objects): list, get, search,
// create with associations, update and delete; properties, pipelines and
// owners; associations; lists (segments) and their members; marketing emails
// and single sends; and files. api_get and api_request reach the rest.

import { apiTools, defineConnector, OutcomeUnknown, ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import { withScopeAdvice } from './scopes.js';
import { compact, multipart, nameFromUrl, trimEmail, trimFile, trimProperty, trimRecord, typeFromName } from './shape.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'HubSpot';

const OBJECT_TYPE: JsonSchema = {
  type: 'string',
  pattern: '^([a-z][a-z0-9_]{1,62}|\\d+-\\d+|p\\d+_[A-Za-z0-9_]+)$',
  description:
    'The record type: contacts, companies, deals, tickets, products, line_items, quotes, leads, notes, calls, tasks, meetings, emails, '
    + 'or a custom object (its id such as 2-1234567, or p1234567_cars).',
};
const RECORD_ID: JsonSchema = { type: 'string', minLength: 1, maxLength: 320, description: 'The record id (or the value of id_property).' };
const RECORD_IDS = (what: string, max: number): JsonSchema => ({
  type: 'array',
  items: { type: 'string', pattern: '^\\d{1,20}$' },
  minItems: 1,
  maxItems: max,
  uniqueItems: true,
  description: `${what}, up to ${max}.`,
});
const PROPERTY_NAMES: JsonSchema = {
  type: 'array',
  items: { type: 'string', pattern: '^[A-Za-z0-9_]{1,100}$' },
  maxItems: 100,
  uniqueItems: true,
  description: 'The properties to return, e.g. ["email", "firstname", "lifecyclestage"] (HubSpot\'s defaults when left out; list_properties names them all).',
};
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result; pass the other arguments unchanged.' };
const EMAIL: JsonSchema = { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+$', description: 'An email address.' };
const CATEGORY: JsonSchema = {
  type: 'string',
  enum: ['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED'],
  default: 'HUBSPOT_DEFINED',
  description: 'The association type\'s category: HUBSPOT_DEFINED (default) or USER_DEFINED for your own labels.',
};
const SEARCH_OPERATORS = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'];

function recordPath(objectType: string, id?: string): string {
  return `/crm/v3/objects/${encodeURIComponent(objectType)}${id !== undefined ? `/${encodeURIComponent(id)}` : ''}`;
}

/** The `after` of a HubSpot paging object. */
function after(data: any): string | undefined {
  const next = data?.paging?.next?.after;
  return typeof next === 'string' && next ? next : typeof next === 'number' ? String(next) : undefined;
}

interface AfterPage {
  key: string;
  items: unknown[];
  extra?: Record<string, unknown>;
  /** The `after` this page was read with (undefined for the first page). */
  current?: string;
  next?: string;
  size: number;
}

/** A page of a list that HubSpot pages with `after`: cut at 32 KB, it resumes inside the same page. */
function afterPage(h: ToolHelpers, skip: number, page: AfterPage): Record<string, unknown> {
  return h.page({
    key: page.key,
    items: page.items.slice(skip),
    ...(page.extra ? { extra: page.extra } : {}),
    resumeAt: (index) => h.makeCursor({ ...(page.current ? { a: page.current } : {}), n: page.size, s: skip + index }),
    ...(page.next && page.items.length ? { nextPage: h.makeCursor({ a: page.next, n: page.size, s: 0 }) } : {}),
  });
}

function pageState(h: ToolHelpers, cursor: string | undefined, size: number): { after?: string; size: number; skip: number } {
  const state = h.cursor(cursor);
  return {
    after: typeof state?.['a'] === 'string' ? state['a'] : undefined,
    size: typeof state?.['n'] === 'number' ? state['n'] : size,
    skip: typeof state?.['s'] === 'number' ? state['s'] : 0,
  };
}

interface AssociationInput {
  to_object_type: string;
  to_id: string;
  type_id?: number;
  category?: string;
}

/** HubSpot's default (unlabeled) association type from one object type to another, for associations given without a type. */
async function defaultTypeId(h: ToolHelpers, from: string, to: string): Promise<{ category: string; typeId: number }> {
  const { data } = await h.api({ path: `/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels` });
  const types: any[] = Array.isArray(data?.results) ? data.results : [];
  const unlabeled = types.find((type) => type?.category === 'HUBSPOT_DEFINED' && !type?.label) ?? types.find((type) => type?.category === 'HUBSPOT_DEFINED');
  if (typeof unlabeled?.typeId !== 'number') {
    throw new ToolFailure(`HubSpot has no default association from ${from} to ${to}: give a type_id (see the labels at /crm/v4/associations/${from}/${to}/labels). Nothing was changed.`);
  }
  return { category: 'HUBSPOT_DEFINED', typeId: unlabeled.typeId };
}

const SINGLE_SEND_PATHS = {
  transactional: '/marketing/v3/transactional/single-email/send',
  marketing: '/marketing/v4/email/single-send',
} as const;

const MARKETING_EMAIL_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 500, description: 'The internal name.' },
  subject: { type: 'string', minLength: 1, maxLength: 500, description: 'The subject line.' },
  from_name: { type: 'string', maxLength: 200, description: 'The From name.' },
  reply_to: EMAIL,
  template_path: { type: 'string', maxLength: 500, description: 'The template, e.g. @hubspot/email/dnd/welcome.html.' },
  include_lists: { type: 'array', items: { type: 'string', pattern: '^\\d{1,20}$' }, maxItems: 100, uniqueItems: true, description: 'List ids to send to (see search_lists).' },
  exclude_lists: { type: 'array', items: { type: 'string', pattern: '^\\d{1,20}$' }, maxItems: 100, uniqueItems: true, description: 'List ids to leave out.' },
  subscription_id: { type: 'integer', minimum: 1, description: 'The subscription type the email belongs to (unsubscribes apply to it).' },
  content: { type: 'object', description: 'HubSpot email content: plainTextVersion, widgets, flexAreas and the other content fields of the template.' },
  language: { type: 'string', maxLength: 20, description: 'The email language, e.g. en.' },
  campaign: { type: 'string', maxLength: 100, description: 'A marketing campaign id to attach it to.' },
  business_unit_id: { type: 'integer', minimum: 0, description: 'The brand (business unit), for accounts with brands.' },
};

interface MarketingEmailArgs {
  name?: string;
  subject?: string;
  from_name?: string;
  reply_to?: string;
  template_path?: string;
  include_lists?: string[];
  exclude_lists?: string[];
  subscription_id?: number;
  content?: Record<string, unknown>;
  language?: string;
  campaign?: string;
  business_unit_id?: number;
}

function marketingEmailBody(args: MarketingEmailArgs): Record<string, unknown> {
  const from = compact({ fromName: args.from_name, replyTo: args.reply_to });
  const lists = compact({ include: args.include_lists, exclude: args.exclude_lists });
  return compact({
    name: args.name,
    subject: args.subject,
    templatePath: args.template_path,
    from: Object.keys(from).length ? from : undefined,
    to: Object.keys(lists).length ? { contactIlsLists: lists } : undefined,
    subscriptionDetails: args.subscription_id !== undefined ? { subscriptionId: args.subscription_id } : undefined,
    content: args.content,
    language: args.language,
    campaign: args.campaign,
    businessUnitId: args.business_unit_id,
  });
}

/** The ids a membership call changed, under either of HubSpot's spellings. */
function membership(data: any): Record<string, unknown> {
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);
  return compact({
    added: list(data?.recordIdsAdded ?? data?.recordsIdsAdded),
    removed: list(data?.recordIdsRemoved),
    missing: list(data?.recordIdsMissing),
  });
}

/**
 * A path as a server that decodes percent-escapes routes it: the decoded segments split again at "/" and "\",
 * each cut at ";" (a path parameter), lower-cased, with empty and "." parts dropped and ".." resolved. The guard
 * decides on these parts, so an escape (%6Fauth, crm%2F..%2Foauth) or a capital letter cannot get past it.
 */
function routedParts(segments: readonly string[]): string[] {
  const parts: string[] = [];
  for (const piece of segments.join('/').split(/[\\/]/)) {
    const part = (piece.split(';')[0] ?? '').toLowerCase();
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts;
}

const connector = defineConnector({
  vendor: 'hubspot',
  label: LABEL,
  origins: ['https://api.hubapi.com'],
  credentials: ['access_token', 'portalid'],
  requiredCredentials: [['access_token']],
  credentialLabels: { access_token: 'HubSpot access token', portalid: 'HubSpot portal ID' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  // A refusal for a scope the sign-in did not grant names the scopes the call needs (scopes.ts).
  tools: withScopeAdvice([
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get the HubSpot account',
      description: 'The connected HubSpot account: portal ID, account type, time zone, currencies, data hosting location and its app domain. A quick connection check.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/account-info/v3/details' });
        const expected = h.credentials['portalid'];
        const portalId = data?.portalId !== undefined ? String(data.portalId) : undefined;
        return compact({
          portalId: data?.portalId,
          accountType: data?.accountType,
          timeZone: data?.timeZone,
          companyCurrency: data?.companyCurrency,
          additionalCurrencies: Array.isArray(data?.additionalCurrencies) && data.additionalCurrencies.length ? data.additionalCurrencies : undefined,
          dataHostingLocation: data?.dataHostingLocation,
          uiDomain: data?.uiDomain,
          warning: expected && portalId && expected !== portalId
            ? `The token belongs to HubSpot portal ${portalId}, not to portal ${expected} this connection was made for.`
            : undefined,
        });
      },
    },
    {
      name: 'list_objects',
      kind: 'read',
      title: 'List HubSpot records',
      description:
        'Records of one type (contacts, companies, deals, tickets, notes, tasks, custom objects...), oldest id first, with the properties asked for '
        + 'and, with associations, the ids of associated records. For filters and sorting use search_objects. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          properties: PROPERTY_NAMES,
          associations: { type: 'array', items: OBJECT_TYPE, maxItems: 10, uniqueItems: true, description: 'Types whose associated record ids to include, e.g. ["companies", "deals"].' },
          archived: { type: 'boolean', default: false, description: 'true to list archived (deleted) records instead.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Records per page, 1 to 100 (default 20).' },
          cursor: CURSOR,
        },
        required: ['object_type'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; properties?: string[]; associations?: string[]; archived: boolean; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          path: recordPath(args.object_type),
          query: {
            limit: state.size,
            after: state.after,
            properties: args.properties?.length ? args.properties.join(',') : undefined,
            associations: args.associations?.length ? args.associations.join(',') : undefined,
            archived: args.archived || undefined,
          },
        });
        const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, { key: 'results', items: results.map(trimRecord), current: state.after, next: after(data), size: state.size });
      },
    },
    {
      name: 'get_object',
      kind: 'read',
      title: 'Get a HubSpot record',
      description:
        'One record by id, or by a unique property with id_property (a contact by email: id_property "email"), with the properties asked for, '
        + 'associated record ids, and optionally the history of some properties.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          id: RECORD_ID,
          id_property: { type: 'string', pattern: '^[A-Za-z0-9_]{1,100}$', description: 'A unique property to find the record by instead of its id, e.g. email or domain.' },
          properties: PROPERTY_NAMES,
          properties_with_history: { ...PROPERTY_NAMES, maxItems: 10, description: 'Properties to return with their past values, e.g. ["lifecyclestage"].' },
          associations: { type: 'array', items: OBJECT_TYPE, maxItems: 10, uniqueItems: true, description: 'Types whose associated record ids to include.' },
        },
        required: ['object_type', 'id'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; id: string; id_property?: string; properties?: string[]; properties_with_history?: string[]; associations?: string[] }, h) {
        const { data } = await h.api({
          path: recordPath(args.object_type, args.id),
          query: {
            idProperty: args.id_property,
            properties: args.properties?.length ? args.properties.join(',') : undefined,
            propertiesWithHistory: args.properties_with_history?.length ? args.properties_with_history.join(',') : undefined,
            associations: args.associations?.length ? args.associations.join(',') : undefined,
          },
          errors: { 404: `HubSpot has no ${args.object_type} record with that id` },
        });
        return trimRecord(data);
      },
    },
    {
      name: 'search_objects',
      kind: 'read',
      title: 'Search HubSpot records',
      description:
        'Finds records of one type with filters (filters in a group must all match; any group may match: up to 5 groups, 6 filters each, 18 in all), '
        + 'a text query over the default searchable properties, and sorting. Operators: EQ, NEQ, LT, LTE, GT, GTE, BETWEEN (value, highValue), IN and '
        + 'NOT_IN (values), HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN (wildcards like *@example.com). Dates are epoch milliseconds or ISO. '
        + 'Returns the total; at most 10,000 results can be paged.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          filter_groups: {
            type: 'array',
            maxItems: 5,
            description: 'e.g. [{"filters": [{"propertyName": "lifecyclestage", "operator": "EQ", "value": "customer"}]}].',
            items: {
              type: 'object',
              properties: {
                filters: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 6,
                  items: {
                    type: 'object',
                    properties: {
                      propertyName: { type: 'string', minLength: 1, maxLength: 100 },
                      operator: { type: 'string', enum: SEARCH_OPERATORS },
                      value: { description: 'The value to compare with (text, number or boolean).' },
                      highValue: { description: 'The upper bound for BETWEEN.' },
                      values: { type: 'array', maxItems: 100, description: 'The values for IN and NOT_IN.' },
                    },
                    required: ['propertyName', 'operator'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['filters'],
              additionalProperties: false,
            },
          },
          query: { type: 'string', minLength: 1, maxLength: 3000, description: 'Text to look for in the default searchable properties (name, email, domain, phone...).' },
          sorts: {
            type: 'array',
            maxItems: 1,
            description: 'One sort, e.g. [{"propertyName": "createdate", "direction": "DESCENDING"}].',
            items: {
              type: 'object',
              properties: {
                propertyName: { type: 'string', minLength: 1, maxLength: 100 },
                direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'] },
              },
              required: ['propertyName'],
              additionalProperties: false,
            },
          },
          properties: PROPERTY_NAMES,
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Records per page, 1 to 200 (default 20).' },
          cursor: CURSOR,
        },
        required: ['object_type'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; filter_groups?: unknown[]; query?: string; sorts?: unknown[]; properties?: string[]; limit: number; cursor?: string }, h) {
        const filters = (args.filter_groups ?? []).reduce<number>((sum, group: any) => sum + (Array.isArray(group?.filters) ? group.filters.length : 0), 0);
        if (filters > 18) throw new ToolFailure('HubSpot takes at most 18 filters in a search. Nothing was sent.');
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          method: 'POST',
          path: `${recordPath(args.object_type)}/search`,
          json: compact({
            filterGroups: args.filter_groups,
            query: args.query,
            sorts: args.sorts,
            properties: args.properties,
            limit: state.size,
            after: state.after,
          }),
          safe: true,
        });
        const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, { key: 'results', items: results.map(trimRecord), extra: { total: data?.total }, current: state.after, next: after(data), size: state.size });
      },
    },
    {
      name: 'create_object',
      kind: 'create',
      check: 'search_objects',
      title: 'Create a HubSpot record',
      description:
        'Creates a record with its properties and, optionally, associations to other records. Contacts need email or a name; companies name or domain; '
        + 'deals dealname, pipeline and dealstage (see list_pipelines). Engagements are records too: notes (hs_note_body), tasks (hs_task_subject, '
        + 'hs_task_status, hs_task_priority), calls (hs_call_title, hs_call_body), meetings (hs_meeting_title, hs_meeting_start_time) and emails, '
        + 'each with hs_timestamp (ISO or epoch ms) and associated to their contact, company or deal. Without type_id an association uses HubSpot\'s default type.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          properties: { type: 'object', description: 'Property values by internal name, e.g. {"email": "ann@example.com", "firstname": "Ann"}.' },
          associations: {
            type: 'array',
            maxItems: 50,
            description: 'Records to associate, e.g. [{"to_object_type": "contacts", "to_id": "501"}].',
            items: {
              type: 'object',
              properties: {
                to_object_type: OBJECT_TYPE,
                to_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The other record\'s id.' },
                type_id: { type: 'integer', minimum: 1, description: 'The association type id (HubSpot\'s default when left out).' },
                category: CATEGORY,
              },
              required: ['to_object_type', 'to_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['object_type', 'properties'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; properties: Record<string, unknown>; associations?: AssociationInput[] }, h) {
        const defaults = new Map<string, { category: string; typeId: number }>();
        const associations: Record<string, unknown>[] = [];
        for (const association of args.associations ?? []) {
          let type = association.type_id !== undefined ? { category: association.category ?? 'HUBSPOT_DEFINED', typeId: association.type_id } : defaults.get(association.to_object_type);
          if (!type) {
            type = await defaultTypeId(h, args.object_type, association.to_object_type);
            defaults.set(association.to_object_type, type);
          }
          associations.push({ to: { id: association.to_id }, types: [{ associationCategory: type.category, associationTypeId: type.typeId }] });
        }
        const { data } = await h.api({
          method: 'POST',
          path: recordPath(args.object_type),
          json: compact({ properties: args.properties, associations: associations.length ? associations : undefined }),
          write: true,
          errors: { 409: 'HubSpot already has a record with that unique value (for a contact, that email)', 400: 'HubSpot did not accept the record' },
        });
        return trimRecord(data);
      },
    },
    {
      name: 'update_object',
      kind: 'update',
      check: 'get_object',
      title: 'Update a HubSpot record',
      description:
        'Changes properties of one record, by id or by a unique property (id_property, e.g. email): only the properties given. An empty string clears '
        + 'a value. Assign an owner with hubspot_owner_id (see list_owners); move a deal with dealstage.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          id: RECORD_ID,
          id_property: { type: 'string', pattern: '^[A-Za-z0-9_]{1,100}$', description: 'A unique property to find the record by instead of its id.' },
          properties: { type: 'object', description: 'The property values to set, e.g. {"lifecyclestage": "customer"}.' },
        },
        required: ['object_type', 'id', 'properties'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; id: string; id_property?: string; properties: Record<string, unknown> }, h) {
        if (!Object.keys(args.properties).length) throw new ToolFailure('Nothing to change: properties is empty. Nothing was changed.');
        const { data } = await h.api({
          method: 'PATCH',
          path: recordPath(args.object_type, args.id),
          query: { idProperty: args.id_property },
          json: { properties: args.properties },
          write: true,
          errors: { 404: `HubSpot has no ${args.object_type} record with that id`, 400: 'HubSpot did not accept the change' },
        });
        return trimRecord(data);
      },
    },
    {
      name: 'delete_object',
      kind: 'delete',
      check: 'get_object',
      title: 'Delete a HubSpot record',
      description: 'Deletes (archives) one record. HubSpot keeps deleted contacts, companies, deals and tickets in its recycling bin for 90 days, where they can be restored.',
      inputSchema: {
        type: 'object',
        properties: { object_type: OBJECT_TYPE, id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The record id.' } },
        required: ['object_type', 'id'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; id: string }, h) {
        await h.api({ method: 'DELETE', path: recordPath(args.object_type, args.id), write: true, errors: { 404: `HubSpot has no ${args.object_type} record with that id` } });
        return { deleted: true, object_type: args.object_type, id: args.id };
      },
    },
    {
      name: 'list_properties',
      kind: 'read',
      title: 'List HubSpot properties',
      description: 'The properties of a record type with their internal names, labels, types, groups and the options of dropdowns, to know what to read, filter on and set. filter narrows them by name or label.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          filter: { type: 'string', minLength: 1, maxLength: 100, description: 'Only properties whose name or label contains this text.' },
          cursor: CURSOR,
        },
        required: ['object_type'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; filter?: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const { data } = await h.api({ path: `/crm/v3/properties/${encodeURIComponent(args.object_type)}` });
        const needle = args.filter?.toLowerCase();
        const properties: any[] = (Array.isArray(data?.results) ? data.results : [])
          .filter((property: any) => !needle || String(property?.name).toLowerCase().includes(needle) || String(property?.label).toLowerCase().includes(needle));
        return h.page({
          key: 'properties',
          items: properties.map(trimProperty).slice(skip),
          extra: { total: properties.length },
          resumeAt: (index) => h.makeCursor({ s: skip + index }),
        });
      },
    },
    {
      name: 'list_pipelines',
      kind: 'read',
      title: 'List HubSpot pipelines',
      description: 'The pipelines of deals, tickets or another record type, with their stages: ids (what dealstage and pipeline take), labels, order, and whether a stage is closed and its probability.',
      inputSchema: {
        type: 'object',
        properties: { object_type: { ...OBJECT_TYPE, default: 'deals', description: 'deals (default), tickets, or another type with pipelines.' } },
        additionalProperties: false,
      },
      async run(args: { object_type: string }, h) {
        const { data } = await h.api({ path: `/crm/v3/pipelines/${encodeURIComponent(args.object_type)}` });
        const pipelines: any[] = Array.isArray(data?.results) ? data.results : [];
        return {
          pipelines: pipelines.map((pipeline) => compact({
            id: pipeline?.id,
            label: pipeline?.label,
            displayOrder: pipeline?.displayOrder,
            archived: pipeline?.archived === true ? true : undefined,
            stages: (Array.isArray(pipeline?.stages) ? pipeline.stages : []).map((stage: any) => compact({
              id: stage?.id,
              label: stage?.label,
              displayOrder: stage?.displayOrder,
              isClosed: stage?.metadata?.isClosed === undefined ? undefined : String(stage.metadata.isClosed) === 'true',
              probability: stage?.metadata?.probability,
              ticketState: stage?.metadata?.ticketState,
            })),
          })),
        };
      },
    },
    {
      name: 'list_owners',
      kind: 'read',
      title: 'List HubSpot owners',
      description: 'The users who can own records, with their owner ids (hubspot_owner_id), names, emails and teams; one by email with email. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          email: EMAIL,
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Owners per page, 1 to 500 (default 100).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { email?: string; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({ path: '/crm/v3/owners', query: { email: args.email, limit: state.size, after: state.after } });
        const owners: any[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, {
          key: 'owners',
          items: owners.map((owner) => compact({
            id: owner?.id,
            email: owner?.email,
            firstName: owner?.firstName,
            lastName: owner?.lastName,
            userId: owner?.userId,
            archived: owner?.archived === true ? true : undefined,
            teams: Array.isArray(owner?.teams) && owner.teams.length ? owner.teams.map((team: any) => compact({ id: team?.id, name: team?.name, primary: team?.primary })) : undefined,
          })),
          current: state.after,
          next: after(data),
          size: state.size,
        });
      },
    },
    {
      name: 'list_associations',
      kind: 'read',
      title: 'List a HubSpot record\'s associations',
      description: 'The records of one type associated with a record (a contact\'s companies, a deal\'s contacts, a company\'s notes...), with each association\'s type ids and labels. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: OBJECT_TYPE,
          id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The record id.' },
          to_object_type: OBJECT_TYPE,
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Associations per page, 1 to 500 (default 100).' },
          cursor: CURSOR,
        },
        required: ['object_type', 'id', 'to_object_type'],
        additionalProperties: false,
      },
      async run(args: { object_type: string; id: string; to_object_type: string; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          path: `/crm/v4/objects/${encodeURIComponent(args.object_type)}/${args.id}/associations/${encodeURIComponent(args.to_object_type)}`,
          query: { limit: state.size, after: state.after },
          errors: { 404: `HubSpot has no ${args.object_type} record with that id` },
        });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, {
          key: 'associations',
          items: results.map((item) => ({
            toObjectId: String(item?.toObjectId),
            types: (Array.isArray(item?.associationTypes) ? item.associationTypes : []).map((type: any) => compact({ category: type?.category, typeId: type?.typeId, label: type?.label })),
          })),
          current: state.after,
          next: after(data),
          size: state.size,
        });
      },
    },
    {
      name: 'create_associations',
      kind: 'create',
      check: 'list_associations',
      title: 'Associate HubSpot records',
      description:
        'Associates records of one type with records of another, up to 100 pairs: with HubSpot\'s default type, or with a given type_id (a label). '
        + 'Associating records that already are associated changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          from_object_type: OBJECT_TYPE,
          to_object_type: OBJECT_TYPE,
          pairs: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            description: 'The records to associate, e.g. [{"from_id": "501", "to_id": "201"}].',
            items: {
              type: 'object',
              properties: { from_id: { type: 'string', pattern: '^\\d{1,20}$' }, to_id: { type: 'string', pattern: '^\\d{1,20}$' } },
              required: ['from_id', 'to_id'],
              additionalProperties: false,
            },
          },
          type_id: { type: 'integer', minimum: 1, description: 'The association type id (a label); HubSpot\'s default when left out.' },
          category: CATEGORY,
        },
        required: ['from_object_type', 'to_object_type', 'pairs'],
        additionalProperties: false,
      },
      async run(args: { from_object_type: string; to_object_type: string; pairs: { from_id: string; to_id: string }[]; type_id?: number; category: string }, h) {
        const base = `/crm/v4/associations/${encodeURIComponent(args.from_object_type)}/${encodeURIComponent(args.to_object_type)}/batch`;
        const inputs = args.pairs.map((pair) => ({
          from: { id: pair.from_id },
          to: { id: pair.to_id },
          ...(args.type_id !== undefined ? { types: [{ associationCategory: args.category, associationTypeId: args.type_id }] } : {}),
        }));
        const { data } = await h.api({
          method: 'POST',
          path: args.type_id !== undefined ? `${base}/create` : `${base}/associate/default`,
          json: { inputs },
          write: true,
          errors: { 400: 'HubSpot did not accept the associations' },
        });
        const errors: any[] = Array.isArray(data?.errors) ? data.errors : [];
        return compact({
          status: data?.status,
          associated: Array.isArray(data?.results) ? data.results.length : undefined,
          errors: errors.length ? errors.map((error) => compact({ message: error?.message, category: error?.category })) : undefined,
        });
      },
    },
    {
      name: 'remove_associations',
      kind: 'delete',
      check: 'list_associations',
      title: 'Remove HubSpot associations',
      description:
        'Removes associations between records, up to 100 pairs: every association between each pair, or with type_id only that type (label), '
        + 'keeping the others. The records themselves stay.',
      inputSchema: {
        type: 'object',
        properties: {
          from_object_type: OBJECT_TYPE,
          to_object_type: OBJECT_TYPE,
          pairs: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            description: 'The associated records, e.g. [{"from_id": "501", "to_id": "201"}].',
            items: {
              type: 'object',
              properties: { from_id: { type: 'string', pattern: '^\\d{1,20}$' }, to_id: { type: 'string', pattern: '^\\d{1,20}$' } },
              required: ['from_id', 'to_id'],
              additionalProperties: false,
            },
          },
          type_id: { type: 'integer', minimum: 1, description: 'Only remove this association type (label).' },
          category: CATEGORY,
        },
        required: ['from_object_type', 'to_object_type', 'pairs'],
        additionalProperties: false,
      },
      async run(args: { from_object_type: string; to_object_type: string; pairs: { from_id: string; to_id: string }[]; type_id?: number; category: string }, h) {
        const base = `/crm/v4/associations/${encodeURIComponent(args.from_object_type)}/${encodeURIComponent(args.to_object_type)}/batch`;
        const inputs = args.type_id !== undefined
          ? args.pairs.map((pair) => ({ from: { id: pair.from_id }, to: { id: pair.to_id }, types: [{ associationCategory: args.category, associationTypeId: args.type_id }] }))
          : args.pairs.map((pair) => ({ from: { id: pair.from_id }, to: [{ id: pair.to_id }] }));
        await h.api({
          method: 'POST',
          path: args.type_id !== undefined ? `${base}/labels/archive` : `${base}/archive`,
          json: { inputs },
          write: true,
          errors: { 400: 'HubSpot did not accept the removal' },
        });
        return { removed: args.pairs.length, from_object_type: args.from_object_type, to_object_type: args.to_object_type };
      },
    },
    {
      name: 'search_lists',
      kind: 'read',
      title: 'Search HubSpot lists',
      description: 'Lists (segments) by name, or all of them, with their ids, record type, processing type (MANUAL and SNAPSHOT lists take added members, DYNAMIC ones follow filters) and size. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200, description: 'Text in the list name; all lists when left out.' },
          processing_types: { type: 'array', items: { type: 'string', enum: ['MANUAL', 'DYNAMIC', 'SNAPSHOT'] }, maxItems: 3, uniqueItems: true, description: 'Only lists of these processing types.' },
          count: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Lists per page, 1 to 500 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { query?: string; processing_types?: string[]; count: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const offset = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const count = typeof state?.['n'] === 'number' ? state['n'] : args.count;
        const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const { data } = await h.api({
          method: 'POST',
          path: '/crm/v3/lists/search',
          json: compact({ query: args.query ?? '', processingTypes: args.processing_types, count, offset, additionalProperties: [] }),
          safe: true,
        });
        const lists: any[] = Array.isArray(data?.lists) ? data.lists : [];
        const next = typeof data?.offset === 'number' ? data.offset : offset + lists.length;
        return h.page({
          key: 'lists',
          items: lists.map((list) => compact({
            listId: list?.listId,
            name: list?.name,
            objectTypeId: list?.objectTypeId,
            processingType: list?.processingType,
            size: list?.additionalProperties?.hs_list_size !== undefined ? Number(list.additionalProperties.hs_list_size) : undefined,
            folder: list?.additionalProperties?.hs_folder_name,
            createdAt: list?.createdAt,
            updatedAt: list?.updatedAt,
          })).slice(skip),
          extra: { total: data?.total },
          resumeAt: (index) => h.makeCursor({ o: offset, n: count, s: skip + index }),
          ...(data?.hasMore === true && lists.length ? { nextPage: h.makeCursor({ o: next, n: count, s: 0 }) } : {}),
        });
      },
    },
    {
      name: 'list_list_members',
      kind: 'read',
      title: 'List the members of a HubSpot list',
      description:
        'The record ids in a list, in id order, with when each joined. With properties, it also reads those properties of each member (contacts by '
        + 'default; set object_type for a list of companies or deals). Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The list id (see search_lists).' },
          properties: PROPERTY_NAMES,
          object_type: { ...OBJECT_TYPE, default: 'contacts', description: 'The list\'s record type, for properties: contacts (default), companies, deals...' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Members per page, 1 to 100 (default 100).' },
          cursor: CURSOR,
        },
        required: ['list_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; properties?: string[]; object_type: string; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          path: `/crm/v3/lists/${args.list_id}/memberships`,
          query: { limit: state.size, after: state.after },
          errors: { 404: 'HubSpot has no list with that id' },
        });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        let members: Record<string, unknown>[] = results.map((item) => compact({ recordId: String(item?.recordId), membershipTimestamp: item?.membershipTimestamp }));
        if (args.properties?.length && members.length) {
          const read = await h.api({
            method: 'POST',
            path: `${recordPath(args.object_type)}/batch/read`,
            json: { inputs: members.map((member) => ({ id: member['recordId'] })), properties: args.properties },
            safe: true,
          });
          const byId = new Map<string, unknown>((Array.isArray(read.data?.results) ? read.data.results : []).map((record: any) => [String(record?.id), trimRecord(record)['properties']]));
          members = members.map((member) => compact({ ...member, properties: byId.get(String(member['recordId'])) }));
        }
        return afterPage(h, state.skip, { key: 'members', items: members, extra: compact({ total: data?.total }), current: state.after, next: after(data), size: state.size });
      },
    },
    {
      name: 'add_to_list',
      kind: 'update',
      check: 'list_list_members',
      title: 'Add records to a HubSpot list',
      description: 'Adds records to a MANUAL or SNAPSHOT list by id, up to 1,000 at a time. Records already in the list or that do not exist are left out and named.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The list id (see search_lists).' },
          record_ids: RECORD_IDS('Record ids to add', 1000),
        },
        required: ['list_id', 'record_ids'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; record_ids: string[] }, h) {
        const { data } = await h.api({
          method: 'PUT',
          path: `/crm/v3/lists/${args.list_id}/memberships/add`,
          json: args.record_ids,
          write: true,
          errors: { 404: 'HubSpot has no list with that id', 400: 'HubSpot did not add the records (only MANUAL and SNAPSHOT lists take members)' },
        });
        return { listId: args.list_id, ...membership(data) };
      },
    },
    {
      name: 'remove_from_list',
      kind: 'delete',
      check: 'list_list_members',
      title: 'Remove records from a HubSpot list',
      description: 'Removes records from a MANUAL or SNAPSHOT list by id, up to 1,000 at a time. The records themselves stay.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The list id.' },
          record_ids: RECORD_IDS('Record ids to remove', 1000),
        },
        required: ['list_id', 'record_ids'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; record_ids: string[] }, h) {
        const { data } = await h.api({
          method: 'PUT',
          path: `/crm/v3/lists/${args.list_id}/memberships/remove`,
          json: args.record_ids,
          write: true,
          errors: { 404: 'HubSpot has no list with that id', 400: 'HubSpot did not remove the records' },
        });
        return { listId: args.list_id, ...membership(data) };
      },
    },
    {
      name: 'list_marketing_emails',
      kind: 'read',
      title: 'List HubSpot marketing emails',
      description: 'Marketing emails with their ids, names, subjects, state (draft, scheduled, published...), type and dates; with include_stats their sends, opens, clicks and bounces. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          is_published: { type: 'boolean', description: 'true for published or sent emails only, false for drafts only.' },
          type: { type: 'string', enum: ['BATCH_EMAIL', 'AUTOMATED_EMAIL', 'AB_EMAIL', 'RSS_EMAIL', 'LOCALTIME_EMAIL', 'SINGLE_SEND_API'], description: 'Only emails of this type.' },
          include_stats: { type: 'boolean', default: false, description: 'true to include each email\'s statistics.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Emails per page, 1 to 100 (default 20).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { is_published?: boolean; type?: string; include_stats: boolean; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          path: '/marketing/v3/emails',
          query: { limit: state.size, after: state.after, isPublished: args.is_published, type: args.type, includeStats: args.include_stats || undefined, sort: '-updatedAt' },
        });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, { key: 'emails', items: results.map((email) => trimEmail(email)), extra: compact({ total: data?.total }), current: state.after, next: after(data), size: state.size });
      },
    },
    {
      name: 'get_marketing_email',
      kind: 'read',
      title: 'Get a HubSpot marketing email',
      description: 'One marketing email with its settings, recipients lists, subscription, state, publish date and statistics; include_content adds its content (widgets, plain text).',
      inputSchema: {
        type: 'object',
        properties: {
          email_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The marketing email id.' },
          include_content: { type: 'boolean', default: false, description: 'true to include the content (cut at 16,000 characters).' },
        },
        required: ['email_id'],
        additionalProperties: false,
      },
      async run(args: { email_id: string; include_content: boolean }, h) {
        const { data } = await h.api({ path: `/marketing/v3/emails/${args.email_id}`, query: { includeStats: true }, errors: { 404: 'HubSpot has no marketing email with that id' } });
        return trimEmail(data, { content: args.include_content });
      },
    },
    {
      name: 'create_marketing_email',
      kind: 'create',
      check: 'list_marketing_emails',
      title: 'Create a HubSpot marketing email',
      description:
        'Creates a marketing email as a draft: name, subject, From name and reply-to, template, recipient lists, subscription type and content. '
        + 'Nothing is sent: publish_marketing_email sends it.',
      inputSchema: { type: 'object', properties: MARKETING_EMAIL_FIELDS, required: ['name'], additionalProperties: false },
      async run(args: MarketingEmailArgs, h) {
        const { data } = await h.api({ method: 'POST', path: '/marketing/v3/emails', json: marketingEmailBody(args), write: true, errors: { 400: 'HubSpot did not accept the email' } });
        return trimEmail(data);
      },
    },
    {
      name: 'update_marketing_email',
      kind: 'update',
      check: 'get_marketing_email',
      title: 'Update a HubSpot marketing email',
      description: 'Changes a marketing email: only the fields given. Changing a published email changes what it sends next.',
      inputSchema: {
        type: 'object',
        properties: { email_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The marketing email id.' }, ...MARKETING_EMAIL_FIELDS },
        required: ['email_id'],
        additionalProperties: false,
      },
      async run(args: MarketingEmailArgs & { email_id: string }, h) {
        const body = marketingEmailBody(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one field. Nothing was changed.');
        const { data } = await h.api({
          method: 'PATCH',
          path: `/marketing/v3/emails/${args.email_id}`,
          json: body,
          write: true,
          errors: { 404: 'HubSpot has no marketing email with that id', 400: 'HubSpot did not accept the change' },
        });
        return trimEmail(data);
      },
    },
    {
      name: 'publish_marketing_email',
      kind: 'create',
      check: 'get_marketing_email',
      title: 'Publish or send a HubSpot marketing email',
      description:
        'Sends a regular marketing email to its lists (or schedules it for its publish date), or turns on an automated one. It cannot be undone once '
        + 'sending starts. Needs Marketing Hub Enterprise or the transactional email add-on.',
      inputSchema: {
        type: 'object',
        properties: { email_id: { type: 'string', pattern: '^\\d{1,20}$', description: 'The marketing email id.' } },
        required: ['email_id'],
        additionalProperties: false,
      },
      async run(args: { email_id: string }, h) {
        await h.api({
          method: 'POST',
          path: `/marketing/v3/emails/${args.email_id}/publish`,
          write: true,
          errors: {
            404: 'HubSpot has no marketing email with that id',
            403: 'HubSpot refused to publish it (publishing needs Marketing Hub Enterprise or the transactional email add-on)',
            400: 'HubSpot did not publish the email',
          },
        });
        return { published: true, email_id: args.email_id, note: 'get_marketing_email shows its state and statistics.' };
      },
    },
    {
      name: 'send_single_email',
      kind: 'create',
      check: 'get_send_status',
      title: 'Send a HubSpot email to one person',
      description:
        'Sends one published email to one address: a transactional email (type transactional, the transactional email add-on) or a marketing '
        + 'email (type marketing, Marketing Hub Enterprise). contact_properties fill {{ contact.NAME }} and custom_properties {{ custom.NAME }}. '
        + 'HubSpot sends at most one email per send_id, so a retry with the same send_id never sends twice. Returns the status id.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['transactional', 'marketing'], default: 'transactional', description: 'transactional (default) or marketing.' },
          email_id: { type: 'integer', minimum: 1, description: 'The id of the published email to send (from HubSpot\'s email tool or list_marketing_emails).' },
          to: EMAIL,
          from: { type: 'string', maxLength: 300, description: 'A From header that overrides the email\'s, e.g. "Shop <shop@example.com>".' },
          reply_to: { type: 'array', items: EMAIL, maxItems: 5, description: 'Reply-To addresses.' },
          cc: { type: 'array', items: EMAIL, maxItems: 10, description: 'Cc addresses.' },
          bcc: { type: 'array', items: EMAIL, maxItems: 10, description: 'Bcc addresses.' },
          send_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Your id for this send; one is made when left out. Reuse it to retry safely.' },
          contact_properties: { type: 'object', description: 'Contact properties to set and use, e.g. {"firstname": "Ann"}.' },
          custom_properties: { type: 'object', description: 'Values for {{ custom.NAME }}, e.g. {"order_number": "1234"}.' },
        },
        required: ['email_id', 'to'],
        additionalProperties: false,
      },
      async run(args: { type: 'transactional' | 'marketing'; email_id: number; to: string; from?: string; reply_to?: string[]; cc?: string[]; bcc?: string[]; send_id?: string; contact_properties?: Record<string, unknown>; custom_properties?: Record<string, unknown> }, h) {
        const sendId = args.send_id ?? crypto.randomUUID();
        let data: any;
        try {
          ({ data } = await h.api({
            method: 'POST',
            path: SINGLE_SEND_PATHS[args.type],
            json: compact({
              emailId: args.email_id,
              message: compact({ to: args.to, from: args.from, replyTo: args.reply_to, cc: args.cc, bcc: args.bcc, sendId }),
              contactProperties: args.contact_properties,
              customProperties: args.custom_properties,
            }),
            write: true,
            errors: { 400: 'HubSpot did not accept the send', 403: 'HubSpot refused the send (it needs the transactional email add-on or Marketing Hub Enterprise)' },
          }));
        } catch (error) {
          if (error instanceof OutcomeUnknown) {
            throw new OutcomeUnknown(`${error.message} Sending it again with send_id "${sendId}" is safe: HubSpot sends at most one email per send_id.`);
          }
          throw error;
        }
        return compact({ sendId, statusId: data?.statusId, status: data?.status, sendResult: data?.sendResult, requestedAt: data?.requestedAt });
      },
    },
    {
      name: 'get_send_status',
      kind: 'read',
      title: 'Get the status of a HubSpot single send',
      description: 'The status of a single send (PENDING, PROCESSING, CANCELED, COMPLETE) and its result (SENT, or why it was not sent, such as PREVIOUSLY_BOUNCED).',
      inputSchema: {
        type: 'object',
        properties: { status_id: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9-]+$', description: 'The statusId from send_single_email.' } },
        required: ['status_id'],
        additionalProperties: false,
      },
      async run(args: { status_id: string }, h) {
        const { data } = await h.api({ path: `/marketing/v3/email/send-statuses/${args.status_id}`, errors: { 404: 'HubSpot has no send with that status id' } });
        return compact({ statusId: data?.statusId, status: data?.status, sendResult: data?.sendResult, requestedAt: data?.requestedAt, startedAt: data?.startedAt, completedAt: data?.completedAt });
      },
    },
    {
      name: 'list_files',
      kind: 'read',
      title: 'List HubSpot files',
      description: 'Files in the file manager, newest first, with their ids, names, types, sizes, access and URLs; filter by name, type or extension. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'Files whose name contains this text.' },
          type: { type: 'string', enum: ['IMG', 'DOCUMENT', 'AUDIO', 'MOVIE', 'OTHER'], description: 'Only this kind of file.' },
          extension: { type: 'string', pattern: '^[A-Za-z0-9]{1,8}$', description: 'Only files with this extension, e.g. pdf.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Files per page, 1 to 100 (default 20).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { name?: string; type?: string; extension?: string; limit: number; cursor?: string }, h) {
        const state = pageState(h, args.cursor, args.limit);
        const { data } = await h.api({
          path: '/files/v3/files/search',
          query: { name: args.name, type: args.type, extension: args.extension, limit: state.size, after: state.after, sort: '-createdAt' },
        });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        return afterPage(h, state.skip, { key: 'files', items: results.map(trimFile), current: state.after, next: after(data), size: state.size });
      },
    },
    {
      name: 'upload_file',
      kind: 'create',
      check: 'list_files',
      title: 'Upload a file to HubSpot',
      description:
        'Downloads a file from a public https URL (up to 20 MB) and uploads it to the HubSpot file manager, in a folder path (created when missing), '
        + 'to use in emails, pages or records. Returns its id and URL. access: PUBLIC_INDEXABLE, PUBLIC_NOT_INDEXABLE (default) or PRIVATE.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public https URL of the file.' },
          file_name: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^/\\\\]+$', description: 'The name to save it under, with its extension (from the URL when left out).' },
          folder_path: { type: 'string', minLength: 1, maxLength: 500, pattern: '^/', default: '/', description: 'The folder, e.g. /marketing (default /).' },
          access: { type: 'string', enum: ['PUBLIC_INDEXABLE', 'PUBLIC_NOT_INDEXABLE', 'PRIVATE'], default: 'PUBLIC_NOT_INDEXABLE', description: 'Who can open the file\'s URL.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async run(args: { url: string; file_name?: string; folder_path: string; access: string }, h) {
        const name = args.file_name ?? nameFromUrl(args.url);
        if (!name) throw new ToolFailure('The URL does not end with a file name: give file_name, with its extension. Nothing was changed.');
        const { bytes, contentType } = await h.media(args.url, { what: 'file', maxBytes: 20 * 1024 * 1024 });
        const type = contentType && /^[a-z]+\/[A-Za-z0-9.+-]+/.test(contentType) && !contentType.startsWith('text/html') ? contentType.split(';')[0]!.trim() : typeFromName(name);
        const form = multipart(
          {
            fileName: name,
            folderPath: args.folder_path,
            options: JSON.stringify({ access: args.access, overwrite: false, duplicateValidationStrategy: 'NONE', duplicateValidationScope: 'ENTIRE_PORTAL' }),
          },
          { field: 'file', name, type, bytes },
        );
        const { data } = await h.api({
          method: 'POST',
          path: '/files/v3/files',
          body: form.body,
          contentType: form.contentType,
          write: true,
          errors: { 400: 'HubSpot did not accept the file' },
        });
        return trimFile(data);
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The HubSpot API at https://api.hubapi.com, with the connection\'s access token: paths such as /crm/v3/objects/contacts/merge, '
        + '/crm/v3/objects/{type}/batch/update, /crm/v4/associations/{from}/{to}/labels, /crm/v3/lists, /marketing/v3/emails/{id}/draft, '
        + '/communication-preferences/v3/definitions, /automation/v4/flows or /cms/v3/pages. Reference: https://developers.hubspot.com/docs/api-reference.',
      guard(request) {
        if (routedParts(request.segments)[0] === 'oauth') throw new ToolFailure('HubSpot\'s OAuth endpoints are not available here. Nothing was sent.');
      },
    }),
  ]),
});

export = connector;
