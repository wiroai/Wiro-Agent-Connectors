import { base64Decode, ToolFailure, truncate, utf8Decode } from '../../core/index.js';

// The `accounts` credential: the connected Firebase projects. It takes one
// service account key file (JSON) or a list of projects, each with its key
// and optionally an app name, its apps and its FCM topics, as JSON text or
// its base64 text; a key inside may be a JSON object, JSON text or base64 of
// it. Field names follow the older setup (appname, serviceaccountjson,
// projectid, apps, topics with topickey and topicdesc) and their camelCase
// forms. The keys are never logged, returned or quoted.

export interface FirebaseApp {
  platform?: string;
  id: string;
}

export interface FirebaseTopic {
  topic: string;
  description?: string;
}

export interface FirebaseProject {
  projectId: string;
  appName: string;
  /** The key file as JSON text, for googleServiceAccountToken. */
  keyText: string;
  clientEmail: string;
  apps: FirebaseApp[];
  topics: FirebaseTopic[];
}

const MAX_PROJECTS = 25;
const HELP =
  'Give the service account key file of a Firebase project (Firebase console -> Project settings -> Service accounts -> Generate new '
  + 'private key), or a JSON list of projects such as [{"appname": "My App", "serviceaccountjson": {...the key file...}, "topics": '
  + '[{"topickey": "locale_en", "topicdesc": "English speakers"}]}].';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON value from JSON text or from base64 of JSON text; objects and lists pass as they are. */
function jsonOf(value: unknown): unknown {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  for (const candidate of [text, () => utf8Decode(base64Decode(text.replace(/^data:[^,]*;base64,/i, '').replace(/-/g, '+').replace(/_/g, '/'))).trim()]) {
    try {
      const source = typeof candidate === 'string' ? candidate : candidate();
      if (source.startsWith('{') || source.startsWith('[')) return JSON.parse(source);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

function firstOf(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name];
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined;
}

function readApps(value: unknown): FirebaseApp[] {
  const list = Array.isArray(value) ? value : [];
  const apps: FirebaseApp[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = text(firstOf(item, ['id', 'appId', 'appid', 'packageName', 'packagename', 'bundleId', 'bundleid']));
    if (!id) continue;
    const platform = text(item['platform'])?.toLowerCase();
    apps.push({ ...(platform ? { platform } : {}), id });
  }
  return apps.slice(0, 50);
}

function readTopics(value: unknown): FirebaseTopic[] {
  const topics: FirebaseTopic[] = [];
  const add = (topic: string | undefined, description: string | undefined): void => {
    if (topic) topics.push({ topic: topic.replace(/^\/topics\//, ''), ...(description ? { description: truncate(description, 300) } : {}) });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') add(text(item), undefined);
      else if (isRecord(item)) add(text(firstOf(item, ['topickey', 'topicKey', 'key', 'topic', 'name'])), text(firstOf(item, ['topicdesc', 'topicDesc', 'description', 'desc'])));
    }
  } else if (isRecord(value)) {
    for (const [topic, description] of Object.entries(value)) add(text(topic), text(description));
  }
  return topics.slice(0, 200);
}

function readProject(entry: unknown, position: number, total: number): FirebaseProject {
  const which = total > 1 ? `Firebase project ${position + 1} of the accounts list` : 'The Firebase project';
  if (!isRecord(entry)) throw new ToolFailure(`${which} is not an object. ${HELP} Nothing was sent.`);
  // A bare key file stands for a project of its own.
  const key = entry['type'] === 'service_account' || typeof entry['private_key'] === 'string'
    ? entry
    : jsonOf(firstOf(entry, ['serviceaccountjson', 'serviceAccountJson', 'serviceAccountJsonBase64', 'service_account_json', 'serviceaccount', 'serviceAccount', 'key']));
  if (!isRecord(key) || typeof key['private_key'] !== 'string' || typeof key['client_email'] !== 'string') {
    throw new ToolFailure(`${which} has no usable service account key (a key file with client_email and private_key). ${HELP} Nothing was sent.`);
  }
  const projectId = text(key['project_id']) ?? text(firstOf(entry, ['projectid', 'projectId', 'project_id']));
  if (!projectId || !/^[a-z][a-z0-9.:-]{3,100}$/.test(projectId)) {
    throw new ToolFailure(`${which} has no valid project id: the key file's project_id is missing. ${HELP} Nothing was sent.`);
  }
  return {
    projectId,
    appName: text(firstOf(entry, ['appname', 'appName', 'name'])) ?? projectId,
    keyText: JSON.stringify(key),
    clientEmail: key['client_email'] as string,
    apps: readApps(entry['apps']),
    topics: readTopics(entry['topics']),
  };
}

/** The connected projects from the `accounts` credential, or a ToolFailure that says what is wrong (never quoting it). */
export function readProjects(value: string): FirebaseProject[] {
  const parsed = jsonOf(value);
  let entries: unknown[];
  if (Array.isArray(parsed)) entries = parsed;
  else if (isRecord(parsed) && Array.isArray(parsed['accounts'])) entries = parsed['accounts'];
  else if (isRecord(parsed)) entries = [parsed];
  else throw new ToolFailure(`The Firebase accounts value could not be read as JSON. ${HELP} Nothing was sent.`);
  if (!entries.length) throw new ToolFailure(`The Firebase accounts list is empty. ${HELP} Nothing was sent.`);
  if (entries.length > MAX_PROJECTS) throw new ToolFailure(`The Firebase accounts list has ${entries.length} projects; at most ${MAX_PROJECTS} are supported. Nothing was sent.`);
  return entries.map((entry, index) => readProject(entry, index, entries.length));
}

function describe(project: FirebaseProject): string {
  return project.appName === project.projectId ? project.projectId : `${project.projectId} (${project.appName})`;
}

/** The project a call works on: by project id, app name or one of its app ids; the only one when there is one. */
export function projectFor(projects: FirebaseProject[], given: string | undefined): FirebaseProject {
  const names = projects.map(describe).join(', ');
  if (given === undefined) {
    if (projects.length === 1) return projects[0] as FirebaseProject;
    throw new ToolFailure(`Several Firebase projects are connected: give project, one of ${names}. Nothing was sent.`);
  }
  const wanted = given.trim().toLowerCase();
  const match = projects.find((project) => project.projectId.toLowerCase() === wanted)
    ?? projects.find((project) => project.appName.toLowerCase() === wanted)
    ?? projects.find((project) => project.apps.some((app) => app.id.toLowerCase() === wanted));
  if (!match) throw new ToolFailure(`No connected Firebase project matches "${truncate(given, 100)}": use one of ${names}. Nothing was sent.`);
  return match;
}
