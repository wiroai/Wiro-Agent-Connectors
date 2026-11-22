// Gmail, through the Gmail API v1 (https://developers.google.com/gmail/api/reference/rest).
//
// Credential: `access_token`, an OAuth 2.0 access token of the mailbox's
// Google account with the scope https://www.googleapis.com/auth/gmail.modify
// (read, label, draft and send; never delete for good). The host refreshes
// it; the module sends it to https://gmail.googleapis.com/gmail/v1/users/me/
// only. One connection is one mailbox, so there is no account picker.

import {
  apiTools,
  base64UrlEncode,
  defineConnector,
  ToolFailure,
  truncate,
  utf8Bytes,
  type ApiToolRequest,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { compact, googleApi, sliceText } from './google.js';
import { bodyText, buildMessage, decodeEntities, formatAddress, header, oneLine, readPayload, type Attachment } from './mime.js';

type Schema = ToolDefinition['inputSchema'];

const BASE = '/gmail/v1/users/me';
/** The most body text get_message returns in one call, in UTF-8 bytes. */
const BODY_BYTES = 24_000;
/** The most body text get_thread returns per message. */
const THREAD_BODY_CHARS = 3_000;
/** Message reads at a time while listing (Gmail allows short bursts per user). */
const PARALLEL_READS = 5;
const LIST_HEADERS = ['From', 'To', 'Subject', 'Date'];

const ID = '^[A-Za-z0-9_-]{1,100}$';
const MESSAGE_ID: Schema = { type: 'string', pattern: ID, description: 'The message id, from list_messages.' };
const MESSAGE_IDS: Schema = {
  type: 'array',
  items: { type: 'string', pattern: ID },
  minItems: 1,
  maxItems: 1000,
  uniqueItems: true,
  description: 'Message ids, from list_messages (1 to 1000).',
};
const LABEL_IDS: Schema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 200 },
  maxItems: 100,
  uniqueItems: true,
};
const ADDRESSES: Schema = {
  type: 'array',
  items: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\r\\n]*@[^\\r\\n]*$' },
  maxItems: 100,
  uniqueItems: true,
};
const CURSOR: Schema = { type: 'string', description: 'nextCursor from the previous result (send the same filters with it).' };

const MAIL_FIELDS: Record<string, Schema> = {
  to: { ...ADDRESSES, description: 'Recipients, as "name@example.com" or "Name <name@example.com>". A reply goes to the original sender when left out.' },
  cc: { ...ADDRESSES, description: 'Copy recipients.' },
  bcc: { ...ADDRESSES, description: 'Blind copy recipients.' },
  subject: { type: 'string', maxLength: 500, pattern: '^[^\\r\\n]*$', description: 'The subject. A reply takes "Re: " and the original subject when left out.' },
  body: { type: 'string', maxLength: 500_000, description: 'The message as plain text.' },
  html_body: { type: 'string', maxLength: 1_000_000, description: 'The message as HTML, sent with a plain-text copy (the body, or text made from the HTML).' },
  reply_to_message_id: { type: 'string', pattern: ID, description: 'Answer this message: the mail joins its thread, with the reply headers set.' },
};

interface MailArgs {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  html_body?: string;
  reply_to_message_id?: string;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;
}

function messagePath(id: string): string {
  return `${BASE}/messages/${encodeURIComponent(id)}`;
}

function labelsOf(message: any): string[] {
  return Array.isArray(message?.labelIds) ? message.labelIds.map((label: unknown) => String(label)) : [];
}

function receivedAt(message: any): string | undefined {
  const ms = Number(message?.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** The fields an agent needs to pick a message from a list. */
function trimSummary(message: any): Record<string, unknown> {
  const headers = message?.payload?.headers;
  const labels = labelsOf(message);
  return compact({
    id: message?.id,
    thread_id: message?.threadId,
    from: text(header(headers, 'From'), 300),
    to: text(header(headers, 'To'), 300),
    subject: text(header(headers, 'Subject'), 300),
    date: text(header(headers, 'Date'), 100),
    received: receivedAt(message),
    snippet: typeof message?.snippet === 'string' ? truncate(decodeEntities(message.snippet), 300) : undefined,
    unread: labels.includes('UNREAD'),
    labels,
  });
}

/** One message read with format=metadata, or undefined when it is gone (deleted since it was listed). */
async function readSummary(h: ToolHelpers, id: string): Promise<Record<string, unknown> | undefined> {
  try {
    const { data } = await googleApi(h, { path: messagePath(id), query: { format: 'metadata', metadataHeaders: LIST_HEADERS } });
    return trimSummary(data);
  } catch (error) {
    if (error instanceof ToolFailure && error.details.status === 404) return undefined;
    throw error;
  }
}

/** Runs fn over items, `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A message read with format=full: headers, body text and attachments. */
function readFull(message: any): { headers: Record<string, unknown>; body: ReturnType<typeof bodyText>; html: string[]; attachments: Attachment[] } {
  const headers = message?.payload?.headers;
  const parts = readPayload(message?.payload);
  return {
    headers: compact({
      from: text(header(headers, 'From'), 500),
      to: text(header(headers, 'To'), 2000),
      cc: text(header(headers, 'Cc'), 2000),
      bcc: text(header(headers, 'Bcc'), 2000),
      reply_to: text(header(headers, 'Reply-To'), 500),
      subject: text(header(headers, 'Subject'), 1000),
      date: text(header(headers, 'Date'), 100),
      message_id_header: text(header(headers, 'Message-ID'), 500),
      in_reply_to: text(header(headers, 'In-Reply-To'), 500),
    }),
    body: bodyText(parts),
    html: parts.html,
    attachments: parts.attachments,
  };
}

/** The RFC 2822 message of a draft or a send, as base64url, and the thread it joins. */
async function compose(h: ToolHelpers, args: MailArgs, sending: boolean): Promise<{ raw: string; threadId?: string; to: string[]; subject: string }> {
  const format = (list: string[] | undefined, field: string): string[] => (list ?? []).map((value) => {
    const item = formatAddress(value);
    if (!item) throw new ToolFailure(`${field} has an address Gmail cannot use: give "name@example.com" or "Name <name@example.com>". Nothing was sent.`);
    return item;
  });
  let to = format(args.to, 'to');
  const cc = format(args.cc, 'cc');
  const bcc = format(args.bcc, 'bcc');
  let subject = args.subject;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;

  if (args.reply_to_message_id) {
    const { data } = await googleApi(h, {
      path: messagePath(args.reply_to_message_id),
      query: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'] },
      errors: { 404: `Gmail found no message ${args.reply_to_message_id} to reply to` },
    });
    const headers = data?.payload?.headers;
    threadId = typeof data?.threadId === 'string' ? data.threadId : undefined;
    const messageId = oneLine(header(headers, 'Message-ID'));
    if (messageId) {
      inReplyTo = messageId;
      references = [...(oneLine(header(headers, 'References'))?.split(/\s+/) ?? []), messageId].slice(-20).join(' ');
    }
    if (subject === undefined) {
      const original = oneLine(header(headers, 'Subject')) ?? '';
      subject = /^re:/i.test(original) ? original : `Re: ${original}`.trim();
    }
    if (!to.length && !cc.length && !bcc.length) {
      const sender = oneLine(header(headers, 'Reply-To')) ?? oneLine(header(headers, 'From'));
      if (sender) to = [sender];
    }
  }

  if (sending) {
    if (!to.length && !cc.length && !bcc.length) throw new ToolFailure('Give at least one recipient in to, cc or bcc. Nothing was sent.');
    if (args.body === undefined && args.html_body === undefined) throw new ToolFailure('Give body or html_body: the message is empty. Nothing was sent.');
  }
  const random = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `part_${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const message = buildMessage({
    to,
    cc,
    bcc,
    subject: subject ?? '',
    ...(args.body !== undefined ? { text: args.body } : {}),
    ...(args.html_body !== undefined ? { html: args.html_body } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  }, boundary);
  return { raw: base64UrlEncode(utf8Bytes(message)), ...(threadId ? { threadId } : {}), to, subject: subject ?? '' };
}

/** Gmail settings (forwarding, filters, delegates, send-as) are never changed through the generic tool. */
function settingsGuard(request: ApiToolRequest): void {
  if (request.method !== 'GET' && request.segments[4] === 'settings') {
    throw new ToolFailure('Gmail settings (forwarding, filters, delegates, send-as addresses, vacation replies) are not changed here: change them in Gmail. Nothing was sent.');
  }
}

const connector = defineConnector({
  vendor: 'gmail',
  label: 'Gmail',
  origins: ['https://gmail.googleapis.com'],
  credentials: ['access_token'],
  credentialLabels: { access_token: 'Gmail access token' },
  authHeaders: (credentials) => ({ authorization: `Bearer ${credentials['access_token']}` }),
  tools: [
    {
      name: 'get_profile',
      kind: 'read',
      title: 'Get the Gmail mailbox',
      description: 'Returns the connected mailbox: its address and its total numbers of messages and threads.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const { data } = await googleApi(h, { path: `${BASE}/profile` });
        return compact({ email: data?.emailAddress, messages_total: data?.messagesTotal, threads_total: data?.threadsTotal, history_id: data?.historyId });
      },
    },
    {
      name: 'list_messages',
      kind: 'read',
      title: 'List Gmail messages',
      description:
        'Lists messages of the mailbox, newest first, with each one\'s id, thread, sender, recipients, subject, date, snippet, labels and '
        + 'whether it is unread. query takes Gmail\'s search syntax: "in:inbox is:unread" for unread inbox mail, "from:alice@example.com '
        + 'newer_than:7d", "subject:invoice has:attachment", "in:sent". Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 2000, description: 'A Gmail search, such as "in:inbox is:unread". Leave out for all mail except spam and trash.' },
          label_ids: { ...LABEL_IDS, description: 'Only messages with all of these label ids, such as ["INBOX", "UNREAD"] (list_labels has the ids of your own labels).' },
          include_spam_trash: { type: 'boolean', default: false, description: 'Include spam and trash (default false).' },
          max_results: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Messages per page, 1 to 50 (default 20).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { query?: string; label_ids?: string[]; include_spam_trash: boolean; max_results: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const max = typeof state?.['n'] === 'number' ? state['n'] : args.max_results;
        const { data } = await googleApi(h, {
          path: `${BASE}/messages`,
          query: { q: args.query, labelIds: args.label_ids, includeSpamTrash: args.include_spam_trash || undefined, maxResults: max, pageToken },
        });
        const ids: string[] = (Array.isArray(data?.messages) ? data.messages : [])
          .map((message: any) => message?.id)
          .filter((id: unknown): id is string => typeof id === 'string')
          .slice(skip);
        const messages = (await mapLimit(ids, PARALLEL_READS, (id) => readSummary(h, id))).filter((message) => message !== undefined);
        return h.page({
          key: 'messages',
          items: messages,
          extra: compact({ result_size_estimate: data?.resultSizeEstimate }),
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: max }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: max }) } : {}),
        });
      },
    },
    {
      name: 'get_message',
      kind: 'read',
      title: 'Read a Gmail message',
      description:
        'Reads one message: sender, recipients, subject, date, reply headers, labels, the body as text (HTML-only mail is made '
        + 'readable) and the list of attachments. A long body comes in parts: when next_content_offset is set, call again with '
        + 'content_offset set to it. Reading a message does not mark it read; mark_as_read does.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: MESSAGE_ID,
          body_format: { type: 'string', enum: ['text', 'html'], default: 'text', description: 'text (default), or html for the HTML part as sent when there is one.' },
          content_offset: { type: 'integer', minimum: 0, default: 0, description: 'Where to start reading the body: 0, or next_content_offset from the previous result.' },
        },
        required: ['message_id'],
        additionalProperties: false,
      },
      async run(args: { message_id: string; body_format: 'text' | 'html'; content_offset: number }, h) {
        const { data } = await googleApi(h, {
          path: messagePath(args.message_id),
          query: { format: 'full' },
          errors: { 404: `Gmail found no message ${args.message_id}`, 400: `Gmail found no message ${args.message_id}` },
        });
        const message = readFull(data);
        const labels = labelsOf(data);
        const html = args.body_format === 'html' && message.html.length ? message.html.join('\n') : undefined;
        const body = html ?? message.body.text;
        const part = sliceText(body, args.content_offset, BODY_BYTES);
        return compact({
          id: data?.id,
          thread_id: data?.threadId,
          ...message.headers,
          received: receivedAt(data),
          unread: labels.includes('UNREAD'),
          labels,
          body_type: html !== undefined ? 'html' : message.body.from === 'html' ? 'text from html' : message.body.from,
          body_length: body.length,
          body: part.text,
          next_content_offset: part.next,
          attachments: message.attachments.length ? message.attachments.slice(0, 50) : undefined,
          size: data?.sizeEstimate,
        });
      },
    },
    {
      name: 'get_thread',
      kind: 'read',
      title: 'Read a Gmail thread',
      description:
        'Reads a conversation: every message of the thread, oldest first, with sender, recipients, date, subject, labels, the body as '
        + `text (each cut at ${THREAD_BODY_CHARS} characters; get_message reads one whole) and the attachment names. Pass nextCursor back as cursor for more.`,
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', pattern: ID, description: 'The thread id, from list_messages.' },
          cursor: { type: 'string', description: 'nextCursor from the previous result.' },
        },
        required: ['thread_id'],
        additionalProperties: false,
      },
      async run(args: { thread_id: string; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await googleApi(h, {
          path: `${BASE}/threads/${encodeURIComponent(args.thread_id)}`,
          query: { format: 'full' },
          errors: { 404: `Gmail found no thread ${args.thread_id}`, 400: `Gmail found no thread ${args.thread_id}` },
        });
        const messages = (Array.isArray(data?.messages) ? data.messages : []).map((item: any) => {
          const message = readFull(item);
          const labels = labelsOf(item);
          return compact({
            id: item?.id,
            ...message.headers,
            received: receivedAt(item),
            unread: labels.includes('UNREAD'),
            labels,
            body: truncate(message.body.text, THREAD_BODY_CHARS),
            attachments: message.attachments.length ? message.attachments.map((attachment) => attachment.filename ?? attachment.mime_type).slice(0, 20) : undefined,
          });
        });
        return h.page({
          key: 'messages',
          items: messages.slice(skip),
          extra: { thread_id: data?.id ?? args.thread_id, message_count: messages.length },
          resumeAt: (index) => h.makeCursor({ o: skip + index }),
        });
      },
    },
    {
      name: 'list_labels',
      kind: 'read',
      title: 'List Gmail labels',
      description: 'Lists the labels of the mailbox, system ones (INBOX, UNREAD, STARRED, IMPORTANT, SENT, SPAM, TRASH) and your own, with the id each tool takes.',
      inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: 'nextCursor from the previous result.' } }, additionalProperties: false },
      async run(args: { cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const { data } = await googleApi(h, { path: `${BASE}/labels` });
        const labels = (Array.isArray(data?.labels) ? data.labels : [])
          .map((label: any) => compact({ id: label?.id, name: text(label?.name, 300), type: typeof label?.type === 'string' ? label.type.toLowerCase() : undefined }));
        return h.page({ key: 'labels', items: labels.slice(skip), resumeAt: (index) => h.makeCursor({ o: skip + index }) });
      },
    },
    {
      name: 'list_drafts',
      kind: 'read',
      title: 'List Gmail drafts',
      description: 'Lists the drafts of the mailbox, newest first, with each one\'s draft id, message id, recipients, subject and snippet. Pass nextCursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 2000, description: 'A Gmail search to narrow the drafts, such as "subject:offer".' },
          max_results: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Drafts per page, 1 to 50 (default 20).' },
          cursor: CURSOR,
        },
        additionalProperties: false,
      },
      async run(args: { query?: string; max_results: number; cursor?: string }, h) {
        const state = h.cursor(args.cursor);
        const pageToken = typeof state?.['p'] === 'string' ? state['p'] : undefined;
        const skip = typeof state?.['o'] === 'number' ? state['o'] : 0;
        const max = typeof state?.['n'] === 'number' ? state['n'] : args.max_results;
        const { data } = await googleApi(h, { path: `${BASE}/drafts`, query: { q: args.query, maxResults: max, pageToken } });
        const drafts: any[] = (Array.isArray(data?.drafts) ? data.drafts : []).filter((draft: any) => typeof draft?.message?.id === 'string').slice(skip);
        const items = (await mapLimit(drafts, PARALLEL_READS, async (draft) => {
          const summary = await readSummary(h, draft.message.id);
          return summary ? { draft_id: draft.id, ...summary } : undefined;
        })).filter((item) => item !== undefined);
        return h.page({
          key: 'drafts',
          items,
          resumeAt: (index) => h.makeCursor({ ...(pageToken ? { p: pageToken } : {}), o: skip + index, n: max }),
          ...(typeof data?.nextPageToken === 'string' && data.nextPageToken ? { nextPage: h.makeCursor({ p: data.nextPageToken, o: 0, n: max }) } : {}),
        });
      },
    },
    {
      name: 'mark_as_read',
      kind: 'update',
      check: 'get_message',
      title: 'Mark Gmail messages read or unread',
      description: 'Marks messages as read (default) or, with read: false, as unread. Returns how many were changed.',
      inputSchema: {
        type: 'object',
        properties: {
          message_ids: MESSAGE_IDS,
          read: { type: 'boolean', default: true, description: 'true (default) marks them read, false unread.' },
        },
        required: ['message_ids'],
        additionalProperties: false,
      },
      async run(args: { message_ids: string[]; read: boolean }, h) {
        await googleApi(h, {
          method: 'POST',
          path: `${BASE}/messages/batchModify`,
          json: { ids: args.message_ids, ...(args.read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }) },
          write: true,
        });
        return { updated: args.message_ids.length, read: args.read };
      },
    },
    {
      name: 'modify_labels',
      kind: 'update',
      check: 'get_message',
      title: 'Add or remove Gmail labels',
      description:
        'Adds labels to messages and removes others, by label id (list_labels): archive by removing INBOX, star with STARRED, '
        + 'file under one of your labels with its id such as "Label_12". Returns how many messages were changed.',
      inputSchema: {
        type: 'object',
        properties: {
          message_ids: MESSAGE_IDS,
          add_label_ids: { ...LABEL_IDS, description: 'Label ids to add.' },
          remove_label_ids: { ...LABEL_IDS, description: 'Label ids to remove.' },
        },
        required: ['message_ids'],
        additionalProperties: false,
      },
      async run(args: { message_ids: string[]; add_label_ids?: string[]; remove_label_ids?: string[] }, h) {
        if (!args.add_label_ids?.length && !args.remove_label_ids?.length) {
          throw new ToolFailure('Nothing to change: give add_label_ids or remove_label_ids. Nothing was changed.');
        }
        await googleApi(h, {
          method: 'POST',
          path: `${BASE}/messages/batchModify`,
          json: { ids: args.message_ids, ...(args.add_label_ids?.length ? { addLabelIds: args.add_label_ids } : {}), ...(args.remove_label_ids?.length ? { removeLabelIds: args.remove_label_ids } : {}) },
          write: true,
          errors: { 400: 'Gmail did not accept the change: check the message and label ids (list_labels)' },
        });
        return compact({ updated: args.message_ids.length, added: args.add_label_ids, removed: args.remove_label_ids });
      },
    },
    {
      name: 'trash_message',
      kind: 'delete',
      check: 'get_message',
      title: 'Move a Gmail message to the trash',
      description: 'Moves a message to the trash. Gmail deletes it for good after 30 days; until then it can be taken back out of the trash in Gmail.',
      inputSchema: { type: 'object', properties: { message_id: MESSAGE_ID }, required: ['message_id'], additionalProperties: false },
      async run(args: { message_id: string }, h) {
        const { data } = await googleApi(h, {
          method: 'POST',
          path: `${messagePath(args.message_id)}/trash`,
          write: true,
          errors: { 404: `Gmail found no message ${args.message_id}` },
        });
        return { trashed: true, message_id: data?.id ?? args.message_id, labels: labelsOf(data) };
      },
    },
    {
      name: 'create_label',
      kind: 'create',
      check: 'list_labels',
      title: 'Create a Gmail label',
      description: 'Creates a label in the mailbox, shown in the label list and on messages unless told otherwise. Returns its id. Gmail refuses a name that exists.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 225, pattern: '^[^\\r\\n]+$', description: 'The label name; a slash nests it under another label, such as "Clients/Acme".' },
          show_in_label_list: { type: 'boolean', default: true, description: 'Show it in the label list (default true).' },
          show_in_message_list: { type: 'boolean', default: true, description: 'Show it on messages in the list (default true).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args: { name: string; show_in_label_list: boolean; show_in_message_list: boolean }, h) {
        const { data } = await googleApi(h, {
          method: 'POST',
          path: `${BASE}/labels`,
          json: {
            name: args.name,
            labelListVisibility: args.show_in_label_list ? 'labelShow' : 'labelHide',
            messageListVisibility: args.show_in_message_list ? 'show' : 'hide',
          },
          write: true,
          errors: { 409: 'Gmail already has a label with that name' },
        });
        return compact({ id: data?.id, name: data?.name, type: typeof data?.type === 'string' ? data.type.toLowerCase() : undefined });
      },
    },
    {
      name: 'create_draft',
      kind: 'create',
      check: 'list_drafts',
      title: 'Save a Gmail draft',
      description:
        'Saves a message as a draft in the mailbox, without sending it: to show a reply or a new mail before it goes out. With '
        + 'reply_to_message_id it joins that thread as a reply. Send it later with send_draft. Returns the draft id.',
      inputSchema: { type: 'object', properties: { ...MAIL_FIELDS }, additionalProperties: false },
      async run(args: MailArgs, h) {
        const mail = await compose(h, args, false);
        const { data } = await googleApi(h, {
          method: 'POST',
          path: `${BASE}/drafts`,
          json: { message: { raw: mail.raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) } },
          write: true,
        });
        return compact({ draft_id: data?.id, message_id: data?.message?.id, thread_id: data?.message?.threadId, to: mail.to.length ? mail.to : undefined, subject: mail.subject });
      },
    },
    {
      name: 'send_draft',
      kind: 'create',
      check: 'list_messages',
      title: 'Send a Gmail draft',
      description: 'Sends a saved draft as it is, from the mailbox. It cannot be called back: send only what was approved. Returns the sent message id.',
      inputSchema: {
        type: 'object',
        properties: { draft_id: { type: 'string', pattern: ID, description: 'The draft id, from create_draft or list_drafts.' } },
        required: ['draft_id'],
        additionalProperties: false,
      },
      async run(args: { draft_id: string }, h) {
        const { data } = await googleApi(h, {
          method: 'POST',
          path: `${BASE}/drafts/send`,
          json: { id: args.draft_id },
          write: true,
          errors: { 404: `Gmail found no draft ${args.draft_id}` },
        });
        return compact({ sent: true, message_id: data?.id, thread_id: data?.threadId, labels: labelsOf(data) });
      },
    },
    {
      name: 'send_message',
      kind: 'create',
      check: 'list_messages',
      title: 'Send a Gmail message',
      description:
        'Sends a mail from the mailbox right away, as plain text or HTML (with a plain-text copy). With reply_to_message_id it '
        + 'answers that message in its thread, to the original sender unless to is given. It cannot be called back: send only '
        + 'what was approved (create_draft saves one for review). Sent once; when the outcome is unclear, look in Sent (list_messages '
        + 'with "in:sent") before sending again.',
      inputSchema: { type: 'object', properties: { ...MAIL_FIELDS }, additionalProperties: false },
      async run(args: MailArgs, h) {
        const mail = await compose(h, args, true);
        const { data } = await googleApi(h, {
          method: 'POST',
          path: `${BASE}/messages/send`,
          json: { raw: mail.raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) },
          write: true,
        });
        return compact({ sent: true, message_id: data?.id, thread_id: data?.threadId, to: mail.to, subject: mail.subject, labels: labelsOf(data) });
      },
    },
    // The rest of the Gmail API: history, attachments, threads, drafts updates.
    ...apiTools({
      label: 'Gmail',
      description:
        'The Gmail API v1 for the connected mailbox at https://gmail.googleapis.com/gmail/v1/users/me: paths start with '
        + '/gmail/v1/users/me/, such as /gmail/v1/users/me/history (startHistoryId in query), '
        + '/gmail/v1/users/me/messages/MESSAGE_ID/attachments/ATTACHMENT_ID, /gmail/v1/users/me/threads/THREAD_ID/modify or '
        + '/gmail/v1/users/me/drafts/DRAFT_ID. Settings are read only. Reference: https://developers.google.com/gmail/api/reference/rest.',
      basePath: '/gmail/v1/users/me/',
      guard: settingsGuard,
      send: (request, h) => googleApi(h, request),
    }),
  ],
});

export = connector;
