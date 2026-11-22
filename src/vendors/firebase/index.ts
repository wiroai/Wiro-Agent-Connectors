// Firebase Cloud Messaging (push notifications), through the FCM HTTP v1 API,
// with one service account per Firebase project.
//
// Credential: `accounts`, the connected Firebase projects (see projects.ts):
// one service account key file, from Firebase console -> Project settings ->
// Service accounts -> Generate new private key, or a JSON list of projects
// with their keys, app names, apps and the FCM topics their apps subscribe
// to. Each project's key signs a short-lived token (RS256) for the
// firebase.messaging scope; the keys never leave the call.
//
// FCM has one method, messages:send, so there are no generic API tools: the
// send and validate tools cover every message option.

import {
  defineConnector,
  googleServiceAccountToken,
  jsonSize,
  OutcomeUnknown,
  ToolFailure,
  truncate,
  type ApiResponse,
  type FailureDetails,
  type ToolDefinition,
  type ToolHelpers,
} from '../../core/index.js';
import { projectFor, readProjects, type FirebaseProject } from './projects.js';

type JsonSchema = ToolDefinition['inputSchema'];

const LABEL = 'Firebase';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/firebase.messaging'];
const MAX_DATA_BYTES = 4000;
const CHECK_TOPIC = 'connection-check';

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain objects merged, the second one winning. */
function merge(base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }
  return out;
}

function projects(h: ToolHelpers): FirebaseProject[] {
  return readProjects(h.credentials['accounts'] as string);
}

/** messages:send for a project, with its own token. */
async function send(h: ToolHelpers, project: FirebaseProject, body: Record<string, unknown>, mode: { validateOnly: boolean }): Promise<ApiResponse> {
  const token = await googleServiceAccountToken(h, project.keyText, { scopes: SCOPES });
  return h.api({
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(project.projectId)}/messages:send`,
    headers: { authorization: `Bearer ${token}` },
    json: mode.validateOnly ? { validate_only: true, ...body } : body,
    ...(mode.validateOnly ? { safe: true } : { write: true }),
    errors: {
      400: 'Firebase did not accept the message',
      401: `Firebase did not accept the service account of the project ${project.projectId}`,
      403: `Firebase refused the service account ${project.clientEmail}: give it the Firebase Cloud Messaging API Admin role in the project ${project.projectId} and check that the Firebase Cloud Messaging API is enabled`,
      404: 'Firebase found no such device token or project; a token that is not registered any more belongs to an app that was uninstalled or whose token expired, so stop sending to it',
    },
  });
}

interface MessageArgs {
  project?: string;
  token?: string;
  topic?: string;
  condition?: string;
  title?: string;
  body?: string;
  image_url?: string;
  data?: Record<string, unknown>;
  android_channel_id?: string;
  click_action?: string;
  sound?: string;
  badge?: number;
  priority?: 'normal' | 'high';
  ttl_seconds?: number;
  collapse_key?: string;
  analytics_label?: string;
  android?: Record<string, unknown>;
  apns?: Record<string, unknown>;
  webpush?: Record<string, unknown>;
}

const MESSAGE_PROPERTIES: Record<string, JsonSchema> = {
  project: { type: 'string', minLength: 1, maxLength: 200, description: 'The project to send from: its project id, app name or one of its app ids. Optional when one project is connected.' },
  topic: { type: 'string', pattern: '^(/topics/)?[A-Za-z0-9\\-_.~%]{1,900}$', description: 'A topic the app subscribes its users to, e.g. locale_en (list_projects shows the configured ones).' },
  condition: {
    type: 'string',
    minLength: 1,
    maxLength: 1000,
    description: "Topics combined, e.g. \"'tier_paid' in topics && 'locale_tr' in topics\": up to 5 topics with &&, || and !, each name in single quotes.",
  },
  token: { type: 'string', minLength: 20, maxLength: 4096, description: 'One device\'s registration token, e.g. for a test push.' },
  title: { type: 'string', minLength: 1, maxLength: 1000, description: 'The notification title (about 65 characters show before it is cut).' },
  body: { type: 'string', minLength: 1, maxLength: 4000, description: 'The notification text (about 45 characters show collapsed on Android, about 178 expanded on iOS).' },
  image_url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2000, description: 'A public https image (JPEG or PNG, under 1 MB) shown in the notification; iOS shows it only with a Notification Service Extension in the app.' },
  data: { type: 'object', description: 'Key-value data for the app, values as text, e.g. {"screen": "offers", "eventId": "eid-2026"}; up to 4 KB.' },
  android_channel_id: { type: 'string', maxLength: 200, description: 'The Android notification channel id, e.g. promotions.' },
  click_action: { type: 'string', maxLength: 500, description: 'The Android click action, e.g. OPEN_PROMOTION.' },
  sound: { type: 'string', maxLength: 200, description: 'The sound on Android and iOS, e.g. default.' },
  badge: { type: 'integer', minimum: 0, maximum: 99999, description: 'The iOS app icon badge number.' },
  priority: { type: 'string', enum: ['normal', 'high'], description: 'Delivery priority on Android and iOS: normal or high (wakes the device).' },
  ttl_seconds: { type: 'integer', minimum: 0, maximum: 2419200, description: 'How long Firebase keeps trying to deliver, in seconds (up to 28 days).' },
  collapse_key: { type: 'string', maxLength: 64, description: 'Messages with the same key replace each other while waiting for the device.' },
  analytics_label: { type: 'string', pattern: '^[a-zA-Z0-9-_.~%]{1,50}$', description: 'A label for Firebase\'s delivery reports, e.g. eid-2026-tr.' },
  android: { type: 'object', description: 'Raw Android options (FCM AndroidConfig), merged over the ones above, e.g. {"notification": {"color": "#ff0000"}}.' },
  apns: { type: 'object', description: 'Raw iOS options (FCM ApnsConfig: headers and payload), merged over the ones above.' },
  webpush: { type: 'object', description: 'Raw web push options (FCM WebpushConfig).' },
};

/** The FCM message the arguments describe, after checking them. */
function buildMessage(args: MessageArgs): Record<string, unknown> {
  const targets = [args.token, args.topic, args.condition].filter((value) => value !== undefined);
  if (targets.length !== 1) throw new ToolFailure('Give one target: topic, condition or token. Nothing was sent.');
  if (args.condition !== undefined) {
    const topics = args.condition.match(/'[^']+'\s+in\s+topics/g) ?? [];
    if (!topics.length) throw new ToolFailure("condition names no topic: write each as 'name' in topics. Nothing was sent.");
    if (topics.length > 5) throw new ToolFailure(`condition names ${topics.length} topics; Firebase allows 5. Nothing was sent.`);
  }
  const message: Record<string, unknown> = {};
  if (args.token !== undefined) message['token'] = args.token;
  if (args.topic !== undefined) message['topic'] = args.topic.replace(/^\/topics\//, '');
  if (args.condition !== undefined) message['condition'] = args.condition;

  const notification = compact({ title: args.title, body: args.body, image: args.image_url });
  if (Object.keys(notification).length) message['notification'] = notification;
  if (args.data !== undefined) {
    const entries = Object.entries(args.data);
    if (entries.some(([, value]) => typeof value !== 'string')) throw new ToolFailure('data values must be text, e.g. {"count": "3"}. Nothing was sent.');
    if (jsonSize(args.data) > MAX_DATA_BYTES) throw new ToolFailure('data is larger than the 4 KB Firebase allows. Nothing was sent.');
    if (entries.length) message['data'] = args.data;
  }
  if (!message['notification'] && !message['data'] && !args.android && !args.apns && !args.webpush) {
    throw new ToolFailure('The message is empty: give title and body, data, or platform options. Nothing was sent.');
  }

  const androidNotification = compact({ channel_id: args.android_channel_id, click_action: args.click_action, sound: args.sound });
  const android = compact({
    priority: args.priority?.toUpperCase(),
    ttl: args.ttl_seconds !== undefined ? `${args.ttl_seconds}s` : undefined,
    collapse_key: args.collapse_key,
    notification: Object.keys(androidNotification).length ? androidNotification : undefined,
  });
  const aps = compact({ sound: args.sound, badge: args.badge, 'mutable-content': args.image_url ? 1 : undefined });
  const apnsHeaders = compact({
    'apns-priority': args.priority ? (args.priority === 'high' ? '10' : '5') : undefined,
    'apns-collapse-id': args.collapse_key,
    'apns-expiration': args.ttl_seconds !== undefined ? String(Math.floor(Date.now() / 1000) + args.ttl_seconds) : undefined,
  });
  const apns = compact({
    headers: Object.keys(apnsHeaders).length ? apnsHeaders : undefined,
    payload: Object.keys(aps).length ? { aps } : undefined,
    fcm_options: args.image_url ? { image: args.image_url } : undefined,
  });
  if (Object.keys(android).length || args.android) message['android'] = merge(android, args.android);
  if (Object.keys(apns).length || args.apns) message['apns'] = merge(apns, args.apns);
  if (args.webpush) message['webpush'] = args.webpush;
  if (args.analytics_label) message['fcm_options'] = { analytics_label: args.analytics_label };
  return message;
}

function targetOf(message: Record<string, unknown>): string {
  if (typeof message['topic'] === 'string') return `topic ${message['topic']}`;
  if (typeof message['condition'] === 'string') return `condition ${truncate(message['condition'], 200)}`;
  return 'one device token';
}

/** The message as an agent sees it, without the device token. */
function preview(message: Record<string, unknown>): Record<string, unknown> {
  return message['token'] !== undefined ? { ...message, token: '(device token)' } : message;
}

const connector = defineConnector({
  vendor: 'firebase',
  label: LABEL,
  origins: [FCM_ORIGIN, TOKEN_ORIGIN],
  credentials: ['accounts'],
  credentialLabels: { accounts: 'Firebase service accounts' },
  tools: [
    {
      name: 'list_projects',
      kind: 'read',
      title: 'List the connected Firebase projects',
      description:
        'Lists the connected Firebase projects from the connection\'s settings, without calling Firebase: project id, app name, service account, '
        + 'the apps (platform and id) and the FCM topics with what each audience is. Use it to pick the project and the topic of a push. '
        + 'No topics means the app has none configured: send to a token, or to a topic every install subscribes to.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        return {
          projects: projects(h).map((project) => compact({
            project: project.projectId,
            appName: project.appName,
            serviceAccount: project.clientEmail,
            apps: project.apps.length ? project.apps : undefined,
            topics: project.topics,
          })),
        };
      },
    },
    {
      name: 'check_projects',
      kind: 'read',
      title: 'Check the Firebase connection',
      description:
        'Checks every connected project with Firebase: signs in with its service account and has Firebase validate a test message without '
        + 'delivering it. Returns ok per project, or Firebase\'s reason for the first one that fails.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args: Record<string, never>, h) {
        const all = projects(h);
        const results: Record<string, unknown>[] = [];
        for (const project of all) {
          try {
            await send(h, project, { message: { topic: CHECK_TOPIC, notification: { title: 'Connection check', body: 'Connection check' } } }, { validateOnly: true });
          } catch (error) {
            if (error instanceof ToolFailure && all.length > 1) {
              throw new ToolFailure(`The Firebase project ${project.projectId} (${results.length + 1} of ${all.length}) failed the check: ${error.message}`, error.details);
            }
            throw error;
          }
          results.push({ project: project.projectId, appName: project.appName, ok: true });
        }
        return { projects: results };
      },
    },
    {
      name: 'validate_message',
      kind: 'read',
      title: 'Validate a Firebase push message',
      description:
        'Has Firebase check a push message without delivering it: the same arguments as send_message. Returns the message as it would be '
        + 'sent, or Firebase\'s reason for refusing it.',
      inputSchema: { type: 'object', properties: MESSAGE_PROPERTIES, additionalProperties: false },
      async run(args: MessageArgs, h) {
        const project = projectFor(projects(h), args.project);
        const message = buildMessage(args);
        await send(h, project, { message }, { validateOnly: true });
        return { valid: true, project: project.projectId, appName: project.appName, target: targetOf(message), message: preview(message) };
      },
    },
    {
      name: 'send_message',
      kind: 'create',
      check: 'list_projects',
      title: 'Send a Firebase push notification',
      description:
        'Sends a push notification through Firebase Cloud Messaging to the users subscribed to a topic, to a condition of topics, or to one '
        + 'device token: title, text, optional image, data for the app, and Android and iOS options (channel, sound, badge, priority, '
        + 'time to live, collapse key). It is delivered at once and cannot be recalled; validate_message checks it first. Returns the message id.',
      inputSchema: { type: 'object', properties: MESSAGE_PROPERTIES, additionalProperties: false },
      async run(args: MessageArgs, h) {
        const project = projectFor(projects(h), args.project);
        const message = buildMessage(args);
        try {
          const { data } = await send(h, project, { message }, { validateOnly: false });
          return compact({ sent: true, project: project.projectId, appName: project.appName, target: targetOf(message), messageId: data?.name });
        } catch (error) {
          if (error instanceof OutcomeUnknown) {
            // Firebase keeps no record of sent messages that a tool could read to check.
            throw new ToolFailure(
              `${error.message.replace('whether the change was made', 'whether the message was sent')} Firebase keeps no list of sent `
                + 'messages to look it up: send it again only if a second notification is acceptable.',
              { outcome: 'unknown' } as unknown as FailureDetails,
            );
          }
          throw error;
        }
      },
    },
  ],
});

export = connector;
