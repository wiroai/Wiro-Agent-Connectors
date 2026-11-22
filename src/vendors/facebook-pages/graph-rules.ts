// Graph API rules the Meta connectors share; each keeps its own copy of this
// file, since a module imports only from the core and its own folder.
//
// Rate limits. A throttled Graph call does not get HTTP 429: it gets HTTP 400
// or 403 with error code 4 (app), 17 (user), 32 (Page), 613 (custom) or 80000
// to 80014 (business use case). Those failures are reported as rate limits.
//
// The generic tools. Graph reads a parameter from the query, a form body or a
// JSON body alike; it takes `batch` (many requests in one, each with its own
// path) and `method` (another HTTP method than the one sent); and it reads
// `fields` as a selection that can reach into other objects. The generic tools
// look at all of it, percent-decoded, before anything is sent, and their
// replies lose any token or app secret proof they carry.

import { ToolFailure, type ToolDefinition, type ToolHelpers } from '../../core/index.js';

/** A rate limit the service reported. */
export class RateLimited extends ToolFailure {}

const THROTTLE_CODE = /\(#(?:4|17|32|613|800(?:0\d|1[0-4]))\)/;
const THROTTLE_TEXT = /request limit reached|too many calls|exceeded the rate limit/i;
const NOTHING_CHANGED = ' Nothing was changed.';

/** A failure that is the service's throttling, reported as a rate limit; anything else is returned as it is. */
export function rateLimited(error: unknown, label: string): unknown {
  if (!(error instanceof ToolFailure) || error instanceof RateLimited) return error;
  const { status } = error.details;
  if (status !== 400 && status !== 403) return error;
  const { message } = error;
  if (!THROTTLE_CODE.test(message) && !THROTTLE_TEXT.test(message)) return error;
  const unchanged = message.endsWith(NOTHING_CHANGED);
  const body = unchanged ? message.slice(0, -NOTHING_CHANGED.length) : message;
  // The service's own words, as the core put them: "...(HTTP 400): <words>." or '... said: "<words>".'
  const words = (/\(HTTP \d{3}\): (.+)\.$/s.exec(body)?.[1] ?? / said: "(.+)"\.$/s.exec(body)?.[1])?.replace(/[.!?。]+$/u, '');
  return new RateLimited(
    `${label} rate limit reached (HTTP ${status})${words ? `: ${words}` : ''}.${unchanged ? NOTHING_CHANGED : ''} `
      + 'Wait a while before trying again: the limit counts calls over a rolling hour.',
    error.details,
  );
}

/** The tools, with every request's throttling reported as a rate limit. */
export function withRateLimits(tools: ToolDefinition[], label: string): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    run: (args: unknown, h: ToolHelpers) => tool.run(args, {
      ...h,
      api: (request) => h.api(request).catch((error: unknown) => {
        throw rateLimited(error, label);
      }),
    }),
  }));
}

/** The arguments of api_get and api_request, as they arrive. */
export interface GenericArgs {
  path?: unknown;
  query?: unknown;
  json?: unknown;
  body?: unknown;
  content_type?: unknown;
}

/** One parameter, from the query or the body; a value given as JSON text is parsed. */
export interface GraphParam {
  name: string;
  value: unknown;
}

/** A generic request, read the way Graph reads it. */
export interface GraphRequestParts {
  /** The path's segments, as given and percent-decoded. */
  segments: string[];
  /** Every parameter of the query and the body. */
  params: GraphParam[];
  /** The `fields` selections, as given and percent-decoded. */
  fields: string[];
  /** Every segment, parameter name and text value at any depth, as given and percent-decoded. */
  texts: string[];
}

const MAX_DEPTH = 32;
const SECRET = /access_token|appsecret|app_secret|client_secret|debug_token/i;
const OVERRIDES = ['batch', 'method'];

function nothingSent(sentence: string): ToolFailure {
  return new ToolFailure(`${sentence} Nothing was sent.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A text and its percent-decoded forms: a value may be encoded more than once. */
function decodings(text: string): string[] {
  const forms = [text];
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/** A parameter value with JSON text parsed, the way Graph reads objects and lists. */
function parsedValue(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collect(value: unknown, into: string[], depth: number): void {
  if (depth > MAX_DEPTH) throw nothingSent('The request is nested too deeply.');
  if (typeof value === 'string') {
    into.push(...decodings(value));
    const inner = parsedValue(value);
    if (inner !== value) collect(inner, into, depth + 1);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    into.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      into.push(...decodings(key));
      collect(item, into, depth + 1);
    }
  }
}

function queryParams(query: unknown): GraphParam[] {
  if (!isRecord(query)) return [];
  const params: GraphParam[] = [];
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) params.push({ name, value: parsedValue(item) });
    }
  }
  return params;
}

function bodyParams(args: GenericArgs, label: string): GraphParam[] {
  const entries = (record: Record<string, unknown>): GraphParam[] => Object.entries(record).map(([name, value]) => ({ name, value: parsedValue(value) }));
  if (args.json !== undefined && args.body !== undefined) throw nothingSent('Give json or body, not both.');
  if (args.json !== undefined) return isRecord(args.json) ? entries(args.json) : [];
  if (typeof args.body !== 'string') return [];
  const type = typeof args.content_type === 'string' ? args.content_type.trim().toLowerCase() : '';
  if (!type) throw nothingSent('content_type is required with body, e.g. "application/x-www-form-urlencoded".');
  if (/^application\/x-www-form-urlencoded\b/.test(type)) {
    return [...new URLSearchParams(args.body)].map(([name, value]) => ({ name, value: parsedValue(value) }));
  }
  if (/^application\/(?:[a-z0-9.+-]+\+)?json\b/.test(type)) {
    let data: unknown;
    try {
      data = JSON.parse(args.body);
    } catch {
      throw nothingSent('body is not valid JSON.');
    }
    if (!isRecord(data)) throw nothingSent('A JSON body must be an object of parameters.');
    return entries(data);
  }
  throw nothingSent(`The generic ${label} tools send parameters as a JSON object (json) or as a form (body, with content_type application/x-www-form-urlencoded).`);
}

/** Reads a generic request the way Graph will: its path, and every parameter of its query and body. */
export function readGraphRequest(args: GenericArgs, label: string): GraphRequestParts {
  const path = typeof args.path === 'string' ? args.path : '';
  const segments = path.split('/').filter((segment) => segment !== '').flatMap(decodings);
  const params = [...queryParams(args.query), ...bodyParams(args, label)];
  const texts = [...segments];
  const fields: string[] = [];
  for (const { name, value } of params) {
    texts.push(...decodings(name));
    collect(value, texts, 0);
    if (name.trim().toLowerCase() === 'fields') collect(value, fields, 0);
  }
  return { segments, params, fields, texts };
}

/** Refuses what would reach past the generic tools: many requests in one, another method, tokens and app secrets. */
export function refuseUnsafe(parts: GraphRequestParts, label: string): void {
  const override = OVERRIDES.find((name) => parts.params.some((param) => param.name.trim().toLowerCase() === name));
  if (override) {
    throw nothingSent(`The ${override} parameter is not available through the generic ${label} tools: send one request at a time, with api_get to read and api_request to change.`);
  }
  if (parts.segments.some((segment) => segment.toLowerCase() === 'oauth') || parts.texts.some((text) => SECRET.test(text))) {
    throw nothingSent(`Tokens and app secrets are not available through the generic ${label} tools, and the connection's own token is added for you.`);
  }
}

const SECRET_KEY = /^(?:access_token|appsecret_proof)$/i;
const SECRET_URL_PARAM = /([?&](?:access_token|appsecret_proof)=)[^&#\s"'\\]*/gi;
const SECRET_JSON_VALUE = /(\\*")(access_token|appsecret_proof)\1\s*:\s*\1[^"\\]*\1/gi;

/**
 * A reply without tokens or app secret proofs: keys of that name are dropped,
 * and their values are taken out of text (a URL's query, JSON inside a string).
 */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (typeof value === 'string') return value.replace(SECRET_URL_PARAM, '$1hidden').replace(SECRET_JSON_VALUE, '$1$2$1:$1hidden$1');
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, depth + 1));
  if (isRecord(value)) {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SECRET_KEY.test(key)) clean[key] = withoutSecrets(item, depth + 1);
    }
    return clean;
  }
  return value;
}
