import type { JsonSchema } from '../types.js';

// A small validator for the JSON Schema subset in types.ts. Hosts may or may not
// validate arguments before calling a module, so every module checks them here,
// and a tool's run() only ever sees arguments that match its schema.

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: string[] };

const patterns = new Map<string, RegExp>();

function patternOf(source: string): RegExp {
  let compiled = patterns.get(source);
  if (!compiled) {
    compiled = new RegExp(source, 'u');
    patterns.set(source, compiled);
  }
  return compiled;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function name(path: string): string {
  return `\`${path}\``;
}

function child(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function checkValue(schema: JsonSchema, value: unknown, path: string, issues: string[]): void {
  switch (schema.type) {
    case 'object':
      checkObject(schema, value, path, issues);
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push(`${name(path)} must be an array`);
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push(`${name(path)} must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push(`${name(path)} must have at most ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}`);
      }
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
        issues.push(`${name(path)} must not repeat an item`);
      }
      if (schema.items) {
        value.forEach((item, index) => checkValue(schema.items as JsonSchema, item, `${path}[${index}]`, issues));
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') {
        issues.push(`${name(path)} must be a string`);
        return;
      }
      const length = Array.from(value).length;
      if (schema.minLength !== undefined && length < schema.minLength) {
        issues.push(schema.minLength === 1
          ? `${name(path)} must not be empty`
          : `${name(path)} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        issues.push(`${name(path)} must be at most ${schema.maxLength} characters (it has ${length})`);
      }
      if (schema.format === 'uri' && !isHttpUrl(value)) {
        issues.push(`${name(path)} must be an absolute http(s) URL`);
      } else if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value)) {
        issues.push(`${name(path)} does not have the expected format${schema.description ? ` (${schema.description})` : ''}`);
      }
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        issues.push(`${name(path)} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`);
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push(`${name(path)} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push(`${name(path)} must be at most ${schema.maximum}`);
      }
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push(`${name(path)} must be true or false`);
        return;
      }
      break;
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    issues.push(`${name(path)} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
}

function checkObject(schema: JsonSchema, value: unknown, path: string, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push(`${path ? name(path) : 'the arguments'} must be an object`);
    return;
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) issues.push(`${name(child(path, key))} is required`);
  }
  const unknown: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false) unknown.push(key);
      continue;
    }
    if (item === undefined || item === null) continue;
    checkValue(property, item, child(path, key), issues);
  }
  if (unknown.length) {
    const known = Object.keys(properties);
    issues.push(`unknown ${path ? `field${unknown.length > 1 ? 's' : ''} in ${name(path)}` : `argument${unknown.length > 1 ? 's' : ''}`} `
      + `${unknown.map((key) => JSON.stringify(key)).join(', ')}`
      + (known.length ? ` (expected: ${known.join(', ')})` : ''));
  }
}

function copyDefault(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * Checks tool arguments against the tool's input schema. Absent or null
 * optional arguments take the schema default, if there is one, and a null is
 * otherwise treated as absent. Some MCP clients add a `toolCallId` of their
 * own to the arguments, which is dropped instead of refused.
 */
export function validateArguments(schema: JsonSchema, args: unknown): ValidationResult {
  const input = args === undefined || args === null ? {} : args;
  if (!isPlainObject(input)) return { ok: false, issues: ['the arguments must be an object'] };
  const value: Record<string, unknown> = { ...input };
  if (!schema.properties?.['toolCallId']) delete value['toolCallId'];

  const issues: string[] = [];
  checkObject(schema, value, '', issues);
  if (issues.length) return { ok: false, issues };

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (value[key] === null) delete value[key];
    if (value[key] === undefined && property.default !== undefined) value[key] = copyDefault(property.default);
  }
  return { ok: true, value };
}
