// Brevo (formerly Sendinblue), through the Brevo API v3 (https://developers.brevo.com/reference).
//
// Credential: `apikey`, a Brevo API key from Brevo -> Settings -> SMTP & API ->
// API Keys (it starts with xkeysib-). It is sent in the api-key header to
// https://api.brevo.com/v3/ only. The tools cover the account and senders,
// contacts, folders and lists, email campaigns (draft, test, send, schedule),
// templates, transactional email and its statistics; api_get and api_request
// reach the rest of the API (SMS campaigns, segments, attributes, webhooks, CRM).

import { apiTools, defineConnector, ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import { compact, offsetList, statisticCounts, trimCampaign, trimContact, trimTemplate } from './shape.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Brevo';

const EMAIL: JsonSchema = {
  type: 'string',
  minLength: 3,
  maxLength: 320,
  pattern: '^[^@\\s]+@[^@\\s]+$',
  description: 'An email address.',
};
const PERSON: JsonSchema = {
  type: 'object',
  properties: { email: EMAIL, name: { type: 'string', maxLength: 70, description: 'The display name, up to 70 characters.' } },
  required: ['email'],
  additionalProperties: false,
};
const SENDER: JsonSchema = {
  type: 'object',
  description: 'The sender: {email, name} of a verified sender (see list_senders), or {id} of a sender.',
  properties: {
    email: EMAIL,
    name: { type: 'string', maxLength: 70, description: 'The sender name.' },
    id: { type: 'integer', minimum: 1, description: 'A sender id from list_senders, instead of email.' },
  },
  additionalProperties: false,
};
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result; pass the other arguments unchanged.' };
const IDENTIFIER: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 320,
  description: 'The contact: its email address, or its Brevo id (with identifier_type contact_id for an id that could be read as something else).',
};
const IDENTIFIER_TYPE: JsonSchema = {
  type: 'string',
  enum: ['email_id', 'contact_id', 'ext_id', 'phone_id', 'whatsapp_id', 'landline_number_id'],
  description: 'What identifier is: email_id, contact_id, ext_id (your own id), phone_id (the SMS attribute), whatsapp_id or landline_number_id. Leave out for an email address or a Brevo id.',
};
const ATTRIBUTES: JsonSchema = {
  type: 'object',
  description: 'Contact attributes in upper case, as named in Brevo, e.g. {"FIRSTNAME": "Jane", "LASTNAME": "Doe", "SMS": "+15551234567"}.',
};
const LIST_IDS: JsonSchema = {
  type: 'array',
  items: { type: 'integer', minimum: 1 },
  maxItems: 100,
  uniqueItems: true,
  description: 'Brevo list ids (see list_lists).',
};
const DATE_TIME = (what: string): JsonSchema => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})$',
  description: `${what}, an ISO 8601 date-time with a time zone, e.g. 2026-12-01T09:00:00.000Z.`,
});
const DATE = (what: string): JsonSchema => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${what}, as YYYY-MM-DD.` });

/** The campaign fields create and update share. */
const CAMPAIGN_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 200, description: 'The internal campaign name (recipients do not see it).' },
  subject: { type: 'string', minLength: 1, maxLength: 500, description: 'The subject line; it can use {{ contact.FIRSTNAME }}.' },
  preview_text: { type: 'string', maxLength: 300, description: 'The preview text shown after the subject in inboxes.' },
  sender: SENDER,
  reply_to: EMAIL,
  to_field: { type: 'string', maxLength: 200, description: 'The To name, e.g. "{{ contact.FIRSTNAME }} {{ contact.LASTNAME }}".' },
  list_ids: { ...LIST_IDS, description: 'The lists to send to (see list_lists).' },
  exclusion_list_ids: { ...LIST_IDS, description: 'Lists whose contacts are left out.' },
  segment_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100, uniqueItems: true, description: 'Segments to send to, instead of or besides lists.' },
  html_content: {
    type: 'string',
    minLength: 1,
    maxLength: 1_000_000,
    description: 'The HTML body. It must contain {{ unsubscribe }}; {{ mirror }} links the web version. Give html_content, html_url or template_id.',
  },
  html_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public URL Brevo reads the HTML body from, instead of html_content.' },
  template_id: { type: 'integer', minimum: 1, description: 'A template to use for the body (see list_templates), instead of html_content.' },
  scheduled_at: DATE_TIME('When Brevo sends it. Leave out to keep a draft'),
  tag: { type: 'string', maxLength: 100, description: 'A tag to group campaigns by.' },
  params: { type: 'object', description: 'Values for {{ params.NAME }} placeholders in the body.' },
};

interface CampaignArgs {
  name?: string;
  subject?: string;
  preview_text?: string;
  sender?: { email?: string; name?: string; id?: number };
  reply_to?: string;
  to_field?: string;
  list_ids?: number[];
  exclusion_list_ids?: number[];
  segment_ids?: number[];
  html_content?: string;
  html_url?: string;
  template_id?: number;
  scheduled_at?: string;
  tag?: string;
  params?: Record<string, unknown>;
}

function checkSender(sender: CampaignArgs['sender']): void {
  if (sender && sender.email === undefined && sender.id === undefined) {
    throw new ToolFailure('sender needs an email or an id. Nothing was changed.');
  }
}

/** Brevo's campaign body from the arguments that were given. */
function campaignBody(args: CampaignArgs): Record<string, unknown> {
  checkSender(args.sender);
  const recipients = compact({
    listIds: args.list_ids,
    exclusionListIds: args.exclusion_list_ids,
    segmentIds: args.segment_ids,
  });
  return compact({
    name: args.name,
    subject: args.subject,
    previewText: args.preview_text,
    sender: args.sender,
    replyTo: args.reply_to,
    toField: args.to_field,
    recipients: Object.keys(recipients).length ? recipients : undefined,
    htmlContent: args.html_content,
    htmlUrl: args.html_url,
    templateId: args.template_id,
    scheduledAt: args.scheduled_at,
    tag: args.tag,
    params: args.params,
  });
}

function contactPath(identifier: string): string {
  return `/v3/contacts/${encodeURIComponent(identifier)}`;
}

/** How many of a contact list's items Brevo accepts in one call. */
const LIST_MEMBERS_MAX = 150;

function membersBody(args: { emails?: string[]; ids?: number[] }): Record<string, unknown> {
  const given = [args.emails?.length ? 'emails' : '', args.ids?.length ? 'ids' : ''].filter(Boolean);
  if (given.length !== 1) throw new ToolFailure('Give emails or ids (one of the two). Nothing was changed.');
  return args.emails?.length ? { emails: args.emails } : { ids: args.ids };
}

const MEMBERS_SCHEMA: Record<string, JsonSchema> = {
  list_id: { type: 'integer', minimum: 1, description: 'The list id (see list_lists).' },
  emails: { type: 'array', items: EMAIL, minItems: 1, maxItems: LIST_MEMBERS_MAX, uniqueItems: true, description: `Contacts by email address, up to ${LIST_MEMBERS_MAX}.` },
  ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: LIST_MEMBERS_MAX, uniqueItems: true, description: `Contacts by Brevo id, up to ${LIST_MEMBERS_MAX}, instead of emails.` },
};

function listResult(data: any): Record<string, unknown> {
  const contacts = data?.contacts ?? {};
  return compact({
    success: Array.isArray(contacts.success) ? contacts.success : undefined,
    failure: Array.isArray(contacts.failure) ? contacts.failure : undefined,
    total: contacts.total,
  });
}

async function sendTransactional(h: ToolHelpers, body: Record<string, unknown>) {
  return h.api({
    method: 'POST',
    path: '/v3/smtp/email',
    json: body,
    write: true,
    errors: { 400: 'Brevo did not accept the email', 402: 'Brevo refused the email: the account has no email credits left' },
  });
}

/**
 * A path as a server that decodes percent-escapes routes it: the decoded segments split again at "/" and "\",
 * each cut at ";" (a path parameter), lower-cased, with empty and "." parts dropped and ".." resolved. The guard
 * decides on these parts, so an escape (%63orporate, corporate%2Fkey) or a capital letter cannot get past it.
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
  vendor: 'brevo',
  label: LABEL,
  origins: ['https://api.brevo.com'],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'Brevo API key' },
  authHeaders: (credentials) => ({ 'api-key': credentials['apikey'] as string }),
  tools: [
    {
      name: 'get_account',
      kind: 'read',
      title: 'Get the Brevo account',
      description:
        'The connected Brevo account: email, company, plan with its remaining email and SMS credits, and whether marketing automation is on. '
        + 'A quick check that the API key works.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/v3/account' });
        return compact({
          email: data?.email,
          firstName: data?.firstName,
          lastName: data?.lastName,
          companyName: data?.companyName,
          plan: Array.isArray(data?.plan) ? data.plan : undefined,
          marketingAutomation: data?.marketingAutomation?.enabled,
        });
      },
    },
    {
      name: 'list_senders',
      kind: 'read',
      title: 'List Brevo senders',
      description: 'The senders of the account with their ids, names, emails and whether they are active. Only active (verified) senders can send campaigns and transactional email.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/v3/senders' });
        const senders: any[] = Array.isArray(data?.senders) ? data.senders : [];
        return { senders: senders.map((sender) => compact({ id: sender?.id, name: sender?.name, email: sender?.email, active: sender?.active })) };
      },
    },
    {
      name: 'list_contacts',
      kind: 'read',
      title: 'List Brevo contacts',
      description:
        'Contacts with their attributes, lists and blocklist flags, newest first. Filter by lists or a segment, by creation or change date, '
        + 'or by one attribute value. Returns the total; pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Contacts per page, 1 to 1000 (default 50).' },
          list_ids: LIST_IDS,
          segment_id: { type: 'integer', minimum: 1, description: 'Only contacts of this segment (not with list_ids).' },
          modified_since: DATE_TIME('Only contacts changed after this time'),
          created_since: DATE_TIME('Only contacts created after this time'),
          filter: { type: 'string', maxLength: 500, description: 'An attribute filter, equals only, e.g. equals(FIRSTNAME,"Jane").' },
          sort: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'By creation date: desc (default) or asc.' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; list_ids?: number[]; segment_id?: number; modified_since?: string; created_since?: string; filter?: string; sort: string; cursor?: string }, h) {
        if (args.list_ids?.length && args.segment_id !== undefined) throw new ToolFailure('Give list_ids or segment_id, not both. Nothing was sent.');
        return offsetList(h, args.cursor, {
          key: 'contacts',
          path: '/v3/contacts',
          limit: args.limit,
          query: {
            listIds: args.list_ids,
            segmentId: args.segment_id,
            modifiedSince: args.modified_since,
            createdSince: args.created_since,
            filter: args.filter,
            sort: args.sort,
          },
          trim: trimContact,
        });
      },
    },
    {
      name: 'get_contact',
      kind: 'read',
      title: 'Get a Brevo contact',
      description:
        'One contact by email address, Brevo id, your own id or phone: attributes, lists, blocklist flags, and how many campaign messages it was sent, '
        + 'opened and clicked (the events themselves with include_statistics).',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: IDENTIFIER,
          identifier_type: IDENTIFIER_TYPE,
          include_statistics: { type: 'boolean', default: false, description: 'true to return the campaign events (sent, opened, clicked...) instead of their counts.' },
        },
        required: ['identifier'],
        additionalProperties: false,
      },
      async run(args: { identifier: string; identifier_type?: string; include_statistics: boolean }, h) {
        const { data } = await h.api({
          path: contactPath(args.identifier),
          query: { identifierType: args.identifier_type },
          errors: { 404: 'Brevo has no contact with that identifier' },
        });
        return compact({
          ...trimContact(data),
          ...(args.include_statistics ? { statistics: data?.statistics } : { statisticCounts: statisticCounts(data?.statistics) }),
        });
      },
    },
    {
      name: 'upsert_contact',
      kind: 'update',
      check: 'get_contact',
      title: 'Create or update a Brevo contact',
      description:
        'Creates a contact, or updates the one with the same email (update_existing, on by default): attributes, lists to add it to, and blocklist flags. '
        + 'Lists it already belongs to are kept. Returns its id when Brevo gives one.',
      inputSchema: {
        type: 'object',
        properties: {
          email: EMAIL,
          ext_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Your own id for the contact (the EXT_ID attribute).' },
          attributes: ATTRIBUTES,
          list_ids: { ...LIST_IDS, description: 'Lists to add the contact to.' },
          email_blacklisted: { type: 'boolean', description: 'true to block it from all email (an unsubscribe), false to unblock.' },
          sms_blacklisted: { type: 'boolean', description: 'true to block it from all SMS, false to unblock.' },
          update_existing: { type: 'boolean', default: true, description: 'Update a contact that already exists (default true); false makes an existing email an error.' },
        },
        additionalProperties: false,
      },
      async run(args: { email?: string; ext_id?: string; attributes?: Record<string, unknown>; list_ids?: number[]; email_blacklisted?: boolean; sms_blacklisted?: boolean; update_existing: boolean }, h) {
        if (!args.email && !args.ext_id && !args.attributes) {
          throw new ToolFailure('Give an email, an ext_id or attributes such as SMS to identify the contact. Nothing was changed.');
        }
        const { status, data } = await h.api({
          method: 'POST',
          path: '/v3/contacts',
          json: compact({
            email: args.email,
            ext_id: args.ext_id,
            attributes: args.attributes,
            listIds: args.list_ids,
            emailBlacklisted: args.email_blacklisted,
            smsBlacklisted: args.sms_blacklisted,
            updateEnabled: args.update_existing,
          }),
          write: true,
          errors: { 400: 'Brevo did not accept the contact' },
        });
        // Brevo answers 204 when it updated an existing contact; a 201 is a new contact unless updating was allowed,
        // when Brevo may also answer 201 for an update.
        return compact({
          saved: true,
          id: data?.id,
          email: args.email,
          created: status === 201 && !args.update_existing ? true : undefined,
          updated: status === 204 ? true : undefined,
        });
      },
    },
    {
      name: 'update_contact',
      kind: 'update',
      check: 'get_contact',
      title: 'Update a Brevo contact',
      description:
        'Changes an existing contact: attributes (only those given), lists to add it to or remove it from, blocklist flags, or its ext_id. '
        + 'Removing it from a list keeps the contact.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: IDENTIFIER,
          identifier_type: IDENTIFIER_TYPE,
          attributes: ATTRIBUTES,
          ext_id: { type: 'string', minLength: 1, maxLength: 200, description: 'A new EXT_ID.' },
          list_ids: { ...LIST_IDS, description: 'Lists to add the contact to.' },
          unlink_list_ids: { ...LIST_IDS, description: 'Lists to remove the contact from.' },
          email_blacklisted: { type: 'boolean', description: 'true to block it from all email, false to unblock.' },
          sms_blacklisted: { type: 'boolean', description: 'true to block it from all SMS, false to unblock.' },
        },
        required: ['identifier'],
        additionalProperties: false,
      },
      async run(args: { identifier: string; identifier_type?: string; attributes?: Record<string, unknown>; ext_id?: string; list_ids?: number[]; unlink_list_ids?: number[]; email_blacklisted?: boolean; sms_blacklisted?: boolean }, h) {
        const body = compact({
          attributes: args.attributes,
          ext_id: args.ext_id,
          listIds: args.list_ids,
          unlinkListIds: args.unlink_list_ids,
          emailBlacklisted: args.email_blacklisted,
          smsBlacklisted: args.sms_blacklisted,
        });
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give attributes, lists or a blocklist flag. Nothing was changed.');
        await h.api({
          method: 'PUT',
          path: contactPath(args.identifier),
          query: { identifierType: args.identifier_type },
          json: body,
          write: true,
          errors: { 404: 'Brevo has no contact with that identifier' },
        });
        return { updated: true, identifier: args.identifier };
      },
    },
    {
      name: 'delete_contact',
      kind: 'delete',
      check: 'get_contact',
      title: 'Delete a Brevo contact',
      description: 'Deletes a contact for good, with its attributes and history. To stop emailing someone, prefer upsert_contact with email_blacklisted: true.',
      inputSchema: {
        type: 'object',
        properties: { identifier: IDENTIFIER, identifier_type: IDENTIFIER_TYPE },
        required: ['identifier'],
        additionalProperties: false,
      },
      async run(args: { identifier: string; identifier_type?: string }, h) {
        await h.api({
          method: 'DELETE',
          path: contactPath(args.identifier),
          query: { identifierType: args.identifier_type },
          write: true,
          errors: { 404: 'Brevo has no contact with that identifier' },
        });
        return { deleted: true, identifier: args.identifier };
      },
    },
    {
      name: 'list_folders',
      kind: 'read',
      title: 'List Brevo contact folders',
      description: 'The folders that hold contact lists, with their subscriber counts. Every list belongs to a folder. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50, description: 'Folders per page, 1 to 50 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        return offsetList(h, args.cursor, {
          key: 'folders',
          path: '/v3/contacts/folders',
          limit: args.limit,
          trim: (folder: any) => compact({
            id: folder?.id,
            name: folder?.name,
            totalSubscribers: folder?.totalSubscribers,
            uniqueSubscribers: folder?.uniqueSubscribers,
            totalBlacklisted: folder?.totalBlacklisted,
          }),
        });
      },
    },
    {
      name: 'create_folder',
      kind: 'create',
      check: 'list_folders',
      title: 'Create a Brevo contact folder',
      description: 'Creates a folder for contact lists and returns its id.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 200, description: 'The folder name.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string }, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/contacts/folders', json: { name: args.name }, write: true });
        return { id: data?.id, name: args.name };
      },
    },
    {
      name: 'list_lists',
      kind: 'read',
      title: 'List Brevo contact lists',
      description: 'Contact lists with their ids, folders and subscriber and blocklisted counts; one folder\'s lists with folder_id. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { type: 'integer', minimum: 1, description: 'Only the lists of this folder.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50, description: 'Lists per page, 1 to 50 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { folder_id?: number; limit: number; cursor?: string }, h) {
        return offsetList(h, args.cursor, {
          key: 'lists',
          path: args.folder_id !== undefined ? `/v3/contacts/folders/${args.folder_id}/lists` : '/v3/contacts/lists',
          limit: args.limit,
          trim: (list: any) => compact({
            id: list?.id,
            name: list?.name,
            folderId: list?.folderId,
            totalSubscribers: list?.totalSubscribers ?? list?.uniqueSubscribers,
            totalBlacklisted: list?.totalBlacklisted,
          }),
        });
      },
    },
    {
      name: 'create_list',
      kind: 'create',
      check: 'list_lists',
      title: 'Create a Brevo contact list',
      description: 'Creates a contact list in a folder (see list_folders, or create_folder) and returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The list name.' },
          folder_id: { type: 'integer', minimum: 1, description: 'The folder that holds the list.' },
        },
        required: ['name', 'folder_id'],
        additionalProperties: false,
      },
      async run(args: { name: string; folder_id: number }, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/contacts/lists', json: { name: args.name, folderId: args.folder_id }, write: true });
        return { id: data?.id, name: args.name, folderId: args.folder_id };
      },
    },
    {
      name: 'list_list_contacts',
      kind: 'read',
      title: 'List the contacts of a Brevo list',
      description: 'The contacts of one list with their attributes, newest first; only those changed since a time with modified_since. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'integer', minimum: 1, description: 'The list id (see list_lists).' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Contacts per page, 1 to 500 (default 50).' },
          modified_since: DATE_TIME('Only contacts changed after this time'),
          sort: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'By creation date: desc (default) or asc.' },
          cursor: CURSOR,
        },
        required: ['list_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: number; limit: number; modified_since?: string; sort: string; cursor?: string }, h) {
        return offsetList(h, args.cursor, {
          key: 'contacts',
          path: `/v3/contacts/lists/${args.list_id}/contacts`,
          limit: args.limit,
          query: { modifiedSince: args.modified_since, sort: args.sort },
          trim: trimContact,
        });
      },
    },
    {
      name: 'add_contacts_to_list',
      kind: 'update',
      check: 'list_list_contacts',
      title: 'Add contacts to a Brevo list',
      description: `Adds existing contacts to a list, by email or by id, up to ${LIST_MEMBERS_MAX} at a time. Returns which were added and which failed (for example, not a contact yet: create it with upsert_contact).`,
      inputSchema: { type: 'object', properties: MEMBERS_SCHEMA, required: ['list_id'], additionalProperties: false },
      async run(args: { list_id: number; emails?: string[]; ids?: number[] }, h) {
        const { data } = await h.api({
          method: 'POST',
          path: `/v3/contacts/lists/${args.list_id}/contacts/add`,
          json: membersBody(args),
          write: true,
          errors: { 404: 'Brevo has no list with that id' },
        });
        return { listId: args.list_id, ...listResult(data) };
      },
    },
    {
      name: 'remove_contacts_from_list',
      kind: 'delete',
      check: 'list_list_contacts',
      title: 'Remove contacts from a Brevo list',
      description: `Removes contacts from a list, by email or by id, up to ${LIST_MEMBERS_MAX} at a time. The contacts themselves are kept. Returns which were removed and which failed.`,
      inputSchema: { type: 'object', properties: MEMBERS_SCHEMA, required: ['list_id'], additionalProperties: false },
      async run(args: { list_id: number; emails?: string[]; ids?: number[] }, h) {
        const { data } = await h.api({
          method: 'POST',
          path: `/v3/contacts/lists/${args.list_id}/contacts/remove`,
          json: membersBody(args),
          write: true,
          errors: { 404: 'Brevo has no list with that id' },
        });
        return { listId: args.list_id, ...listResult(data) };
      },
    },
    {
      name: 'list_email_campaigns',
      kind: 'read',
      title: 'List Brevo email campaigns',
      description:
        'Email campaigns, newest first, with status, subject, sender, lists, schedule and, with statistics, their delivered, open, click, bounce and '
        + 'unsubscribe counts. Filter by status, type or a sent date range. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'archive', 'queued', 'suspended', 'inProcess', 'inReview', 'cancelled'],
            description: 'Only campaigns with this status.',
          },
          type: { type: 'string', enum: ['classic', 'trigger'], description: 'classic campaigns or trigger (automation) campaigns.' },
          statistics: { type: 'boolean', default: false, description: 'true to include each campaign\'s global statistics (last 6 months only).' },
          start_date: DATE_TIME('Sent at or after this time (with end_date, status sent or none)'),
          end_date: DATE_TIME('Sent at or before this time (with start_date)'),
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Campaigns per page, 1 to 100 (default 25).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { status?: string; type?: string; statistics: boolean; start_date?: string; end_date?: string; limit: number; cursor?: string }, h) {
        if ((args.start_date === undefined) !== (args.end_date === undefined)) {
          throw new ToolFailure('Give start_date and end_date together. Nothing was sent.');
        }
        return offsetList(h, args.cursor, {
          key: 'campaigns',
          path: '/v3/emailCampaigns',
          limit: args.limit,
          query: {
            status: args.status,
            type: args.type,
            statistics: args.statistics ? 'globalStats' : undefined,
            startDate: args.start_date,
            endDate: args.end_date,
            excludeHtmlContent: true,
          },
          trim: (campaign: any) => trimCampaign(campaign),
        });
      },
    },
    {
      name: 'get_email_campaign',
      kind: 'read',
      title: 'Get a Brevo email campaign',
      description:
        'One email campaign with its status, settings, recipients and statistics: global counts (delivered, unique opens and clicks, bounces, '
        + 'unsubscriptions, complaints), counts per list and the most clicked links. include_html adds the HTML body.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: { type: 'integer', minimum: 1, description: 'The campaign id.' },
          include_html: { type: 'boolean', default: false, description: 'true to include the HTML body (cut at 20,000 characters).' },
        },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: number; include_html: boolean }, h) {
        const { data } = await h.api({
          path: `/v3/emailCampaigns/${args.campaign_id}`,
          query: { excludeHtmlContent: args.include_html ? undefined : true },
          errors: { 404: 'Brevo has no email campaign with that id' },
        });
        const statistics = data?.statistics ?? {};
        const links = statistics.linksStats && typeof statistics.linksStats === 'object'
          ? Object.entries(statistics.linksStats as Record<string, any>)
            .map(([url, value]) => ({ url, clicks: typeof value === 'number' ? value : value?.nbClick ?? value }))
            .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0))
            .slice(0, 50)
          : undefined;
        return compact({
          ...trimCampaign(data, { html: args.include_html }),
          campaignStats: Array.isArray(statistics.campaignStats) && statistics.campaignStats.length ? statistics.campaignStats : undefined,
          linksStats: links?.length ? links : undefined,
          remaining: statistics.remaining,
        });
      },
    },
    {
      name: 'create_email_campaign',
      kind: 'create',
      check: 'list_email_campaigns',
      title: 'Create a Brevo email campaign',
      description:
        'Creates an email campaign: a draft that nothing sends until send_campaign_now, or, with scheduled_at, scheduled to send then. Needs a name, '
        + 'a subject, a verified sender, lists or segments, and a body: html_content (with {{ unsubscribe }}), html_url or template_id. Returns the id.',
      inputSchema: {
        type: 'object',
        properties: CAMPAIGN_FIELDS,
        required: ['name', 'subject', 'sender'],
        additionalProperties: false,
      },
      async run(args: CampaignArgs, h) {
        const bodies = [args.html_content, args.html_url, args.template_id].filter((item) => item !== undefined).length;
        if (bodies !== 1) throw new ToolFailure('Give exactly one of html_content, html_url or template_id. Nothing was changed.');
        if (!args.list_ids?.length && !args.segment_ids?.length) throw new ToolFailure('Give list_ids or segment_ids: who receives it. Nothing was changed.');
        const { data } = await h.api({
          method: 'POST',
          path: '/v3/emailCampaigns',
          json: campaignBody(args),
          write: true,
          errors: { 400: 'Brevo did not accept the campaign' },
        });
        return compact({ id: data?.id, name: args.name, status: args.scheduled_at ? 'scheduled' : 'draft', scheduledAt: args.scheduled_at });
      },
    },
    {
      name: 'update_email_campaign',
      kind: 'update',
      check: 'get_email_campaign',
      title: 'Update a Brevo email campaign',
      description:
        'Changes a draft or scheduled email campaign: only the fields given. scheduled_at schedules it (or moves the time). A sent campaign cannot be changed.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: { type: 'integer', minimum: 1, description: 'The campaign id.' }, ...CAMPAIGN_FIELDS },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: CampaignArgs & { campaign_id: number }, h) {
        const body = campaignBody(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one campaign field. Nothing was changed.');
        await h.api({
          method: 'PUT',
          path: `/v3/emailCampaigns/${args.campaign_id}`,
          json: body,
          write: true,
          errors: { 404: 'Brevo has no email campaign with that id', 400: 'Brevo did not accept the change' },
        });
        return { updated: true, id: args.campaign_id };
      },
    },
    {
      name: 'send_test_email',
      kind: 'create',
      check: 'get_email_campaign',
      title: 'Send a test of a Brevo campaign',
      description: 'Sends a test of an email campaign to the given addresses, or to the account\'s test list when none are given. Brevo allows 50 test emails a day.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign_id: { type: 'integer', minimum: 1, description: 'The campaign id.' },
          emails: { type: 'array', items: EMAIL, maxItems: 50, uniqueItems: true, description: 'Where to send the test; the test list when left out.' },
        },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: number; emails?: string[] }, h) {
        await h.api({
          method: 'POST',
          path: `/v3/emailCampaigns/${args.campaign_id}/sendTest`,
          json: { emailTo: args.emails ?? [] },
          write: true,
          errors: { 404: 'Brevo has no email campaign with that id', 400: 'Brevo did not send the test' },
        });
        return { sent: true, id: args.campaign_id, to: args.emails ?? 'test list' };
      },
    },
    {
      name: 'send_campaign_now',
      kind: 'create',
      check: 'get_email_campaign',
      title: 'Send a Brevo campaign now',
      description:
        'Sends an email campaign to all its recipients right away. It cannot be undone. Check the campaign first with get_email_campaign '
        + '(and a test with send_test_email). Sending uses the account\'s email credits.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: { type: 'integer', minimum: 1, description: 'The campaign id.' } },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: number }, h) {
        await h.api({
          method: 'POST',
          path: `/v3/emailCampaigns/${args.campaign_id}/sendNow`,
          write: true,
          errors: {
            404: 'Brevo has no email campaign with that id',
            400: 'Brevo did not send the campaign',
            402: 'Brevo refused to send: the account does not have enough email credits',
          },
        });
        return { sent: true, id: args.campaign_id, note: 'Brevo is sending the campaign; get_email_campaign shows its status and statistics.' };
      },
    },
    {
      name: 'delete_email_campaign',
      kind: 'delete',
      check: 'list_email_campaigns',
      title: 'Delete a Brevo email campaign',
      description: 'Deletes an email campaign that is not being sent, such as a draft. It cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: { campaign_id: { type: 'integer', minimum: 1, description: 'The campaign id.' } },
        required: ['campaign_id'],
        additionalProperties: false,
      },
      async run(args: { campaign_id: number }, h) {
        await h.api({
          method: 'DELETE',
          path: `/v3/emailCampaigns/${args.campaign_id}`,
          write: true,
          errors: { 404: 'Brevo has no email campaign with that id' },
        });
        return { deleted: true, id: args.campaign_id };
      },
    },
    {
      name: 'list_templates',
      kind: 'read',
      title: 'List Brevo email templates',
      description: 'The account\'s email templates with their ids, names, subjects, senders and whether they are active. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'true for active templates only, false for inactive only; both when left out.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Templates per page, 1 to 1000 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { active?: boolean; limit: number; cursor?: string }, h) {
        return offsetList(h, args.cursor, {
          key: 'templates',
          path: '/v3/smtp/templates',
          limit: args.limit,
          query: { templateStatus: args.active },
          trim: (template: any) => trimTemplate(template),
        });
      },
    },
    {
      name: 'get_template',
      kind: 'read',
      title: 'Get a Brevo email template',
      description: 'One email template with its settings and HTML body (cut at 20,000 characters).',
      inputSchema: {
        type: 'object',
        properties: { template_id: { type: 'integer', minimum: 1, description: 'The template id.' } },
        required: ['template_id'],
        additionalProperties: false,
      },
      async run(args: { template_id: number }, h) {
        const { data } = await h.api({ path: `/v3/smtp/templates/${args.template_id}`, errors: { 404: 'Brevo has no template with that id' } });
        return trimTemplate(data, { html: true });
      },
    },
    {
      name: 'create_template',
      kind: 'create',
      check: 'list_templates',
      title: 'Create a Brevo email template',
      description:
        'Creates an email template for campaigns and transactional email: name, subject, sender and an HTML body (html_content or html_url). '
        + 'Placeholders: {{ contact.FIRSTNAME }}, {{ params.NAME }}. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The template name.' },
          subject: { type: 'string', minLength: 1, maxLength: 500, description: 'The subject line.' },
          sender: SENDER,
          html_content: { type: 'string', minLength: 10, maxLength: 1_000_000, description: 'The HTML body, at least 10 characters.' },
          html_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public URL to read the HTML body from, instead of html_content.' },
          reply_to: EMAIL,
          to_field: { type: 'string', maxLength: 200, description: 'The To name, e.g. "{{ contact.FIRSTNAME }}".' },
          tag: { type: 'string', maxLength: 100, description: 'A tag for the template.' },
          is_active: { type: 'boolean', default: true, description: 'Active templates can be used for transactional email (default true).' },
        },
        required: ['name', 'subject', 'sender'],
        additionalProperties: false,
      },
      async run(args: { name: string; subject: string; sender: CampaignArgs['sender']; html_content?: string; html_url?: string; reply_to?: string; to_field?: string; tag?: string; is_active: boolean }, h) {
        checkSender(args.sender);
        if ((args.html_content === undefined) === (args.html_url === undefined)) throw new ToolFailure('Give html_content or html_url (one of the two). Nothing was changed.');
        const { data } = await h.api({
          method: 'POST',
          path: '/v3/smtp/templates',
          json: compact({
            templateName: args.name,
            subject: args.subject,
            sender: args.sender,
            htmlContent: args.html_content,
            htmlUrl: args.html_url,
            replyTo: args.reply_to,
            toField: args.to_field,
            tag: args.tag,
            isActive: args.is_active,
          }),
          write: true,
          errors: { 400: 'Brevo did not accept the template' },
        });
        return { id: data?.id, name: args.name };
      },
    },
    {
      name: 'update_template',
      kind: 'update',
      check: 'get_template',
      title: 'Update a Brevo email template',
      description: 'Changes an email template: only the fields given.',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'integer', minimum: 1, description: 'The template id.' },
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'A new name.' },
          subject: { type: 'string', minLength: 1, maxLength: 500, description: 'A new subject line.' },
          sender: SENDER,
          html_content: { type: 'string', minLength: 10, maxLength: 1_000_000, description: 'A new HTML body.' },
          html_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public URL to read a new HTML body from.' },
          reply_to: EMAIL,
          to_field: { type: 'string', maxLength: 200, description: 'A new To name.' },
          tag: { type: 'string', maxLength: 100, description: 'A new tag.' },
          is_active: { type: 'boolean', description: 'Activate or deactivate it.' },
        },
        required: ['template_id'],
        additionalProperties: false,
      },
      async run(args: { template_id: number; name?: string; subject?: string; sender?: CampaignArgs['sender']; html_content?: string; html_url?: string; reply_to?: string; to_field?: string; tag?: string; is_active?: boolean }, h) {
        checkSender(args.sender);
        const body = compact({
          templateName: args.name,
          subject: args.subject,
          sender: args.sender,
          htmlContent: args.html_content,
          htmlUrl: args.html_url,
          replyTo: args.reply_to,
          toField: args.to_field,
          tag: args.tag,
          isActive: args.is_active,
        });
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one template field. Nothing was changed.');
        await h.api({
          method: 'PUT',
          path: `/v3/smtp/templates/${args.template_id}`,
          json: body,
          write: true,
          errors: { 404: 'Brevo has no template with that id', 400: 'Brevo did not accept the change' },
        });
        return { updated: true, id: args.template_id };
      },
    },
    {
      name: 'send_transactional_email',
      kind: 'create',
      check: 'list_transactional_events',
      title: 'Send a Brevo transactional email',
      description:
        'Sends one email right away (or at scheduled_at): to up to 50 recipients, with cc, bcc and reply-to, and either a subject with an HTML or text '
        + 'body, or a template_id with params for {{ params.NAME }}. Attachments are public URLs Brevo downloads. Returns the message id. '
        + 'Uses the account\'s transactional email credits.',
      inputSchema: {
        type: 'object',
        properties: {
          sender: SENDER,
          to: { type: 'array', items: PERSON, minItems: 1, maxItems: 50, description: 'The recipients: [{"email": "a@example.com", "name": "Ann"}].' },
          cc: { type: 'array', items: PERSON, maxItems: 50, description: 'Cc recipients.' },
          bcc: { type: 'array', items: PERSON, maxItems: 50, description: 'Bcc recipients.' },
          reply_to: PERSON,
          subject: { type: 'string', minLength: 1, maxLength: 500, description: 'The subject line (not with template_id, which has its own).' },
          html_content: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The HTML body.' },
          text_content: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The plain text body.' },
          template_id: { type: 'integer', minimum: 1, description: 'A template (see list_templates) instead of subject and body.' },
          params: { type: 'object', description: 'Values for {{ params.NAME }} in the template or body, e.g. {"ORDER_ID": "1234"}.' },
          tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 10, description: 'Tags to find the email by in statistics.' },
          headers: { type: 'object', description: 'Custom headers, e.g. {"X-Mailin-custom": "order-1234"}.' },
          attachments: {
            type: 'array',
            maxItems: 10,
            description: 'Files to attach: [{"url": "https://...", "name": "invoice.pdf"}], or {"content": base64, "name"}.',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public URL of the file.' },
                content: { type: 'string', maxLength: 7_000_000, description: 'The file in base64, instead of url.' },
                name: { type: 'string', minLength: 1, maxLength: 200, description: 'The file name with its extension.' },
              },
              additionalProperties: false,
            },
          },
          scheduled_at: DATE_TIME('When to send it (Brevo may send up to 5 minutes later)'),
        },
        required: ['to'],
        additionalProperties: false,
      },
      async run(args: {
        sender?: CampaignArgs['sender'];
        to: { email: string; name?: string }[];
        cc?: { email: string; name?: string }[];
        bcc?: { email: string; name?: string }[];
        reply_to?: { email: string; name?: string };
        subject?: string;
        html_content?: string;
        text_content?: string;
        template_id?: number;
        params?: Record<string, unknown>;
        tags?: string[];
        headers?: Record<string, unknown>;
        attachments?: { url?: string; content?: string; name?: string }[];
        scheduled_at?: string;
      }, h) {
        checkSender(args.sender);
        if (args.template_id === undefined) {
          if (!args.sender) throw new ToolFailure('sender is required without template_id. Nothing was sent.');
          if (!args.subject) throw new ToolFailure('subject is required without template_id. Nothing was sent.');
          if (!args.html_content && !args.text_content) throw new ToolFailure('Give html_content or text_content, or a template_id. Nothing was sent.');
        }
        for (const attachment of args.attachments ?? []) {
          if ((attachment.url === undefined) === (attachment.content === undefined)) throw new ToolFailure('Each attachment needs a url or a content (one of the two). Nothing was sent.');
          if (attachment.content !== undefined && !attachment.name) throw new ToolFailure('An attachment given as content needs a name. Nothing was sent.');
        }
        const { status, data } = await sendTransactional(h, compact({
          sender: args.sender,
          to: args.to,
          cc: args.cc?.length ? args.cc : undefined,
          bcc: args.bcc?.length ? args.bcc : undefined,
          replyTo: args.reply_to,
          subject: args.subject,
          htmlContent: args.html_content,
          textContent: args.text_content,
          templateId: args.template_id,
          params: args.params,
          tags: args.tags?.length ? args.tags : undefined,
          headers: args.headers,
          attachment: args.attachments?.length ? args.attachments.map((item) => compact(item)) : undefined,
          scheduledAt: args.scheduled_at,
        }));
        return compact({
          sent: status !== 202,
          scheduled: status === 202 ? true : undefined,
          messageId: data?.messageId,
          messageIds: Array.isArray(data?.messageIds) ? data.messageIds : undefined,
        });
      },
    },
    {
      name: 'get_transactional_stats',
      kind: 'read',
      title: 'Get Brevo transactional email statistics',
      description:
        'Totals for transactional email over a period: requests, delivered, opens and unique opens, clicks, bounces, spam reports, blocked, '
        + 'invalid and unsubscribed. Give days, or start_date and end_date; filter by tag.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 90, description: 'The last N days (not with start_date).' },
          start_date: DATE('The first day'),
          end_date: DATE('The last day'),
          tag: { type: 'string', maxLength: 100, description: 'Only emails with this tag.' },
        },
        additionalProperties: false,
      },
      async run(args: { days?: number; start_date?: string; end_date?: string; tag?: string }, h) {
        if ((args.start_date === undefined) !== (args.end_date === undefined)) throw new ToolFailure('Give start_date and end_date together. Nothing was sent.');
        if (args.days !== undefined && args.start_date !== undefined) throw new ToolFailure('Give days or a date range, not both. Nothing was sent.');
        const { data } = await h.api({
          path: '/v3/smtp/statistics/aggregatedReport',
          query: { days: args.days, startDate: args.start_date, endDate: args.end_date, tag: args.tag },
        });
        return data ?? {};
      },
    },
    {
      name: 'list_transactional_events',
      kind: 'read',
      title: 'List Brevo transactional email events',
      description:
        'Events of transactional emails, newest first: requests, deliveries, opens, clicks, bounces, spam reports, blocks and unsubscribes, with '
        + 'the email, subject, message id and reason. Filter by recipient, event, message id, template or tag; it shows whether an email was sent. '
        + 'Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          email: EMAIL,
          event: {
            type: 'string',
            enum: ['requests', 'delivered', 'hardBounces', 'softBounces', 'blocked', 'spam', 'invalid', 'deferred', 'clicks', 'opened', 'uniqueOpened', 'unsubscribed', 'error', 'loadedByProxy'],
            description: 'Only this kind of event.',
          },
          message_id: { type: 'string', maxLength: 300, description: 'Only the events of this message id.' },
          template_id: { type: 'integer', minimum: 1, description: 'Only emails sent with this template.' },
          tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 10, description: 'Only emails with these tags.' },
          days: { type: 'integer', minimum: 1, maximum: 90, description: 'The last N days (not with start_date).' },
          start_date: DATE('The first day'),
          end_date: DATE('The last day'),
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Events per page, 1 to 500 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { email?: string; event?: string; message_id?: string; template_id?: number; tags?: string[]; days?: number; start_date?: string; end_date?: string; limit: number; cursor?: string }, h) {
        if ((args.start_date === undefined) !== (args.end_date === undefined)) throw new ToolFailure('Give start_date and end_date together. Nothing was sent.');
        return offsetList(h, args.cursor, {
          key: 'events',
          path: '/v3/smtp/statistics/events',
          limit: args.limit,
          query: {
            email: args.email,
            event: args.event,
            messageId: args.message_id,
            templateId: args.template_id,
            // Brevo takes the tags as a serialized array.
            tags: args.tags?.length ? JSON.stringify(args.tags) : undefined,
            days: args.days,
            startDate: args.start_date,
            endDate: args.end_date,
          },
          trim: (event: any) => compact({
            date: event?.date,
            event: event?.event,
            email: event?.email,
            subject: event?.subject,
            messageId: event?.messageId,
            templateId: event?.templateId,
            tag: event?.tag,
            reason: event?.reason,
            link: event?.link,
            from: event?.from,
          }),
        });
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The Brevo API v3 at https://api.brevo.com/v3, with the connected API key: paths start with /v3/, such as /v3/contacts/attributes, '
        + '/v3/contacts/segments, /v3/smsCampaigns, /v3/emailCampaigns/{id}/status, /v3/emailCampaigns/{id}/sharedUrl, /v3/webhooks or /v3/crm/deals. '
        + 'Reference: https://developers.brevo.com/reference.',
      basePath: '/v3/',
      guard(request) {
        const [base, area] = routedParts(request.segments);
        if (base !== 'v3') throw new ToolFailure('The path must stay under /v3/. Nothing was sent.');
        // Users, invitations and sub-accounts (and their API keys) are account administration, not the agent's job.
        if (request.method !== 'GET' && (area === 'organization' || area === 'corporate')) {
          throw new ToolFailure('Changing the Brevo organization or its sub-accounts is not available here. Nothing was sent.');
        }
      },
    }),
  ],
});

export = connector;
