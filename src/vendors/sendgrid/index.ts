// Twilio SendGrid, through the SendGrid Web API v3 (https://www.twilio.com/docs/sendgrid/api-reference).
//
// Credential: `apikey`, a SendGrid API key from SendGrid -> Settings -> API
// Keys (it starts with SG.). It is sent as a Bearer token to
// https://api.sendgrid.com/v3/ only. The tools cover email sending (with
// templates and attachments from public URLs), Marketing Campaigns contacts,
// lists, custom fields and Single Sends, dynamic templates, verified senders,
// unsubscribe groups, statistics and suppressions; api_get and api_request
// reach the rest of the API.

import { apiTools, defineConnector, ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';
import {
  base64,
  compact,
  isoFromUnix,
  offsetList,
  tokenList,
  trimContact,
  trimSingleSend,
  trimTemplate,
  typeFromName,
} from './shape.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'SendGrid';

const EMAIL: JsonSchema = {
  type: 'string',
  minLength: 3,
  maxLength: 320,
  pattern: '^[^@\\s]+@[^@\\s]+$',
  description: 'An email address.',
};
const PERSON: JsonSchema = {
  type: 'object',
  properties: { email: EMAIL, name: { type: 'string', maxLength: 200, description: 'The display name.' } },
  required: ['email'],
  additionalProperties: false,
};
const PEOPLE = (what: string, max: number): JsonSchema => ({
  type: 'array',
  items: PERSON,
  maxItems: max,
  description: `${what}: [{"email": "ann@example.com", "name": "Ann"}], up to ${max}.`,
});
const CURSOR: JsonSchema = { type: 'string', description: 'nextCursor from the previous result; pass the other arguments unchanged.' };
const UUID: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$', description: 'A SendGrid id.' };
const DATE = (what: string): JsonSchema => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${what}, as YYYY-MM-DD.` });
const TEMPLATE_ID: JsonSchema = {
  type: 'string',
  pattern: '^(d-)?[A-Za-z0-9-]{8,64}$',
  description: 'A template id, such as d-0123456789abcdef0123456789abcdef for a dynamic template (see list_templates).',
};

/** The most a single attachment and all of them together may weigh before base64 (SendGrid's message limit is 30 MB). */
const ATTACHMENT_MAX = 10 * 1024 * 1024;
const ATTACHMENTS_TOTAL_MAX = 20 * 1024 * 1024;

const SUPPRESSIONS = ['bounces', 'blocks', 'spam_reports', 'invalid_emails', 'unsubscribes'] as const;

const SINGLE_SEND_FIELDS: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 100, description: 'The Single Send name (recipients do not see it).' },
  subject: { type: 'string', minLength: 1, maxLength: 500, description: 'The subject line.' },
  html_content: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The HTML body; {{{unsubscribe}}} and {{{Weblink}}} work in it.' },
  plain_content: { type: 'string', maxLength: 1_000_000, description: 'The plain text body (generated from the HTML when left out).' },
  design_id: { type: 'string', maxLength: 100, description: 'A saved design to use as the body, instead of html_content.' },
  sender_id: { type: 'integer', minimum: 1, description: 'The verified sender (see list_senders).' },
  suppression_group_id: { type: 'integer', minimum: 1, description: 'The unsubscribe group (see list_unsubscribe_groups). Scheduling needs this or custom_unsubscribe_url.' },
  custom_unsubscribe_url: { type: 'string', format: 'uri', maxLength: 2000, description: 'Your own unsubscribe page, instead of a suppression group.' },
  list_ids: { type: 'array', items: UUID, maxItems: 50, uniqueItems: true, description: 'The lists to send to (see list_lists).' },
  segment_ids: { type: 'array', items: UUID, maxItems: 10, uniqueItems: true, description: 'Segments to send to.' },
  send_to_all: { type: 'boolean', description: 'true to send to all contacts instead of lists or segments.' },
  categories: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 10, description: 'Categories for statistics.' },
  ip_pool: { type: 'string', maxLength: 64, description: 'The IP pool to send from.' },
};

interface SingleSendArgs {
  name?: string;
  subject?: string;
  html_content?: string;
  plain_content?: string;
  design_id?: string;
  sender_id?: number;
  suppression_group_id?: number;
  custom_unsubscribe_url?: string;
  list_ids?: string[];
  segment_ids?: string[];
  send_to_all?: boolean;
  categories?: string[];
  ip_pool?: string;
}

function singleSendBody(args: SingleSendArgs): Record<string, unknown> {
  const sendTo = compact({ list_ids: args.list_ids, segment_ids: args.segment_ids, all: args.send_to_all });
  const config = compact({
    subject: args.subject,
    html_content: args.html_content,
    plain_content: args.plain_content,
    generate_plain_content: args.html_content !== undefined && args.plain_content === undefined ? true : undefined,
    design_id: args.design_id,
    editor: args.html_content !== undefined ? 'code' : undefined,
    sender_id: args.sender_id,
    suppression_group_id: args.suppression_group_id,
    custom_unsubscribe_url: args.custom_unsubscribe_url,
    ip_pool: args.ip_pool,
  });
  return compact({
    name: args.name,
    categories: args.categories,
    send_to: Object.keys(sendTo).length ? sendTo : undefined,
    email_config: Object.keys(config).length ? config : undefined,
  });
}

interface Attachment {
  url: string;
  filename: string;
  type?: string;
  disposition?: 'attachment' | 'inline';
  content_id?: string;
}

/** Downloads each attachment from its public URL (through the host's guard) and encodes it for SendGrid. */
async function attachmentsFor(h: ToolHelpers, attachments: Attachment[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.disposition === 'inline' && !attachment.content_id) {
      throw new ToolFailure(`The inline attachment ${attachment.filename} needs a content_id to be shown in the HTML (cid:...). Nothing was sent.`);
    }
    const { bytes } = await h.media(attachment.url, { what: `attachment ${attachment.filename}`, maxBytes: ATTACHMENT_MAX });
    total += bytes.byteLength;
    if (total > ATTACHMENTS_TOTAL_MAX) {
      throw new ToolFailure('The attachments together are larger than 20 MB, more than a SendGrid email can carry. Nothing was sent.');
    }
    out.push(compact({
      content: base64(bytes),
      filename: attachment.filename,
      type: attachment.type ?? typeFromName(attachment.filename),
      disposition: attachment.disposition,
      content_id: attachment.content_id,
    }));
  }
  return out;
}

/**
 * A path as a server that decodes percent-escapes routes it: the decoded segments split again at "/" and "\",
 * each cut at ";" (a path parameter), lower-cased, with empty and "." parts dropped and ".." resolved. The guard
 * decides on these parts, so an escape (api%5Fkeys, teammate%73) or a capital letter cannot get past it.
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

/** Account administration the generic tools may read but never change (scopes: teammates' access requests). */
const ADMIN_AREAS = new Set(['teammates', 'subusers', 'access_settings', 'sso', 'scopes']);
/** The account's own sign-in details under /v3/user/: changing them could hand the account to someone else. */
const SIGN_IN_DETAILS = new Set(['email', 'username', 'password']);

const connector = defineConnector({
  vendor: 'sendgrid',
  label: LABEL,
  origins: ['https://api.sendgrid.com'],
  credentials: ['apikey'],
  credentialLabels: { apikey: 'SendGrid API key' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['apikey']}` }),
  tools: [
    {
      name: 'get_account',
      kind: 'read',
      title: 'Check the SendGrid API key',
      description:
        'What the connected API key may do: its number of scopes and whether it can send mail, manage Marketing Campaigns, templates, senders, '
        + 'suppressions and statistics, plus the account type and sender reputation when the key may read them. A quick connection check.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/v3/scopes' });
        const scopes: string[] = Array.isArray(data?.scopes) ? data.scopes.map(String) : [];
        const has = (prefix: string) => scopes.some((scope) => scope === prefix || scope.startsWith(`${prefix}.`));
        const result: Record<string, unknown> = {
          scopes: scopes.length,
          can: {
            send_mail: has('mail.send'),
            marketing: has('marketing'),
            templates: has('templates'),
            senders: has('verified_senders') || has('marketing.senders'),
            suppressions: has('suppression') || has('asm'),
            stats: has('stats'),
            email_activity: has('messages'),
          },
        };
        if (scopes.includes('user.account.read')) {
          const account = await h.api({ path: '/v3/user/account' });
          result['account'] = compact({ type: account.data?.type, reputation: account.data?.reputation });
        }
        return result;
      },
    },
    {
      name: 'send_email',
      kind: 'create',
      check: 'search_email_activity',
      title: 'Send an email with SendGrid',
      description:
        'Sends one email: to up to 1,000 recipients (each gets their own copy unless separate_copies is false), with cc, bcc, reply-to, '
        + 'and a subject with a text and/or HTML body, or a dynamic template_id with dynamic_template_data. Attachments are public https URLs '
        + '(up to 10 files, 20 MB in all). send_at schedules it up to 72 hours ahead; sandbox_mode checks the request without sending. '
        + 'Returns the message id.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { ...PERSON, description: 'The sender: a verified sender or an address of an authenticated domain.' },
          to: PEOPLE('The recipients', 1000),
          cc: PEOPLE('Cc recipients', 100),
          bcc: PEOPLE('Bcc recipients', 100),
          separate_copies: {
            type: 'boolean',
            default: true,
            description: 'true (default): each address in to gets its own copy and sees only itself. false: one email to everyone in to, cc and bcc, as a mail program sends it.',
          },
          reply_to: PERSON,
          subject: { type: 'string', minLength: 1, maxLength: 998, description: 'The subject line (a dynamic template has its own).' },
          text: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The plain text body.' },
          html: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The HTML body.' },
          template_id: TEMPLATE_ID,
          dynamic_template_data: { type: 'object', description: 'Values for the template\'s {{handlebars}}, e.g. {"first_name": "Ann"}, for every recipient.' },
          personalizations: {
            type: 'array',
            maxItems: 1000,
            items: { type: 'object' },
            description: 'Advanced, instead of to/cc/bcc: SendGrid personalizations, e.g. [{"to": [{"email": "a@example.com"}], "dynamic_template_data": {"name": "Ann"}}].',
          },
          categories: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 10, description: 'Categories for statistics.' },
          custom_args: { type: 'object', description: 'Your own values that come back in event webhooks, e.g. {"order_id": "1234"}.' },
          send_at: { type: 'integer', minimum: 0, description: 'When to send, as a Unix time in seconds, up to 72 hours ahead.' },
          asm_group_id: { type: 'integer', minimum: 1, description: 'The unsubscribe group (see list_unsubscribe_groups) the email belongs to.' },
          headers: { type: 'object', description: 'Extra email headers, e.g. {"X-Order": "1234"}.' },
          attachments: {
            type: 'array',
            maxItems: 10,
            description: 'Files to attach, downloaded from public https URLs: [{"url": "https://...", "filename": "invoice.pdf"}].',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri', maxLength: 2000, description: 'A public https URL of the file, up to 10 MB.' },
                filename: { type: 'string', minLength: 1, maxLength: 255, description: 'The file name recipients see, with its extension.' },
                type: { type: 'string', maxLength: 255, description: 'The media type, e.g. application/pdf (from the file name when left out).' },
                disposition: { type: 'string', enum: ['attachment', 'inline'], description: 'attachment (default) or inline (shown in the HTML).' },
                content_id: { type: 'string', maxLength: 255, description: 'For inline files: the id the HTML uses as cid:<content_id>.' },
              },
              required: ['url', 'filename'],
              additionalProperties: false,
            },
          },
          sandbox_mode: { type: 'boolean', default: false, description: 'true to have SendGrid check the request without sending anything.' },
          ip_pool_name: { type: 'string', maxLength: 64, description: 'The IP pool to send from.' },
        },
        required: ['from'],
        additionalProperties: false,
      },
      async run(args: {
        from: { email: string; name?: string };
        to?: { email: string; name?: string }[];
        cc?: { email: string; name?: string }[];
        bcc?: { email: string; name?: string }[];
        separate_copies: boolean;
        reply_to?: { email: string; name?: string };
        subject?: string;
        text?: string;
        html?: string;
        template_id?: string;
        dynamic_template_data?: Record<string, unknown>;
        personalizations?: Record<string, unknown>[];
        categories?: string[];
        custom_args?: Record<string, unknown>;
        send_at?: number;
        asm_group_id?: number;
        headers?: Record<string, unknown>;
        attachments?: Attachment[];
        sandbox_mode: boolean;
        ip_pool_name?: string;
      }, h) {
        if (args.personalizations?.length && (args.to?.length || args.cc?.length || args.bcc?.length)) {
          throw new ToolFailure('Give to/cc/bcc or personalizations, not both. Nothing was sent.');
        }
        if (!args.personalizations?.length && !args.to?.length) throw new ToolFailure('Give at least one recipient in to (or personalizations). Nothing was sent.');
        if (!args.template_id) {
          if (!args.subject) throw new ToolFailure('subject is required without template_id. Nothing was sent.');
          if (!args.text && !args.html) throw new ToolFailure('Give text or html, or a template_id. Nothing was sent.');
        }
        const to = args.to ?? [];
        const copied = Boolean(args.cc?.length || args.bcc?.length);
        if (!args.personalizations?.length && args.separate_copies && to.length > 1 && copied) {
          throw new ToolFailure('cc and bcc go on one shared email: set separate_copies to false, or send each recipient their own email. Nothing was sent.');
        }
        const shared = (recipients: { email: string; name?: string }[]) => compact({
          to: recipients,
          cc: args.cc?.length ? args.cc : undefined,
          bcc: args.bcc?.length ? args.bcc : undefined,
          dynamic_template_data: args.dynamic_template_data,
        });
        const personalizations = args.personalizations?.length
          ? args.personalizations
          : args.separate_copies && to.length > 1
            ? to.map((recipient) => shared([recipient]))
            : [shared(to)];
        const content = [
          ...(args.text ? [{ type: 'text/plain', value: args.text }] : []),
          ...(args.html ? [{ type: 'text/html', value: args.html }] : []),
        ];
        const attachments = args.attachments?.length ? await attachmentsFor(h, args.attachments) : undefined;
        const { status, headers } = await h.api({
          method: 'POST',
          path: '/v3/mail/send',
          json: compact({
            personalizations,
            from: args.from,
            reply_to: args.reply_to,
            subject: args.subject,
            content: content.length ? content : undefined,
            template_id: args.template_id,
            categories: args.categories?.length ? args.categories : undefined,
            custom_args: args.custom_args,
            send_at: args.send_at,
            asm: args.asm_group_id !== undefined ? { group_id: args.asm_group_id } : undefined,
            headers: args.headers,
            attachments,
            ip_pool_name: args.ip_pool_name,
            mail_settings: args.sandbox_mode ? { sandbox_mode: { enable: true } } : undefined,
          }),
          write: true,
          errors: { 400: 'SendGrid did not accept the email', 403: 'SendGrid refused to send it (the API key may lack Mail Send, or the sender is not verified)' },
        });
        return compact({
          accepted: true,
          sandbox: args.sandbox_mode || undefined,
          status,
          messageId: headers.get('x-message-id') ?? undefined,
          recipients: personalizations.length,
          scheduled: args.send_at !== undefined ? isoFromUnix(args.send_at) : undefined,
        });
      },
    },
    {
      name: 'search_email_activity',
      kind: 'read',
      title: 'Search SendGrid email activity',
      description:
        'Recent emails with their status (delivered, not delivered, processing), opens and clicks, found with a SendGrid activity query such as '
        + 'to_email="ann@example.com" or subject="Your order". It shows whether an email went out. Needs the Email Activity history add-on.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 1000, description: 'An activity query, e.g. to_email="ann@example.com" AND status="delivered".' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20, description: 'At most this many emails (default 20).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string; limit: number }, h) {
        const { data } = await h.api({
          path: '/v3/messages',
          query: { query: args.query, limit: args.limit },
          errors: { 403: 'SendGrid refused the activity search (it needs the Email Activity history add-on and the messages.read scope)' },
        });
        const messages: any[] = Array.isArray(data?.messages) ? data.messages : [];
        return h.page({
          key: 'messages',
          items: messages.map((message) => compact({
            msg_id: message?.msg_id,
            to_email: message?.to_email,
            from_email: message?.from_email,
            subject: message?.subject,
            status: message?.status,
            opens_count: message?.opens_count,
            clicks_count: message?.clicks_count,
            last_event_time: message?.last_event_time,
          })),
          resumeAt: () => '',
        });
      },
    },
    {
      name: 'upsert_contacts',
      kind: 'update',
      // A job_id comes back only with a clear answer, so an unclear one is checked on the contacts themselves.
      check: 'search_contacts',
      title: 'Add or update SendGrid contacts',
      description:
        'Adds contacts to Marketing Campaigns or updates those with the same email (or other identifier), optionally adding them to lists. '
        + 'Up to 1,000 at a time. SendGrid applies it in the background: the result has a job_id for get_import_status.',
      inputSchema: {
        type: 'object',
        properties: {
          list_ids: { type: 'array', items: UUID, maxItems: 50, uniqueItems: true, description: 'Lists to add the contacts to (see list_lists).' },
          contacts: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            description: 'The contacts: email (or phone_number_id, external_id or anonymous_id), first_name, last_name, city, country and other reserved fields, '
              + 'and custom_fields keyed by field id (see list_custom_fields), e.g. {"email": "ann@example.com", "first_name": "Ann", "custom_fields": {"e1_T": "VIP"}}.',
            items: {
              type: 'object',
              properties: {
                email: EMAIL,
                first_name: { type: 'string', maxLength: 50 },
                last_name: { type: 'string', maxLength: 50 },
                custom_fields: { type: 'object', description: 'Custom field values keyed by field id.' },
              },
            },
          },
        },
        required: ['contacts'],
        additionalProperties: false,
      },
      async run(args: { list_ids?: string[]; contacts: Record<string, unknown>[] }, h) {
        const ids = ['email', 'phone_number_id', 'external_id', 'anonymous_id'];
        const index = args.contacts.findIndex((contact) => !ids.some((key) => typeof contact[key] === 'string' && contact[key]));
        if (index !== -1) throw new ToolFailure(`contacts[${index}] needs an email, phone_number_id, external_id or anonymous_id. Nothing was changed.`);
        const { status, data } = await h.api({
          method: 'PUT',
          path: '/v3/marketing/contacts',
          json: compact({ list_ids: args.list_ids, contacts: args.contacts }),
          write: true,
          errors: { 400: 'SendGrid did not accept the contacts' },
        });
        return compact({ accepted: status === 202 || status === 200, job_id: data?.job_id, contacts: args.contacts.length });
      },
    },
    {
      name: 'get_import_status',
      kind: 'read',
      title: 'Get a SendGrid contacts job',
      description: 'The status of a contacts import or delete job (pending, completed, errored, failed) with the counts of contacts requested, created, updated, deleted and in error.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { ...UUID, description: 'The job_id from upsert_contacts or delete_contacts.' } },
        required: ['job_id'],
        additionalProperties: false,
      },
      async run(args: { job_id: string }, h) {
        const { data } = await h.api({ path: `/v3/marketing/contacts/imports/${encodeURIComponent(args.job_id)}`, errors: { 404: 'SendGrid has no contacts job with that id' } });
        return compact({ id: data?.id, status: data?.status, job_type: data?.job_type, results: data?.results, started_at: data?.started_at, finished_at: data?.finished_at });
      },
    },
    {
      name: 'search_contacts',
      kind: 'read',
      title: 'Search SendGrid contacts',
      description:
        'Finds Marketing Campaigns contacts with an SGQL query, e.g. email LIKE \'ann%\' AND CONTAINS(list_ids, \'<list id>\'), '
        + 'first_name = \'Ann\', contact_id = \'<contact id>\', or created_at > TIMESTAMP \'2026-01-01T00:00:00Z\'. Returns the number found and up to 50 of them.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 5000, description: 'The SGQL condition.' } },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args: { query: string }, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/marketing/contacts/search', json: { query: args.query }, safe: true });
        const contacts: unknown[] = Array.isArray(data?.result) ? data.result : [];
        return h.page({ key: 'contacts', items: contacts.map(trimContact), extra: { contact_count: data?.contact_count }, resumeAt: () => '' });
      },
    },
    {
      name: 'get_contacts_by_email',
      kind: 'read',
      title: 'Get SendGrid contacts by email',
      description: 'Looks up Marketing Campaigns contacts by email address, up to 100 at a time, with their fields, lists and custom fields; addresses with no contact are named.',
      inputSchema: {
        type: 'object',
        properties: { emails: { type: 'array', items: EMAIL, minItems: 1, maxItems: 100, uniqueItems: true, description: 'Email addresses.' } },
        required: ['emails'],
        additionalProperties: false,
      },
      async run(args: { emails: string[] }, h) {
        const { data } = await h.api({
          method: 'POST',
          path: '/v3/marketing/contacts/search/emails',
          json: { emails: args.emails },
          safe: true,
          errors: { 404: 'SendGrid has no contact with any of these emails' },
        });
        const found: Record<string, unknown>[] = [];
        const missing: string[] = [];
        for (const [email, value] of Object.entries((data?.result ?? {}) as Record<string, any>)) {
          if (value?.contact) found.push(trimContact(value.contact));
          else missing.push(email);
        }
        return h.page({ key: 'contacts', items: found, extra: missing.length ? { not_found: missing } : {}, resumeAt: () => '' });
      },
    },
    {
      name: 'delete_contacts',
      kind: 'delete',
      check: 'search_contacts',
      title: 'Delete SendGrid contacts',
      description: 'Deletes Marketing Campaigns contacts by id (from search_contacts), up to 100 at a time. SendGrid deletes them in the background: the result has a job_id for get_import_status.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: UUID, minItems: 1, maxItems: 100, uniqueItems: true, description: 'Contact ids.' } },
        required: ['ids'],
        additionalProperties: false,
      },
      async run(args: { ids: string[] }, h) {
        const { data } = await h.api({ method: 'DELETE', path: '/v3/marketing/contacts', query: { ids: args.ids.join(',') }, write: true });
        return compact({ accepted: true, job_id: data?.job_id, contacts: args.ids.length });
      },
    },
    {
      name: 'list_custom_fields',
      kind: 'read',
      title: 'List SendGrid contact fields',
      description: 'The custom fields of Marketing Campaigns contacts with their ids and types (custom_fields in upsert_contacts take these ids), and the reserved fields.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/v3/marketing/field_definitions' });
        const fields = (items: unknown) => (Array.isArray(items) ? items.map((field: any) => compact({ id: field?.id, name: field?.name, field_type: field?.field_type, read_only: field?.read_only })) : []);
        return { custom_fields: fields(data?.custom_fields), reserved_fields: fields(data?.reserved_fields) };
      },
    },
    {
      name: 'list_lists',
      kind: 'read',
      title: 'List SendGrid contact lists',
      description: 'Marketing Campaigns lists with their ids and contact counts. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Lists per page, 1 to 1000 (default 100).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { page_size: number; cursor?: string }, h) {
        return tokenList(h, args.cursor, {
          key: 'lists',
          path: '/v3/marketing/lists',
          pageSize: args.page_size,
          trim: (list: any) => compact({ id: list?.id, name: list?.name, contact_count: list?.contact_count }),
        });
      },
    },
    {
      name: 'create_list',
      kind: 'create',
      check: 'list_lists',
      title: 'Create a SendGrid contact list',
      description: 'Creates a Marketing Campaigns list and returns its id.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 100, description: 'The list name.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string }, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/marketing/lists', json: { name: args.name }, write: true });
        return compact({ id: data?.id, name: data?.name ?? args.name, contact_count: data?.contact_count });
      },
    },
    {
      name: 'delete_list',
      kind: 'delete',
      check: 'list_lists',
      title: 'Delete a SendGrid contact list',
      description: 'Deletes a list. Its contacts are kept unless delete_contacts is true, which deletes them too (for good).',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { ...UUID, description: 'The list id.' },
          delete_contacts: { type: 'boolean', default: false, description: 'true to delete the list\'s contacts as well.' },
        },
        required: ['list_id'],
        additionalProperties: false,
      },
      async run(args: { list_id: string; delete_contacts: boolean }, h) {
        const { data } = await h.api({
          method: 'DELETE',
          path: `/v3/marketing/lists/${encodeURIComponent(args.list_id)}`,
          query: { delete_contacts: args.delete_contacts || undefined },
          write: true,
          errors: { 404: 'SendGrid has no list with that id' },
        });
        return compact({ deleted: true, id: args.list_id, job_id: data?.job_id });
      },
    },
    {
      name: 'list_single_sends',
      kind: 'read',
      title: 'List SendGrid Single Sends',
      description: 'Single Sends (marketing emails) with their status (draft, scheduled, triggered), send time and categories, newest first. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Single Sends per page, 1 to 100 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { page_size: number; cursor?: string }, h) {
        return tokenList(h, args.cursor, { key: 'single_sends', path: '/v3/marketing/singlesends', pageSize: args.page_size, trim: (send: any) => trimSingleSend(send) });
      },
    },
    {
      name: 'get_single_send',
      kind: 'read',
      title: 'Get a SendGrid Single Send',
      description: 'One Single Send with its recipients, sender, unsubscribe setting, schedule, warnings and its HTML and text bodies (cut at 20,000 characters).',
      inputSchema: {
        type: 'object',
        properties: { single_send_id: { ...UUID, description: 'The Single Send id.' } },
        required: ['single_send_id'],
        additionalProperties: false,
      },
      async run(args: { single_send_id: string }, h) {
        const { data } = await h.api({ path: `/v3/marketing/singlesends/${encodeURIComponent(args.single_send_id)}`, errors: { 404: 'SendGrid has no Single Send with that id' } });
        return trimSingleSend(data, { html: true });
      },
    },
    {
      name: 'create_single_send',
      kind: 'create',
      check: 'list_single_sends',
      title: 'Create a SendGrid Single Send',
      description:
        'Creates a Single Send (a marketing email) as a draft; nothing is sent until schedule_single_send. For sending later it needs a subject, '
        + 'an HTML body or design, a sender_id, recipients (list_ids, segment_ids or send_to_all) and a suppression_group_id or custom_unsubscribe_url.',
      inputSchema: { type: 'object', properties: SINGLE_SEND_FIELDS, required: ['name'], additionalProperties: false },
      async run(args: SingleSendArgs, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/marketing/singlesends', json: singleSendBody(args), write: true, errors: { 400: 'SendGrid did not accept the Single Send' } });
        return trimSingleSend(data);
      },
    },
    {
      name: 'update_single_send',
      kind: 'update',
      check: 'get_single_send',
      title: 'Update a SendGrid Single Send',
      description: 'Changes a draft Single Send: only the fields given. A scheduled one must be unscheduled first.',
      inputSchema: {
        type: 'object',
        properties: { single_send_id: { ...UUID, description: 'The Single Send id.' }, ...SINGLE_SEND_FIELDS },
        required: ['single_send_id'],
        additionalProperties: false,
      },
      async run(args: SingleSendArgs & { single_send_id: string }, h) {
        const body = singleSendBody(args);
        if (!Object.keys(body).length) throw new ToolFailure('Nothing to change: give at least one field. Nothing was changed.');
        const { data } = await h.api({
          method: 'PATCH',
          path: `/v3/marketing/singlesends/${encodeURIComponent(args.single_send_id)}`,
          json: body,
          write: true,
          errors: { 404: 'SendGrid has no Single Send with that id', 400: 'SendGrid did not accept the change' },
        });
        return trimSingleSend(data);
      },
    },
    {
      name: 'schedule_single_send',
      kind: 'update',
      check: 'get_single_send',
      title: 'Schedule or send a SendGrid Single Send',
      description:
        'Schedules a Single Send for a time, or sends it now with send_at "now". Sending cannot be undone; a scheduled send can be stopped with '
        + 'unschedule_single_send before it starts. Check it first with get_single_send.',
      inputSchema: {
        type: 'object',
        properties: {
          single_send_id: { ...UUID, description: 'The Single Send id.' },
          send_at: {
            type: 'string',
            pattern: '^(now|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2}))$',
            description: '"now", or a future ISO 8601 date-time with a time zone, e.g. 2026-12-01T09:00:00Z.',
          },
        },
        required: ['single_send_id', 'send_at'],
        additionalProperties: false,
      },
      async run(args: { single_send_id: string; send_at: string }, h) {
        const { data } = await h.api({
          method: 'PUT',
          path: `/v3/marketing/singlesends/${encodeURIComponent(args.single_send_id)}/schedule`,
          json: { send_at: args.send_at },
          write: true,
          errors: { 404: 'SendGrid has no Single Send with that id', 400: 'SendGrid did not schedule the Single Send' },
        });
        return compact({ id: args.single_send_id, status: data?.status, send_at: data?.send_at });
      },
    },
    {
      name: 'unschedule_single_send',
      kind: 'update',
      check: 'get_single_send',
      title: 'Unschedule a SendGrid Single Send',
      description: 'Cancels a scheduled Single Send before it starts and turns it back into a draft.',
      inputSchema: {
        type: 'object',
        properties: { single_send_id: { ...UUID, description: 'The Single Send id.' } },
        required: ['single_send_id'],
        additionalProperties: false,
      },
      async run(args: { single_send_id: string }, h) {
        const { data } = await h.api({
          method: 'DELETE',
          path: `/v3/marketing/singlesends/${encodeURIComponent(args.single_send_id)}/schedule`,
          write: true,
          errors: { 404: 'SendGrid has no Single Send with that id' },
        });
        return compact({ id: args.single_send_id, status: data?.status ?? 'draft' });
      },
    },
    {
      name: 'delete_single_send',
      kind: 'delete',
      check: 'list_single_sends',
      title: 'Delete a SendGrid Single Send',
      description: 'Deletes a Single Send. Deleting a scheduled one cancels it; it cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: { single_send_id: { ...UUID, description: 'The Single Send id.' } },
        required: ['single_send_id'],
        additionalProperties: false,
      },
      async run(args: { single_send_id: string }, h) {
        await h.api({
          method: 'DELETE',
          path: `/v3/marketing/singlesends/${encodeURIComponent(args.single_send_id)}`,
          write: true,
          errors: { 404: 'SendGrid has no Single Send with that id' },
        });
        return { deleted: true, id: args.single_send_id };
      },
    },
    {
      name: 'get_single_send_stats',
      kind: 'read',
      title: 'Get SendGrid Single Send statistics',
      description: 'Delivery and engagement of a sent Single Send: requests, delivered, opens and unique opens, clicks and unique clicks, bounces, blocks, spam reports and unsubscribes (per A/B variation when it had one).',
      inputSchema: {
        type: 'object',
        properties: { single_send_id: { ...UUID, description: 'The Single Send id.' } },
        required: ['single_send_id'],
        additionalProperties: false,
      },
      async run(args: { single_send_id: string }, h) {
        const { data } = await h.api({ path: `/v3/marketing/stats/singlesends/${encodeURIComponent(args.single_send_id)}`, query: { aggregated_by: 'total' } });
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        return { id: args.single_send_id, results: results.map((row) => compact({ ab_variation: row?.ab_variation, ab_phase: row?.ab_phase, stats: row?.stats })) };
      },
    },
    {
      name: 'list_templates',
      kind: 'read',
      title: 'List SendGrid templates',
      description: 'Transactional templates (dynamic by default, or legacy) with their versions, which one is active, and their subjects. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          generation: { type: 'string', enum: ['dynamic', 'legacy'], default: 'dynamic', description: 'dynamic (default) or legacy templates.' },
          page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Templates per page, 1 to 200 (default 50).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { generation: string; page_size: number; cursor?: string }, h) {
        return tokenList(h, args.cursor, {
          key: 'templates',
          path: '/v3/templates',
          query: { generations: args.generation },
          pageSize: args.page_size,
          trim: (template: any) => trimTemplate(template),
        });
      },
    },
    {
      name: 'get_template',
      kind: 'read',
      title: 'Get a SendGrid template',
      description: 'One template with its versions, and the active version\'s subject, HTML and text (cut at 20,000 characters).',
      inputSchema: {
        type: 'object',
        properties: { template_id: TEMPLATE_ID },
        required: ['template_id'],
        additionalProperties: false,
      },
      async run(args: { template_id: string }, h) {
        const { data } = await h.api({ path: `/v3/templates/${encodeURIComponent(args.template_id)}`, errors: { 404: 'SendGrid has no template with that id' } });
        return trimTemplate(data, { html: true });
      },
    },
    {
      name: 'create_template',
      kind: 'create',
      check: 'list_templates',
      title: 'Create a SendGrid template',
      description: 'Creates an empty transactional template (dynamic by default) and returns its id; add its content with create_template_version.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'The template name.' },
          generation: { type: 'string', enum: ['dynamic', 'legacy'], default: 'dynamic', description: 'dynamic (handlebars, default) or legacy.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string; generation: string }, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/templates', json: { name: args.name, generation: args.generation }, write: true });
        return trimTemplate(data);
      },
    },
    {
      name: 'create_template_version',
      kind: 'create',
      check: 'get_template',
      title: 'Add a version to a SendGrid template',
      description:
        'Adds a version to a template: subject and HTML (with {{handlebars}} such as {{first_name}}, {{#if}} and {{#each}}), plain text, and whether '
        + 'it becomes the active version that emails use (default true).',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: TEMPLATE_ID,
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'The version name, e.g. v2.' },
          subject: { type: 'string', minLength: 1, maxLength: 255, description: 'The subject line; it can use handlebars.' },
          html_content: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'The HTML body.' },
          plain_content: { type: 'string', maxLength: 1_000_000, description: 'The plain text body (generated from the HTML when left out).' },
          active: { type: 'boolean', default: true, description: 'true (default) to make it the version in use.' },
          test_data: { type: 'object', description: 'Sample values for previews in SendGrid.' },
        },
        required: ['template_id', 'name', 'subject', 'html_content'],
        additionalProperties: false,
      },
      async run(args: { template_id: string; name: string; subject: string; html_content: string; plain_content?: string; active: boolean; test_data?: Record<string, unknown> }, h) {
        const { data } = await h.api({
          method: 'POST',
          path: `/v3/templates/${encodeURIComponent(args.template_id)}/versions`,
          json: compact({
            name: args.name,
            subject: args.subject,
            html_content: args.html_content,
            plain_content: args.plain_content,
            generate_plain_content: args.plain_content === undefined ? true : undefined,
            active: args.active ? 1 : 0,
            editor: 'code',
            test_data: args.test_data ? JSON.stringify(args.test_data) : undefined,
          }),
          write: true,
          errors: { 404: 'SendGrid has no template with that id', 400: 'SendGrid did not accept the version' },
        });
        return compact({ id: data?.id, template_id: data?.template_id ?? args.template_id, name: data?.name, active: data?.active, subject: data?.subject });
      },
    },
    {
      name: 'list_senders',
      kind: 'read',
      title: 'List SendGrid verified senders',
      description: 'Verified sender identities with their ids (the sender_id of Single Sends), from and reply-to addresses, and whether they are verified.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Senders per page, 1 to 100 (default 100).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { limit: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const last = typeof state?.['l'] === 'number' ? state['l'] : undefined;
        const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
        const limit = typeof state?.['n'] === 'number' ? state['n'] : args.limit;
        const { data } = await h.api({ path: '/v3/verified_senders', query: { limit, lastSeenID: last } });
        const senders: any[] = Array.isArray(data?.results) ? data.results : [];
        const lastId = senders[senders.length - 1]?.id;
        return h.page({
          key: 'senders',
          items: senders.map((sender) => compact({
            id: sender?.id,
            nickname: sender?.nickname,
            from_email: sender?.from_email,
            from_name: sender?.from_name,
            reply_to: sender?.reply_to,
            verified: sender?.verified,
            locked: sender?.locked,
          })).slice(skip),
          resumeAt: (index) => h.makeCursor({ ...(last !== undefined ? { l: last } : {}), n: limit, s: skip + index }),
          ...(senders.length >= limit && typeof lastId === 'number' ? { nextPage: h.makeCursor({ l: lastId, n: limit, s: 0 }) } : {}),
        });
      },
    },
    {
      name: 'create_sender',
      kind: 'create',
      check: 'list_senders',
      title: 'Add a SendGrid verified sender',
      description: 'Adds a sender identity. SendGrid emails the from address a verification link; the sender can send only once it is verified.',
      inputSchema: {
        type: 'object',
        properties: {
          nickname: { type: 'string', minLength: 1, maxLength: 100, description: 'A name for the sender in SendGrid.' },
          from_email: EMAIL,
          from_name: { type: 'string', maxLength: 256, description: 'The From name recipients see.' },
          reply_to: EMAIL,
          reply_to_name: { type: 'string', maxLength: 256, description: 'The reply-to name.' },
          address: { type: 'string', minLength: 1, maxLength: 100, description: 'The street address (anti-spam laws require one).' },
          address2: { type: 'string', maxLength: 100, description: 'More of the address.' },
          city: { type: 'string', minLength: 1, maxLength: 150, description: 'The city.' },
          state: { type: 'string', maxLength: 2, description: 'The two-letter state, for the US.' },
          zip: { type: 'string', maxLength: 10, description: 'The postal code.' },
          country: { type: 'string', minLength: 1, maxLength: 100, description: 'The country.' },
        },
        required: ['nickname', 'from_email', 'reply_to', 'address', 'city', 'country'],
        additionalProperties: false,
      },
      async run(args: Record<string, string>, h) {
        const { data } = await h.api({ method: 'POST', path: '/v3/verified_senders', json: compact({ ...args }), write: true, errors: { 400: 'SendGrid did not accept the sender' } });
        return compact({ id: data?.id, nickname: data?.nickname, from_email: data?.from_email, verified: data?.verified, note: 'SendGrid sent a verification email to the from address.' });
      },
    },
    {
      name: 'list_unsubscribe_groups',
      kind: 'read',
      title: 'List SendGrid unsubscribe groups',
      description: 'Unsubscribe (suppression) groups with their ids, names, whether one is the default, and how many have unsubscribed. Single Sends and emails name one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, h) {
        const { data } = await h.api({ path: '/v3/asm/groups' });
        const groups: any[] = Array.isArray(data) ? data : [];
        return { groups: groups.map((group) => compact({ id: group?.id, name: group?.name, description: group?.description, is_default: group?.is_default, unsubscribes: group?.unsubscribes })) };
      },
    },
    {
      name: 'get_stats',
      kind: 'read',
      title: 'Get SendGrid email statistics',
      description:
        'Email statistics for a date range, in total and per day, week or month: requests, delivered, opens, clicks, bounces, blocks, drops, '
        + 'spam reports and unsubscribes, for the whole account or for up to 10 categories. Pass nextCursor back as cursor for more periods.',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: DATE('The first day'),
          end_date: DATE('The last day (default today)'),
          aggregated_by: { type: 'string', enum: ['day', 'week', 'month'], default: 'day', description: 'Periods of a day (default), a week or a month.' },
          categories: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 10, uniqueItems: true, description: 'Only these categories, each counted on its own.' },
          cursor: CURSOR,
        },
        required: ['start_date'],
        additionalProperties: false,
      },
      async run(args: { start_date: string; end_date?: string; aggregated_by: string; categories?: string[]; cursor?: string }, h) {
        const skip = (() => {
          const state = h.cursor(args.cursor);
          return typeof state?.['s'] === 'number' ? state['s'] : 0;
        })();
        const { data } = await h.api({
          path: args.categories?.length ? '/v3/categories/stats' : '/v3/stats',
          query: { start_date: args.start_date, end_date: args.end_date, aggregated_by: args.aggregated_by, categories: args.categories },
        });
        const rows: any[] = Array.isArray(data) ? data : [];
        const totals: Record<string, Record<string, number>> = {};
        const periods = rows.map((row) => ({
          date: row?.date,
          stats: (Array.isArray(row?.stats) ? row.stats : []).map((stat: any) => {
            const name = typeof stat?.name === 'string' ? stat.name : 'all';
            const metrics: Record<string, number> = {};
            for (const [key, value] of Object.entries((stat?.metrics ?? {}) as Record<string, unknown>)) {
              if (typeof value !== 'number') continue;
              totals[name] ??= {};
              totals[name][key] = (totals[name][key] ?? 0) + value;
              if (value !== 0) metrics[key] = value;
            }
            return compact({ name: name === 'all' ? undefined : name, metrics });
          }),
        }));
        return h.page({
          key: 'periods',
          items: periods.slice(skip),
          extra: { totals },
          resumeAt: (index) => h.makeCursor({ s: skip + index }),
        });
      },
    },
    {
      name: 'list_suppressions',
      kind: 'read',
      title: 'List SendGrid suppressions',
      description:
        'Addresses SendGrid will not send to: bounces, blocks, spam reports, invalid emails or global unsubscribes, newest first, with when and why. '
        + 'Filter by a time range or one email. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...SUPPRESSIONS], description: 'bounces, blocks, spam_reports, invalid_emails or unsubscribes.' },
          email: EMAIL,
          start_time: { type: 'integer', minimum: 0, description: 'Only entries since this Unix time (seconds).' },
          end_time: { type: 'integer', minimum: 0, description: 'Only entries up to this Unix time (seconds).' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Entries per page, 1 to 500 (default 100).' },
          cursor: CURSOR,
        },
        required: ['type'],
        additionalProperties: false,
      },
      async run(args: { type: string; email?: string; start_time?: number; end_time?: number; limit: number; cursor?: string }, h) {
        return offsetList(h, args.cursor, {
          key: 'suppressions',
          path: `/v3/suppression/${args.type}`,
          limit: args.limit,
          query: { email: args.email, start_time: args.start_time, end_time: args.end_time },
          trim: (entry: any) => compact({ email: entry?.email, created: isoFromUnix(entry?.created), reason: entry?.reason, status: entry?.status, ip: entry?.ip }),
        });
      },
    },
    {
      name: 'delete_suppression',
      kind: 'delete',
      check: 'list_suppressions',
      title: 'Remove an address from a SendGrid suppression list',
      description:
        'Removes one email address from a suppression list (bounces, blocks, spam_reports, invalid_emails or unsubscribes), so SendGrid sends '
        + 'to it again. Only do this when the person asked for it or the address was fixed.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...SUPPRESSIONS], description: 'The list to remove it from.' },
          email: EMAIL,
        },
        required: ['type', 'email'],
        additionalProperties: false,
      },
      async run(args: { type: string; email: string }, h) {
        const path = args.type === 'unsubscribes'
          ? `/v3/asm/suppressions/global/${encodeURIComponent(args.email)}`
          : `/v3/suppression/${args.type}/${encodeURIComponent(args.email)}`;
        await h.api({ method: 'DELETE', path, write: true, errors: { 404: `SendGrid has no such address in ${args.type}` } });
        return { removed: true, type: args.type, email: args.email };
      },
    },
    ...apiTools({
      label: LABEL,
      description:
        'The SendGrid Web API v3 at https://api.sendgrid.com/v3, with the connected API key: paths start with /v3/, such as /v3/marketing/segments/2.0, '
        + '/v3/marketing/contacts/count, /v3/marketing/lists/{id}, /v3/asm/groups/{id}/suppressions, /v3/user/webhooks/event/settings or /v3/whitelabel/domains. '
        + 'Reference: https://docs.sendgrid.com/api-reference.',
      basePath: '/v3/',
      guard(request) {
        const [base, area = '', detail = ''] = routedParts(request.segments);
        if (base !== 'v3') throw new ToolFailure('The path must stay under /v3/. Nothing was sent.');
        if (area === 'api_keys') throw new ToolFailure('SendGrid API keys are not available here. Nothing was sent.');
        // Teammates, subusers, access settings and the account's sign-in details are account administration.
        if (request.method !== 'GET' && (ADMIN_AREAS.has(area) || (area === 'user' && SIGN_IN_DETAILS.has(detail)))) {
          throw new ToolFailure(
            'Changing SendGrid teammates, subusers, access settings, single sign-on or the account\'s email, username or password is not available here. Nothing was sent.',
          );
        }
      },
    }),
  ],
});

export = connector;
