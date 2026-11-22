// Customer Match members and offline conversions through Google's Data
// Manager API (https://datamanager.googleapis.com/v1), the way Google takes
// first-party data from every Google Cloud project now: the Google Ads API
// keeps OfflineUserDataJobService and UploadClickConversions for the projects
// that used them before April and June 2026 only. The token needs the scope
// https://www.googleapis.com/auth/datamanager, and the project the Data
// Manager API enabled. Each request names its destination: the Google Ads
// account (operatingAccount), the manager account it is reached through
// (loginAccount) and the list or conversion action (productDestinationId).

import {
  allowedAccounts,
  jsonSize,
  OUTPUT_LIMIT_BYTES,
  OutcomeUnknown,
  ToolFailure,
  truncate,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import {
  CONSENT,
  HASHED_LISTS,
  hashIdentifiers,
  IDENTIFIER_LISTS,
  identifierCount,
  MAX_MATCH_IDENTIFIERS,
  skippedSummary,
  type Hashed,
  type IdentifierArgs,
} from './identifiers.js';
import { loginFor } from './login.js';
import { chosenCustomer, compact, CUSTOMER_ID, digits, LOGIN_CUSTOMER_ID, snake, snakeDeep } from './shared.js';

export const DATA_MANAGER = 'https://datamanager.googleapis.com';
const DM_VERSION = 'v1';
const MAX_EVENTS = 2_000;
const MAX_EVENT_IDENTIFIERS = 10;
const MAX_WARNINGS = 20;
const MAX_COUNTS = 20;
const MAX_INDICES = 20;
const EVENT_SOURCES = ['WEB', 'APP', 'IN_STORE', 'PHONE', 'MESSAGE', 'OTHER'];
const RFC3339 = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';

const ACCESS =
  'Google refused the request: the sign-in needs the scope https://www.googleapis.com/auth/datamanager, the Data Manager API must be '
  + 'enabled in the Google Cloud project of the OAuth client, and the Google account needs access to this Google Ads account (for one '
  + 'reached through a manager account, give login_customer_id)';
const AUDIENCE_ERRORS = {
  400: 'Google did not accept the audience request: the list must be a Customer Match list of contact information in this account '
    + '(search gives its ID as user_list.id); validate_only: true has a request checked without taking anyone',
  403: ACCESS,
  404: 'Google found no such Customer Match list in this account',
};
const EVENT_ERRORS = {
  400: 'Google did not accept the conversions: the conversion action must be one of this account whose source is Website (Import from '
    + 'clicks), times must be RFC 3339 with a time zone and currencies 3-letter codes; validate_only: true has them checked without taking any',
  403: ACCESS,
  404: 'Google found no such conversion action in this account',
};
const STATUS_ERRORS = {
  400: 'Google did not accept the request ID: pass the request_id an upload returned, unchanged',
  403: 'Google refused the request: the sign-in needs the scope https://www.googleapis.com/auth/datamanager, and only the Google account that sent an upload can read its status',
  404: 'Google found no upload with this request ID',
};

const USER_LIST = {
  type: 'string' as const,
  pattern: '^(customers/[0-9]{10}/userLists/)?[0-9]{1,20}$',
  description: 'The Customer Match list\'s ID, or its resource name customers/{customer_id}/userLists/{id} (search lists them: SELECT user_list.id, user_list.name FROM user_list WHERE user_list.type = CRM_BASED).',
};
const VALIDATE_ONLY = { type: 'boolean' as const, description: 'Have Google check the request without taking the data.' };
const CLICK_ID = { type: 'string' as const, minLength: 1, maxLength: 1000 };

interface AudienceArgs extends IdentifierArgs {
  customer_id: string;
  login_customer_id?: string;
  user_list: string;
  ad_user_data_consent?: 'GRANTED' | 'DENIED';
  ad_personalization_consent?: 'GRANTED' | 'DENIED';
  validate_only?: boolean;
}

interface ConversionInput extends IdentifierArgs {
  conversion_time: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  session_attributes?: string;
  value?: number;
  currency?: string;
  transaction_id?: string;
  event_source?: string;
}

interface ConversionArgs {
  customer_id: string;
  login_customer_id?: string;
  conversion_action: string;
  conversions: ConversionInput[];
  event_source: string;
  ad_user_data_consent?: 'GRANTED' | 'DENIED';
  ad_personalization_consent?: 'GRANTED' | 'DENIED';
  validate_only?: boolean;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? truncate(value, max) : undefined;
}

/** The numeric ID in an ID or in a resource name customers/{customer}/{collection}/{id}; another account's resource is refused. */
function ownId(value: string, customer: string, collection: string, what: string): string {
  const match = new RegExp(`^customers/([0-9]{10})/${collection}/([0-9]+)$`).exec(value);
  if (match && match[1] !== customer) throw new ToolFailure(`The ${what} belongs to another account than ${customer}. Nothing was sent.`);
  return match ? (match[2] as string) : value;
}

/**
 * Where the data goes: the account, the manager account it is reached through (none when it is opened
 * directly), the list or action. The manager account is looked up in the Google Ads API, a separate API
 * with its own access level and quota: when it refuses the lookup, the data goes without a login
 * account, and the Data Manager API answers for itself.
 */
async function destination(h: ToolHelpers, customer: string, explicitLogin: string | undefined, productDestinationId: string): Promise<Record<string, unknown>> {
  let login: string | undefined;
  try {
    login = await loginFor(h, customer, explicitLogin);
  } catch (error) {
    if (!(error instanceof ToolFailure) || error.details.status === undefined) throw error;
  }
  return compact({
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customer },
    loginAccount: login && login !== customer ? { accountType: 'GOOGLE_ADS', accountId: login } : undefined,
    productDestinationId,
  });
}

function consentOf(args: { ad_user_data_consent?: string; ad_personalization_consent?: string }): Record<string, unknown> | undefined {
  const status = (value: string | undefined) => (value ? `CONSENT_${value}` : undefined);
  const consent = compact({ adUserData: status(args.ad_user_data_consent), adPersonalization: status(args.ad_personalization_consent) });
  return Object.keys(consent).length ? consent : undefined;
}

/** Hashes the people of one call, refusing a call with none, too many, or no valid one before anything is sent. */
async function checkedIdentifiers(args: IdentifierArgs): Promise<Hashed> {
  const total = identifierCount(args);
  if (!total) throw new ToolFailure('Give at least one email or phone number. Nothing was sent.');
  if (total > MAX_MATCH_IDENTIFIERS) throw new ToolFailure(`Give at most ${MAX_MATCH_IDENTIFIERS} emails and phone numbers per call (got ${total}). Nothing was sent.`);
  const hashed = await hashIdentifiers(args);
  if (!hashed.emails.length && !hashed.phones.length) {
    throw new ToolFailure('None of the emails or phone numbers is valid (phones need E.164 form, e.g. "+15551234567"). Nothing was sent.');
  }
  return hashed;
}

/** One audience member per identifier, emails first, in the order given. */
function membersOf(hashed: Hashed): Record<string, unknown>[] {
  const member = (identifier: Record<string, string>) => ({ compositeData: { userData: { userIdentifiers: [identifier] } } });
  return [...hashed.emails.map((hash) => member({ emailAddress: hash })), ...hashed.phones.map((hash) => member({ phoneNumber: hash }))];
}

/** How many of each kind were sent, in the order they were sent (the order of get_upload_status's record indices). */
function sentCounts(args: IdentifierArgs, hashed: Hashed): Record<string, number> {
  const counts: Record<string, number> = {
    emails: (args.emails?.length ?? 0) - hashed.skippedEmails.length,
    hashed_emails: args.hashed_emails?.length ?? 0,
    phones: (args.phones?.length ?? 0) - hashed.skippedPhones.length,
    hashed_phones: args.hashed_phones?.length ?? 0,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

/** Google's warnings about fields it took anyway, cut to a few short lines. */
function warningsOf(data: any): Record<string, unknown> {
  const list: any[] = Array.isArray(data?.fieldWarnings) ? data.fieldWarnings : [];
  if (!list.length) return {};
  return {
    warnings: list.slice(0, MAX_WARNINGS).map((item) => compact({ field: text(item?.field, 200), reason: text(item?.reason, 120), description: text(item?.description, 200) })),
    ...(list.length > MAX_WARNINGS ? { warnings_total: list.length } : {}),
  };
}

/** Sends one ingestion request; an unclear outcome says what sending it again would do. */
async function ingest(h: ToolHelpers, path: string, body: Record<string, unknown>, validateOnly: boolean | undefined, errors: Record<number, string>, again: string): Promise<any> {
  try {
    const { data } = await h.api({ method: 'POST', origin: DATA_MANAGER, path: `/${DM_VERSION}/${path}`, json: body, write: !validateOnly, errors });
    return data;
  } catch (error) {
    if (error instanceof OutcomeUnknown) throw new OutcomeUnknown(`${error.message} ${again}`);
    throw error;
  }
}

function audienceTool(mode: 'add' | 'remove'): ToolDefinition {
  const adding = mode === 'add';
  return {
    name: adding ? 'add_audience_members' : 'remove_audience_members',
    kind: adding ? 'create' : 'delete',
    check: 'search',
    title: adding ? 'Add Customer Match members (Data Manager API)' : 'Remove Customer Match members (Data Manager API)',
    description: adding
      ? 'Adds people to a Customer Match list of one account by email or phone through Google\'s Data Manager API, which takes Customer '
        + 'Match data from every Google Cloud project (upload_customer_match only works for projects Google allowlisted): normalizes and '
        + 'hashes them with SHA-256 here, then sends up to 10,000 in one request. Someone already in the list is not added twice. Matching '
        + 'takes up to 48 hours, and a list needs at least 100 members to be used for targeting. Needs the scope '
        + 'https://www.googleapis.com/auth/datamanager and the Data Manager API enabled in the project. Returns a request_id for get_upload_status.'
      : 'Removes people from a Customer Match list of one account by email or phone through Google\'s Data Manager API, open to every '
        + 'Google Cloud project: normalizes and hashes them with SHA-256 here, then sends up to 10,000 in one request. Removing someone who '
        + 'is not in the list changes nothing. Needs the scope https://www.googleapis.com/auth/datamanager and the Data Manager API enabled '
        + 'in the project. Returns a request_id for get_upload_status.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: CUSTOMER_ID,
        login_customer_id: LOGIN_CUSTOMER_ID,
        user_list: USER_LIST,
        ...IDENTIFIER_LISTS,
        ...HASHED_LISTS,
        ...(adding
          ? {
            ...CONSENT,
            accept_customer_match_terms: {
              type: 'boolean',
              enum: [true],
              description: 'true confirms that the account accepts Google\'s Customer Match terms (https://support.google.com/adspolicy/answer/6299717), which Google requires with every upload. Pass it only when the advertiser has accepted them.',
            },
          }
          : {}),
        validate_only: VALIDATE_ONLY,
      },
      required: adding ? ['customer_id', 'user_list', 'accept_customer_match_terms'] : ['customer_id', 'user_list'],
      additionalProperties: false,
    },
    async run(args: AudienceArgs, h) {
      const id = chosenCustomer(h, args.customer_id);
      const list = ownId(args.user_list, id, 'userLists', 'user list');
      const hashed = await checkedIdentifiers(args);
      const body = compact({
        destinations: [await destination(h, id, args.login_customer_id, list)],
        audienceMembers: membersOf(hashed),
        consent: adding ? consentOf(args) : undefined,
        encoding: 'HEX',
        termsOfService: adding ? { customerMatchTermsOfServiceStatus: 'ACCEPTED' } : undefined,
        validateOnly: args.validate_only ? true : undefined,
      });
      const data = await ingest(
        h,
        adding ? 'audienceMembers:ingest' : 'audienceMembers:remove',
        body,
        args.validate_only,
        AUDIENCE_ERRORS,
        adding
          ? 'Customer Match keeps each person once, so sending the same people again adds no one twice.'
          : 'Removing the same people again changes nothing more.',
      );
      return compact({
        customer_id: id,
        user_list: `customers/${id}/userLists/${list}`,
        request_id: text(data?.requestId, 200),
        validate_only: args.validate_only ? true : undefined,
        valid: args.validate_only ? true : undefined,
        members_sent: hashed.emails.length + hashed.phones.length,
        sent: sentCounts(args, hashed),
        skipped_emails: skippedSummary(hashed.skippedEmails),
        skipped_phones: skippedSummary(hashed.skippedPhones),
        ...warningsOf(data),
        note: args.validate_only
          ? 'Google checked the request and took no one.'
          : `Google ${adding ? 'matches the people' : 'removes them'} in the background${adding ? ', within 48 hours' : ''}: get_upload_status with request_id tells how many it took and why any were not.`,
      });
    },
  };
}

const CONVERSION = {
  type: 'object' as const,
  properties: {
    conversion_time: { type: 'string' as const, pattern: RFC3339, description: 'When it happened, RFC 3339 with a time zone, e.g. "2026-11-20T14:05:00-05:00".' },
    gclid: { ...CLICK_ID, description: 'The Google click ID of the ad click.' },
    gbraid: { ...CLICK_ID, description: 'The click ID of an app click from iOS 14 or later.' },
    wbraid: { ...CLICK_ID, description: 'The click ID of a web click from iOS 14 or later.' },
    session_attributes: { type: 'string' as const, minLength: 1, maxLength: 8000, description: 'The encoded session attributes string captured with the form, when no click ID is known.' },
    emails: { ...IDENTIFIER_LISTS.emails, maxItems: MAX_EVENT_IDENTIFIERS, description: 'The person\'s emails in plain text (hashed here).' },
    phones: { ...IDENTIFIER_LISTS.phones, maxItems: MAX_EVENT_IDENTIFIERS, description: 'The person\'s phone numbers in E.164 form (hashed here).' },
    hashed_emails: { ...HASHED_LISTS.hashed_emails, maxItems: MAX_EVENT_IDENTIFIERS },
    hashed_phones: { ...HASHED_LISTS.hashed_phones, maxItems: MAX_EVENT_IDENTIFIERS },
    value: { type: 'number' as const, minimum: 0, description: 'The conversion value, in currency units (not micros).' },
    currency: { type: 'string' as const, pattern: '^[A-Za-z]{3}$', description: 'The value\'s 3-letter currency code, e.g. "USD" (default: the conversion action\'s).' },
    transaction_id: { type: 'string' as const, minLength: 1, maxLength: 128, description: 'The order or lead ID: Google Ads counts one conversion per ID and action, so a repeat updates it instead of adding one.' },
    event_source: { type: 'string' as const, enum: EVENT_SOURCES, description: 'Where this one happened, if not event_source.' },
  },
  required: ['conversion_time'],
  additionalProperties: false,
};

const uploadConversions: ToolDefinition = {
  name: 'upload_conversions',
  kind: 'write',
  check: 'search',
  title: 'Upload offline conversions (Data Manager API)',
  description:
    'Sends offline conversions to a conversion action of one account through Google\'s Data Manager API, which takes them from every '
    + 'Google Cloud project (the Google Ads API\'s uploadClickConversions only works for projects Google allowlisted): click conversions by '
    + 'gclid, gbraid or wbraid, and enhanced conversions for leads by email or phone, normalized and hashed with SHA-256 here. Up to 2,000 '
    + 'per call, each with its time, value, currency and transaction_id. A conversion whose transaction_id was sent before updates that '
    + 'one. The action\'s source must be Website (Import from clicks). Needs the scope https://www.googleapis.com/auth/datamanager and the '
    + 'Data Manager API enabled. Returns a request_id for get_upload_status.',
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: CUSTOMER_ID,
      login_customer_id: LOGIN_CUSTOMER_ID,
      conversion_action: {
        type: 'string',
        pattern: '^(customers/[0-9]{10}/conversionActions/)?[0-9]{1,20}$',
        description: 'The conversion action\'s ID or resource name customers/{customer_id}/conversionActions/{id} (search lists them: SELECT conversion_action.id, conversion_action.name FROM conversion_action WHERE conversion_action.type = UPLOAD_CLICKS).',
      },
      conversions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EVENTS,
        items: CONVERSION,
        description: 'The conversions, each with conversion_time and at least one of gclid, gbraid, wbraid, session_attributes, an email or a phone (at most 10 emails and phones each).',
      },
      event_source: { type: 'string', enum: EVENT_SOURCES, default: 'WEB', description: 'Where the conversions happened: WEB (default), APP, IN_STORE, PHONE, MESSAGE or OTHER.' },
      ...CONSENT,
      validate_only: VALIDATE_ONLY,
    },
    required: ['customer_id', 'conversion_action', 'conversions'],
    additionalProperties: false,
  },
  async run(args: ConversionArgs, h) {
    const id = chosenCustomer(h, args.customer_id);
    const action = ownId(args.conversion_action, id, 'conversionActions', 'conversion action');
    const events: Record<string, unknown>[] = [];
    const skipped: Record<string, unknown>[] = [];
    for (const [index, conversion] of args.conversions.entries()) {
      const given = identifierCount(conversion);
      if (given > MAX_EVENT_IDENTIFIERS) {
        throw new ToolFailure(`Conversion ${index} has ${given} emails and phone numbers; Google takes at most ${MAX_EVENT_IDENTIFIERS} per conversion. Nothing was sent.`);
      }
      const hashed = await hashIdentifiers(conversion);
      const identifiers = [...hashed.emails.map((hash) => ({ emailAddress: hash })), ...hashed.phones.map((hash) => ({ phoneNumber: hash }))];
      const adIdentifiers = compact({ gclid: conversion.gclid, gbraid: conversion.gbraid, wbraid: conversion.wbraid, sessionAttributes: conversion.session_attributes });
      if (!identifiers.length && !Object.keys(adIdentifiers).length) {
        throw new ToolFailure(`Conversion ${index} has no gclid, gbraid, wbraid, session_attributes, or valid email or phone number, so Google could not match it. Nothing was sent.`);
      }
      if (hashed.skippedEmails.length || hashed.skippedPhones.length) {
        skipped.push(compact({
          conversion: index,
          emails: hashed.skippedEmails.length ? hashed.skippedEmails : undefined,
          phones: hashed.skippedPhones.length ? hashed.skippedPhones : undefined,
        }));
      }
      events.push(compact({
        eventTimestamp: conversion.conversion_time,
        transactionId: conversion.transaction_id,
        eventSource: conversion.event_source ?? args.event_source,
        adIdentifiers: Object.keys(adIdentifiers).length ? adIdentifiers : undefined,
        userData: identifiers.length ? { userIdentifiers: identifiers } : undefined,
        conversionValue: conversion.value,
        currency: conversion.currency?.toUpperCase(),
      }));
    }
    const body = compact({
      destinations: [await destination(h, id, args.login_customer_id, action)],
      events,
      consent: consentOf(args),
      encoding: 'HEX',
      validateOnly: args.validate_only ? true : undefined,
    });
    const data = await ingest(
      h,
      'events:ingest',
      body,
      args.validate_only,
      EVENT_ERRORS,
      'Google Ads counts a conversion with the same transaction_id, or the same gclid and time, once, so sending these again counts twice only those with neither.',
    );
    return compact({
      customer_id: id,
      conversion_action: `customers/${id}/conversionActions/${action}`,
      request_id: text(data?.requestId, 200),
      validate_only: args.validate_only ? true : undefined,
      valid: args.validate_only ? true : undefined,
      conversions_sent: events.length,
      skipped_identifiers: skipped.length ? skipped.slice(0, 100) : undefined,
      ...warningsOf(data),
      note: args.validate_only
        ? 'Google checked the conversions and took none.'
        : 'Google processes the conversions in the background: get_upload_status with request_id tells how many it took and why any were not.',
    });
  },
};

const STATUS_KEYS = ['audienceMembersIngestionStatus', 'audienceMembersRemovalStatus', 'eventsIngestionStatus', 'removeAllAudienceMembersStatus'];

/** Error or warning counts by reason, with the first record indices of each. */
function countsOf(list: unknown, withIndices: boolean): Record<string, unknown>[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.slice(0, MAX_COUNTS).map((item: any) => {
    const indices: unknown[] = Array.isArray(item?.recordIndices) ? item.recordIndices : [];
    return compact({
      reason: text(item?.reason, 120),
      record_count: item?.recordCount !== undefined ? Number(item.recordCount) : undefined,
      record_indices: withIndices && indices.length ? indices.slice(0, MAX_INDICES) : undefined,
    });
  });
}

/** One destination's status: how the request went, how many records it held, and why any failed. */
function destinationStatus(item: any, withIndices: boolean): Record<string, unknown> {
  const key = STATUS_KEYS.find((name) => item?.[name] && typeof item[name] === 'object');
  const status = key ? item[key] : undefined;
  // An audience status holds one object per kind of data (compositeDataIngestionStatus, ...): its figures are inside it.
  const inner = status && Object.keys(status).length === 1 && typeof Object.values(status)[0] === 'object' ? Object.values(status)[0] : status;
  return compact({
    customer_id: text(item?.destination?.operatingAccount?.accountId, 20),
    product_destination_id: text(item?.destination?.productDestinationId, 40),
    request_status: text(item?.requestStatus, 40),
    operation: key ? snake(key.replace(/Status$/, '')) : undefined,
    figures: inner && Object.keys(inner).length ? snakeDeep(inner) : undefined,
    errors: countsOf(item?.errorInfo?.errorCounts, withIndices),
    warnings: countsOf(item?.warningInfo?.warningCounts, withIndices),
  });
}

const getUploadStatus: ToolDefinition = {
  name: 'get_upload_status',
  kind: 'read',
  title: 'Get the status of a Data Manager upload',
  description:
    'How Google processed a request of add_audience_members, remove_audience_members or upload_conversions, by its request_id: '
    + 'request_status PROCESSING, SUCCESS, PARTIAL_SUCCESS or FAILED, how many records it held, the match rate range of an audience '
    + 'upload, and the reasons of the records that failed or got warnings, with their record indices (0-based, in the order they were '
    + 'sent). It changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$', description: 'The request_id an upload returned.' },
    },
    required: ['request_id'],
    additionalProperties: false,
  },
  async run(args: { request_id: string }, h) {
    const { data } = await h.api({
      origin: DATA_MANAGER,
      path: `/${DM_VERSION}/requestStatus:retrieve`,
      query: { requestId: args.request_id },
      errors: STATUS_ERRORS,
    });
    const all: any[] = Array.isArray(data?.requestStatusPerDestination) ? data.requestStatusPerDestination : [];
    // Only the accounts chosen for the connection are shown.
    const allowed = allowedAccounts(h.ctx.accounts, 'customers');
    const shown = all.filter((item) => allowed === null || allowed.includes(digits(String(item?.destination?.operatingAccount?.accountId ?? ''))));
    const build = (withIndices: boolean) => compact({
      request_id: args.request_id,
      destinations: shown.map((item) => destinationStatus(item, withIndices)),
      hidden_destinations: all.length > shown.length ? all.length - shown.length : undefined,
    });
    const result = build(true);
    if (jsonSize(result) <= OUTPUT_LIMIT_BYTES - 500) return result;
    return { ...build(false), note: 'Record indices are left out to fit the result.' };
  },
};

/** The Data Manager tools: audience members in and out, offline conversions, and the status of each upload. */
export function dataManagerTools(): ToolDefinition[] {
  return [audienceTool('add'), audienceTool('remove'), uploadConversions, getUploadStatus];
}
